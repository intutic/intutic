"""Approval holds — a hold rule refuses the call for now and asks a person.

The same mechanism as the MCP proxy's ``approvalHold.ts`` and
``@intutic/gate``'s ``hold.ts``, through the same control-plane decisions API
the harness hook gates use:

1. A call that matches a hold rule (``hold`` severity in the policy snapshot,
   or a ``REQUIRE_APPROVAL:`` rule in the SOP register) is looked up in the
   workspace's approved bypasses (``GET /api/v1/decisions/approved-bypasses``).
   An exact, unexpired match — same rule, same tool, same arguments — lets the
   call through.
2. Otherwise the call is refused with ``IntuticGateHold`` and a hold is
   recorded (``POST /api/v1/decisions``): it joins the review queue, the
   workspace is notified (``decision.pending``, Slack included), and the
   refusal carries the hold id.
3. An owner, admin or engineering manager approves it
   (``intutic decision approve <holdId>`` or the Slack card). The identical
   retry passes only while the workspace's review-hold bypass
   (``reviewHoldBypassEnabled``) is on, for ``reviewHoldBypassTtlMinutes``;
   with it off, approving records the decision and the retry is held again.

"Identical" is the bypass key: the rule id, the tool name trimmed and
lower-cased, and a SHA-256 of the arguments serialised as JavaScript's
``JSON.stringify`` would with sorted keys. JavaScript's serialisation and not
Python's, so the hash is the one the other gates compute for the same call;
``packages/shared-types/fixtures/hold-key-vectors.json`` holds all three to it.

A hold needs the control plane both ways, so without one (no client, or an
unreachable control plane) the call stays held, whatever ``fail_closed`` says,
exactly as a hook gate's hold refuses when it cannot record: a rule that says
a person must approve is not satisfied by nobody being reachable.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from .client import GateClient

#: The hold-record version the control plane accepts.
HOLD_RECORD_VERSION = 1


@dataclass
class HoldOutcome:
    #: "bypassed" (an approval lets the call through) or "held".
    kind: str
    hold_id: str
    #: Held: whether the control plane accepted the hold record.
    recorded: bool = False
    #: Bypassed: the member who approved it.
    decided_by: str = ""


def _js_number(x: float) -> str:
    """A float as JavaScript's Number#toString writes it: the same shortest
    digits as Python's repr, placed by ECMAScript's rules rather than
    Python's (``1e-07`` is ``1e-7``, ``1e+16`` is ``10000000000000000``)."""
    if math.isnan(x) or math.isinf(x):
        return "null"   # what JSON.stringify writes for them
    if x == 0:
        return "0"
    sign, digits, exponent = Decimal(repr(abs(x))).normalize().as_tuple()
    d = "".join(str(n) for n in digits)
    k = len(d)
    n = int(exponent) + k
    if k <= n <= 21:
        out = d + "0" * (n - k)
    elif 0 < n <= 21:
        out = d[:n] + "." + d[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + d
    else:
        e = n - 1
        mantissa = d if k == 1 else d[0] + "." + d[1:]
        out = f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"
    return ("-" if x < 0 else "") + out


def canonical_json(value: Any) -> str:
    """JSON with object keys sorted at every level, so key order never changes
    a hash — byte for byte what the TypeScript gates' ``canonicalJson`` writes."""
    if isinstance(value, dict):
        # By UTF-16 code unit, as JavaScript compares strings, not by code
        # point: the two disagree once a key mixes astral and high-BMP characters.
        items = sorted(((str(k), v) for k, v in value.items()), key=lambda kv: kv[0].encode("utf-16-be"))
        return "{" + ",".join(
            f"{json.dumps(k, ensure_ascii=False)}:{canonical_json(v)}" for k, v in items
        ) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _js_number(value)
    return json.dumps(str(value), ensure_ascii=False)


def hold_key(tool_name: str, tool_input: Any) -> tuple[str, str]:
    """The bypass key's call half: (tool name normalised, hash of its arguments)."""
    canonical = canonical_json(tool_input if tool_input is not None else {})
    return tool_name.strip().lower(), hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _new_hold_id() -> str:
    return f"hold_{_base36(int(time.time() * 1000))}_{os.urandom(4).hex()}"


def _base36(n: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return out or "0"


def hold_message(rule_reason: str, rule_id: str, outcome: HoldOutcome) -> str:
    """What the agent is told — the one place this package words a hold. Says
    who can approve, and that a retry passes only with the bypass setting on,
    because "retry after approval" alone is false under the default settings."""
    if not outcome.recorded:
        return (
            f"HELD for approval: {rule_reason} [{rule_id}], but the hold could not be recorded "
            f"(Intutic control plane unreachable), so there is nothing to approve yet. Do not retry "
            f"until the control plane is reachable; the retry then asks for approval."
        )
    return (
        f"HELD for approval: {rule_reason} [{rule_id}]. Hold id: {outcome.hold_id}. "
        f"An owner, admin or engineering manager can approve it with: intutic decision approve "
        f"{outcome.hold_id} (or reject it), or from the Slack card. Retry this exact call after "
        f"approval only if the workspace's review-hold bypass (reviewHoldBypassEnabled) is on; "
        f"otherwise approving records the decision and the call stays held."
    )


def request_hold(client: Optional["GateClient"], rule_id: str, rule_reason: str,
                 tool_name: str, tool_input: Any) -> HoldOutcome:
    """Lets the call through on an approved bypass, or records a hold and
    returns its id. Never raises: every failure leaves the call held."""
    hold_id = _new_hold_id()
    if client is None:
        return HoldOutcome("held", hold_id, recorded=False)
    tool_name_normalized, target_hash = hold_key(tool_name, tool_input)

    bypass = _find_bypass(client, rule_id, tool_name_normalized, target_hash)
    if bypass is not None:
        return bypass

    recorded = client.record_hold({
        "v": HOLD_RECORD_VERSION,
        "holdId": hold_id,
        "reason": rule_id,
        "tool": tool_name,
        "sessionId": client.session_id,
        "at": datetime.now(timezone.utc).isoformat(),
        "toolNameNormalized": tool_name_normalized,
        "targetHash": target_hash,
        "context": {"source": "gate_sdk", "harness": client.harness, "tool": tool_name, "rule": rule_reason},
    })
    return HoldOutcome("held", hold_id, recorded=recorded)


def _find_bypass(client: "GateClient", rule_id: str, tool_name_normalized: str,
                 target_hash: str) -> Optional[HoldOutcome]:
    entries = client.approved_bypasses()
    if not entries:
        return None
    now = datetime.now(timezone.utc)
    for raw in entries:
        if not isinstance(raw, dict):
            continue
        # The route answers for the key's own workspace; the comparison is a
        # second check, made whenever this client was told its workspace.
        if client.workspace_id and raw.get("workspaceId") != client.workspace_id:
            continue
        if raw.get("sopRuleId") != rule_id:
            continue
        if raw.get("toolNameNormalized") != tool_name_normalized or raw.get("targetHash") != target_hash:
            continue
        try:
            expires = datetime.fromisoformat(str(raw.get("expiresAt", "")).replace("Z", "+00:00"))
        except ValueError:
            continue
        if expires.tzinfo is None or now >= expires:
            continue
        hold_id = raw.get("holdId")
        decided_by = raw.get("decidedBy")
        return HoldOutcome(
            "bypassed",
            hold_id if isinstance(hold_id, str) else "",
            decided_by=decided_by if isinstance(decided_by, str) else "",
        )
    return None
