# Policies & Enforcement <Badge type="tip" text="Cloud" />

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
- AWS credentials
- Database connection credentials, JWTs and bearer tokens
- Private keys
- PII: payment card numbers, IBANs and US Social Security Numbers, plus email
  addresses and phone numbers when you turn them on (see [PII detectors](#pii-detectors))

### Enforcement

The action is **per pattern, not per mode**. For secrets it is fixed by what
the pattern is: private keys and Anthropic API keys **block** (the request is
refused with a DLP error); everything else **redacts** — the match is replaced with
`[REDACTED_*]` and the redacted body is what reaches your provider.

DLP is configured in `config.yaml` under `intutic_settings.dlp`:

| Setting | Default | Effect |
|---------|---------|--------|
| `enabled` | `true` | Master switch |
| `scan_input` | `true` | Scan request bodies and forwarded header values before forwarding |
| `scan_output` | `true` | Scan response bodies; streaming responses are scrubbed before each chunk reaches the client |
| `stream_holdback_bytes` | derived (1020 with the built-in patterns) | How far a streamed response is held back so a secret split across two chunks is seen whole before any of it is sent. The default is the longest match any installed pattern can produce. It delays the first token by the time the model takes to write that many bytes (a few seconds), not the end of the response. `0` turns the holdback off, and a split secret can then get through; a smaller number leaves secrets longer than it uncovered. Applies only when `enabled` and `scan_output` are on |
| `patterns` | none | Your own patterns, added to the built-in set (below) |
| `detectors` | see below | The action for each PII detector: `off`, `redact` or `block` |

### PII detectors <Badge type="tip" text="Open-Core" />

Each detector finds a candidate with a pattern and then validates it, so a
number that only looks like a card is not redacted as one. These are pattern
and checksum detectors, not a model: names, postal addresses and free-text
identifiers are not detected.

| Id | Detects | Validation | Default |
|---|---|---|---|
| `pii.card` | Payment card numbers: 13 to 19 digits, plain or in groups split by spaces or dashes (4-4-4-4, 4-6-5, 4-6-4) | A Visa, Mastercard, American Express, Discover, JCB, Diners Club or UnionPay prefix at a length that brand issues, and a valid Luhn checksum | `redact` |
| `pii.iban` | IBANs in capitals, printed in groups of four or written solid | A country code from the IBAN registry, that country's exact length, and the mod-97 check | `redact` |
| `pii.ssn` | US Social Security Numbers written `NNN-NN-NNNN` | Rejects numbers never issued: area 000, 666 or 900–999, group 00, serial 0000 | `redact` |
| `pii.email` | Email addresses | A letters-only top-level domain of two or more characters; well-formed dots and hyphens | `off` |
| `pii.phone` | Phone numbers starting with `+` (E.164, any country), and North American numbers with separators: `(NNN) NNN-NNNN`, `NNN-NNN-NNNN`, `NNN.NNN.NNNN` | 10 to 15 digits. Numbers with no `+` and no separators are not matched | `off` |

Every detector also requires a boundary: a match inside a longer word or
number (`order_4111…`, `0.4111…`, a fifth dash-separated group) is not a
finding. Card numbers that card brands publish for testing pass every check a
real number does, so they are redacted too.

Email and phone are off because coding-agent traffic is full of them: git
authors, `git config user.email`, `package.json` contacts, test fixtures. On
1,000 real coding-agent runs (64,583 tool calls from public OpenHands
trajectories), the email detector matched in 215 calls — mostly test
addresses such as `example.com` ones, git configuration and author credits in
licence headers — and the card, IBAN and SSN detectors matched nothing.

Set a detector's action under `dlp.detectors`. Detectors you leave out keep
their defaults:

```yaml
intutic_settings:
  dlp:
    detectors:
      pii.email: redact
      pii.phone: redact
      pii.card: block     # refuse the request instead of redacting
```

An unknown id or action stops the proxy at startup with an error naming it.
Findings carry the detector id as their pattern name and `pii` as their
category, so redactions read `[REDACTED_PII]` and SOP `pii()` taint rules see
them. The [MCP governance proxy](/guide/mcp-governance#configuration-reference) runs the
same detectors with the same defaults; on its machine, `INTUTIC_MCP_DLP_DETECTORS` sets
their actions the way `dlp.detectors` does for the LLM proxy.

#### Setting detector actions for a workspace <Badge type="tip" text="Cloud" />

A connected workspace can set the actions centrally, so every developer's proxies
handle PII the same way. The workspace setting `piiDetectors` gives an action
to each detector it names; an owner or admin sets it on **Settings › Security ›
PII Detectors**, with `intutic settings set`, or with Terraform:

```bash
intutic settings set piiDetectors '{"pii.card":"block","pii.email":"redact"}'
intutic settings set piiDetectors null   # stop governing the detectors centrally
```

The LLM proxy reads the setting with each virtual key it serves and applies it
to that key's requests and responses. The MCP governance proxy reads it with
the rest of the workspace's policy and applies it to tool-call arguments and
results. In both, the workspace's action is the baseline, and the machine's own
config — `dlp.detectors` for the LLM proxy, `INTUTIC_MCP_DLP_DETECTORS` for the
MCP proxy — may make it stricter (`off` → `redact` → `block`) but never looser:

| Workspace | Machine's config | Action |
|---|---|---|
| `pii.card: redact` | not set | `redact` |
| `pii.card: redact` | `pii.card: block` | `block` |
| `pii.card: block` | `pii.card: off` | `block` |
| `pii.email: off` | `pii.email: redact` | `redact` |
| not set | `pii.phone: redact` | `redact` |
| not set | not set | the detector's default |

A detector the workspace leaves out is governed by each machine's config, as it
is on a proxy with no workspace. A change reaches every LLM proxy within 30
seconds, and every MCP proxy with the rest of its policy: within a minute, or
up to five minutes for a proxy in `daemon` mode, whose MCP daemon caches the
policy.

If the LLM proxy cannot read the setting, it follows its
[fail mode](/concepts/circuit-breaker#proxy-side-fail-mode): with
`fail_closed: true`, the default, it refuses the request; with
`fail_closed: false`, or under a global break-glass override, it scans with the
machine's config alone. The MCP proxy keeps the setting it last loaded while
the control plane is unreachable, as it keeps the rest of its policy. When the
control plane answers that it cannot read the stored setting, the MCP proxy
follows `mcpProxyFailBehavior`, or `INTUTIC_MCP_FAIL_OPEN` for a workspace that
never chose: fail-closed refuses the tool call (`GOVERNANCE_UNAVAILABLE`),
fail-open scans with `INTUTIC_MCP_DLP_DETECTORS` alone. The setting is
available on every plan.

#### What each surface does with a match

The detectors and their defaults are one definition, shared by the two proxies, and both run
on your machines with the workspace's setting, when there is one. What a match does depends on
what the surface can change:

| Surface | What it scans | An enabled detector's match |
|---|---|---|
| LLM proxy | Request bodies and forwarded headers; responses, streaming included | The detector's action: `redact` replaces it with `[REDACTED_PII]`, `block` refuses the request |
| MCP governance proxy | Tool-call arguments | Blocks the call, whether the action is `redact` or `block`: the proxy cannot rewrite the arguments a tool receives, so the only way not to pass the value on is to refuse the call |
| MCP governance proxy | Tool results | Redacts it, whether the action is `redact` or `block` |
| Hook gates and SDK gates | Not scanned for PII | None. A gate can only allow or block a tool call, and the calls it sees are the ones an agent makes on the developer's own machine, where card numbers in test fixtures and personal data in local files are routine. Blocking each one would stop ordinary work, as blocking a pasted JWT would. The gates block credential-shaped values, not PII |

So the same Social Security Number is redacted from a model request, blocked as an MCP tool
argument, and allowed in a harness's shell command. When the agent's model traffic goes
through the LLM proxy, the model never sees the number unredacted to put it in a tool call.

### Custom patterns

Add patterns for data shaped by your own systems (customer IDs, record numbers, health identifiers) under `dlp.patterns`:

```yaml
intutic_settings:
  dlp:
    patterns:
      - name: customer_id          # appears in findings; keep names unique
        category: pii              # SOP taint rules group by it; redactions read [REDACTED_PII]
        regex: 'CUST-[0-9]{8}'     # Rust regex syntax: no lookaround; (?i: … ) for case-insensitive
        action: redact             # redact (default) or block
```

`action` is `redact` or `block`; anything else, or a regex that does not compile, stops the proxy at startup with an error naming the pattern, so a typo never leaves a rule silently unenforced. A pattern with a long bounded repetition (`{50,1000}`) raises the derived `stream_holdback_bytes` for every streamed response.

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

### Promoting Monitor → Enforce

Run **Monitor** first and read what it would have denied before you switch:

1. Set the mode to Monitor with the allow list you intend to enforce, and
   leave it there for at least one full working week so every job and
   developer machine has run under it.
2. Read the would-deny counts (each would-be denial is counted per
   destination). Every destination on that list is either a missing
   allow-list entry or a real leak; decide which for each one, and add the
   entries you mean to keep.
3. When a week passes with no would-deny you did not expect, switch to
   Enforce. AI providers and DNS stay reachable in every mode, so the switch
   cannot cut an agent off from its model.
4. Keep `intutic enforce` on the host for the machines that matter: the
   proxy-layer mode only governs traffic the proxy sees.

Switching back to Monitor is one setting and takes effect on the next
request; nothing is queued or lost in between.

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

## Compliance Scope

**Policies › Compliance Scope** (`/policies/scope`; Owners, Admins and Engineering Managers) shows how much of each connected agent environment Intutic enforces, and the evidence behind it. It refreshes every 30 seconds.

Each environment (a harness the sync daemon reported) gets an **enforcement tier** from the governance layers found active in its config:

| Tier | Shown as | Active layers | Depth score |
|------|----------|---------------|-------------|
| **A** | Tier A: full | MCP proxy and a native hook: every tool call enforced in process | 100 |
| **B** | Tier B: proxy | MCP proxy only | 75 |
| **C** | Tier C: LLM | LLM proxy only | 50 |
| **D** | Tier D: rules | A rules file only: guidance the agent reads, checked after the fact | 25 |
| none | No coverage | Nothing detected | 0 |

Its **score**, out of 100, weights the depth score at 60% and a telemetry score at 40%. The telemetry score reflects whether the environment's gate has been seen reporting recently, and how many tool calls it blocked in the last 24 hours.

The page opens with **Unenforced environments**, **Fully enforced (tier A)**, **Environments monitored** and **Average score**, then a count per tier, then one card per environment, tier A first. Below the cards:

- **Active Compliance Probes** — the workspace's compliance probes, with **Collect & export evidence**. See [Compliance Evidence](/guide/compliance-evidence).
- **Framework Coverage** — the probes and records mapped to the EU AI Act, ISO/IEC 42001, NIST AI RMF or MITRE ATLAS, with the report as Markdown, CSV or PDF and the human-oversight export. See [Framework Mapping](/guide/framework-mapping).
- **Provider Incidents** — upstream provider outages that affected this workspace's requests, grouped into failure windows. See [Provider-Downtime Evidence](/guide/provider-incidents).
- **Capability Misses** — sessions that ran tools with no governing guideline matched, most ungoverned first.

---

## Related

- [Agent Guidelines (SOPs)](/guide/sops) — Managing governance rules
- [How It Works](/guide/how-it-works) — Architecture and enforcement flow
- [Sandboxed Execution](/guide/sandboxed-execution) — Backends, platform coverage, and the client-side-advisory caveat
- [Core Concepts](/guide/concepts) — PCAS actions, anomaly types, risk tiers
- [Integrations Overview](/integrations/overview) — How policies are applied per harness
