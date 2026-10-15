# LiteLLM & Proxy Routing Architecture <Badge type="tip" text="Cloud" />

This page documents how LLM requests are routed from client harnesses (Cursor, Claude Code, etc.), the architectural separation between hot-path gateways and internal helper services, and how the routing behaves in the open-source local sandbox versus the commercial enterprise control plane.

---

## 1. Local Open-Core Routing (Developer Sandbox)

In the open-source local developer sandbox, routing is designed to be stateless, lightweight, and extremely low-latency **out of the box**. The same open-core proxy also ships an optional stateful routing mode (Thompson sampling with a local reward loop) that is opt-in via `config.yaml`. 

```
                               ┌────────────────────────────────┐
                               │     Local Workstation          │
  Harnesses ──────────────────▶│  Intutic Proxy Gateway (Rust)  │
 (Cursor, Claude Code, Aider)  │  (intutic-proxy)               │
                               └──────────────┬─────────────────┘
                                              │
                                              │ (Direct TLS stream)
                                              ▼
                                 🌐 Upstream API Providers
                                 (Anthropic, OpenAI, Gemini)
```

*   **Direct-to-Provider:** The local **Intutic Proxy Gateway** (a custom proxy written in Rust, located in `packages/proxy`) intercepts API calls, runs Layer 1 safety checks (DLP, local budget gates, and sandboxed WASM custom rules) in-process — no network hop, no model call — and forwards the stream **directly** to the upstream model provider.
*   **Zero Local Overhead:** The open-source local developer sandbox does **not** run or require any Python LiteLLM container or Node.js control plane processes. It keeps the workstation footprint small and avoids adding cold-path routing hops.
*   **Optional Stateful Routing:** The same open-core proxy also contains the full Thompson-sampling bandit router (`packages/proxy/src/routing/bandit.rs`) and a local deterministic reward loop (`packages/proxy/src/routing/reward.rs`) that learns arm state from signals the proxy already observes — upstream success, latency vs. SLO, token anomaly, and routed-vs-requested cost ratio — with no LLM judge and no control plane. It is enabled through the `intutic_settings.routing` block in `config.yaml`, which ships **commented out**, so the stateless direct-to-provider path above remains the default until you explicitly turn it on.

---

## 2. Enterprise Control Plane Routing (SaaS / VPC)

When the local gateway is connected to the commercial **Intutic Control Plane**, the architecture splits into a dual-proxy configuration to decouple latency-sensitive traffic from complex, off-hot-path evaluation logic.

```
                  ┌──────────────────────────────────────────────┐
                  │            Intutic Control Plane (Cloud)     │
                  │                                              │
  Local Proxy ────┼─▶ [Rust Gateway] ────────────────────────────┼─▶ Upstream LLMs
                  │       │                                      │
                  │       ▼ (Valkey Pub/Sub)                     │
                  │  ┌───────────────────┐      ┌─────────────┐  │
                  │  │   Control Plane   │─────▶│   LiteLLM   │  │
                  │  │  (Node.js / Hono) │      │  (Python)   │  │
                  │  └───────────────────┘      └─────────────┘  │
                  └──────────────────────────────────────────────┘
```

### Hot-Path: Intutic Proxy Gateway (Rust)
All production completions flow exclusively through the high-performance Rust proxy. It terminates TLS, runs inline WASM filters, and handles direct streaming to model providers. Completion content **never** passes through Python runtimes on the hot-path.

### Off-Hot-Path: LiteLLM Helper (Python)
The commercial control plane deploys an internal Python `litellm` container. It sits entirely off the hot-path and acts as an administrative coordinator for the Node.js control plane:

*   **LLM Output Probe (opt-in):** When the LLM probe feature flag is on for a workspace and its plan allows an LLM judge, a sample of completed responses is graded asynchronously against the session's active SOP by a self-hosted judge model. The verdict is written to the control-plane log only; it is not stored and does not block or change the request.
*   **SOP Quality Scoring:** Scores an SOP against a 13-category quality rubric (0–2 per category, 26 in total) when it is promoted from review to generated, and when the optional SOP refinement pass (off by default) proposes a rewrite. If the helper is unreachable, the control plane falls back to an offline structural score, marked `[offline]`.
*   **SOP Compilation:** Translates natural-language SOP markdown into a machine-readable step graph (JSON) using the model's JSON output mode.
*   **Not pricing (FinOps):** this container does not fetch rates. Token costs come from LiteLLM's published price list, re-pinned nightly into the proxy's offline pricing bundle and shipped with each release.

---

## 3. Intelligent Model Routing

The **Intelligent Model Routing** engine — **Adaptive Reinforcement Selection** over a Thompson-sampling arm set — ships in the open-core Rust proxy and is shared by both deployments, optimizing cost vs. capability dynamically. In standalone open-core mode the proxy learns arm state itself from the local deterministic reward loop; the commercial control plane takes over arm learning with a daily reward of the same shape, computed from the traces it holds (with a member's useful/wasted label overriding a trace's integrity score), and adds the daily decay and outage penalties described below. No LLM judge takes part in either reward. 

### Adaptive Selection & Candidate Selection
* **Candidate Pool:** The router chooses among the proxy's `candidate_models` (by default `claude-sonnet-5-5`, `gpt-4.1` and `gemini-3.8-flash`) or the workspace's own `routingCandidates`, narrowed per request to the candidates that request can reach: a format it can be translated to, allowed, within budget and with a credential. See [Which models a request can be routed to](/guide/intelligent-routing#which-models-a-request-can-be-routed-to).
* **Automatic Bypass:** If a client explicitly requests a custom, specialized, or low-cost local model (e.g. `llama-3-8b`), the router automatically bypasses intelligent routing selection to prevent upgrading cheap requests to expensive frontier models.
* **Cold-Start Fallback:** Until the candidate arms for a request's SOP tier and task type have 20 recorded pulls between them, the router serves the requested model and gathers baseline observations first.

### Word-Boundary Task Classification
Prompt text is classified at the gateway using a fast, non-allocating word-boundary matcher. This avoids regex/LLM latency, categorizing prompts into five task types:
* `testing` — default keywords: `test`, `spec`, `assert`, `vitest`, `jest`, `unittest`
* `deployment` — default keywords: `deploy`, `release`, `kubernetes`, `docker`, `gke`, `pipeline`, `ci/cd`
* `review` — default keywords: `review`, `audit`, `lint`, `eslint`, `pr`
* `debugging` — default keywords: `fix`, `bug`, `issue`, `error`, `crash`, `debug`
* `coding` — default fallback category

#### Dynamic Custom Keywords & UI Configuration
Developers and administrators can customize these trigger words in the dashboard under **Settings › AI Routing & Caching**, in **Configurable Task Trigger Words** on the Smart Model Routing & Response Cache card. Custom trigger lists are saved to PostgreSQL settings and propagated to Valkey under the cache key `workspace:bandit_keywords:{workspaceId}`. The Rust proxy fetches this configuration dynamically with a **200ms timeout** failover, falling back to defaults if Valkey is degraded.

#### No Background Re-Classification
A trace keeps the task type the keyword matcher gave it, and its reward goes to that arm. There is no background LLM pass that re-categorises `coding` traces or adds keywords to the workspace's lists: the trigger words are the ones you configure.

#### Single-Writer Ownership
Arm learning has exactly one writer per workspace, tracked in Valkey under `bandit:reward_mode:{workspaceId}`. A standalone open-core proxy claims the marker as `local` and runs the deterministic reward loop itself. When a control plane takes the workspace over, it sets the marker to `cloud`; the local writer sees the change on its next ownership refresh and stands down within **~60s**, leaving the cloud reward cron as the sole writer. This prevents the local loop and the cron from double-counting rewards against the same arms.

### Real-Time Outage Protection & Penalties
* **Outage Capture:** The Rust proxy detects upstream connection timeouts and $500+$ server errors. 
* **Failure Penalty:** Outages are instantly logged in Valkey (`bandit:outage_failures:{workspaceId}`). During daily updates, these failures are directly added to the model's `beta` parameter, immediately reducing its routing probability.

### Dynamic Parameter Decay (Preventing Lock-in)
To prevent historical data from causing exploration lock-in (where a model remains selected despite recent degradation), the daily cron job applies a **decay factor ($\gamma = 0.95$)** to all workspace model parameters (`alpha`, `beta`, and `pulls`) before adding new reward updates. This prioritizes recent model performance and keeps the routing system highly adaptive to provider drifts.
