import json
import subprocess
from pathlib import Path

import pytest

from intutic_clawde.git_context import normalize_git_remote, resolve_git_context

ROOT = Path(__file__).resolve().parents[3]
#: The vectors shared-types' normalizeGitRemote and the TypeScript SDK's copy are held to.
VECTORS = json.loads(
    (ROOT / "packages" / "shared-types" / "fixtures" / "git-remote-vectors.json").read_text(encoding="utf-8")
)["vectors"]


@pytest.mark.parametrize("vector", VECTORS, ids=[repr(v["remote"]) for v in VECTORS])
def test_normalize_git_remote_matches_the_shared_vectors(vector):
    assert normalize_git_remote(vector["remote"]) == vector["normalized"]


def _repo(path: Path) -> Path:
    def git(*args):
        return subprocess.run(["git", *args], cwd=path, check=True, capture_output=True, text=True).stdout.strip()

    git("init", "-q", "-b", "feature/attribution")
    git("-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-q", "--allow-empty", "-m", "first")
    # A CI checkout's remote carries a token; it must not leave the machine.
    git("remote", "add", "origin", "https://x-access-token:not-a-secret@github.com/acme/widgets.git")
    return path


def test_reads_repository_branch_and_commit_without_the_remotes_credentials(tmp_path, monkeypatch):
    monkeypatch.delenv("GITHUB_HEAD_REF", raising=False)
    repo = _repo(tmp_path)
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True).stdout.strip()
    assert resolve_git_context(str(repo)) == {
        "repoUrl": "github.com/acme/widgets",
        "branchName": "feature/attribution",
        "commitHash": commit,
    }


def test_takes_the_branch_from_github_head_ref_on_a_detached_head(tmp_path, monkeypatch):
    repo = _repo(tmp_path)
    subprocess.run(["git", "checkout", "-q", "--detach"], cwd=repo, check=True)
    monkeypatch.setenv("GITHUB_HEAD_REF", "feature/from-ci")
    assert resolve_git_context(str(repo), "fallback")["branchName"] == "feature/from-ci"
    monkeypatch.delenv("GITHUB_HEAD_REF")
    assert resolve_git_context(str(repo), "fallback")["branchName"] == "fallback"


def test_is_empty_outside_a_repository(tmp_path, monkeypatch):
    monkeypatch.delenv("GITHUB_HEAD_REF", raising=False)
    assert resolve_git_context(str(tmp_path)) == {}
