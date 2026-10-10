"""verify_integrity_root against the roots the control plane's own signer
sealed (tools/cli/src/commands/__fixtures__/integrity-roots.json, with the key
set it published), running the fixture's cases, which the CLI's
integrity.test.ts and the TypeScript SDK's integrity.test.ts run too, so all
three reach the same verdict.

A verdict that checks a signature needs the ``compliance`` extra
(cryptography) and is skipped without it; the ones decided before any
signature check (unsigned, keys_unavailable, an unpublished key, an unknown
algorithm or version) always run."""

import builtins
import copy
import importlib.util
import json
from pathlib import Path

import pytest

from intutic_clawde import verify_integrity_root
from intutic_clawde.integrity import integrity_root_preimage

FIXTURES = Path(__file__).resolve().parents[3] / "tools" / "cli" / "src" / "commands" / "__fixtures__"
FIXTURE = json.loads((FIXTURES / "integrity-roots.json").read_text(encoding="utf-8"))
PUBLISHED = json.loads((FIXTURES / "integrity-jwks.json").read_text(encoding="utf-8"))
HAS_CRYPTOGRAPHY = importlib.util.find_spec("cryptography") is not None

KEY_SETS = {
    "published": PUBLISHED,
    "activeOnly": {"keys": [k for k in PUBLISHED["keys"] if k["kid"] == FIXTURE["activeKeyId"]]},
    "empty": {"keys": []},
    "brokenActive": {
        "keys": [{**k, "x": "AAAA"} if k["kid"] == FIXTURE["activeKeyId"] else k for k in PUBLISHED["keys"]]
    },
    "none": None,
}


def _root(case):
    root = {**copy.deepcopy(FIXTURE["roots"][case["root"]]), **case["set"]}
    for field in case["delete"]:
        root.pop(field, None)
    return root


def _needs_signature_check(case):
    root = _root(case)
    jwks = KEY_SETS[case["jwks"]]
    if not root.get("signature") or not root.get("signing_key_id") or jwks is None:
        return False
    if not any(k.get("kid") == root["signing_key_id"] for k in jwks["keys"]):
        return False
    return root.get("signature_alg") == "EdDSA" and root.get("signing_preimage_version", 1) in (1, 2, None)


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=[f"{c['expect']}: {c['name']}" for c in FIXTURE["cases"]])
def test_case(case):
    if _needs_signature_check(case) and not HAS_CRYPTOGRAPHY:
        pytest.skip("needs the compliance extra (cryptography)")
    assert verify_integrity_root(_root(case), KEY_SETS[case["jwks"]]) == case["expect"]


def test_rebuilds_the_preimage_the_signer_wrote_field_by_field():
    root = FIXTURE["roots"]["v2Chained"]
    assert integrity_root_preimage(root) == "\x1f".join(
        ["intutic.merkle-root.v2", root["workspace_id"], "lr_7", "2", root["merkle_root"], "1", root["previous_root"]]
    )
    assert len(integrity_root_preimage(FIXTURE["roots"]["v1RetiredKey"]).split("\x1f")) == 5
    with pytest.raises(ValueError, match="unknown signing preimage version 3"):
        integrity_root_preimage({**root, "signing_preimage_version": 3})


def test_says_which_extra_a_signature_check_needs_when_cryptography_is_missing(monkeypatch):
    real_import = builtins.__import__

    def without_cryptography(name, *args, **kwargs):
        if name.startswith("cryptography"):
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_cryptography)
    with pytest.raises(ImportError, match=r"intutic-clawde\[compliance\]"):
        verify_integrity_root(FIXTURE["roots"]["v2Chained"], PUBLISHED)
    # A verdict reached before any signature check needs nothing.
    assert verify_integrity_root(FIXTURE["roots"]["unsigned"], PUBLISHED) == "unsigned"
