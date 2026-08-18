# CrewAI

Integrate Intutic governance with [CrewAI](https://www.crewai.com/) multi-agent crews.

CrewAI is governed on two independent surfaces:

1. **LLM egress** — point the model client's `base_url` at the Intutic proxy (or launch under `intutic exec`).
2. **Local tool execution** — CrewAI tools run as plain callables/`CrewStructuredTool` instances inside *your* process. No config or hook file can gate them, so the blocking gate ships SDK-side in `intutic-clawde`.

## How it works

The `crewai` adapter is detected when `pyproject.toml`, `requirements.txt`, or `uv.lock` declares a `crewai` dependency. It writes a `.env.intutic` file with proxy base-URL env vars plus a comment block pointing at the SDK gate.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

### 2. Route LLM traffic through the proxy

Source `.env.intutic`, launch under `intutic exec`, or set `base_url` explicitly on your LLM client — same as [LangGraph](/integrations/langgraph#2-route-llm-traffic-through-the-proxy).

### 3. Gate local tool execution (SDK)

```bash
pip install intutic-clawde[crewai]
```

CrewAI (v1.15.3+) exposes a global `before_tool_call` hook registry. `install()` registers a hook built on `Gate.guard()`:

```python
from intutic_clawde.gate import Gate, GateConfig, install as install_gate
from intutic_clawde.gate.adapters.crewai import install as install_crewai_gate

install_gate(Gate(GateConfig()))
install_crewai_gate()  # call once, at process start — before running any Crew
```

CrewAI's own documented veto contract: a `before_tool_call` hook returns `False` to block a call, `True`/`None` to allow it. `install()`'s hook returns `False` whenever `Gate.guard()` raises `IntuticGateRefusal` — and, deliberately, on **any other exception too**. CrewAI's dispatcher swallows any hook exception that is not its own internal abort signal and treats the call as allowed; this adapter cannot rely on CrewAI to fail closed on its behalf, so an unexpected error (a misconfigured gate, a bug) also blocks rather than silently passing through ungoverned.

### 4. Trace attribution

```python
from intutic_clawde.gate import intutic_headers

llm = ChatOpenAI(
    base_url="http://localhost:4000/v1",
    default_headers=intutic_headers(session_id=run_id, harness="crewai"),
)
```

## What gets written

Same shape as LangGraph's `.env.intutic` — proxy URLs plus a pointer at `intutic_clawde.gate.adapters.crewai.install`.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do). In short: there is no sync-daemon hook file, argument-level gating requires calling `install()` in your own agent code, and `x-intutic-harness` attribution is client-supplied, not authorization.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `crewai` |
| Config file | `.env.intutic` |
| Detection | `crewai` in `pyproject.toml`, `requirements.txt`, or `uv.lock` |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`intutic_clawde.gate.adapters.crewai.install`, a `before_tool_call` hook) — no sync-daemon hook file |
