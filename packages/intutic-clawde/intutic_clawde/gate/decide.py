"""Decide rules: the grammar, the validator and the semantics.

A transliteration of packages/shared-types/src/decide.ts; read that module's
docstring for what a decide rule is. Every port runs
packages/shared-types/fixtures/decide-vectors.json and must give the same
answer, reason text included, so the shapes here follow the TypeScript:

- a rule is the dict its `decide:` line's JSON parses to (no `kind`);
- a parsed `when` is a dict: {"op": "yes", "q"}, {"op": "eq", "q", "o"},
  {"op": "not", "a"}, {"op": "and" | "or", "a", "b"};
- a declaration is {"kind": "rule", "rule", "expr"} or
  {"kind": "unreadable", "id", "error"};
- three-valued answers are the strings "T", "F" and "U".

Lengths count code points and regexes are ASCII, as the TypeScript and Rust
ports read them. The standard library only.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from decimal import Decimal

DECIDE_MAX_QUESTIONS = 8
DECIDE_MAX_OPTIONS = 8
DECIDE_MAX_RULES_PER_CALL = 4
DECIDE_MAX_WHEN_CHARS = 256
DECIDE_MIN_ASK_CHARS = 8
DECIDE_MAX_ASK_CHARS = 300
DECIDE_DEFAULT_BAND = {"yes_at": 0.85, "no_below": 0.15}
NONE_OF_THESE = "none_of_these"

_TOOL_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]{0,63}")
_MAX_TOOLS = 8
_MAX_TITLE = 80
_RULE_ID = re.compile(r"[a-z][a-z0-9_-]{0,47}")
_NAME = re.compile(r"[a-z][a-z0-9_]{0,31}")
_WORD_NAME = re.compile(r"[a-z][a-z0-9_]*")
_KEYWORDS = ("AND", "OR", "NOT", "IN")
_NEWLINE_OR_TAB = re.compile(r"[\t\r\n]")

# Approval comes from the harness's ask or the review queue, never from a
# model reading text (check 8).
DECIDE_APPROVAL_RE = re.compile(
    r"\b(approv\w*|authori[sz]\w*|pre-?approv\w*|consent\w*|permi(t|ssion)\w*|sign(ed)?[- ]off)\b",
    re.IGNORECASE | re.ASCII,
)

_RULE_FIELDS = ("id", "title", "on", "tools", "questions", "when", "band", "escalate", "rollout", "context")
_QUESTION_FIELDS = ("type", "ask", "options", "band")
_BAND_FIELDS = ("yes_at", "no_below")

_EMPTY_LINE = "decide: the line is empty; write one rule per line as `decide: {json}`"
_NOT_JSON = "decide: the value is not JSON; write one rule per line as `decide: {json}`"


# ─── Shape ────────────────────────────────────────────────────────────


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _unknown_field(obj, allowed):
    extra = sorted(k for k in obj if k not in allowed)
    return extra[0] if extra else None


def _band_shape(v, path):
    if not isinstance(v, dict):
        return f"{path} must be an object"
    extra = _unknown_field(v, _BAND_FIELDS)
    if extra is not None:
        return f"{path}: unknown field {extra}"
    if "yes_at" not in v:
        return f"{path}.yes_at is required"
    if not _is_number(v["yes_at"]) or not (0.5 < v["yes_at"] < 1):
        return f"{path}.yes_at must be above 0.5 and below 1"
    if "no_below" not in v:
        return f"{path}.no_below is required"
    if not _is_number(v["no_below"]) or not v["no_below"] > 0:
        return f"{path}.no_below must be above 0"
    return None


def _question_shape(name, v):
    path = f"questions.{name}"
    if not isinstance(v, dict):
        return f"{path} must be an object"
    extra = _unknown_field(v, _QUESTION_FIELDS)
    if extra is not None:
        return f"{path}: unknown field {extra}"
    if "type" not in v:
        return f"{path}.type is required"
    if v["type"] not in ("yes_no", "choice"):
        return f"{path}.type must be yes_no or choice"
    if "ask" not in v:
        return f"{path}.ask is required"
    ask = v["ask"]
    if (
        not isinstance(ask, str)
        or not DECIDE_MIN_ASK_CHARS <= len(ask) <= DECIDE_MAX_ASK_CHARS
        or _NEWLINE_OR_TAB.search(ask)
    ):
        return f"{path}.ask must be {DECIDE_MIN_ASK_CHARS} to {DECIDE_MAX_ASK_CHARS} characters with no tab or newline"
    if v["type"] == "yes_no":
        if "options" in v:
            return f"{path}.options applies to choice questions only"
    else:
        if "options" not in v:
            return f"{path}.options is required for a choice question"
        options = v["options"]
        if not isinstance(options, list):
            return f"{path}.options must be a list"
        if not 2 <= len(options) <= DECIDE_MAX_OPTIONS:
            return f"{path}.options lists 2 to {DECIDE_MAX_OPTIONS} options"
        for i, o in enumerate(options):
            if not isinstance(o, str) or not _NAME.fullmatch(o):
                return f"{path}.options[{i}] is not an option name"
            if options.index(o) != i:
                return f"{path}.options[{i}] repeats {o}"
    if "band" in v:
        return _band_shape(v["band"], f"{path}.band")
    return None


def _rule_shape(v):
    if not isinstance(v, dict):
        return "a rule is a JSON object"
    extra = _unknown_field(v, _RULE_FIELDS)
    if extra is not None:
        return f"unknown field {extra}"

    if "id" not in v:
        return "id is required"
    if not isinstance(v["id"], str) or not _RULE_ID.fullmatch(v["id"]):
        return "id must be a lower-case letter, then up to 47 of a-z, 0-9, _ or -"

    if "title" in v:
        t = v["title"]
        if not isinstance(t, str) or not 1 <= len(t) <= _MAX_TITLE or _NEWLINE_OR_TAB.search(t):
            return f"title must be 1 to {_MAX_TITLE} characters with no tab or newline"

    if "on" not in v:
        return "on is required"
    if v["on"] not in ("tool_call", "response"):
        return "on must be tool_call or response"

    if "tools" in v:
        tools = v["tools"]
        if not isinstance(tools, list):
            return "tools must be a list"
        if not 1 <= len(tools) <= _MAX_TOOLS:
            return f"tools names 1 to {_MAX_TOOLS} tools"
        for i, t in enumerate(tools):
            if not isinstance(t, str) or not _TOOL_TOKEN.fullmatch(t):
                return f"tools[{i}] is not a tool name"

    if "questions" not in v:
        return "questions is required"
    questions = v["questions"]
    if not isinstance(questions, dict):
        return "questions must be an object"
    for name in sorted(questions):
        if not _NAME.fullmatch(name):
            return f"questions: {name} is not a question name"
        if name.upper() in _KEYWORDS:
            return f"questions: {name} is a when keyword"
        why = _question_shape(name, questions[name])
        if why:
            return why

    if "when" not in v:
        return "when is required"
    if not isinstance(v["when"], str):
        return "when must be a string"
    if not 1 <= len(v["when"]) <= DECIDE_MAX_WHEN_CHARS:
        return f"when must be 1 to {DECIDE_MAX_WHEN_CHARS} characters"

    if "band" in v:
        why = _band_shape(v["band"], "band")
        if why:
            return why
    if "escalate" in v and v["escalate"] not in ("ask", "review", "refuse"):
        return "escalate must be ask, review or refuse"
    if "rollout" in v and v["rollout"] not in ("shadow", "enforce"):
        return "rollout must be shadow or enforce"
    if "context" in v:
        c = v["context"]
        if not isinstance(c, list):
            return "context must be a list"
        if len(c) > 1 or (len(c) == 1 and c[0] != "last_user_turn"):
            return "context may list last_user_turn, once"
    return None


# ─── `when` ───────────────────────────────────────────────────────────


class _WhenError(Exception):
    def __init__(self, message, column):
        super().__init__(message)
        self.message = message
        self.column = column


def _is_word_char(c):
    return "a" <= c <= "z" or "A" <= c <= "Z" or "0" <= c <= "9" or c == "_"


def _tokenize(src):
    out = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        col = i + 1
        if c in " \t\n\r":
            i += 1
        elif c in "(),":
            out.append((c, c, col))
            i += 1
        elif c in "=!" and i + 1 < n and src[i + 1] == "=":
            out.append((c + "=", c + "=", col))
            i += 2
        elif _is_word_char(c):
            j = i
            while j < n and _is_word_char(src[j]):
                j += 1
            w = src[i:j]
            if w in _KEYWORDS:
                out.append(("kw", w, col))
            elif _WORD_NAME.fullmatch(w):
                out.append(("name", w, col))
            else:
                raise _WhenError(f"unknown word {w}", col)
            i = j
        else:
            raise _WhenError(f"unexpected character {c}", col)
    out.append(("end", "", n + 1))
    return out


def parse_when(src):
    """Parse a `when`; returns {"ok": True, "expr"} or {"ok": False, "message", "column"}. Never raises."""
    try:
        toks = _tokenize(src)
        pos = [0]

        def peek():
            return toks[pos[0]]

        def take():
            t = toks[pos[0]]
            pos[0] += 1
            return t

        def is_kw(w):
            t = peek()
            return t[0] == "kw" and t[1] == w

        def option():
            t = take()
            if t[0] != "name":
                raise _WhenError("expected an option", t[2])
            return t[1]

        def parse_or():
            a = parse_and()
            while is_kw("OR"):
                take()
                a = {"op": "or", "a": a, "b": parse_and()}
            return a

        def parse_and():
            a = parse_unary()
            while is_kw("AND"):
                take()
                a = {"op": "and", "a": a, "b": parse_unary()}
            return a

        def parse_unary():
            if is_kw("NOT"):
                take()
                return {"op": "not", "a": parse_unary()}
            return parse_atom()

        def parse_atom():
            t = take()
            if t[0] == "(":
                e = parse_or()
                close = take()
                if close[0] != ")":
                    raise _WhenError("expected )", close[2])
                return e
            if t[0] != "name":
                raise _WhenError("expected a question name, NOT or (", t[2])
            q = t[1]
            if peek()[0] == "==":
                take()
                return {"op": "eq", "q": q, "o": option()}
            if peek()[0] == "!=":
                take()
                return {"op": "not", "a": {"op": "eq", "q": q, "o": option()}}
            if is_kw("IN"):
                take()
                opened = take()
                if opened[0] != "(":
                    raise _WhenError("expected (", opened[2])
                e = {"op": "eq", "q": q, "o": option()}
                while True:
                    sep = take()
                    if sep[0] == ")":
                        return e
                    if sep[0] != ",":
                        raise _WhenError("expected , or )", sep[2])
                    e = {"op": "or", "a": e, "b": {"op": "eq", "q": q, "o": option()}}
            return {"op": "yes", "q": q}

        expr = parse_or()
        if peek()[0] != "end":
            raise _WhenError("expected AND, OR or the end", peek()[2])
        return {"ok": True, "expr": expr}
    except _WhenError as err:
        return {"ok": False, "message": err.message, "column": err.column}


def canonical_when(e):
    """Fully parenthesised, `!=` and `IN` rewritten."""
    op = e["op"]
    if op == "yes":
        return e["q"]
    if op == "eq":
        return f"({e['q']} == {e['o']})"
    if op == "not":
        return f"(NOT {canonical_when(e['a'])})"
    word = "AND" if op == "and" else "OR"
    return f"({canonical_when(e['a'])} {word} {canonical_when(e['b'])})"


def _atoms_of(e, out):
    if e["op"] in ("yes", "eq"):
        out.append(e)
    elif e["op"] == "not":
        _atoms_of(e["a"], out)
    else:
        _atoms_of(e["a"], out)
        _atoms_of(e["b"], out)
    return out


# ─── Validation ───────────────────────────────────────────────────────


def decide_options(q):
    """A choice question's options as asked: none_of_these appended when absent, moved last when present."""
    return [o for o in q.get("options") or [] if o != NONE_OF_THESE] + [NONE_OF_THESE]


def decide_question_band(rule, name):
    q = rule["questions"].get(name) or {}
    return q.get("band") or rule.get("band") or DECIDE_DEFAULT_BAND


def validate_decide_rule(value):
    """{"ok": True, "rule", "expr"} or {"ok": False, "reason"}. The shape, then the eight checks in order."""
    shape = _rule_shape(value)
    if shape:
        return {"ok": False, "reason": f"decide: {shape}"}
    rule = value
    questions = rule["questions"]
    names = sorted(questions)

    if (rule["on"] == "tool_call") != ("tools" in rule):
        return {"ok": False, "reason": "decide: tools is required for on: tool_call and not allowed for on: response"}
    if rule["on"] != "tool_call" and "context" in rule:
        return {"ok": False, "reason": "decide: context applies to on: tool_call only"}
    if not 1 <= len(names) <= DECIDE_MAX_QUESTIONS:
        return {"ok": False, "reason": f"decide: a rule asks 1 to {DECIDE_MAX_QUESTIONS} questions"}
    band = rule.get("band")
    if band is not None and not band["no_below"] < band["yes_at"]:
        return {"ok": False, "reason": "decide: band: no_below must be below yes_at"}
    for n in names:
        b = questions[n].get("band")
        if b is not None and not b["no_below"] < b["yes_at"]:
            return {"ok": False, "reason": f"decide: {n}: no_below must be below yes_at"}

    parsed = parse_when(rule["when"])
    if not parsed["ok"]:
        return {"ok": False, "reason": f"decide: when: {parsed['message']} at column {parsed['column']}"}
    used = set()
    for atom in _atoms_of(parsed["expr"], []):
        q = questions.get(atom["q"])
        if q is None:
            return {"ok": False, "reason": f"decide: when: unknown question {atom['q']}"}
        if atom["op"] == "yes" and q["type"] != "yes_no":
            return {"ok": False, "reason": f"decide: when: {atom['q']} is not a yes_no question"}
        if atom["op"] == "eq":
            if q["type"] != "choice":
                return {"ok": False, "reason": f"decide: when: {atom['q']} is not a choice question"}
            if atom["o"] not in decide_options(q):
                return {"ok": False, "reason": f"decide: when: unknown option {atom['o']} for {atom['q']}"}
        used.add(atom["q"])
    for n in names:
        if n not in used:
            return {"ok": False, "reason": f"decide: question {n} is never used in when"}
    for n in names:
        if DECIDE_APPROVAL_RE.search(questions[n]["ask"]):
            return {
                "ok": False,
                "reason": f"decide: {n} asks about approval; approval comes from the harness ask or the review queue, never from a question",
            }
    return {"ok": True, "rule": rule, "expr": parsed["expr"]}


def _reject_constant(name):
    raise ValueError(name)


def parse_decide_line(raw):
    """The value of one `decide:` line (the text after the key)."""
    text = raw.strip()
    if not text:
        return {"kind": "unreadable", "id": None, "error": _EMPTY_LINE}
    try:
        # NaN and Infinity are not JSON, whatever Python's parser allows.
        value = json.loads(text, parse_constant=_reject_constant)
    except ValueError:
        return {"kind": "unreadable", "id": None, "error": _NOT_JSON}
    rid = value.get("id") if isinstance(value, dict) else None
    rid = rid if isinstance(rid, str) and rid != "" else None
    v = validate_decide_rule(value)
    if v["ok"]:
        return {"kind": "rule", "rule": v["rule"], "expr": v["expr"]}
    return {"kind": "unreadable", "id": rid, "error": v["reason"]}


def parse_decide_lines(values):
    """Every `decide:` line of one SOP, in order. A line reusing an earlier id is unreadable."""
    seen = set()
    out = []
    for raw in values:
        d = parse_decide_line(raw)
        rid = d["rule"]["id"] if d["kind"] == "rule" else d["id"]
        if rid is not None:
            if rid in seen:
                d = {"kind": "unreadable", "id": rid, "error": f"decide: id {rid} is used twice in this SOP"}
            else:
                seen.add(rid)
        out.append(d)
    return out


# ─── Identity ─────────────────────────────────────────────────────────


def _js_number(x):
    """A number as JavaScript's `JSON.stringify` writes it: shortest round trip, exponent below 1e-6 and from 1e21."""
    if isinstance(x, bool):
        raise TypeError("a boolean is not a number")
    if isinstance(x, int):
        return str(x)
    if x == 0:
        return "0"
    if x < 0:
        return "-" + _js_number(-x)
    _sign, digits, exponent = Decimal(repr(x)).as_tuple()
    ds = "".join(str(d) for d in digits).rstrip("0") or "0"
    n = len(digits) + exponent  # x = 0.d1d2... × 10^n
    k = len(ds)
    if k <= n <= 21:
        return ds + "0" * (n - k)
    if 0 < n <= 21:
        return ds[:n] + "." + ds[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + ds
    e = n - 1
    mantissa = ds[0] + ("." + ds[1:] if k > 1 else "")
    return f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"


def _canonical_json(v):
    if isinstance(v, dict):
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{_canonical_json(v[k])}" for k in sorted(v)) + "}"
    if isinstance(v, list):
        return "[" + ",".join(_canonical_json(x) for x in v) + "]"
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, bool) or v is None:
        return json.dumps(v)
    return _js_number(v)


def decide_hash_input(rule):
    """The canonical JSON the rule hash covers; see decideHashInput in decide.ts."""
    parsed = parse_when(rule["when"])
    if not parsed["ok"]:
        raise ValueError(f"decide_hash_input: when does not parse ({parsed['message']})")
    questions = {}
    for name, q in rule["questions"].items():
        b = decide_question_band(rule, name)
        out = {"type": q["type"], "ask": q["ask"], "band": {"yes_at": b["yes_at"], "no_below": b["no_below"]}}
        if q["type"] == "choice":
            out["options"] = decide_options(q)
        questions[name] = out
    return _canonical_json(
        {
            "on": rule["on"],
            "tools": sorted(set(rule.get("tools") or [])),
            "questions": questions,
            "when": canonical_when(parsed["expr"]),
            "context": sorted(set(rule.get("context") or [])),
        }
    )


def decide_rule_hash(rule):
    """`ruleHash`: lower-case hex SHA-256 of the UTF-8 hash input."""
    return hashlib.sha256(decide_hash_input(rule).encode("utf-8")).hexdigest()


# ─── Semantics ────────────────────────────────────────────────────────


def k_and(a, b):
    if a == "F" or b == "F":
        return "F"
    return "T" if a == "T" and b == "T" else "U"


def k_or(a, b):
    if a == "T" or b == "T":
        return "T"
    return "F" if a == "F" and b == "F" else "U"


def k_not(a):
    return "F" if a == "T" else "T" if a == "F" else "U"


def band_value(p, band):
    if p >= band["yes_at"]:
        return "T"
    if p < band["no_below"]:
        return "F"
    return "U"


def choice_orders(n):
    """As written, reversed, and past three options rotated by half (the judge cascade's attributeSops)."""
    ids = list(range(n))
    half = n // 2
    orders = [ids, ids[::-1]]
    if n > 3:
        orders.append(ids[half:] + ids[:half])
    return orders


def choice_atoms(options, per_order, band):
    """{option: {"p", "spread", "value"}}: the mean over orders through the band; U when the orders disagree by more than the band's width."""
    out = {}
    for o in options:
        ps = [m.get(o, 0) for m in per_order]
        if not ps:
            out[o] = {"p": 0, "spread": 0, "value": "U"}
            continue
        total = 0.0
        for p in ps:
            total += p
        mean = total / len(ps)
        spread = max(ps) - min(ps)
        value = "U" if spread > band["yes_at"] - band["no_below"] else band_value(mean, band)
        out[o] = {"p": mean, "spread": spread, "value": value}
    return out


def eval_when(e, atoms):
    op = e["op"]
    if op == "yes":
        return atoms["yes"].get(e["q"], "U")
    if op == "eq":
        return atoms["eq"].get(e["q"], {}).get(e["o"], "U")
    if op == "not":
        return k_not(eval_when(e["a"], atoms))
    if op == "and":
        return k_and(eval_when(e["a"], atoms), eval_when(e["b"], atoms))
    return k_or(eval_when(e["a"], atoms), eval_when(e["b"], atoms))


def _logit(p):
    q = min(max(p, 1e-12), 1 - 1e-12)
    return math.log(q / (1 - q))


def combiner_score(rule, answers, combiner):
    """s = σ(bias + Σ w_q · logit(p_q)) in sorted question order; None when a weighted answer is missing."""
    x = combiner["bias"]
    for name in sorted(combiner["weights"]):
        q = rule["questions"].get(name)
        a = answers.get(name)
        if q is None or a is None:
            return None
        if q["type"] == "yes_no":
            if not _is_number(a.get("p")):
                return None
            p = a["p"]
        else:
            per_order = a.get("perOrder") or []
            if not per_order:
                return None
            atoms = choice_atoms(decide_options(q), per_order, decide_question_band(rule, name))
            p = max(c["p"] for c in atoms.values())
        x += combiner["weights"][name] * _logit(p)
    return 1 / (1 + math.exp(-x))


def decide_atoms(rule, answers):
    atoms = {"yes": {}, "eq": {}}
    for name in sorted(rule["questions"]):
        q = rule["questions"][name]
        a = answers.get(name)
        band = decide_question_band(rule, name)
        if q["type"] == "yes_no":
            atoms["yes"][name] = band_value(a["p"], band) if a is not None and _is_number(a.get("p")) else "U"
        else:
            c = choice_atoms(decide_options(q), (a or {}).get("perOrder") or [], band)
            atoms["eq"][name] = {o: v["value"] for o, v in c.items()}
    return atoms


def decide_rule_outcome(rule, expr, answers, combiner=None):
    """T refuses (DECIDE_REFUSED), F allows, U escalates through `escalate` (default ask); `escalate: refuse` refuses with DECIDE_ESCALATED."""
    atoms = decide_atoms(rule, answers)
    score = None
    if combiner:
        score = combiner_score(rule, answers, combiner)
        value = "U" if score is None else band_value(score, combiner["band"])
    else:
        value = eval_when(expr, atoms)
    base = {"value": value, "score": score, "atoms": atoms}
    if value == "T":
        return {**base, "outcome": "refuse", "code": "DECIDE_REFUSED", "via": None}
    if value == "F":
        return {**base, "outcome": "allow", "code": None, "via": None}
    escalate = rule.get("escalate", "ask")
    if escalate == "refuse":
        return {**base, "outcome": "refuse", "code": "DECIDE_ESCALATED", "via": None}
    return {**base, "outcome": "escalate", "code": "DECIDE_ESCALATED", "via": escalate}


def select_decide_rules(candidates, tool):
    """The rules a tool call asks: enforce first, then snapshot order; at most four. An enforce rule past four makes the call unavailable."""
    matched = [c for c in candidates if c.get("on") == "tool_call" and tool in (c.get("tools") or [])]
    ordered = [c for c in matched if c.get("effective") == "enforce"] + [c for c in matched if c.get("effective") != "enforce"]
    beyond = ordered[DECIDE_MAX_RULES_PER_CALL:]
    unavailable = None
    if any(c.get("effective") == "enforce" for c in beyond):
        unavailable = f"more than {DECIDE_MAX_RULES_PER_CALL} decide rules name {tool}"
    return {
        "evaluate": ordered[:DECIDE_MAX_RULES_PER_CALL],
        "skipped": [c for c in beyond if c.get("effective") != "enforce"],
        "unavailable": unavailable,
    }


def decide_call_outcome(selection, results):
    """The first enforce refusal (or unavailable engine) refuses; else the first enforce escalation escalates; else allow."""
    if selection.get("unavailable"):
        return {"outcome": "refuse", "code": "GOVERNANCE_UNAVAILABLE", "ruleRef": None, "via": None, "reason": selection["unavailable"]}
    enforcing = [r for r in results if r.get("effective") == "enforce"]
    for r in enforcing:
        if r["outcome"] in ("refuse", "unavailable"):
            code = "GOVERNANCE_UNAVAILABLE" if r["outcome"] == "unavailable" else (r.get("code") or "DECIDE_REFUSED")
            return {"outcome": "refuse", "code": code, "ruleRef": r["ref"], "via": None, "reason": None}
    for r in enforcing:
        if r["outcome"] == "escalate":
            return {"outcome": "escalate", "code": "DECIDE_ESCALATED", "ruleRef": r["ref"], "via": r.get("via") or "ask", "reason": None}
    return {"outcome": "allow", "code": None, "ruleRef": None, "via": None, "reason": None}
