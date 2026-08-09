"""SOP rules authored in the product, enforced before execution.

`SopRule` has carried an optional `argPattern` since mcp-proxy shipped, and
`packages/mcp-proxy/src/policy.ts:113-114` matches it against the serialised
tool input. For a long time nothing *produced* one: the control plane's rule
endpoint parsed SOP titles with `^(BLOCK|WARN|REQUIRE_APPROVAL):([^:]+)(?::(.+))?$`,
so the finest rule an author could express was over the tool NAME — and the
strongest deploy rule available was

    BLOCK:^shell$        # block every shell call

which blocks `make test` and `git status` too. A rule that broad gets switched
off within a day, so in practice the policy could not be written at all.

intutic/intutic-enterprise#14 added a ` WHERE ` clause to the title grammar, so
the rule becomes sayable in the product:

    BLOCK:^shell$ WHERE kubectl\\s+apply(?!.*@sha256:):deploy must be pinned

Now the *policy* lives in the SOP register — versioned, lifecycle-gated,
visible on the dashboard, editable without touching agent code — and this
module is only the part that applies it.

Matching mirrors `matchSopRule` in
`services/control-plane/src/lib/sopRuleTitle.ts` (itself a deliberate
line-for-line mirror of `PolicyClient.matchRule` in
`packages/mcp-proxy/src/policy.ts:107-124`), deliberately:

  * rules are tried in the order the control plane returned them
  * first match wins
  * `toolPattern` is tested against the tool name, `argPattern` against the
    serialised tool input
  * the serialisation is the `JSON.stringify(tool_input ?? {})` shape both
    mirrors match against — compact separators, insertion order, non-ASCII
    left intact — or the consumers diverge on the exact input they disagree
    about (see `serialise_tool_input`)
  * a rule whose regex does not compile is SKIPPED, not fatal

That last one is what makes this safe to run against a control plane that
predates the change. An old one truncates the pattern at the `:` inside
`@sha256:`, leaving an unterminated group; it fails to compile and is skipped,
so this tier goes quiet rather than misfiring. `supports_arg_patterns()`
reports that state so the operator sees it instead of guessing.

Fetch failure is non-fatal for the same reason it is in `policy.ts`: the gate's
image-integrity tier independently covers the deploy case and fails CLOSED.
This tier changes where the policy is *authored*, not whether the run is safe.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

FETCH_TIMEOUT = 3.0

# Actions the control plane can return. Anything else is ignored rather than
# guessed at — an unrecognised action must not silently become "allow".
ACTION_BLOCK = "block"
ACTION_WARN = "warn"
ACTION_APPROVAL = "require_approval"
KNOWN_ACTIONS = frozenset({ACTION_BLOCK, ACTION_WARN, ACTION_APPROVAL})


@dataclass(frozen=True)
class SopRule:
    id: str
    tool_pattern: str
    action: str
    reason: str
    arg_pattern: str | None = None

    def matches(self, tool_name: str, tool_input_json: str) -> bool:
        """Mirror of matchSopRule, including its silent-skip on bad regex."""
        try:
            if not re.search(self.tool_pattern, tool_name):
                return False
            if self.arg_pattern is not None:
                return bool(re.search(self.arg_pattern, tool_input_json))
            return True
        except re.error:
            # Malformed regex in rule — skip silently, exactly as the control
            # plane and mcp-proxy mirrors do.
            return False


def serialise_tool_input(tool_input: dict | None) -> str:
    """The `JSON.stringify(tool_input ?? {})` both TS mirrors match against.

    Compact separators, insertion order preserved, non-ASCII left intact.
    Python's defaults (spaces after separators) would let an argPattern that
    spans a key/value boundary match on one enforcement path and not the other.
    """
    return json.dumps(tool_input or {}, separators=(",", ":"), ensure_ascii=False)


def parse_rules(payload: object) -> list[SopRule]:
    """Accept the rule list in whichever envelope the control plane used.

    `/api/v1/sop/rules` returns `{rules:[...]}`, while sibling list endpoints
    variously return `{items:[...]}` (camelCase) and `{data:[...]}` (snake_case).
    Reading the wrong key yields zero rules and a tier that enforces nothing
    while looking healthy — the worst failure a gate can have — so all three
    are accepted rather than assumed.
    """
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = (payload.get("rules") or payload.get("items")
                or payload.get("data") or [])
    else:
        return []
    if not isinstance(rows, list):
        return []

    out: list[SopRule] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        tool_pattern = row.get("toolPattern") or row.get("tool_pattern")
        action = str(row.get("action") or "").lower()
        if not isinstance(tool_pattern, str) or not tool_pattern:
            continue
        if action not in KNOWN_ACTIONS:
            continue
        arg = row.get("argPattern") or row.get("arg_pattern")
        out.append(SopRule(
            id=str(row.get("id") or row.get("sopId") or "sop"),
            tool_pattern=tool_pattern,
            action=action,
            reason=str(row.get("reason") or f"SOP rule {tool_pattern}"),
            arg_pattern=arg if isinstance(arg, str) and arg else None,
        ))
    return out


def fetch_rules(base_url: str, api_key: str, workspace_id: str,
                timeout: float = FETCH_TIMEOUT) -> list[SopRule] | None:
    """Return active VALIDATED rules, or None if they could not be fetched.

    None and [] mean different things and the caller must not conflate them:
    None is "the register did not answer", [] is "the register answered and
    this workspace has no rules". Only the second is a statement about policy.
    """
    qs = urllib.parse.urlencode({"workspaceId": workspace_id, "active": "true"})
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/v1/sop/rules?{qs}",
        method="GET",
        headers={"Authorization": f"Bearer {api_key}",
                 "X-Workspace-Id": workspace_id},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError):
        return None
    try:
        return parse_rules(json.loads(raw) if raw else {})
    except json.JSONDecodeError:
        return None


def supports_arg_patterns(rules: list[SopRule]) -> bool:
    """True when the control plane emitted at least one usable argPattern.

    A control plane predating intutic-enterprise#14 cannot produce one, so this
    doubles as a deployment probe — surface it rather than letting the tier be
    silently inert.
    """
    return any(r.arg_pattern and _compiles(r.arg_pattern) for r in rules)


def _compiles(pattern: str) -> bool:
    try:
        re.compile(pattern)
        return True
    except re.error:
        return False


def first_match(rules: list[SopRule], tool_name: str,
                tool_input: dict) -> SopRule | None:
    """First rule matching this call, in control-plane order."""
    payload = serialise_tool_input(tool_input)
    for rule in rules:
        if rule.matches(tool_name, payload):
            return rule
    return None
