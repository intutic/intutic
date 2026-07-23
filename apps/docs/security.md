---
title: Security
description: How Intutic protects your AI agent workflows — threat model, data flow, encryption, authentication, and compliance posture.
---

# Security

Intutic is a governance layer that sits between your AI agents and LLM providers. Security is foundational — every design decision prioritizes the principle that **governance infrastructure must never become the attack surface it's meant to protect**.

---

## Threat Model

Intutic defends against three categories of threat:

| Threat | Vector | Mitigation |
|---|---|---|
| **Agent misuse** | AI agent executes destructive tool calls (file deletion, credential exposure, unauthorized API calls) | Real-time SOP evaluation with BYPASS/ENHANCE/HIJACK/KILL verdicts via the [circuit breaker](/guide/how-it-works) |
| **Credential leakage** | API keys, tokens, or secrets exfiltrated through agent output or prompt injection | DLP scanning in the proxy hot path; secrets detected and redacted before reaching the LLM |
| **Unauthorized access** | Rogue agents or developers bypassing governance controls | RBAC enforcement, OBO token scoping, harness config drift detection with auto-revert, and break-glass overrides |

---

## Data Flow

```
Developer → AI Agent → Intutic Proxy (:4000) → LLM Provider
                            │
                      ┌─────▼──────┐
                      │  Policy    │
                      │  Engine    │
                      │  (WASM +   │
                      │   SOPs)    │
                      └─────┬──────┘
                            │
                      ┌─────▼──────┐
                      │  Control   │
                      │  Plane     │
                      │  (:3001)   │
                      └────────────┘
```

1. Every LLM request from an AI agent is routed through the **local Intutic proxy** on port 4000
2. The proxy evaluates tool calls against SOPs in the **WASM policy engine** (< 5ms typical)
3. Verdicts, traces, and telemetry are sent to the **control plane** for storage and analysis
4. The proxy **never stores prompts or completions** — only structured telemetry (tool names, verdicts, token counts, timing)

---

## Data Locality

The proxy runs **locally on the developer's machine**. LLM traffic is not rerouted through Intutic's cloud infrastructure — it flows directly from the proxy to the LLM provider. Only governance telemetry reaches the control plane.

---

## Encryption

### In Transit

All network communication is encrypted with TLS 1.2+:

| Path | Protocol |
|---|---|
| Proxy → LLM Provider | HTTPS (TLS 1.2+) |
| Proxy → Control Plane | HTTPS (TLS 1.2+) |
| Sync Daemon ↔ Control Plane | WSS (WebSocket over TLS) |
| Dashboard → Control Plane | HTTPS (TLS 1.2+) |

### At Rest

| Data | Storage | Encryption |
|---|---|---|
| Governance traces | PostgreSQL | AES-256 (managed encryption) |
| Session state & caches | Valkey (Redis-compatible) | Ephemeral — not persisted to disk |
| SOP definitions | PostgreSQL | AES-256 (managed encryption) |
| API keys & credentials | PostgreSQL + system keychain | AES-256 + OS-level keychain encryption |
| Local config | `~/.intutic/credentials.json` | File permissions (`0600`) + system keychain |

---

<!-- ENTERPRISE_ONLY_START -->
::: warning Enterprise Feature — Commercial / VPC Tier
The identity, SSO, OIDC, and compliance capabilities below are available in the **Enterprise SaaS & Self-Hosted VPC** editions.
:::

## Authentication & Identity <Badge type="danger" text="Enterprise Tier" />

Intutic provides enterprise-grade identity and access management:

- **Single Sign-On (SSO)** — OIDC integration with Okta, Microsoft Entra ID, Google Workspace, Ping Identity, and custom OIDC providers
- **API Keys** — Virtual keys (`vk_` prefix) for programmatic access, with rotation and revocation
- **OBO Tokens** — Short-lived, employee-scoped agent credentials that replace shared API keys
- **RBAC Roles** — Five-tier role hierarchy (Owner → Admin → EM → Developer → Viewer) with feature-level gating

---

## Compliance <Badge type="danger" text="Enterprise Tier" />

Intutic helps your organization meet regulatory requirements for AI governance:

- **SOC 2 Readiness** — Automated evidence collection for trust service criteria (security, availability, processing integrity, confidentiality)
- **HIPAA BAA** — PHI safeguard tracking and BAA status management
- **GDPR** — Data erasure (right to be forgotten), consent management, and data processing agreements
- **Data Residency** — Pin governance data to US, EU, or APAC regions

---
<!-- ENTERPRISE_ONLY_END -->

### Enforcement Coverage

Connected harnesses are scored on a four-tier system:

| Tier | Enforcement Level |
|---|---|
| **A** | Strict — immutable rules, credential redaction, system command blocking |
| **B** | Moderate — prompts for suspicious tool combinations |
| **C** | Audit — records traces without blocking |
| **D** | Observe — alerts only, fail-open |

---

## Infrastructure Security

| Layer | Controls |
|---|---|
| **Network** | VPC isolation, private subnets, no public database endpoints |
| **Compute** | GKE with node auto-upgrade, workload identity, pod security standards |
| **Secrets** | GCP Secret Manager — never committed to source control |
| **Monitoring** | Structured logging with trace context |
| **Supply chain** | Dependabot, lockfile integrity, signed container images |

→ Self-hosted deployment: [Deployment guide](/guide/how-it-works)
→ CLI configuration: [CLI Reference](/reference/cli)

---

## Responsible Disclosure

If you discover a security vulnerability, please report it to **support@intutic.ai**. We aim to acknowledge reports within 24 hours and provide a fix or mitigation within 7 business days.

---

| Page | What it covers |
|---|---|
| [Getting Started](/guide/getting-started) | Quickstart guide, local CLI setup, and harness connection |
| [How It Works](/guide/how-it-works) | Full architecture walkthrough — proxy, policy engine, control plane |
| [Custom Filters (WASM)](/external/wasm-rules) | WASM policy rules engine for custom tool-call filtering |
| [CLI Reference](/reference/cli) | CLI commands, doctor diagnostic tool, and local configuration |
| [Integrations Hub](/integrations/) | Harness setup guides for 18 supported agent tools |
