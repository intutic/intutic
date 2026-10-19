"""Scope and plan semantics, ported from the proxy so every surface answers
"is this change inside the scope?" and "is this run on its plan?" the same way
.

A transliteration of packages/shared-types/src/scopeMatch.ts; read that
module's docstring for each function's port of origin (detectors.rs,
sops.rs, manifest.rs). Every port runs
packages/shared-types/fixtures/scope-plan-vectors.json.

The bash hook gates emit this file after the phrase matcher's (phrases.py),
which is_file_write_call calls: imported here as a module, and found in the
emitting script's scope when it is not one. Otherwise the standard library
only, and no backtick or dollar-brace, which a TypeScript copy cannot hold.
"""

try:
    from .phrases import has_phrase, phrase_text
except (ImportError, KeyError):  # embedded in a bash gate (exec without __name__), beside the phrase matcher's source
    pass

PLAN_DEVIATION_TOLERANCE = 0.4
NARROWED_TO_NOTHING = "<none: workspace list disjoint from org ceiling>"

SCOPE_WRITE_TOOLS = ("write", "write_file", "writefile", "create_file", "createfile")
SCOPE_EDIT_TOOLS = ("edit", "edit_file", "editfile", "multiedit", "apply_patch", "str_replace", "notebookedit")
SCOPE_DELETE_TOOLS = ("delete_file", "deletefile", "remove_file", "rm_file")
SCOPE_MOVE_TOOLS = ("move_file", "movefile", "rename_file", "rename")
SCOPE_EDITOR_TOOLS = ("str_replace_editor", "text_editor", "texteditor", "str_replace_based_edit_tool")
SCOPE_PATH_KEYS = ("file_path", "filepath", "path", "filename", "target_file", "notebook_path")
SCOPE_COMMAND_KEYS = ("command", "cmd", "script")
SCOPE_SHELL_TOOLS = ("bash", "shell", "run_command", "runcommand", "execute_command", "run_shell_command",
                     "terminal", "execute", "exec")
SCOPE_READ_TOOLS = ("read", "readfile", "view", "cat", "open_file")
SCOPE_MOVE_FROM_KEYS = ("source", "source_path", "from", "old_path")
SCOPE_MOVE_TO_KEYS = ("destination", "destination_path", "to", "new_path")
SCOPE_TARGET_MAX_BYTES = 512
PLAN_EXEMPT_TOOLS = ("read", "readfile", "view", "cat", "open_file", "glob", "grep", "ls", "list_dir", "search",
                     "todowrite")
FILE_WRITE_SHELL_PHRASES = ("sed -i", "perl -i", "perl -pi", "git apply", "git am", "git checkout", "git switch",
                            "git restore", "git reset", "git merge", "git pull", "git rebase", "git cherry-pick",
                            "git revert", "git stash pop", "git stash apply", "patch -p")


def _ascii_lower(s):
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def _tool_is(name, group):
    lower = name.lower()
    return any(lower == t or lower.endswith(t) for t in group)


def _keyed(inp, keys):
    if not isinstance(inp, dict):
        return None
    for k in keys:
        v = inp.get(k)
        if isinstance(v, str) and v != "":
            return v
    return None


def _utf8_len(ch):
    cp = ord(ch)
    return 1 if cp < 0x80 else 2 if cp < 0x800 else 3 if cp < 0x10000 else 4


def _clip(s):
    total = 0
    for i, ch in enumerate(s):
        n = _utf8_len(ch)
        if total + n > SCOPE_TARGET_MAX_BYTES:
            return s[:i] + "…"
        total += n
    return s


def _norm_scope(s):
    t = s
    while t[:2] == "./":
        t = t[2:]
    t = t.lstrip("/").rstrip("/")
    return _ascii_lower(t)


def is_within_scope(target, scopes):
    """Segment-prefix match of target against scopes, ignoring ASCII case and leading ./ or /."""
    t = _norm_scope(target)
    for raw in scopes:
        s = _norm_scope(raw)
        if s == "" or t == s or t[:len(s) + 1] == s + "/":
            return True
    return False


def sop_applies_to_role(roles, role):
    if not roles:
        return True
    if role == "":
        return False
    return _ascii_lower(role) in roles


def collect_scope_paths(sops, role):
    """The path scope in force for role (sops.rs collect_scope_paths), org ceiling included."""
    workspace, org = [], []
    for s in sops:
        if not sop_applies_to_role(s["roles"], role):
            continue
        (org if s["scope"] == "org" else workspace).extend(s["scopePaths"])
    if not org:
        out = workspace
    elif not workspace:
        out = org
    else:
        out = [w for w in workspace if is_within_scope(w, org)] or [NARROWED_TO_NOTHING]
    return sorted(set(out))


def collect_plan_steps(sops, role):
    """The plan in force for role (sops.rs collect_plan_steps), org ceiling included."""
    workspace, org = [], []
    for s in sops:
        if not sop_applies_to_role(s["roles"], role):
            continue
        (org if s["scope"] == "org" else workspace).extend(s["planSteps"])
    if not org:
        return workspace
    if not workspace:
        return org
    allowed = {_ascii_lower(o) for o in org}
    return [w for w in workspace if _ascii_lower(w) in allowed] or [NARROWED_TO_NOTHING]


def plan_off_steps(sequence, plan_steps, tolerance):
    """{"offPlan", "ratio"}: the off-plan names, sorted and deduplicated, when their share is over tolerance."""
    if not plan_steps or not sequence:
        return {"offPlan": [], "ratio": 0}
    plan = {_ascii_lower(p) for p in plan_steps}
    off = [t for t in sequence if _ascii_lower(t) not in plan]
    if not off:
        return {"offPlan": [], "ratio": 0}
    ratio = len(off) / len(sequence)
    if ratio <= tolerance:
        return {"offPlan": [], "ratio": ratio}
    return {"offPlan": sorted(set(off)), "ratio": min(1, ratio)}


def change_targets(tool, inp):
    """The mutations one tool call makes, as the proxy's change manifest records them."""
    if _tool_is(tool, SCOPE_MOVE_TOOLS):
        src = _keyed(inp, SCOPE_MOVE_FROM_KEYS)
        dst = _keyed(inp, SCOPE_MOVE_TO_KEYS)
        if src is not None or dst is not None:
            return [{"op": "move", "target": _clip(t)} for t in (src, dst) if t is not None]
    op = None
    if _tool_is(tool, SCOPE_EDITOR_TOOLS):
        command = inp.get("command") if isinstance(inp, dict) else None
        command = _ascii_lower(command) if isinstance(command, str) else ""
        if command == "view":
            return []
        op = "write" if command == "create" else "edit"
    elif _tool_is(tool, SCOPE_WRITE_TOOLS):
        op = "write"
    elif _tool_is(tool, SCOPE_EDIT_TOOLS):
        op = "edit"
    elif _tool_is(tool, SCOPE_DELETE_TOOLS):
        op = "delete"
    if op is None:
        return []
    target = _keyed(inp, SCOPE_PATH_KEYS)
    return [] if target is None else [{"op": op, "target": _clip(target)}]


def _diff_path(raw, prefix):
    p = raw
    tab = p.find("\t")
    if tab != -1:
        p = p[:tab]
    p = p.strip(" ")
    if len(p) >= 2 and p[0] == '"' and p[-1] == '"':
        p = p[1:-1]
    if p in ("/dev/null", ""):
        return None
    if prefix and p[:len(prefix)] == prefix:
        p = p[len(prefix):]
    return p or None


def diff_changed_paths(diff):
    """The paths a diff changes, in the order first seen, each once."""
    out = []

    def add(p):
        if p is not None and p not in out:
            out.append(p)

    for raw in diff.split("\n"):
        line = raw[:-1] if raw.endswith("\r") else raw
        if line[:11] == "diff --git ":
            rest = line[11:]
            if rest[:2] != "a/":
                continue
            first = rest.find(" b/")
            if first == -1:
                continue
            if rest.find(" b/", first + 1) == -1:
                add(_diff_path(rest[:first], "a/"))
                add(_diff_path(rest[first + 1:], "b/"))
            elif (len(rest) - 5) % 2 == 0:
                n = (len(rest) - 5) // 2
                a = rest[2:2 + n]
                if rest[2 + n:5 + n] == " b/" and rest[5 + n:] == a:
                    add(_diff_path(a, ""))
        elif line[:4] == "--- ":
            add(_diff_path(line[4:], "a/"))
        elif line[:4] == "+++ ":
            add(_diff_path(line[4:], "b/"))
        elif line[:12] == "rename from ":
            add(_diff_path(line[12:], ""))
        elif line[:10] == "rename to ":
            add(_diff_path(line[10:], ""))
    return out


def _normalise_path(p):
    parts = []
    for seg in p.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if parts:
                parts.pop()
        else:
            parts.append(seg)
    return "/" + "/".join(parts)


def scope_relative_path(target, cwd, root):
    """target relative to the workspace root, or None when outside it, under ~, or unresolvable."""
    if target == "" or target[:1] == "~" or cwd[:1] != "/" or root[:1] != "/":
        return None
    absolute = _normalise_path(target if target[:1] == "/" else cwd + "/" + target)
    base = _normalise_path(root)
    if absolute == base:
        return ""
    head = "/" if base == "/" else base + "/"
    return absolute[len(head):] if absolute[:len(head)] == head else None


def is_plan_exempt_tool(tool):
    """Whether plan_approval: lets tool run before approval: a PLAN_EXEMPT_TOOLS name, bare or mcp__<server>__<name>."""
    lower = tool.lower()
    return any(lower == t or lower[-(len(t) + 2):] == "__" + t for t in PLAN_EXEMPT_TOOLS)


def is_file_write_call(tool, inp):
    """Whether the call changed files: a mutation, or a shell command with a FILE_WRITE_SHELL_PHRASES phrase."""
    if change_targets(tool, inp):
        return True
    if not _tool_is(tool, SCOPE_SHELL_TOOLS):
        return False
    command = _keyed(inp, SCOPE_COMMAND_KEYS)
    if command is None:
        return False
    words = phrase_text(command)
    return any(has_phrase(words, p) for p in FILE_WRITE_SHELL_PHRASES)
