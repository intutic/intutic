"""The OPAQUE intervention mode: an agent is refused without being told which
rule refused it.

Port of ``packages/shared-types/src/opaqueRefusal.ts``. In an OPAQUE workspace
(the policy snapshot's ``@intervention_mode`` record) every refusal on
workspace policy tells the agent ``OPAQUE_REFUSAL_MESSAGE`` instead of the
rule's name, text or matched pattern, with the same refusal code, so a caller
behaves exactly as it would in a TRANSPARENT workspace. The emitted event keeps
the full reason. Refusals that say nothing about the policy (a call too large
to evaluate, a snapshot that failed its integrity check, a chaos fault) are
unchanged. ``refusal-codes.json`` (``opaqueMessage``) holds this copy to the
others.
"""

from __future__ import annotations

OPAQUE_REFUSAL_MESSAGE = "Blocked by workspace policy. Ask a workspace admin if you need this action."

INTERVENTION_MODE_RECORD_TAG = "@intervention_mode"


def is_opaque_mode(mode: object) -> bool:
    """Whether an intervention mode is OPAQUE, in any case."""
    return isinstance(mode, str) and mode.strip().upper() == "OPAQUE"


def is_opaque_record(line: str) -> bool:
    """Whether a ``.rules`` line is the record of an OPAQUE workspace."""
    parts = line.split("\t")
    return len(parts) == 2 and parts[0] == INTERVENTION_MODE_RECORD_TAG and is_opaque_mode(parts[1])
