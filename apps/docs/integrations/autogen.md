# AutoGen

Integrate Intutic governance with [Microsoft AutoGen](https://microsoft.github.io/autogen/) (`autogen-core`/`autogen-agentchat`/`autogen-ext`, 0.4+) — Microsoft's multi-agent conversation framework.

::: warning Read this before wiring the SDK gate in — it does not see the tool calls most AutoGen code makes
`IntuticInterventionHandler` hooks `autogen_core.InterventionHandler.on_send` — the only confirmed veto point AutoGen publishes for a `FunctionCall` message. It is real, and it was driven end to end against a real `SingleThreadedAgentRuntime` (registering the handler, sending a `FunctionCall` through `runtime.send_message`, and observing the runtime's own `MessageDroppedException` on a block). But `on_send` only fires for messages explicitly routed through `runtime.send_message`/`publish_message` — and **`AssistantAgent`, the class essentially every AutoGen application and tutorial is built on, never calls that.** Its `_execute_tool_call` dispatches directly to `workbench.call_tool_stream(...)`/`handoff_tool.run_json(...)`, entirely in-process, bypassing the `AgentRuntime` message-passing this handler intercepts.

Practically: if your application uses plain `AssistantAgent` (or a `Swarm`/`ChatAgent` team pattern built on it) with a `Workbench` or a plain tool list — the tutorial-default usage pattern — `IntuticInterventionHandler` sees **nothing**. Every tool call that agent makes is invisible to it. See [TD-374](#what-the-adapter-does-not-do) below for the tracked gap, and the mitigation this page leads with in Setup step 3.
:::

## How it works

The `autogen` adapter is detected when `pyproject.toml`, `requirements.txt`, or `uv.lock` declares `autogen-agentchat`, `autogen-core`, or `autogen-ext` — any one present is treated as "AutoGen is here." Like LangGraph, it writes a `.env.intutic` file with proxy base-URL env vars plus a comment block pointing at the SDK gate.

AutoGen is governed on two independent surfaces:

1. **LLM egress** — point the model client's `base_url` at the Intutic proxy (or launch under `intutic exec`).
2. **Local tool execution** — split across two mechanisms depending on which part of AutoGen your code actually exercises (see the warning above): `IntuticInterventionHandler` for messages explicitly routed through `AgentRuntime.send_message`/`publish_message`, and the framework-agnostic `@guard`/`guard_tools` helpers for everything `AssistantAgent` runs itself.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

### 2. Route LLM traffic through the proxy

Source `.env.intutic`, launch under `intutic exec`, or set `base_url` explicitly on your LLM client — same as [LangGraph](/integrations/langgraph#2-route-llm-traffic-through-the-proxy).

### 3. Gate local tool execution (SDK) — pick the mechanism that matches your code

```bash
pip install intutic-clawde[autogen]
```

**If your code is `AssistantAgent`-based (the common case):** `IntuticInterventionHandler` will not see these tool calls at all. Wrap the tool objects themselves before handing them to the agent, using the same framework-agnostic helper CrewAI/LangGraph tools were already documented as covered by:

```python
from intutic_clawde.gate import Gate, GateConfig, install, guard_tools

install(Gate(GateConfig()))

tools = guard_tools([shell_tool, write_file_tool, deploy_tool])
agent = AssistantAgent("assistant", model_client=model_client, tools=tools)
```

**If your code is a custom multi-agent system built directly on `AgentRuntime`/`RoutedAgent`**, dispatching `FunctionCall` messages between agents explicitly (the lower-level, core-API pattern — real, and the one case this handler actually covers), register `IntuticInterventionHandler`:

```python
from autogen_core import SingleThreadedAgentRuntime
from intutic_clawde.gate import Gate, GateConfig, install
from intutic_clawde.gate.adapters.autogen import IntuticInterventionHandler

install(Gate(GateConfig()))
runtime = SingleThreadedAgentRuntime(intervention_handlers=[IntuticInterventionHandler()])
```

On a deny, `on_send` returns AutoGen's own `DropMessage` sentinel; the runtime turns that into a `MessageDroppedException` raised back to the sender's `await runtime.send_message(...)` call — the message never reaches its recipient, and the tool body never runs. Non-`FunctionCall` messages pass through unchanged.

Most real applications need **both**: `guard_tools` for the `AssistantAgent` tools you construct, and `IntuticInterventionHandler` only if some part of your system also dispatches runtime-routed `FunctionCall` messages by hand.

### 4. Trace attribution

```python
from intutic_clawde.gate import intutic_headers

llm = ChatOpenAI(
    base_url="http://localhost:4000/v1",
    default_headers=intutic_headers(session_id=run_id, harness="autogen"),
)
```

## What gets written

Same shape as LangGraph's `.env.intutic` — proxy URLs plus a pointer at `intutic_clawde.gate.adapters.autogen.IntuticInterventionHandler`.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do) — plus AutoGen-specific limits:

- **`AssistantAgent`'s own tool calls never reach `IntuticInterventionHandler`.** Confirmed by reading `autogen_agentchat.agents._assistant_agent` directly, not by inference: `_execute_tool_call` dispatches to `workbench.call_tool_stream(...)`/`handoff_tool.run_json(...)` in-process, bypassing `AgentRuntime` message-passing entirely. This is wider than "the reflection path is uncovered" — it is the entire `AssistantAgent` tool-execution path. Mitigation: wrap the tool objects with `guard_tools`/`@guard` before constructing the `Workbench`/tool list, as shown in Setup step 3. See TD-374.
- **`ToolException` does not exist.** An earlier plan for this adapter proposed raising `autogen_core.ToolException(call_id=...)` as an alternative veto; that class was checked against a real `autogen-core==0.7.5` install and does not exist at this version (`autogen_core.exceptions` exports only `CantHandleException`, `MessageDroppedException`, `NotAccessibleError`, `UndeliverableException`). `DropMessage` is the only confirmed veto point.
- **Microsoft's "Agent Framework" convergence is a watch item, not something this adapter targets.** Microsoft has publicly discussed consolidating AutoGen and Semantic Kernel into a successor framework; no concrete, installable, stable release existed at the time this adapter was built, so it has not been evaluated and is not covered by anything on this page. See TD-375.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `autogen` |
| Config file | `.env.intutic` |
| Detection | `autogen-agentchat`, `autogen-core`, or `autogen-ext` in `pyproject.toml`, `requirements.txt`, or `uv.lock` |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`intutic_clawde.gate.adapters.autogen.IntuticInterventionHandler`, an `InterventionHandler.on_send` veto) — covers only runtime-routed `FunctionCall` messages, **not** `AssistantAgent`'s own tool calls (use `guard_tools`/`@guard` for those); no sync-daemon hook file |
