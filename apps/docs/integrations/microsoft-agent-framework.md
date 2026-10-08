# Microsoft Agent Framework

Integrate Intutic governance with [Microsoft Agent Framework](https://github.com/microsoft/agent-framework), Microsoft's successor to AutoGen and Semantic Kernel (`agent-framework` / `agent-framework-core` on PyPI, imported as `agent_framework`).

Agent Framework is a **different framework** from [AutoGen](/integrations/autogen), not a new version of it. It has its own API and its own tool-call veto point, so it has its own adapter.

Agent Framework is governed on two independent surfaces:

1. **LLM egress** goes through the Intutic proxy when you use the OpenAI or Anthropic chat clients. See the provider table below.
2. **Local tool execution**: Agent Framework tools (`@tool` functions and MCP tools) run inside *your* Python process. No config or hook file can gate them, so the blocking gate ships SDK-side in `intutic-clawde`.

## How it works

The `agent-framework` adapter is detected when `pyproject.toml`, `requirements.txt`, or `uv.lock` declares an `agent-framework` dependency (`agent-framework`, `agent-framework-core`, or any `agent-framework-*` provider package, spelled with `-` or `_`). It writes a `.env.intutic` file with proxy base-URL env vars plus a comment block pointing at the SDK gate.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

### 2. Route LLM traffic through the proxy

Whether the proxy sees model traffic depends on which chat client you build the agent with:

| Chat client | Proxy-routable? | How |
|---|---|---|
| `OpenAIChatClient` (`agent-framework-openai`) | ✅ Yes | Reads `OPENAI_BASE_URL` (written by `.env.intutic`) when no `base_url` is passed. |
| `AnthropicClient` (`agent-framework-anthropic`) | ✅ Yes | Reads `ANTHROPIC_BASE_URL` (written by `.env.intutic`) when no `base_url` is passed. |
| Azure OpenAI / Foundry clients | ❌ Not via `.env.intutic` | They read their own endpoint settings (`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_BASE_URL`, Foundry project endpoints). Intutic does not write those. Pass the proxy URL as `base_url` yourself if your deployment allows it. |
| Other providers (Bedrock, Gemini, Ollama, ...) | ❌ Not via `.env.intutic` | No Intutic-written env var routes these. |

The env-var behaviour of the OpenAI and Anthropic clients comes from their constructor source (`agent-framework-openai==1.15.0`, `agent-framework-anthropic==1.0.0b261002`). It was not exercised against a live model.

### 3. Gate local tool execution (SDK)

```bash
pip install "intutic-clawde[agent-framework]"
```

The extra installs `agent-framework-core` only. Install your chat client's package (`agent-framework-openai`, `agent-framework-anthropic`, ...) or the full `agent-framework` meta-package alongside it.

Agent Framework runs every automatic tool call through a function-middleware chain. `IntuticFunctionMiddleware` is a `FunctionMiddleware` that asks the gate before calling `call_next()`:

```python
from agent_framework import Agent
from intutic_clawde.gate import Gate, GateClient, GateConfig, install as install_gate
from intutic_clawde.gate.adapters.agent_framework import IntuticFunctionMiddleware

# The client reads INTUTIC_API_KEY / INTUTIC_WORKSPACE_ID, or the credentials
# `intutic login` saved. Without it the gate still enforces the local policy
# snapshot, but skips your SOP rules, the control-plane check and audit events.
client = GateClient.from_env(session_id=run_id, harness="agent-framework")
install_gate(Gate(GateConfig(workspace_id=client.workspace_id), client=client))
agent = Agent(client=..., tools=[...], middleware=[IntuticFunctionMiddleware()])
```

Or attach it to an agent you already built:

```python
from intutic_clawde.gate.adapters.agent_framework import install

install(agent)
```

**On a deny**, the middleware never calls `call_next()`, so the tool body never runs. It sets `context.result` to the `[Intutic Governance] BLOCKED: ...` message. The model receives that message as the tool's result, and the run continues so the model can respond to the refusal.

Agent Framework offers other ways to stop a call. They were tested against a real `Agent` (`agent-framework-core==1.20.0`, stub chat client) and rejected:

- `MiddlewareTermination` ends the function-calling loop at once. The model is never called again, so it never sees the refusal.
- An ordinary exception is turned into a generic `Error: Function failed.` tool result. The tool does not run, but the model never sees the reason.

**Fail-closed posture:** if the gate itself errors, or no gate is installed, the middleware raises `MiddlewareFailure`. That is the framework's own signal for enforcement layers. Agent Framework does not turn it into a tool result. It cancels the rest of the tool batch and raises it out of `Agent.run()`, so the run stops loudly instead of running tools unguarded.

**Registration is per agent.** Every `Agent` needs the middleware, including each agent inside a multi-agent workflow.

### 4. MCP tools

Agent Framework turns MCP tools into ordinary `FunctionTool`s, so they pass through the same function middleware and the same gate as native tools. This was confirmed by reading the source (`agent_framework/_mcp.py`). The test suite does not drive a live MCP server.

### 5. Trace attribution

```python
from intutic_clawde.gate import intutic_headers
from agent_framework.openai import OpenAIChatClient

client = OpenAIChatClient(
    base_url="http://localhost:4000/v1",  # the OpenAI client appends /chat/completions
    default_headers=intutic_headers(session_id=run_id, harness="agent-framework"),
)
```

## What gets written

The same `.env.intutic` shape as LangGraph: proxy URLs plus a pointer at `intutic_clawde.gate.adapters.agent_framework.IntuticFunctionMiddleware`.

To undo what `intutic connect` writes here, run `intutic disconnect --harness agent-framework`: each file goes back to what it held before connect first wrote it, or is deleted if connect created it, and edits you made since are kept. `.env.intutic` stays while another harness that writes it is still connected. See [`intutic disconnect`](/reference/cli#intutic-disconnect).

## What the adapter does NOT do

The same structural gaps as every SDK-gated framework apply. See [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do). Agent Framework adds these limits:

- **Middleware order.** Function middleware runs outermost first: chat-client middleware, then `Agent(middleware=[...])`, then `agent.run(..., middleware=[...])`. A function middleware that runs *inside* the Intutic one could still change the arguments after the gate approved them. If you use argument-repair middleware, put `IntuticFunctionMiddleware` after it.
- **Only automatic tool calls are gated.** Calling `tool.invoke(...)` directly from your own code skips the function-middleware chain.
- **Hosted tools** run on the model provider's side, not in your process, so the middleware never sees them. Examples are the OpenAI client's `get_code_interpreter_tool()`, `get_file_search_tool()` and `get_mcp_tool()` (hosted MCP).

## Config details

| Property | Value |
|----------|-------|
| Harness type | `agent-framework` |
| Config file | `.env.intutic` |
| Detection | `agent-framework` or `agent_framework` (including `agent-framework-*` packages) in `pyproject.toml`, `requirements.txt`, or `uv.lock` |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`intutic_clawde.gate.adapters.agent_framework.IntuticFunctionMiddleware`, a `FunctionMiddleware` that short-circuits denied calls) — no sync-daemon hook file |
