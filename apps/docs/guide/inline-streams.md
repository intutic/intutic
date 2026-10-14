# Inline Stream Alerts <Badge type="tip" text="Cloud" />

Intutic features low-latency, real-time post-response stream interception to append governance notifications directly to agent output streams before they complete.

This ensures critical warnings—such as exfiltration risks, loop detection, or a blocked tool call—appear directly inside the developer's chat console or terminal without requiring them to check the dashboard.

---

## 🏗️ Architecture & Interception Mechanism

The Rust proxy gateway captures and buffers streaming responses from models in a lightweight pass-through loop:

```
[Upstream Provider] --(SSE Stream)--> [Intutic Proxy] --(Intercepted stream)--> [Client IDE]
                                            |
                                 Drains pending alerts
                                            |
                                        [Valkey]
```

1. **Terminal Token Detection**: The proxy scans incoming SSE message chunks looking for the terminal stream delimiter of the target protocol:
   * **OpenAI Chat Completions**: `data: [DONE]`
   * **Anthropic**: `event: message_stop`
   * **OpenAI Responses API** (Codex CLI): `response.completed` — but no alert block is written on this protocol yet; pending alerts stay queued rather than being drained.
2. **Notification Draining**: Before forwarding the terminal delimiter, the proxy performs an atomic pipeline fetch (`LRANGE` + `DEL`) against the session, workspace and (for an agent in a multi-agent graph) graph-node notification lists in Valkey.
3. **Chunk Injection**: If any governance events were flagged during the trace execution, they are sorted most severe first, capped at five per response, formatted as one block chunk in the stream's own protocol and written into the stream: Markdown for harnesses whose chat renders it (Claude Code, Cursor, Windsurf, Antigravity, OpenHands, Cline, Roo Code), plain text for any other.
4. **Clean Exit**: The proxy then forwards the original stream end marker, allowing client-side parsers (such as in Cursor or VS Code) to terminate correctly without crashes.

---

## 📋 Markdown Alert Structure

For a harness that renders Markdown, drained alerts are formatted as a Markdown block: a heading, then each alert with a priority marker and its category. Any other harness gets the same alerts as plain text, as below. An alert names the governance event and the guidance to follow; when the rule was derived from a policy document, that guidance carries the cited sentence and the page it came from, the same text the gate printed at the moment of the block:

```text
--- Intutic Governance ---

[CRITICAL] Anomaly: Data Exfiltration Detected
Your agent has repeatedly outputted file path assumptions that do not exist in the workspace...

--- End Governance ---
```
