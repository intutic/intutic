//! AWS Signature Version 4 request signing (header-based, `AWS4-HMAC-SHA256`).
//!
//! Algorithm: <https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html>.
//! The tests run the AWS-published SigV4 test-suite vectors
//! (`get-vanilla`, `post-vanilla`, `get-vanilla-query-order-key-case`,
//! `post-x-www-form-urlencoded`, `get-utf8`) and the documented signing-key
//! derivation example, so a regression in any step — canonical request,
//! string to sign, key derivation — fails against AWS's own numbers.
//!
//! Hand-rolled on `ring` HMAC (already linked for rustls) and `sha2` rather
//! than the `aws-sigv4` crate, which brings the smithy runtime type crates;
//! the signer itself is the ~150 lines below.

use chrono::{DateTime, Utc};
use ring::hmac;
use sha2::{Digest, Sha256};

/// AWS credentials. `Debug` names the access key id only — the secret and the
/// session token never reach a log line through this type.
#[derive(Clone, PartialEq, Eq)]
pub struct AwsCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

impl std::fmt::Debug for AwsCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AwsCredentials")
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &"<redacted>")
            .field(
                "session_token",
                &self.session_token.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// One request to sign.
pub struct Request<'a> {
    pub method: &'a str,
    pub host: &'a str,
    /// The path exactly as it goes on the wire (already percent-encoded once).
    pub path: &'a str,
    /// Raw (unencoded) query parameters.
    pub query: &'a [(&'a str, &'a str)],
    /// Headers to sign besides `host` and `x-amz-date`, e.g. `content-type`.
    pub headers: &'a [(&'a str, &'a str)],
    pub payload: &'a [u8],
}

/// The headers to add to the request: `x-amz-date`, `x-amz-security-token`
/// for temporary credentials, and `authorization`.
pub fn sign(
    req: &Request<'_>,
    creds: &AwsCredentials,
    region: &str,
    service: &str,
    now: DateTime<Utc>,
) -> Vec<(&'static str, String)> {
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = &amz_date[..8];

    let mut signed: Vec<(String, String)> = req
        .headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), canonical_header_value(v)))
        .collect();
    signed.push(("host".into(), req.host.to_ascii_lowercase()));
    signed.push(("x-amz-date".into(), amz_date.clone()));
    if let Some(token) = &creds.session_token {
        signed.push(("x-amz-security-token".into(), token.clone()));
    }
    signed.sort();

    let creq = canonical_request(req, &signed);
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex::encode(Sha256::digest(creq.as_bytes()))
    );
    let key = hmac::Key::new(
        hmac::HMAC_SHA256,
        signing_key(&creds.secret_access_key, date, region, service).as_ref(),
    );
    let signature = hex::encode(hmac::sign(&key, string_to_sign.as_bytes()).as_ref());
    let signed_names = signed
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");

    let mut out = vec![("x-amz-date", amz_date)];
    if let Some(token) = &creds.session_token {
        out.push(("x-amz-security-token", token.clone()));
    }
    out.push((
        "authorization",
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_names}, Signature={signature}",
            creds.access_key_id
        ),
    ));
    out
}

fn canonical_request(req: &Request<'_>, signed: &[(String, String)]) -> String {
    let mut query: Vec<(String, String)> = req
        .query
        .iter()
        .map(|(k, v)| (uri_encode(k), uri_encode(v)))
        .collect();
    query.sort();
    let query = query
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let headers: String = signed.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let names = signed
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    format!(
        "{}\n{}\n{query}\n{headers}\n{names}\n{}",
        req.method,
        canonical_uri(req.path),
        hex::encode(Sha256::digest(req.payload))
    )
}

/// Every path segment URI-encoded once more. Services other than S3 sign the
/// wire path encoded a second time, which is why a Bedrock model id such as
/// `…-v1:0` travels as `…-v1%3A0` and is signed as `…-v1%253A0`.
fn canonical_uri(path: &str) -> String {
    if path.is_empty() {
        return "/".into();
    }
    path.split('/')
        .map(uri_encode)
        .collect::<Vec<_>>()
        .join("/")
}

/// RFC 3986 unreserved characters pass through; everything else is `%XX`
/// with uppercase hex, per the SigV4 encoding rules.
pub fn uri_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Trim, and collapse runs of spaces to one, as the canonical form requires.
fn canonical_header_value(v: &str) -> String {
    v.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `kSigning`: HMAC chain over date, region, service and `aws4_request`.
fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> hmac::Tag {
    let k = |key: &[u8], data: &str| {
        hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data.as_bytes())
    };
    let k_date = k(format!("AWS4{secret}").as_bytes(), date);
    let k_region = k(k_date.as_ref(), region);
    let k_service = k(k_region.as_ref(), service);
    k(k_service.as_ref(), "aws4_request")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    // The AWS SigV4 test suite's fixed inputs (aws-sig-v4-test-suite, as
    // vendored by awslabs/aws-c-auth and botocore): example credentials,
    // us-east-1, service "service", 2015-08-30T12:36:00Z.
    fn suite_creds() -> AwsCredentials {
        AwsCredentials {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: ["wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"].concat(),
            session_token: None,
        }
    }

    fn suite_time() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2015, 8, 30, 12, 36, 0).unwrap()
    }

    fn authorization(req: &Request<'_>) -> String {
        sign(req, &suite_creds(), "us-east-1", "service", suite_time())
            .into_iter()
            .find(|(k, _)| *k == "authorization")
            .unwrap()
            .1
    }

    #[test]
    fn get_vanilla() {
        let req = Request {
            method: "GET",
            host: "example.amazonaws.com",
            path: "/",
            query: &[],
            headers: &[],
            payload: b"",
        };
        let signed = vec![
            ("host".to_string(), "example.amazonaws.com".to_string()),
            ("x-amz-date".to_string(), "20150830T123600Z".to_string()),
        ];
        assert_eq!(
            canonical_request(&req, &signed),
            "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            authorization(&req),
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }

    #[test]
    fn post_vanilla() {
        let req = Request {
            method: "POST",
            host: "example.amazonaws.com",
            path: "/",
            query: &[],
            headers: &[],
            payload: b"",
        };
        assert_eq!(
            authorization(&req),
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"
        );
    }

    #[test]
    fn signing_key_matches_the_documented_derivation_example() {
        // docs.aws.amazon.com "Examples of how to derive a signing key for
        // Signature Version 4": 20120215 / us-east-1 / iam.
        assert_eq!(
            hex::encode(
                signing_key(
                    &["wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"].concat(),
                    "20120215",
                    "us-east-1",
                    "iam"
                )
                .as_ref()
            ),
            "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
        );
    }

    #[test]
    fn temporary_credentials_sign_the_session_token() {
        let mut creds = suite_creds();
        creds.session_token = Some("token-value".into());
        let req = Request {
            method: "POST",
            host: "bedrock-runtime.us-east-1.amazonaws.com",
            path: "/model/m/invoke",
            query: &[],
            headers: &[("content-type", "application/json")],
            payload: b"{}",
        };
        let out = sign(&req, &creds, "us-east-1", "bedrock", suite_time());
        assert!(out
            .iter()
            .any(|(k, v)| *k == "x-amz-security-token" && v == "token-value"));
        let auth = &out.iter().find(|(k, _)| *k == "authorization").unwrap().1;
        assert!(
            auth.contains("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,"),
            "{auth}"
        );
        assert!(auth.contains("/20150830/us-east-1/bedrock/aws4_request"));
    }

    #[test]
    fn the_wire_path_is_encoded_again_for_the_canonical_uri() {
        assert_eq!(
            canonical_uri("/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke"),
            "/model/us.anthropic.claude-sonnet-4-5-20250929-v1%253A0/invoke"
        );
        assert_eq!(canonical_uri("/"), "/");
    }

    #[test]
    fn debug_never_prints_the_secret() {
        let mut creds = suite_creds();
        creds.session_token = Some("session-secret".into());
        let shown = format!("{creds:?}");
        assert!(shown.contains("AKIDEXAMPLE"));
        assert!(!shown.contains("EXAMPLEKEY"));
        assert!(!shown.contains("session-secret"));
    }
}
