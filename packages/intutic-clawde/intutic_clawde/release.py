"""Release flags: which Intutic distributions this build may point users at.

Only the open core is released. The hosted cloud and the self-hosted
distribution are not, so while their flag is False the SDK has no default
control plane (pass ``base_url`` / ``control_plane_url`` or set
``INTUTIC_CONTROL_PLANE_URL``) and the README hides the passages that
advertise them (``<!-- UNRELEASED:cloud`` / ``<!-- UNRELEASED:self-host``
comment blocks).

Launching one is a flag flip in all three places, then a release of each:

- here (``intutic-clawde`` on PyPI),
- ``packages/shared-types/src/release.ts`` (``CLOUD_RELEASED``,
  ``SELF_HOST_RELEASED``) for the TypeScript packages,
- ``packages/terraform-provider-intutic/internal/provider/release.go``
  (``cloudReleased``, ``selfHostReleased``) for the Terraform provider.

When flipping ``CLOUD_RELEASED``, also unwrap the README's
``UNRELEASED:cloud`` blocks and update the docstrings that say there is no
default control plane.
"""

#: The hosted cloud (``https://api.intutic.ai``) is released.
CLOUD_RELEASED = False

#: The self-hosted (on-prem) distribution is released.
SELF_HOST_RELEASED = False

#: Intutic's hosted control plane: the API host, not the dashboard's.
HOSTED_CONTROL_PLANE_URL = "https://api.intutic.ai"
