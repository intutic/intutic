"""Evaluating one tool call's decide rules against the engine, inside the
engine protections.

A transliteration of packages/shared-types/src/decideEvaluate.ts; read its
docstring for the design. In short: nothing is asked unless the deterministic
tiers allowed the call; a rule enforces only when its author wrote enforce,
the snapshot stamped it enforce and one of its pins (earned under its own rule
hash) is for the model digest the engine reports; and a known-answer canary,
cached per engine URL and digest in ``~/.intutic/decide/canary.json`` for ten
minutes, runs beside the rule's questions when the cache is missing, failed or
stale. A failed canary discards every answer: the engine is unavailable, which
refuses an enforcing rule with GOVERNANCE_UNAVAILABLE. With the engine's
per-call p95 (``q95Ms``, which ``intutic doctor`` stores in engine.json), a
rule whose estimate does not fit the time left is not asked: an enforcing one
escalates, a shadow one is logged and allowed.

All three ports run the ``rollout`` and ``evaluate`` cases of
packages/shared-types/fixtures/decide-engine-vectors.json.
"""

from __future__ import annotations

import json
import math
import os
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import decide
from .decide_engine import (
    DecideEngineError,
    DecideQuestionCall,
    build_decide_tool_call_state,
    decide_engine_error_outcome,
    run_decide_canary,
)

#: A canary result older than this is run again.
DECIDE_CANARY_TTL_MS = 600_000
#: The most engine and digest pairs the cache file keeps, newest last.
_CANARY_ENTRIES_MAX = 16


def default_canary_path() -> Path:
    return Path.home() / ".intutic" / "decide" / "canary.json"


# ---------------------------------------------------------------------------
# Effective rollout (protections 4 and 5)
# ---------------------------------------------------------------------------


def decide_effective_rollout(entry: Dict[str, Any], model_digest: Optional[str]) -> Dict[str, Any]:
    """``{"effective", "why", "pin"}`` for a record-shaped ``entry`` (``ir``,
    ``rollout``, ``stampedBy``, ``pins``). Enforce only when the author wrote
    enforce, the snapshot stamped it, and a pin is for ``model_digest``; a None
    digest (the engine could not say) leaves a stamped rule enforcing."""
    if entry["ir"].get("rollout") != "enforce":
        return {"effective": "shadow", "why": "rollout", "pin": None}
    if entry["rollout"] != "enforce":
        stamp = entry["stampedBy"]
        return {"effective": "shadow", "why": "rollout" if stamp == "rule" else stamp, "pin": None}
    if not entry["pins"]:
        return {"effective": "shadow", "why": "no-pins", "pin": None}
    if model_digest is None:
        return {"effective": "enforce", "why": None, "pin": None}
    pin = next((p for p in entry["pins"] if p["modelDigest"] == model_digest), None)
    if pin is None:
        return {"effective": "shadow", "why": "not_evaluated", "pin": None}
    return {"effective": "enforce", "why": None, "pin": pin}


# ---------------------------------------------------------------------------
# The canary cache (protection 6)
# ---------------------------------------------------------------------------


def decide_canary_fresh(entry: Optional[Dict[str, Any]], now_ms: float) -> bool:
    """A passed result younger than the TTL. A failed one is never fresh."""
    return (entry is not None and entry["ok"] is True and entry["atMs"] <= now_ms
            and now_ms - entry["atMs"] < DECIDE_CANARY_TTL_MS)


def _number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _canary_entry(v: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(v, dict):
        return None
    if not isinstance(v.get("url"), str) or not isinstance(v.get("modelDigest"), str) or not isinstance(v.get("ok"), bool):
        return None
    if not all(_number(v.get(k)) for k in ("atMs", "pViolation", "pClean")) or not isinstance(v.get("choiceTop"), str):
        return None
    return {k: v[k] for k in ("url", "modelDigest", "ok", "atMs", "pViolation", "pClean", "choiceTop")}


class CanaryFileStore:
    """The canary cache as one JSON file, ``{"v":1,"entries":[...]}``, mode
    0600 in a 0700 directory, replaced whole so a reader never sees half of
    it. A file that does not read is an empty cache, and the canary runs."""

    def __init__(self, path: Optional[os.PathLike] = None):
        self.path = Path(path) if path is not None else default_canary_path()

    def _all(self) -> List[Dict[str, Any]]:
        try:
            doc = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        if not isinstance(doc, dict) or doc.get("v") != 1 or not isinstance(doc.get("entries"), list):
            return []
        return [e for e in (_canary_entry(x) for x in doc["entries"]) if e is not None]

    def read(self, url: str, model_digest: str) -> Optional[Dict[str, Any]]:
        return next((e for e in self._all() if e["url"] == url and e["modelDigest"] == model_digest), None)

    def write(self, entry: Dict[str, Any]) -> None:
        entries = [e for e in self._all() if e["url"] != entry["url"] or e["modelDigest"] != entry["modelDigest"]]
        entries = (entries + [entry])[-_CANARY_ENTRIES_MAX:]
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, tmp = tempfile.mkstemp(prefix=self.path.name + ".", suffix=".tmp", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps({"v": 1, "entries": entries}, separators=(",", ":")) + "\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


# ---------------------------------------------------------------------------
# One call
# ---------------------------------------------------------------------------


@dataclass
class DecideRuleReport:
    ref: str
    rule_hash: str
    effective: str
    why: Optional[str]
    #: allow | refuse | escalate | unavailable
    outcome: str
    code: Optional[str]
    via: Optional[str]
    #: The engine error that made the rule unavailable or unknown, or
    #: "budget_skip": its estimate did not fit the time left, so it was not asked.
    error: Optional[str]
    model_digest: Optional[str]
    #: None when nothing came back, or when a failed canary discarded it.
    answers: Optional[Dict[str, Any]]


@dataclass
class DecideEvaluation:
    call: Dict[str, Any]
    rules: List[DecideRuleReport]
    skipped: List[str]
    #: The engine's identity before the questions (``describe``), or None.
    engine: Optional[Dict[str, str]]
    #: "cached", "ok", "failed" (answered wrongly), or None when not needed
    #: or when the engine gave the canary no answer.
    canary: Optional[str]


_ALLOW = {"outcome": "allow", "code": None, "ruleRef": None, "via": None, "reason": None}


def _error_code(err: BaseException) -> str:
    return err.code if isinstance(err, DecideEngineError) else "bad_response"


# ---------------------------------------------------------------------------
# The latency budget
# ---------------------------------------------------------------------------


def decide_rule_calls(rule: Dict[str, Any]) -> int:
    """The engine calls one evaluation of ``rule`` makes: a yes/no question
    one, a choice two, or three past three options (none_of_these counted)."""
    n = 0
    for q in rule["questions"].values():
        n += 1 if q["type"] == "yes_no" else (3 if len(decide.decide_options(q)) > 3 else 2)
    return n


def decide_rule_estimate_ms(rule: Dict[str, Any], q95_ms: float, parallel: int) -> int:
    """The estimated time to evaluate ``rule``: the per-call p95 times its calls over ``parallel``."""
    # Rounded half up, as JavaScript's Math.round, not Python's half to even.
    return int(math.floor(q95_ms * math.ceil(decide_rule_calls(rule) / max(1, parallel)) + 0.5))


def decide_stored_q95_ms(file: Any) -> Optional[float]:
    """The per-call p95 ``intutic doctor`` stored in engine.json (``q95Ms``,
    parsed), or None when there is none."""
    v = file.get("q95Ms") if isinstance(file, dict) else None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0:
        return None
    return v


def evaluate_decide_call(
    *,
    deterministic: str,
    tool: str,
    tool_input: Any,
    cwd: str,
    rules: List[Dict[str, Any]],
    deadline_s: float,
    engine: Any,
    engine_url: str,
    canary: CanaryFileStore,
    last_user_turn: Optional[str] = None,
    now_ms=lambda: time.time() * 1000,
    q95_ms: Optional[float] = None,
    parallel: int = 1,
) -> DecideEvaluation:
    """Evaluates the decide rules a tool call matches. ``rules`` are decoded
    ``@decide`` records, in snapshot order; ``engine`` is a DecideEngine (or
    anything with its ``ask`` and ``describe``), or the DecideEngineError that
    creating it raised; ``deadline_s`` is an absolute time.monotonic() time.
    Never raises on an engine error: the rule is unavailable (or, for
    too_large, unknown).

    With the engine's p95 (``q95_ms``, see decide_stored_q95_ms), a rule
    whose estimate does not fit the time left before ``deadline_s`` is not
    asked: its report carries ``budget_skip`` and it is unknown. An enforcing
    one escalates (or refuses, with ``escalate: refuse``); a shadow one is
    allowed. The rest are asked."""
    args = dict(deterministic=deterministic, tool=tool, tool_input=tool_input, cwd=cwd, deadline_s=deadline_s,
                engine=engine, engine_url=engine_url, canary=canary, last_user_turn=last_user_turn, now_ms=now_ms)
    if q95_ms is None or deterministic != "allow":
        return _evaluate_decide_rules(rules=rules, **args)
    left_ms = (deadline_s - time.monotonic()) * 1000
    in_budget, over_budget = [], []
    for r in rules:
        v = decide.validate_decide_rule(r["ir"])
        named = r["ir"].get("on") == "tool_call" and tool in (r["ir"].get("tools") or [])
        if named and v["ok"] and decide_rule_estimate_ms(v["rule"], q95_ms, parallel) > left_ms:
            over_budget.append(r)
        else:
            in_budget.append(r)
    ev = _evaluate_decide_rules(rules=in_budget, **args)
    if not over_budget:
        return ev

    digest = ev.engine["model_digest"] if ev.engine else None
    skipped = []
    for r in over_budget:
        v = decide.validate_decide_rule(r["ir"])
        pins = r["pins"] if v["ok"] and decide.decide_rule_hash(v["rule"]) == r["ruleHash"] else []
        eff = decide_effective_rollout(dict(r, pins=pins), digest)
        escalate = (v["rule"].get("escalate") if v["ok"] else None) or "ask"
        base = dict(ref=r["ref"], rule_hash=r["ruleHash"], effective=eff["effective"], why=eff["why"],
                    error="budget_skip", model_digest=digest, answers=None)
        if eff["effective"] == "shadow":
            skipped.append(DecideRuleReport(**base, outcome="allow", code=None, via=None))
        elif escalate == "refuse":
            skipped.append(DecideRuleReport(**base, outcome="refuse", code="DECIDE_ESCALATED", via=None))
        else:
            skipped.append(DecideRuleReport(**base, outcome="escalate", code="DECIDE_ESCALATED", via=escalate))
    reports = ev.rules + skipped
    # A refusal for too many rules on the tool comes before any rule is asked, and stands.
    if not ev.rules and ev.call["outcome"] != "allow":
        call = ev.call
    else:
        results = [{"ref": r.ref, "effective": r.effective, "outcome": r.outcome, "code": r.code, "via": r.via}
                   for r in reports]
        call = decide.decide_call_outcome({"unavailable": None}, results)
    return DecideEvaluation(call, reports, ev.skipped, ev.engine, ev.canary)


def _evaluate_decide_rules(
    *,
    deterministic: str,
    tool: str,
    tool_input: Any,
    cwd: str,
    rules: List[Dict[str, Any]],
    deadline_s: float,
    engine: Any,
    engine_url: str,
    canary: CanaryFileStore,
    last_user_turn: Optional[str],
    now_ms,
) -> DecideEvaluation:
    """evaluate_decide_call on every rule it is given, with no budget estimate."""
    if deterministic != "allow":
        refused = {"outcome": "refuse", "code": None, "ruleRef": None, "via": None,
                   "reason": "a deterministic rule refused the call"}
        return DecideEvaluation(refused, [], [], None, None)
    matched = [r for r in rules if r["ir"].get("on") == "tool_call" and tool in (r["ir"].get("tools") or [])]
    if not matched:
        return DecideEvaluation(dict(_ALLOW), [], [], None, None)

    client = None if isinstance(engine, DecideEngineError) else engine
    engine_error = engine.code if isinstance(engine, DecideEngineError) else None
    identity = None
    if client is not None:
        try:
            identity = client.describe(deadline_s)
        except Exception as err:  # noqa: BLE001 - every engine failure is unavailability
            engine_error = _error_code(err)
    described = identity["model_digest"] if identity else None

    entries = []
    for r in matched:
        v = decide.validate_decide_rule(r["ir"])
        # Pins are earned by one rule hash: a rule whose hash is not the one its
        # pins were stored under has none.
        pins = r["pins"] if v["ok"] and decide.decide_rule_hash(v["rule"]) == r["ruleHash"] else []
        entry = dict(r, pins=pins)
        entries.append({"entry": entry, "v": v, "pre": decide_effective_rollout(entry, described)})
    selection = decide.select_decide_rules(
        [{"ref": e["entry"]["ref"], "on": e["entry"]["ir"].get("on"), "tools": e["entry"]["ir"].get("tools"),
          "effective": e["pre"]["effective"], "e": e} for e in entries],
        tool,
    )
    skipped = [c["ref"] for c in selection["skipped"]]
    if selection["unavailable"]:
        return DecideEvaluation(decide.decide_call_outcome(selection, []), [], skipped, identity, None)

    def ask_rule(e):
        if client is None or engine_error:
            return None, engine_error or "not_configured", None
        if not e["v"]["ok"]:
            return None, "bad_response", None
        rule = e["v"]["rule"]
        questions = [
            DecideQuestionCall(name, "choice", q["ask"], tuple(decide.decide_options(q))) if q["type"] == "choice"
            else DecideQuestionCall(name, "yes_no", q["ask"])
            for name, q in rule["questions"].items()
        ]
        try:
            context = {"last_user_turn": last_user_turn} if "last_user_turn" in (rule.get("context") or []) else {}
            state = build_decide_tool_call_state(
                rule_id=rule["id"], sop_title=e["entry"]["sopTitle"], rule_text=e["entry"]["ruleText"],
                tool=tool, cwd=cwd, tool_input=tool_input, **context,
            )
            res = client.ask(state, questions, deadline_s)
            return res.answers, None, res.model_digest
        except Exception as err:  # noqa: BLE001 - every engine failure is unavailability
            return None, _error_code(err), None

    canary_state = None
    canary_job = None
    if client is not None and not engine_error and identity:
        if decide_canary_fresh(canary.read(engine_url, described), now_ms()):
            canary_state = "cached"
        else:
            # None on a pass; "canary_failed" when the canary was answered
            # wrongly; the engine's own error code (upstream, timeout) when
            # it got no answer at all.
            def run_canary():
                try:
                    r = run_decide_canary(client.ask, deadline_s)
                except Exception as err:  # noqa: BLE001 - an engine that cannot answer it is unavailable
                    return _error_code(err)
                try:
                    canary.write({"url": engine_url, "modelDigest": described, "ok": r.ok, "atMs": now_ms(),
                                  "pViolation": r.p_violation, "pClean": r.p_clean, "choiceTop": r.choice_top})
                except OSError:
                    pass  # An unwritable cache only means the canary runs again next call.
                return None if r.ok else "canary_failed"
            canary_job = run_canary

    evaluated = selection["evaluate"]
    with ThreadPoolExecutor(max_workers=len(evaluated) + 1) as pool:
        canary_future = pool.submit(canary_job) if canary_job else None
        asked = [f.result() for f in [pool.submit(ask_rule, c["e"]) for c in evaluated]]
        canary_error = canary_future.result() if canary_future else None
    if canary_job:
        canary_state = "ok" if canary_error is None else "failed" if canary_error == "canary_failed" else None

    reports: List[DecideRuleReport] = []
    for c, (answers, error, digest) in zip(evaluated, asked):
        e = c["e"]
        digest = digest or described
        eff = decide_effective_rollout(e["entry"], digest)
        base = dict(ref=e["entry"]["ref"], rule_hash=e["entry"]["ruleHash"], effective=eff["effective"],
                    why=eff["why"], model_digest=digest)
        if canary_error is not None:
            # A canary that got no answer: the rule's own engine error when it
            # has one (it asked the same engine), else the canary's.
            own = canary_error != "canary_failed" and error and decide_engine_error_outcome(error) == "unavailable"
            reports.append(DecideRuleReport(**base, outcome="unavailable", code=None, via=None,
                                            error=error if own else canary_error, answers=None))
            continue
        if error and decide_engine_error_outcome(error) == "unavailable":
            reports.append(DecideRuleReport(**base, outcome="unavailable", code=None, via=None, error=error, answers=None))
            continue
        if not e["v"]["ok"]:
            reports.append(DecideRuleReport(**base, outcome="unavailable", code=None, via=None, error="bad_response", answers=None))
            continue
        inputs = {name: {"p": a.p, "perOrder": a.per_order} for name, a in (answers or {}).items()}
        # A pin's fitted combiner replaces `when`. Its per-question temperatures
        # are not applied here.
        pin = eff["pin"]
        combiner = None
        if pin and pin.get("combiner"):
            rule = e["v"]["rule"]
            combiner = {"bias": pin["combiner"]["bias"], "weights": pin["combiner"]["weights"],
                        "band": pin.get("band") or rule.get("band") or decide.DECIDE_DEFAULT_BAND}
        o = decide.decide_rule_outcome(e["v"]["rule"], e["v"]["expr"], inputs, combiner)
        reports.append(DecideRuleReport(**base, outcome=o["outcome"], code=o["code"], via=o["via"], error=error, answers=answers))

    results = [{"ref": r.ref, "effective": r.effective, "outcome": r.outcome, "code": r.code, "via": r.via} for r in reports]
    return DecideEvaluation(decide.decide_call_outcome(selection, results), reports, skipped, identity, canary_state)


# ---------------------------------------------------------------------------
# What a gate says (decideDecision and its helpers in decideEvaluate.ts)
# ---------------------------------------------------------------------------


def _unknown_questions(entry: Dict[str, Any], answers: Optional[Dict[str, Any]]) -> List[str]:
    """The asks of the questions a rule could not answer: a yes/no between its
    bands, a choice none of whose options cleared yes_at while one stayed
    unknown. Every question when none can be named."""
    v = decide.validate_decide_rule(entry["ir"])
    if not v["ok"]:
        return []
    rule = v["rule"]
    names = list(rule["questions"])
    if answers:
        inputs = {n: {"p": a.p, "perOrder": a.per_order} for n, a in answers.items()}
        atoms = decide.decide_atoms(rule, inputs)

        def unknown(name):
            if name in atoms["yes"]:
                return atoms["yes"][name] == "U"
            values = list(atoms["eq"].get(name, {}).values())
            return "T" not in values and "U" in values

        named = [n for n in names if unknown(n)]
        if named:
            return [rule["questions"][n]["ask"] for n in named]
    return [rule["questions"][n]["ask"] for n in names]


def _rule_reason(report: DecideRuleReport, entry: Dict[str, Any]) -> str:
    title = entry["ir"].get("title") or entry["sopTitle"]
    if report.error == "budget_skip" and report.outcome != "allow":
        return (f"Needs a person: {title} — the decide engine cannot answer rule {entry['ir']['id']} "
                "within this call's time budget")
    if report.outcome == "unavailable":
        return (f"GOVERNANCE_UNAVAILABLE — the decide engine could not evaluate rule {entry['ir']['id']} "
                f"({title}): {report.error or 'unavailable'}")
    if report.code == "DECIDE_REFUSED":
        return f"Decide rule {entry['ir']['id']} ({title}) refused this call"
    return f"Needs a person: {title} — " + " ".join(_unknown_questions(entry, report.answers))


def decide_decision(ev: DecideEvaluation, rules: List[Dict[str, Any]]) -> Dict[str, Any]:
    """``{"outcome", "code", "ruleId", "via", "reason"}``: what a gate acts on
    for a call's evaluation of ``rules``, the reason without the rule id."""
    call = ev.call
    if call["outcome"] == "allow":
        return {"outcome": "allow", "code": None, "ruleId": None, "via": None, "reason": ""}
    ref = call["ruleRef"]
    entry = next((r for r in rules if r["ref"] == ref), None)
    report = next((r for r in ev.rules if r.ref == ref), None)
    if entry is not None and report is not None:
        reason = _rule_reason(report, entry)
    else:
        reason = "GOVERNANCE_UNAVAILABLE — " + (call.get("reason") or "the decide rules for this call could not be evaluated")
    return {"outcome": call["outcome"], "code": call["code"], "ruleId": None if ref is None else f"decide.{ref}",
            "via": (call.get("via") or "ask") if call["outcome"] == "escalate" else None, "reason": reason}


def decide_shadow_findings(ev: DecideEvaluation, rules: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """The evaluated shadow rules that would have refused, escalated or found
    the engine unavailable: what a gate records while the call goes on."""
    out = []
    for report in ev.rules:
        if report.effective != "shadow" or report.outcome == "allow":
            continue
        entry = next((r for r in rules if r["ref"] == report.ref), None)
        if entry is not None:
            out.append({"ruleId": f"decide.{report.ref}", "reason": _rule_reason(report, entry)})
    return out


def decide_unavailable_decision(rules: List[Dict[str, Any]], tool: str, why: str) -> Dict[str, Any]:
    """The decision when the evaluation could not run or finish: refuse with
    GOVERNANCE_UNAVAILABLE under the first matched rule stamped enforce,
    unless every rule on the tool is stamped shadow, which allows."""
    matched = [r for r in rules if r["ir"].get("on") == "tool_call" and tool in (r["ir"].get("tools") or [])]
    enforcing = next((r for r in matched if r["rollout"] == "enforce"), None)
    if enforcing is None:
        return {"outcome": "allow", "code": None, "ruleId": None, "via": None, "reason": ""}
    return {"outcome": "refuse", "code": "GOVERNANCE_UNAVAILABLE", "ruleId": f"decide.{enforcing['ref']}", "via": None,
            "reason": f"GOVERNANCE_UNAVAILABLE — {why}"}
