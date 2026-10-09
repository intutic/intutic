"""The repository, branch and HEAD commit a process runs in: what cost per
branch, per commit and per pull request is attributed by.

The control plane copies a session's git context onto every trace it records
under that session (``POST /api/v1/sessions`` takes ``repoUrl``,
``branchName`` and ``commitHash``, the same fields the sync daemon reports),
so this is what ClawdeClient registers its session with. Without it, SDK
traffic is filed under "No git context". The Python twin of the TypeScript
SDK's ``git-context.ts``.
"""

import os
import re
import subprocess
from typing import Dict, Optional
from urllib.parse import urlsplit

#: Schemes git can fetch over the network. ``file:`` and local paths are not
#: repositories anyone else can name.
_NETWORK_SCHEMES = {"http", "https", "ssh", "git", "git+ssh", "ssh+git"}

_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)
# scp-like: [user[:password]@]host:path. A colon after the first slash makes
# it a local path, which is how git itself tells them apart.
_SCP = re.compile(r"^(?:[^@/]+@)?([^:/\s]+):(\S+)$")
_SHA1 = re.compile(r"^[0-9a-f]{40}$")


def normalize_git_remote(remote: str) -> Optional[str]:
    """A remote reduced to ``host/path``: lower-cased host, no scheme, user,
    password, port, query, fragment or ``.git`` suffix; None for anything that
    is not a network remote. A copy of ``normalizeGitRemote`` in
    ``@intutic/shared-types``, held to the same vectors in
    ``packages/shared-types/fixtures/git-remote-vectors.json``. Normalised
    here, before it leaves the machine: a CI checkout's remote embeds a token.
    """
    raw = remote.strip()
    if not raw or "\\" in raw or re.match(r"^[a-zA-Z]:/", raw):
        return None

    if _SCHEME.match(raw):
        try:
            url = urlsplit(raw)
            host = url.hostname or ""
        except ValueError:
            return None
        if url.scheme.lower() not in _NETWORK_SCHEMES:
            return None
        path = url.path
    else:
        scp = _SCP.match(raw)
        if not scp:
            return None
        host = scp.group(1)
        path = re.split(r"[?#]", scp.group(2), maxsplit=1)[0]

    path = path.strip("/")
    if path.endswith(".git"):
        path = path[: -len(".git")]
    path = path.strip("/")
    if not host or not path:
        return None
    return f"{host.lower()}/{path}"


def _git(cwd: str, *args: str) -> Optional[str]:
    try:
        out = subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=3, check=True
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return out or None


def resolve_git_context(cwd: str, fallback_branch: Optional[str] = None) -> Dict[str, str]:
    """The git context of ``cwd``, best effort: a directory that is not a
    repository, or a machine without git, gives an empty dict.

    A detached HEAD names no branch. That is how CI checks out a pull request,
    so the branch then comes from ``GITHUB_HEAD_REF`` (GitHub Actions' pull
    request head branch), else ``fallback_branch`` (``resolve_context()``'s
    ``gitBranch``). Values the control plane's session route would refuse are
    left out rather than failing the registration.
    """
    remote = _git(cwd, "remote", "get-url", "origin")
    head = _git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
    commit = _git(cwd, "rev-parse", "HEAD")

    repo_url = normalize_git_remote(remote) if remote else None
    branch = (head if head != "HEAD" else None) or os.environ.get("GITHUB_HEAD_REF") or fallback_branch
    context: Dict[str, str] = {}
    if repo_url and len(repo_url) <= 512:
        context["repoUrl"] = repo_url
    if branch and len(branch) <= 256:
        context["branchName"] = branch
    # A SHA-1 object id; a SHA-256 repository's 64-character id does not fit the column.
    if commit and _SHA1.match(commit):
        context["commitHash"] = commit
    return context
