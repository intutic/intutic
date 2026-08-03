# Intelligent Model Routing Guide <Badge type="info" text="FinOps & Latency" />

Intelligent Model Routing allows organizations to dynamically optimize LLM model selection across connected AI agent harnesses. By classifying tasks and routing prompts to the most cost-effective and capable models using adaptive reinforcement learning, Intutic helps you achieve peak performance while minimizing token expenses.

---

## How It Works

1. **Proxy Interception**: Every outbound prompt from your developer tools is routed through the proxy gateway.
2. **Gateway Classification**: The proxy performs in-process keyword matching — no model call — to classify the prompt into one of five task types: `testing`, `deployment`, `review`, `debugging`, or `coding`.
3. **Thompson Sampling Selection**: Intutic evaluates historical reward parameters ($\alpha, \beta$) for the `(Model × SOP Tier × Task Type)` Beta distribution to select the optimal model.
4. **Reward Feedback**: Every routed request updates its arm's ($\alpha, \beta$) parameters in Valkey. Where the reward signal comes from depends on your deployment: [local deterministic rewards](#local-deterministic-reward-mode-open-core) in standalone open-core mode, or LLM-as-a-Judge audits in cloud-managed workspaces.

<!-- ENTERPRISE_ONLY_START -->
### Cloud Reward Feedback (LLM-as-a-Judge)

Background **LLMProbe** workers audit trajectory outputs, evaluating response quality and SOP compliance. High-quality responses increment success parameters ($\alpha$), while failures increment ($\beta$) in Valkey.

```
 ┌────────────────┐       ┌─────────────────────┐       ┌─────────────────────┐
 │ Outbound Prompt│ ──1──>│  Thompson Sampling  │ ──2──>│  Selected Model     │
 └────────────────┘       │  Model Selection    │       │ (e.g., gpt-4o-mini) │
                          └──────────┬──────────┘       └──────────┬──────────┘
                                     ▲                             │
                                  4. Reward                        │ 3. Response
                                 Update (α, β)                     │
                                     │                             ▼
                          ┌──────────┴──────────┐       ┌─────────────────────┐
                          │  LLM-as-a-Judge     │ <─────│ Async Background    │
                          │  (LLMProbe Audit)   │       │ Trajectory Logger   │
                          └─────────────────────┘       └─────────────────────┘
```
<!-- ENTERPRISE_ONLY_END -->

---

## Local Deterministic Reward Mode (Open-Core)

Standalone proxies learn without any LLM judge: after every routed request, the proxy computes a reward in $[0, 1]$ from signals it already observes and updates the arm directly — entirely on your machine, off the request latency path.

Where that arm state lives depends on whether a Valkey is present. With one, it is the `bandit:{workspaceId}` hash. Without one, it is `~/.intutic/bandit-state.json`, written atomically after each update. **Both persist across restarts**, which matters because Thompson sampling only engages after 20 cumulative pulls — a proxy that forgot its arms on every restart would never reach that threshold, and would fall back to the requested model forever.

The two representations are numerically equivalent within `1e-12`. The difference is not the update rule — that is shared code — but serialization: Valkey round-trips each arm through `cjson`'s 14 significant digits, while the local file keeps full `f64` precision. The local store is, marginally, the more precise of the two.

| Signal | Effect on reward |
|---|---|
| Upstream transport failure or 5xx | reward = `0` (failed pull) |
| Latency over `latency_slo_ms` | `− latency_penalty × min(overrun ratio, 1)` |
| Token-count anomaly detected | `− token_anomaly_penalty` |
| Routed model costlier than requested | `− cost_penalty × min(cost ratio − 1, 1)` |

A clean on-SLO response at equal-or-lower cost earns the full reward of `1.0`. Upstream 4xx responses are the caller's fault and produce no update. Cached responses never produce updates.

The arm update rule is identical to the cloud reward cron, so learning state carries over seamlessly if you later connect a control plane:

$$\text{scale} = \max\left(\tfrac{1}{\log_2(\text{pulls}+2)}, 0.1\right),\quad \alpha \mathrel{+}= r \cdot \text{scale},\quad \beta \mathrel{+}= (1-r) \cdot \text{scale}$$

**Ownership hand-off**: the first local update claims the workspace by setting `bandit:reward_mode:{workspace}` to `local`. When a control plane takes over reward learning it sets the marker to `cloud`, and the local writer stands down automatically within ~60 seconds — arms transfer to LLMProbe without distortion.

> [!NOTE]
> Routing locks the selected model per session, so one long session contributes many pulls to a single arm. This matches cloud semantics; expect learning to converge per-workspace, not per-request.

### Standalone Activation

Enable routing directly in the proxy's `config.yaml` — no dashboard or control plane required:

```yaml
intutic_settings:
  routing:
    enabled: true
    candidate_models: ["claude-3-5-sonnet", "gpt-4o", "gemini-2.0-flash"]
    reward:
      enabled: true
      latency_slo_ms: 30000
      latency_penalty: 0.3
      token_anomaly_penalty: 0.2
      cost_penalty: 0.2
```

`candidate_models` must name entries from your `model_list` so provider resolution and cost estimation stay accurate. Requests for models outside the pool bypass the bandit untouched.

> [!IMPORTANT]
> **Precedence**: if a control plane publishes a feature-flag payload for the workspace, `ff_bandit_routing` is authoritative and `routing.enabled` is ignored — even if that payload is malformed, in which case every flag resolves to `false`. Presence is what confers authority. The config toggle applies only when no control plane manages the workspace.

---

## Setup & Activation

<!-- ENTERPRISE_ONLY_START -->
### Step 1: Enable Routing in the Dashboard
1. Open the **Compute Metrics Dashboard** (e.g., your control-plane console, or the local one at `http://localhost:5174`).
2. Navigate to **Settings** from the sidebar navigation.
3. Click on the **Smart Model Routing & Response Cache** tab.
4. Check the **`Enable Intelligent Model Routing`** option.

---

### Step 2: Configure Custom Task Trigger Words
You can customize the words that trigger model redirection to fit your team's tech stack and vocabularies:
1. In the **Intelligent Model Routing** settings section, locate the keyword configuration fields.
2. Input comma-separated lists of trigger keywords for the following categories:
   * **Testing**: e.g., `test, spec, vitest, jest, unittest, assert`
   * **Deployment**: e.g., `deploy, release, kubernetes, docker, gke, pipeline, ci/cd`
   * **Review**: e.g., `review, audit, lint, eslint, pr`
   * **Debugging**: e.g., `fix, bug, issue, error, crash, debug`
3. Click **Save Keywords** to push the updates to Valkey.

> [!NOTE]
> Custom keywords are validated at the API layer. Keywords must be alphanumeric strings (or `ci/cd`) and between 2 and 19 characters long.

---
<!-- ENTERPRISE_ONLY_END -->

### Step 3: Route Agent Traffic
To route agent traffic, you must ensure your AI agent harnesses are connected to the Intutic proxy gateway:

#### Option A: Using the CLI (Recommended)
The Intutic CLI sync daemon scans and automatically updates the configurations of all supported harnesses in your local repository:
```bash
npm install -g @intutic/cli
intutic login
intutic init
intutic connect
```

#### Option B: Standalone Proxy Redirects
For custom agent configurations, point your agent's API base URL environment variables directly to the proxy gateway:
```bash
export OPENAI_BASE_URL="http://localhost:4000/v1"
# Host only — the Anthropic SDK appends /v1/messages itself.
export ANTHROPIC_BASE_URL="http://localhost:4000"
```

Once connected, your prompts are automatically routed to the most optimal model based on local rules and current learning rates.
