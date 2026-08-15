# Policies & Enforcement <Badge type="warning" text="Cloud / Team" />

Configure how Intutic governs your AI coding agents using a two-layer protection architecture.

## Two-Layer Protection

Intutic protects your workspace using two complementary enforcement layers:

1. **Layer 1 (Client/Rule Layer)** — Compiles and injects natural-language instructions (SOPs) directly into harness configuration files that agents read before starting
2. **Layer 2 (Network/Packet Layer)** — Intercepts raw LLM API calls via the proxy to block policy violations, redact sensitive data, and break execution loops

---

## Data Loss Prevention (DLP)

The DLP gate scans request payloads, forwarded request headers, and response
bodies — streaming included — for sensitive data.

### What's Detected

- API keys and access tokens
- AWS credentials and service account keys
- Social Security Numbers (SSNs)
- Personally Identifiable Information (PII)
- Database connection strings
- Private keys and certificates

### Enforcement

The action is **per pattern, not per mode**, and is fixed by what the pattern
is: private keys and Anthropic API keys **block** (the request is refused with
a DLP error); everything else **redacts** — the match is replaced with
`[REDACTED_*]` and the redacted body is what reaches your provider.

DLP is configured in `config.yaml` under `intutic_settings.dlp`:

| Setting | Default | Effect |
|---------|---------|--------|
| `enabled` | `true` | Master switch |
| `scan_input` | `true` | Scan request bodies and forwarded header values before forwarding |
| `scan_output` | `true` | Scan response bodies; streaming responses are scrubbed per SSE line before each line reaches the client |

Headers follow the same doctrine: a block-action match in a forwarded header
refuses the request with a DLP error, and any other header finding is redacted
in place before the request leaves the machine. In streamed responses,
block-tier matches are contained by redaction rather than killing the stream.

There is no log-only mode today; every finding is also recorded in the trace
and available to WASM rules as `dlp_findings`.

---

## Enforcement Actions (PCAS)

The Policy Compliance and Action System evaluates every tool use request against your safety guidelines:

### Risk Categories

Each tool execution is classified by risk level:

| Category | Examples |
|----------|---------|
| **None** | Read-only operations, search, local project compilation |
| **Credential Access** | Reading `.env` files, accessing keyrings, querying credential managers |
| **Destructive** | Running `rm -rf`, deleting cloud infrastructure, executing destructive database queries |

### Four Enforcement Actions

| Action | What Happens | When It's Used |
|--------|-------------|----------------|
| **Bypass** | Tool call passes through unmodified | Fully compliant with all policies |
| **Enhance** | Safety prompts or warnings are injected into the agent's context | Minor risk but generally safe |
| **Hijack** | Tool outcome is replaced with a mock response or override | Policy violation that can be safely redirected |
| **Kill** | Tool call is blocked immediately | Serious policy violation or budget breach |

### Intervention Modes

How the enforcement action is communicated:

| Mode | Behavior |
|------|----------|
| **Transparent** | Developer sees a clear explanation of the policy breach |
| **Opaque** | Agent receives a generic error and tries an alternative approach |
| **Silent Log** | Request proceeds but is flagged in the dashboard for review |

---

## Network Egress Control

While DLP and PCAS govern *what the model sees*, egress control governs
*where the agent's traffic can go at all* — a guardrail alongside them,
not a special case of either.

Set the posture once per workspace and it reaches every proxy — they
hot-reload it within roughly 30 seconds, no restart needed.

| Mode | Behavior |
|---|---|
| **Off** (default) | The proxy mediates AI traffic but denies nothing. No egress control — each proxy stays on its own local config. |
| **Monitor** | Nothing is blocked, but every connection that would be denied under Enforce is logged and counted. Use it to measure blast radius before committing. |
| **Enforce** | Destinations not on the allow list are denied (403, no tunnel). AI providers are always intercepted, never blocked. |

The **allow list** is one entry per line — an exact host
(`api.internal.corp`), a `.suffix` domain (`.internal.corp`), or a
CIDR/IP (`10.0.0.0/8`) — unioned with each developer's local allow
entries. AI providers and DNS are always permitted regardless of mode.

This is the *proxy-layer* half of egress control — it governs traffic the
proxy actually sees. It does not, on its own, stop an agent from routing
around the proxy entirely. Pair it with `intutic enforce` on the host
(a default-deny firewall that makes the proxy the *only* path off the
machine) to close that gap — see
[Egress Enforcement & Runtime Isolation](/guide/how-it-works#egress-enforcement-runtime-isolation-opt-in)
and the [CLI reference](/reference/cli#intutic-enforce).

## Sandboxed Execution

A workspace-level requirement that agents run inside an isolated runtime —
a container or Firecracker microVM whose only egress is the governing
proxy — enforced by the CLI on `intutic exec`.

| Requirement | Behavior |
|---|---|
| **Off** (default) | Agents run on the host as normal. Developers can still opt in with `intutic exec --sandbox`. |
| **Recommend** | An un-sandboxed `intutic exec` still runs, but prints a warning nudging the developer to add `--sandbox`. |
| **Require** | An un-sandboxed `intutic exec` is refused — the developer must re-run with `--sandbox`. |

This is a client-side, advisory layer: a determined developer can bypass
it by not using `intutic exec` at all. See
[Sandboxed Execution](/guide/sandboxed-execution) for the backends
(containers today, Firecracker microVMs where KVM is available — with
its own maturity caveat), what they actually isolate, and what platforms
this does and does not cover.

## SOP Synchronization

When you run `intutic connect`, the sync daemon keeps your workspace aligned with the control plane:

1. **Detects** all active coding harnesses in your workspace
2. **Formats** SOPs into harness-native structures (Markdown for Claude Code, JSON for Antigravity, YAML for Aider, etc.)
3. **Writes** governance rules atomically, preventing configuration drift or corruption
4. **Monitors** for manual edits and rewrites configurations based on your bypass enforcement tier

See [How It Works](/guide/how-it-works) for the full sync daemon architecture.

---

## Related

- [Agent Guidelines (SOPs)](/guide/sops) — Managing governance rules
- [How It Works](/guide/how-it-works) — Architecture and enforcement flow
- [Sandboxed Execution](/guide/sandboxed-execution) — Backends, platform coverage, and the client-side-advisory caveat
- [Core Concepts](/guide/concepts) — PCAS actions, anomaly types, risk tiers
- [Integrations Overview](/integrations/overview) — How policies are applied per harness
