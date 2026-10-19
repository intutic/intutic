/**
 * The `@rule` record decoder and Tier R in Python, for the bash gates (their extractor already requires
 * python3), emitted after the phrase matcher (`phrasesPy.ts`) in `GATE_PY_LIB`.
 *
 * Byte-identical to `packages/intutic-clawde/intutic_clawde/gate/rule_record.py`,
 * which a test compares; edit that file and copy it here. It is the
 * transliteration of `@intutic/shared-types`'s gateRuleRecord.ts, and both run the
 * shared vectors. No backtick or dollar-brace, which this copy cannot hold.
 */
export const RULE_RECORD_PY_SOURCE = String.raw`"""Rule records in the policy snapshot: the @rule record, its
fallback line, and how a gate that reads it decides a call (Tier R).

A transliteration of packages/shared-types/src/gateRuleRecord.ts (the
reader's half: the writers are the daemon, the CLI and the control plane).
A record is five tab-separated columns: @rule, the fallback line's id or
-, the kind, the rollout, and base64 of the canonical JSON of its
payload, {v, ref, sopTitle, ...kind fields}. A record that does not
decode leaves its fallback line in force, which refuses. Kinds:
requires_outcome (a qualified requires_before), scope_paths (under
scope_paths_mode: enforce) and plan_approval.

Every port runs packages/shared-types/fixtures/rule-record-vectors.json. The
bash hook gates emit this file after test_outcome.py, scope_match.py and the
lane phrases, whose names it uses: imported here as modules, and found in the
emitting script's scope when it is not one. Otherwise the standard library
only, and no backtick or dollar-brace, which a TypeScript copy cannot hold.
"""

import base64
import binascii
import json
import re

try:
    from .actions import LANE_PHRASES
    from .scope_match import (
        SCOPE_DELETE_TOOLS, SCOPE_EDIT_TOOLS, SCOPE_EDITOR_TOOLS, SCOPE_MOVE_TOOLS, SCOPE_SHELL_TOOLS,
        SCOPE_WRITE_TOOLS, change_targets, is_plan_exempt_tool, is_within_scope, scope_relative_path,
    )
    from .test_outcome import prerequisite_case, prerequisite_unmet_reason
except (ImportError, KeyError):  # embedded in a bash gate (exec without __name__), beside the sources it needs
    pass

RULE_RECORD_TAG = "@rule"
RULE_SNAPSHOT_FORMAT = 3
RULE_SOP_TITLE_MAX_CHARS = 80
RULE_SCOPE_PATHS_MAX = 64
RULE_SCOPE_PATH_MAX_CHARS = 512
GATE_RULE_KINDS = ("requires_outcome", "scope_paths", "plan_approval")
V22_ACTION_TOKENS = ("action:deploy", "action:publish", "action:release", "action:db_write")

# The payload fields of each kind, sorted; the kind, fallback id and rollout are columns.
_FIELDS = {
    "requires_outcome": ["adjacent", "first", "qualifier", "ref", "sopTitle", "then", "v"],
    "scope_paths": ["ref", "scopePaths", "sopTitle", "v"],
    "plan_approval": ["mode", "ref", "sopTitle", "v"],
}
_REF = re.compile(r"^[^\n\r\u2028\u2029]+#([a-z_]+):([1-9][0-9]{0,5})\Z")
_TOKEN = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,63}\Z")
_LINE_BREAK = re.compile(r"[\t\r\n]")


def _from_base64(b64):
    """Standard base64 back to UTF-8 text; raises on anything but the canonical encoding."""
    raw = base64.b64decode(b64, validate=True)
    text = raw.decode("utf-8")
    if base64.b64encode(raw).decode("ascii") != b64:
        raise ValueError("not canonical base64")
    return text


def _text(v, max_chars, min_chars):
    return isinstance(v, str) and not _LINE_BREAK.search(v) and min_chars <= len(v) <= max_chars


def decode_gate_rule_record(line):
    """An @rule line as a record dict (payload fields plus kind, fallbackId and rollout), or None."""
    f = line.split("\t")
    if len(f) != 5 or f[0] != RULE_RECORD_TAG or not f[4]:
        return None
    kind = f[2]
    if kind not in _FIELDS:
        return None
    try:
        r = json.loads(_from_base64(f[4]))
    except (ValueError, binascii.Error, UnicodeDecodeError):
        return None
    if not isinstance(r, dict) or sorted(r.keys()) != _FIELDS[kind]:
        return None
    if f[3] not in ("shadow", "enforce"):
        return None
    r = dict(r, kind=kind, fallbackId=None if f[1] == "-" else f[1], rollout=f[3])
    if r["v"] != 1 or isinstance(r["v"], bool):
        return None
    if not _text(r["sopTitle"], RULE_SOP_TITLE_MAX_CHARS, 0) or not isinstance(r["ref"], str):
        return None
    m = _REF.match(r["ref"])
    if not m or m.group(1) != kind:
        return None
    if r["rollout"] == "enforce":
        fid = r["fallbackId"]
        if not isinstance(fid, str) or not re.match(r"^" + kind + "-fallback:" + m.group(2) + r"@[0-9a-f]{12}\Z", fid):
            return None
    elif r["fallbackId"] is not None:
        return None
    if kind == "requires_outcome":
        if r["first"] != "action:run_tests" or r["qualifier"] != "ok" or not isinstance(r["adjacent"], bool):
            return None
        if not isinstance(r["then"], str) or not _TOKEN.match(r["then"]) or r["then"] == "action:run_tests":
            return None
    elif kind == "scope_paths":
        paths = r["scopePaths"]
        if not isinstance(paths, list) or not 1 <= len(paths) <= RULE_SCOPE_PATHS_MAX:
            return None
        if any(not _text(p, RULE_SCOPE_PATH_MAX_CHARS, 1) for p in paths):
            return None
    elif r["mode"] not in ("required", "strict"):
        return None
    return r


def gate_rule_fallback_reason(kind, sop_title):
    if kind == "requires_outcome":
        return ("Qualified requires_before (" + sop_title + "): this gate cannot read test results, so the call "
                "it gates is refused; upgrade the Intutic gate")
    if kind == "scope_paths":
        return ("scope_paths_mode: enforce (" + sop_title + "): this gate cannot check a change against the "
                "scope, so every file change is refused; upgrade the Intutic gate")
    return ("plan_approval (" + sop_title + "): this gate cannot check plan approval, so every call is refused; "
            "upgrade the Intutic gate")


def _escape(s):
    return re.sub(r"([.*+?^(){}$|\[\]\\])", r"\\\1", s)


def gate_rule_fallback(record):
    """The fallback line an older gate refuses with in the record's place, or None for a shadow record."""
    if record["fallbackId"] is None:
        return None
    base = {"id": record["fallbackId"], "severity": "block", "reason": gate_rule_fallback_reason(record["kind"], record["sopTitle"])}
    if record["kind"] == "plan_approval":
        return dict(base, subject="tool", source=" [^ ]+ ", ignoreCase=False)
    if record["kind"] == "scope_paths":
        tools = SCOPE_WRITE_TOOLS + SCOPE_EDIT_TOOLS + SCOPE_DELETE_TOOLS + SCOPE_MOVE_TOOLS + SCOPE_EDITOR_TOOLS
        return dict(base, subject="tool", source=" [^ ]*(" + "|".join(_escape(t) for t in tools) + ") ", ignoreCase=True)
    then = record["then"]
    if then in V22_ACTION_TOKENS:
        return dict(base, subject="action", source=" (" + _escape(then) + ") ", ignoreCase=True)
    if then.startswith("action:"):
        phrases = LANE_PHRASES.get(then) or []
        if phrases:
            return dict(base, subject="phrase", source="|".join(phrases), ignoreCase=True)
        return dict(base, subject="tool", source=" [^ ]*(" + "|".join(_escape(t) for t in SCOPE_SHELL_TOOLS) + ") ",
                    ignoreCase=True)
    return dict(base, subject="tool", source=" (" + _escape(then) + ") ", ignoreCase=False)


def gate_rule_plan_from_response(status, body):
    """The session's plan from GET /api/v1/plans/session/:id ({"status": approved|none|unavailable})."""
    if status == 404:
        return {"status": "none"}
    if status != 200 or not isinstance(body, dict):
        return {"status": "unavailable"}
    if body.get("lifecycleState") not in ("APPROVED", "EXECUTING"):
        return {"status": "none"}
    tools = []
    steps = body.get("steps")
    for step in steps if isinstance(steps, list) else []:
        if not isinstance(step, dict):
            continue
        tool = step.get("tool") if isinstance(step.get("tool"), str) else step.get("toolName")
        if isinstance(tool, str) and tool.strip() and tool.strip() not in tools:
            tools.append(tool.strip())
    return {"status": "approved", "tools": tools}


def _plan_finding(records, call):
    if not records or is_plan_exempt_tool(call["tool"]):
        return None
    rec = next((r for r in records if r["mode"] == "strict"), records[0])
    rule_id = "plan_approval." + rec["sopTitle"]
    scope = {"tools": [call["tool"]]}
    head = "plan_approval: " + rec["mode"] + " (" + rec["sopTitle"] + "): "
    if call["sessionId"] == "":
        return {"code": "PLAN_NOT_APPROVED", "ruleId": rule_id, "scope": scope, "ref": rec["ref"],
                "reason": head + call["harness"] + " sent no session id, so no approved plan can be found for this session"}
    plan = call["plan"]
    if plan["status"] != "approved":
        why = "this session has no approved plan" if plan["status"] == "none" else "the approved plans could not be read"
        return {"code": "PLAN_NOT_APPROVED", "ruleId": rule_id, "scope": scope, "ref": rec["ref"],
                "reason": head + why + "; get the plan approved, then retry"}
    if rec["mode"] == "strict":
        tool = call["tool"].lower()
        if not any(t.lower() == tool for t in plan["tools"]):
            return {"code": "OFF_PLAN", "ruleId": rule_id, "scope": scope, "ref": rec["ref"],
                    "reason": call["tool"] + " is not a step of this session's approved plan (plan_approval: strict, "
                    + rec["sopTitle"] + ")"}
    return None


def _requires_finding(records, call):
    tool = call["tool"].lower()
    for rec in records:
        if rec["then"] not in call["actions"] and rec["then"].lower() != tool:
            continue
        why = None
        if not call["observable"]:
            case = "not_observable"
        elif call["sessionId"] == "":
            case = "no_session"
        else:
            case, why = prerequisite_case(call["outcomes"], rec["first"], rec["adjacent"], call["nowMs"])
        if case == "met":
            continue
        return {
            "code": "PREREQUISITE_UNMET",
            "ruleId": "requires_before." + rec["first"] + "[ok]" + ("~>" if rec["adjacent"] else "->") + rec["then"],
            "reason": prerequisite_unmet_reason(rec["first"], rec["then"], case, why, call["harness"]),
            "scope": {"tools": [rec["then"]], "step": rec["first"]},
            "ref": rec["ref"],
        }
    return None


def _scope_finding(records, call):
    if not records:
        return None
    targets = change_targets(call["tool"], call["input"])
    if not targets:
        return None
    scopes = []
    for r in records:
        for p in r["scopePaths"]:
            if p not in scopes:
                scopes.append(p)
    outside = []
    for t in targets:
        rel = scope_relative_path(t["target"], call["cwd"], call["root"])
        if (rel is None or not is_within_scope(rel, scopes)) and t["target"] not in outside:
            outside.append(t["target"])
    if not outside:
        return None
    rec = records[0]
    return {
        "code": "OUT_OF_SCOPE",
        "ruleId": "scope_paths." + rec["sopTitle"],
        "reason": "Changes outside the declared file scope: " + ", ".join(outside) + " (scope: " + ", ".join(scopes) + ")",
        "scope": {"paths": outside},
        "ref": rec["ref"],
    }


def _findings(records, call):
    out = []
    for finding in (
        _plan_finding([r for r in records if r["kind"] == "plan_approval"], call),
        _requires_finding([r for r in records if r["kind"] == "requires_outcome"], call),
        _scope_finding([r for r in records if r["kind"] == "scope_paths"], call),
    ):
        if finding is not None:
            out.append(finding)
    return out


def evaluate_gate_rule_records(records, call):
    """Tier R: {"refusal": the first enforcing finding or None, "shadow": the shadow records' findings}.

    'call' carries tool, input, actions, cwd, root, sessionId, harness,
    outcomes (a state dict or None), observable, plan and nowMs, as in
    gateRuleRecord.ts GateRuleCall.
    """
    enforce = _findings([r for r in records if r["rollout"] == "enforce"], call)
    return {"refusal": enforce[0] if enforce else None,
            "shadow": _findings([r for r in records if r["rollout"] == "shadow"], call)}
`
