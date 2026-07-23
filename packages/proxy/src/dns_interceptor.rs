// dns_interceptor.rs — Lightweight DNS interceptor for AI provider domain enforcement.
//
// Listens on UDP port 53 (or a configurable port) and intercepts DNS queries
// for AI provider hostnames, redirecting their resolved IPs to the proxy's
// listening address. All other queries are forwarded transparently to the
// system resolver.
//
// This allows the MDM agent to enforce that AI API traffic is always
// routed through the Intutic governance proxy without requiring per-process
// environment variable injection.
//
// WS-6NC LLD #33 §3.1
//
// Architecture:
//   Developer machine DNS → intutic-dns (UDP 53) → system resolver
//                                                 ↘ proxy IP for AI hosts

use std::net::{SocketAddr, UdpSocket};
use std::time::Duration;

// Maximum DNS UDP payload per RFC 1035
const DNS_BUF_SIZE: usize = 512;
// DNS query/response header is always 12 bytes
const DNS_HEADER_LEN: usize = 12;

/// Error type for DNS interceptor operations.
#[derive(Debug)]
pub enum DnsError {
    Io(std::io::Error),
    InvalidPacket,
    ForwardFailed,
}

impl std::fmt::Display for DnsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DnsError::Io(e) => write!(f, "DNS I/O error: {}", e),
            DnsError::InvalidPacket => write!(f, "Invalid DNS packet"),
            DnsError::ForwardFailed => write!(f, "DNS forward failed"),
        }
    }
}

impl From<std::io::Error> for DnsError {
    fn from(e: std::io::Error) -> Self {
        DnsError::Io(e)
    }
}

/// Configuration for the DNS interceptor.
pub struct DnsInterceptorConfig {
    /// Address the interceptor listens on (default: 127.0.0.1:53).
    pub listen_addr: SocketAddr,
    /// System resolver to forward non-AI queries to (default: 1.1.1.1:53).
    pub upstream_resolver: SocketAddr,
    /// IP address of the Intutic proxy to inject for AI hostnames.
    pub proxy_ip: std::net::Ipv4Addr,
    /// Upstream query timeout.
    pub upstream_timeout: Duration,
}

impl Default for DnsInterceptorConfig {
    fn default() -> Self {
        let proxy_ip_str =
            std::env::var("INTUTIC_PROXY_IP").unwrap_or_else(|_| "127.0.0.1".to_string());
        let upstream_str =
            std::env::var("INTUTIC_DNS_UPSTREAM").unwrap_or_else(|_| "1.1.1.1:53".to_string());
        Self {
            listen_addr: "127.0.0.1:5353".parse().expect("valid addr"),
            upstream_resolver: upstream_str
                .parse()
                .unwrap_or_else(|_| "1.1.1.1:53".parse().unwrap()),
            proxy_ip: proxy_ip_str
                .parse()
                .unwrap_or_else(|_| [127, 0, 0, 1].into()),
            upstream_timeout: Duration::from_secs(2),
        }
    }
}

/// Extracts the queried hostname from a raw DNS query packet.
/// Returns None if the packet is malformed.
pub fn extract_query_name(buf: &[u8]) -> Option<String> {
    if buf.len() < DNS_HEADER_LEN + 1 {
        return None;
    }
    let mut pos = DNS_HEADER_LEN;
    let mut labels = Vec::new();

    loop {
        if pos >= buf.len() {
            return None;
        }
        let len = buf[pos] as usize;
        if len == 0 {
            break;
        }
        // Pointer compression not followed — skip
        if len & 0xC0 == 0xC0 {
            return None;
        }
        pos += 1;
        if pos + len > buf.len() {
            return None;
        }
        labels.push(std::str::from_utf8(&buf[pos..pos + len]).ok()?.to_string());
        pos += len;
    }

    Some(labels.join("."))
}

/// Builds a synthetic DNS A-record response redirecting `hostname` to `ip`.
///
/// Returns a minimal valid DNS response with a single A record and TTL=1
/// (short TTL forces re-resolution frequently so the rule can be revoked quickly).
pub fn build_redirect_response(query: &[u8], ip: std::net::Ipv4Addr) -> Option<Vec<u8>> {
    if query.len() < DNS_HEADER_LEN {
        return None;
    }

    let mut response = Vec::with_capacity(query.len() + 16);

    // Copy transaction ID from query
    response.extend_from_slice(&query[0..2]);

    // Flags: QR=1 (response), AA=1, RD=1, RA=1, RCODE=0
    response.push(0x85); // 1000 0101
    response.push(0x80); // 1000 0000

    // QDCOUNT=1, ANCOUNT=1, NSCOUNT=0, ARCOUNT=0
    response.extend_from_slice(&[0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);

    // Copy question section from original query (start at byte 12)
    response.extend_from_slice(&query[DNS_HEADER_LEN..]);

    // Answer section: pointer to question name (0xC00C)
    response.extend_from_slice(&[0xC0, 0x0C]); // Name: pointer to offset 12
    response.extend_from_slice(&[0x00, 0x01]); // Type: A
    response.extend_from_slice(&[0x00, 0x01]); // Class: IN
    response.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]); // TTL: 1 second
    response.extend_from_slice(&[0x00, 0x04]); // RDLENGTH: 4 bytes
    response.extend_from_slice(&ip.octets()); // RDATA: IPv4 address

    Some(response)
}

/// Runs the DNS interceptor. Blocks indefinitely.
///
/// For AI provider hostnames (as determined by `hostname_filter::is_ai_provider_host`),
/// responds with the proxy IP. All other queries are forwarded to the upstream resolver.
pub fn run_interceptor(cfg: DnsInterceptorConfig) -> Result<(), DnsError> {
    let sock = UdpSocket::bind(cfg.listen_addr)?;
    sock.set_read_timeout(Some(Duration::from_secs(1)))?;

    eprintln!(
        "[intutic-dns] Listening on {} — AI traffic redirected to {}",
        cfg.listen_addr, cfg.proxy_ip
    );

    let mut buf = [0u8; DNS_BUF_SIZE];

    loop {
        let (len, src) = match sock.recv_from(&mut buf) {
            Ok(r) => r,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue
            }
            Err(e) => return Err(DnsError::Io(e)),
        };

        let packet = &buf[..len];

        // Determine whether to intercept or forward
        let hostname = extract_query_name(packet);
        let should_intercept = hostname
            .as_deref()
            .map(crate::hostname_filter::is_ai_provider_host)
            .unwrap_or(false);

        if should_intercept {
            if let Some(response) = build_redirect_response(packet, cfg.proxy_ip) {
                let _ = sock.send_to(&response, src);
            }
        } else {
            // Forward to upstream resolver
            let upstream_sock = UdpSocket::bind("0.0.0.0:0")?;
            upstream_sock.set_read_timeout(Some(cfg.upstream_timeout))?;
            if upstream_sock.send_to(packet, cfg.upstream_resolver).is_ok() {
                let mut resp_buf = [0u8; DNS_BUF_SIZE];
                if let Ok((rlen, _)) = upstream_sock.recv_from(&mut resp_buf) {
                    let _ = sock.send_to(&resp_buf[..rlen], src);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_query(name: &str) -> Vec<u8> {
        // Minimal DNS query for name (type A, class IN)
        let mut pkt = vec![
            0xAB, 0xCD, // Transaction ID
            0x01, 0x00, // Flags: RD set
            0x00, 0x01, // QDCOUNT = 1
            0x00, 0x00, // ANCOUNT = 0
            0x00, 0x00, // NSCOUNT = 0
            0x00, 0x00, // ARCOUNT = 0
        ];
        for label in name.split('.') {
            pkt.push(label.len() as u8);
            pkt.extend_from_slice(label.as_bytes());
        }
        pkt.push(0); // End of QNAME
        pkt.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]); // QTYPE=A, QCLASS=IN
        pkt
    }

    #[test]
    fn test_extract_query_name_simple() {
        let pkt = make_query("api.openai.com");
        let name = extract_query_name(&pkt);
        assert_eq!(name.as_deref(), Some("api.openai.com"));
    }

    #[test]
    fn test_extract_query_name_single_label() {
        let pkt = make_query("localhost");
        let name = extract_query_name(&pkt);
        assert_eq!(name.as_deref(), Some("localhost"));
    }

    #[test]
    fn test_build_redirect_response_length() {
        let pkt = make_query("api.openai.com");
        let ip: std::net::Ipv4Addr = [127, 0, 0, 1].into();
        let resp = build_redirect_response(&pkt, ip).expect("response built");
        // Should be at least header + question + answer
        assert!(resp.len() > DNS_HEADER_LEN + 16);
    }

    #[test]
    fn test_build_redirect_response_transaction_id() {
        let pkt = make_query("api.anthropic.com");
        let ip: std::net::Ipv4Addr = [127, 0, 0, 1].into();
        let resp = build_redirect_response(&pkt, ip).unwrap();
        // Transaction ID must match query
        assert_eq!(resp[0], 0xAB);
        assert_eq!(resp[1], 0xCD);
    }

    #[test]
    fn test_build_redirect_response_flags_is_response() {
        let pkt = make_query("api.openai.com");
        let ip: std::net::Ipv4Addr = [10, 0, 0, 1].into();
        let resp = build_redirect_response(&pkt, ip).unwrap();
        // QR bit (bit 15) must be set
        assert!(
            resp[2] & 0x80 != 0,
            "QR bit should be set in response flags"
        );
    }

    #[test]
    fn test_invalid_packet_too_short() {
        let name = extract_query_name(&[0x00, 0x01]);
        assert!(name.is_none());
    }

    #[test]
    fn test_redirect_response_invalid_short_query() {
        let ip: std::net::Ipv4Addr = [127, 0, 0, 1].into();
        let resp = build_redirect_response(&[0x00], ip);
        assert!(resp.is_none());
    }
}
