//! listen.rs — the addresses the proxy listens on, and whether a peer that is
//! not this machine may use it.
//!
//! A local proxy listens on loopback only. Listening on every interface made
//! it an open `CONNECT` tunnel for anyone on the same network, because the
//! egress policy is off by default and tunnels every host it does not
//! intercept. `INTUTIC_PROXY_BIND` opens it to other addresses on purpose: a
//! container image or a shared gateway, where the clients are elsewhere by
//! design.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::OnceLock;

/// The addresses to listen on, from `INTUTIC_PROXY_BIND` (`value`): a
/// comma-separated list of IP addresses. Unset or blank, a proxy with the
/// gateway front door on (`INTUTIC_GATEWAY_REQUIRE_VK`, every caller holds a
/// virtual key) listens on every interface, and any other proxy on loopback.
pub fn resolve_bind(value: Option<&str>, gateway: bool) -> Result<Vec<IpAddr>, String> {
    let value = value.map(str::trim).unwrap_or("");
    if value.is_empty() {
        let ip = if gateway {
            Ipv4Addr::UNSPECIFIED
        } else {
            Ipv4Addr::LOCALHOST
        };
        return Ok(vec![IpAddr::V4(ip)]);
    }
    let mut addrs = Vec::new();
    for part in value.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let ip: IpAddr = part.parse().map_err(|_| {
            format!(
                "INTUTIC_PROXY_BIND: `{part}` is not an IP address. Give one or more, \
                 comma-separated: 127.0.0.1 (this machine only), 0.0.0.0 (every interface), \
                 or a specific interface's address"
            )
        })?;
        if !addrs.contains(&ip) {
            addrs.push(ip);
        }
    }
    if addrs.is_empty() {
        return Err("INTUTIC_PROXY_BIND names no address".to_string());
    }
    Ok(addrs)
}

/// Whether listening on `addrs` lets peers other than this machine connect.
pub fn is_open(addrs: &[IpAddr]) -> bool {
    addrs.iter().any(|ip| !ip.is_loopback())
}

static LISTENER_OPEN: OnceLock<bool> = OnceLock::new();

/// Record, once at startup, whether the listener was opened beyond loopback.
pub fn set_listener_open(open: bool) {
    let _ = LISTENER_OPEN.set(open);
}

/// Whether the listener was opened beyond loopback. `false` until
/// [`set_listener_open`] runs, so a proxy that never set it treats every
/// non-loopback peer as unexpected.
pub fn listener_open() -> bool {
    LISTENER_OPEN.get().copied().unwrap_or(false)
}

/// Whether `peer` is this machine. An IPv4 peer on a dual-stack `::` listener
/// arrives as `::ffff:127.0.0.1`, which is loopback too.
pub fn is_loopback_peer(peer: IpAddr) -> bool {
    peer.to_canonical().is_loopback()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ips(list: &[&str]) -> Vec<IpAddr> {
        list.iter().map(|s| s.parse().unwrap()).collect()
    }

    #[test]
    fn a_local_proxy_listens_on_loopback_by_default() {
        assert_eq!(resolve_bind(None, false).unwrap(), ips(&["127.0.0.1"]));
        assert_eq!(
            resolve_bind(Some("  "), false).unwrap(),
            ips(&["127.0.0.1"])
        );
        assert!(!is_open(&resolve_bind(None, false).unwrap()));
    }

    #[test]
    fn a_gateway_listens_on_every_interface_by_default() {
        assert_eq!(resolve_bind(None, true).unwrap(), ips(&["0.0.0.0"]));
        assert!(is_open(&resolve_bind(None, true).unwrap()));
    }

    #[test]
    fn the_variable_wins_and_takes_a_list() {
        assert_eq!(
            resolve_bind(Some("127.0.0.1, 172.17.0.1"), false).unwrap(),
            ips(&["127.0.0.1", "172.17.0.1"])
        );
        assert_eq!(
            resolve_bind(Some("127.0.0.1"), true).unwrap(),
            ips(&["127.0.0.1"])
        );
        assert_eq!(resolve_bind(Some("::1,::1"), false).unwrap(), ips(&["::1"]));
        assert!(is_open(&ips(&["127.0.0.1", "172.17.0.1"])));
        assert!(!is_open(&ips(&["127.0.0.1", "::1"])));
    }

    #[test]
    fn an_address_that_does_not_parse_is_refused() {
        let err = resolve_bind(Some("localhost"), false).unwrap_err();
        assert!(err.contains("`localhost`"), "{err}");
        assert!(resolve_bind(Some("0.0.0.0:4000"), false).is_err());
        assert!(resolve_bind(Some(","), false).is_err());
    }

    #[test]
    fn loopback_peers_include_mapped_ipv4() {
        assert!(is_loopback_peer("127.0.0.1".parse().unwrap()));
        assert!(is_loopback_peer("::1".parse().unwrap()));
        assert!(is_loopback_peer("::ffff:127.0.0.1".parse().unwrap()));
        assert!(!is_loopback_peer("192.168.1.42".parse().unwrap()));
        assert!(!is_loopback_peer("::ffff:10.0.0.5".parse().unwrap()));
    }
}
