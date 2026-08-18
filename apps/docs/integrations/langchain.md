# LangChain

Integrate Intutic governance with [LangChain](https://www.langchain.com/) v1.x agents.

LangChain is governed on two independent surfaces:

1. **LLM egress** — point the model client's `base_url` at the Intutic proxy (or launch under `intutic exec`). Every LLM call crosses the proxy and is governed like any other harness.
2. **Local tool execution** — LangChain tools run as plain Python callables/objects inside *your* process. No config or hook file can gate them, so the blocking gate ships SDK-side in `intutic-clawde`.

## How it works

The `langchain` adapter is detected when `pyproject.toml`, `requirements.txt`, or `uv.lock` declares a `langchain`/`langchain-core` dependency. Like LangGraph, it writes a `.env.intutic` file with proxy base-URL env vars plus a comment block pointing at the SDK gate.

Detection also covers LangChain.js (the `langchain` npm package) for reporting purposes — but this adapter's env-writer is Python-only, matching the `intutic_clawde.gate.adapters.langchain` gate it points at. A JS/TS tool-call gate for LangChain.js is tracked separately.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • langchain → .env.intutic
```

### 2. Route LLM traffic through the proxy

Source the generated env file, launch under `intutic exec`, or set `base_url` explicitly — same as [LangGraph](/integrations/langgraph#2-route-llm-traffic-through-the-proxy).

### 3. Gate local tool execution (SDK)

```bash
pip install intutic-clawde[langchain]
```

LangChain v1.x exposes a documented middleware veto point — `AgentMiddleware.wrap_tool_call(request, handler)` — which `IntuticMiddleware` implements:

```python
from langchain.agents import create_agent
from intutic_clawde.gate import Gate, GateConfig, install
from intutic_clawde.gate.adapters.langchain import IntuticMiddleware

install(Gate(GateConfig()))

agent = create_agent(model, tools, middleware=[IntuticMiddleware()])
```

On deny, `IntuticMiddleware` returns a `ToolMessage(status="error")` carrying the `[Intutic Governance] BLOCKED: ...` message **without calling the handler** — the tool body never runs.

**Pre-1.0 LangChain, or plain tool objects:** use the framework-agnostic `guard_tools(tools)` helper instead — it already duck-types `.func`/`._run` on LangChain tool objects without importing langchain, and needs no LangChain-version-specific code:

```python
from intutic_clawde.gate import guard_tools

tools = guard_tools([shell_tool, write_file_tool, deploy_tool])
```

Both paths funnel into the same `Gate.guard(tool_name, tool_input)` decision — the same four-tier evaluation (policy snapshot, SOP rules, image integrity, control-plane hook-gate) documented on the [LangGraph](/integrations/langgraph#3-gate-local-tool-execution-sdk) page.

### 4. Trace attribution

```python
from intutic_clawde.gate import intutic_headers

llm = ChatOpenAI(
    base_url="http://localhost:4000/v1",
    default_headers=intutic_headers(session_id=run_id, harness="langchain"),
)
```

## What gets written

Same shape as LangGraph's `.env.intutic` — proxy URLs plus a pointer at `intutic_clawde.gate.adapters.langchain.IntuticMiddleware`.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do). In short: there is no sync-daemon hook file, argument-level gating requires wiring the SDK into your own agent code, and `x-intutic-harness` attribution is client-supplied, not authorization.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `langchain` |
| Config file | `.env.intutic` |
| Detection | `langchain`/`langchain-core` in `pyproject.toml`, `requirements.txt`, or `uv.lock` (Python); `langchain` in `package.json` (JS/TS, detection-only) |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`intutic_clawde.gate.adapters.langchain.IntuticMiddleware`, LangChain v1.x `wrap_tool_call`) — no sync-daemon hook file |
