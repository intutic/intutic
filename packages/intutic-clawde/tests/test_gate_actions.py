"""Prove gate/actions.py still matches the proxy's actions.rs.

The gate blocks a turn *before* the proxy sees it. If the two classifiers
disagree, one of two bad things happens: the gate stops something the proxy
would have allowed, or it waves through something the proxy then refuses with
a different reason. Either way the run tells two stories.

Intutic already applies this discipline to itself — services/sync-daemon has a
hookActionParity test that fails the build when actions.rs and
claudeCodeHooks.ts:452 drift. This is the same test for the SDK's consumer.

If this test fails, actions.rs changed. Re-read it and update gate/actions.py;
do not edit the assertion.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from intutic_clawde.gate import actions

# actions.rs lives in this same repository; the env var exists for running the
# suite from an sdist or another checkout.
_DEFAULT_ACTIONS_RS = str(
    Path(__file__).resolve().parents[3] / "packages" / "proxy" / "src"
    / "plugins" / "anomaly" / "actions.rs"
)
ACTIONS_RS = os.environ.get("INTUTIC_ACTIONS_RS", _DEFAULT_ACTIONS_RS)

pytestmark_parity = pytest.mark.skipif(
    not os.path.exists(ACTIONS_RS),
    reason=f"actions.rs not available at {ACTIONS_RS}; set INTUTIC_ACTIONS_RS",
)


def _rust_list(name: str) -> list[str]:
    """Pull a `const NAME: &[&str] = &[ ... ];` list out of the Rust source."""
    import re
    src = open(ACTIONS_RS, encoding="utf-8").read()
    m = re.search(rf"{name}:\s*&\[&str\]\s*=\s*&\[(.*?)\];", src, re.S)
    assert m, f"{name} not found in {ACTIONS_RS} — did the Rust get restructured?"
    # String literals only; skips the `//` comments interleaved in these blocks.
    return re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))


@pytestmark_parity
@pytest.mark.parametrize(
    "rust_name,py_value",
    [
        ("DEPLOY_PATTERNS", actions.DEPLOY_PATTERNS),
        ("PUBLISH_PATTERNS", actions.PUBLISH_PATTERNS),
        ("RELEASE_PATTERNS", actions.RELEASE_PATTERNS),
        ("TEST_PATTERNS", actions.TEST_PATTERNS),
        ("HTTP_POST_PATTERNS", actions.HTTP_POST_PATTERNS),
        ("DB_WRITE_PATTERNS", actions.DB_WRITE_PATTERNS),
        ("SECRET_PATH_FRAGMENTS", actions.SECRET_PATH_FRAGMENTS),
        ("PII_PATH_FRAGMENTS", actions.PII_PATH_FRAGMENTS),
        ("SHELL_TOOLS", actions.SHELL_TOOLS),
        ("READ_TOOLS", actions.READ_TOOLS),
        ("FETCH_TOOLS", actions.FETCH_TOOLS),
    ],
)
def test_pattern_lists_match_rust(rust_name, py_value):
    assert _rust_list(rust_name) == py_value, (
        f"{rust_name} drifted from actions.rs. Update gate/actions.py to match "
        f"the Rust, not the other way round."
    )


def test_trailing_spaces_preserved():
    """`"update "` without its space matches every occurrence of the word."""
    assert "update " in actions.DB_WRITE_PATTERNS
    assert "truncate " in actions.DB_WRITE_PATTERNS
    assert "curl -d " in actions.HTTP_POST_PATTERNS


class TestClassify:
    def test_kubectl_apply_is_deploy(self):
        assert actions.classify("shell", {"command": "kubectl apply -f k8s/catalogue.yaml"}) == [
            "action:deploy"
        ]

    def test_git_push_is_deploy(self):
        assert "action:deploy" in actions.classify("shell", {"command": "git push origin main"})

    def test_tests_are_ordered_before_deploy(self):
        """`make test && kubectl apply` must emit run_tests first.

        MissingPredecessorDetector reads position in the sequence, so emitting
        the deploy first would make a single compound command look like a
        deploy with no prior test.
        """
        assert actions.classify("shell", {"command": "make test && kubectl apply -f k8s/"}) == [
            "action:run_tests",
            "action:deploy",
        ]

    def test_unknown_argument_key_still_classifies(self):
        """flatten_input reads every string value, not a fixed key."""
        assert "action:deploy" in actions.classify("shell", {"totally_new_key": "kubectl apply -f x.yaml"})

    def test_nested_and_list_arguments(self):
        assert "action:deploy" in actions.classify("shell", {"argv": ["kubectl", "apply", "-f", "k8s/"]})

    def test_case_insensitive(self):
        assert "action:deploy" in actions.classify("shell", {"command": "KUBECTL APPLY -f k8s/"})

    def test_non_shell_tool_emits_nothing(self):
        """Only shell-family tools get command classification."""
        assert actions.classify("write_file", {"path": "k8s/x.yaml", "content": "kubectl apply"}) == []

    def test_namespaced_tool_name_matches_by_suffix(self):
        assert actions.tool_is("mcp__sandbox__bash", actions.SHELL_TOOLS)

    def test_benign_command_is_unclassified(self):
        assert actions.classify("shell", {"command": "ls -la"}) == []

    def test_kubeconfig_synthesises_secret_read(self):
        """Pinned so nobody assumes `--kubeconfig` is inert: it trips the
        secret_read -> http_post forbidden succession in the proxy."""
        assert "action:secret_read" in actions.classify(
            "shell", {"command": "kubectl --kubeconfig /tmp/kc apply -f k8s/"}
        )


class TestInfraPaths:
    def test_k8s_path_is_infra(self):
        assert actions.touches_infra("k8s/catalogue.yaml")

    def test_terraform_is_infra(self):
        assert actions.touches_infra("infra/main.tf")

    def test_src_is_not_infra(self):
        assert not actions.touches_infra("src/app.py")
