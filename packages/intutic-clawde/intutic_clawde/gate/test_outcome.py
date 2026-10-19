"""Did the tests pass? The deciding function behind the qualified ordering rule
requires_before: action:run_tests[ok] -> action:deploy, and the
per-session state a gate keeps of it.

A transliteration of packages/shared-types/src/testOutcome.ts; read that
module's docstring for the steps. In short, decide_test_outcome says failed
for a non-zero exit code, an error flag, a false success flag, a runner
summary with failures, or a summary saying no tests ran; ok for exit code 0,
or, with no exit code, a summary that counts a pass; and unknown otherwise,
which leaves a qualified rule unmet as a failure does.

Every port runs packages/shared-types/fixtures/test-outcome-vectors.json. The
bash hook gates emit this file verbatim, so it must stay self-contained: the
standard library only, no module state beyond the constants below, and no
backtick or dollar-brace, which a TypeScript copy cannot hold.

Inputs and states are plain dicts with the TypeScript field names
(exitCode, isError, success, output; {"v": 1, "outcomes":
{...}}), so a gate can read and write the same state file.
"""

import json
import re

OUTCOME_TOKENS = ("action:run_tests",)
OUTCOME_QUALIFIERS = ("ok",)
TEST_OUTPUT_TAIL_BYTES = 65536
TEST_OUTPUT_LINE_BYTES = 1024
TEST_OUTPUT_JSON_MAX_CHARS = 1048576
OUTCOME_STATE_TTL_MS = 86400000
_MAX_SAFE_INTEGER = 9007199254740991

_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_EXIT_CODE = re.compile(r"exit code:? (-?[0-9]{1,9})\Z", re.IGNORECASE | re.ASCII)
_EXIT_STATUS = re.compile(r"exit status ([0-9]{1,9})\Z")
_EXITED = re.compile(r"(?:Process|Command) exited with code (-?[0-9]{1,9})")
_COUNT = re.compile(r"([0-9]{1,9}) ([a-z]+)")
_PYTEST_NONE = re.compile(r"=+ no tests ran")
_PYTEST = re.compile(r"=+ (.+) in [0-9.]+s.* =+\Z")
_JEST = re.compile(r"Tests:[ \t]+(.+)\Z")
_VITEST = re.compile(r"[ \t]*Tests[ \t]+(.+)\Z")
_GO_OK = re.compile(r"ok[ \t]+[^ \t]+")
_GO_FAIL = re.compile(r"FAIL(?:[ \t]|\Z)")
_GO_FAIL_TEST = re.compile(r"--- FAIL:")
_CARGO = re.compile(r"test result: (ok|FAILED)\. ([0-9]{1,9}) passed; ([0-9]{1,9}) failed;")
_MOCHA_PASS = re.compile(r"[ \t]*([0-9]{1,9}) passing")
_MOCHA_FAIL = re.compile(r"[ \t]*([0-9]{1,9}) failing")
_RSPEC = re.compile(r"([0-9]{1,9}) examples?, ([0-9]{1,9}) failures?")


def _utf8_len(ch):
    cp = ord(ch)
    if cp < 0x80:
        return 1
    if cp < 0x800:
        return 2
    if cp < 0x10000:
        return 3
    return 4


def _utf8_tail(s, max_bytes):
    """The last max_bytes bytes of s as UTF-8, starting on a character."""
    total = 0
    i = len(s)
    while i > 0:
        n = _utf8_len(s[i - 1])
        if total + n > max_bytes:
            break
        total += n
        i -= 1
    return s[i:]


def _utf8_head(s, max_bytes):
    """The first max_bytes bytes of s as UTF-8, ending on a character."""
    total = 0
    i = 0
    while i < len(s):
        n = _utf8_len(s[i])
        if total + n > max_bytes:
            break
        total += n
        i += 1
    return s[:i]


def _lines(text):
    """The lines of text, each cut to 1 KiB, without carriage returns or ANSI sequences."""
    return [_ANSI.sub("", _utf8_head(raw, TEST_OUTPUT_LINE_BYTES).replace("\r", "")) for raw in text.split("\n")]


def _integer_or_none(v):
    """A JSON integer exit code, or None."""
    if isinstance(v, bool):
        return None
    if isinstance(v, int) and abs(v) <= _MAX_SAFE_INTEGER:
        return v
    if isinstance(v, float) and v.is_integer() and abs(v) <= _MAX_SAFE_INTEGER:
        return int(v)
    return None


def extract_exit_code(output):
    """The exit code a run's text reports, or None. See testOutcome.ts extractExitCode."""
    if not isinstance(output, str) or output == "":
        return None
    trimmed = output.strip()
    if len(trimmed) <= TEST_OUTPUT_JSON_MAX_CHARS and trimmed[:1] == "{" and trimmed[-1:] == "}":
        try:
            parsed = json.loads(trimmed)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            meta = parsed.get("metadata")
            if isinstance(meta, dict):
                m = _integer_or_none(meta.get("exit_code"))
                if m is not None:
                    return m
            for key in ("exit_code", "exitCode"):
                v = _integer_or_none(parsed.get(key))
                if v is not None:
                    return v
    head = _utf8_head(output, TEST_OUTPUT_TAIL_BYTES)
    parts = [head] if len(head) == len(output) else [head, _utf8_tail(output[len(head):], TEST_OUTPUT_TAIL_BYTES)]
    for part in parts:
        for raw in _lines(part):
            line = raw.lstrip(" \t").rstrip(" \t")
            m = _EXIT_CODE.match(line) or _EXIT_STATUS.match(line) or _EXITED.match(line)
            if m:
                return int(m.group(1))
    return None


def _counts(text):
    """'N word' pieces of a summary, split on ',' and '|': the count of each word."""
    counts = {}
    for piece in re.split(r"[,|]", text):
        m = _COUNT.match(piece.lstrip(" \t"))
        if m:
            counts[m.group(2)] = counts.get(m.group(2), 0) + int(m.group(1))
    return counts


def parse_test_summaries(output):
    """The runner summaries in the last 64 KiB of output, in order (go and mocha folded into one each)."""
    if not isinstance(output, str) or output == "":
        return []
    out = []
    go = None
    mocha = None
    for line in _lines(_utf8_tail(output, TEST_OUTPUT_TAIL_BYTES)):
        if _PYTEST_NONE.match(line):
            out.append({"runner": "pytest", "passed": 0, "failed": 0, "noTests": True})
            continue
        m = _PYTEST.match(line)
        if m:
            c = _counts(m.group(1))
            if not any(k in c for k in ("passed", "failed", "error", "errors")):
                continue
            out.append({"runner": "pytest", "passed": c.get("passed", 0),
                        "failed": c.get("failed", 0) + c.get("error", 0) + c.get("errors", 0),
                        "noTests": c.get("passed") == 0})
            continue
        m = _JEST.match(line)
        if m:
            c = _counts(m.group(1))
            out.append({"runner": "jest", "passed": c.get("passed", 0), "failed": c.get("failed", 0),
                        "noTests": c.get("passed") == 0 or c.get("total") == 0})
            continue
        m = _VITEST.match(line)
        if m:
            c = _counts(m.group(1))
            if "passed" not in c and "failed" not in c:
                continue
            out.append({"runner": "vitest", "passed": c.get("passed", 0), "failed": c.get("failed", 0),
                        "noTests": c.get("passed") == 0})
            continue
        if _GO_OK.match(line):
            if go is None:
                go = {"runner": "go", "passed": 0, "failed": 0, "noTests": False}
                out.append(go)
            go["passed"] += 1
            continue
        if _GO_FAIL.match(line) or _GO_FAIL_TEST.match(line):
            if go is None:
                go = {"runner": "go", "passed": 0, "failed": 0, "noTests": False}
                out.append(go)
            go["failed"] += 1
            continue
        m = _CARGO.match(line)
        if m:
            passed, failed = int(m.group(2)), int(m.group(3))
            out.append({"runner": "cargo", "passed": passed,
                        "failed": 1 if m.group(1) == "FAILED" and failed == 0 else failed,
                        "noTests": passed == 0})
            continue
        m = _MOCHA_PASS.match(line)
        if m:
            if mocha is None:
                mocha = {"runner": "mocha", "passed": 0, "failed": 0, "noTests": False}
                out.append(mocha)
            mocha["passed"] += int(m.group(1))
            if int(m.group(1)) == 0:
                mocha["noTests"] = True
            continue
        m = _MOCHA_FAIL.match(line)
        if m:
            if mocha is None:
                mocha = {"runner": "mocha", "passed": 0, "failed": 0, "noTests": False}
                out.append(mocha)
            mocha["failed"] += int(m.group(1))
            continue
        m = _RSPEC.match(line)
        if m:
            examples, failures = int(m.group(1)), int(m.group(2))
            out.append({"runner": "rspec", "passed": max(0, examples - failures), "failed": failures,
                        "noTests": examples == 0})
    return out


def decide_test_outcome(inp):
    """The outcome of one test run, as {"outcome": ok|failed|unknown, "why": ...}.

    'inp' carries any of exitCode, isError, success and output.
    """
    exit_code = inp.get("exitCode")
    if isinstance(exit_code, bool) or not isinstance(exit_code, (int, float)) or _integer_or_none(exit_code) is None:
        exit_code = None
    else:
        exit_code = int(exit_code)
    if exit_code is not None and exit_code != 0:
        return {"outcome": "failed", "why": "exit_code"}
    if inp.get("isError") is True:
        return {"outcome": "failed", "why": "is_error"}
    if inp.get("success") is False:
        return {"outcome": "failed", "why": "success_false"}
    passed = 0
    no_tests = False
    for s in parse_test_summaries(inp.get("output")):
        if s["failed"] > 0:
            return {"outcome": "failed", "why": "summary_failed"}
        passed += s["passed"]
        if s["noTests"]:
            no_tests = True
    if passed == 0 and no_tests:
        return {"outcome": "failed", "why": "no_tests"}
    if exit_code == 0:
        return {"outcome": "ok", "why": "exit_zero"}
    if passed >= 1:
        return {"outcome": "ok", "why": "summary_passed"}
    return {"outcome": "unknown", "why": "no_signal"}


def ordering_qualifier_error(side, left):
    """Why one side of an ordering rule cannot carry its qualifier, or None."""
    if "[" not in side and "]" not in side:
        return None
    if left and side == "action:run_tests[ok]":
        return None
    return json.dumps(side, ensure_ascii=False) + ": [ok] qualifies only action:run_tests, on the left of ->"


def split_qualifier(token):
    """action:run_tests[ok] as ("action:run_tests", "ok"); any other token unqualified."""
    return ("action:run_tests", "ok") if token == "action:run_tests[ok]" else (token, None)


def empty_outcome_state():
    return {"v": 1, "outcomes": {}}


def outcome_state_file_name(harness, session_id, sha256_hex):
    """The first 32 hex of sha256(harness NUL session_id), and .json."""
    return sha256_hex(harness + "\0" + session_id)[:32] + ".json"


def parse_outcome_state(text):
    """A state file's text as a state, or None when it is not one."""
    try:
        v = json.loads(text)
    except ValueError:
        return None
    if not isinstance(v, dict) or v.get("v") != 1 or isinstance(v.get("v"), bool) or not isinstance(v.get("outcomes"), dict):
        return None
    outcomes = {}
    for key, e in v["outcomes"].items():
        if not isinstance(e, dict):
            return None
        at = e.get("at")
        if e.get("o") not in ("ok", "failed", "unknown") or isinstance(at, bool) or not isinstance(at, (int, float)):
            return None
        if at != at or at in (float("inf"), float("-inf")):
            return None
        if "why" in e and not isinstance(e["why"], str):
            return None
        if "changed" in e and e["changed"] is not True:
            return None
        if "later" in e and e["later"] is not True:
            return None
        outcomes[key] = e
    return {"v": 1, "outcomes": outcomes}


def record_test_outcome(state, token, decision, at_ms):
    """state with token's outcome replaced by this run's."""
    outcomes = dict(state["outcomes"])
    outcomes[token] = {"o": decision["outcome"], "at": at_ms, "why": decision["why"]}
    return {"v": 1, "outcomes": outcomes}


def note_completed_call(state, changed_files):
    """state after another call completed: none adjacent any more, and stale after a file change."""
    outcomes = {}
    for key, e in state["outcomes"].items():
        nxt = {"o": e["o"], "at": e["at"]}
        if "why" in e:
            nxt["why"] = e["why"]
        if e.get("changed") or changed_files:
            nxt["changed"] = True
        nxt["later"] = True
        outcomes[key] = nxt
    return {"v": 1, "outcomes": outcomes}


def prerequisite_case(state, token, adjacent, now_ms):
    """(case, why): met only for an ok younger than a day that no file change followed
    (and, adjacent, no other call)."""
    e = None if state is None else state["outcomes"].get(token)
    if e is None or not (now_ms - e["at"] < OUTCOME_STATE_TTL_MS) or e["at"] > now_ms:
        return ("none", None)
    if e["o"] == "failed":
        return ("failed", e.get("why"))
    if e["o"] == "unknown":
        return ("unknown", e.get("why"))
    if e.get("changed"):
        return ("changed", None)
    if adjacent and e.get("later"):
        return ("not_adjacent", None)
    return ("met", None)


def prerequisite_unmet_reason(first, then, case, why, harness):
    """The PREREQUISITE_UNMET reason for every case but met, byte for byte as every port words it."""
    head = then + " needs a passing " + first + " first; "
    if case == "none":
        return head + "none ran in this session"
    if case == "failed":
        return head + "the last " + first + " failed (" + (why if why is not None else "failed") + ")"
    if case == "unknown":
        return head + "the result of the last " + first + " could not be read; rerun the tests so their summary is visible"
    if case == "changed":
        return head + "files changed after the last passing " + first + "; rerun the tests"
    if case == "not_adjacent":
        return head + then + " must come directly after it, and another call came between"
    if case == "not_observable":
        return head + harness + " reports no tool results Intutic can read, so a passing run cannot be observed here"
    if case == "no_session":
        return head + harness + " sent no session id, so test results cannot be tied to this session"
    return ""
