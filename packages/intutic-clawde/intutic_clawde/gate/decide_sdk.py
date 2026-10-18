"""``decide(state, questions, ...)`` for agents built on this SDK: ask a
self-hosted model a few narrow yes/no or pick-one questions about a state, and
get each answer's probability, its three-valued reading through a band and,
with a ``when``, the outcome a decide rule would reach.

The questions are written as a decide rule's ``questions`` and validated the
same way, so wording that asks the model for approval is refused. Every call
goes through the engine client and its host guard: a hosted decision API is
refused before anything is sent, and there is no way to pass an engine object
that skips the guard.

Engine errors are raised as ``DecideEngineError``, so a caller cannot read an
unavailable engine as an answer. The one exception is ``too_large``: a state
over the limit is never truncated, every answer is unknown, and with a
``when`` the outcome escalates.

A port of ``packages/shared-types/src/decideSdk.ts``; both run
``packages/shared-types/fixtures/decide-sdk-vectors.json``.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

from .decide import (
    NONE_OF_THESE, band_value, choice_atoms, decide_options, decide_question_band, decide_rule_outcome,
    validate_decide_rule,
)
from .decide_engine import (
    DECIDE_MAX_STATE_BYTES, DecideEngineConfig, DecideEngineError, DecideQuestionCall, create_decide_engine,
    resolve_decide_engine_config,
)

#: The budget when neither ``budget_ms`` nor ``INTUTIC_DECIDE_BUDGET_MS`` sets one.
DECIDE_SDK_DEFAULT_BUDGET_MS = 7_300

_UNSET: Any = object()


@dataclass
class DecideSdkAnswer:
    type: str
    #: p(yes), for a yes/no question; None when nothing was asked.
    p: Optional[float] = None
    #: The yes/no answer through its band: "T", "F" or "U".
    value: Optional[str] = None
    #: For a choice: each order's probability per option.
    per_order: Optional[List[Dict[str, float]]] = None
    #: For a choice: each option's atom ``q == o`` ({"p", "spread", "value"}).
    options: Optional[Dict[str, Dict[str, Any]]] = None
    #: For a choice: the option whose atom is T, or None.
    choice: Optional[str] = None


@dataclass
class DecideSdkResult:
    answers: Dict[str, DecideSdkAnswer]
    #: ``when``'s value, or None without a ``when``.
    value: Optional[str]
    outcome: Optional[str]
    code: Optional[str]
    via: Optional[str]
    #: "too_large" when the state was over DECIDE_MAX_STATE_BYTES and nothing was asked.
    error: Optional[str]
    model: Optional[str]
    model_digest: Optional[str]
    digest_strength: Optional[str]
    adapter: str
    latency_ms: float


def decide_engine_file_path() -> Path:
    return Path.home() / ".intutic" / "decide" / "engine.json"


def load_decide_engine_file(path: Path) -> Any:
    """engine.json's parsed content, or None when the file does not exist. A
    file that does not read or parse leaves the engine not configured."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError:
        raise DecideEngineError("not_configured", f"{path} cannot be read") from None
    try:
        return json.loads(text)
    except ValueError:
        raise DecideEngineError("not_configured", f"{path} is not JSON") from None


def _sdk_rule(questions: Mapping[str, Any], when: Optional[str], band: Optional[Mapping[str, float]],
              escalate: Optional[str]) -> Dict[str, Any]:
    if when is None:
        when = " OR ".join(
            f"{n} == {NONE_OF_THESE}" if isinstance(questions.get(n), dict) and questions[n].get("type") == "choice" else n
            for n in sorted(questions)
        )
    rule: Dict[str, Any] = {"id": "sdk", "on": "response", "questions": questions, "when": when}
    if band is not None:
        rule["band"] = band
    if escalate is not None:
        rule["escalate"] = escalate
    return rule


def _budget(budget_ms: Optional[float], env: Mapping[str, str]) -> float:
    if budget_ms is not None:
        return budget_ms
    raw = (env.get("INTUTIC_DECIDE_BUDGET_MS") or "").strip()
    if not raw:
        return DECIDE_SDK_DEFAULT_BUDGET_MS
    if not re.fullmatch(r"[0-9]+", raw):
        raise DecideEngineError("not_configured", "INTUTIC_DECIDE_BUDGET_MS must be a whole number")
    return int(raw)


def decide(
    state: str,
    questions: Mapping[str, Any],
    *,
    when: Optional[str] = None,
    band: Optional[Mapping[str, float]] = None,
    escalate: Optional[str] = None,
    engine: Optional[DecideEngineConfig] = None,
    engine_file: Any = _UNSET,
    env: Optional[Mapping[str, str]] = None,
    budget_ms: Optional[float] = None,
) -> DecideSdkResult:
    """Asks ``questions`` (written as a decide rule's ``questions``) about
    ``state``. ``engine`` is the engine's configuration; without it,
    ``engine_file`` (engine.json's parsed content, default read from
    ``~/.intutic/decide/engine.json``) and ``env`` (default ``os.environ``)
    give it. Raises ``ValueError`` for questions a decide rule would refuse,
    and ``DecideEngineError`` when the engine is not configured, its host is
    refused, or it cannot answer in time."""
    if not isinstance(state, str):
        raise ValueError("decide: state must be a string")
    v = validate_decide_rule(_sdk_rule(questions, when, band, escalate))
    if not v["ok"]:
        raise ValueError(v["reason"])
    rule = v["rule"]
    env = os.environ if env is None else env
    if engine is None:
        if engine_file is _UNSET:
            engine_file = load_decide_engine_file(decide_engine_file_path())
        engine = resolve_decide_engine_config(engine_file, env)
    budget = _budget(budget_ms, env)
    client = create_decide_engine(engine)

    names = sorted(rule["questions"])
    calls = []
    for name in names:
        q = rule["questions"][name]
        options = tuple(decide_options(q)) if q["type"] == "choice" else ()
        calls.append(DecideQuestionCall(name, q["type"], q["ask"], options))
    started = time.monotonic()
    res = None
    # A caller's state is held to the tool-call limit: the engine takes larger
    # ones, up to an ``on: response`` state's limit, from the state builders only.
    if len(state.encode("utf-8")) <= DECIDE_MAX_STATE_BYTES:
        try:
            res = client.ask(state, calls, started + budget / 1000)
        except DecideEngineError as err:
            if err.code != "too_large":
                raise

    inputs: Dict[str, Dict[str, Any]] = {}
    answers: Dict[str, DecideSdkAnswer] = {}
    for name in names:
        q = rule["questions"][name]
        a = res.answers.get(name) if res else None
        q_band = decide_question_band(rule, name)
        p = a.p if a is not None else None
        per_order = a.per_order if a is not None else None
        inputs[name] = {"p": p, "perOrder": per_order}
        if q["type"] == "yes_no":
            answers[name] = DecideSdkAnswer("yes_no", p=p, value="U" if p is None else band_value(p, q_band))
        else:
            options = choice_atoms(decide_options(q), per_order or [], q_band)
            choice = next((o for o, c in options.items() if c["value"] == "T"), None)
            answers[name] = DecideSdkAnswer("choice", per_order=per_order, options=options, choice=choice)

    ruled = decide_rule_outcome(rule, v["expr"], inputs) if when is not None else None
    return DecideSdkResult(
        answers=answers,
        value=ruled["value"] if ruled else None,
        outcome=ruled["outcome"] if ruled else None,
        code=ruled["code"] if ruled else None,
        via=ruled["via"] if ruled else None,
        error=None if res else "too_large",
        model=res.model if res else None,
        model_digest=res.model_digest if res else None,
        digest_strength=res.digest_strength if res else None,
        adapter=engine.adapter,
        latency_ms=res.latency_ms if res else (time.monotonic() - started) * 1000,
    )
