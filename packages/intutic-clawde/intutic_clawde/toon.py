"""The control plane's TOON list encoding, decoded.

A list endpoint answering with 20 rows or more (``GET /api/v1/traces``) may
send them as one pipe-separated string under ``data``, with
``format: "toon"`` and ``listProperty`` naming the key the rows belong under.
This is the TypeScript SDK's ``src/toon.ts`` (a copy of ``toonDecode`` in
``@intutic/shared-types``), applied to every control-plane response.

Cells longer than the encoder's limit arrive cut, ending in ``…``: TOON trades
that for size, and nothing here can restore them.
"""

import json
import re
from typing import Any, Dict, List, Optional

# What JavaScript's Number() reads as a number: decimal (with an optional
# exponent), Infinity, and unsigned hex, binary and octal literals. A cell is
# typed the way the TypeScript decoder types it, so both SDKs return the same
# rows.
_DECIMAL = re.compile(r"[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?")
_RADIX = {
    "0x": (16, re.compile(r"[0-9a-fA-F]+")),
    "0X": (16, re.compile(r"[0-9a-fA-F]+")),
    "0b": (2, re.compile(r"[01]+")),
    "0B": (2, re.compile(r"[01]+")),
    "0o": (8, re.compile(r"[0-7]+")),
    "0O": (8, re.compile(r"[0-7]+")),
}


def _split_cells(line: str) -> List[str]:
    cells: List[str] = []
    cur = ""
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == "\\":
            nxt = line[i + 1] if i + 1 < len(line) else ""
            if nxt == "\\":
                cur += "\\"
                i += 2
                continue
            if nxt == "|":
                cur += "|"
                i += 2
                continue
            if nxt == "n":
                cur += "\n"
                i += 2
                continue
            cur += "\\"
            i += 1
            continue
        if ch == "|":
            cells.append(cur)
            cur = ""
            i += 1
            continue
        cur += ch
        i += 1
    cells.append(cur)
    return cells


def _js_number(raw: str) -> Optional[float]:
    """The number JavaScript's ``Number(raw)`` gives, or None for NaN."""
    text = raw.strip()
    if text == "":
        return 0
    if _DECIMAL.fullmatch(text):
        if re.fullmatch(r"[+-]?[0-9]+", text):
            return int(text)
        return float(text)
    if text in ("Infinity", "+Infinity", "-Infinity"):
        return float(text)
    radix = _RADIX.get(text[:2])
    if radix is not None and radix[1].fullmatch(text[2:]):
        return int(text[2:], radix[0])
    return None


def _decode_cell(raw: str) -> Any:
    if raw == "-":
        return None
    if raw == "t":
        return True
    if raw == "f":
        return False
    if raw != "":
        num = _js_number(raw)
        if num is not None:
            return num
    if raw.startswith("{") or raw.startswith("["):
        try:
            return json.loads(raw)
        except ValueError:
            pass  # Not JSON after all: the text itself.
    return raw


def toon_decode(toon: str) -> Optional[List[Dict[str, Any]]]:
    """Rows from a TOON string, or None when it is not one."""
    lines = toon.rstrip().split("\n")
    header = lines[0] if lines else ""
    if not header.startswith("TOON|"):
        return None
    cols_str = header[len("TOON|"):]
    if cols_str == "(empty)":
        return []
    cols = cols_str.split(",")
    rows: List[Dict[str, Any]] = []
    for line in lines[1:]:
        if not line.strip():
            continue
        cells = _split_cells(line)
        rows.append({key: _decode_cell(cells[i] if i < len(cells) else "-") for i, key in enumerate(cols)})
    return rows


def unwrap_toon_envelope(data: Any) -> Any:
    """Moves a TOON-encoded list out of its envelope onto ``listProperty``, so
    the body has the shape a shorter list arrives in; any other body passes
    through."""
    if not isinstance(data, dict):
        return data
    if data.get("format") != "toon" or not isinstance(data.get("data"), str) or not isinstance(data.get("listProperty"), str):
        return data
    unwrapped = {k: v for k, v in data.items() if k not in ("format", "data")}
    unwrapped[data["listProperty"]] = toon_decode(data["data"]) or []
    return unwrapped
