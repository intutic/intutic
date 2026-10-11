"""Offline verification of a compliance evidence archive: the check
``intutic compliance verify`` makes, with nothing but the archive and the
control plane's published key set, so the answer does not depend on trusting
the server that produced the archive.

The rules are the sealer's (``soc2EvidenceService.ts`` in the control plane):
a sha256 manifest over canonical JSON, and an Ed25519 signature over
``intutic-soc2-evidence-v1\\n<archiveSha256>``, present only when the
deployment had a signing key. The CLI and the TypeScript SDK apply the same
rules; the tests hold all of them to the archive the control plane's own code
sealed (``tools/cli/src/commands/__fixtures__/evidence-archive.json``).

Checking a signature needs the ``cryptography`` package
(``pip install 'intutic-clawde[compliance]'``); the hashes need nothing.
"""

import base64
import hashlib
import json
import math
import re
from decimal import Decimal
from typing import Any, Dict, Optional, Union, cast

from .types import EvidenceVerification, SigningJwks

#: The domain the control plane signs evidence archives under.
EVIDENCE_SIGNING_DOMAIN = "intutic-soc2-evidence-v1"

_SECTION = re.compile(r"^framework:([^:]+)(?::(csv|pdf))?$")


def _js_number(value: Union[int, float]) -> str:
    """A number as JavaScript's JSON.stringify writes it.

    The archive was hashed by JavaScript, so a number must serialise to the
    same text: ``1e-7`` and not Python's ``1e-07``, ``100000000000000000000``
    and not ``1e+20``.
    """
    if isinstance(value, int) and abs(value) < 2**53:
        return str(value)
    x = float(value)
    if not math.isfinite(x):
        return "null"
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    digits_tuple = Decimal(repr(abs(x))).normalize().as_tuple()
    digits = "".join(str(d) for d in digits_tuple.digits)
    k = len(digits)
    n = cast(int, digits_tuple.exponent) + k
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    exponent = n - 1
    mantissa = digits[0] + ("." + digits[1:] if k > 1 else "")
    return f"{sign}{mantissa}e{'+' if exponent > 0 else '-'}{abs(exponent)}"


def canonical_json(value: Any) -> str:
    """Object keys sorted recursively (by UTF-16 code unit, as JavaScript
    sorts them), arrays in order: the preimage the control plane hashes."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{canonical_json(value[k])}" for k in keys) + "}"
    raise TypeError(f"not a JSON value: {type(value).__name__}")


def _sha256_hex(data: Union[str, bytes]) -> str:
    return hashlib.sha256(data.encode("utf-8") if isinstance(data, str) else data).hexdigest()


def _section_content(archive: Dict[str, Any], name: str) -> Optional[Union[str, bytes]]:
    """What one manifest entry hashes, or None when the archive has nothing under that name."""
    for category in archive.get("categories") or []:
        if category.get("category") == name:
            return canonical_json(category)
    m = _SECTION.match(name)
    if not m:
        return None
    framework = next(
        (f for f in archive.get("frameworks") or [] if (f.get("coverage") or {}).get("frameworkId") == m.group(1)),
        None,
    )
    if framework is None:
        return None
    # The CSV as its UTF-8 bytes and the PDF decoded, so a file saved out of
    # the archive checks with `sha256sum` alone.
    if m.group(2) == "csv":
        return framework.get("csv")
    if m.group(2) == "pdf":
        pdf = framework.get("pdf")
        return None if pdf is None else base64.b64decode(pdf)
    return canonical_json(framework)


def _b64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _signature_state(sig: Dict[str, Any], archive_sha256: str, jwks: Optional[SigningJwks]) -> str:
    # A signature made under another domain (another kind of export) or
    # algorithm is not this archive's signature, whatever its bytes.
    if sig.get("preimageDomain") != EVIDENCE_SIGNING_DOMAIN or sig.get("algorithm") != "Ed25519":
        return "invalid"
    if jwks is None:
        return "keys_unavailable"
    jwk = next((k for k in jwks.get("keys", []) if k.get("kid") == sig.get("keyId")), None)
    if jwk is None:
        return "unverifiable"
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError as e:
        raise ImportError(
            "Checking an evidence archive's signature needs the cryptography package: "
            "pip install 'intutic-clawde[compliance]'"
        ) from e
    if jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519" or not isinstance(jwk.get("x"), str):
        # A published key this runtime cannot load is one we do not effectively hold.
        return "unverifiable"
    try:
        key = Ed25519PublicKey.from_public_bytes(_b64url(jwk["x"]))
        key.verify(base64.b64decode(sig.get("value", "")), f"{EVIDENCE_SIGNING_DOMAIN}\n{archive_sha256}".encode("utf-8"))
        return "valid"
    except InvalidSignature:
        return "invalid"
    except ValueError:
        return "unverifiable"


def verify_evidence_archive(archive: Dict[str, Any], jwks: Optional[SigningJwks]) -> EvidenceVerification:
    """Checks an evidence archive the way it was sealed: the manifest's
    hashes, then the signature over the archive hash against the published
    key its ``keyId`` names (``jwks``, from ``ControlPlaneClient.get_signing_keys()``
    or a saved copy; None when it could not be had).

    ``verified`` is True only for an archive whose hashes match and whose
    signature a published key accepts. An unsigned archive, or one whose key is
    not published, is not verified even when its hashes match: nothing then
    shows who produced it.
    """
    rest = {k: v for k, v in archive.items() if k not in ("manifest", "signature")}
    archive_sha256 = _sha256_hex(canonical_json(rest))
    manifest = archive.get("manifest") or {}
    archive_hash_matches = archive_sha256 == manifest.get("archiveSha256")

    sections = list((manifest.get("sections") or {}).items())
    section_mismatches = []
    for name, recorded in sections:
        content = _section_content(archive, name)
        if content is None or _sha256_hex(content) != recorded:
            section_mismatches.append(name)

    sig = archive.get("signature")
    signature = "unsigned" if sig is None else _signature_state(sig, manifest.get("archiveSha256") or "", jwks)
    return {
        "archiveSha256": archive_sha256,
        "archiveHashMatches": archive_hash_matches,
        "sectionMismatches": section_mismatches,
        "sectionsChecked": len(sections),
        "signature": cast(Any, signature),
        "signingKeyId": None if sig is None else sig.get("keyId"),
        "unsignedReason": manifest.get("unsignedReason") if sig is None else None,
        "verified": archive_hash_matches and not section_mismatches and signature == "valid",
    }
