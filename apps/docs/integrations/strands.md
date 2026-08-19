# AWS Strands Agents

Integrate Intutic governance with [Strands Agents](https://strandsagents.com) — AWS's flagship open-source agent framework and the default in Bedrock AgentCore's quickstarts.

Strands is governed on two independent surfaces:

1. **LLM egress** — routable through the Intutic proxy **only for some model providers**; the framework's *default* provider (Bedrock) is not one of them. See the per-provider table below — this is the first framework in the SDK-gated family whose default egress cannot traverse the proxy, and this page says so plainly rather than implying otherwise.
2. **Local tool execution** — Strands tools run as plain decorated callables (or MCP-materialised tools) inside *your* Python process. No config or hook file can gate them, so the blocking gate ships SDK-side in `intutic-clawde`.

## How it works

The `strands` adapter is detected when `pyproject.toml`, `requirements.txt`, or `uv.lock` declares a `strands-agents` dependency (this also matches `strands-agents-tools` and the `bedrock-agentcore` package's `strands-agents` extra — all of which imply the framework is in use). It writes a `.env.intutic` file with proxy base-URL env vars plus a comment block pointing at the SDK gate.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

### 2. Route LLM traffic through the proxy — per-provider honesty

Strands supports multiple model providers, and whether the Intutic proxy can see the traffic depends entirely on which one you construct:

| Provider | Proxy-routable? | How |
|---|---|---|
| **Bedrock** (`BedrockModel` — the DEFAULT when you pass no `model`) | ❌ **No** | Bedrock traffic is SigV4-signed boto3 calls to `bedrock-runtime.<region>.amazonaws.com`. The Intutic proxy does not speak Bedrock's wire protocol and cannot re-sign SigV4 requests — there is no base-URL env var that makes this traffic governable by the proxy. Vector B and the [response gate](/reference/harness-security-matrix#vector-d--response-gate) do **not** apply; the SDK tool gate below is the enforcement point. |
| `AnthropicModel` | ✅ Yes | The Anthropic Python SDK honors `ANTHROPIC_BASE_URL` (written by `.env.intutic`) when no explicit `base_url` is passed, or pass `client_args={"base_url": ...}`. |
| `OpenAIModel` | ✅ Yes | The OpenAI Python SDK honors `OPENAI_BASE_URL` (written by `.env.intutic`), or pass `client_args={"base_url": ...}`. |
| `LiteLLMModel` | ⚠️ Per-model | Set `client_args={"api_base": "<proxy>"}`; whether env-var routing applies depends on the underlying provider LiteLLM dispatches to. |
| Gemini / Mistral / Ollama / Writer / LlamaAPI / SageMaker | ❌ Not via `.env.intutic` | No Intutic-written env var routes these today. Ollama is local egress by definition; SageMaker is SigV4 like Bedrock. |

If you deploy on **Bedrock AgentCore Runtime**, the same per-provider reality applies inside the runtime; a dedicated AgentCore deployment guide is a separate, later documentation phase — this page is scoped to the framework.

### 3. Gate local tool execution (SDK)

```bash
pip install intutic-clawde[strands]
```

Strands has a typed hooks system with a documented pre-tool-call veto: `strands.hooks.BeforeToolCallEvent.cancel_tool` (verified against a real `strands-agents==1.52.0` install — source read, then driven through a full agent loop, not inferred from docs). `IntuticHookProvider` subscribes to that event and cancels denied calls:

```python
from strands import Agent
from intutic_clawde.gate import Gate, GateConfig, install as install_gate
from intutic_clawde.gate.adapters.strands import IntuticHookProvider

install_gate(Gate(GateConfig()))
agent = Agent(model=..., tools=[...], hooks=[IntuticHookProvider()])
```

Or attach to an already-constructed agent:

```python
from intutic_clawde.gate.adapters.strands import install

install(agent)
```

On a deny, the tool body never runs; the model receives an error-status tool result carrying the `[Intutic Governance] BLOCKED: ...` message and the run continues — Strands' own documented cancel contract, not an exception hack.

**Fail-closed posture:** unlike CrewAI's dispatcher (which swallows hook exceptions and *allows* the call), Strands propagates a raising hook and aborts the whole run — confirmed empirically against the real dispatcher. So an unexpected gate error, or a missing `install_gate(...)`, aborts loudly instead of running tools unguarded.

**Registration is per-Agent, not process-global.** Each `Agent` (including every node agent inside a multi-agent `Graph`/`Swarm`) needs the hook passed to it.

### 4. MCP tools

Strands materialises MCP tools as regular agent tools (`MCPAgentTool`), and they dispatch through the **same** `BeforeToolCallEvent` — the gate sees them identically to native tools (verified with a real stdio MCP server in this adapter's test suite). Tool-name and argument-level (`WHERE`) rules apply unchanged.

### 5. Trace attribution

```python
from intutic_clawde.gate import intutic_headers
from strands.models.anthropic import AnthropicModel

model = AnthropicModel(client_args={
    "base_url": "http://localhost:4000",
    "default_headers": intutic_headers(session_id=run_id, harness="strands"),
})
```

(Only meaningful on proxy-routable providers — see the table above.)

## What gets written

Same shape as LangGraph's `.env.intutic` — proxy URLs plus a pointer at `intutic_clawde.gate.adapters.strands.IntuticHookProvider`. Remember: the base-URL vars in that file are inert under the default Bedrock provider.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do) — plus Strands-specific limits:

- **Bedrock/SageMaker egress is ungoverned by the proxy** (see the table above). Tool calls remain fully gated; prompts/responses to those providers are not inspected. See TD-420.
- **Hook ordering:** another hook registered to run after this one could mutate `tool_use` post-approval; Strands offers no "always last" guarantee (the adapter registers late, at order 99, to narrow this). See TD-421.
- The experimental **`BidiAgent`** (bidirectional streaming) fires a different event class this adapter does not subscribe to. See TD-422.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `strands` |
| Config file | `.env.intutic` |
| Detection | `strands-agents` in `pyproject.toml`, `requirements.txt`, or `uv.lock` |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`intutic_clawde.gate.adapters.strands.IntuticHookProvider`, a `BeforeToolCallEvent.cancel_tool` hook) — no sync-daemon hook file |
