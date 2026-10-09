"""How much the gate evaluates before it refuses.

The same values as @intutic/shared-types gateLimits.ts, which documents where
they come from; a test holds both to the "limits" of
packages/shared-types/fixtures/gate-rule-vectors.json.
"""

from __future__ import annotations

from typing import Optional

from .soprules import serialise_tool_input

#: The largest shell command, in UTF-8 bytes, the gate evaluates.
COMMAND_SIZE_LIMIT = 256 * 1024

#: The largest tool arguments, in UTF-8 bytes of compact JSON, the gate evaluates.
ARGUMENTS_SIZE_LIMIT = 1024 * 1024


def too_large_reason(command: str, tool_input: Optional[dict]) -> Optional[str]:
    """Why a call is too large to evaluate, or None.

    Counts the command and the compact JSON of the arguments (the shape the
    SOP rules match) in UTF-8 bytes; arguments that do not serialize are left
    to the tiers, which handle them already.
    """
    command_bytes = len(command.encode("utf-8", "surrogatepass"))
    if command_bytes > COMMAND_SIZE_LIMIT:
        return (
            f"COMMAND_TOO_LARGE: the command is {command_bytes} bytes, over the "
            f"{COMMAND_SIZE_LIMIT}-byte limit a gate evaluates; split it into smaller commands"
        )
    try:
        argument_bytes = len(serialise_tool_input(tool_input).encode("utf-8", "surrogatepass"))
    except (TypeError, ValueError):
        return None
    if argument_bytes > ARGUMENTS_SIZE_LIMIT:
        return (
            f"COMMAND_TOO_LARGE: the tool arguments are {argument_bytes} bytes, over the "
            f"{ARGUMENTS_SIZE_LIMIT}-byte limit a gate evaluates; write the content in smaller parts"
        )
    return None
