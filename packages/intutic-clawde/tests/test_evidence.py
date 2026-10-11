"""verify_evidence_archive against the archive the control plane's own code
sealed and signed (tools/cli/src/commands/__fixtures__/evidence-archive.json,
with the key set it published), the same cases the CLI's
complianceVerify.test.ts and the TypeScript SDK's evidence.test.ts run, so all
three answer alike.

The signature checks need the ``compliance`` extra (cryptography) and are
skipped without it; the hash checks need nothing and always run."""

import base64
import builtins
import importlib.util
import json
from pathlib import Path

import pytest

from intutic_clawde import verify_evidence_archive
from intutic_clawde.evidence import EVIDENCE_SIGNING_DOMAIN, canonical_json

FIXTURES = Path(__file__).resolve().parents[3] / "tools" / "cli" / "src" / "commands" / "__fixtures__"
JWKS = json.loads((FIXTURES / "evidence-jwks.json").read_text(encoding="utf-8"))


needs_cryptography = pytest.mark.skipif(
    importlib.util.find_spec("cryptography") is None, reason="needs the compliance extra (cryptography)"
)


def archive():
    return json.loads((FIXTURES / "evidence-archive.json").read_text(encoding="utf-8"))


def test_canonical_json_sorts_keys_recursively_and_keeps_array_order():
    assert canonical_json({"b": 1, "a": [{"d": 2, "c": 3}, None]}) == '{"a":[{"c":3,"d":2},null],"b":1}'


@pytest.mark.parametrize(
    "value, text",
    [
        (1e-7, "1e-7"),
        (0.000001, "0.000001"),
        (1e21, "1e+21"),
        (1e20, "100000000000000000000"),
        (1.5e16, "15000000000000000"),
        (123.456, "123.456"),
        (-2.5e-9, "-2.5e-9"),
        (100.0, "100"),
        (-0.0, "0"),
        (2**60, "1152921504606847000"),
        ("é\n\"", '"é\\n\\""'),
    ],
)
def test_canonical_json_writes_values_as_javascript_does(value, text):
    # The archive was hashed by JavaScript's JSON.stringify; Python's own
    # spelling of these (1e-07, 1e+20, 100.0) would change the hash.
    assert canonical_json(value) == text


def test_canonical_json_orders_keys_by_utf16_code_unit_as_javascript_sorts():
    # By code point U+FF5E comes first; in UTF-16, U+1F600's first unit (0xD83D) is below 0xFF5E.
    assert canonical_json({"～": 1, "\U0001f600": 2}) == '{"\U0001f600":2,"～":1}'


@needs_cryptography
def test_verifies_an_archive_the_control_plane_sealed_and_signed():
    v = verify_evidence_archive(archive(), JWKS)
    assert v["archiveHashMatches"] is True
    assert v["sectionMismatches"] == []
    assert v["sectionsChecked"] == 5
    assert v["signature"] == "valid"
    assert v["signingKeyId"] == JWKS["keys"][0]["kid"]
    assert v["verified"] is True


def test_fails_an_archive_whose_content_changed():
    a = archive()
    a["categories"][0]["counts"]["governance_incidents.severity.high"] = 0
    v = verify_evidence_archive(a, None)
    assert v["archiveHashMatches"] is False
    assert v["sectionMismatches"] == ["security"]
    assert v["verified"] is False


def test_checks_the_csv_and_the_pdf_as_the_files_they_are_and_as_part_of_their_framework():
    a = archive()
    a["frameworks"][0]["csv"] += "Article 10,failing\n"
    a["frameworks"][0]["pdf"] = base64.b64encode(b"%PDF-1.7\n% edited\n").decode()
    assert verify_evidence_archive(a, None)["sectionMismatches"] == [
        "framework:eu_ai_act",
        "framework:eu_ai_act:csv",
        "framework:eu_ai_act:pdf",
    ]


def test_fails_a_manifest_entry_that_names_nothing_in_the_archive():
    a = archive()
    a["manifest"]["sections"]["framework:sox"] = "0" * 64
    assert verify_evidence_archive(a, None)["sectionMismatches"] == ["framework:sox"]


def test_says_unsigned_and_does_not_verify_an_archive_collected_without_a_signing_key():
    a = archive()
    a["signature"] = None
    a["manifest"]["unsignedReason"] = "Unsigned: this deployment has no signing key."
    v = verify_evidence_archive(a, JWKS)
    assert v["archiveHashMatches"] is True
    assert v["signature"] == "unsigned"
    assert v["signingKeyId"] is None
    assert v["unsignedReason"] == "Unsigned: this deployment has no signing key."
    assert v["verified"] is False


@needs_cryptography
def test_fails_a_signature_another_key_made_under_the_published_key_id():
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    a = archive()
    other = Ed25519PrivateKey.generate()
    preimage = f"{EVIDENCE_SIGNING_DOMAIN}\n{a['manifest']['archiveSha256']}".encode()
    a["signature"]["value"] = base64.b64encode(other.sign(preimage)).decode()
    v = verify_evidence_archive(a, JWKS)
    assert v["signature"] == "invalid"
    assert v["verified"] is False


def test_fails_a_signature_made_for_another_kind_of_export():
    a = archive()
    a["signature"]["preimageDomain"] = "intutic-human-oversight-v1"
    assert verify_evidence_archive(a, JWKS)["signature"] == "invalid"


def test_does_not_verify_a_signature_it_could_not_check():
    assert verify_evidence_archive(archive(), {"keys": []})["signature"] == "unverifiable"
    assert verify_evidence_archive(archive(), None)["signature"] == "keys_unavailable"


def test_says_which_extra_a_signature_check_needs_when_cryptography_is_missing(monkeypatch):
    real_import = builtins.__import__

    def without_cryptography(name, *args, **kwargs):
        if name.startswith("cryptography"):
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_cryptography)
    with pytest.raises(ImportError, match=r"intutic-clawde\[compliance\]"):
        verify_evidence_archive(archive(), JWKS)
    # The hashes need nothing beyond the standard library.
    a = archive()
    a["signature"] = None
    assert verify_evidence_archive(a, None)["archiveHashMatches"] is True
