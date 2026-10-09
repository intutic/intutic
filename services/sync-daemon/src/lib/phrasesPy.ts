/**
 * The phrase matcher in Python, for the gates that run Python: the bash gates
 * (their extractor already requires python3) and the Open WebUI filter.
 *
 * Byte-identical to `packages/intutic-clawde/intutic_clawde/gate/phrases.py`,
 * which a test compares; edit that file and copy it here. It is the
 * transliteration of `@intutic/shared-types`'s phrases.ts, and both run the
 * shared vectors.
 */
export const PHRASES_PY_SOURCE = String.raw`"""Phrase matching for shell commands and SQL in linear time.

A transliteration of packages/shared-types/src/phrases.ts; read that module's
docstring for what counts as a separator and why no regex searches the input.
The rules are the same; the walk is organised for CPython, which is slow per
step: runs of ordinary characters, spaces and backslashes are consumed by
anchored character-class matches (one pass each, nothing to backtrack into),
and a phrase is checked only at the words that can start it.

Every classifier runs the shared vectors in
packages/proxy/src/plugins/anomaly/action_vectors.json, and the hook gates
emit this file verbatim (services/sync-daemon/src/lib/phrasesPy.ts holds a
byte-identical copy, which a test compares). It must stay self-contained: the
standard library only, no module state beyond the constants below, and no
backtick or dollar-brace, which the TypeScript copy cannot hold.
"""

import re
from bisect import bisect_left

_SPACE_CHARS = (
    " \t\n\r\v\f          "
    "       　﻿"
)
_SPACES = frozenset(_SPACE_CHARS)
_WORD = frozenset("abcdefghijklmnopqrstuvwxyz0123456789_")
# One anchored match per piece of the text. Every alternative starts with a
# character no other alternative can start with, so exactly one can match at
# a position and it matches one run of its class: nothing to backtrack into.
_PIECE = re.compile(
    "(?P<plain>[^" + _SPACE_CHARS + "\\\\/;&|-]+)"
    "|(?P<space>[" + _SPACE_CHARS + "]+)"
    "|(?P<dash>-+)"
    "|(?P<backslash>\\\\+)"
    "|(?P<other>[/;&|])"
)


class PhraseText:
    """A text cut into words, ready for any number of has_phrase calls."""

    __slots__ = ("raw", "joined", "toks", "sep", "nl", "eol", "dash", "bar", "tail", "memo")

    def __init__(self):
        self.raw = ""
        self.joined = ""
        self.toks = []
        self.sep = []
        self.nl = []
        self.eol = []
        self.dash = []
        self.bar = []
        self.tail = False
        self.memo = {}


def phrase_text(value):
    """Cut value into words in one pass (see phraseText in phrases.ts)."""
    s = ("" if value is None else str(value)).lower()
    n = len(s)
    t = PhraseText()
    t.raw = s
    toks, sep, nl, eol, dash, bar = t.toks, t.sep, t.nl, t.eol, t.dash, t.bar
    start = -1
    tok_bar = False
    pend_sep = pend_nl = pend_eol = False
    close = -2  # the next "*/" at or after the last search; -1 once none is left
    i = 0
    while i < n:
        m = _PIECE.match(s, i)
        kind = m.lastgroup
        j = m.end()
        if kind == "plain":
            if start < 0:
                start = i
            i = j
            continue
        word_break = False
        newline = eol_here = False
        nxt = j
        if kind == "space":
            newline = eol_here = "\n" in m.group()
            word_break = True
        elif kind == "dash":
            # A "--" inside a word starts a new one, glued to it: it can open a
            # comment or an option run but cannot stand for a plain gap.
            if j - i > 1 and start >= 0:
                toks.append(s[start:i])
                sep.append(pend_sep)
                nl.append(pend_nl)
                eol.append(pend_eol)
                dash.append(s.startswith("--", start))
                bar.append(tok_bar)
                start = -1
                tok_bar = False
                pend_sep = pend_nl = pend_eol = False
            if start < 0:
                start = i
            i = j
            continue
        elif kind == "backslash":
            # Every backslash but the last is followed by a backslash: a
            # literal character. The last one decides.
            last = j - 1
            d = s[j] if j < n else ""
            if d in ("n", "t", "r") or (d != "" and d in _SPACES):
                if last > i and start < 0:
                    start = i
                word_break = True
                eol_here = d == "n"
                nxt = j + 1
                if last > i:
                    # the literal backslashes end the word before the escape
                    toks.append(s[start:last])
                    sep.append(pend_sep)
                    nl.append(pend_nl)
                    eol.append(pend_eol)
                    dash.append(s.startswith("--", start))
                    bar.append(tok_bar)
                    start = -1
                    tok_bar = False
                    pend_sep = pend_nl = pend_eol = False
            else:
                if start < 0:
                    start = i
                i = j
                continue
        else:
            c = s[i]
            if c == "/" and j < n and s[j] == "*" and close != -1:
                if close < i + 2:
                    close = s.find("*/", i + 2)
                if close != -1:
                    word_break = True
                    nxt = close + 2
            if not word_break:
                if start < 0:
                    start = i
                if c != "/":
                    tok_bar = True
                i = j
                continue
        if start >= 0:
            toks.append(s[start:i])
            sep.append(pend_sep)
            nl.append(pend_nl)
            eol.append(pend_eol)
            dash.append(s.startswith("--", start))
            bar.append(tok_bar)
            start = -1
            tok_bar = False
            pend_sep = pend_nl = pend_eol = False
        pend_sep = True
        if newline:
            pend_nl = True
        if eol_here:
            pend_eol = True
        i = nxt
    if start >= 0:
        toks.append(s[start:n])
        sep.append(pend_sep)
        nl.append(pend_nl)
        eol.append(pend_eol)
        dash.append(s.startswith("--", start))
        bar.append(tok_bar)
        pend_sep = False
    t.tail = pend_sep
    t.joined = " ".join(toks)
    return t


def _next_index(t):
    """Per word x: the first word at or after x containing ;&|, with a real
    newline before it, and with any newline before it. Built once per text."""
    ix = t.memo.get("#next")
    if ix is None:
        T = len(t.toks)
        nb = [T] * (T + 1)
        nn = [T] * (T + 1)
        ne = [T] * (T + 1)
        b = n_ = e = T
        bar, nl, eol = t.bar, t.nl, t.eol
        for x in range(T - 1, -1, -1):
            if bar[x]:
                b = x
            if nl[x]:
                n_ = x
            if eol[x]:
                e = x
            nb[x] = b
            nn[x] = n_
            ne[x] = e
        ix = (nb, nn, ne)
        t.memo["#next"] = ix
    return ix


def has_phrase(t, needle, bounded=False):
    """Whether t contains needle (see hasPhrase in phrases.ts)."""
    words = needle.lower().split(" ")
    if len(words) == 1:
        return words[0] in t.raw
    trailing_gap = words[-1] == ""
    if trailing_gap:
        words.pop()
    for w in words:
        if w == "" or w not in t.joined:
            return False
    toks, sep, dash, tail = t.toks, t.sep, t.dash, t.tail
    T = len(toks)
    k = len(words)

    def positions(i):
        """The words that word i of the phrase can be, by its position."""
        w = words[i]
        first = i == 0
        last = i == k - 1 and not trailing_gap
        key = ("f" if first else "") + ("l" if last else "") + ("b" if bounded else "") + ":" + w
        hit = t.memo.get(key)
        if hit is not None:
            return hit
        lw = len(w)
        if first:
            out = [q for q, tok in enumerate(toks) if tok.endswith(w)]
        elif last:
            out = [q for q, tok in enumerate(toks) if tok.startswith(w)]
        else:
            out = [q for q, tok in enumerate(toks) if tok == w]
        if bounded:
            kept = []
            for q in out:
                tok = toks[q]
                if first and len(tok) > lw and tok[len(tok) - lw - 1] in _WORD:
                    continue
                if last and len(tok) > lw and (tok[lw] in _WORD or tok[lw] == "."):
                    continue
                kept.append(q)
            out = kept
        t.memo[key] = out
        return out

    # The words at which the rest of the phrase matches, ascending.
    ok = positions(k - 1)
    if trailing_gap:
        kept = []
        for q in ok:
            r = q + 1
            if r < T:
                if sep[r] or (dash[r] and not t.bar[r] and (r + 1 < T or tail)):
                    kept.append(q)
            elif tail:
                kept.append(q)
        ok = kept
    if k == 1:
        return bool(ok)
    nb, nn, ne = _next_index(t)
    for i in range(k - 2, -1, -1):
        ok_sep = [q for q in ok if sep[q]]
        ok_set = set(ok_sep)
        memo = {}

        def option(r):
            # An option run reaches any word before a ;&| word or a real newline.
            j = bisect_left(ok_sep, r + 1)
            return j < len(ok_sep) and ok_sep[j] <= min(nb[r], nn[r + 1], T - 1)

        def reach(r):
            # The gap that starts at word r leads into the rest of the phrase:
            # directly, after an option run, or after -- comments, each of
            # which runs to the next newline.
            path = []
            cur = r
            while True:
                if cur >= T:
                    val = False
                    break
                if cur in memo:
                    val = memo[cur]
                    break
                if cur in ok_set or (dash[cur] and option(cur)):
                    val = memo[cur] = True
                    break
                if not dash[cur]:
                    val = memo[cur] = False
                    break
                path.append(cur)
                cur = ne[cur + 1]
            for x in path:
                memo[x] = val
            return val

        ok = [p for p in positions(i) if reach(p + 1)]
        if not ok:
            return False
    return bool(ok)
`
