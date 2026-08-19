# smolagents

Integrate Intutic governance with [smolagents](https://huggingface.co/docs/smolagents) (`smolagents`, 1.26+) — Hugging Face's code-executing agent framework.

::: warning Read this first — `CodeAgent` gates code TEXT, not tool calls
smolagents ships two agent classes with fundamentally different governance shapes. `ToolCallingAgent` calls discrete, named tools — plain callables, governed by `@guard`/`guard_tools` exactly like every other framework on this site. `CodeAgent` is different in kind: a "tool call" in `CodeAgent` mode is a whole chunk of **model-generated Python source** handed to a `PythonExecutor` and run. There is no discrete tool call to intercept — the executor invocation itself is the only choke point smolagents publishes.

`IntuticPythonExecutor` gates the generated code **string** before it reaches the interpreter — the same `{"command": ...}` shape a shell command gets, so an existing SOP rule authored against `kubectl apply` already applies to a `CodeAgent` shelling out via `subprocess`/`os.system`, with no separate rule needed. What it does **not** see, precisely: control flow that only reaches a dangerous call after some computation the interpreter hasn't executed yet, runtime-constructed strings (`os.system("ku" + "bectl apply " + rest)` never contains the literal substring an `argPattern` matches, even though the executed command does), and tools invoked *by* the running code through `send_tools` — a real, in-process call once the code is already executing, invisible to this text-level pre-execution check the same way an already-running process is invisible to every other pre-exec check in this codebase. This closes real coverage `CodeAgent` had none of before, but it is honestly narrower than the argument-level gating every other adapter on this site does — matched in scope and honesty to `openWebuiHooks.ts`'s `inlet()` filter, which governs prompt text rather than a tool call and says so explicitly in its own doc comment. See [TD-377](#what-the-adapter-does-not-do) below.
:::

## How it works

The `smolagents` adapter is detected when `pyproject.toml`, `requirements.txt`, or `uv.lock` declares a `smolagents` dependency. Like LangGraph, it writes a `.env.intutic` file with proxy base-URL env vars plus a comment block pointing at the SDK gate.

smolagents is governed on two independent surfaces:

1. **LLM egress** — point the model client's `base_url` at the Intutic proxy (or launch under `intutic exec`).
2. **Local tool/code execution** — split by agent class, per the warning above: `guard_tools`/`@guard` for `ToolCallingAgent`'s discrete tools, `IntuticPythonExecutor` for `CodeAgent`'s generated code.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

### 2. Route LLM traffic through the proxy

Source `.env.intutic`, launch under `intutic exec`, or set `base_url` explicitly on your model client — same as [LangGraph](/integrations/langgraph#2-route-llm-traffic-through-the-proxy).

### 3. Gate local execution (SDK) — pick the mechanism for your agent class

```bash
pip install intutic-clawde[smolagents]
```

**`ToolCallingAgent`** — tools are plain callables, wrapped the same way as every other framework:

```python
from intutic_clawde.gate import Gate, GateConfig, install, guard_tools

install(Gate(GateConfig()))

tools = guard_tools([shell_tool, write_file_tool, deploy_tool])
agent = ToolCallingAgent(tools=tools, model=model)
```

`guard_tools` was extended specifically for smolagents: a smolagents `Tool` object is `callable` on its own `__call__`, so without duck-typing `.forward` too, `guard_tools` would silently replace it with a bare wrapper function and lose the `.name`/`.inputs` schema `ToolCallingAgent` needs to show the model. This is already handled — no extra step required.

**`CodeAgent`** — wrap the executor, not any individual tool:

```python
from smolagents import CodeAgent, LocalPythonExecutor
from intutic_clawde.gate.adapters.smolagents import IntuticPythonExecutor

agent = CodeAgent(
    tools=[...], model=model,
    executor=IntuticPythonExecutor(LocalPythonExecutor(additional_authorized_imports=[])),
)
```

`send_tools`/`send_variables` pass through untouched. On each step, `__call__` evaluates the gate against `{"command": code_action}` **before** delegating to the wrapped executor. On deny it raises `smolagents.local_python_executor.InterpreterError` — smolagents' own "this code should not run" exception (the same one syntax errors and disallowed imports raise) — carrying the `[Intutic Governance] BLOCKED: ...` message. `CodeAgent._step_stream` catches this the same way it catches any other step failure: the error is fed back to the model, and the run is not crashed. This was driven live against `smolagents==1.26.0`, not just read from source.

**Optional: `intutic_step_callback`.** Gate enforcement and the audit trail (`tool_blocked`/`tool_allowed` hook events) already happen unconditionally inside `IntuticPythonExecutor.__call__` — this callback is not required for either. It bridges into smolagents' own `step_callbacks` lifecycle (fires once per `ActionStep`, after the step completes) for building an observer around that lifecycle instead of around `Gate` directly:

```python
agent = CodeAgent(
    ..., executor=IntuticPythonExecutor(...),
    step_callbacks=[intutic_step_callback],
)
```

It recognizes a block by the `[Intutic Governance] BLOCKED:` prefix in `step.error`, not by re-evaluating the gate — it logs via the standard `logging` module and deliberately does not call the control-plane client a second time, to avoid turning one real incident into two hook-events records.

### 4. Trace attribution

```python
from intutic_clawde.gate import intutic_headers

llm = ChatOpenAI(
    base_url="http://localhost:4000/v1",
    default_headers=intutic_headers(session_id=run_id, harness="smolagents"),
)
```

## What gets written

Same shape as LangGraph's `.env.intutic` — proxy URLs plus a pointer at `intutic_clawde.gate.adapters.smolagents.IntuticPythonExecutor`.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do) — plus the `CodeAgent`-specific boundary from the warning above, tracked as **TD-377** and treated as an inherent property of gating generated code text, not a defect scheduled for a fix:

- **Runtime-constructed strings evade `argPattern` matching.** A rule authored against a literal substring (e.g. `kubectl apply`) does not match code that assembles the same command at runtime via string concatenation, even though the executed result is identical.
- **Conditional reach is not evaluated.** A rule evaluates against the code as submitted; code whose dangerous branch is behind a condition the interpreter has not yet reached is judged the same as code that always takes that branch.
- **Tools invoked by the executing code via `send_tools` are invisible to this check.** smolagents lets generated code call tools passed to `send_tools` — a real, in-process call once the code is already running. `IntuticPythonExecutor` only sees the code text before execution starts, the same way any pre-exec check in this codebase cannot see into an already-running process.
- **No finer-grained veto point exists to target instead.** Closing this gap would require smolagents publishing a per-statement or per-call hook inside `LocalPythonExecutor` itself; nothing like that exists at `smolagents==1.26.0`. Until it does, code-text-level gating is the only coverage `CodeAgent` has — which is still strictly more than the zero coverage it had before this adapter existed.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `smolagents` |
| Config file | `.env.intutic` |
| Detection | `smolagents` in `pyproject.toml`, `requirements.txt`, or `uv.lock` |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side, split by agent class: `guard_tools`/`@guard` for `ToolCallingAgent`'s discrete tools; `intutic_clawde.gate.adapters.smolagents.IntuticPythonExecutor` (a `PythonExecutor.__call__` wrapper raising `InterpreterError`) for `CodeAgent`'s generated code text — see TD-377 for what code-text-level gating does not cover; no sync-daemon hook file |
