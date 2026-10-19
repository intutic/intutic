"""What a refusal says about where to retry: its scope (paths,
tools, step, detector, rule) and its evidence (what the refuser saw),
bounded the same way on every surface.

A transliteration of packages/shared-types/src/refusalDetail.ts: each list
holds at most 8 items and each string at most 256 code points, with C0
control characters (U+0000 to U+001F) removed first; a string empty after
that is dropped, an empty list left out, and a scope with nothing left is
None. In an OPAQUE workspace both are dropped, and so is the stderr retry
line. Every port runs packages/shared-types/fixtures/refusal-detail-vectors.json.

Self-contained (the standard library only), so the bash hook gates can emit
it verbatim; no backtick or dollar-brace, which a TypeScript copy cannot hold.
"""

import re

REFUSAL_DETAIL_MAX_ITEMS = 8
REFUSAL_DETAIL_MAX_CHARS = 256
RETRY_SCOPE_PREFIX = "[Intutic] Retry scope: "

_C0 = re.compile("[\u0000-\u001f]")


def _detail_text(s):
    """s without C0 control characters, cut to 256 code points; None when nothing is left or it is not a string."""
    if not isinstance(s, str):
        return None
    clean = _C0.sub("", s)
    return clean[:REFUSAL_DETAIL_MAX_CHARS] if clean else None


def _detail_list(v):
    if not isinstance(v, list):
        return None
    out = []
    for item in v:
        if len(out) >= REFUSAL_DETAIL_MAX_ITEMS:
            break
        t = _detail_text(item)
        if t is not None:
            out.append(t)
    return out or None


def bound_refusal_scope(scope):
    """A scope bounded as the module says, keys in a fixed order; None when nothing is left."""
    if not isinstance(scope, dict):
        return None
    out = {}
    for key in ("paths", "tools"):
        v = _detail_list(scope.get(key))
        if v:
            out[key] = v
    for key in ("step", "detector", "rule"):
        v = _detail_text(scope.get(key))
        if v is not None:
            out[key] = v
    return out or None


def bound_refusal_evidence(evidence):
    """Evidence bounded: at most 8 items, each with a kind and a detail that survive bounding."""
    out = []
    if not isinstance(evidence, list):
        return out
    for item in evidence:
        if len(out) >= REFUSAL_DETAIL_MAX_ITEMS:
            break
        if not isinstance(item, dict):
            continue
        kind, detail = _detail_text(item.get("kind")), _detail_text(item.get("detail"))
        if kind is not None and detail is not None:
            out.append({"kind": kind, "detail": detail})
    return out


def refusal_detail_for_mode(mode, scope, evidence):
    """The detail a refusal carries in an intervention mode: nothing in OPAQUE, else the bounded scope and evidence."""
    if mode == "OPAQUE":
        return {}
    out = {}
    s = bound_refusal_scope(scope)
    if s:
        out["scope"] = s
    e = bound_refusal_evidence(evidence)
    if e:
        out["evidence"] = e
    return out


def retry_scope_line(mode, scope):
    """'[Intutic] Retry scope: <paths, else tools>', or None when neither, and in OPAQUE."""
    if mode == "OPAQUE":
        return None
    s = bound_refusal_scope(scope) or {}
    items = s.get("paths") or s.get("tools")
    return RETRY_SCOPE_PREFIX + ", ".join(items) if items else None
