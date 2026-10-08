"""SSO-group tool clearance, read from the policy snapshot.

Port of ``evaluateSsoGroupClearance`` and the ``@sso_groups`` record in
``packages/shared-types/src/ssoGroupClearance.ts`` — the evaluator the control
plane's hook gate, the MCP proxy and the sync daemon's snapshot compiler share.
``tests/test_gate_sso_groups.py`` runs the shared vectors
(``packages/shared-types/fixtures/sso-group-clearance-vectors.json``) through
this module so it cannot drift from them. ``@intutic/gate`` carries the same
port in ``src/ssoGroups.ts``.

The snapshot's record carries the workspace's policy and the member the
snapshot was issued to, with their groups as the control plane resolved them.
It sits inside the snapshot's digest; when the digest fails, the gate still
applies the policy but treats the member's groups as unknown, so an edited
group list clears nothing.

Algorithm, in order: no policy -> GRANTED; tool on ``requireOboFor`` ->
REQUIRES_OBO; tool not on ``highRiskTools`` -> GRANTED; groups unknown ->
DENIED; member holds a ``requiredGroups`` entry -> GRANTED; otherwise DENIED.
Names and groups match exactly.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from dataclasses import dataclass
from typing import Optional

SSO_GROUP_RECORD_TAG = "@sso_groups"

GRANTED = "GRANTED"
DENIED = "DENIED"
REQUIRES_OBO = "REQUIRES_OBO"


@dataclass(frozen=True)
class SsoGroupPolicy:
    high_risk_tools: tuple[str, ...]
    required_groups: tuple[str, ...]
    require_obo_for: tuple[str, ...]


@dataclass(frozen=True)
class SsoGroupRecord:
    policy: SsoGroupPolicy
    member_id: Optional[str]
    # None means the groups are unknown, which refuses every high-risk tool.
    member_groups: Optional[tuple[str, ...]]
    issued_at: str


@dataclass(frozen=True)
class SsoGroupDecision:
    clearance: str
    rule_id: Optional[str] = None
    reason: str = ""


def _string_list(value) -> tuple[str, ...]:
    return tuple(v for v in value if isinstance(v, str)) if isinstance(value, list) else ()


def parse_policy(value) -> Optional[SsoGroupPolicy]:
    if not isinstance(value, dict):
        return None
    return SsoGroupPolicy(
        high_risk_tools=_string_list(value.get("highRiskTools")),
        required_groups=_string_list(value.get("requiredGroups")),
        require_obo_for=_string_list(value.get("requireOboFor")),
    )


def _rule_id(kind: str, tool_name: str) -> str:
    return f"sso_group.{kind}.{re.sub(r'[^A-Za-z0-9_.:-]', '_', tool_name)}"


def evaluate(policy: Optional[SsoGroupPolicy], tool_name: str,
             member_groups: Optional[tuple[str, ...] | list[str]]) -> SsoGroupDecision:
    if policy is None:
        return SsoGroupDecision(GRANTED)
    if tool_name in policy.require_obo_for:
        return SsoGroupDecision(
            REQUIRES_OBO, _rule_id("require_obo", tool_name),
            f"SSO group policy: {tool_name} is on-behalf-of only, and a tool-call gate has no OBO token to present",
        )
    if tool_name not in policy.high_risk_tools:
        return SsoGroupDecision(GRANTED)
    if member_groups is not None and any(g in member_groups for g in policy.required_groups):
        return SsoGroupDecision(GRANTED)
    groups = ", ".join(policy.required_groups) if policy.required_groups else "(none configured)"
    if member_groups is None:
        why = "and this gate does not know the member's groups"
    else:
        why = "and this member holds none of them"
    return SsoGroupDecision(
        DENIED, _rule_id("high_risk", tool_name),
        f"SSO group policy: {tool_name} requires one of the SSO groups {groups}, {why}",
    )


def decode_record(line: str) -> Optional[SsoGroupRecord]:
    """Reads the snapshot's record line; None for any other line or a damaged one."""
    parts = line.split("\t")
    if len(parts) != 2 or parts[0] != SSO_GROUP_RECORD_TAG or not parts[1]:
        return None
    try:
        raw = json.loads(base64.b64decode(parts[1], validate=True).decode("utf-8"))
    except (binascii.Error, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    policy = parse_policy(raw.get("policy"))
    issued_at = raw.get("issuedAt")
    if policy is None or not isinstance(issued_at, str):
        return None
    member = raw.get("member")
    if isinstance(member, dict) and isinstance(member.get("memberId"), str):
        return SsoGroupRecord(policy, member["memberId"], _string_list(member.get("ssoGroups")), issued_at)
    return SsoGroupRecord(policy, None, None, issued_at)
