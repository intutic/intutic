//! Decoder for the AWS event-stream wire format (`application/vnd.amazon.eventstream`).
//!
//! Bedrock's streaming operations (`InvokeModelWithResponseStream`,
//! `ConverseStream`) answer with this binary framing rather than SSE. Each
//! message is
//!
//! ```text
//! [total length u32][headers length u32][prelude CRC32 u32]
//! [headers ...][payload ...][message CRC32 u32]
//! ```
//!
//! big-endian throughout, CRC-32 (IEEE) over the prelude and over everything
//! before the trailing checksum. A header is a one-byte name length, the name,
//! a one-byte value type and a type-specific value. Bedrock only sends string
//! headers (`:event-type`, `:message-type`, `:content-type`,
//! `:exception-type`), but every type is skipped correctly so an unexpected
//! header cannot desynchronise the frame.
//!
//! Hand-rolled rather than taken from `aws-smithy-eventstream`, which would
//! bring the smithy runtime type crates with it for ~100 lines of framing that
//! the tests below pin byte for byte.

/// A frame larger than this is refused rather than buffered. Bedrock's chunks
/// are a few KB; the cap only exists so a corrupt length prefix cannot make
/// the proxy allocate whatever four arbitrary bytes happen to say.
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// Prelude (8) + prelude CRC (4) + message CRC (4).
const FRAMING_BYTES: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    /// String-valued headers only, in wire order. Other header types are
    /// validated and skipped: nothing Bedrock sends uses them.
    pub headers: Vec<(String, String)>,
    pub payload: Vec<u8>,
}

impl Message {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    #[error("event-stream prelude checksum mismatch")]
    PreludeChecksum,
    #[error("event-stream message checksum mismatch")]
    MessageChecksum,
    #[error("event-stream frame of {0} bytes exceeds the limit")]
    TooLarge(usize),
    #[error("malformed event-stream frame: {0}")]
    Malformed(&'static str),
}

/// Incremental decoder: feed it bytes as they arrive, take whole messages out.
#[derive(Debug, Default)]
pub struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Bytes received that do not yet form a whole message.
    pub fn pending(&self) -> usize {
        self.buf.len()
    }

    /// The next complete message, `None` when more bytes are needed. An error
    /// is terminal: the stream cannot be resynchronised after a bad frame.
    pub fn next_message(&mut self) -> Option<Result<Message, DecodeError>> {
        if self.buf.len() < 12 {
            return None;
        }
        let total = be_u32(&self.buf[0..4]) as usize;
        let headers_len = be_u32(&self.buf[4..8]) as usize;
        if crc32fast::hash(&self.buf[0..8]) != be_u32(&self.buf[8..12]) {
            return Some(Err(DecodeError::PreludeChecksum));
        }
        if total > MAX_MESSAGE_BYTES {
            return Some(Err(DecodeError::TooLarge(total)));
        }
        if total < FRAMING_BYTES || headers_len > total - FRAMING_BYTES {
            return Some(Err(DecodeError::Malformed("length prefix")));
        }
        if self.buf.len() < total {
            return None;
        }
        let frame: Vec<u8> = self.buf.drain(..total).collect();
        if crc32fast::hash(&frame[..total - 4]) != be_u32(&frame[total - 4..]) {
            return Some(Err(DecodeError::MessageChecksum));
        }
        let headers = match parse_headers(&frame[12..12 + headers_len]) {
            Ok(h) => h,
            Err(e) => return Some(Err(e)),
        };
        let payload = frame[12 + headers_len..total - 4].to_vec();
        Some(Ok(Message { headers, payload }))
    }
}

fn be_u32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

fn parse_headers(mut b: &[u8]) -> Result<Vec<(String, String)>, DecodeError> {
    let mut out = Vec::new();
    while !b.is_empty() {
        let name_len = b[0] as usize;
        b = &b[1..];
        if b.len() < name_len + 1 {
            return Err(DecodeError::Malformed("header name"));
        }
        let name = std::str::from_utf8(&b[..name_len])
            .map_err(|_| DecodeError::Malformed("header name utf-8"))?
            .to_string();
        let value_type = b[name_len];
        b = &b[name_len + 1..];
        // Fixed-width types: bool true/false carry no value; byte 1, short 2,
        // int 4, long 8, timestamp 8, uuid 16.
        let fixed = match value_type {
            0 | 1 => Some(0),
            2 => Some(1),
            3 => Some(2),
            4 => Some(4),
            5 | 8 => Some(8),
            9 => Some(16),
            6 | 7 => None,
            _ => return Err(DecodeError::Malformed("header value type")),
        };
        match fixed {
            Some(n) => {
                if b.len() < n {
                    return Err(DecodeError::Malformed("header value"));
                }
                b = &b[n..];
            }
            None => {
                if b.len() < 2 {
                    return Err(DecodeError::Malformed("header value length"));
                }
                let len = u16::from_be_bytes([b[0], b[1]]) as usize;
                b = &b[2..];
                if b.len() < len {
                    return Err(DecodeError::Malformed("header value"));
                }
                if value_type == 7 {
                    let v = std::str::from_utf8(&b[..len])
                        .map_err(|_| DecodeError::Malformed("header value utf-8"))?;
                    out.push((name, v.to_string()));
                }
                b = &b[len..];
            }
        }
    }
    Ok(out)
}

/// Encode one message. The proxy never sends event-stream frames; this exists
/// so tests (here and in the Bedrock translation tests) build real frames
/// rather than hand-typed byte arrays.
#[cfg(test)]
pub fn encode(headers: &[(&str, &str)], payload: &[u8]) -> Vec<u8> {
    let mut h = Vec::new();
    for (name, value) in headers {
        h.push(name.len() as u8);
        h.extend_from_slice(name.as_bytes());
        h.push(7);
        h.extend_from_slice(&(value.len() as u16).to_be_bytes());
        h.extend_from_slice(value.as_bytes());
    }
    let total = (FRAMING_BYTES + h.len() + payload.len()) as u32;
    let mut m = Vec::new();
    m.extend_from_slice(&total.to_be_bytes());
    m.extend_from_slice(&(h.len() as u32).to_be_bytes());
    let prelude_crc = crc32fast::hash(&m);
    m.extend_from_slice(&prelude_crc.to_be_bytes());
    m.extend_from_slice(&h);
    m.extend_from_slice(payload);
    let crc = crc32fast::hash(&m);
    m.extend_from_slice(&crc.to_be_bytes());
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape of a Bedrock `chunk` frame, checked field by field: the
    /// length prefixes, both checksums, the header and the payload.
    #[test]
    fn decodes_a_frame_with_a_string_header() {
        let frame = encode(&[(":event-type", "chunk")], b"{\"bytes\":\"e30=\"}");
        // 16 framing + (1 + 11 + 1 + 2 + 5) header + 16 payload
        assert_eq!(frame.len(), 16 + 20 + 16);
        assert_eq!(be_u32(&frame[0..4]) as usize, frame.len());
        assert_eq!(be_u32(&frame[4..8]), 20);
        let mut d = Decoder::new();
        d.push(&frame);
        let m = d.next_message().unwrap().unwrap();
        assert_eq!(m.header(":event-type"), Some("chunk"));
        assert_eq!(m.payload, b"{\"bytes\":\"e30=\"}");
        assert!(d.next_message().is_none());
        assert_eq!(d.pending(), 0);
    }

    /// The no-op message vector from awslabs/aws-c-event-stream's decoder
    /// tests: a 16-byte frame with no headers and no payload. The prelude
    /// `00 00 00 10 00 00 00 00` has CRC32 `05 c2 48 eb`, and the 12-byte
    /// prefix has CRC32 `7d 98 c8 ff`, so this pins the checksum variant
    /// (IEEE, not Castagnoli) against bytes AWS published.
    #[test]
    fn decodes_the_published_empty_message_vector() {
        let bytes = [
            0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x05, 0xc2, 0x48, 0xeb, 0x7d, 0x98,
            0xc8, 0xff,
        ];
        let mut d = Decoder::new();
        d.push(&bytes);
        let m = d.next_message().unwrap().unwrap();
        assert!(m.headers.is_empty());
        assert!(m.payload.is_empty());
        assert_eq!(encode(&[], &[]), bytes);
    }

    #[test]
    fn reassembles_frames_split_at_every_byte_boundary() {
        let mut stream = encode(&[(":event-type", "a")], b"one");
        stream.extend(encode(&[(":event-type", "b")], b"two"));
        for split in 0..stream.len() {
            let mut d = Decoder::new();
            let mut got = Vec::new();
            for part in [&stream[..split], &stream[split..]] {
                d.push(part);
                while let Some(m) = d.next_message() {
                    got.push(m.unwrap().payload);
                }
            }
            assert_eq!(got, vec![b"one".to_vec(), b"two".to_vec()], "split={split}");
        }
    }

    #[test]
    fn a_corrupt_payload_fails_the_message_checksum() {
        let mut frame = encode(&[(":event-type", "chunk")], b"payload");
        let n = frame.len();
        frame[n - 6] ^= 0xff;
        let mut d = Decoder::new();
        d.push(&frame);
        assert_eq!(d.next_message().unwrap(), Err(DecodeError::MessageChecksum));
    }

    #[test]
    fn a_corrupt_length_fails_the_prelude_checksum_before_any_allocation() {
        let mut frame = encode(&[], b"x");
        frame[0] = 0x7f;
        let mut d = Decoder::new();
        d.push(&frame);
        assert_eq!(d.next_message().unwrap(), Err(DecodeError::PreludeChecksum));
    }

    #[test]
    fn non_string_headers_are_skipped_without_desynchronising() {
        // :message-type (string), a bool-true, an int32 and a uuid header,
        // then the payload. Only the string header is reported.
        let mut h = Vec::new();
        h.push(13u8);
        h.extend_from_slice(b":message-type");
        h.push(7);
        h.extend_from_slice(&5u16.to_be_bytes());
        h.extend_from_slice(b"event");
        h.push(1);
        h.extend_from_slice(b"t");
        h.push(0);
        h.push(1);
        h.extend_from_slice(b"i");
        h.push(4);
        h.extend_from_slice(&7i32.to_be_bytes());
        h.push(1);
        h.extend_from_slice(b"u");
        h.push(9);
        h.extend_from_slice(&[0u8; 16]);
        let payload = b"ok";
        let total = (16 + h.len() + payload.len()) as u32;
        let mut m = total.to_be_bytes().to_vec();
        m.extend_from_slice(&(h.len() as u32).to_be_bytes());
        let c = crc32fast::hash(&m);
        m.extend_from_slice(&c.to_be_bytes());
        m.extend_from_slice(&h);
        m.extend_from_slice(payload);
        let c = crc32fast::hash(&m);
        m.extend_from_slice(&c.to_be_bytes());

        let mut d = Decoder::new();
        d.push(&m);
        let msg = d.next_message().unwrap().unwrap();
        assert_eq!(msg.headers, vec![(":message-type".into(), "event".into())]);
        assert_eq!(msg.payload, b"ok");
    }
}
