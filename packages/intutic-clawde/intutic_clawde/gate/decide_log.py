"""The decide log, and the drift alarm it feeds.

A transliteration of packages/shared-types/src/decideLog.ts; read its
docstring for the design. Every process that evaluates a call's decide rules
appends one line to ``~/.intutic/logs/decide-YYYY-MM-DD.jsonl`` (UTC date),
mode 0600, with a single append write: the hash of each state sent, the rule
hashes, the model digest, every answer's probability and band, the outcome and
the mode, and the arguments only after redaction, cut to 2,048 bytes. A line
is at most 8,192 bytes; the excerpt is shortened first.

Drift (engine protection 8): each rule keeps its last 200 decisions in
``~/.intutic/decide/stats/<ruleHash>.json``; against the eval run its pin
came from, ``decide.drift`` fires when the escalation rate moves more than
0.15 from the run's, or a question's median probability leaves the run's
[p10, p90], at most once a day per rule and only once 20 decisions are kept.

Both ports run packages/shared-types/fixtures/decide-log-vectors.json.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence
from urllib.parse import urlsplit

from . import decide
from .decide_engine import build_decide_tool_call_state, decide_canonical_json

DECIDE_LOG_LINE_MAX_BYTES = 8192
DECIDE_ARGS_EXCERPT_MAX_BYTES = 2048
DECIDE_LOG_RETENTION_DAYS = 30
DECIDE_STATS_KEEP = 200
DECIDE_DRIFT_MIN_DECISIONS = 20
DECIDE_DRIFT_ESCALATION_DELTA = 0.15
DECIDE_DRIFT_INTERVAL_MS = 86_400_000
DECIDE_REDACTED = "[REDACTED]"

#: The excerpt's redaction patterns: the gate's credential-value patterns and
#: the PII detectors' regexes, without their validators, so a stored excerpt
#: loses more than live traffic would, never less. The vectors file pins the
#: list to the TypeScript one.
DECIDE_LOG_REDACTION_SOURCES = (
    "(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)" + "[A-Z2-7]" * 16,
    "sk-ant-" + "[A-Za-z0-9_-]" * 20 + "[A-Za-z0-9_-]*",
    "gh[pousr]_" + "[A-Za-z0-9]" * 36,
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "sk-or-v1-" + "[A-Za-z0-9]" * 20 + "[A-Za-z0-9]*",
    "vk_" + "[a-f0-9]" * 32,
    "gwk_" + "[a-f0-9]" * 64,
    "sk_live_" + "[A-Za-z0-9]" * 24,
    "[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{4}|[0-9]{4}[ -][0-9]{6}[ -][0-9]{4,5}|[0-9]{13,19}",
    "[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){11,30}",
    "[0-9]{3}-[0-9]{2}-[0-9]{4}",
    "[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63}){1,8}",
    "\\+[1-9][0-9]{0,2}(?:[ .-]?\\([0-9]{1,4}\\)|[ .-]?[0-9]{1,4}){2,7}"
    "|(?:1[ .-])?(?:\\([2-9][0-9]{2}\\) ?|[2-9][0-9]{2}[ .-])[2-9][0-9]{2}[ .-][0-9]{4}",
)


def default_logs_dir() -> Path:
    return Path.home() / ".intutic" / "logs"


def default_stats_dir() -> Path:
    return Path.home() / ".intutic" / "decide" / "stats"


def default_decide_dir() -> Path:
    return Path.home() / ".intutic" / "decide"


# ---------------------------------------------------------------------------
# Files and text
# ---------------------------------------------------------------------------


def _iso(at_ms: float) -> str:
    dt = datetime.fromtimestamp(at_ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(at_ms) % 1000:03d}Z"


def decide_log_file_name(at_ms: float, kind: str = "decide") -> str:
    """``decide-YYYY-MM-DD.jsonl`` for the UTC date of ``at_ms``; ``decide-state-…`` for raw states."""
    return f"{kind}-{_iso(at_ms)[:10]}.jsonl"


def decide_log_file_date(name: str) -> Optional[int]:
    m = re.fullmatch(r"decide(?:-state)?-([0-9]{4}-[0-9]{2}-[0-9]{2})\.jsonl", name)
    if not m:
        return None
    try:
        dt = datetime.strptime(m.group(1), "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return int(dt.timestamp() * 1000)


def decide_utf8_prefix(s: str, top: int) -> str:
    out = []
    n = 0
    for ch in s:
        b = len(ch.encode("utf-8"))
        if n + b > top:
            break
        n += b
        out.append(ch)
    return "".join(out)


def decide_redact(text: str, sources: Sequence[str]) -> str:
    out = text
    for source in sources:
        try:
            pattern = re.compile(source)
        except re.error:
            continue
        out = pattern.sub(DECIDE_REDACTED, out)
    return out


def decide_args_excerpt(tool_input: Any, sources: Sequence[str], max_bytes: int = DECIDE_ARGS_EXCERPT_MAX_BYTES) -> str:
    return decide_utf8_prefix(decide_redact(decide_canonical_json({} if tool_input is None else tool_input), sources), max_bytes)


# ---------------------------------------------------------------------------
# The decision record
# ---------------------------------------------------------------------------


def _eq_atoms(e: Dict[str, Any], out: List[str]) -> List[str]:
    op = e["op"]
    if op == "eq":
        key = f"{e['q']} == {e['o']}"
        if key not in out:
            out.append(key)
    elif op == "not":
        _eq_atoms(e["a"], out)
    elif op in ("and", "or"):
        _eq_atoms(e["a"], out)
        _eq_atoms(e["b"], out)
    return out


def _log_answer(rule: Dict[str, Any], expr: Optional[Dict[str, Any]], name: str, a: Any) -> Optional[Dict[str, Any]]:
    q = rule["questions"].get(name)
    if q is None:
        return None
    band = decide.decide_question_band(rule, name)
    pair = [band["no_below"], band["yes_at"]]
    if q["type"] == "yes_no":
        p = a.p if isinstance(a.p, (int, float)) else None
        return {"type": "yes_no", "p": p, "pRaw": p, "value": "U" if p is None else decide.band_value(p, band), "band": pair}
    atoms = decide.choice_atoms(decide.decide_options(q), a.per_order or [], band)
    used = [k for k in _eq_atoms(expr, []) if k.startswith(f"{name} == ")] if expr else []
    return {
        "type": "choice",
        "p": {o: c["p"] for o, c in atoms.items()},
        "spread": {o: c["spread"] for o, c in atoms.items()},
        "atoms": {k: atoms.get(k[len(name) + 4:], {}).get("value", "U") for k in used},
        "band": pair,
    }


def _when_value(r: Any) -> Optional[str]:
    if r.outcome == "unavailable":
        return None
    if r.outcome == "allow":
        return "F"
    return "T" if r.code == "DECIDE_REFUSED" else "U"


def build_decide_decision_record(evaluation: Any, rules: Sequence[Dict[str, Any]], ctx: Dict[str, Any], sha256_hex: Callable[[str], str]) -> Dict[str, Any]:
    """The ``decide.decision`` record of one evaluated call; ``ctx`` carries
    atMs, harness, workspaceId, sessionId, tool, toolInput, cwd,
    lastUserTurn, budgetMs, latencyMs, engine and redact (the sources)."""
    by_ref = {r["ref"]: r for r in rules}
    logged = []
    for rep in evaluation.rules:
        entry = by_ref.get(rep.ref)
        v = decide.validate_decide_rule(entry["ir"]) if entry else None
        rule = v["rule"] if v and v["ok"] else None
        expr = v["expr"] if v and v["ok"] else None
        state_hash = None
        if entry and rule:
            try:
                state = build_decide_tool_call_state(
                    rule["id"], entry["sopTitle"], entry["ruleText"], ctx["tool"], ctx["cwd"], ctx["toolInput"],
                    ctx.get("lastUserTurn") if "last_user_turn" in (rule.get("context") or []) else None,
                )
                state_hash = "sha256:" + sha256_hex(state)
            except Exception:  # noqa: BLE001 - too_large: no state was sent
                state_hash = None
        answers = None
        if rule and rep.answers:
            answers = {}
            for name in sorted(rep.answers):
                la = _log_answer(rule, expr, name, rep.answers[name])
                if la is not None:
                    answers[name] = la
        logged.append({
            "ref": rep.ref,
            "ruleHash": rep.rule_hash,
            "rollout": entry["rollout"] if entry else "shadow",
            "effective": rep.effective,
            "why": rep.why,
            "stateHash": state_hash,
            "modelDigest": rep.model_digest,
            "answers": answers,
            "when": _when_value(rep),
            "outcome": rep.outcome,
            "escalate": (entry["ir"].get("escalate") if entry else None) or "ask",
            "error": rep.error,
        })
    return {
        "v": 1,
        "event": "decide.decision",
        "at": _iso(ctx["atMs"]),
        "harness": ctx["harness"],
        "workspaceId": ctx["workspaceId"],
        "sessionId": ctx["sessionId"],
        "tool": ctx["tool"],
        "stateHash": logged[0]["stateHash"] if logged else None,
        "argsExcerpt": decide_args_excerpt(ctx["toolInput"], ctx["redact"]),
        "engine": ctx["engine"],
        "budgetMs": ctx["budgetMs"],
        "latencyMs": ctx["latencyMs"],
        "outcome": evaluation.call["outcome"],
        "code": evaluation.call["code"],
        "rules": logged,
        "skipped": list(evaluation.skipped),
    }


def build_decide_event_record(event: str, ctx: Dict[str, Any], body: Dict[str, Any]) -> Dict[str, Any]:
    return {"v": 1, "event": event, "at": _iso(ctx["atMs"]), "harness": ctx["harness"], "workspaceId": ctx["workspaceId"], "sessionId": ctx["sessionId"], **body}


def _dump(record: Dict[str, Any]) -> str:
    return json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n"


def decide_log_line(record: Dict[str, Any], top: int = DECIDE_LOG_LINE_MAX_BYTES) -> str:
    """The record as one JSON line of at most ``top`` bytes: the excerpt is
    shortened first, by halves; then choice answers keep only their atoms;
    then the answers go. Whatever was cut, ``truncated`` says so."""

    def fits(r: Dict[str, Any]) -> Optional[str]:
        line = _dump(r)
        return line if len(line.encode("utf-8")) <= top else None

    whole = fits(record)
    if whole:
        return whole
    r = {**record, "truncated": True}
    if isinstance(r.get("argsExcerpt"), str):
        excerpt = r["argsExcerpt"]
        while excerpt:
            excerpt = decide_utf8_prefix(excerpt, len(excerpt.encode("utf-8")) // 2)
            line = fits({**r, "argsExcerpt": excerpt})
            if line:
                return line
        r["argsExcerpt"] = ""
    if isinstance(r.get("rules"), list):
        slim = []
        for rule in r["rules"]:
            answers = rule.get("answers")
            if answers:
                answers = {n: ({"type": "choice", "atoms": a["atoms"], "band": a["band"]} if a.get("type") == "choice" else a) for n, a in answers.items()}
            slim.append({**rule, "answers": answers})
        line = fits({**r, "rules": slim})
        if line:
            return line
        bare = fits({**r, "rules": [{**rule, "answers": None} for rule in slim]})
        if bare:
            return bare
    return _dump({"v": 1, "event": record.get("event"), "at": record.get("at"), "truncated": True})


def append_decide_log_line(logs_dir: Path, file: str, line: str) -> None:
    """One write to a file opened for append, mode 0600 in a 0700 directory."""
    logs_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(str(logs_dir / file), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, line.encode("utf-8"))
    finally:
        os.close(fd)


# ---------------------------------------------------------------------------
# Drift (protection 8)
# ---------------------------------------------------------------------------


def decide_tracked_p(rule: Dict[str, Any], name: str, a: Any) -> Optional[float]:
    q = rule["questions"].get(name)
    if q is None:
        return None
    if q["type"] == "yes_no":
        return a.p if isinstance(a.p, (int, float)) else None
    atoms = decide.choice_atoms(decide.decide_options(q), a.per_order or [], decide.decide_question_band(rule, name))
    ps = [c["p"] for c in atoms.values()]
    return max(ps) if ps else None


def record_decide_stats(stats: Optional[Dict[str, Any]], rule_hash: str, d: Dict[str, Any]) -> Dict[str, Any]:
    prior = stats if stats and stats.get("ruleHash") == rule_hash else {"v": 1, "ruleHash": rule_hash, "decisions": [], "lastDriftAtMs": None}
    return {**prior, "decisions": (prior["decisions"] + [d])[-DECIDE_STATS_KEEP:]}


def _median(xs: List[float]) -> float:
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 == 1 else (s[m - 1] + s[m]) / 2


def check_decide_drift(stats: Dict[str, Any], run: Dict[str, Any], now_ms: float) -> Optional[Dict[str, Any]]:
    decisions = stats["decisions"]
    n = len(decisions)
    if n < DECIDE_DRIFT_MIN_DECISIONS:
        return None
    last = stats.get("lastDriftAtMs")
    if last is not None and now_ms - last < DECIDE_DRIFT_INTERVAL_MS:
        return None
    rate = sum(1 for d in decisions if d["outcome"] == "escalate") / n
    if abs(rate - run["escalationRate"]) > DECIDE_DRIFT_ESCALATION_DELTA:
        return {"measure": "escalation_rate", "question": None, "value": rate, "expected": run["escalationRate"],
                "threshold": DECIDE_DRIFT_ESCALATION_DELTA, "n": n}
    for name in sorted(run["questions"]):
        rng = run["questions"][name]
        ps = [d["p"][name] for d in decisions if isinstance(d["p"].get(name), (int, float))]
        if len(ps) < DECIDE_DRIFT_MIN_DECISIONS:
            continue
        m = _median(ps)
        if m < rng["p10"] or m > rng["p90"]:
            return {"measure": "median_p", "question": name, "value": m, "expected": [rng["p10"], rng["p90"]], "threshold": None, "n": len(ps)}
    return None


def read_decide_stats(stats_dir: Path, rule_hash: str) -> Optional[Dict[str, Any]]:
    try:
        s = json.loads((stats_dir / f"{rule_hash}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(s, dict) or s.get("v") != 1 or s.get("ruleHash") != rule_hash or not isinstance(s.get("decisions"), list):
        return None
    decisions = [d for d in s["decisions"] if isinstance(d, dict) and isinstance(d.get("atMs"), (int, float))
                 and d.get("outcome") in ("allow", "refuse", "escalate") and isinstance(d.get("p"), dict)]
    last = s.get("lastDriftAtMs")
    return {"v": 1, "ruleHash": rule_hash, "decisions": decisions, "lastDriftAtMs": last if isinstance(last, (int, float)) else None}


def write_decide_stats(stats_dir: Path, stats: Dict[str, Any]) -> None:
    stats_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=str(stats_dir), suffix=".tmp")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(stats, separators=(",", ":")) + "\n")
        os.replace(tmp, stats_dir / f"{stats['ruleHash']}.json")
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_decide_call_log(
    evaluation: Any,
    rules: Sequence[Dict[str, Any]],
    ctx: Dict[str, Any],
    sha256_hex: Callable[[str], str],
    eval_run: Callable[[str, str], Optional[Dict[str, Any]]],
    logs_dir: Optional[Path] = None,
    stats_dir: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """Writes one evaluated call (its decision line, and a canary_failed,
    unavailable or not_evaluated line when one applies), updates each
    answered rule's stats and raises ``decide.drift`` against the eval run
    of the pin it ran under. Returns the drifts. Raises on a write error;
    a caller on the decision path catches it."""
    if not evaluation.rules and not evaluation.skipped and evaluation.call["outcome"] == "allow":
        return []
    logs = logs_dir or default_logs_dir()
    stats_root = stats_dir or default_stats_dir()
    file = decide_log_file_name(ctx["atMs"])

    def append(r: Dict[str, Any]) -> None:
        append_decide_log_line(logs, file, decide_log_line(r))

    append(build_decide_decision_record(evaluation, rules, ctx, sha256_hex))
    if evaluation.canary == "failed":
        append(build_decide_event_record("decide.canary_failed", ctx, {"engineHost": ctx["engine"].get("host"), "modelDigest": ctx["engine"].get("digest")}))
    unavailable = [r for r in evaluation.rules if r.outcome == "unavailable"]
    if unavailable:
        append(build_decide_event_record("decide.unavailable", ctx, {"tool": ctx["tool"], "rules": [{"ref": r.ref, "effective": r.effective, "error": r.error} for r in unavailable]}))
    not_evaluated = [r for r in evaluation.rules if r.why == "not_evaluated"]
    if not_evaluated:
        append(build_decide_event_record("decide.not_evaluated", ctx, {"modelDigest": ctx["engine"].get("digest"), "rules": [{"ref": r.ref, "ruleHash": r.rule_hash} for r in not_evaluated]}))

    drifts = []
    by_ref = {r["ref"]: r for r in rules}
    for rep in evaluation.rules:
        entry = by_ref.get(rep.ref)
        if not entry or not rep.answers or rep.outcome == "unavailable":
            continue
        v = decide.validate_decide_rule(entry["ir"])
        if not v["ok"]:
            continue
        ps = {}
        for name, a in rep.answers.items():
            x = decide_tracked_p(v["rule"], name, a)
            if x is not None:
                ps[name] = x
        stats = record_decide_stats(read_decide_stats(stats_root, rep.rule_hash), rep.rule_hash, {"atMs": ctx["atMs"], "outcome": rep.outcome, "p": ps})
        pin = next((p for p in entry["pins"] if p.get("modelDigest") == rep.model_digest), None)
        run = eval_run(rep.rule_hash, pin["evalRunId"]) if pin else None
        drift = check_decide_drift(stats, run, ctx["atMs"]) if run else None
        if drift:
            stats = {**stats, "lastDriftAtMs": ctx["atMs"]}
            drifts.append(drift)
            append(build_decide_event_record("decide.drift", ctx, {"ruleRef": rep.ref, "ruleHash": rep.rule_hash, "modelDigest": rep.model_digest, "evalRunId": pin["evalRunId"], **drift}))
        write_decide_stats(stats_root, stats)
    return drifts


# ---------------------------------------------------------------------------
# Where a gate writes it
# ---------------------------------------------------------------------------

_DEFAULT_PORTS = {"http": 80, "https": 443}


def decide_engine_host(url: str) -> str:
    """``host:port`` of an engine URL, as the log records it; never its path,
    query or credentials. A scheme's default port is left out, as a WHATWG
    URL leaves it out."""
    try:
        u = urlsplit(url)
        host = u.hostname or ""
        port = u.port
    except ValueError:
        return ""
    if not host:
        return ""
    if ":" in host:
        host = f"[{host}]"
    return f"{host}:{port}" if port is not None and _DEFAULT_PORTS.get(u.scheme) != port else host


def decide_log_engine(cfg: Any, evaluation: Any) -> Dict[str, Any]:
    """The engine as a call's record names it: the configured adapter, host and
    model (``cfg`` is None when the engine is not configured), and the model,
    digest and canary the evaluation reported."""
    ident = evaluation.engine or {}
    model = ident.get("model")
    return {
        "adapter": cfg.adapter if cfg is not None else "",
        "host": decide_engine_host(cfg.url) if cfg is not None else "",
        "model": model if model is not None else (cfg.model if cfg is not None else None),
        "digest": ident.get("model_digest"),
        "digestStrength": ident.get("digest_strength"),
        "canary": evaluation.canary,
    }


_HEX = re.compile(r"^[0-9a-f]+$")
_RUN_ID = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*$")


def read_decide_eval_run_baseline(decide_dir: Path, rule_hash: str, eval_run_id: str) -> Optional[Dict[str, Any]]:
    """The drift baseline of the eval run ``intutic decide eval`` stored at
    ``decide_dir/evals/<ruleHash>/runs/<evalRunId>.json``, or None when there
    is none, it does not read, or either name is not a plain file name."""
    if not _HEX.match(rule_hash) or not _RUN_ID.match(eval_run_id):
        return None
    try:
        run = json.loads((decide_dir / "evals" / rule_hash / "runs" / f"{eval_run_id}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    b = run.get("baseline") if isinstance(run, dict) else None
    if not isinstance(b, dict) or not isinstance(b.get("escalationRate"), (int, float)) or not isinstance(b.get("questions"), dict):
        return None
    return b


def now_ms() -> float:
    return time.time() * 1000
