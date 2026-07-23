# Policies & Enforcement <Badge type="warning" text="Cloud / Team" />

Configure how Intutic governs your AI coding agents using a two-layer protection architecture.

## Two-Layer Protection

Intutic protects your workspace using two complementary enforcement layers:

1. **Layer 1 (Client/Rule Layer)** — Compiles and injects natural-language instructions (SOPs) directly into harness configuration files that agents read before starting
2. **Layer 2 (Network/Packet Layer)** — Intercepts raw LLM API calls via the proxy to block policy violations, redact sensitive data, and break execution loops

---

## Data Loss Prevention (DLP)

The DLP gate scans request payloads and tool outputs for sensitive data before forwarding them to LLM providers.

### What's Detected

- API keys and access tokens
- AWS credentials and service account keys
- Social Security Numbers (SSNs)
- Personally Identifiable Information (PII)
- Database connection strings
- Private keys and certificates

### Enforcement Modes

Configure DLP behavior using the `INTUTIC_DLP_MODE` environment variable:

| Mode | Action | Description |
|------|--------|-------------|
| **Block** | Reject request | The request is rejected entirely with a DLP error |
| **Redact** | Mask & forward | Sensitive data is replaced with masks (e.g., `sk-proj-****`) and the request continues |
| **Log** | Observe only | The incident is logged in the dashboard but the request proceeds unchanged |

::: tip
Start with `log` mode to understand your DLP exposure, then switch to `redact` or `block` once you've reviewed the findings.
:::

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
- [Core Concepts](/guide/concepts) — PCAS actions, anomaly types, risk tiers
- [Integrations Overview](/integrations/overview) — How policies are applied per harness
