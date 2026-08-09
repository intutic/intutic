# LangGraph

Integrate Intutic governance with [LangGraph](https://www.langchain.com/langgraph) — LangChain's graph-based agent framework.

LangGraph is governed on two independent surfaces:

1. **LLM egress** — point the model client's `base_url` at the Intutic proxy (or launch under `intutic exec`). Every LLM call crosses the proxy and is governed like any other harness.
2. **Local tool execution** — LangGraph tools are plain Python callables running inside *your* process. No config or hook file can gate them, so the blocking gate ships SDK-side in `intutic-clawde` and wraps your tools in-process.

## How it works

The `langgraph` adapter is detected when `pyproject.toml`, `requirements.txt`, or `uv.lock` declares a `langgraph` (or `langchain`) dependency. Like Codex, it writes a `.env.intutic` file with proxy base-URL env vars — plus a generated comment block pointing at the SDK gate, because env vars govern egress but not local tool execution.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

```
✓ Detected harnesses:
  • langgraph → .env.intutic
```

### 2. Route LLM traffic through the proxy

Either source the generated env file:

```bash
source .env.intutic
python my_agent.py
```

…or launch under `intutic exec`, which injects the same base-URL env vars for the child process:

```bash
intutic exec -- python my_agent.py
```

…or set `base_url` explicitly on the model client:

```python
from langgraph.graph import StateGraph, START, END
from langchain_openai import ChatOpenAI
from typing import TypedDict

# 1. Initialize LLM pointing at the Intutic proxy
llm = ChatOpenAI(
    model="gpt-4o",
    base_url="http://localhost:4000/v1",  # or your hosted proxy
    api_key="your-intutic-api-key",
)

class AgentState(TypedDict):
    input: str
    response: str

def call_model(state: AgentState):
    # This call is governed pre-flight by Intutic
    res = llm.invoke(state["input"])
    return {"response": res.content}

# Compile Graph
builder = StateGraph(AgentState)
builder.add_node("agent", call_model)
builder.add_edge(START, "agent")
builder.add_edge("agent", END)

graph = builder.compile()
```

LangGraph.js works the same way:

```typescript
import { StateGraph, START, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  model: "gpt-4o",
  configuration: {
    baseURL: "http://localhost:4000/v1", // or your hosted proxy
    apiKey: "your-intutic-api-key",
  }
});
```

### 3. Gate local tool execution (SDK)

```bash
pip install intutic-clawde
```

Wrap your tools before handing them to the graph:

```python
from intutic_clawde.gate import Gate, GateConfig, install, guard_tools

install(Gate(GateConfig()))

# LangChain/LangGraph tool objects are wrapped in place (duck-typed — no
# langchain import inside the SDK). Plain callables work too.
tools = guard_tools([shell_tool, write_file_tool, deploy_tool])
```

Or gate a single callable with the decorator:

```python
from intutic_clawde.gate import guard

@guard
def shell(command: str) -> str:
    ...
```

**The python-raise contract:** on deny the gate raises `IntuticGateRefusal` *before the tool body runs*, with a message beginning `[Intutic Governance] BLOCKED:` — the same prefix family as the Open WebUI filter, so anything that already recognises that contract recognises this one. The gate evaluates, in order:

1. the compiled **policy snapshot** (`~/.intutic/hooks/policy-snapshot.rules`) — the same artifact the sync-daemon compiles for every shipped harness,
2. **SOP rules** authored in the product, including the argument-level `WHERE` clause (`argPattern`) — the gate sees the tool's full rendered arguments, with positionals bound to their parameter names so an argPattern cannot be dodged by calling convention,
3. container **image provenance** on deploy commands,
4. the control plane's **hook-gate** (`POST /api/v1/hook-gate`) — fail-closed by default: if the control plane cannot be reached, the call is refused rather than waved through.

Every decision is reported via `/api/v1/hook-events`, so gated LangGraph runs appear in the same audit feed as hook-based harnesses.

### 4. Trace attribution

The proxy attributes OpenAI-shaped traffic to a harness by wire protocol unless the client says who it is. Send the `x-intutic-harness: langgraph` header so traces file under LangGraph (the proxy honours it; older proxies ignore unknown headers, so it is always safe to send). The SDK builds the right headers for you:

```python
from intutic_clawde.gate import intutic_headers

llm = ChatOpenAI(
    base_url="http://localhost:4000/v1",
    default_headers=intutic_headers(session_id=run_id),
)
```

`intutic_headers` also sets `x-session-id` — worth doing, because the proxy defaults an unset session ID to the literal `"unknown"`, which merges every run into a single dashboard session.

## What gets written

A `.env.intutic` file with proxy URLs and a pointer at the SDK gate:

```bash
# Intutic Governance Rules (auto-generated)
# DO NOT EDIT — managed by intutic sync daemon
# Last sync: 2026-08-10T00:00:00Z
# Source this file: source .env.intutic

export ANTHROPIC_BASE_URL="http://localhost:4000/v1"
export OPENAI_BASE_URL="http://localhost:4000/v1"
export INTUTIC_PROXY_URL="http://localhost:4000/v1"
export INTUTIC_SOP_COUNT=5

# These env vars govern LLM egress only. LangGraph tools run in your own
# Python process, where no config or hook file can gate them — the
# blocking tool gate ships SDK-side:
#   pip install intutic-clawde
#   from intutic_clawde.gate import guard_tools
```

## What the adapter does NOT do

Stated plainly, because the gaps are structural:

- **There is no sync-daemon hook file.** Every hook-based harness has an on-disk config the daemon writes a pre-tool gate into; LangGraph has none — tools are Python callables inside your process. The daemon cannot gate what it cannot reach from disk. The adapter's registry entry records this deliberately (`NO_GATE` in the sync-daemon's gate registry) rather than leaving it to look like an oversight.
- **Argument-level gating requires the SDK wrapper in your code.** Without `guard_tools`/`@guard`, the only tool enforcement is the proxy's response gate (Vector D), which withholds model-emitted denied tool calls — but cannot see a tool your code invokes directly, and on streams matches tool *name* only. Argument-level SOP rules (`argPattern`) evaluate against a tool call's full arguments only inside the SDK gate.
- **Attribution is client-supplied.** `x-intutic-harness` scopes traces and observability; it is not authorization, and a client that lies about its harness is filed as what it claims. Authorization stays bound to the virtual key.

## Multi-agent graphs

For per-node identity (`node_id`, `agent_role`, `graph_id`, `parent_session_id`, `depth`), graph-wide budgets, and ordering constraints across nodes, see [Graph Guardrails](/guide/graph-guardrails).

## Config details

| Property | Value |
|----------|-------|
| Harness type | `langgraph` |
| Config file | `.env.intutic` |
| Detection | `langgraph`/`langchain` in `pyproject.toml`, `requirements.txt`, or `uv.lock` |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`intutic_clawde.gate`, python-raise) — no sync-daemon hook file |
