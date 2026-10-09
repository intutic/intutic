//! The caller's credential, typed by where it may be sent.
//!
//! A request's bearer is either an Intutic virtual key (`vk_…`) or, on a
//! passthrough proxy, the caller's own provider credential (an Anthropic or
//! OpenAI key, a Claude OAuth token). The two have different destinations: a
//! virtual key authenticates the caller to Intutic and may go to the control
//! plane; a provider credential goes to that provider's upstream and nowhere
//! else.
//!
//! The rule used to be a `starts_with("vk_")` check repeated at each
//! control-plane call site, and the sites that lacked it sent provider keys
//! to the control plane. Every control-plane client in this crate now takes a
//! [`VirtualKey`], and the only way to get one is [`RequestCredential::classify`]
//! on a `vk_` token, so handing a provider key to one does not compile.
//!
//! The provider variant carries no value. The passthrough copies the caller's
//! own `Authorization`/`x-api-key` headers onto the upstream request
//! (`proxy.rs`), so nothing needs the key as a value, and a value that does
//! not exist cannot be sent anywhere else.

use std::fmt;

/// The bearer a proxied request arrived with.
#[derive(Debug)]
pub enum RequestCredential {
    VirtualKey(VirtualKey),
    ProviderKey,
}

impl RequestCredential {
    pub fn classify(token: &str) -> Self {
        if token.starts_with("vk_") {
            Self::VirtualKey(VirtualKey(token.to_string()))
        } else {
            Self::ProviderKey
        }
    }

    pub fn virtual_key(&self) -> Option<&VirtualKey> {
        match self {
            Self::VirtualKey(key) => Some(key),
            Self::ProviderKey => None,
        }
    }
}

/// An Intutic virtual key: the only caller credential the control plane
/// receives.
#[derive(Clone, PartialEq, Eq)]
pub struct VirtualKey(String);

impl VirtualKey {
    /// Characters of a key the control plane indexes keys by and the dashboard
    /// shows. Not a secret.
    const PREFIX_LEN: usize = 12;

    /// Sets this key as the request's bearer.
    pub fn authorize(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request.bearer_auth(&self.0)
    }

    /// The whole key, for hashing and for the authenticated key record. Send
    /// it through [`Self::authorize`].
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn prefix(&self) -> &str {
        self.0.get(..Self::PREFIX_LEN).unwrap_or(&self.0)
    }
}

/// The prefix only, so a key in a `?` log field or a panic message is not the
/// key.
impl fmt::Debug for VirtualKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "VirtualKey({}…)", self.prefix())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vk() -> String {
        ["vk_", "0123456789abcdef0123456789abcdef", "_ws_cred"].concat()
    }

    #[test]
    fn a_vk_token_is_a_virtual_key() {
        let token = vk();
        let credential = RequestCredential::classify(&token);
        assert_eq!(
            credential.virtual_key().map(VirtualKey::as_str),
            Some(token.as_str())
        );
    }

    #[test]
    fn anything_else_is_a_provider_key_with_no_virtual_key() {
        for token in [
            ["sk-ant-", "api03-", "fixture"].concat(),
            ["sk-", "proj-", "fixture"].concat(),
            "VK_upper".to_string(),
            "bearer-with-vk_-inside".to_string(),
        ] {
            assert!(
                RequestCredential::classify(&token).virtual_key().is_none(),
                "{token:?} classified as a virtual key"
            );
        }
    }

    #[test]
    fn debug_shows_only_the_prefix() {
        let token = vk();
        let shown = format!("{:?}", RequestCredential::classify(&token));
        assert!(!shown.contains(&token), "{shown}");
        assert!(shown.contains(&token[..12]), "{shown}");
    }

    #[test]
    fn authorize_sets_the_bearer() {
        let token = vk();
        let credential = RequestCredential::classify(&token);
        let key = credential.virtual_key().expect("a virtual key");
        let request = key
            .authorize(reqwest::Client::new().get("http://cp.invalid/"))
            .build()
            .expect("request builds");
        assert_eq!(
            request.headers()["authorization"],
            format!("Bearer {token}").as_str()
        );
    }
}
