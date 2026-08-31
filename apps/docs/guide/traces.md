# Traces <Badge type="tip" text="Open-Core" />

Traces are the audit trail of every AI agent request that flows through the Intutic proxy. Each trace records what happened, what enforcement action was applied, and how much it cost.

In open-core the proxy writes traces locally as daily-sharded JSONL under `~/.intutic/logs/` (`traces-YYYY-MM-DD.jsonl`, one record per line, capped at 64MB/day). Today, reading them means `cat`/`jq` on those files directly — `intutic traces list` / `intutic traces inspect` require a connected control plane and exit with an error otherwise. A local reader for these commands is in progress. The REST API shown alongside each CLI example below is the connected-mode equivalent, and connected mode is the only way to see a trace's compliance score and enforcement action today.

## What's in a trace?

Each execution trace contains (field names as written to the local JSONL; connected mode camelCases them over the API):

| Field | Description |
|-------|-------------|
| `trace_id` | Unique identifier (`tr_` prefix) |
| `session_id` | The agent session this trace belongs to |
| `created_at` | ISO 8601 timestamp of the request |
| `model` / `provider` | The LLM model and provider used |
| `requested_model` / `actual_model_routed` | The model the caller asked for vs. the one that actually served the request |
| `raw_input_tokens` / `output_tokens` | Token counts |
| `raw_cost_usd` / `actual_cost_usd` | Cost had the requested model served it, vs. the actual cost of the routed model's response |
| `cache_hit` / `cache_read_input_tokens` / `cache_creation_input_tokens` | Provider prompt-cache accounting |
| `latency_ms` | Request latency |
| `verdict` | The proxy's own enforcement verdict — locally, exactly one of `allowed`, `killed`, `upstream_error` |
| `harness_type` | Which coding agent/IDE issued the request |

Two fields you may see referenced elsewhere are **connected-mode only, with no local equivalent**: a compliance/quality **score**, and the four-way `BYPASS`/`ENHANCE`/`HIJACK`/`KILL` enforcement-action vocabulary used by the control plane's PCAS layer. A standalone proxy's own `verdict` field uses a different, narrower vocabulary (above).

## Listing traces

### CLI

```bash
# List last 20 traces (default)
intutic traces list

# Show 50 traces from the last 7 days
intutic traces list --limit 50 --since 7d

# Filter by enforcement action
intutic traces list --action KILL

# Filter by model
intutic traces list --model claude-4-sonnet

# Output as JSON
intutic traces list --json
```

**CLI options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--limit <n>` | Number of traces (1–100) | `20` |
| `--since <duration>` | Time window: `30m`, `24h`, `7d` | `24h` |
| `--action <type>` | Filter: `BYPASS`, `ENHANCE`, `HIJACK`, `KILL` | _(all)_ |
| `--model <name>` | Filter by model name | _(all)_ |
| `--json` | JSON output instead of table | `false` |
| `--dev` | Use local control plane | `false` |

<!-- ENTERPRISE_ONLY_START -->
### API

```bash
# List traces with pagination
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-control-plane.example/api/v1/traces?limit=20&offset=0"

# Filter by enforcement action and time
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-control-plane.example/api/v1/traces?enforcement=KILL&since=2026-06-01T00:00:00Z"

# Filter by model
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-control-plane.example/api/v1/traces?model=gpt-4o"
```

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | number | 1–100, default 20 |
| `offset` | number | Pagination offset, default 0 |
| `since` | ISO 8601 datetime | Only traces after this time |
| `enforcement` | enum | `BYPASS`, `ENHANCE`, `HIJACK`, `KILL` |
| `model` | string | Filter by model name |

<!-- ENTERPRISE_ONLY_END -->
## Inspecting a trace

### CLI

```bash
intutic traces inspect tr_abc123
```

Returns the full trace detail including:
- Token counts and costs
- Compliance scores
- Anomaly data (if any)
- Corrective prompt card (if enforcement was applied)

<!-- ENTERPRISE_ONLY_START -->
### API

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-control-plane.example/api/v1/traces/tr_abc123"
```

**Response:** Full trace object with all fields.

**Status codes:**
- `200` — Trace returned
- `404` — Trace not found
- `500` — Server error

## Classifying token utility

You can retroactively classify traces as USEFUL or WASTED. This feeds the FinOps ledger and the model routing optimizer.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "trace_ids": ["tr_abc123", "tr_def456"],
    "classification": "WASTED",
    "reason": "Agent looped on the same file 5 times"
  }' \
  "https://your-control-plane.example/api/v1/usage/classify"
```

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `trace_ids` | string[] | 1–500 trace IDs to classify |
| `classification` | enum | `USEFUL` or `WASTED` |
| `reason` | string | 1–1000 chars explaining the classification |

<!-- ENTERPRISE_ONLY_END -->
## Understanding enforcement actions

### BYPASS
The request was fully compliant with all active SOPs. No modification needed. This is the ideal state.

### ENHANCE
The request was compliant but could be improved. The proxy enriched the prompt, upgraded the model, or added context. The original intent is preserved.

### HIJACK
The request was rerouted — typically for cost optimization (downgrading an expensive model to an equivalent cheaper one) or capability routing (sending a coding task to a code-specialized model).

### KILL
The request was blocked. Common reasons:
- Budget exceeded for the user's tier
- SOP policy violation detected
- A deterministic anomaly detector fired (loop, forbidden tool, credential sweep, budget breach)
- Unauthorized tool call attempted
