//! ca_manager.rs — Local CA certificate generation and management.
//!
//! Generates a self-signed CA keypair stored at ~/.intutic/ca.{crt,key}
//! with mode 0o600. The CA is used by tls_mitm.rs to sign per-host
//! certificates on-the-fly for TLS interception of AI provider traffic.
//!
//! The public CA cert must be installed in the OS trust store via
//! the CLI `intutic init` command (`tools/cli/src/lib/caTrust.ts`) before
//! MITM works.

use anyhow::{Context, Result};
use chrono::{DateTime, Datelike, Duration, NaiveDateTime, Utc};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, SanType,
};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use tracing::{info, warn};

use crate::paths::intutic_dir;

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

/// Returns true if the CA cert and key files already exist.
pub fn is_ca_present() -> bool {
    ca_cert_path().exists() && ca_key_path().exists()
}

/// How long a per-host leaf certificate is valid, counted from when it is
/// minted. Well inside the 398 days browsers and Apple platforms accept for a
/// TLS server certificate. Leaves are minted per `CONNECT` and never cached,
/// so every connection gets a fresh window.
const LEAF_VALIDITY_DAYS: i64 = 90;
const _: () = assert!(LEAF_VALIDITY_DAYS <= 397);

/// How far a leaf's and the CA's `notBefore` is set back, so a client whose
/// clock runs a little behind does not see a certificate from the future.
const BACKDATE_DAYS: i64 = 1;

/// How long a newly generated CA is valid.
const CA_VALIDITY_DAYS: i64 = 3650;

/// A CA this close to its `notAfter` (or past it) is replaced when it is
/// loaded, and the new one has to be trusted again (`intutic connect`).
const CA_RENEW_BEFORE_DAYS: i64 = 30;

/// Set `params`' validity to `[now - BACKDATE_DAYS, now + days]`, at day
/// granularity. Both bounds are relative to `now`: a certificate minted on any
/// date is valid for the same window from that date.
fn set_validity(params: &mut CertificateParams, now: DateTime<Utc>, days: i64) {
    let start = (now - Duration::days(BACKDATE_DAYS)).date_naive();
    let end = (now + Duration::days(days)).date_naive();
    params.not_before = rcgen::date_time_ymd(start.year(), start.month() as u8, start.day() as u8);
    params.not_after = rcgen::date_time_ymd(end.year(), end.month() as u8, end.day() as u8);
}

/// The CA's subject, which is also every leaf's issuer. One definition, so the
/// two cannot drift apart: a leaf whose issuer name differs from the CA's
/// subject does not chain to it, and clients reject it.
fn ca_distinguished_name() -> DistinguishedName {
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "Intutic Governance Proxy CA");
    dn.push(DnType::OrganizationName, "Intutic");
    dn
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
        let cert_der = match pem_to_der(&cert_pem) {
            Some(der) => der,
            None => tokio::fs::read(ca_cert_der_path())
                .await
                .unwrap_or_default(),
        };
        if ca_needs_renewal(&cert_der, Utc::now()) {
            warn!(
                "The CA in ~/.intutic/ has expired or expires within {CA_RENEW_BEFORE_DAYS} days; \
                 generating a new one. Run `intutic connect` to trust it, or intercepted \
                 connections will be refused."
            );
        } else {
            info!("CA keypair loaded from ~/.intutic/");
            return Ok(CaKeyPair {
                cert_pem,
                key_pem,
                cert_der,
            });
        }
    } else {
        info!("Generating new CA keypair in ~/.intutic/");
    }

    let pair = generate_ca_at(Utc::now())?;
    persist_ca(&pair).await?;
    Ok(pair)
}

/// The first certificate in `pem`, as DER.
fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
    let mut reader = std::io::Cursor::new(pem.as_bytes());
    let first = rustls_pemfile::certs(&mut reader).next()?.ok()?;
    Some(first.to_vec())
}

/// Whether a loaded CA must be replaced: it has expired, or will within
/// `CA_RENEW_BEFORE_DAYS`. A certificate whose expiry cannot be read is kept
/// rather than replaced, since a new CA has to be trusted again by hand.
fn ca_needs_renewal(cert_der: &[u8], now: DateTime<Utc>) -> bool {
    match cert_not_after(cert_der) {
        Some(not_after) => not_after <= (now + Duration::days(CA_RENEW_BEFORE_DAYS)).naive_utc(),
        None => {
            warn!("Could not read the expiry of ~/.intutic/ca.crt; keeping it");
            false
        }
    }
}

/// A certificate's `notAfter`, read from its DER encoding:
/// `Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { [0] version OPTIONAL,
/// serialNumber, signature, issuer, validity SEQUENCE { notBefore, notAfter }, … } … }`.
fn cert_not_after(der: &[u8]) -> Option<NaiveDateTime> {
    let (cert, _) = der_take(der, 0x30)?;
    let (mut tbs, _) = der_take(cert, 0x30)?;
    if tbs.first() == Some(&0xa0) {
        tbs = der_take(tbs, 0xa0)?.1;
    }
    // serialNumber, signature, issuer
    for tag in [0x02, 0x30, 0x30] {
        tbs = der_take(tbs, tag)?.1;
    }
    let (validity, _) = der_take(tbs, 0x30)?;
    // notBefore, then notAfter: each a UTCTime (0x17) or GeneralizedTime (0x18).
    let rest = der_take(validity, *validity.first()?)?.1;
    let tag = *rest.first()?;
    if tag != 0x17 && tag != 0x18 {
        return None;
    }
    let text = std::str::from_utf8(der_take(rest, tag)?.0).ok()?;
    // UTCTime has a two-digit year: 50–99 is 19xx, 00–49 is 20xx (RFC 5280).
    let full = if tag == 0x17 {
        let yy: u32 = text.get(..2)?.parse().ok()?;
        format!("{}{}", if yy >= 50 { 19 } else { 20 }, text)
    } else {
        text.to_string()
    };
    NaiveDateTime::parse_from_str(&full, "%Y%m%d%H%M%SZ").ok()
}

/// Split one DER element with the expected `tag` off the front of `input`:
/// `(contents, rest)`.
fn der_take(input: &[u8], tag: u8) -> Option<(&[u8], &[u8])> {
    if *input.first()? != tag {
        return None;
    }
    let first = *input.get(1)? as usize;
    let (len, header) = if first < 0x80 {
        (first, 2)
    } else {
        let n = first & 0x7f;
        if n == 0 || n > 4 {
            return None;
        }
        let len = input
            .get(2..2 + n)?
            .iter()
            .fold(0usize, |acc, b| (acc << 8) | *b as usize);
        (len, 2 + n)
    };
    let end = header.checked_add(len)?;
    Some((input.get(header..end)?, input.get(end..)?))
}

/// Generate a self-signed CA certificate using rcgen, valid from `now`.
fn generate_ca_at(now: DateTime<Utc>) -> Result<CaKeyPair> {
    let mut params = CertificateParams::default();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.distinguished_name = ca_distinguished_name();
    set_validity(&mut params, now, CA_VALIDITY_DAYS);

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
    sign_cert_for_host_at(ca, hostname, Utc::now())
}

/// [`sign_cert_for_host`] with the clock passed in, so the validity window is
/// testable. The leaf is valid from `now - BACKDATE_DAYS` to
/// `now + LEAF_VALIDITY_DAYS`.
fn sign_cert_for_host_at(ca: &CaKeyPair, hostname: &str, now: DateTime<Utc>) -> Result<SignedCert> {
    let issuer_key = KeyPair::from_pem(&ca.key_pem)?;

    // Only the issuer's name and key reach the leaf (its issuer field and
    // authority key identifier), so this stand-in must carry the CA's exact
    // subject. Its own validity is irrelevant to the leaf.
    let mut issuer_params = CertificateParams::default();
    issuer_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    issuer_params.distinguished_name = ca_distinguished_name();
    let issuer_cert = issuer_params.self_signed(&issuer_key)?;

    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, hostname);
    params.distinguished_name = dn;
    params.subject_alt_names = vec![SanType::DnsName(hostname.try_into()?)];
    // Apple platforms refuse a TLS server certificate without serverAuth.
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    set_validity(&mut params, now, LEAF_VALIDITY_DAYS);

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
    use chrono::TimeZone;
    use rustls::client::danger::ServerCertVerifier;
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use std::sync::Arc;

    fn generate_ca() -> Result<CaKeyPair> {
        generate_ca_at(Utc::now())
    }

    fn pem_der(pem: &str) -> CertificateDer<'static> {
        CertificateDer::from(pem_to_der(pem).expect("one certificate"))
    }

    /// Verify `leaf` for `host` against `ca` as the only trusted root, the way
    /// a TLS client would, at `at`.
    fn verify_at(
        ca: &CaKeyPair,
        leaf: &SignedCert,
        host: &str,
        at: DateTime<Utc>,
    ) -> std::result::Result<(), rustls::Error> {
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(pem_der(&ca.cert_pem))
            .expect("CA is a valid root");
        let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(
            Arc::new(roots),
            Arc::new(rustls::crypto::ring::default_provider()),
        )
        .build()
        .expect("verifier");
        let when =
            UnixTime::since_unix_epoch(std::time::Duration::from_secs(at.timestamp() as u64));
        verifier
            .verify_server_cert(
                &pem_der(&leaf.cert_pem),
                &[],
                &ServerName::try_from(host.to_string()).unwrap(),
                &[],
                when,
            )
            .map(|_| ())
    }

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

    /// A leaf minted today chains to the CA and is valid now and for the whole
    /// window, and not after it.
    #[test]
    fn a_leaf_minted_today_is_valid_for_the_window() {
        let now = Utc::now();
        let ca = generate_ca_at(now).unwrap();
        let leaf = sign_cert_for_host_at(&ca, "api.anthropic.com", now).unwrap();

        verify_at(&ca, &leaf, "api.anthropic.com", now).expect("valid now");
        verify_at(
            &ca,
            &leaf,
            "api.anthropic.com",
            now + Duration::days(LEAF_VALIDITY_DAYS - 1),
        )
        .expect("valid until the end of the window");
        assert!(verify_at(
            &ca,
            &leaf,
            "api.anthropic.com",
            now + Duration::days(LEAF_VALIDITY_DAYS + 1)
        )
        .is_err());
        assert!(verify_at(&ca, &leaf, "api.openai.com", now).is_err());

        let not_after = cert_not_after(&pem_to_der(&leaf.cert_pem).unwrap()).unwrap();
        let days = (not_after - now.naive_utc()).num_days();
        assert!(
            (LEAF_VALIDITY_DAYS - 1..=LEAF_VALIDITY_DAYS).contains(&days),
            "{days}"
        );
    }

    /// The window moves with the clock: a leaf minted on a date after the old
    /// hard-coded end date is valid on that date.
    #[test]
    fn a_leaf_minted_on_any_date_is_valid_from_that_date() {
        let ca = generate_ca_at(Utc::now()).unwrap();
        let later = Utc.with_ymd_and_hms(2027, 6, 1, 12, 0, 0).unwrap();
        let leaf = sign_cert_for_host_at(&ca, "api2.cursor.sh", later).unwrap();
        verify_at(&ca, &leaf, "api2.cursor.sh", later).expect("valid on its own date");
        assert!(verify_at(&ca, &leaf, "api2.cursor.sh", later - Duration::days(3)).is_err());
    }

    /// Leaves are never cached: each mint is a new certificate, so one that
    /// has expired is replaced by the next connection's.
    #[test]
    fn an_expired_leaf_is_reissued_on_the_next_mint() {
        let ca = generate_ca_at(Utc::now()).unwrap();
        let old = Utc::now() - Duration::days(LEAF_VALIDITY_DAYS + 10);
        let expired = sign_cert_for_host_at(&ca, "api.openai.com", old).unwrap();
        assert!(verify_at(&ca, &expired, "api.openai.com", Utc::now()).is_err());

        let fresh = sign_cert_for_host(&ca, "api.openai.com").unwrap();
        assert_ne!(fresh.cert_pem, expired.cert_pem);
        verify_at(&ca, &fresh, "api.openai.com", Utc::now()).expect("fresh leaf valid");
    }

    #[test]
    fn the_ca_is_valid_for_ten_years_from_now() {
        let now = Utc::now();
        let ca = generate_ca_at(now).unwrap();
        let not_after = cert_not_after(&ca.cert_der).unwrap();
        let days = (not_after - now.naive_utc()).num_days();
        assert!(
            (CA_VALIDITY_DAYS - 1..=CA_VALIDITY_DAYS).contains(&days),
            "{days}"
        );
        assert!(!ca_needs_renewal(&ca.cert_der, now));
    }

    #[test]
    fn an_expired_or_expiring_ca_is_renewed() {
        let issued = Utc.with_ymd_and_hms(2016, 1, 1, 0, 0, 0).unwrap();
        let ca = generate_ca_at(issued).unwrap();
        let expires = cert_not_after(&ca.cert_der).unwrap().and_utc();
        assert!(!ca_needs_renewal(
            &ca.cert_der,
            expires - Duration::days(CA_RENEW_BEFORE_DAYS + 1)
        ));
        assert!(ca_needs_renewal(
            &ca.cert_der,
            expires - Duration::days(CA_RENEW_BEFORE_DAYS - 1)
        ));
        assert!(ca_needs_renewal(&ca.cert_der, expires + Duration::days(1)));
    }

    /// Both encodings of a validity date: rcgen writes UTCTime before 2050 and
    /// GeneralizedTime from 2050 on.
    #[test]
    fn cert_not_after_reads_utc_and_generalized_time() {
        let issued = Utc.with_ymd_and_hms(2030, 3, 4, 0, 0, 0).unwrap();
        let ca = generate_ca_at(issued).unwrap();
        let utc = cert_not_after(&ca.cert_der).unwrap();
        assert_eq!(
            utc.date(),
            (issued + Duration::days(CA_VALIDITY_DAYS)).date_naive()
        );

        let ca = generate_ca_at(Utc.with_ymd_and_hms(2045, 1, 1, 0, 0, 0).unwrap()).unwrap();
        let generalized = cert_not_after(&ca.cert_der).unwrap();
        assert_eq!(generalized.date().year(), 2054);

        assert_eq!(cert_not_after(b""), None);
        assert_eq!(cert_not_after(&[0x30, 0x03, 0x02, 0x01]), None);
    }

    /// No calendar date is written into the validity code any more.
    #[test]
    fn no_validity_date_is_hard_coded() {
        let src = include_str!("ca_manager.rs");
        let code = &src[..src.find("#[cfg(test)]").unwrap()];
        assert!(!code.contains("date_time_ymd(20"), "a literal date is back");
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
