/**
 * The sequence-rule matcher in Python, for the Open WebUI filter.
 *
 * Byte-identical to `packages/intutic-clawde/intutic_clawde/gate/sequence.py`,
 * which a test compares; edit that file and copy it here. It is the
 * transliteration of `@intutic/shared-types`'s sequence.ts, and both run the
 * shared vectors.
 */
export const SEQUENCE_PY_SOURCE = String.raw`"""Sequence rules: a gate rule "A.*B" run as "find A, then find B after it".

A transliteration of packages/shared-types/src/sequence.ts; read that module's
docstring for when this means the same as the regex. A rule whose .rules
flags column contains "s" is cut into alternatives of steps at its top-level
"|" and ".*", and each step is searched for once, from where the previous one
ended: linear in the text, where re.search on the whole regex backtracks from
every start of the first step to the end of the text.

Every reader runs packages/shared-types/fixtures/gate-rule-vectors.json, and
the Open WebUI filter emits this file verbatim
(services/sync-daemon/src/lib/sequencePy.ts holds a byte-identical copy,
which a test compares). It must stay self-contained: the standard library
only, no module state, and no backtick or dollar-brace, which the TypeScript
copy cannot hold.
"""

import re


def sequence_alternatives(source):
    """Split a sequence rule's source into alternatives of steps."""
    alternatives = []
    steps = []
    current = []
    depth = 0
    in_class = False
    i = 0
    n = len(source)
    while i < n:
        c = source[i]
        if c == "\\":
            current.append(source[i:i + 2])
            i += 2
            continue
        if in_class:
            current.append(c)
            i += 1
            if c == "]":
                in_class = False
            continue
        if c == "[":
            in_class = True
            current.append(c)
            i += 1
            if source[i:i + 1] == "^":
                current.append("^")
                i += 1
            if source[i:i + 1] == "]":
                current.append("]")
                i += 1
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        if depth == 0 and c == "|":
            steps.append("".join(current))
            alternatives.append([s for s in steps if s])
            steps = []
            current = []
            i += 1
            continue
        if depth == 0 and c == "." and source[i + 1:i + 2] == "*":
            steps.append("".join(current))
            current = []
            i += 2
            continue
        current.append(c)
        i += 1
    steps.append("".join(current))
    alternatives.append([s for s in steps if s])
    return alternatives


def compile_sequence(source, flags=0):
    """Compile a sequence rule's steps for sequence_match."""
    return [[re.compile(s, flags) for s in steps] for steps in sequence_alternatives(source)]


def sequence_match(alternatives, text):
    """Whether some alternative's steps occur in text in order."""
    for steps in alternatives:
        pos = 0
        for step in steps:
            m = step.search(text, pos)
            if m is None:
                break
            pos = m.end()
        else:
            return True
    return False
`
