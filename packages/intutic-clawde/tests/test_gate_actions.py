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


_VECTORS = Path(ACTIONS_RS).with_name("action_vectors.json")


def _vectors() -> dict:
    import json
    return json.loads(_VECTORS.read_text(encoding="utf-8")) if _VECTORS.exists() else {"held": [], "notHeld": []}


@pytestmark_parity
@pytest.mark.parametrize("command,tokens", _vectors()["held"])
def test_shared_vector_classifies_as_listed(command, tokens):
    # The vectors every classifier shares (actions.rs, actions.ts, the hook
    # gates' hold classifier): `git\tpush`, a line continuation or a long
    # option between the words used to classify as nothing here.
    assert actions.classify("bash", {"command": command}) == tokens


@pytestmark_parity
@pytest.mark.parametrize("command", _vectors()["notHeld"])
def test_shared_vector_classifies_as_nothing(command):
    assert actions.classify("bash", {"command": command}) == []


def _adversarial():
    v = _vectors()
    return v.get("adversarial", [])


@pytestmark_parity
@pytest.mark.parametrize("unit,times", _adversarial())
def test_adversarial_input_classifies_in_linear_time(unit, times):
    # The proxy's regex (SQL_GAP in actions.rs) is safe in Rust's linear
    # engine; Python's backtracking one took seconds on text an agent can be
    # talked into writing. The phrase matcher must stay linear on these.
    import time

    command = unit * times
    t0 = time.perf_counter()
    actions.classify("bash", {"command": command})
    assert time.perf_counter() - t0 < 0.2


@pytest.mark.parametrize(
    "command",
    [
        "psql -c 'DROP\nTABLE users'",
        "psql -c 'DROP\tTABLE users'",
        "psql -c 'DROP/**/TABLE users'",
        "psql -c 'DROP /* why */ TABLE users'",
        "psql -c 'DROP -- why\nTABLE users'",
        "psql -c 'dRoP tAbLe users'",
        r"printf 'DROP\nTABLE users' | psql",
        r"printf 'DROP -- why\nTABLE users' | psql",
    ],
)
def test_db_write_whatever_separates_the_keywords(command):
    """A plain "drop table" substring missed every one of these."""
    assert actions.classify("shell", {"command": command}) == ["action:db_write"]


def test_db_write_from_json_escaped_arguments():
    import json
    decoded = json.loads(r'{"command": "psql -c \"DROP\nTABLE users\""}')
    assert actions.classify("shell", decoded) == ["action:db_write"]


@pytest.mark.parametrize(
    "command", ["git stash drop", "psql --table-only", "drop_table_helper.sh", "dropdb --help"]
)
def test_a_keyword_alone_is_not_a_db_write(command):
    assert "action:db_write" not in actions.classify("shell", {"command": command})


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
