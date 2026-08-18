# OpenAI Agents SDK

Integrate Intutic governance with the [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) (Python).

The SDK is governed on two independent surfaces:

1. **LLM egress** — point the model client's `base_url` at the Intutic proxy (or launch under `intutic exec`).
2. **Local tool execution** — tools run as plain Python callables inside *your* process. No config or hook file can gate them, so the blocking gate ships SDK-side in `intutic-clawde`.

## How it works

The `openai-agents` adapter is detected when `pyproject.toml`, `requirements.txt`, or `uv.lock` declares an `openai-agents` dependency. It writes a `.env.intutic` file with proxy base-URL env vars plus a comment block pointing at the SDK gate.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

### 2. Route LLM traffic through the proxy

Source `.env.intutic`, launch under `intutic exec`, or set `base_url` explicitly — same as [LangGraph](/integrations/langgraph#2-route-llm-traffic-through-the-proxy).

### 3. Gate local tool execution (SDK)

```bash
pip install intutic-clawde[openai-agents]
```

The SDK documents `@tool_input_guardrail` — a guardrail that runs before a tool executes and can reject the call. Attach `intutic_tool_guardrail` to a tool via `function_tool`:

```python
from agents import function_tool
from intutic_clawde.gate import Gate, GateConfig, install
from intutic_clawde.gate.adapters.openai_agents import intutic_tool_guardrail

install(Gate(GateConfig()))

@function_tool(tool_input_guardrails=[intutic_tool_guardrail])
def shell(command: str) -> str:
    ...
```

On deny, the guardrail returns `ToolGuardrailFunctionOutput.reject_content(message)` — the SDK rejects the call and hands `message` (the `[Intutic Governance] BLOCKED: ...` text) back to the model in place of a tool result, rather than running the tool body.

Need a specific `Gate` instance rather than the process-wide one installed via `install()` — e.g. in a test, or a multi-tenant process running more than one gate? Use the factory instead of the module-level guardrail:

```python
from intutic_clawde.gate.adapters.openai_agents import make_intutic_tool_guardrail

my_guardrail = make_intutic_tool_guardrail(gate=my_gate)
```

### 4. Trace attribution

```python
from intutic_clawde.gate import intutic_headers

llm = ChatOpenAI(
    base_url="http://localhost:4000/v1",
    default_headers=intutic_headers(session_id=run_id, harness="openai-agents"),
)
```

## What gets written

Same shape as LangGraph's `.env.intutic` — proxy URLs plus a pointer at `intutic_clawde.gate.adapters.openai_agents.intutic_tool_guardrail`.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do). In short: there is no sync-daemon hook file, argument-level gating requires attaching the guardrail to your own tools, and `x-intutic-harness` attribution is client-supplied, not authorization.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `openai-agents` |
| Config file | `.env.intutic` |
| Detection | `openai-agents` in `pyproject.toml`, `requirements.txt`, or `uv.lock` |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`intutic_clawde.gate.adapters.openai_agents.intutic_tool_guardrail`, a `@tool_input_guardrail`) — no sync-daemon hook file |
