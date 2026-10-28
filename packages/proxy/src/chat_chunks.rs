//! The stream's `id`, `created` and `model` on every Chat Completions chunk
//! the proxy writes itself.
//!
//! A streamed Chat Completions answer is a run of `chat.completion.chunk`s,
//! each carrying the stream's `id`, `created` and `model`; the OpenAI chunk
//! schema requires all three, and a strict client refuses a chunk without
//! them (Grok Build: "missing field `created`", then "missing field `id`").
//! Into the upstream's stream the proxy writes chunks of its own: the output
//! DLP's held text (`intutic-dlp-holdback`) and tool-call arguments, the
//! judge's, decide's and governance notes (`intutic-judge-gov`,
//! `intutic-decide`, `intutic-gov`), and a refusal's tail
//! (`chatcmpl-intutic-response-gate`). Each is built where it is written,
//! with an id of its own or none, and no `created` or `model`.
//!
//! `ChunkStamp` sits on the response body of a Chat Completions client and
//! gives each of those chunks the stream's identity: learned from the
//! upstream's chunks as they pass, or, before the first, a proxy id, the
//! current time and the request's model. An upstream chunk is one with an id
//! that is not the proxy's (`intutic-…`, `chatcmpl-intutic…`) and a
//! `created`; it passes untouched.

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::Value;

/// The id a chunk gets when the proxy writes one before any upstream chunk.
const PROXY_STREAM_ID: &str = "chatcmpl-intutic";

pub struct ChunkStamp {
    id: Option<Value>,
    created: Option<Value>,
    model: Value,
}

impl ChunkStamp {
    /// A stamp for a stream answering a request for `model`.
    pub fn new(model: &str) -> Self {
        Self {
            id: None,
            created: None,
            model: Value::from(model),
        }
    }

    /// `inner`, its proxy-written chunks stamped.
    pub fn apply<S, E>(mut self, inner: S) -> impl Stream<Item = Result<Bytes, E>> + Send + 'static
    where
        S: Stream<Item = Result<Bytes, E>> + Send + 'static,
        E: Send + 'static,
    {
        inner.map(move |item| item.map(|b| self.stamp(b)))
    }

    /// One body item: each whole `data:` line of a proxy-written chunk in it
    /// stamped, every other line as it was. The proxy sends whole lines, the
    /// upstream's one at a time and its own as whole events; a line cut at the
    /// end of an item passes as it is.
    pub fn stamp(&mut self, bytes: Bytes) -> Bytes {
        let Ok(text) = std::str::from_utf8(&bytes) else {
            return bytes;
        };
        if !text.contains("chat.completion.chunk") {
            return bytes;
        }
        let mut out = String::with_capacity(text.len() + 96);
        let mut changed = false;
        for piece in text.split_inclusive('\n') {
            match self.line(piece) {
                Some(stamped) => {
                    out.push_str(&stamped);
                    changed = true;
                }
                None => out.push_str(piece),
            }
        }
        if changed {
            Bytes::from(out)
        } else {
            bytes
        }
    }

    /// The line stamped, when it is a whole `data:` line of a chunk the proxy
    /// wrote; `None` to keep it. An upstream chunk's identity is kept for the
    /// proxy's chunks after it.
    fn line(&mut self, piece: &str) -> Option<String> {
        if !piece.ends_with('\n') {
            return None;
        }
        let data = piece.strip_prefix("data:")?.trim();
        let mut chunk: Value = serde_json::from_str(data).ok()?;
        let fields = chunk.as_object_mut()?;
        if fields.get("object").and_then(Value::as_str) != Some("chat.completion.chunk") {
            return None;
        }
        let id = fields.get("id").and_then(Value::as_str).unwrap_or("");
        let proxy_id =
            id.is_empty() || id.starts_with("intutic-") || id.starts_with(PROXY_STREAM_ID);
        if !proxy_id && fields.contains_key("created") {
            self.id = fields.get("id").cloned();
            self.created = fields.get("created").cloned();
            if let Some(model) = fields.get("model").filter(|m| !m.is_null()) {
                self.model = model.clone();
            }
            return None;
        }
        let id = self
            .id
            .get_or_insert_with(|| Value::from(PROXY_STREAM_ID))
            .clone();
        let created = self
            .created
            .get_or_insert_with(|| Value::from(chrono::Utc::now().timestamp()))
            .clone();
        fields.insert("id".into(), id);
        fields.insert("created".into(), created);
        fields.insert("model".into(), self.model.clone());
        Some(format!("data: {}\n", serde_json::to_string(&chunk).ok()?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(s: &mut ChunkStamp, text: &str) -> Value {
        let out = s.stamp(Bytes::from(text.to_string()));
        let line = std::str::from_utf8(&out)
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .to_string();
        serde_json::from_str(line.strip_prefix("data: ").unwrap()).unwrap()
    }

    #[test]
    fn a_proxy_chunk_gets_the_upstream_streams_identity() {
        let mut s = ChunkStamp::new("asked-model");
        let upstream = r#"data: {"id":"chatcmpl-up","object":"chat.completion.chunk","created":1700000000,"model":"served-model","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}"#;
        let passed = s.stamp(Bytes::from(format!("{upstream}\n")));
        assert_eq!(
            passed,
            Bytes::from(format!("{upstream}\n")),
            "an upstream chunk passes untouched"
        );

        let held = stamp(
            &mut s,
            "data: {\"choices\":[{\"delta\":{\"content\":\"tail\"},\"finish_reason\":null,\"index\":0}],\"id\":\"intutic-dlp-holdback\",\"object\":\"chat.completion.chunk\"}\n\n",
        );
        assert_eq!(held["id"], "chatcmpl-up");
        assert_eq!(held["created"], 1700000000);
        assert_eq!(held["model"], "served-model");
        assert_eq!(held["choices"][0]["delta"]["content"], "tail");

        // A tool call's flushed arguments carry no id at all.
        let args = stamp(
            &mut s,
            "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
        );
        assert_eq!(args["id"], "chatcmpl-up");
        assert_eq!(args["created"], 1700000000);
    }

    #[test]
    fn before_any_upstream_chunk_the_request_model_and_now() {
        let mut s = ChunkStamp::new("asked-model");
        let refusal = stamp(
            &mut s,
            "data: {\"id\":\"chatcmpl-intutic-response-gate\",\"object\":\"chat.completion.chunk\",\"choices\":[]}\n\ndata: [DONE]\n\n",
        );
        assert_eq!(refusal["id"], PROXY_STREAM_ID);
        assert_eq!(refusal["model"], "asked-model");
        assert!(refusal["created"].as_u64().unwrap() > 1_700_000_000);
    }

    #[test]
    fn every_line_of_an_event_is_kept() {
        let mut s = ChunkStamp::new("m");
        let text = "data: {\"id\":\"intutic-decide\",\"object\":\"chat.completion.chunk\",\"choices\":[]}\n\ndata: [DONE]\n\n";
        let out = String::from_utf8(s.stamp(Bytes::from(text)).to_vec()).unwrap();
        let lines: Vec<&str> = out.split('\n').collect();
        assert_eq!(lines.len(), 5, "{out:?}");
        assert!(lines[0].starts_with("data: {"));
        assert_eq!(lines[1], "");
        assert_eq!(lines[2], "data: [DONE]");
        assert!(out.ends_with("\n\n"));
    }

    #[test]
    fn other_lines_pass_as_they_are() {
        let mut s = ChunkStamp::new("m");
        for text in [
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n\n",
            ": keep-alive\n\n",
            "data: {\"object\":\"chat.completion.chunk\",\"id\":\"intutic-x\"", // cut mid-line
        ] {
            assert_eq!(s.stamp(Bytes::from(text)), Bytes::from(text));
        }
    }
}
