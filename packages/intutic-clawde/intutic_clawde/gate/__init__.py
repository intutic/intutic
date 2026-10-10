"""Pre-execution tool gate for agent frameworks without a shipped Intutic harness.

Intutic ships PreToolUse hooks for the harnesses in the sync-daemon's gate
registry (packages/shared-types/src/gateKind.ts). LangGraph — and most
DIY Python agent loops — are not among them. This subpackage is the missing
adapter, written against Intutic's own published gate contract:

  * it reads the same ``~/.intutic/hooks/policy-snapshot.rules`` artifact the
    sync-daemon compiles for every shipped harness (``snapshot``),
  * it applies SOP rules authored in the product, including the ``WHERE``
    argument clause (``soprules``, a mirror of the control plane's
    ``matchSopRule``),
  * it checks container image provenance on deploy commands (``imagecheck``),
  * and it consults ``POST /api/v1/hook-gate`` on the control plane
    (``client``), reporting every decision via ``/api/v1/hook-events``.

Framework integration is deliberately framework-agnostic: the ``@guard``
decorator wraps any callable tool, ``guard_tools`` wraps a list of
LangChain/LangGraph-style tool objects by duck typing (no langchain import),
and CrewAI / AutoGen tools — plain callables — work through the same
decorator. ``intutic_headers`` returns the headers a ChatOpenAI/OpenAI client
pointed at the Intutic proxy should send for trace attribution.

On deny the gate raises ``IntuticGateRefusal``, whose message follows the same
``[Intutic Governance] BLOCKED: ...`` python-raise contract as the Open WebUI
filter, so anything that already recognises that family recognises this one.
A hold rule raises its subclass ``IntuticGateHold`` (``[Intutic Governance]
HELD: ...``), carrying the hold's id.
"""

from .actions import classify, is_deploy, is_test, touches_infra
from .client import GateClient, GateResponse
from .framework import guard, guard_tools, intutic_headers
from .gate import GATE_REFUSAL_CODES, Gate, GateConfig, IntuticGateHold, IntuticGateRefusal, active, install
from .hold import canonical_json, hold_key, hold_message
from .imagecheck import Verdict as ImageVerdict
from .limits import ARGUMENTS_SIZE_LIMIT, COMMAND_SIZE_LIMIT
from .snapshot import Snapshot, load_snapshot
from .soprules import SopRule, first_match, parse_rules, supports_arg_patterns

__all__ = [
    "classify", "is_deploy", "is_test", "touches_infra",
    "GateClient", "GateResponse",
    "guard", "guard_tools", "intutic_headers",
    "Gate", "GateConfig", "GATE_REFUSAL_CODES", "IntuticGateHold", "IntuticGateRefusal", "active", "install",
    "canonical_json", "hold_key", "hold_message",
    "ARGUMENTS_SIZE_LIMIT", "COMMAND_SIZE_LIMIT",
    "ImageVerdict", "Snapshot", "load_snapshot",
    "SopRule", "first_match", "parse_rules", "supports_arg_patterns",
]
