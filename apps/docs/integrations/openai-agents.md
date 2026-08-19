# OpenAI Agents SDK

Integrate Intutic governance with the OpenAI Agents SDK — both the
[Python SDK](https://openai.github.io/openai-agents-python/) (`openai-agents`)
and the [TypeScript SDK](https://openai.github.io/openai-agents-js/)
(`@openai/agents`). The Python integration is documented first; the
[TypeScript section](#typescript-sdk-openai-agents) follows.

The SDK is governed on two independent surfaces:

1. **LLM egress** — point the model client's `base_url` at the Intutic proxy (or launch under `intutic exec`).
2. **Local tool execution** — tools run as plain Python callables inside *your* process. No config or hook file can gate them, so the blocking gate ships SDK-side in `intutic-clawde`.

## How it works

The `openai-agents` adapter is detected when `pyproject.toml`, `requirements.txt`, or `uv.lock` declares an `openai-agents` dependency — or when `package.json` declares any `@openai/agents*` dependency (the TypeScript SDK). It writes a `.env.intutic` file with proxy base-URL env vars plus a comment block pointing at the SDK gate for the detected ecosystem.

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

## TypeScript SDK (@openai/agents)

The TypeScript SDK is gated by `@intutic/gate/openai` (the `@intutic/gate`
npm package) — the TS twin of the Python guardrail above, verified against
`@openai/agents@0.16.1`.

**Minimum versions:** tool input guardrails (the veto point everything below
uses) exist since `@openai/agents-core` **0.3.8** (2026-01-14). The optional
pre-approval ordering flag needs **0.11.8** (see below).

### 1. Route LLM traffic through the proxy — easier than most JS frameworks

The underlying `openai` client reads `OPENAI_BASE_URL` whenever no explicit
`baseURL`/client is passed, so sourcing `.env.intutic` (or launching under
`intutic exec`) routes all chat traffic through the Intutic proxy with
**zero code** — unlike the Vercel AI SDK, which requires in-code provider
construction. The SDK's default transport is the OpenAI Responses API, whose
wire shape the proxy already parses (response gate included).

::: danger Tracing exports bypass the proxy — handle this
`@openai/agents` ships with tracing **on by default**, and its exporter POSTs
trace spans — **including tool inputs and outputs** — to a **hardcoded**
`https://api.openai.com/v1/traces/ingest`. That endpoint ignores
`OPENAI_BASE_URL`: even with LLM egress fully proxied, tool I/O leaves
through the side door. `installOpenAiGate()` closes this by default by
setting the SDK's own kill-switch env, `OPENAI_AGENTS_DISABLE_TRACING=1`. If
you need traces, re-point the exporter at an approved collector —
`setTraceProcessors([new BatchTraceProcessor(new OpenAITracingExporter({ endpoint }))])`
— and pass `{ tracingExport: 'keep' }`.
:::

### 2. Gate local tool execution (SDK)

```bash
npm install @intutic/gate
```

```ts
import { Agent, run, tool } from '@openai/agents'
import { installOpenAiGate, wrapAgent, intuticToolGuardrail } from '@intutic/gate/openai'

installOpenAiGate({ workspaceId: process.env.INTUTIC_WORKSPACE_ID })

// Either: attach the guardrail per tool...
const shell = tool({
  name: 'shell',
  description: 'Run a shell command',
  parameters: z.object({ command: z.string() }),
  inputGuardrails: [intuticToolGuardrail()],
  execute: async ({ command }) => runShell(command),
})

// ...or wrap the whole agent (recommended — see the MCP note below):
const agent = wrapAgent(new Agent({ name: 'ops', tools: [shell], mcpServers }))
const result = await run(agent, prompt)
```

On deny, the guardrail resolves `rejectContent` — the SDK skips the tool body
and hands the `[Intutic Governance] BLOCKED: ...` message back to the model
in place of a tool result, exactly like the Python `reject_content` flow. An
unexpected gate crash also rejects (fail closed).

**MCP tools — use `wrapAgent`, not a map over `agent.tools`.** Tools from
`agent.mcpServers` are materialized per run by `agent.getAllTools()` and
never appear in `agent.tools`; wrapping only the static tool list silently
leaves every MCP tool ungated. `wrapAgent()` patches the agent's
`getAllTools` so MCP-derived tools get the same guardrail. Agents reached
via handoffs are separate objects — wrap each one.

**Ordering with human approval:** for a tool whose `needsApproval` resolves
true, guardrails run **after** the approval prompt by default. To evaluate
the gate before asking a human (so a blocked call never reaches the approval
UI), pass the run config `toolExecution: { preApprovalInputGuardrails: true }`
(requires `@openai/agents-core` >= 0.11.8).

**Realtime / voice agents:** `@openai/agents-realtime` honours
`FunctionTool.inputGuardrails` through the same mechanism, so a guardrail
injected here also gates voice-agent tool calls.

### 3. Non-function tools — what `wrapAgent`/`wrapTools` does with each

| Tool | What happens |
|------|--------------|
| `hostedMcpTool(...)` | Rewritten to `require_approval: 'always'` + an Intutic `on_approval` that guards each call (a pre-existing `onApproval` is composed after the gate allows). Note the SDK's own default is `require_approval: 'never'` — an unwrapped hosted MCP tool is entirely ungated. If your original config demanded a human (`requireApproval`) but had no `onApproval`, a gate-allowed call is **rejected**, not silently auto-approved — an approval that cannot be granted in an unattended run is a block (same posture as SOP approval rules); keep your own `onApproval` to retain a human flow. |
| `shellTool({ shell })` (local) | Every action is routed through the approval path and gated per command; gate refusal → rejected with the BLOCKED message. After the gate allows, your original `needsApproval`/`onApproval` policy is replayed unchanged (including leaving a genuine human-approval interruption pending). |
| `applyPatchTool(...)` | Same as local shell; the gate sees `{ path, operation, content }` per operation. |
| `computerTool(...)` | The **only** hook is the per-action `needsApproval` predicate — there is no `onApproval` and no guardrail. A gate-refused action resolves `needsApproval → true`, surfacing as a pending interruption in `result.interruptions` that **your code must `state.reject(...)`**. Stated honestly: this adapter cannot auto-reject a computer action with a message, and a handler that approves the interruption overrides the gate (the refusal is still recorded as `tool_blocked` telemetry). Helper: `intuticComputerNeedsApproval()`. |
| `webSearchTool` / `fileSearchTool` / `codeInterpreterTool` / image generation / hosted-environment `shellTool` | **Not gateable client-side, by anyone.** These execute server-side at OpenAI; no guardrail, approval hook, or wrapper ever sees them (hosted shell types `needsApproval`/`onApproval` as `never`). They pass through unwrapped. Their LLM-side traffic is still visible to the proxy, but per-call tool gating does not exist for them. |

### 4. Trace attribution

Same as the Python section: send `intuticHeaders(...)` (from `@intutic/gate`)
as default headers on a proxy-pointed client, or set `INTUTIC_SESSION_ID` —
`installOpenAiGate()` reuses it for control-plane event attribution.

## What gets written

Same shape as LangGraph's `.env.intutic` — proxy URLs plus a pointer at the SDK gate: `intutic_clawde.gate.adapters.openai_agents.intutic_tool_guardrail` for a Python (or mixed) workspace, `@intutic/gate/openai` for a TypeScript-only one.

## What the adapter does NOT do

Same structural gaps as every SDK-gated framework — see [LangGraph's "What the adapter does NOT do"](/integrations/langgraph#what-the-adapter-does-not-do). In short: there is no sync-daemon hook file, argument-level gating requires attaching the guardrail to your own tools, and `x-intutic-harness` attribution is client-supplied, not authorization.

## Config details

| Property | Value |
|----------|-------|
| Harness type | `openai-agents` |
| Config file | `.env.intutic` |
| Detection | `openai-agents` in `pyproject.toml`, `requirements.txt`, or `uv.lock` — OR any `@openai/agents*` dependency in `package.json` |
| Format | Shell environment variables |
| Write strategy | Atomic (write to `.intutic-tmp`, then rename) |
| Tool gate | SDK-side, both ecosystems (Python: `intutic_clawde.gate.adapters.openai_agents.intutic_tool_guardrail`; TypeScript: `@intutic/gate/openai`) — no sync-daemon hook file |
