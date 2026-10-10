# Intelligent Model Routing Guide <Badge type="info" text="FinOps & Latency" />

Intelligent Model Routing allows organizations to dynamically optimize LLM model selection across connected AI agent harnesses. By classifying tasks and routing prompts to the most cost-effective and capable models using adaptive reinforcement learning, Intutic helps you achieve peak performance while minimizing token expenses.

---

## How It Works

1. **Proxy Interception**: Every outbound prompt from your developer tools is routed through the proxy gateway.
2. **Gateway Classification**: The proxy performs deterministic keyword matching — in-process, no model call — to classify the prompt into one of five task types: `testing`, `deployment`, `review`, `debugging`, or `coding`.
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
> Routing locks the selected model per **scope** (workspace + the best available caller identity — see [Session Lock and KV-Cache Affinity](#session-lock-and-kv-cache-affinity) below for exactly what that means), so one long-running scope contributes many pulls to a single arm rather than one per request. This matches cloud semantics; expect learning to converge per-workspace, not per-request.

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

When `config.yaml` has a non-empty `model_list`, a candidate it does not name (as `model_name` or `litellm_params.model`) is dropped at startup with an error in the log, so a typo cannot become a model the bandit routes to. That check is all `model_list` does: the provider is chosen from the model name, its address from `ANTHROPIC_UPSTREAM_URL` and the other [upstream variables](/reference/configuration#provider-upstreams-and-keys), and cost from the bundled price list. Requests for models outside the pool bypass the bandit untouched.

In a cloud-managed workspace, the routing candidate pool is further narrowed to the intersection
of `candidate_models` and the workspace's approved-models allowlist (see
[Settings › Security › Approved Models](/guide/settings#approved-models)) — a candidate the allowlist excludes
is never selected, no matter how strong its arm.

> [!IMPORTANT]
> **Precedence**: if a control plane publishes a feature-flag payload for the workspace, `ff_bandit_routing` is authoritative and `routing.enabled` is ignored — even if that payload is malformed, in which case every flag resolves to `false`. Presence is what confers authority. The config toggle applies only when no control plane manages the workspace.

---

## Session Lock and KV-Cache Affinity

Every routing scope's model choice is pinned for that scope's lifetime — the bandit samples once
per scope, not once per request. This section explains why, what a "scope" actually is (it is
**not** simply "the session," despite the name this feature has always gone by), and what the pin
does and doesn't protect.

### What "scope" actually means

The natural name for this is "session lock," but no coding-agent harness in practice sends the
`x-session-id` header that name implies — so a lock keyed on that header alone would, in reality,
key on the literal string `"unknown"` for effectively all traffic, collapsing every unidentified
caller in every workspace onto one shared lock. That was a real defect, not a hypothetical one,
fixed in the same change that made the honesty work below possible.

The real key is the **scope**: `{workspace_id}:{agent}`, where `agent` resolves through a ladder —
the `x-session-id` header if a harness ever sends one, else the active autonomous-loop run id, else
the authenticated member id, else `anonymous`. Workspace is always the first component, so
cross-tenant contamination is structurally impossible regardless of what (if anything) identifies
the caller beyond that. Anonymous traffic inside one workspace still shares a bucket — correct,
since there is genuinely nothing to tell two anonymous callers in the same workspace apart — but
that bucket never crosses a workspace boundary.

### Why mid-scope switches are expensive

Provider inference backends cache the key/value (KV) state of a prompt prefix so a follow-up
request that repeats that prefix — exactly what a multi-turn conversation does — can skip
recomputing it, cutting both latency and cost on later turns. That cache is scoped to a specific
model: switching models mid-conversation forces the new model to recompute the entire prompt
prefix from scratch, discarding whatever cache discount the prior turns had built up. A bandit
that re-sampled fresh on every request would defeat prompt caching almost entirely on any
multi-turn conversation, trading a small chance of a marginally-better arm for a guaranteed cache
miss on every subsequent turn.

**Worked example.** A coding agent is twelve turns into a session on `claude-sonnet-4-5` with a
20,000-token prefix (system prompt, tool definitions, the conversation so far) that the provider
has cached. At the bundled list prices, a cache read is $0.30 per million tokens and a cache
write is $3.75 per million on Sonnet; on `claude-haiku-4-5` the same two rates are $0.10 and
$1.25.

| Turn 13 routed to | Prefix cost this turn | Why |
|---|---|---|
| Sonnet (stay) | 20,000 × $0.30/M = **$0.0060** | the whole prefix is a cache read |
| Haiku (switch) | 20,000 × $1.25/M = **$0.0250** | Haiku has never seen this prefix — a full cache write |

The switch costs about four times what staying costs on the turn it happens. Haiku's cheaper reads
then save $0.004 a turn ($0.006 − $0.002), so the switch does not pay for itself until five more
turns have gone by on Haiku without switching back — and a bandit that re-samples every turn
switches back. The guard rule in the proxy is exactly this arithmetic: when the last observation
for the scope shows a cache-read fraction of at least `cache_guard_min_read_bp` (5000 = 50%) and
is younger than `cache_guard_max_age_secs` (300 s, the provider's cache TTL), the bandit is not
consulted and the warm model is kept. Output tokens are the same either way and are left out.

The lock exists primarily to stop the bandit from flip-flopping arms mid-conversation — that was
the original complaint it fixes. Keeping the provider-side KV-cache prefix warm across turns is a
second effect of the same mechanism, not a separate feature, but it's just as real and just as
load-bearing for cost and latency.

### What engages and releases the lock

- **Engaged**: the first time a scope is routed — either because Thompson sampling picked an arm,
  or because the fallback path (fewer than 20 cumulative pulls on the relevant arms) used the
  requested model outright — the chosen model is written as that scope's locked model. Every
  subsequent request in the scope reads the lock and skips sampling entirely.
- **Released**: a lock clears when the proxy detects the locked model has become unservable (for
  example, the provider has decommissioned it and starts returning errors specifically attributable
  to the model choice, not the request). The next request in that scope re-samples fresh, and the
  model the scope was just running on feeds a same-family tie-break preference for the new pick —
  so a released lock still prefers landing back in the same model family where reasonably possible,
  rather than jumping to an unrelated one.

### The limit of what the lock protects

The lock only protects the *model* choice — it says nothing about the rest of the request body.
SOP content is still prepended to the system prompt on every request, which can itself shift the
cached prefix even with the model held constant. The lock keeps you from paying the worst-case
cost (a full model switch) on every turn; it does not guarantee a byte-identical prefix across the
whole scope's life.

## Cache-Honesty Guard

The session lock above protects a scope's *first* routing decision for as long as it holds — but a
lock releases (an unservable pick) or was never engaged (this is the scope's first-ever turn), and
at that moment the bandit is about to Thompson-sample fresh with no special regard for whatever
warmth the requested model may already have. The cache-honesty guard is the layer that closes that
gap: immediately before sampling, it asks whether there is strong, fresh, first-party evidence
that the *requested* model's own prefix for this scope is already warm — and if so, declines to
sample at all, serving the request as asked instead of risking a switch that would discard that
warmth for an unproven arm.

This is entirely **deterministic, local, and open-core-safe** — no LLM call, no control-plane
dependency, the same logic in standalone and managed deployments. It reads only
`SessionRouting.cache_warm_model` / `cache_read_bp` / `cache_observed_at`, populated after every
routed response's real provider usage data — never a guess, always something this specific scope
actually observed on a prior turn.

Three knobs, all on `intutic_settings.routing`, following the same shape as `sop_pin_max_age_secs`:

| Key | Default | Meaning |
|---|---|---|
| `cache_guard_max_age_secs` | `300` | How old an observation may be and still count as fresh — Anthropic's own prompt-cache TTL, not an arbitrary staleness budget. **`0` is the kill switch**: the guard never finds a fresh observation and always falls through to normal sampling. |
| `cache_guard_min_read_bp` | `5000` | The minimum observed cache-read fraction, in basis points, to count as "warm enough" to protect. `5000` = 50% — a coin-flip cache-read rate isn't worth pinning a turn's routing decision over. |
| `cache_guard_cold_start_prompt_bytes` | `20000` | On a scope's very first turn — no observation exists yet — a prompt at or above this size declines to sample once, on the theory that a large first prompt is the shape most likely worth a stable prefix. Fires **at most once per scope, ever**: the moment any real observation exists (even a stale or cold one), evidence permanently supersedes the heuristic. `0` disables just this heuristic, leaving the evidence-based guard itself untouched. |

The guard deliberately does **not** re-engage the session lock when it declines to sample — a
scope is coarse (`{workspace}:{agent}`) with its own 24-hour TTL, and locking on a single guarded
turn would pin routing off for a full day. Leaving it unlocked means the guard re-evaluates fresh
on every turn and resumes sampling the moment the prefix actually goes cold, rather than on a
fixed schedule.

If you need an instant, config-redeploy-free lever instead of the guard's own kill switch, `routing.mode: shadow`
stops enforcement entirely while still recording what the router would have chosen.

**Design principle**: the router is only trustworthy if it prices its own decisions honestly. As of
this guard and the honest-counterfactual pricing fix it depends on, a request that keeps a warm
model warm is priced identically on both sides of the savings calculation — no phantom bonus for
declining to switch — and a request the router *would* switch away from a warm prefix is protected
by a guard whose thresholds are config, not code, and whose kill switch is one value. Every dial
here is visible in `config.yaml`, not buried in a reward formula. One visible consequence: reported
savings read *lower* after this pass than before it, on workspaces that were previously crediting
the router for turns it didn't actually improve. That is the fix working, not a regression — the
old number was never real.

---

## Retries and fallbacks <Badge type="tip" text="Open-Core" />

When a provider is overloaded or rate limited, the proxy retries the call itself, before anything
reaches your agent. When a model's retries run out, it can send the request to fallback targets
you list, in order. Both run in the proxy, locally and deterministically, on every plan. Retries
are on by default; fallbacks are off until you list a target.

### What is retried

- **Statuses** `429`, `500`, `502`, `503`, `504` and `529` (Anthropic's overloaded), plus
  timeouts and failed or reset connections. Other `4xx` answers describe the request itself and
  are passed straight back.
- **Only before a response has started.** The proxy forwards nothing until the provider's
  response head arrives, so a failure before it is retried and a `2xx` head commits the request.
  A stream that breaks after it started, or an `error` event inside a `200` stream, is never
  retried: your agent may already hold part of the answer.
- **Only inference calls**: `POST` to `/v1/messages`, `/v1/chat/completions`, `/v1/responses` and
  Gemini's `generateContent`. These create nothing you can address later, so sending one twice
  costs tokens and changes no state. Anything else the proxy passes through (batches, files,
  cached contents) is sent once.
- **Not a spent quota.** A `429` that reports an exhausted spend limit or quota
  (`enforced_spend_limit_reached`, `insufficient_quota` and similar) does not clear by waiting,
  so it is returned at once and starts no fallback.
- **The provider's verdict wins.** `x-should-retry: false` stops a retry; `true` asks for one.

### How long it waits

Each wait is random between zero and a bound that starts at `initial_backoff_ms` and doubles per
attempt up to `max_backoff_ms` ("full jitter"), so many clients failing together do not retry
together. When the provider says how long to wait — `retry-after-ms`, `retry-after` (seconds or
an HTTP date), or OpenAI's `x-ratelimit-reset-requests` / `-tokens` for the limit that is spent —
the proxy waits exactly that long instead.

`budget_ms` bounds the whole request: every call, wait and fallback. A wait that would outlast it
is not made, and a provider that asks for longer than the budget allows gets its answer, its
`retry-after` included, passed straight back so your agent's own client can wait. A call already
in progress is never cut short by the budget.

### Fallbacks

`routing.fallbacks` lists ordered targets per model. Each key is the model that was sent
upstream, after routing; each target names a `model`, a `provider`, or both:

```yaml
intutic_settings:
  routing:
    fallbacks:
      claude-opus-4-1:
        - model: claude-sonnet-4-5
        - model: deepseek-chat
          provider: deepseek
```

A target that names only a provider sends the same model there. Between Anthropic's API,
[AWS Bedrock](/integrations/aws-bedrock) and [Google Vertex AI](/integrations/google-vertex-ai)
the model id is rewritten into the target's scheme, so one Claude model can fall back across all
three:

```yaml
intutic_settings:
  routing:
    fallbacks:
      claude-sonnet-4-5-20250929:
        - provider: bedrock
        - provider: vertex_ai
```

A fallback runs only after the model's retries are spent on a retryable failure, and each target
gets the same retry policy within the same time budget. With retries turned off
(`retry.enabled: false`), each model gets one call and the fallbacks still run after it fails. A
target is skipped, and the skip recorded, when it:

- cannot take your request as it is: another wire format (a Claude target for a Chat Completions
  request), or the Gemini route, which names the model in its URL;
- is not allowed by the workspace's [approved models](/guide/settings#approved-models) or the
  key's own model list;
- would not fit a spend budget the request passed. The proxy runs the same pre-request check the
  request went through — the key's and workspace's budgets, or a standalone proxy's
  [daily cap](/guide/budgets#local-daily-cap) — priced for the target's model, and skips it with
  `budget` on the trace. A fallback never spends past a cap the request was held to;
- has no credential for its provider. A request made with your own provider key is sent on with
  that key to the same provider only;
- would start after the time budget is spent (`time_budget`).

If every target fails, your agent gets the routed model's own error.

### Session lock and prompt cache

A fallback never moves the [session lock](#session-lock-and-kv-cache-affinity). The next turn
goes back to the locked model and whatever prompt cache it holds, so a short overload costs one
turn on the fallback rather than the rest of the session. The fallback's answer is not written
to the response cache, and its cache usage is not recorded for the session, for the same reason.
When the routed model's prefix was warm and the fallback is a different model family, the trace
says so (`cache_affinity_broken`): that turn paid full price for a prefix the routed model had
cached.

A fallback never answers for the routed model in the bandit either. The routed arm takes the
failure (a `5xx` or a dropped connection; a `429` is the account's limit, not the model's), and
the fallback's response earns it nothing.

### What you see

- **Response headers**: `x-intutic-upstream-attempts` when the answer took more than one call, and
  `x-intutic-upstream-fallback-from` naming the model whose retries ran out when a fallback
  answered. `x-intutic-routed-to` then names the fallback.
- **The trace**: `upstream_attempts` lists every call — model, provider, outcome, latency, the
  wait before the next call and why it stopped — and `upstream_fallback` names the target that
  answered. Both show in the dashboard's trace detail. They are absent on the ordinary request
  that took one call.
- **Metrics**: `upstream_retries` (by provider and the failure that prompted it) and
  `upstream_fallbacks` (served or exhausted). See [OpenTelemetry](/guide/opentelemetry#metrics).

### Per-workspace settings

The workspace setting `upstreamRetry` overrides any of the proxy's values, field by field:

```bash
intutic settings set upstreamRetry '{"maxAttempts": 4, "budgetMs": 45000}'
intutic settings set upstreamRetry --file retry.json   # with fallbacks
intutic settings set upstreamRetry null                # back to each proxy's config
```

Its fallback targets take every provider `config.yaml` does, `bedrock`, `vertex` and `azure` included.
The same setting is under **Settings › AI Routing & Caching › Retries & Fallbacks** in the dashboard and in
Terraform's `intutic_workspace_settings`. The proxy picks a change up on the key's next request.
See [configuration](/reference/configuration#retries-intutic-settings-routing-retry) for every key
and its limit.

---

## Setup & Activation

<!-- ENTERPRISE_ONLY_START -->
### Step 1: Enable Routing in the Dashboard
1. Open the Intutic dashboard (your control-plane console, or the local one at `http://localhost:5174`).
2. Open **Settings** from the sidebar.
3. Click the **AI Routing & Caching** tab, and find the **Smart Model Routing & Response Cache** card.
4. Turn on **Enable Intelligent Model Routing**.

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
