"""Container image integrity checking.

Given a deploy command, find the manifests it would apply, extract every
container image reference, and check each against an allowlist of approved
sha256 digests. Nothing else in Intutic does this — no cosign, no sigstore,
no admission webhook — so this check is the argument-level enforcement point
for "deploy only pinned, reviewed images".

Fail-closed on anything it cannot read. That is a deliberate departure from
Intutic's fail-open default (WASM rules, hook-gate, the MCP proxy all fail
open). The reasoning: a gate that cannot parse what it is being asked to
approve does not know what it is approving, and "I could not read it" is not
evidence of safety. The same argument the proxy's own SHELL_EXTRACT makes for
itself.
"""

from __future__ import annotations

import os
import shlex
from dataclasses import dataclass, field

import yaml

from .actions import DEPLOY_PATTERNS, is_deploy

# Failure codes. Each becomes the operator-visible reason, so they are specific
# rather than a single "policy violation".
E_UNPINNED_LATEST = "E_UNPINNED_LATEST"
E_UNPINNED_TAG = "E_UNPINNED_TAG"
E_UNKNOWN_REGISTRY = "E_UNKNOWN_REGISTRY"
E_UNKNOWN_IMAGE = "E_UNKNOWN_IMAGE"
E_DIGEST_MISMATCH = "E_DIGEST_MISMATCH"
E_MANIFEST_UNPARSEABLE = "E_MANIFEST_UNPARSEABLE"


@dataclass
class ImageRef:
    """A parsed container image reference."""

    raw: str
    repository: str          # registry/namespace/name, no tag, no digest
    tag: str | None
    digest: str | None       # "sha256:..." or None
    source: str = ""         # which manifest file it came from

    @property
    def is_pinned(self) -> bool:
        return self.digest is not None


@dataclass
class Verdict:
    ok: bool
    code: str = ""
    detail: str = ""
    images: list[ImageRef] = field(default_factory=list)

    @property
    def reason(self) -> str:
        """The single line an operator sees on the dashboard."""
        if self.ok:
            return ""
        return f"[image-integrity] {self.code}: {self.detail}"


def parse_image_ref(raw: str, source: str = "") -> ImageRef:
    """Parse `registry/repo:tag@sha256:...` into its parts.

    Docker's own rule for splitting registry from repository: the first path
    component is a registry host only if it contains a dot or a colon, or is
    exactly `localhost`. Otherwise it is a Docker Hub namespace. Getting this
    wrong would misclassify `weaveworksdemos/catalogue` as a registry named
    `weaveworksdemos`.
    """
    ref = raw.strip()
    digest = None
    tag = None

    if "@" in ref:
        ref, digest = ref.split("@", 1)

    # A colon is only a tag separator if it is in the last path component;
    # otherwise it is a registry port (`localhost:5000/foo`).
    slash = ref.rfind("/")
    colon = ref.rfind(":")
    if colon > slash:
        ref, tag = ref[:colon], ref[colon + 1:]

    return ImageRef(raw=raw.strip(), repository=ref, tag=tag, digest=digest, source=source)


def _extract_images_from_doc(doc, source: str) -> list[ImageRef]:
    """Walk a parsed YAML document for container image references.

    Recursive rather than keyed on a fixed path, so it finds images in
    Deployments, StatefulSets, DaemonSets, Jobs, CronJobs (which nest a further
    two levels) and bare Pods without a per-kind table to keep current.
    """
    found: list[ImageRef] = []

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key in ("containers", "initContainers", "ephemeralContainers") and isinstance(value, list):
                    for c in value:
                        if isinstance(c, dict) and isinstance(c.get("image"), str):
                            found.append(parse_image_ref(c["image"], source))
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(doc)
    return found


def manifest_paths_from_command(command: str) -> tuple[list[str], bool]:
    """Extract the -f/-k targets from a kubectl/helm command.

    Returns (paths, readable). `readable` is False when the command applies
    something we cannot inspect — stdin (`-f -`), a URL, or a command we could
    not tokenise. That drives the fail-closed path.
    """
    try:
        tokens = shlex.split(command)
    except ValueError:
        return [], False

    paths: list[str] = []
    readable = True
    flags_with_path = {"-f", "--filename", "-k", "--kustomize"}

    i = 0
    while i < len(tokens):
        tok = tokens[i]
        value = None
        if tok in flags_with_path and i + 1 < len(tokens):
            value = tokens[i + 1]
            i += 1
        elif tok.startswith("--filename=") or tok.startswith("--kustomize="):
            value = tok.split("=", 1)[1]
        elif tok.startswith("-f") and len(tok) > 2 and not tok.startswith("--"):
            value = tok[2:]

        if value is not None:
            # Stdin and remote URLs are outside what we can verify.
            if value == "-" or value.startswith(("http://", "https://")):
                readable = False
            else:
                paths.append(value)
        i += 1

    return paths, readable


def _load_yaml_docs(path: str) -> list:
    """Load every YAML document under a file or directory."""
    docs: list = []
    if os.path.isdir(path):
        for root, _dirs, files in os.walk(path):
            for fn in sorted(files):
                if fn.endswith((".yaml", ".yml")):
                    docs.extend(_load_yaml_docs(os.path.join(root, fn)))
        return docs
    with open(path, "r", encoding="utf-8") as fh:
        docs.extend(d for d in yaml.safe_load_all(fh) if d is not None)
    return docs


def inline_images_from_command(command: str) -> list[ImageRef]:
    """Catch images named directly on the command line.

    `kubectl set image deploy/catalogue catalogue=repo:latest` never touches a
    manifest, so the YAML path would miss it entirely.
    """
    out: list[ImageRef] = []
    try:
        tokens = shlex.split(command)
    except ValueError:
        return out
    for tok in tokens:
        candidate = tok.split("=", 1)[1] if "=" in tok and "/" in tok.split("=", 1)[1] else tok
        # A bare word is only an image reference if it looks like one.
        if "/" in candidate and (":" in candidate or "@" in candidate):
            if candidate.startswith(("http://", "https://", "-")):
                continue
            out.append(parse_image_ref(candidate, source="<command line>"))
    return out


def check_images(images: list[ImageRef], policy: dict) -> Verdict:
    """Evaluate parsed references against the allowlist. First failure wins."""
    require_digest = policy.get("require_digest", True)
    allowed_registries = policy.get("registries_allowed", [])
    known = policy.get("images", {})

    for img in images:
        where = f" (in {img.source})" if img.source else ""

        # 1. Unpinned by tag — `:latest` or no tag at all.
        if img.digest is None and (img.tag is None or img.tag == "latest"):
            shown = img.raw if img.tag else f"{img.raw} (no tag -> :latest)"
            return Verdict(False, E_UNPINNED_LATEST,
                           f"{shown} resolves to a mutable tag and is not pinned to an "
                           f"approved sha256 digest{where}", images)

        # 2. A real tag, but still no digest.
        if img.digest is None and require_digest:
            return Verdict(False, E_UNPINNED_TAG,
                           f"{img.raw} is pinned only by tag; policy requires an "
                           f"@sha256 digest{where}", images)

        # 3. Registry not on the allowlist.
        if allowed_registries and not any(img.repository.startswith(r) for r in allowed_registries):
            return Verdict(False, E_UNKNOWN_REGISTRY,
                           f"{img.repository} is not in an approved registry "
                           f"({', '.join(allowed_registries)}){where}", images)

        # 4. Approved registry, but this image was never reviewed.
        entry = known.get(img.repository)
        if entry is None:
            return Verdict(False, E_UNKNOWN_IMAGE,
                           f"{img.repository} has no entry in the image allowlist{where}", images)

        # 5. Pinned to a digest nobody approved.
        approved = entry.get("approved_digests", [])
        if img.digest not in approved:
            return Verdict(False, E_DIGEST_MISMATCH,
                           f"{img.repository} is pinned to {img.digest}, which is not an "
                           f"approved digest for this image{where}", images)

    return Verdict(True, images=images)


def check_command(command: str, repo_root: str, policy: dict) -> Verdict:
    """Full check for a deploy command. The entry point the gate calls."""
    paths, readable = manifest_paths_from_command(command)

    images = inline_images_from_command(command)

    if not readable:
        return Verdict(False, E_MANIFEST_UNPARSEABLE,
                       "the deploy reads from stdin or a remote URL, so its images "
                       "cannot be verified before it runs")

    for p in paths:
        full = p if os.path.isabs(p) else os.path.join(repo_root, p)
        try:
            docs = _load_yaml_docs(full)
        except FileNotFoundError:
            return Verdict(False, E_MANIFEST_UNPARSEABLE,
                           f"{p} does not exist, so its images cannot be verified")
        except (yaml.YAMLError, OSError, UnicodeDecodeError) as exc:
            return Verdict(False, E_MANIFEST_UNPARSEABLE,
                           f"{p} could not be parsed as YAML ({type(exc).__name__}), "
                           f"so its images cannot be verified")
        for doc in docs:
            images.extend(_extract_images_from_doc(doc, source=p))

    # A deploy naming no image at all is not a provenance decision to make here
    # (`kubectl rollout restart`, `kubectl apply` of a ConfigMap). Let it pass;
    # the ordering floor and the snapshot rules still apply.
    if not images:
        return Verdict(True, images=[])

    return check_command_images(images, policy)


def check_command_images(images: list[ImageRef], policy: dict) -> Verdict:
    return check_images(images, policy)


def check_written_manifest(path: str, content: str, policy: dict) -> Verdict:
    """Check a manifest at authoring time, before it is ever applied.

    Lets the dashboard show the bad image being *written* a full turn before it
    is *applied* — the write is flagged, the apply is blocked.
    """
    try:
        docs = [d for d in yaml.safe_load_all(content) if d is not None]
    except yaml.YAMLError as exc:
        return Verdict(False, E_MANIFEST_UNPARSEABLE,
                       f"{path} is not valid YAML ({type(exc).__name__})")
    images: list[ImageRef] = []
    for doc in docs:
        images.extend(_extract_images_from_doc(doc, source=path))
    if not images:
        return Verdict(True, images=[])
    return check_images(images, policy)


def is_deploy_command(tool_name: str, tool_input: dict) -> bool:
    """True when this call should be image-checked."""
    return is_deploy(tool_name, tool_input)


__all__ = [
    "ImageRef", "Verdict", "parse_image_ref", "check_command", "check_images",
    "check_written_manifest", "is_deploy_command", "manifest_paths_from_command",
    "inline_images_from_command", "DEPLOY_PATTERNS",
    "E_UNPINNED_LATEST", "E_UNPINNED_TAG", "E_UNKNOWN_REGISTRY",
    "E_UNKNOWN_IMAGE", "E_DIGEST_MISMATCH", "E_MANIFEST_UNPARSEABLE",
]
