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
refuses an enforcing rule with GOVERNANCE_UNAVAILABLE.

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
    #: The engine error that made the rule unavailable or unknown.
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
    #: "cached", "ok", "failed", or None when not needed.
    canary: Optional[str]


_ALLOW = {"outcome": "allow", "code": None, "ruleRef": None, "via": None, "reason": None}


def _error_code(err: BaseException) -> str:
    return err.code if isinstance(err, DecideEngineError) else "bad_response"


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
) -> DecideEvaluation:
    """Evaluates the decide rules a tool call matches. ``rules`` are decoded
    ``@decide`` records, in snapshot order; ``engine`` is a DecideEngine (or
    anything with its ``ask`` and ``describe``), or the DecideEngineError that
    creating it raised; ``deadline_s`` is an absolute time.monotonic() time.
    Never raises on an engine error: the rule is unavailable (or, for
    too_large, unknown)."""
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
            def run_canary():
                try:
                    r = run_decide_canary(client.ask, deadline_s)
                except Exception:  # noqa: BLE001 - an engine that cannot answer it has failed it
                    return False
                try:
                    canary.write({"url": engine_url, "modelDigest": described, "ok": r.ok, "atMs": now_ms(),
                                  "pViolation": r.p_violation, "pClean": r.p_clean, "choiceTop": r.choice_top})
                except OSError:
                    pass  # An unwritable cache only means the canary runs again next call.
                return r.ok
            canary_job = run_canary

    evaluated = selection["evaluate"]
    with ThreadPoolExecutor(max_workers=len(evaluated) + 1) as pool:
        canary_future = pool.submit(canary_job) if canary_job else None
        asked = [f.result() for f in [pool.submit(ask_rule, c["e"]) for c in evaluated]]
        canary_ok = canary_future.result() if canary_future else True
    if canary_job:
        canary_state = "ok" if canary_ok else "failed"

    reports: List[DecideRuleReport] = []
    for c, (answers, error, digest) in zip(evaluated, asked):
        e = c["e"]
        digest = digest or described
        eff = decide_effective_rollout(e["entry"], digest)
        base = dict(ref=e["entry"]["ref"], rule_hash=e["entry"]["ruleHash"], effective=eff["effective"],
                    why=eff["why"], model_digest=digest)
        if not canary_ok:
            reports.append(DecideRuleReport(**base, outcome="unavailable", code=None, via=None, error="canary_failed", answers=None))
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
