"""Decide rules in the policy snapshot: the `@format` and `@decide` records.

A transliteration of the decoders in packages/shared-types/src/decideRecord.ts;
read that module's docstring for the records and the fallback line. Both run
the `record` group of packages/shared-types/fixtures/decide-vectors.json and
must decode every line to the same record or to None. A record that does not
decode leaves its fallback line in force, which refuses what the rule covers.
The standard library only.
"""

from __future__ import annotations

import base64
import binascii
import json
import math
import re

from . import decide

SNAPSHOT_FORMAT_RECORD_TAG = "@format"
SNAPSHOT_FORMAT = 2
DECIDE_RECORD_TAG = "@decide"
DECIDE_FALLBACK_PREFIX = "decide-fallback:"
DECIDE_RULE_TEXT_MAX_BYTES = 4096
DECIDE_SOP_TITLE_MAX_CHARS = 80

_STAMPS = ("rule", "local-disable", "server-shadow", "silent-log", "no-pins")
_RECORD_FIELDS = ("fallbackId", "ir", "pins", "ref", "rollout", "ruleHash", "ruleText", "sopTitle", "stampedBy", "v")
_PIN_FIELDS = ("band", "combiner", "evalRunId", "modelDigest", "source", "temperature")
_FORMAT = re.compile(r"[1-9][0-9]{0,5}", re.ASCII)
_HASH = re.compile(r"[0-9a-f]{64}", re.ASCII)
_HEX12 = re.compile(r"[0-9a-f]{12}", re.ASCII)
_NEWLINE_OR_TAB = re.compile(r"[\t\r\n]")


def decode_snapshot_format_record(line: str):
    """The format a `@format` line names: a positive integer, or None for any other line or a damaged one."""
    f = line.split("\t")
    if len(f) != 2 or f[0] != SNAPSHOT_FORMAT_RECORD_TAG or not _FORMAT.fullmatch(f[1]):
        return None
    return int(f[1])


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _only_fields(obj: dict, allowed) -> bool:
    return all(k in allowed for k in obj)


def _number_map(v) -> bool:
    return isinstance(v, dict) and all(_is_number(x) for x in v.values())


def _reject_constant(name):
    raise ValueError(name)


def _from_base64(b64: str) -> str:
    """Standard base64 back to UTF-8 text. Raises on anything but the canonical encoding of valid UTF-8."""
    raw = base64.b64decode(b64.encode("ascii"), validate=True)
    text = raw.decode("utf-8")
    if base64.b64encode(raw).decode("ascii") != b64:
        raise ValueError("not canonical base64")
    return text


def parse_decide_pin(value):
    """A pin as a record carries it, or None. Unknown fields refuse."""
    if not isinstance(value, dict) or not _only_fields(value, _PIN_FIELDS):
        return None
    digest, run, source = value.get("modelDigest"), value.get("evalRunId"), value.get("source")
    if not isinstance(digest, str) or digest == "" or not isinstance(run, str) or run == "":
        return None
    if source not in ("local", "server"):
        return None
    if "temperature" in value and not _number_map(value["temperature"]):
        return None
    if "band" in value:
        band = value["band"]
        if not isinstance(band, dict) or not _only_fields(band, ("yes_at", "no_below")):
            return None
        yes_at, no_below = band.get("yes_at"), band.get("no_below")
        if not _is_number(yes_at) or not _is_number(no_below) or not (0.5 < yes_at < 1 and 0 < no_below < yes_at):
            return None
    if "combiner" in value:
        combiner = value["combiner"]
        if not isinstance(combiner, dict) or not _only_fields(combiner, ("bias", "weights")):
            return None
        if not _is_number(combiner.get("bias")) or not _number_map(combiner.get("weights")):
            return None
    return value


def _tools_column(ir: dict) -> str:
    return ",".join(sorted(set(ir.get("tools") or [])))


def _rule_hash(ir):
    v = decide.validate_decide_rule(ir)
    return decide.decide_rule_hash(v["rule"]) if v["ok"] else None


def decode_decide_record(line: str):
    """Reads an `@decide` line back: the record, or None (see decodeDecideRecord in decideRecord.ts)."""
    f = line.split("\t")
    if len(f) != 5 or f[0] != DECIDE_RECORD_TAG or not f[4]:
        return None
    try:
        r = json.loads(_from_base64(f[4]), parse_constant=_reject_constant)
    except (ValueError, binascii.Error, UnicodeError):
        return None
    if not isinstance(r, dict) or not _only_fields(r, _RECORD_FIELDS) or any(k not in r for k in _RECORD_FIELDS):
        return None
    ir = r["ir"]
    if not (_is_number(r["v"]) and r["v"] == 1) or not isinstance(ir, dict) or not isinstance(ir.get("id"), str):
        return None
    rule_hash = r["ruleHash"]
    if not isinstance(rule_hash, str) or not _HASH.fullmatch(rule_hash) or _rule_hash(ir) != rule_hash:
        return None
    ref, rid = r["ref"], ir["id"]
    if not isinstance(ref, str) or len(ref) <= len(rid) + 1 or not ref.endswith("#" + rid):
        return None
    rollout, stamped, fallback = r["rollout"], r["stampedBy"], r["fallbackId"]
    if rollout not in ("shadow", "enforce") or stamped not in _STAMPS:
        return None
    if rollout == "enforce":
        head = DECIDE_FALLBACK_PREFIX + rid + "@"
        if stamped != "rule" or not isinstance(fallback, str):
            return None
        if not fallback.startswith(head) or not _HEX12.fullmatch(fallback[len(head):]):
            return None
    elif fallback is not None:
        return None
    title, text = r["sopTitle"], r["ruleText"]
    if not isinstance(title, str) or _NEWLINE_OR_TAB.search(title) or len(title) > DECIDE_SOP_TITLE_MAX_CHARS:
        return None
    if not isinstance(text, str) or len(text.encode("utf-8", "surrogatepass")) > DECIDE_RULE_TEXT_MAX_BYTES:
        return None
    if not isinstance(r["pins"], list) or any(parse_decide_pin(p) is None for p in r["pins"]):
        return None
    if f[1] != (fallback if fallback is not None else "-") or f[2] != rollout or f[3] != _tools_column(ir):
        return None
    return r
