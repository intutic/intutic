# LiteLLM & Proxy Routing Architecture <Badge type="danger" text="Enterprise" />

This page documents how LLM requests are routed from client harnesses (Cursor, Claude Code, etc.), the architectural separation between hot-path gateways and internal helper services, and how the routing behaves in the open-source local sandbox versus the commercial enterprise control plane.

---

## 1. Local Open-Core Routing (Developer Sandbox)

In the open-source local developer sandbox, routing is designed to be stateless, lightweight, and extremely low-latency. 

```
                               ┌────────────────────────────────┐
                               │     Local Workstation          │
  Harnesses ──────────────────▶│  Intutic Proxy Gateway (Rust)  │
 (Cursor, Claude Code, Aider)  │  (intutic-proxy)               │
                               └──────────────┬─────────────────┘
                                              │
                                              │ (Direct SSL Stream)
                                              ▼
                                 🌐 Upstream API Providers
                                 (Anthropic, OpenAI, Gemini)
```

*   **Direct-to-Provider:** The local **Intutic Proxy Gateway** (a custom proxy written in Rust, located in `packages/proxy`) intercepts API calls, runs Layer 1 safety checks (DLP, local budget gates, and sandboxed WASM custom rules) in under **5ms**, and forwards the stream **directly** to the upstream model provider.
*   **Zero Local Overhead:** The open-source local developer sandbox does **not** run or require any Python LiteLLM container or Node.js control plane processes. It keeps the workstation footprint small and avoids adding cold-path routing hops.

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
All production completions flow exclusively through the high-performance Rust proxy. It terminates TLS, runs inline V8/WASM filters, and handles direct streaming to model providers. Completion content **never** passes through Python runtimes on the hot-path.

### Off-Hot-Path: LiteLLM Helper (Python)
The commercial control plane deploys an internal Python `litellm` container. It sits entirely off the hot-path and acts as an administrative coordinator for the Node.js control plane:

*   **LLM Probes (Layer 2 SOP Evaluation):** Captures tool-use events and executes asynchronous, deep LLM evaluations against your organization's SOP registry.
*   **SOP Compliance Scoring:** Automatically evaluates newly added SOP rules across 13 compliance categories to generate structured quality metrics.
*   **SOP Compilation:** Translates natural-language SOP markdown files into machine-readable JSON schemas using structured model outputs.
*   **Pricing Synchronization (FinOps):** Automatically queries provider endpoints daily to sync token and context costs, storing them in the control plane's database for accurate cost attribution.

---

## 3. Intelligent Model Routing

The commercial control plane proxy integrates an **Intelligent Model Routing** engine using **Adaptive Reinforcement Selection** to optimize cost vs. capability dynamically. 

### Adaptive Selection & Candidate Selection
* **Candidate Pool:** The router evaluates a core pool of high-capability candidate models: `claude-3-5-sonnet`, `gpt-4o`, and `gemini-1.5-pro`.
* **Automatic Bypass:** If a client explicitly requests a custom, specialized, or low-cost local model (e.g. `llama-3-8b`), the router automatically bypasses intelligent routing selection to prevent upgrading cheap requests to expensive frontier models.
* **Cold-Start Fallback:** If a workspace has fewer than 20 cumulative requests handled, the routing model remains inactive to gather baseline observations first.

### Word-Boundary Task Classification
Prompt text is classified at the gateway using a fast, non-allocating word-boundary matcher. This avoids regex/LLM latency, categorizing prompts into five task types:
* `testing` — default keywords: `test`, `spec`, `assert`, `vitest`, `jest`, `unittest`
* `deployment` — default keywords: `deploy`, `release`, `kubernetes`, `docker`, `gke`, `pipeline`, `ci/cd`
* `review` — default keywords: `review`, `audit`, `lint`, `eslint`, `pr`
* `debugging` — default keywords: `fix`, `bug`, `issue`, `error`, `crash`, `debug`
* `coding` — default fallback category

#### Dynamic Custom Keywords & UI Configuration
Developers and administrators can customize these trigger words via the **Compute Metrics Dashboard**. Custom trigger lists are saved to PostgreSQL settings and propagated to Valkey under the cache key `workspace:bandit_keywords:{workspaceId}`. The Rust proxy fetches this configuration dynamically with a **200ms timeout** failover, falling back to defaults if Valkey is degraded.

#### Background LLM-as-a-Judge Refinement
To maintain optimal task classification without hot path overhead:
1. **Asynchronous Analysis**: A daily background cron job processes a sample of execution trace prompts, using high-performance LLM-as-a-judge completion calls to review and refine their classifications.
2. **In-Memory Statistics Redirection**: To comply with audit guidelines that require `execution_traces` to be strictly write-once / append-only, classification adjustments are performed in-memory during reward aggregation. Reward feedback is shifted directly to the refined arm (e.g. from `coding` to `testing`) without mutating historical records.
3. **Keyword Expansion**: Newly identified keywords are automatically added to the workspace's custom settings lists, enhancing local matching accuracy on future runs.

### Real-Time Outage Protection & Penalties
* **Outage Capture:** The Rust proxy detects upstream connection timeouts and $500+$ server errors. 
* **Failure Penalty:** Outages are instantly logged in Valkey (`bandit:outage_failures:{workspaceId}`). During daily updates, these failures are directly added to the model's `beta` parameter, immediately reducing its routing probability.

### Dynamic Parameter Decay (Preventing Lock-in)
To prevent historical data from causing exploration lock-in (where a model remains selected despite recent degradation), the daily cron job applies a **decay factor ($\gamma = 0.95$)** to all workspace model parameters (`alpha`, `beta`, and `pulls`) before adding new reward updates. This prioritizes recent model performance and keeps the routing system highly adaptive to provider drifts.
