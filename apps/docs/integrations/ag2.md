# AG2

Integrate Intutic governance with [AG2](https://ag2.ai/) (`ag2`, 1.0+) — a fork/continuation of pre-Microsoft AutoGen with its own, from-scratch architecture.

## AG2 vs AutoGen — which page do I want?

AG2 and [AutoGen](/integrations/autogen) are **not the same framework**, even though AG2 started life as a fork of the original (pre-Microsoft) AutoGen project and older tutorials/blog posts sometimes still describe it in `ConversableAgent`/`GroupChat` terms. That framing is stale: the `ag2` package on PyPI (`ag2==1.0.2`, installed live to write this adapter) no longer imports as `autogen` at all and shares no API surface with the `ConversableAgent`/`GroupChat` shape most AG2/pyautogen tutorials still describe. It is a from-scratch architecture built around typed `Event`s flowing through a `Stream`, agents (`ag2.Agent`) driven by a `Context`, and a `BaseMiddleware` chain intercepting `on_turn`/`on_llm_call`/`on_tool_execution`/`on_human_input`.

If your project imports `autogen_core`/`autogen_agentchat`/`autogen_ext` (Microsoft's actively-maintained framework, post-fork), you want the [AutoGen page](/integrations/autogen) instead — its hook surface (`InterventionHandler.on_send`) and its coverage gap (`AssistantAgent`'s own tool calls bypass it entirely) are unrelated to AG2's. This page covers `ag2`'s own, distinct `BaseMiddleware.on_tool_execution` hook.

## How it works

The `ag2` adapter is detected when `pyproject.toml`, `requirements.txt`, or `uv.lock` declares an `ag2` dependency — a boundary-aware regex is used rather than a plain substring test, since "ag2" is short enough to false-positive inside "flag2" or a version string. Like LangGraph, it writes a `.env.intutic` file with proxy base-URL env vars plus a comment block pointing at the SDK gate.

AG2 is governed on two independent surfaces:

1. **LLM egress** — point the model client's `base_url` at the Intutic proxy (or launch under `intutic exec`).
2. **Local tool execution** — AG2's own `BaseMiddleware.on_tool_execution` hook, confirmed by reading `ag2/middleware/base.py`, `ag2/tools/executor.py`, and `ag2/tools/final/function_tool.py` directly against a real `ag2==1.0.2` install.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

### 2. Route LLM traffic through the proxy

Source `.env.intutic`, launch under `intutic exec`, or set `base_url` explicitly on your LLM client — same as [LangGraph](/integrations/langgraph#2-route-llm-traffic-through-the-proxy).

### 3. Gate local tool execution (SDK)

```bash
pip install intutic-clawde[ag2]
```

`BaseMiddleware.on_tool_execution(self, call_next, event, context)` is AG2's own documented veto point — the base implementation is the identity middleware (`return await call_next(event, context)`), and `FunctionTool.register` folds every entry in `middleware=[...]` right-to-left over that chain. `IntuticMiddleware` overrides it:

```python
from ag2 import Agent
from intutic_clawde.gate import Gate, GateConfig, install
from intutic_clawde.gate.adapters.ag2 import IntuticMiddleware

install(Gate(GateConfig()))
agent = Agent("my-agent", middleware=[IntuticMiddleware])
```

Pass the **class**, not an instance — AG2 constructs one per turn via `IntuticMiddleware(event, context)`, matching `MiddlewareFactory`'s documented `Protocol.__call__(self, event, context) -> BaseMiddleware` shape. For an explicit `Gate` (tests, multi-gate processes), use `make_intutic_middleware(gate=...)` instead:

```python
from intutic_clawde.gate.adapters.ag2 import make_intutic_middleware

agent = Agent("my-agent", middleware=[make_intutic_middleware(gate=my_gate)])
```

On a deny, `on_tool_execution` returns `ToolErrorEvent.from_call(event, exc)` — AG2's own constructor for "this tool call failed" — **without calling `call_next`**, so the tool body never runs.

### 4. Trace attribution

```python
from intutic_clawde.gate import intutic_headers

llm = ChatOpenAI(
    base_url="http://localhost:4000/v1",
    default_headers=intutic_headers(session_id=run_id, harness="ag2"),
)
```

## What gets written

Same shape as LangGraph's `.env.intutic` — proxy URLs plus a pointer at `intutic_clawde.gate.adapters.ag2.IntuticMiddleware`.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do) — plus one AG2-specific open question:

- **Exception-propagation behavior inside `on_tool_execution` was not verified live.** `IntuticMiddleware.on_tool_execution` converts *every* exception raised while evaluating the gate (not only `IntuticGateRefusal`) into a returned `ToolErrorEvent`, matching the "fail closed on principle" posture `crewai.py` uses — but for CrewAI that posture was proven *necessary*: a real `crewai==1.15.16` install was driven and its dispatcher confirmed to swallow any non-`HookAborted` hook exception and report the call as **allowed**. For AG2, only the mechanism's shape was confirmed live (installing `ag2==1.0.2`, reading the middleware/executor source directly, and driving `on_tool_execution` directly with a real `ToolCallEvent`) — not what AG2's own event/stream dispatcher does with an exception that escapes `on_tool_execution` itself, since that would require a full multi-turn `Agent.run()`/`ask()` driven by a real or stub LLM, which this integration did not build for AG2 (unlike [Pydantic AI](/integrations/pydantic-ai), where `FunctionModel` made that straightforward). The defensive catch-all is therefore a precaution carried over from the CrewAI precedent, not a confirmed-necessary one for AG2 — and it is not known to be harmless-but-unnecessary either. See TD-376.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `ag2` |
| Config file | `.env.intutic` |
| Detection | `ag2` (boundary-aware match — not a plain substring, to avoid false positives like "flag2") in `pyproject.toml`, `requirements.txt`, or `uv.lock` |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`intutic_clawde.gate.adapters.ag2.IntuticMiddleware`, a `BaseMiddleware.on_tool_execution` veto) — fail-closed posture on gate errors is a precaution, not confirmed necessary (TD-376); no sync-daemon hook file |
