//! The self-hosted guard on a decide engine's URL.
//!
//! A transliteration of `packages/shared-types/src/decideHostGuard.ts`; all
//! three guards run the `host` cases of
//! `packages/shared-types/fixtures/decide-engine-vectors.json`.
//!
//! The guard judges the literal URL, with no DNS lookup: loopback and private
//! addresses pass, a name passes only when it is `localhost`, ends in
//! `.local`, or is listed in `INTUTIC_SELF_HOSTED_DECISION_HOSTS`, and the
//! hosted decision APIs are refused even when listed. Anything but printable
//! ASCII, a backslash, a percent sign, a query or a fragment is refused rather
//! than normalised, so the HTTP client reaches the host the guard judged.

use once_cell::sync::Lazy;
use regex::Regex;
use std::net::Ipv6Addr;

/// Hosted decision APIs, matched on the host or any subdomain of it.
pub const DECIDE_HOSTED_DENYLIST: &[&str] = &[
    "typesafe.ai",
    "fastino.ai",
    "api.openai.com",
    "openai.azure.com",
    "services.ai.azure.com",
    "gateway.ai.cloudflare.com",
    "ai-gateway.vercel.sh",
    "api.fireworks.ai",
    "api.perplexity.ai",
    "cloud.databricks.com",
    "azuredatabricks.net",
];

const DECISION_ROUTES: &[&str] = &["/v1/decisions", "/v1/systemone"];

static AUTHORITY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9._-]+))(?::([0-9]{1,5}))?$")
        .expect("static regex")
});

/// The guard's verdict. `reason` is `loopback`, `private` or `listed` when
/// `ok`; otherwise `scheme`, `bad_url`, `credentials`, `denylist`,
/// `decision_path` or `not_listed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostVerdict {
    pub ok: bool,
    pub host: String,
    pub reason: &'static str,
}

fn refuse(host: &str, reason: &'static str) -> HostVerdict {
    HostVerdict {
        ok: false,
        host: host.to_string(),
        reason,
    }
}

fn host_matches(host: &str, name: &str) -> bool {
    host == name
        || (host.len() > name.len()
            && host.ends_with(name)
            && host.as_bytes()[host.len() - name.len() - 1] == b'.')
}

fn normalise_name(name: &str) -> String {
    let lower = name.trim().to_ascii_lowercase();
    lower.strip_suffix('.').map(str::to_string).unwrap_or(lower)
}

fn parse_ipv4(host: &str) -> Option<[u16; 4]> {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u16; 4];
    for (i, p) in parts.iter().enumerate() {
        let canonical = !p.is_empty()
            && p.len() <= 3
            && p.bytes().all(|b| b.is_ascii_digit())
            && (p.len() == 1 || !p.starts_with('0'));
        if !canonical {
            return None;
        }
        let n: u16 = p.parse().ok()?;
        if n > 255 {
            return None;
        }
        out[i] = n;
    }
    Some(out)
}

fn listed_names(listed: Option<&str>) -> Vec<String> {
    listed
        .unwrap_or("")
        .split(',')
        .map(normalise_name)
        .map(|e| e.strip_prefix('.').map(str::to_string).unwrap_or(e))
        .filter(|e| !e.is_empty())
        .collect()
}

/// Judges a decide engine's base URL. `listed` is the value of
/// `INTUTIC_SELF_HOSTED_DECISION_HOSTS` (a comma list).
pub fn check_self_hosted_decision_host(url: &str, listed: Option<&str>) -> HostVerdict {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    let rest = if lower.starts_with("http://") {
        &url[7..]
    } else if lower.starts_with("https://") {
        &url[8..]
    } else {
        return refuse("", "scheme");
    };
    if rest
        .chars()
        .any(|c| !('\u{21}'..='\u{7e}').contains(&c) || matches!(c, '\\' | '%' | '?' | '#'))
    {
        return refuse("", "bad_url");
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if authority.contains('@') {
        return refuse("", "credentials");
    }

    let Some(m) = AUTHORITY.captures(authority) else {
        return refuse("", "bad_url");
    };
    if let Some(port) = m.get(3) {
        if port.as_str().parse::<u32>().map_or(true, |p| p > 65535) {
            return refuse("", "bad_url");
        }
    }
    let (host, v6) = match (m.get(1), m.get(2)) {
        (Some(v6), _) => {
            let text = v6.as_str().to_ascii_lowercase();
            match text.parse::<Ipv6Addr>() {
                Ok(addr) => (text, Some(addr.segments())),
                Err(_) => return refuse("", "bad_url"),
            }
        }
        (None, Some(name)) => (normalise_name(name.as_str()), None),
        _ => return refuse("", "bad_url"),
    };
    if host.is_empty() {
        return refuse("", "bad_url");
    }

    if DECIDE_HOSTED_DENYLIST
        .iter()
        .any(|d| host_matches(&host, d))
    {
        return refuse(&host, "denylist");
    }

    let local = match v6 {
        Some(g) if g[..7].iter().all(|&x| x == 0) && g[7] == 1 => Some("loopback"),
        Some(g) if g[0] & 0xfe00 == 0xfc00 => Some("private"),
        Some(_) => None,
        None => match parse_ipv4(&host) {
            Some([127, ..]) => Some("loopback"),
            Some([10, ..]) | Some([192, 168, ..]) | Some([169, 254, ..]) => Some("private"),
            Some([172, b, ..]) if (16..=31).contains(&b) => Some("private"),
            Some(_) => None,
            None if host == "localhost" => Some("loopback"),
            None if host.ends_with(".local") => Some("private"),
            None => None,
        },
    };
    if let Some(reason) = local {
        return HostVerdict {
            ok: true,
            host,
            reason,
        };
    }

    let lower_path = path.to_ascii_lowercase();
    if DECISION_ROUTES.iter().any(|r| lower_path.contains(r)) {
        return refuse(&host, "decision_path");
    }
    if listed_names(listed)
        .iter()
        .any(|name| host_matches(&host, name))
    {
        return HostVerdict {
            ok: true,
            host,
            reason: "listed",
        };
    }
    refuse(&host, "not_listed")
}
