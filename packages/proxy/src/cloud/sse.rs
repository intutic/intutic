//! Byte-stream translation: a provider's streaming body in, Anthropic SSE out.
//!
//! The translated stream is what `proxy::handle_proxy` reads line by line, so
//! everything it does to a stream — DLP holdback, the response gate, usage
//! accounting — sees the same bytes the client will.

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::Value;

/// One Anthropic SSE event, `event:` line included — the proxy's
/// cross-protocol translator keys on it.
pub fn event(name: &str, data: &Value) -> String {
    format!("event: {name}\ndata: {data}\n\n")
}

/// A stateful provider-stream → Anthropic-SSE translator.
pub trait Translate: Send + 'static {
    /// Translate the next upstream bytes; returns SSE text (possibly empty).
    fn feed(&mut self, bytes: &[u8]) -> String;
    /// The upstream ended cleanly. Returns whatever closes the message.
    fn finish(&mut self) -> String;
    /// True once the translator has emitted a terminal event (a mapped
    /// in-stream error); the rest of the upstream is ignored.
    fn done(&self) -> bool;
}

/// Wrap `upstream` so it yields `translator`'s SSE.
pub fn translate<S, T>(upstream: S, translator: T) -> reqwest::Body
where
    S: Stream<Item = reqwest::Result<Bytes>> + Send + Unpin + 'static,
    T: Translate,
{
    struct State<S, T> {
        upstream: S,
        t: T,
        ended: bool,
    }
    let stream = futures_util::stream::unfold(
        State {
            upstream,
            t: translator,
            ended: false,
        },
        |mut st| async move {
            loop {
                if st.ended || st.t.done() {
                    return None;
                }
                match st.upstream.next().await {
                    Some(Ok(bytes)) => {
                        let out = st.t.feed(&bytes);
                        if !out.is_empty() {
                            return Some((Ok::<Bytes, std::io::Error>(Bytes::from(out)), st));
                        }
                    }
                    Some(Err(e)) => {
                        // Passed on as a stream error: the proxy's reader
                        // flushes its holdback and records the failure, as it
                        // does for a native upstream that drops mid-stream.
                        st.ended = true;
                        return Some((Err(std::io::Error::other(e)), st));
                    }
                    None => {
                        st.ended = true;
                        let out = st.t.finish();
                        if out.is_empty() {
                            return None;
                        }
                        return Some((Ok(Bytes::from(out)), st));
                    }
                }
            }
        },
    );
    reqwest::Body::wrap_stream(stream)
}

/// A `reqwest::Response` with `status` and an SSE body.
pub fn response(status: u16, body: reqwest::Body) -> reqwest::Response {
    reqwest::Response::from(
        axum::http::Response::builder()
            .status(status)
            .header("content-type", "text/event-stream")
            .body(body)
            .expect("static status and headers"),
    )
}

/// Splits an SSE byte stream into `data:` payloads, across chunk boundaries.
/// Buffers bytes, not text, so a multi-byte character split between two
/// chunks is decoded whole.
#[derive(Default)]
pub struct DataLines {
    buf: Vec<u8>,
}

impl DataLines {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            out.extend(data_of(&line));
        }
        out
    }

    /// A final line with no trailing newline.
    pub fn finish(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.buf);
        data_of(&rest)
    }
}

fn data_of(line: &[u8]) -> Option<String> {
    let line = String::from_utf8_lossy(line);
    line.trim_end_matches(['\n', '\r'])
        .strip_prefix("data:")
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
}

#[cfg(test)]
pub(crate) async fn collect(body: reqwest::Body) -> String {
    let resp = response(200, body);
    resp.text().await.unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Upper;
    impl Translate for Upper {
        fn feed(&mut self, bytes: &[u8]) -> String {
            String::from_utf8_lossy(bytes).to_uppercase()
        }
        fn finish(&mut self) -> String {
            "!".into()
        }
        fn done(&self) -> bool {
            false
        }
    }

    #[tokio::test]
    async fn the_translator_sees_every_chunk_and_closes_the_stream() {
        let up = futures_util::stream::iter(vec![
            Ok(Bytes::from_static(b"ab")),
            Ok(Bytes::from_static(b"")),
            Ok(Bytes::from_static(b"cd")),
        ]);
        assert_eq!(collect(translate(up, Upper)).await, "ABCD!");
    }

    #[test]
    fn data_lines_survive_any_split() {
        let raw = "data: {\"a\":1}\r\n\r\ndata: {\"b\":\"é\"}\n\n: comment\ndata:[3]";
        for i in 0..raw.len() {
            let mut d = DataLines::default();
            let mut got = d.push(&raw.as_bytes()[..i]);
            got.extend(d.push(&raw.as_bytes()[i..]));
            got.extend(d.finish());
            assert_eq!(got, vec!["{\"a\":1}", "{\"b\":\"é\"}", "[3]"], "split {i}");
        }
    }
}
