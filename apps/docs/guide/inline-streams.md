# Inline Stream Alerts <Badge type="warning" text="Cloud / Team" />

Intutic features low-latency, real-time post-response stream interception to append governance notifications directly to agent output streams before they complete.

This ensures critical warnings—such as exfiltration risks, severe loop detection, or goal drift anomalies—appear directly inside the developer's chat console or terminal without requiring them to check the dashboard.

---

## 🏗️ Architecture & Interception Mechanism

The Rust proxy gateway captures and buffers streaming responses from models in a lightweight pass-through loop:

```
[Upstream Provider] --(SSE Stream)--> [Intutic Proxy] --(Intercepted stream)--> [Client IDE]
                                            |
                                 Drains pending alerts
                                            |
                                      [GKE Valkey]
```

1. **Terminal Token Detection**: The proxy scans incoming SSE message chunks looking for the terminal stream delimiter of the target protocol:
   * **OpenAI / Gemini**: `data: [DONE]`
   * **Anthropic**: `event: message_stop`
2. **Notification Draining**: Before forwarding the terminal delimiter, the proxy performs an atomic pipeline fetch (`LRANGE` + `DEL`) against the workspace and session notification lists in Valkey.
3. **Chunk Injection**: If any governance events were flagged during the trace execution, they are formatted as a protocol-compliant markdown block chunk and written into the stream.
4. **Clean Exit**: The proxy then forwards the original stream end marker, allowing client-side parsers (such as in Cursor or VS Code) to terminate correctly without crashes.

---

## 📋 Markdown Alert Structure

Drained alerts are formatted into standard Markdown blocks containing GitHub-style warning callouts and links to Notion/Confluence policy pages:

```markdown
--- Intutic Governance ---

[CRITICAL] Anomaly: Severe Hallucination / Drift Detected
Your agent has repeatedly outputted file path assumptions that do not exist in the workspace...

*Review and modify the prompt, or adjust system guidelines.*
```
