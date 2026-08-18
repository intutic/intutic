# Google ADK

Integrate Intutic governance with [Google's Agent Development Kit](https://google.github.io/adk-docs/) (ADK).

ADK is governed on two independent surfaces:

1. **LLM egress** — point the model client's `base_url` at the Intutic proxy (or launch under `intutic exec`).
2. **Local tool execution** — ADK tools run as plain Python callables inside *your* process. No config or hook file can gate them, so the blocking gate ships SDK-side in `intutic-clawde`.

## How it works

The `google-adk` adapter is detected when `pyproject.toml`, `requirements.txt`, or `uv.lock` declares a `google-adk` dependency. It writes a `.env.intutic` file with proxy base-URL env vars plus a comment block pointing at the SDK gate.

## Setup

### 1. Initialize Intutic

```bash
intutic init
```

### 2. Route LLM traffic through the proxy

Source `.env.intutic`, launch under `intutic exec`, or set `base_url` explicitly — same as [LangGraph](/integrations/langgraph#2-route-llm-traffic-through-the-proxy).

### 3. Gate local tool execution (SDK)

```bash
pip install intutic-clawde[google-adk]
```

ADK documents `before_tool_callback` — returning a non-`None` dict skips the real tool call and that dict becomes the (synthetic) tool result. Two ways to wire it, matching ADK's own two registration surfaces:

**Global, via a plugin** (every tool call across an `App`):

```python
from google.adk.apps.app import App
from intutic_clawde.gate import Gate, GateConfig, install
from intutic_clawde.gate.adapters.google_adk import IntuticPlugin

install(Gate(GateConfig()))

app = App(name="my_app", root_agent=agent, plugins=[IntuticPlugin()])
```

**Per-agent fallback** (for callers not using `App(plugins=[...])`):

```python
from google.adk.agents.llm_agent import LlmAgent
from intutic_clawde.gate.adapters.google_adk import intutic_before_tool_callback

agent = LlmAgent(..., before_tool_callback=intutic_before_tool_callback)
```

The two surfaces use different keyword conventions on ADK's own call sites (`tool_args=` for the plugin, `args=` for the per-agent callback) — both adapter functions match their respective site exactly.

On deny, either callback returns a synthetic error dict (`{"status": "error", "error": "[Intutic Governance] BLOCKED: ...", ...}`) instead of letting the tool run.

### 4. Trace attribution

```python
from intutic_clawde.gate import intutic_headers

llm = ChatOpenAI(
    base_url="http://localhost:4000/v1",
    default_headers=intutic_headers(session_id=run_id, harness="google-adk"),
)
```

## What gets written

Same shape as LangGraph's `.env.intutic` — proxy URLs plus a pointer at `intutic_clawde.gate.adapters.google_adk.IntuticPlugin`.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do). In short: there is no sync-daemon hook file, argument-level gating requires wiring the plugin/callback into your own agent code, and `x-intutic-harness` attribution is client-supplied, not authorization.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `google-adk` |
| Config file | `.env.intutic` |
| Detection | `google-adk` in `pyproject.toml`, `requirements.txt`, or `uv.lock` |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side (`intutic_clawde.gate.adapters.google_adk.IntuticPlugin`, ADK's `before_tool_callback`) — no sync-daemon hook file |
