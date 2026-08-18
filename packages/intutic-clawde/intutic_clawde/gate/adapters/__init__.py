"""Framework-specific gate adapters (Wave 1).

`framework.py` (one level up) is the framework-agnostic core: `@guard` wraps
any callable, and `guard_tools` duck-types LangChain/LangGraph-style tool
objects without importing them. That core already covers CrewAI and AutoGen
tools directly (they are plain callables) and pre-1.0 LangChain tool objects.

This subpackage adds a thin adapter per framework for the cases where the
framework publishes its OWN veto point — a middleware hook, a plugin
callback, a guardrail decorator — richer than "wrap the callable": LangChain
v1.x's `AgentMiddleware.wrap_tool_call`, CrewAI's `before_tool_call` hook,
Google ADK's `before_tool_callback`, and the OpenAI Agents SDK's
`@tool_input_guardrail`. Every adapter funnels into the same
`Gate.guard(tool_name, tool_input)` core `framework.py` uses — there is
exactly one enforcement decision in this package, just several ways to plug
it into a framework's own call graph.

Each module here is optional-import guarded: importing
`intutic_clawde.gate.adapters.<x>` never raises even when `<x>`'s framework
is not installed. Only *instantiating* the adapter class (or calling the
guardrail factory) requires the framework — install the matching extra,
e.g. ``pip install intutic-clawde[crewai]``.

Modules:
  langchain.py       IntuticMiddleware (LangChain v1.x AgentMiddleware)
  crewai.py           install() — registers a before_tool_call hook
  google_adk.py       IntuticPlugin (BasePlugin) + a per-agent callback fallback
  openai_agents.py     intutic_tool_guardrail (a @tool_input_guardrail)
"""
