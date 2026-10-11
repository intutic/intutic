"""Offline verification of a sealed trace root's signature: the check
``intutic integrity verify`` makes, with nothing but the root and the control
plane's published key set, so the answer does not depend on trusting the
server that sealed it.

The rules are the signer's (``rootSigner.ts`` in the control plane), the CLI's
and the TypeScript SDK's: an Ed25519 signature over a domain-separated
preimage of the root's scope, rebuilt here rather than handed over, under the
preimage version the root records. The tests hold all of them to roots the
control plane's own signer sealed
(``tools/cli/src/commands/__fixtures__/integrity-roots.json``).

Checking a signature needs the ``cryptography`` package
(``pip install 'intutic-clawde[compliance]'``).
"""

import base64
import binascii
from typing import Any, Dict, Mapping, Optional

from .types import IntegrityRootSignatureState, SigningJwks

#: Domain tag per preimage version, as the signer writes them. Also the list of
#: versions this build can rebuild: a root naming any other is unverifiable.
_SIGN_DOMAIN: Dict[int, str] = {
    1: "intutic.merkle-root.v1",
    2: "intutic.merkle-root.v2",
}


def _preimage_version(root: Mapping[str, Any]) -> Any:
    """The version a root was sealed under; absent means 1 (a control plane
    older than the column)."""
    version = root.get("signing_preimage_version")
    return 1 if version is None else version


def _known_version(version: Any) -> Optional[int]:
    if isinstance(version, bool):
        return None
    if isinstance(version, float) and version.is_integer():
        version = int(version)
    return version if isinstance(version, int) and version in _SIGN_DOMAIN else None


def _js_string(value: Any) -> str:
    """A number as JavaScript's String() writes it: the signer stringified
    ``leaf_schema_version`` in JavaScript."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def integrity_root_preimage(root: Mapping[str, Any]) -> str:
    """The exact bytes the control plane signed for this root, under the
    version the root records. Fields joined by U+001F: domain, workspace, loop
    run (empty for none), leaf schema version, merkle root; from v2 on, a
    presence tag and the predecessor, so "no predecessor" is not the same bytes
    as any value."""
    version = _known_version(_preimage_version(root))
    if version is None:
        # Guessing an encoding would produce bytes that were never signed, and
        # the key would then say "forged".
        raise ValueError(f"unknown signing preimage version {_preimage_version(root)}")
    loop_run_id = root.get("loop_run_id")
    fields = [
        _SIGN_DOMAIN[version],
        root["workspace_id"],
        "" if loop_run_id is None else loop_run_id,
        _js_string(root["leaf_schema_version"]),
        root["merkle_root"],
    ]
    if version >= 2:
        # A previous_root the server omitted is the same claim as an explicit None.
        previous = root.get("previous_root")
        fields += ["0", ""] if previous is None else ["1", previous]
    return "\x1f".join(fields)


def _b64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def verify_integrity_root(root: Mapping[str, Any], jwks: Optional[SigningJwks]) -> IntegrityRootSignatureState:
    """Checks a sealed root's signature against the published key the root
    itself names (``jwks``, from ``ControlPlaneClient.get_signing_keys()`` or a
    saved copy; None when it could not be had). Pass the ``root`` of
    ``ControlPlaneClient.get_integrity_root()``.

    Only ``"invalid"`` says the root was changed: a published key rejected it.
    ``"unverifiable"`` (the key is not published, or the root names an
    algorithm or preimage version this build cannot check) and
    ``"keys_unavailable"`` are no verdict, and ``"unsigned"`` is a deployment
    that had no signing key. The key is chosen by ``signing_key_id`` and never
    by trying others: a root that verifies under some other key is not the same
    claim.
    """
    if not root.get("signature") or not root.get("signing_key_id"):
        return "unsigned"
    if jwks is None:
        return "keys_unavailable"
    jwk = next((k for k in jwks.get("keys", []) if k.get("kid") == root["signing_key_id"]), None)
    if jwk is None:
        return "unverifiable"
    if root.get("signature_alg") != "EdDSA":
        return "unverifiable"
    if _known_version(_preimage_version(root)) is None:
        return "unverifiable"
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError as e:
        raise ImportError(
            "Checking a trace root's signature needs the cryptography package: "
            "pip install 'intutic-clawde[compliance]'"
        ) from e
    if jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519" or not isinstance(jwk.get("x"), str):
        # A published key this runtime cannot load is one we do not effectively hold.
        return "unverifiable"
    try:
        key = Ed25519PublicKey.from_public_bytes(_b64url(jwk["x"]))
    except (ValueError, binascii.Error):
        return "unverifiable"
    try:
        key.verify(base64.b64decode(root["signature"]), integrity_root_preimage(root).encode("utf-8"))
        return "valid"
    except (InvalidSignature, ValueError, binascii.Error):
        # Node reads a malformed base64 signature leniently and the key then
        # rejects it: a signature the key does not accept is invalid either way.
        return "invalid"
