"""Tests for SOP rules authored in the product.

Two properties matter more than the rest, and both are about NOT enforcing:

  * A rule set that fails to load must not become "allow everything" silently
    *or* "block everything" loudly. It must be distinguishable — hence None vs
    [] in fetch_rules.
  * A rule from a control plane predating the ` WHERE ` clause arrives with a
    truncated, uncompilable pattern. It must be skipped, not raised on, or the
    gate dies against an older deployment with a stack trace.

The precedence test is the one an operator would actually notice: if the
image-integrity tier fired first, the block would be attributed to hardcoded
Python rather than to the policy in the register, which inverts the point of
the tier.

These tests also pin parity with the control plane's matchSopRule
(services/control-plane/src/lib/sopRuleTitle.ts) and mcp-proxy's matchRule:
iteration order, first-match-wins, silent skip on uncompilable regex, and the
JSON.stringify-shaped serialisation of the tool input.
"""

from __future__ import annotations

import json

import pytest

from intutic_clawde.gate import gate as gate_mod
from intutic_clawde.gate import snapshot as snapshot_mod
from intutic_clawde.gate import soprules

APPLY = {"command": "kubectl apply -f k8s/catalogue-dep.yaml"}
# Same shape, but the manifest it names is digest-pinned, so the image tier
# allows it. Used to prove a WARN rule really does let the call through —
# against an unpinned manifest the image tier would block anyway and the test
# would pass vacuously.
APPLY_PINNED = {"command": "kubectl apply -f k8s/pinned.yaml"}

_REGISTRY = "us-central1-docker.pkg.dev/intutic/intutic"
_IMAGE = f"{_REGISTRY}/sockshop/catalogue"
_DIGEST = "sha256:" + "a" * 64


def _manifest(image: str) -> str:
    return (
        "apiVersion: apps/v1\nkind: Deployment\n"
        "metadata:\n  name: catalogue\n  namespace: sock-shop\n"
        "spec:\n  template:\n    spec:\n      containers:\n"
        f"        - name: catalogue\n          image: {image}\n"
    )

# The rule the product can express only since the WHERE clause shipped.
DIGEST_RULE = {
    "id": "sp_pin",
    "toolPattern": "^shell$",
    "argPattern": r"kubectl\s+apply(?!.*@sha256:)",
    "action": "block",
    "reason": "deploy must reference a digest-pinned image",
}


def rules(*rows) -> list[soprules.SopRule]:
    return soprules.parse_rules({"rules": list(rows)})


class TestParsing:
    def test_reads_the_documented_envelope(self):
        assert len(rules(DIGEST_RULE)) == 1

    @pytest.mark.parametrize("key", ["rules", "items", "data"])
    def test_accepts_every_envelope_the_api_uses(self, key):
        # /sop/rules says {rules}, /sops says {items}, /incidents says {data}.
        # Reading the wrong key yields a tier that enforces nothing while
        # looking healthy — the worst failure a gate can have.
        assert len(soprules.parse_rules({key: [DIGEST_RULE]})) == 1

    def test_accepts_a_bare_list(self):
        assert len(soprules.parse_rules([DIGEST_RULE])) == 1

    def test_ignores_an_unrecognised_action(self):
        # An action we do not understand must not default to allow OR block.
        assert rules({**DIGEST_RULE, "action": "quarantine"}) == []

    def test_ignores_a_rule_with_no_tool_pattern(self):
        assert rules({**DIGEST_RULE, "toolPattern": ""}) == []

    def test_absent_arg_pattern_stays_none_rather_than_empty_string(self):
        # "" is a regex that matches everything. Coercing a missing field to it
        # would turn a tool-name rule into a match-anything rule.
        r = rules({k: v for k, v in DIGEST_RULE.items() if k != "argPattern"})[0]
        assert r.arg_pattern is None

    def test_survives_a_non_dict_row(self):
        assert len(soprules.parse_rules({"rules": ["nope", None, DIGEST_RULE]})) == 1

    def test_survives_a_garbage_payload(self):
        assert soprules.parse_rules("not json at all") == []


class TestSerialisation:
    """The serialisation is parity-critical: matchSopRule documents that
    toolInputJson must be `JSON.stringify(tool_input ?? {})`, or the two
    enforcement paths diverge on the exact input they disagree about."""

    def test_matches_json_stringify_shape(self):
        # Compact separators, insertion order, non-ASCII intact — what
        # JSON.stringify produces, byte for byte, for this input.
        assert soprules.serialise_tool_input(
            {"command": "ls", "ctx": "prod-cluster", "n": 1, "s": "café"}
        ) == '{"command":"ls","ctx":"prod-cluster","n":1,"s":"café"}'

    def test_none_becomes_empty_object(self):
        assert soprules.serialise_tool_input(None) == "{}"

    def test_boundary_spanning_pattern_matches_both_paths(self):
        # A pattern spanning the key/value seam only matches if the separators
        # agree with the TS mirrors. Python's default ", "/": " would break it.
        r = rules({**DIGEST_RULE, "argPattern": r'"cluster":"prod"', "id": "sp_seam"})
        assert soprules.first_match(r, "shell", {"cluster": "prod"}) is not None


class TestMatching:
    def test_the_rule_that_was_previously_unsayable(self):
        r = rules(DIGEST_RULE)
        assert soprules.first_match(r, "shell", APPLY) is not None

    def test_a_digest_pinned_apply_is_allowed(self):
        r = rules(DIGEST_RULE)
        pinned = {"command": "kubectl apply -f k8s/x.yaml  # img@sha256:abc"}
        assert soprules.first_match(r, "shell", pinned) is None

    def test_unrelated_shell_calls_are_untouched(self):
        # The entire reason argPattern matters: `BLOCK:^shell$` alone would
        # have blocked these, and a rule that blocks these gets switched off.
        r = rules(DIGEST_RULE)
        for cmd in ("make test", "git status", "ls -la"):
            assert soprules.first_match(r, "shell", {"command": cmd}) is None

    def test_tool_pattern_still_gates_the_match(self):
        r = rules(DIGEST_RULE)
        assert soprules.first_match(r, "read_file", APPLY) is None

    def test_first_rule_wins_in_control_plane_order(self):
        warn = {**DIGEST_RULE, "id": "sp_first", "action": "warn"}
        assert soprules.first_match(rules(warn, DIGEST_RULE), "shell", APPLY).id == "sp_first"

    def test_an_uncompilable_rule_is_skipped_not_raised(self):
        # Exactly what an older control plane produces: `[^:]+` truncates the
        # pattern at the colon in `@sha256:`, leaving an unterminated group.
        broken = {**DIGEST_RULE, "id": "sp_old",
                  "toolPattern": r"^shell$ WHERE kubectl\s+apply(?!.*@sha256",
                  "argPattern": None}
        assert soprules.first_match(rules(broken), "shell", APPLY) is None

    def test_a_broken_rule_does_not_mask_a_later_good_one(self):
        broken = {**DIGEST_RULE, "id": "sp_old", "toolPattern": "([unclosed"}
        assert soprules.first_match(rules(broken, DIGEST_RULE), "shell", APPLY).id == "sp_pin"

    def test_arg_pattern_sees_every_field_not_just_command(self):
        r = rules({**DIGEST_RULE, "argPattern": "prod-cluster", "id": "sp_ctx"})
        assert soprules.first_match(r, "shell", {"command": "ls", "ctx": "prod-cluster"})


class TestCapabilityProbe:
    def test_reports_support_when_a_usable_arg_pattern_arrives(self):
        assert soprules.supports_arg_patterns(rules(DIGEST_RULE)) is True

    def test_reports_no_support_for_a_tool_name_only_rule(self):
        assert soprules.supports_arg_patterns(
            rules({k: v for k, v in DIGEST_RULE.items() if k != "argPattern"})) is False

    def test_an_uncompilable_arg_pattern_does_not_count_as_support(self):
        assert soprules.supports_arg_patterns(
            rules({**DIGEST_RULE, "argPattern": "([unclosed"})) is False


class TestGateIntegration:
    """The tier as a wrapped agent actually meets it."""

    def _gate(self, monkeypatch, rows, tmp_path):
        # A real allowlist, so a call that falls THROUGH the SOP tier reaches a
        # working image tier rather than its "policy file missing" block.
        # Without this, every test here passes for the wrong reason.
        pol = tmp_path / ".intutic"
        pol.mkdir(exist_ok=True)
        (pol / "image-allowlist.json").write_text(json.dumps({
            "version": 1,
            "require_digest": True,
            "registries_allowed": [_REGISTRY],
            "images": {_IMAGE: {"approved_digests": [_DIGEST],
                                "approved_by": "platform-eng"}},
        }))
        k8s = tmp_path / "k8s"
        k8s.mkdir(exist_ok=True)
        (k8s / "catalogue-dep.yaml").write_text(_manifest(f"{_IMAGE}:latest"))
        (k8s / "pinned.yaml").write_text(_manifest(f"{_IMAGE}@{_DIGEST}"))
        cfg = gate_mod.GateConfig(repo_root=str(tmp_path), workspace_id="ws_1",
                                  use_hook_gate=False)
        g = gate_mod.Gate(cfg, client=None)
        g._sop_rules = soprules.parse_rules({"rules": list(rows)})
        g._snapshot = None
        monkeypatch.setattr(gate_mod.snapshot, "load_snapshot",
                            lambda _ws: _EMPTY_SNAPSHOT)
        return g

    def test_a_matching_block_rule_stops_the_call(self, monkeypatch, tmp_path):
        g = self._gate(monkeypatch, [DIGEST_RULE], tmp_path)
        with pytest.raises(gate_mod.IntuticGateRefusal) as e:
            g.guard("shell", APPLY)
        assert e.value.code == "SOP_RULE"
        # The authored reason must reach the operator; a generic string here
        # would leave them reading SOP source to find out what matched.
        assert "digest-pinned" in e.value.reason
        assert "sp_pin" in e.value.reason

    def test_require_approval_blocks_in_an_unattended_run(self, monkeypatch, tmp_path):
        g = self._gate(monkeypatch, [{**DIGEST_RULE, "action": "require_approval"}], tmp_path)
        with pytest.raises(gate_mod.IntuticGateRefusal) as e:
            g.guard("shell", APPLY)
        assert e.value.code == "SOP_RULE_APPROVAL"

    def test_warn_does_not_stop_the_call(self, monkeypatch, tmp_path):
        g = self._gate(monkeypatch, [{**DIGEST_RULE, "action": "warn"}], tmp_path)
        g.guard("shell", APPLY_PINNED)   # must not raise

    def test_sop_tier_is_attributed_before_image_tier(self, monkeypatch, tmp_path):
        # Both tiers would refuse this command. The block must carry the SOP's
        # reason, not imagecheck's error code, or the wrong component gets
        # credited for the decision.
        g = self._gate(monkeypatch, [DIGEST_RULE], tmp_path)
        with pytest.raises(gate_mod.IntuticGateRefusal) as e:
            g.guard("shell", APPLY)
        assert e.value.code == "SOP_RULE"

    def test_an_empty_register_leaves_the_image_tier_to_do_its_job(self, monkeypatch, tmp_path):
        # No SOP rules must not mean "allowed" — the image tier still refuses.
        g = self._gate(monkeypatch, [], tmp_path)
        with pytest.raises(gate_mod.IntuticGateRefusal) as e:
            g.guard("shell", APPLY)
        assert e.value.code != "SOP_RULE"

    def test_the_tier_can_be_turned_off(self, monkeypatch, tmp_path):
        g = self._gate(monkeypatch, [DIGEST_RULE], tmp_path)
        g.cfg.use_sop_rules = False
        with pytest.raises(gate_mod.IntuticGateRefusal) as e:
            g.guard("shell", APPLY)
        assert e.value.code != "SOP_RULE"


# A real, healthy, rule-less snapshot: the snapshot tier must be a no-op in
# these tests so that whatever raises is unambiguously SOP or image integrity.
_EMPTY_SNAPSHOT = snapshot_mod.Snapshot(rules=[], state="ok", workspace_id="ws_1")
