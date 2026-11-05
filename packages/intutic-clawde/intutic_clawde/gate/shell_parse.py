"""A shell command, read as the commands it runs, or not at all.

Deliberately a small subset of shell: words, quotes, escapes, comments and the
operators ;, &, &&, |, |&, || and newline. Anything else (a
redirect, subshell, group, substitution, heredoc, control word) returns None,
and so does anything malformed, because None is the answer that fails safe:
every caller keeps its old behaviour on it.

A port of the proxy's shell_parse.rs; @intutic/gate shellParse.ts is
another. All three run shell-parse-vectors.json in @intutic/shared-types.
"""

# Words that open a construct this parser does not model. alias is here
# because it changes what the next word means.
SHELL_CONTROL_WORDS = frozenset(
    "if then else elif fi for while until do done case esac "
    "select function coproc alias".split()
)
_BACKTICK = chr(96)  # no such character in this file: the gate's copy sits in a template string
_SHELL_NAME = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")


class SimpleCommand:
    """One command and its arguments.

    argv is the words after quote removal. literal is False when a word
    still holds an expansion or glob, so argv is not exactly what runs.
    """

    __slots__ = ("start", "end", "argv", "literal")

    def __init__(self, start, end):
        self.start = start
        self.end = end
        self.argv = []
        self.literal = True


def _shell_is_assignment(text, i):
    """NAME= at i: the word sets a variable for the command after it."""
    j = i
    while j < len(text) and text[j] in _SHELL_NAME:
        j += 1
    return j > i and not text[i].isdigit() and text[j:j + 1] == "="


def parse_shell(text):
    """text as pipelines of simple commands, or None when not understood."""
    pipelines = []
    pipeline = []
    command = None
    word = None
    pipe_open = False
    i = 0
    n = len(text)

    def start_word(at):
        nonlocal word, command
        if word is None:
            word = []
        if command is None:
            command = SimpleCommand(start=at, end=at)

    def end_word(at):
        nonlocal word
        if word is not None and command is not None:
            command.argv.append("".join(word))
            command.end = at
        word = None

    while i < n:
        c = text[i]
        if c in " \t":
            end_word(i)
            i += 1
        elif c == "\\" and text[i + 1:i + 2] == "\n":
            i += 2
        elif c == "\\":
            if i + 1 >= n:
                return None
            start_word(i)
            word.append(text[i + 1])
            i += 2
        elif c == "'":
            start_word(i)
            close = text.find("'", i + 1)
            if close == -1:
                return None
            word.append(text[i + 1:close])
            i = close + 1
        elif c == '"':
            start_word(i)
            i += 1
            while True:
                if i >= n:
                    return None
                q = text[i]
                if q == '"':
                    break
                if q == _BACKTICK:
                    return None
                if q == "$":
                    if text[i + 1:i + 2] == "(":
                        return None
                    command.literal = False
                if q == "\\":
                    if i + 1 >= n:
                        return None
                    following = text[i + 1]
                    if following not in '$"\\\n' + _BACKTICK:
                        word.append("\\")
                    if following != "\n":
                        word.append(following)
                    i += 2
                    continue
                word.append(q)
                i += 1
            i += 1
        elif c == "#" and word is None:
            while i < n and text[i] != "\n":
                i += 1
        elif c in "<>(){}" + _BACKTICK:
            return None
        elif c in "\n;&|":
            end_word(i)
            doubled = c in "&|" and text[i + 1:i + 2] == c
            if command is not None:
                if command.argv[0] in SHELL_CONTROL_WORDS:
                    return None
                pipeline.append(command)
                command = None
            elif c == "\n":
                # A newline may follow an operator or stand alone.
                i += 1
                continue
            else:
                # Any other operator here has nothing to its left.
                return None
            pipe_open = c == "|" and not doubled
            if pipe_open:
                if text[i + 1:i + 2] == "&":
                    i += 1
            else:
                pipelines.append(pipeline)
                pipeline = []
            i += 2 if doubled else 1
        else:
            if c in "$*?[~" or (word is None and _shell_is_assignment(text, i)):
                start_word(i)
                command.literal = False
            start_word(i)
            word.append(c)
            i += 1

    end_word(n)
    if command is not None:
        if command.argv[0] in SHELL_CONTROL_WORDS:
            return None
        pipeline.append(command)
    elif pipe_open:
        return None
    if pipeline:
        pipelines.append(pipeline)
    return pipelines


def drop_carried_text(text):
    """text without the text no command consumes: a lone echo, printf or
    git commit. Unchanged unless the whole of it parsed."""
    pipelines = parse_shell(text)
    if pipelines is None:
        return text
    out = []
    kept = 0
    for pipeline in pipelines:
        if len(pipeline) != 1:
            continue
        only = pipeline[0]
        # printf -v keeps the text for whatever reads the variable.
        carries = only.argv[0] == "echo" or (only.argv[0] == "printf" and only.argv[1:2] != ["-v"])
        if carries or only.argv[:2] == ["git", "commit"]:
            out.append(text[kept:only.start])
            kept = only.end
    out.append(text[kept:])
    return "".join(out)


def _allow_entry(entry):
    """An allow_commands: entry as (argv, open), or None when it is not one
    plain command: git status, or npm test * for any further arguments. A
    word that could expand matches nothing exactly, so an entry may not hold
    one."""
    is_open = entry.endswith(" *")
    parsed = parse_shell(entry[:-2] if is_open else entry)
    if parsed is None or len(parsed) != 1 or len(parsed[0]) != 1:
        return None
    only = parsed[0][0]
    if not only.literal or any(c in word for word in only.argv for c in "$*?[~"):
        return None
    return only.argv, is_open


def is_allow_entry(entry):
    """Whether entry is one allow_commands: can use."""
    return _allow_entry(entry) is not None


def commands_outside_allow(text, allow):
    """The commands in text that allow does not allow, as written, in order.

    All of text when it did not parse, or when an entry cannot be read: an
    allow list that reaches no verdict allows nothing, the opposite of
    drop_carried_text, which keeps its old behaviour on the same input.
    """
    parsed = parse_shell(text)
    entries = [_allow_entry(e) for e in allow]
    if parsed is None or any(e is None for e in entries):
        return [text]
    out = []
    for pipeline in parsed:
        for c in pipeline:
            allowed = any(
                (len(c.argv) >= len(argv) if is_open else c.literal and len(c.argv) == len(argv))
                and c.argv[: len(argv)] == argv
                for argv, is_open in entries
            )
            if not allowed:
                out.append(text[c.start:c.end])
    return out
