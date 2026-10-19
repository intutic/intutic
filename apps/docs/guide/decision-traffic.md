# Decision Traffic <Badge type="tip" text="Open-Core" />

Your apps may call decision models directly: "approve this refund?", "which queue takes this ticket?". A decision model answers each question with a probability instead of generating text. The proxy governs these calls the way it governs your LLM calls: it checks the state before it leaves, refuses models whose weights can change under you, says when an answer is too uncertain to act on, and keeps a record of every call.

Two wire formats carry decision calls, and the proxy speaks both:

| Format | Route | Served by |
| :--- | :--- | :--- |
| System One | `POST /v1/systemone` | TypeSafe (Jev), Fastino, and self-hosted Kev, Laya or LiteLLM servers |
| OpenAI Decisions | `POST /v1/decisions` | OpenAI (`gpt-6-luna`), and servers that implement the same API |

This is your traffic, sent to the provider you choose, hosted or not. It is separate from [decide rules](/guide/decide), where Intutic asks a model about your agents' tool calls: that engine is self-hosted only and refuses hosted decision APIs. Nothing here relaxes that.

---

## Sending calls through the proxy

Point the client's base URL at the proxy, as you do for an LLM SDK. The proxy forwards the call to the upstream for its format:

1. the provider host the call was addressed to, when the client uses the proxy as its HTTPS proxy and the host is one the proxy intercepts (`api.openai.com` is; add a decision provider's host to `INTUTIC_EXTRA_AI_HOSTS` to intercept it too);
2. `decision_traffic.systemone_upstream` or `decision_traffic.decisions_upstream` in `config.yaml`;
3. `UPSTREAM_URL`, one gateway for every provider, such as a LiteLLM that serves both routes;
4. `https://api.typesafe.ai` for System One, `https://api.openai.com` for Decisions.

The credential:

- **Your own provider key** (`Authorization: Bearer <key>`) goes to that upstream unchanged.
- **An Intutic key** (`vk_…`) never leaves the proxy. A call to TypeSafe or Fastino is sent with the workspace's provisioned key for that provider, else `TYPESAFE_API_KEY` or `FASTINO_API_KEY`; a call to OpenAI with the workspace's OpenAI key, else `OPENAI_API_KEY`. With none available the call is refused: `402 byok_required` when the key's plan requires the workspace's own provider keys, else `402 no_upstream_credential`. A self-hosted server or gateway gets no credential, so it must accept calls from the proxy without one.

Headers starting `x-intutic-` are never forwarded.

---

## What is checked before the call

The call passes the same authentication, spend budgets, approved-models list and loop checks as an LLM call. Then, in order:

| Check | What it does | When it refuses |
| :--- | :--- | :--- |
| **DLP on the state** | Scans the state (`state` in System One, `input` in Decisions) with your DLP patterns and PII detectors. A decision state often holds the personal data being decided about | A `block` pattern, such as a private key: `400 dlp_policy_violation`. A `redact` pattern is replaced in the state before it is sent |
| **Egress** | Applies the [egress policy](/reference/configuration#egress-control) to the upstream host | `enforce` mode and a host not on the allow list: `403 policy_denied`. `monitor` mode forwards it and logs `would_refuse_egress` |
| **Version pin** | A model name must pin its weights: a part after the family name that holds a digit (`jev-1.14.0`, `kev-4b`, `gpt-6-luna`). A moving alias (`-latest`, `-stable`, `-current`, `-default`) or a name with no version (`jev-preview`) is unpinned | Unpinned, in `enforce` mode: `403 policy_denied`, naming the model. `shadow` mode forwards it and logs `would_refuse_unpinned`. `allow_unpinned: true` admits it |
| **Daily cap** | On a proxy with no control plane, holds the call to the machine's daily spend cap, as for an LLM call | The estimated cost is over what is left today: `429 OVERAGE_HARD_CAP_EXCEEDED` |

A body that is not a decision request (no model, no state, no questions, or a question type the format does not define) is refused with `400 invalid_body` and not forwarded.

---

## What the proxy adds to the answer

The response body is never changed. Two headers may be added to a successful response:

| Header | When |
| :--- | :--- |
| `x-intutic-decision-abstain: <name>,<name>` | A question's top probability is under its floor (`decision_traffic.floors`, by question name or `*`). For a yes/no question the top probability is `max(p, 1 − p)`; for a choice or score, the largest option. A question with no probability (a refusal, or a `box` answer) is under any floor. Names are comma separated, with characters outside `A–Z a–z 0–9 . _ ~ -` percent-encoded |
| `x-intutic-decision-requires-human: 1` | The call is consequential: the request carried `x-intutic-decision-consequential: 1`, or its model is in `decision_traffic.consequential_models`. A person must act before your app does |

Your app reads the headers and abstains, escalates or waits for a person. The proxy does not decide for it.

---

## Metering

A forwarded decision call is metered like an LLM call: it produces one trace, priced from the offline pricing bundle (TypeSafe's models by their `typesafe/` entries, OpenAI's by name), and its cost counts against the same budgets. A refused call is not forwarded and costs nothing.

<!-- ENTERPRISE_ONLY_START -->
On a workspace's bill, each forwarded decision call is one [Governed Request](/guide/plans), as an LLM call is.
<!-- ENTERPRISE_ONLY_END -->

---

## The decision-traffic log

Every decision call, refused or forwarded, is one line in `~/.intutic/logs/decision-traffic-YYYY-MM-DD.jsonl`, except a body that does not parse, which never was a decision call, and a call refused because no provider key was available. A local proxy writes the file (named by UTC date, mode 0600); a shared gateway keeps the same record on the call's trace instead. The log is named apart from the [decide log](/guide/decide#the-decide-log), which records Intutic's own decide rules. The proxy deletes files older than 30 days, the decide log's retention, on the first call of each day.

```json
{"v":1,"at":"2026-10-20T09:00:01.234Z","traceId":"…","workspaceId":"…","virtualKeyId":"vk_ab12cd34",
 "format":"systemone","provider":"typesafe","upstreamHost":"api.typesafe.ai","model":"jev-1.14.0",
 "modelVersion":"1.14.0","pinned":true,"stateHash":"sha256:…","stateBytes":2310,
 "dlp":{"action":"redact","detectors":["aws_access_key"]},"questions":[{"name":"approve","type":"yes_no"}],
 "probabilities":{"approve":0.62},"floors":{"approve":0.8},"belowFloor":["approve"],"consequential":true,
 "action":"forwarded","status":200,"latencyMs":143}
```

| Field | Meaning |
| :--- | :--- |
| `format` | `systemone` or `decisions` |
| `provider` | `typesafe`, `fastino`, `openai`, or `other` for a self-hosted server or gateway |
| `pinned` | Whether the model name pins its weights |
| `stateHash`, `stateBytes` | The SHA-256 and size of the state as it was sent, after redaction. The state itself is never logged |
| `dlp` | `none`, `redact` or `refuse`, and the patterns that matched |
| `questions` | Each question's name and type: `yes_no` (System One `noul`, OpenAI `predicate`), `choice`, `score` or `box`, with a choice's options or a score's levels |
| `probabilities` | Per question: the probability of yes, a probability per option or level, or `null` when the model gave none |
| `floors`, `belowFloor` | The floor each question was held to, and the questions under it |
| `action` | `forwarded`, `refused_dlp`, `refused_egress`, `refused_unpinned` or `refused_budget` |
| `status` | The status your app received. An upstream that could not be reached is `502` with `action: forwarded` |
| `shadow` | Present when a check only logged: `would_refuse_unpinned`, `would_refuse_egress` |

---

## Configuration

```yaml
intutic_settings:
  decision_traffic:
    mode: enforce            # or shadow
    allow_unpinned: false
    floors:
      approve: 0.8
      "*": 0.6
    consequential_models: [jev-1.14.0]
    systemone_upstream: https://api.typesafe.ai
```

Every setting is in the [configuration reference](/reference/configuration#decision-traffic).

---

## Limits

- **Recorded shapes, not live captures.** The parsers and their tests follow the formats as the providers document them. A provider that changes a field name is caught by its own response failing to parse, which leaves the body untouched and names every floored question in the abstain header.
- **System One questions are keyed by name.** The log and the abstain header list them in name order, not the order the request wrote them.
- **The MCP proxy does not govern decision calls.** They are HTTP API calls, made by your app, not tools an agent calls.
