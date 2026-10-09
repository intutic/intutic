//! Envelope encryption for the provider credentials stored in Valkey.
//!
//! The control plane encrypts every value it writes to
//! `workspace:credentials:{ws}` (`services/control-plane/src/lib/credentialEncryption.ts`),
//! so Valkey's append-only file and its region mirrors never hold a provider
//! key in the clear. This module is the proxy's half of the same format:
//!
//! ```text
//! enc:v1:<kid>:<base64url(nonce ‖ wrapped DEK ‖ tag)>:<base64url(nonce ‖ ciphertext ‖ tag)>
//! ```
//!
//! Each value has its own random 256-bit data key (DEK), sealed with
//! AES-256-GCM; the DEK is sealed in turn under a key encryption key (KEK).
//! Both seals bind `{workspace}/{field}` as associated data, so a ciphertext
//! moved to another workspace or field fails authentication instead of being
//! sent upstream under the wrong tenant.
//!
//! The KEK is HKDF-SHA256 of `ENCRYPTION_KEY` (salt `intutic/credential-kek`,
//! info `kek`); `kid` is the 8-byte HKDF output for info `kid`, in hex.
//! `ENCRYPTION_KEY_PREVIOUS` (comma-separated) keeps values sealed under a
//! rotated-out key readable until the control plane rewraps them.
//!
//! A value without the `enc:v1:` prefix was stored before encryption (or by
//! a proxy without a key) and is returned unchanged; an encrypted value that
//! cannot be opened is an error, never a credential.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::hkdf;
use ring::rand::{SecureRandom, SystemRandom};

const PREFIX: &str = "enc:v1:";
const KDF_SALT: &[u8] = b"intutic/credential-kek";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CredentialError {
    #[error("it is encrypted and this proxy has no ENCRYPTION_KEY")]
    NoKey,
    #[error("it is sealed under key {0}, which is neither ENCRYPTION_KEY nor in ENCRYPTION_KEY_PREVIOUS")]
    UnknownKey(String),
    #[error("its ciphertext is malformed")]
    Malformed,
    #[error("it failed authentication (wrong key, or moved from another workspace or field)")]
    Authentication,
}

struct Kek {
    id: String,
    key: LessSafeKey,
}

/// HKDF output length, as ring's `expand` wants it.
struct Len(usize);

impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn hkdf_expand(secret: &str, info: &[u8], len: usize) -> Vec<u8> {
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, KDF_SALT).extract(secret.as_bytes());
    let mut out = vec![0u8; len];
    prk.expand(&[info], Len(len))
        .and_then(|okm| okm.fill(&mut out))
        .expect("HKDF-SHA256 output of 8 or 32 bytes is always within bounds");
    out
}

fn aes_key(bytes: &[u8]) -> LessSafeKey {
    LessSafeKey::new(UnboundKey::new(&AES_256_GCM, bytes).expect("a 32-byte AES-256 key"))
}

impl Kek {
    fn derive(secret: &str) -> Self {
        Self {
            id: hex::encode(hkdf_expand(secret, b"kid", 8)),
            key: aes_key(&hkdf_expand(secret, b"kek", 32)),
        }
    }
}

fn seal(key: &LessSafeKey, plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce)
        .expect("the system random source is available");
    let mut body = plaintext.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(aad),
        &mut body,
    )
    .expect("AES-GCM seals any input shorter than 64 GiB");
    let mut out = nonce.to_vec();
    out.extend_from_slice(&body);
    out
}

fn open(key: &LessSafeKey, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, CredentialError> {
    if sealed.len() < NONCE_LEN {
        return Err(CredentialError::Malformed);
    }
    let (nonce, rest) = sealed.split_at(NONCE_LEN);
    let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| CredentialError::Malformed)?;
    let mut body = rest.to_vec();
    let plain = key
        .open_in_place(nonce, Aad::from(aad), &mut body)
        .map_err(|_| CredentialError::Authentication)?;
    Ok(plain.to_vec())
}

/// Where a value is stored, bound into both seals. Must match `credentialContext`.
pub fn context(workspace_id: &str, field: &str) -> String {
    format!("{workspace_id}/{field}")
}

pub fn is_encrypted(stored: &str) -> bool {
    stored.starts_with(PREFIX)
}

/// The current key encryption key and any previous ones still accepted.
pub struct CredentialKeyring {
    current: Kek,
    previous: Vec<Kek>,
}

impl CredentialKeyring {
    /// From `ENCRYPTION_KEY` and `ENCRYPTION_KEY_PREVIOUS`; `None` when no key is set.
    pub fn from_env() -> Option<Self> {
        let current = std::env::var("ENCRYPTION_KEY")
            .ok()
            .filter(|s| !s.is_empty())?;
        let previous = std::env::var("ENCRYPTION_KEY_PREVIOUS").unwrap_or_default();
        Some(Self::from_secrets(
            &current,
            &previous
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>(),
        ))
    }

    pub fn from_secrets(current: &str, previous: &[&str]) -> Self {
        Self {
            current: Kek::derive(current),
            previous: previous.iter().map(|s| Kek::derive(s)).collect(),
        }
    }

    /// The id stored with every value this keyring seals.
    pub fn current_id(&self) -> &str {
        &self.current.id
    }

    fn by_id(&self, id: &str) -> Option<&Kek> {
        std::iter::once(&self.current)
            .chain(self.previous.iter())
            .find(|k| k.id == id)
    }

    pub fn encrypt(&self, plaintext: &str, context: &str) -> String {
        let aad = context.as_bytes();
        let mut dek = [0u8; 32];
        SystemRandom::new()
            .fill(&mut dek)
            .expect("the system random source is available");
        let wrapped = seal(&self.current.key, &dek, aad);
        let body = seal(&aes_key(&dek), plaintext.as_bytes(), aad);
        format!(
            "{PREFIX}{}:{}:{}",
            self.current.id,
            URL_SAFE_NO_PAD.encode(wrapped),
            URL_SAFE_NO_PAD.encode(body)
        )
    }

    fn decrypt_sealed(&self, sealed: &str, context: &str) -> Result<String, CredentialError> {
        let mut parts = sealed.split(':');
        let (Some(kid), Some(wrapped), Some(body), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(CredentialError::Malformed);
        };
        let kek = self
            .by_id(kid)
            .ok_or_else(|| CredentialError::UnknownKey(kid.to_string()))?;
        let decode = |s: &str| {
            URL_SAFE_NO_PAD
                .decode(s)
                .map_err(|_| CredentialError::Malformed)
        };
        let aad = context.as_bytes();
        let dek = open(&kek.key, &decode(wrapped)?, aad)?;
        if dek.len() != 32 {
            return Err(CredentialError::Malformed);
        }
        let plain = open(&aes_key(&dek), &decode(body)?, aad)?;
        String::from_utf8(plain).map_err(|_| CredentialError::Malformed)
    }
}

/// The usable value of a stored credential: a value stored in the clear as
/// it is, an encrypted one opened with `keyring`.
pub fn open_stored(
    keyring: Option<&CredentialKeyring>,
    stored: &str,
    context: &str,
) -> Result<String, CredentialError> {
    let Some(sealed) = stored.strip_prefix(PREFIX) else {
        return Ok(stored.to_string());
    };
    keyring
        .ok_or(CredentialError::NoKey)?
        .decrypt_sealed(sealed, context)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "test-encryption-key-32-bytes-ok!";
    const OLD_KEY: &str = "previous-test-key-32-bytes-ok!!!";
    const CTX: &str = "ws_vector/anthropic_api_key";
    const PLAINTEXT: &str = "test-provider-key-0001";

    /// Sealed by the control plane's `encryptCredential(PLAINTEXT, CTX)` under
    /// KEY. The control plane's suite (credentialEncryption.test.ts) opens a
    /// value sealed here; together they pin the two implementations to one
    /// format.
    const NODE_SEALED: &str = "enc:v1:6cf88003d62274ff:dPBhlOFgYnXX_gNuJujF3UBJMRFRLWPBjVUI6TsvjZvDSbieBVJiN-gwaOz_l3UeF5SlmzSTgEpiVu_r:2F7EWp5FackWuryHd3nZSSIqdcRQMDG4yUsr6ofAQajwVUVUz8PPunnl7C9pu1srEuk";

    #[test]
    fn key_id_matches_the_control_plane() {
        // localKeyEncryptionKey(KEY).id
        assert_eq!(
            CredentialKeyring::from_secrets(KEY, &[]).current_id(),
            "6cf88003d62274ff"
        );
    }

    #[test]
    fn opens_what_the_control_plane_sealed() {
        let ring = CredentialKeyring::from_secrets(KEY, &[]);
        assert_eq!(
            open_stored(Some(&ring), NODE_SEALED, CTX).unwrap(),
            PLAINTEXT
        );
    }

    #[test]
    fn round_trips_and_never_stores_the_plaintext() {
        let ring = CredentialKeyring::from_secrets(KEY, &[]);
        let sealed = ring.encrypt(PLAINTEXT, CTX);
        assert!(sealed.starts_with(&format!("enc:v1:{}:", ring.current_id())));
        assert!(!sealed.contains(PLAINTEXT));
        assert_ne!(
            sealed,
            ring.encrypt(PLAINTEXT, CTX),
            "a fresh DEK and nonce every time"
        );
        assert_eq!(open_stored(Some(&ring), &sealed, CTX).unwrap(), PLAINTEXT);
    }

    #[test]
    fn a_rotated_out_key_still_opens_while_it_is_listed_as_previous() {
        let sealed = CredentialKeyring::from_secrets(OLD_KEY, &[]).encrypt(PLAINTEXT, CTX);
        let rotated = CredentialKeyring::from_secrets(KEY, &[OLD_KEY]);
        assert_eq!(
            open_stored(Some(&rotated), &sealed, CTX).unwrap(),
            PLAINTEXT
        );

        let dropped = CredentialKeyring::from_secrets(KEY, &[]);
        assert!(matches!(
            open_stored(Some(&dropped), &sealed, CTX),
            Err(CredentialError::UnknownKey(_))
        ));
    }

    #[test]
    fn a_value_moved_to_another_workspace_does_not_open() {
        let ring = CredentialKeyring::from_secrets(KEY, &[]);
        let sealed = ring.encrypt(PLAINTEXT, CTX);
        assert_eq!(
            open_stored(Some(&ring), &sealed, "ws_other/anthropic_api_key"),
            Err(CredentialError::Authentication)
        );
    }

    #[test]
    fn plaintext_passes_through_and_ciphertext_never_does() {
        assert_eq!(open_stored(None, PLAINTEXT, CTX).unwrap(), PLAINTEXT);
        assert_eq!(
            open_stored(None, NODE_SEALED, CTX),
            Err(CredentialError::NoKey)
        );
        let ring = CredentialKeyring::from_secrets(KEY, &[]);
        let tampered = format!("{}x", &NODE_SEALED[..NODE_SEALED.len() - 1]);
        assert!(open_stored(Some(&ring), &tampered, CTX).is_err());
        assert_eq!(
            open_stored(Some(&ring), "enc:v1:abc", CTX),
            Err(CredentialError::Malformed)
        );
    }
}
