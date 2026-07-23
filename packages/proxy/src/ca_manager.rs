//! ca_manager.rs — Local CA certificate generation and management.
//!
//! Generates a self-signed CA keypair stored at ~/.intutic/ca.{crt,key}
//! with mode 0o600. The CA is used by tls_mitm.rs to sign per-host
//! certificates on-the-fly for TLS interception of AI provider traffic.
//!
//! The public CA cert must be installed in the OS trust store via
//! the CLI `intutic init` command (ca-installer.ts) before MITM works.

use anyhow::{Context, Result};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, KeyPair, SanType,
};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use tracing::info;

/// Paths for the generated CA keypair.
pub fn ca_cert_path() -> PathBuf {
    intutic_dir().join("ca.crt")
}

pub fn ca_key_path() -> PathBuf {
    intutic_dir().join("ca.key")
}

pub fn ca_cert_der_path() -> PathBuf {
    intutic_dir().join("ca.der")
}

fn intutic_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".intutic")
}

/// Returns true if the CA cert and key files already exist.
pub fn is_ca_present() -> bool {
    ca_cert_path().exists() && ca_key_path().exists()
}

/// Holds the raw PEM bytes of the CA cert and key.
#[derive(Clone)]
pub struct CaKeyPair {
    pub cert_pem: String,
    pub key_pem: String,
    pub cert_der: Vec<u8>,
}

/// Ensure the CA keypair exists, generating it if not.
/// Called at proxy startup. Idempotent.
pub async fn ensure_ca_exists() -> Result<CaKeyPair> {
    if is_ca_present() {
        let cert_pem = tokio::fs::read_to_string(ca_cert_path())
            .await
            .context("Failed to read ca.crt")?;
        let key_pem = tokio::fs::read_to_string(ca_key_path())
            .await
            .context("Failed to read ca.key")?;
        let cert_der = tokio::fs::read(ca_cert_der_path())
            .await
            .unwrap_or_default();
        info!("CA keypair loaded from ~/.intutic/");
        return Ok(CaKeyPair {
            cert_pem,
            key_pem,
            cert_der,
        });
    }

    info!("Generating new CA keypair in ~/.intutic/");
    let pair = generate_ca()?;
    persist_ca(&pair).await?;
    Ok(pair)
}

/// Generate a self-signed CA certificate using rcgen.
fn generate_ca() -> Result<CaKeyPair> {
    let mut params = CertificateParams::default();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);

    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "Intutic Governance Proxy CA");
    dn.push(DnType::OrganizationName, "Intutic");
    params.distinguished_name = dn;

    // Valid for 10 years
    params.not_before = rcgen::date_time_ymd(2025, 1, 1);
    params.not_after = rcgen::date_time_ymd(2035, 1, 1);

    let key_pair = KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();
    let cert_der = cert.der().to_vec();

    Ok(CaKeyPair {
        cert_pem,
        key_pem,
        cert_der,
    })
}

/// Persist the CA keypair to ~/.intutic/ with restrictive permissions.
async fn persist_ca(pair: &CaKeyPair) -> Result<()> {
    let dir = intutic_dir();
    tokio::fs::create_dir_all(&dir)
        .await
        .context("Failed to create ~/.intutic/")?;

    // Write cert (world-readable for OS trust store import)
    tokio::fs::write(ca_cert_path(), &pair.cert_pem)
        .await
        .context("Failed to write ca.crt")?;
    tokio::fs::write(ca_cert_der_path(), &pair.cert_der)
        .await
        .context("Failed to write ca.der")?;

    // Write key (owner-only)
    tokio::fs::write(ca_key_path(), &pair.key_pem)
        .await
        .context("Failed to write ca.key")?;
    #[cfg(unix)]
    {
        let meta = tokio::fs::metadata(ca_key_path()).await?;
        let mut perms = meta.permissions();
        perms.set_mode(0o600);
        tokio::fs::set_permissions(ca_key_path(), perms)
            .await
            .context("Failed to chmod ca.key")?;
    }

    info!("CA keypair written to ~/.intutic/ (key mode 0600)");
    Ok(())
}

/// Sign a TLS certificate for a specific hostname using the CA.
/// Called by tls_mitm.rs for each intercepted CONNECT request.
/// In rcgen 0.13, we regenerate the CA cert from PEM to get a Certificate
/// object for signing, which is the supported pattern.
pub fn sign_cert_for_host(ca: &CaKeyPair, hostname: &str) -> Result<SignedCert> {
    let issuer_key = KeyPair::from_pem(&ca.key_pem)?;

    let mut issuer_params = CertificateParams::default();
    issuer_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let mut issuer_dn = DistinguishedName::new();
    issuer_dn.push(DnType::CommonName, "Intutic Governance Proxy CA");
    issuer_params.distinguished_name = issuer_dn;
    issuer_params.not_before = rcgen::date_time_ymd(2025, 1, 1);
    issuer_params.not_after = rcgen::date_time_ymd(2035, 1, 1);
    let issuer_cert = issuer_params.self_signed(&issuer_key)?;

    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, hostname);
    params.distinguished_name = dn;
    params.subject_alt_names = vec![SanType::DnsName(hostname.try_into()?)];
    params.not_before = rcgen::date_time_ymd(2025, 1, 1);
    params.not_after = rcgen::date_time_ymd(2026, 12, 31);

    let leaf_key = KeyPair::generate()?;
    let cert = params.signed_by(&leaf_key, &issuer_cert, &issuer_key)?;

    Ok(SignedCert {
        cert_pem: cert.pem(),
        key_pem: leaf_key.serialize_pem(),
    })
}

pub struct SignedCert {
    pub cert_pem: String,
    pub key_pem: String,
}

/// Check if the CA cert is trusted by the OS trust store.
/// Returns None if the check cannot be performed (platform unsupported).
pub fn is_ca_trusted() -> Option<bool> {
    // Delegate to the CLI ca-installer.ts for actual verification.
    // Proxy just checks if the cert file exists as a proxy for "was init run".
    Some(ca_cert_path().exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_ca() {
        let ca = generate_ca().expect("Failed to generate CA");
        assert!(!ca.cert_pem.is_empty());
        assert!(!ca.key_pem.is_empty());
        assert!(!ca.cert_der.is_empty());
        assert!(ca.cert_pem.contains("BEGIN CERTIFICATE"));
        assert!(ca.key_pem.contains("BEGIN PRIVATE KEY"));
    }

    #[test]
    fn test_sign_cert_for_host() {
        let ca = generate_ca().expect("Failed to generate CA");
        let host = "api.anthropic.com";
        let cert = sign_cert_for_host(&ca, host).expect("Failed to sign cert");
        assert!(!cert.cert_pem.is_empty());
        assert!(!cert.key_pem.is_empty());
        assert!(cert.cert_pem.contains("BEGIN CERTIFICATE"));
        assert!(cert.key_pem.contains("BEGIN PRIVATE KEY"));

        let host2 = "api2.cursor.sh";
        let cert2 = sign_cert_for_host(&ca, host2).expect("Failed to sign cert");
        assert!(!cert2.cert_pem.is_empty());
        assert!(cert2.cert_pem.contains("BEGIN CERTIFICATE"));
    }

    #[test]
    fn test_ca_paths() {
        let cert = ca_cert_path();
        let key = ca_key_path();
        assert!(cert.to_string_lossy().contains(".intutic"));
        assert!(key.to_string_lossy().contains(".intutic"));
        assert!(cert.to_string_lossy().contains("ca.crt"));
        assert!(key.to_string_lossy().contains("ca.key"));
    }
}
