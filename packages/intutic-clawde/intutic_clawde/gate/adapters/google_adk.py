"""Google ADK adapter: `IntuticPlugin` (global) plus a per-agent callback
fallback.

Google ADK (v2.7.1+) documents ``before_tool_callback`` — implemented both as
a ``BasePlugin`` method (fires for every tool call across an ``App``) and as
a per-agent constructor argument (``LlmAgent(before_tool_callback=...)``,
fires only for that agent's tools). Returning a non-None ``dict`` from either
SKIPS the real tool execution and that dict becomes the (synthetic) tool
result — this IS ADK's documented veto point, not an inferred one.

Verified live against ``google-adk==2.7.1`` by reading
``google/adk/flows/llm_flows/functions.py`` directly (not just its docs):

  * the plugin path is checked FIRST (``plugin_manager.run_before_tool_callback``,
    called with keyword args ``tool=``, ``tool_args=``, ``tool_context=``);
  * only if that returns ``None`` does ADK fall through to the per-agent
    ``canonical_before_tool_callbacks``, called with a DIFFERENT keyword
    convention — ``tool=``, ``args=`` (not ``tool_args``), ``tool_context=``.
    ``IntuticPlugin.before_tool_callback`` and
    ``intutic_before_tool_callback`` below match each call site's real
    signature exactly, not a single shared one.
  * ``tool.name`` is a required constructor field on ``BaseTool`` — always
    present.

Optional import: importing this module never fails even without google-adk
installed. Only instantiating ``IntuticPlugin`` (or calling
``intutic_before_tool_callback``) requires it —
``pip install intutic-clawde[google-adk]``.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from ..gate import Gate, IntuticGateRefusal, active

try:
    from google.adk.plugins.base_plugin import BasePlugin
    _HAS_ADK = True
except ImportError:  # pragma: no cover - exercised via _HAS_ADK branches
    BasePlugin = object  # type: ignore[assignment,misc]
    _HAS_ADK = False


def _refusal_result(exc: IntuticGateRefusal) -> Dict[str, Any]:
    """A synthetic tool-error result: any JSON-serializable dict is a valid
    ADK tool result (there is no fixed result schema ADK enforces), so this
    shape is a reasonable, human- and model-readable error payload rather
    than a framework-mandated one."""
    return {
        "status": "error",
        "error": str(exc),
        "intutic_governance": {
            "blocked": True,
            "reason": exc.reason,
            "code": exc.code,
            "incident_id": exc.incident_id,
        },
    }


def _no_gate_error() -> RuntimeError:
    return RuntimeError(
        "No gate configured: call intutic_clawde.gate.install(Gate(...)) "
        "before wiring the ADK callback, or pass gate= where supported. "
        "Refusing to run the tool unguarded."
    )


class IntuticPlugin(BasePlugin):  # type: ignore[misc]
    """ADK ``BasePlugin`` — vetoes every tool call across an ``App``.

    Usage::

        from google.adk.apps.app import App
        from intutic_clawde.gate.adapters.google_adk import IntuticPlugin

        app = App(name="my_app", root_agent=agent, plugins=[IntuticPlugin()])
    """

    def __init__(self, *, name: str = "intutic_governance", gate: Optional[Gate] = None) -> None:
        if not _HAS_ADK:
            raise RuntimeError(
                "IntuticPlugin requires google-adk>=2.7.1: "
                "pip install intutic-clawde[google-adk]"
            )
        super().__init__(name)
        self._gate = gate

    async def before_tool_callback(self, *, tool: Any, tool_args: Dict[str, Any],
                                    tool_context: Any) -> Optional[Dict[str, Any]]:
        g = self._gate or active()
        if g is None:
            raise _no_gate_error()
        try:
            g.guard(tool.name, dict(tool_args or {}))
        except IntuticGateRefusal as exc:
            return _refusal_result(exc)
        return None  # allow — ADK proceeds with the real tool call


async def intutic_before_tool_callback(
    *, tool: Any, args: Dict[str, Any], tool_context: Any,
    gate: Optional[Gate] = None,
) -> Optional[Dict[str, Any]]:
    """Per-agent fallback for callers not using ``App(plugins=[...])``.

    Usage::

        from google.adk.agents.llm_agent import LlmAgent
        from intutic_clawde.gate.adapters.google_adk import intutic_before_tool_callback

        agent = LlmAgent(..., before_tool_callback=intutic_before_tool_callback)

    Note the different keyword shape versus the plugin path above (``args=``,
    not ``tool_args=``) — this is ADK's own per-agent calling convention, not
    a typo; see this module's doc comment.
    """
    g = gate or active()
    if g is None:
        raise _no_gate_error()
    try:
        g.guard(tool.name, dict(args or {}))
    except IntuticGateRefusal as exc:
        return _refusal_result(exc)
    return None
