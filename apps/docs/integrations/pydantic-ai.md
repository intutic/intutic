# Pydantic AI

Integrate Intutic governance with [Pydantic AI](https://ai.pydantic.dev/) (`pydantic-ai`/`pydantic-ai-slim`, 2.31+) — Pydantic's typed agent framework.

Pydantic AI is governed on two independent surfaces:

1. **LLM egress** — point the model client's `base_url` at the Intutic proxy (or launch under `intutic exec`).
2. **Local tool execution** — Pydantic AI tools run inside toolsets attached to your `Agent`. No config or hook file can gate them, so the blocking gate ships SDK-side in `intutic-clawde`, using a veto point the SDK itself documents for exactly this purpose.

## How it works

The `pydantic-ai` adapter is detected when `pyproject.toml`, `requirements.txt`, or `uv.lock` declares `pydantic-ai` or `pydantic-ai-slim` (the substring match covers both package names). Like LangGraph, it writes a `.env.intutic` file with proxy base-URL env vars plus a comment block pointing at the SDK gate.

Pydantic AI documents `WrapperToolset` — an `AbstractToolset` subclass whose whole job is delegating to a wrapped toolset, built for exactly this "intercept before delegating" shape. `IntuticWrapperToolset` subclasses it and overrides `call_tool` to gate before delegating to `super().call_tool(...)`.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

### 2. Route LLM traffic through the proxy

Source `.env.intutic`, launch under `intutic exec`, or set `base_url` explicitly on your model client — same as [LangGraph](/integrations/langgraph#2-route-llm-traffic-through-the-proxy).

### 3. Gate local tool execution (SDK)

```bash
pip install intutic-clawde[pydantic-ai]
```

The simplest path wraps every toolset already attached to an `Agent` in one call:

```python
from pydantic_ai import Agent
from intutic_clawde.gate import Gate, GateConfig, install
from intutic_clawde.gate.adapters.pydantic_ai import guard_agent

install(Gate(GateConfig()))

agent = Agent(model, tools=[...], toolsets=[my_toolset])
guard_agent(agent)  # mutates in place; also returns agent
```

Or wrap a single toolset explicitly:

```python
from intutic_clawde.gate.adapters.pydantic_ai import IntuticWrapperToolset

agent = Agent(model, toolsets=[IntuticWrapperToolset(wrapped=my_toolset)])
```

On a deny, `call_tool` raises `ModelRetry(str(exc))` — confirmed by reading `pydantic_ai/tool_manager.py`: `ToolManager._raw_execute` calls `toolset.call_tool(...)` directly, and any `ModelRetry` it raises is caught two frames up in `ToolManager.execute` and converted into a `RetryPromptPart`. The model sees the refusal message in place of a tool result, and `super().call_tool` — the tool body — never runs.

**Why `ModelRetry` and not `ApprovalRequired`:** Pydantic AI also documents `AbstractToolset.approval_required(...)`/raising `pydantic_ai.exceptions.ApprovalRequired` as a veto-adjacent mechanism. This adapter does not use it — `ApprovalRequired` is Pydantic AI's human-in-the-loop primitive; raising it **defers** the call (surfaced via `DeferredToolRequests`, expecting a human or an external system to resume the run with a decision) rather than denying it. An unattended governed run has nobody to answer that deferral, so treating a gate block as "approval required" would either hang the run or, depending on the caller's deferred-tool handling, let the call through by default. `ModelRetry` is an immediate, non-deferred refusal — the correct match for `Gate.guard()`'s contract.

### 4. Trace attribution

```python
from intutic_clawde.gate import intutic_headers

llm = ChatOpenAI(
    base_url="http://localhost:4000/v1",
    default_headers=intutic_headers(session_id=run_id, harness="pydantic-ai"),
)
```

## What gets written

Same shape as LangGraph's `.env.intutic` — proxy URLs plus a pointer at `intutic_clawde.gate.adapters.pydantic_ai.guard_agent`.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do) — plus Pydantic-AI-specific limits:

- **`guard_agent` does not cover `@agent.tool`-registered functions.** It wraps `agent._user_toolsets` (explicit `Agent(toolsets=[...])` entries) and `agent._dynamic_toolsets`, but deliberately leaves `agent._function_toolset` — the toolset backing `@agent.tool`/`Agent(tools=[...])` — untouched. Those are plain functions under the hood; wrap them with `@guard` (from `intutic_clawde.gate.framework`) before registering, or build an explicit `FunctionToolset(tools=guard_tools([...]))` and pass it via `Agent(toolsets=[...])` so `guard_agent` covers it uniformly with everything else. Reaching into `_function_toolset` directly would break `@agent.tool`'s own registration bookkeeping if a caller adds more tools after calling `guard_agent`.
- **`guard_agent` reaches into private attributes.** `_user_toolsets`/`_dynamic_toolsets` are private (confirmed present at `pydantic-ai-slim==2.31.1` by reading `pydantic_ai/agent/__init__.py`); `Agent.toolsets` is a read-only computed property rebuilt from those two lists on every access, so there is no public replacement point on an already-constructed `Agent`. This is an accepted, documented fragility: a future pydantic-ai release could rename these attributes and silently turn `guard_agent` into a no-op — it would not raise, which is the whole risk of a private-attribute reach-in.
- **Already-wrapped toolsets are left alone.** Calling `guard_agent` twice does not double-wrap an already-`IntuticWrapperToolset`-wrapped entry.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `pydantic-ai` |
| Config file | `.env.intutic` |
| Detection | `pydantic-ai` (matches `pydantic-ai` and `pydantic-ai-slim`) in `pyproject.toml`, `requirements.txt`, or `uv.lock` |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`intutic_clawde.gate.adapters.pydantic_ai.IntuticWrapperToolset`/`guard_agent`, a `WrapperToolset.call_tool` override raising `ModelRetry`) — covers `Agent(toolsets=[...])` entries only, not `@agent.tool`-registered functions; no sync-daemon hook file |
