"""Fault injection in the hook gates, for chaos runs (intutic chaos run).

A transliteration of packages/shared-types/src/chaosGate.ts; read that
module's docstring for the counter files and why every count lives on disk.
In short: a gate is a new process per tool call, so the plan is decoded on
each call, plan_loaded is reported by whichever gate first creates
EVENTS.gate-plan-loaded, and each fault's seen and hit counts are numbered
empty files in EVENTS.gate-counters/, each number claimed with an exclusive
create (O_CREAT | O_EXCL), which exactly one process wins. A permission fault
never sleeps: it holds the call as an approval hold does, in a
FAULT.held.KEY.G file whose modification time is when, and the identical
retry is held again until delay_s has passed, then allowed (delay) or denied
(hold_then_deny) by the one retry that creates FAULT.released.KEY.G.

The bash gates emit this file verbatim (services/sync-daemon/src/lib/chaosPy.ts
holds a byte-identical copy, which a test compares), intutic_clawde.gate's
Gate.guard runs it in process, and every copy runs
packages/shared-types/fixtures/chaos-gate-vectors.json. It must stay
self-contained: the standard library only, no module state beyond the
constants below, and no backtick or dollar-brace, which the TypeScript copy
cannot hold.
"""

import base64
import binascii
import datetime
import json
import os
import re
import sys
import time

_CHAOS_FAULT_IDS = (
    "llm.rate_limit", "llm.upstream_5xx", "llm.context_trim", "llm.model_degrade", "tool.error", "tool.stale_data",
    "mcp.toolset_change", "permission.deny_or_delay", "inject.tool_result", "egress.dns_fail", "egress.credential_401",
)
_CHAOS_B64URL = re.compile(r"^[A-Za-z0-9_-]+={0,2}$")
_CHAOS_RUN_ID = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
_CHAOS_CANARY = re.compile(r"^E-INTUTIC-[0-9A-F]{4,16}$")


def _chaos_int(v, low, high):
    # JSON numbers as JavaScript reads them: 2.0 is the integer 2. A bool is not a number.
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if isinstance(v, float):
        if not v.is_integer():
            return None
        v = int(v)
    return v if low <= v <= high else None


def chaos_decode(raw):
    """(plan, None), or (None, why it is not one)."""
    def invalid(why):
        return None, "INTUTIC_CHAOS_PLAN is not a valid plan: " + why
    try:
        if not isinstance(raw, str) or not _CHAOS_B64URL.match(raw):
            raise ValueError("alphabet")
        b64 = raw.rstrip("=")
        data = json.loads(base64.urlsafe_b64decode(b64 + "=" * ((4 - len(b64) % 4) % 4)).decode("utf-8"))
    except (ValueError, binascii.Error, UnicodeDecodeError):
        return None, "INTUTIC_CHAOS_PLAN is not base64url-encoded JSON"
    if not isinstance(data, dict):
        return invalid("not a JSON object")
    v = data.get("v")
    if isinstance(v, bool) or v != 1:
        return invalid("version " + json.dumps(v) + ", and a gate reads only version 1")
    run_id = data.get("runId")
    if not isinstance(run_id, str) or not _CHAOS_RUN_ID.match(run_id):
        return invalid("runId")
    canary = data.get("canary")
    if not isinstance(canary, str) or not _CHAOS_CANARY.match(canary):
        return invalid("canary")
    raw_faults = data.get("faults")
    if not isinstance(raw_faults, list) or len(raw_faults) > 50:
        return invalid("faults")
    faults = []
    for i, f in enumerate(raw_faults):
        at = "faults[" + str(i) + "]"
        if not isinstance(f, dict) or not isinstance(f.get("id"), str) or f["id"] not in _CHAOS_FAULT_IDS:
            return invalid(at + ".id")
        if f["id"] not in ("tool.error", "permission.deny_or_delay"):
            continue
        match = None
        if "match" in f:
            if not isinstance(f["match"], dict):
                return invalid(at + ".match")
            for k, mv in f["match"].items():
                if k not in ("tool", "host", "model") or not isinstance(mv, str) or not mv:
                    return invalid(at + ".match." + k)
            match = f["match"]
        after_calls = 0
        if "after_calls" in f:
            after_calls = _chaos_int(f["after_calls"], 0, 10000)
            if after_calls is None:
                return invalid(at + ".after_calls")
        times = None
        if "times" in f:
            times = _chaos_int(f["times"], 1, 10000)
            if times is None:
                return invalid(at + ".times")
        fault = {
            "index": i, "id": f["id"], "match": match, "after_calls": after_calls, "times": times,
            "message": "tool failed", "mode": "deny", "delay_s": 0,
        }
        if f["id"] == "tool.error" and "message" in f:
            # Lengths in UTF-16 code units, as JavaScript counts them.
            m = f["message"]
            if not isinstance(m, str) or not 1 <= len(m.encode("utf-16-le", "surrogatepass")) // 2 <= 2000:
                return invalid(at + ".message")
            fault["message"] = m
        if f["id"] == "permission.deny_or_delay":
            if "mode" in f:
                if f["mode"] not in ("deny", "delay", "hold_then_deny"):
                    return invalid(at + ".mode")
                fault["mode"] = f["mode"]
            if "delay_s" in f:
                delay_s = _chaos_int(f["delay_s"], 0, 600)
                if delay_s is None:
                    return invalid(at + ".delay_s")
                fault["delay_s"] = delay_s
        faults.append(fault)
    return {"runId": run_id, "canary": canary, "faults": faults}, None


def chaos_matches(match, tool):
    """Whether a fault's match covers a gate call, which has a tool and nothing else."""
    if not match:
        return True
    if "host" in match or "model" in match:
        return False
    p = match.get("tool")
    if p is None:
        return True
    return tool.endswith(p[1:]) if p.startswith("*") else tool == p


def chaos_event(plan, type_, fields, now):
    """One events-file line: ts, runId, component, type, then the fields that are set."""
    event = {"ts": now, "runId": plan["runId"], "component": "gate", "type": type_}
    for k, v in fields:
        if v is not None:
            event[k] = v
    return json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n"


def chaos_append(events_path, lines):
    """Appends whole lines in one write. An I/O error is reported, never raised."""
    try:
        fd = os.open(events_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            os.write(fd, lines.encode("utf-8"))
        finally:
            os.close(fd)
    except OSError as e:
        sys.stderr.write("[Intutic Governance] chaos: could not append to " + events_path + ": " + str(e) + "\n")


def chaos_claim(directory, prefix, limit):
    """Claims the next numbered file DIRECTORY/PREFIXn with an exclusive create.

    Returns n, 0 when every number up to limit is taken, or -1 on an I/O
    error, after saying so.
    """
    try:
        # Beside the events file, never creating its directory: the runner did.
        try:
            os.mkdir(directory)
        except FileExistsError:
            pass
        n = sum(1 for name in os.listdir(directory) if name.startswith(prefix)) + 1
        while limit is None or n <= limit:
            try:
                os.close(os.open(os.path.join(directory, prefix + str(n)), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644))
                return n
            except FileExistsError:
                n += 1
        return 0
    except OSError as e:
        sys.stderr.write("[Intutic Governance] chaos: could not count calls in " + directory + ": " + str(e) + "\n")
        return -1


def chaos_open_hold(directory, fault, key):
    """The open hold of one fault on one call: (g, created), the number of
    the newest FAULT.held.KEY.G file with no released twin and its
    modification time in milliseconds; None when there is none or it cannot
    be read."""
    try:
        held = str(fault) + ".held." + key + "."
        names = os.listdir(directory)
        g = 0
        for name in names:
            if name.startswith(held) and name[len(held):].isdigit():
                g = max(g, int(name[len(held):]))
        if g == 0 or (str(fault) + ".released." + key + "." + str(g)) in names:
            return None
        # In whole milliseconds, as now is: a hold is never younger than the call that reads it.
        return g, os.stat(os.path.join(directory, held + str(g))).st_mtime_ns // 1000000
    except OSError:
        # No counters yet, or none readable: no hold to continue.
        return None


def chaos_release(directory, fault, key, g):
    """Ends hold g with an exclusive create: True for the one caller that does."""
    try:
        os.close(os.open(os.path.join(directory, str(fault) + ".released." + key + "." + str(g)),
                         os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644))
        return True
    except OSError:
        # Another gate released it first, or it cannot be written.
        return False


def _chaos_ms(now):
    # The ISO-8601 time a call is decided at, in milliseconds; the clock if unreadable.
    try:
        return round(datetime.datetime.fromisoformat(now.replace("Z", "+00:00")).timestamp() * 1000)
    except (AttributeError, TypeError, ValueError):
        return int(time.time() * 1000)


def chaos_now():
    """The time as the JavaScript gates write it: 2026-10-10T12:00:00.000Z."""
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def chaos_call(plan, events_path, call, now):
    """Reports one call and returns the fault the gate must apply, or None.

    call: tool, decision (allow, deny, ask or hold, before any fault), ruleId,
    destructive, policyHit, and key: the call's digest in hex (its tool and
    input, as the gate keys an approval hold), which a held call's retry
    shares. The fault: faultId, kind (deny or hold) and reason, as
    chaosGateCall returns it. now is the ISO-8601 time, and the clock a hold
    is timed by.
    """
    lines = ""
    first = True
    try:
        os.close(os.open(events_path + ".gate-plan-loaded", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644))
    except FileExistsError:
        first = False
    except OSError:
        pass
    if first:
        lines += chaos_event(plan, "plan_loaded", [("faults", len(plan["faults"]))], now)
    lines += chaos_event(plan, "gate_decision", [
        ("tool", call["tool"]),
        ("decision", call["decision"]),
        ("ruleId", call.get("ruleId") or None),
        ("destructive", bool(call.get("destructive"))),
        ("policyHit", bool(call.get("policyHit"))),
    ], now)
    fault = None
    if call["decision"] == "allow":
        directory = events_path + ".gate-counters"
        key = re.sub(r"[^0-9A-Za-z]", "", str(call.get("key") or ""))[:128] or "call"
        now_ms = _chaos_ms(now)
        tag = " [" + plan["canary"] + "]"
        held = "Permission held for approval; retrying this exact call passes once it is approved" + tag
        # The retry of a held call: still held until the delay has passed,
        # then let through or denied by the one retry that releases it.
        retry = False
        for f in plan["faults"]:
            if f["id"] != "permission.deny_or_delay" or f["mode"] == "deny" or not chaos_matches(f["match"], call["tool"]):
                continue
            open_hold = chaos_open_hold(directory, f["index"], key)
            if open_hold is None:
                continue
            retry = True
            if f["delay_s"] > 0 and now_ms - open_hold[1] < f["delay_s"] * 1000:
                fault = {"faultId": f["id"], "kind": "hold", "reason": held}
            elif chaos_release(directory, f["index"], key, open_hold[0]):
                if f["mode"] == "hold_then_deny":
                    fault = {"faultId": f["id"], "kind": "deny",
                             "reason": "Permission held for approval, then denied by approver" + tag}
            else:
                # Another gate released it first: this call is a new one.
                retry = False
                continue
            break
        for f in plan["faults"] if not retry else ():
            if not chaos_matches(f["match"], call["tool"]):
                continue
            # An MCP tool's error is the MCP proxy's to inject; a gate injects the built-in side.
            if f["id"] == "tool.error" and call["tool"].startswith("mcp__"):
                continue
            seen = chaos_claim(directory, str(f["index"]) + ".seen.", None)
            if fault is not None or seen < 1 or seen <= f["after_calls"]:
                continue
            if f["times"] is not None and chaos_claim(directory, str(f["index"]) + ".hit.", f["times"]) < 1:
                continue
            if f["id"] == "tool.error":
                fault = {"faultId": f["id"], "kind": "deny", "reason": f["message"] + tag}
            elif f["mode"] == "deny":
                fault = {"faultId": f["id"], "kind": "deny", "reason": "Permission denied by approver" + tag}
            else:
                # Held from now: the hold's file is what its retries find.
                if chaos_claim(directory, str(f["index"]) + ".held." + key + ".", None) < 1:
                    continue
                fault = {"faultId": f["id"], "kind": "hold", "reason": held}
            lines += chaos_event(plan, "fault_injected", [("faultId", f["id"]), ("call", seen), ("target", call["tool"])], now)
        if fault is None or fault["kind"] == "hold":
            lines += chaos_event(plan, "tool_call", [("tool", call["tool"]), ("ok", fault is None)], now)
    chaos_append(events_path, lines)
    return fault
