"""Tests for the image-integrity checker — one per failure code, plus the
parsing edge cases that would otherwise fail silently in production.

The headline block is E_UNPINNED_LATEST. Everything else here exists so that
block is trustworthy: a checker that passes `:latest` in some spelling, or
that crashes on a CronJob, is worse than no checker at all.
"""

from __future__ import annotations

import os

import pytest

from intutic_clawde.gate import imagecheck as ic

CATALOGUE = "us-central1-docker.pkg.dev/intutic/intutic/sockshop/catalogue"
GOOD_DIGEST = "sha256:0147a65b7116569439eefb1a6dbed455fe022464ef70e0c3cab75bc4a226b39b"
OTHER_DIGEST = "sha256:" + "b" * 64

POLICY = {
    "version": 1,
    "require_digest": True,
    "registries_allowed": ["us-central1-docker.pkg.dev/intutic/intutic"],
    "images": {CATALOGUE: {"approved_digests": [GOOD_DIGEST], "approved_by": "platform-eng"}},
}


def _manifest(image: str, kind: str = "Deployment") -> str:
    return f"""
apiVersion: apps/v1
kind: {kind}
metadata:
  name: catalogue
  namespace: sock-shop
spec:
  template:
    spec:
      containers:
        - name: catalogue
          image: {image}
"""


@pytest.fixture()
def repo(tmp_path):
    (tmp_path / "k8s").mkdir()
    return str(tmp_path)


def _write(repo_root: str, image: str, name: str = "catalogue.yaml", kind: str = "Deployment") -> str:
    p = os.path.join(repo_root, "k8s", name)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(_manifest(image, kind))
    return f"k8s/{name}"


class TestReferenceParsing:
    def test_digest_pinned(self):
        r = ic.parse_image_ref(f"{CATALOGUE}:0.3.5@{GOOD_DIGEST}")
        assert r.repository == CATALOGUE and r.tag == "0.3.5" and r.digest == GOOD_DIGEST
        assert r.is_pinned

    def test_tag_only(self):
        r = ic.parse_image_ref(f"{CATALOGUE}:0.3.5")
        assert r.tag == "0.3.5" and r.digest is None and not r.is_pinned

    def test_no_tag(self):
        r = ic.parse_image_ref("mongo")
        assert r.repository == "mongo" and r.tag is None

    def test_registry_port_is_not_a_tag(self):
        """`localhost:5000/foo` — the colon is a port, not a tag."""
        r = ic.parse_image_ref("localhost:5000/foo")
        assert r.repository == "localhost:5000/foo" and r.tag is None

    def test_registry_port_with_tag(self):
        r = ic.parse_image_ref("localhost:5000/foo:v1")
        assert r.repository == "localhost:5000/foo" and r.tag == "v1"


class TestFailureCodes:
    def test_latest_tag_blocks(self, repo):
        rel = _write(repo, f"{CATALOGUE}:latest")
        v = ic.check_command(f"kubectl apply -f {rel}", repo, POLICY)
        assert not v.ok and v.code == ic.E_UNPINNED_LATEST
        assert "not pinned" in v.reason

    def test_untagged_blocks_as_latest(self, repo):
        """An untagged ref *is* `:latest`; it must not slip past."""
        rel = _write(repo, CATALOGUE)
        v = ic.check_command(f"kubectl apply -f {rel}", repo, POLICY)
        assert not v.ok and v.code == ic.E_UNPINNED_LATEST

    def test_real_tag_without_digest_blocks(self, repo):
        rel = _write(repo, f"{CATALOGUE}:0.3.5")
        v = ic.check_command(f"kubectl apply -f {rel}", repo, POLICY)
        assert not v.ok and v.code == ic.E_UNPINNED_TAG

    def test_unknown_registry_blocks(self, repo):
        rel = _write(repo, f"docker.io/weaveworksdemos/catalogue:0.3.5@{GOOD_DIGEST}")
        v = ic.check_command(f"kubectl apply -f {rel}", repo, POLICY)
        assert not v.ok and v.code == ic.E_UNKNOWN_REGISTRY

    def test_unknown_image_blocks(self, repo):
        other = "us-central1-docker.pkg.dev/intutic/intutic/sockshop/not-reviewed"
        rel = _write(repo, f"{other}:1.0@{GOOD_DIGEST}")
        v = ic.check_command(f"kubectl apply -f {rel}", repo, POLICY)
        assert not v.ok and v.code == ic.E_UNKNOWN_IMAGE

    def test_wrong_digest_blocks(self, repo):
        rel = _write(repo, f"{CATALOGUE}:0.3.5@{OTHER_DIGEST}")
        v = ic.check_command(f"kubectl apply -f {rel}", repo, POLICY)
        assert not v.ok and v.code == ic.E_DIGEST_MISMATCH

    def test_approved_digest_passes(self, repo):
        rel = _write(repo, f"{CATALOGUE}:0.3.5@{GOOD_DIGEST}")
        v = ic.check_command(f"kubectl apply -f {rel}", repo, POLICY)
        assert v.ok, v.reason


class TestFailClosed:
    def test_missing_file_fails_closed(self, repo):
        v = ic.check_command("kubectl apply -f k8s/does-not-exist.yaml", repo, POLICY)
        assert not v.ok and v.code == ic.E_MANIFEST_UNPARSEABLE

    def test_stdin_fails_closed(self, repo):
        """`cat x | kubectl apply -f -` cannot be verified, so it is refused."""
        v = ic.check_command("kubectl apply -f -", repo, POLICY)
        assert not v.ok and v.code == ic.E_MANIFEST_UNPARSEABLE

    def test_remote_url_fails_closed(self, repo):
        v = ic.check_command("kubectl apply -f https://example.com/x.yaml", repo, POLICY)
        assert not v.ok and v.code == ic.E_MANIFEST_UNPARSEABLE

    def test_malformed_yaml_fails_closed(self, repo):
        p = os.path.join(repo, "k8s", "bad.yaml")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("image: [unclosed\n  nope: :\n")
        v = ic.check_command("kubectl apply -f k8s/bad.yaml", repo, POLICY)
        assert not v.ok and v.code == ic.E_MANIFEST_UNPARSEABLE


class TestCoverage:
    def test_directory_apply_checks_every_file(self, repo):
        _write(repo, f"{CATALOGUE}:0.3.5@{GOOD_DIGEST}", "good.yaml")
        _write(repo, f"{CATALOGUE}:latest", "bad.yaml")
        v = ic.check_command("kubectl apply -f k8s/", repo, POLICY)
        assert not v.ok and v.code == ic.E_UNPINNED_LATEST

    def test_init_containers_are_checked(self, repo):
        p = os.path.join(repo, "k8s", "init.yaml")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(f"""
apiVersion: apps/v1
kind: Deployment
metadata: {{name: c}}
spec:
  template:
    spec:
      initContainers:
        - name: wait
          image: {CATALOGUE}:latest
      containers:
        - name: c
          image: {CATALOGUE}:0.3.5@{GOOD_DIGEST}
""")
        v = ic.check_command("kubectl apply -f k8s/init.yaml", repo, POLICY)
        assert not v.ok and v.code == ic.E_UNPINNED_LATEST

    def test_cronjob_nesting_is_reached(self, repo):
        """CronJob buries containers two levels deeper than a Deployment."""
        p = os.path.join(repo, "k8s", "cron.yaml")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(f"""
apiVersion: batch/v1
kind: CronJob
metadata: {{name: reap}}
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: reap
              image: {CATALOGUE}:latest
""")
        v = ic.check_command("kubectl apply -f k8s/cron.yaml", repo, POLICY)
        assert not v.ok and v.code == ic.E_UNPINNED_LATEST

    def test_multi_doc_yaml(self, repo):
        p = os.path.join(repo, "k8s", "multi.yaml")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(_manifest(f"{CATALOGUE}:0.3.5@{GOOD_DIGEST}") + "\n---\n" + _manifest(f"{CATALOGUE}:latest"))
        v = ic.check_command("kubectl apply -f k8s/multi.yaml", repo, POLICY)
        assert not v.ok and v.code == ic.E_UNPINNED_LATEST

    def test_kubectl_set_image_caught_without_a_manifest(self, repo):
        """`kubectl set image` never touches a file, so the YAML path misses it."""
        v = ic.check_command(
            f"kubectl set image deploy/catalogue catalogue={CATALOGUE}:latest -n sock-shop",
            repo, POLICY)
        assert not v.ok and v.code == ic.E_UNPINNED_LATEST

    def test_rollout_restart_names_no_image_and_passes(self, repo):
        """No image named is not an image-provenance decision. Let it through."""
        v = ic.check_command("kubectl rollout restart deploy/catalogue -n sock-shop", repo, POLICY)
        assert v.ok


class TestAuthoringTimeCheck:
    def test_written_manifest_is_flagged(self):
        v = ic.check_written_manifest("k8s/catalogue.yaml", _manifest(f"{CATALOGUE}:latest"), POLICY)
        assert not v.ok and v.code == ic.E_UNPINNED_LATEST

    def test_written_good_manifest_passes(self):
        v = ic.check_written_manifest(
            "k8s/catalogue.yaml", _manifest(f"{CATALOGUE}:0.3.5@{GOOD_DIGEST}"), POLICY)
        assert v.ok

    def test_non_manifest_content_passes(self):
        v = ic.check_written_manifest("k8s/notes.yaml", "just: a value\n", POLICY)
        assert v.ok


class TestTrigger:
    def test_deploy_command_triggers_check(self):
        assert ic.is_deploy_command("shell", {"command": "kubectl apply -f k8s/"})

    def test_benign_command_does_not(self):
        assert not ic.is_deploy_command("shell", {"command": "ls -la"})

    def test_a_namespaced_apply(self):
        assert ic.is_deploy_command("shell", {"command": "kubectl apply -f k8s/catalogue.yaml -n sock-shop"})
