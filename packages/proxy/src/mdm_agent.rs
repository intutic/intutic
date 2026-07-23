// mdm_agent.rs — MDM agent core: CA install, DNS config, firewall setup, heartbeat.
//
// The MDM agent runs as a background daemon on developer machines.
// Responsibilities:
//   1. Install the Intutic CA certificate into system trust store
//   2. Configure system DNS to use the local DNS interceptor
//   3. Apply platform-appropriate firewall rules
//   4. Send periodic heartbeat to the control plane
//   5. Receive and apply configuration updates (bypass rules, etc.)
//
// WS-6NC LLD #33 §3.2

use std::time::Duration;

/// Agent version reported in heartbeats.
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Result type for MDM operations.
pub type MdmResult<T> = Result<T, MdmError>;

/// Errors from MDM agent operations.
#[derive(Debug)]
pub enum MdmError {
    CaInstall(String),
    DnsConfig(String),
    FirewallSetup(String),
    Heartbeat(String),
    Config(String),
    Io(std::io::Error),
}

impl std::fmt::Display for MdmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MdmError::CaInstall(m) => write!(f, "CA install failed: {}", m),
            MdmError::DnsConfig(m) => write!(f, "DNS config failed: {}", m),
            MdmError::FirewallSetup(m) => write!(f, "Firewall setup failed: {}", m),
            MdmError::Heartbeat(m) => write!(f, "Heartbeat failed: {}", m),
            MdmError::Config(m) => write!(f, "Config error: {}", m),
            MdmError::Io(e) => write!(f, "IO error: {}", e),
        }
    }
}

impl From<std::io::Error> for MdmError {
    fn from(e: std::io::Error) -> Self {
        MdmError::Io(e)
    }
}

/// MDM agent configuration, populated at startup.
#[derive(Debug, Clone)]
pub struct MdmAgentConfig {
    /// Intutic control plane base URL.
    pub control_plane_url: String,
    /// Workspace ID this device belongs to.
    pub workspace_id: String,
    /// Device ID assigned on enrollment (mdm_ prefixed).
    pub device_id: String,
    /// Heartbeat interval.
    pub heartbeat_interval: Duration,
    /// Whether to install the CA certificate.
    pub with_ca: bool,
    /// Whether to configure DNS interception.
    pub with_dns: bool,
    /// Whether to apply firewall rules.
    pub with_firewall: bool,
    /// Local proxy port.
    pub proxy_port: u16,
}

impl MdmAgentConfig {
    /// Load from environment variables.
    pub fn from_env() -> Result<Self, MdmError> {
        let control_plane_url = std::env::var("INTUTIC_CONTROL_PLANE_URL")
            .unwrap_or_else(|_| "https://api.intutic.ai".to_string());
        let workspace_id = std::env::var("INTUTIC_WORKSPACE_ID")
            .map_err(|_| MdmError::Config("INTUTIC_WORKSPACE_ID not set".to_string()))?;
        let device_id =
            std::env::var("INTUTIC_DEVICE_ID").unwrap_or_else(|_| format!("mdm_{}", uuid_stub()));
        let heartbeat_s: u64 = std::env::var("INTUTIC_HEARTBEAT_INTERVAL_S")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(300);

        Ok(Self {
            control_plane_url,
            workspace_id,
            device_id,
            heartbeat_interval: Duration::from_secs(heartbeat_s),
            with_ca: true,
            with_dns: true,
            with_firewall: true,
            proxy_port: std::env::var("INTUTIC_PROXY_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(8080),
        })
    }
}

/// Simple deterministic ID generation without external deps.
/// In production use the `id` package from `@intutic/id` equivalent.
fn uuid_stub() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:016x}", t)
}

// ── Status tracking ─────────────────────────────────────────────────────────

/// Current status of each MDM subsystem.
#[derive(Debug, Clone, Default)]
pub struct AgentStatus {
    pub ca_installed: bool,
    pub dns_configured: bool,
    pub firewall_configured: bool,
    pub last_heartbeat_at: Option<std::time::SystemTime>,
    pub last_error: Option<String>,
}

// ── CA installation ─────────────────────────────────────────────────────────

/// Platform-specific CA installation result message.
pub fn install_ca_certificate(cert_pem: &str) -> MdmResult<()> {
    #[cfg(target_os = "macos")]
    {
        install_ca_macos(cert_pem)
    }
    #[cfg(target_os = "linux")]
    {
        install_ca_linux(cert_pem)
    }
    #[cfg(target_os = "windows")]
    {
        install_ca_windows(cert_pem)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        // Unsupported platform — log and continue
        eprintln!("[intutic-mdm] CA install: unsupported platform, skipping.");
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn install_ca_macos(cert_pem: &str) -> MdmResult<()> {
    use std::process::Command;
    // Write cert to temp file
    let tmp = std::env::temp_dir().join("intutic-ca.pem");
    std::fs::write(&tmp, cert_pem).map_err(MdmError::Io)?;

    let status = Command::new("security")
        .args([
            "add-trusted-cert",
            "-d",
            "-r",
            "trustRoot",
            "-k",
            "/Library/Keychains/System.keychain",
        ])
        .arg(tmp.to_str().unwrap_or_default())
        .status()
        .map_err(MdmError::Io)?;

    if status.success() {
        Ok(())
    } else {
        Err(MdmError::CaInstall(
            "security add-trusted-cert failed".to_string(),
        ))
    }
}

#[cfg(target_os = "linux")]
fn install_ca_linux(cert_pem: &str) -> MdmResult<()> {
    use std::process::Command;

    // Try multiple CA bundle paths (distro-agnostic)
    let cert_path = if std::path::Path::new("/usr/local/share/ca-certificates").exists() {
        // Debian/Ubuntu
        let p = std::path::Path::new("/usr/local/share/ca-certificates/intutic-ca.crt");
        std::fs::write(p, cert_pem).map_err(MdmError::Io)?;
        Command::new("update-ca-certificates")
            .status()
            .map_err(MdmError::Io)?;
        p.to_path_buf()
    } else {
        // RHEL/Fedora
        let p = std::path::Path::new("/etc/pki/ca-trust/source/anchors/intutic-ca.crt");
        std::fs::write(p, cert_pem).map_err(MdmError::Io)?;
        Command::new("update-ca-trust")
            .status()
            .map_err(MdmError::Io)?;
        p.to_path_buf()
    };

    eprintln!("[intutic-mdm] CA installed at {:?}", cert_path);
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_ca_windows(cert_pem: &str) -> MdmResult<()> {
    use std::process::Command;
    let tmp = std::env::temp_dir().join("intutic-ca.cer");
    std::fs::write(&tmp, cert_pem).map_err(MdmError::Io)?;
    let status = Command::new("certutil")
        .args(["-addstore", "Root", tmp.to_str().unwrap_or_default()])
        .status()
        .map_err(MdmError::Io)?;

    if status.success() {
        Ok(())
    } else {
        Err(MdmError::CaInstall("certutil -addstore failed".to_string()))
    }
}

// ── DNS configuration ────────────────────────────────────────────────────────

/// Configures the system DNS resolver to use the local Intutic DNS interceptor.
pub fn configure_dns(interceptor_ip: &str, interceptor_port: u16) -> MdmResult<()> {
    let addr = format!("{}:{}", interceptor_ip, interceptor_port);
    eprintln!("[intutic-mdm] Configuring DNS → {}", addr);

    #[cfg(target_os = "macos")]
    return configure_dns_macos(interceptor_ip, interceptor_port);

    #[cfg(target_os = "linux")]
    return configure_dns_linux(interceptor_ip);

    #[cfg(target_os = "windows")]
    return configure_dns_windows(interceptor_ip);

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        eprintln!("[intutic-mdm] DNS config: unsupported platform, skipping.");
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn configure_dns_macos(ip: &str, _port: u16) -> MdmResult<()> {
    use std::process::Command;
    // Configure all active network services
    let output = Command::new("networksetup")
        .args(["-listallnetworkservices"])
        .output()
        .map_err(MdmError::Io)?;

    let services = String::from_utf8_lossy(&output.stdout);
    for svc in services.lines().skip(1) {
        let svc = svc.trim();
        if svc.is_empty() || svc.starts_with('*') {
            continue;
        }
        let _ = Command::new("networksetup")
            .args(["-setdnsservers", svc, ip])
            .status();
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn configure_dns_linux(ip: &str) -> MdmResult<()> {
    // Write resolv.conf stub — works for systemd-resolved and classic resolver
    let resolv = format!(
        "# Managed by Intutic MDM agent — do not edit\nnameserver {}\n",
        ip
    );
    if std::path::Path::new("/etc/systemd/resolved.conf.d").exists() {
        std::fs::create_dir_all("/etc/systemd/resolved.conf.d").map_err(MdmError::Io)?;
        std::fs::write(
            "/etc/systemd/resolved.conf.d/99-intutic.conf",
            format!("[Resolve]\nDNS={}\n", ip),
        )
        .map_err(MdmError::Io)?;
        let _ = std::process::Command::new("systemctl")
            .args(["restart", "systemd-resolved"])
            .status();
    } else {
        std::fs::write("/etc/resolv.conf", resolv).map_err(MdmError::Io)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn configure_dns_windows(ip: &str) -> MdmResult<()> {
    use std::process::Command;
    // Set DNS for all interfaces via netsh
    let output = Command::new("netsh")
        .args(["interface", "show", "interface"])
        .output()
        .map_err(MdmError::Io)?;

    let interfaces = String::from_utf8_lossy(&output.stdout);
    for line in interfaces.lines().skip(3) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 4 {
            let iface = parts[3..].join(" ");
            let _ = Command::new("netsh")
                .args(["interface", "ip", "set", "dns", &iface, "static", ip])
                .status();
        }
    }
    Ok(())
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

/// Payload sent to the control plane every heartbeat interval.
#[derive(Debug, Clone)]
pub struct HeartbeatPayload {
    pub device_id: String,
    pub workspace_id: String,
    pub hostname: String,
    pub platform: String,
    pub proxy_version: String,
    pub ca_installed: bool,
    pub dns_configured: bool,
    pub firewall_configured: bool,
}

impl HeartbeatPayload {
    pub fn to_json(&self) -> String {
        format!(
            r#"{{"deviceId":"{did}","workspaceId":"{wid}","hostname":"{hn}","platform":"{pl}","proxyVersion":"{pv}","caInstalled":{ca},"dnsConfigured":{dns},"firewallConfigured":{fw}}}"#,
            did = self.device_id,
            wid = self.workspace_id,
            hn = self.hostname,
            pl = self.platform,
            pv = self.proxy_version,
            ca = self.ca_installed,
            dns = self.dns_configured,
            fw = self.firewall_configured,
        )
    }
}

/// Sends a single heartbeat to the control plane.
/// Non-blocking — on network error logs and continues.
pub fn send_heartbeat(base_url: &str, payload: &HeartbeatPayload) -> MdmResult<()> {
    let url = format!("{}/api/v1/network/mdm/heartbeat", base_url);
    let body = payload.to_json();

    // Use a simple TCP socket rather than pulling in reqwest to keep the
    // proxy binary lightweight. In production the MDM daemon uses the
    // separate `intutic-mdm` binary which can pull full HTTP client deps.
    eprintln!("[intutic-mdm] Heartbeat → {} ({} bytes)", url, body.len());

    // Actual HTTP call would go here in the full mdm binary.
    // The proxy library only provides the payload builder/serialiser.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_heartbeat_payload_json_fields() {
        let p = HeartbeatPayload {
            device_id: "mdm_test123".to_string(),
            workspace_id: "ws_abc".to_string(),
            hostname: "dev-laptop".to_string(),
            platform: "darwin".to_string(),
            proxy_version: "0.6.0".to_string(),
            ca_installed: true,
            dns_configured: false,
            firewall_configured: true,
        };

        let json = p.to_json();
        assert!(
            json.contains("\"deviceId\":\"mdm_test123\""),
            "missing deviceId"
        );
        assert!(
            json.contains("\"workspaceId\":\"ws_abc\""),
            "missing workspaceId"
        );
        assert!(json.contains("\"caInstalled\":true"), "missing caInstalled");
        assert!(
            json.contains("\"dnsConfigured\":false"),
            "missing dnsConfigured"
        );
        assert!(
            json.contains("\"firewallConfigured\":true"),
            "missing firewallConfigured"
        );
    }

    #[test]
    fn test_heartbeat_payload_json_is_valid_shape() {
        let p = HeartbeatPayload {
            device_id: "mdm_x".to_string(),
            workspace_id: "ws_y".to_string(),
            hostname: "host".to_string(),
            platform: "linux".to_string(),
            proxy_version: "0.6.0".to_string(),
            ca_installed: false,
            dns_configured: false,
            firewall_configured: false,
        };
        let json = p.to_json();
        // Must start and end with braces
        assert!(json.starts_with('{'), "JSON must start with {{");
        assert!(json.ends_with('}'), "JSON must end with }}");
    }

    #[test]
    fn test_agent_version_is_set() {
        // CARGO_PKG_VERSION must be non-empty
        assert!(!AGENT_VERSION.is_empty());
    }

    #[test]
    fn test_uuid_stub_is_non_empty() {
        let id = uuid_stub();
        assert!(!id.is_empty());
        assert_eq!(id.len(), 16); // 16 hex chars
    }
}
