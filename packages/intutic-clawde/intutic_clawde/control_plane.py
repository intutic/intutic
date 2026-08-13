"""Control-plane management client (LLD #69) -- org/team/gateway/credentials
administration, as distinct from ClawdeClient's data-plane chat calls.

Deliberately a separate class, not new methods on ClawdeClient:
ClawdeClient.base_url targets the *proxy* (default http://localhost:4000);
the control plane is a different origin entirely (default
https://app.intutic.ai, or a self-hosted CONTROL_PLANE_URL). Bolting
management calls onto ClawdeClient would silently need a second base URL
on a class whose whole contract today is "one client, one proxy."

Every endpoint here is mirrored 1:1 from tools/cli/src/commands/{org,team,
gateway,credentials,whoami}.ts -- the CLI's own already-tested contracts,
not re-derived. Endpoints deliberately NOT included: session establishment
(login/logout -- an SDK caller supplies api_key directly, matching
ClawdeClient's own existing constructor contract), and local-environment/
terminal concerns (init, doctor, install-daemon, integrity, rollback,
connect, exec, start, sync-context, skill) that have no meaning for a
library embedded in someone else's process.

Works unmodified against a self-hosted control plane -- there is no
SaaS-vs-self-hosted branch anywhere in this file. An open-core user who
runs the proxy standalone with no control plane configured simply never
constructs this class (or does, points it at nothing, and gets a
ClawdeConnectionError on the first call) -- the same framing whoami.ts
already uses: "This command needs an Intutic control plane, which open
core does not include."

Auth: the same api_key type ClawdeClient accepts -- a vk_ token or a JWT
both satisfy services/control-plane/src/middleware/auth.ts, which resolves
either to an AuthContext with a role; endpoints gated
requireRole('OWNER','ADMIN') server-side reject an under-privileged token
exactly as they would for the CLI using the same token.
"""

import os
import requests
from typing import Any, Dict, List, Optional
from .errors import ClawdeConnectionError

DEFAULT_CONTROL_PLANE_URL = "https://app.intutic.ai"


class ControlPlaneClient:
    def __init__(self, api_key: str, base_url: Optional[str] = None):
        if not api_key:
            raise ValueError("API key is required to initialize ControlPlaneClient.")
        self.api_key = api_key
        self.base_url = (
            base_url
            or os.environ.get("INTUTIC_CONTROL_PLANE_URL")
            or DEFAULT_CONTROL_PLANE_URL
        )

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        auth: bool = True,
    ) -> Any:
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if auth:
            headers["Authorization"] = f"Bearer {self.api_key}"

        try:
            res = requests.request(
                method, f"{self.base_url}{path}", json=body, headers=headers, timeout=30.0
            )
        except requests.RequestException as e:
            raise ClawdeConnectionError(
                f"Could not reach control plane at {self.base_url}: {e}"
            )

        if not res.ok:
            raise ClawdeConnectionError(
                f"Control plane {method} {path} failed ({res.status_code}): {res.text}"
            )

        if not res.content:
            return None
        return res.json()

    def whoami(self) -> Dict[str, Any]:
        """GET /api/v1/auth/me"""
        return self._request("GET", "/api/v1/auth/me")

    def signup_org(self, email: str, password: str, name: str, org_name: str) -> Dict[str, Any]:
        """POST /api/v1/auth/signup/org -- unauthenticated, creates the calling user."""
        return self._request(
            "POST",
            "/api/v1/auth/signup/org",
            {"email": email, "password": password, "name": name, "orgName": org_name},
            auth=False,
        )

    def list_teams(self, org_id: str) -> List[Dict[str, Any]]:
        """GET /api/v1/orgs/:orgId/teams"""
        res = self._request("GET", f"/api/v1/orgs/{_quote(org_id)}/teams")
        return res.get("data", []) if res else []

    def create_team(self, org_id: str, name: str) -> Dict[str, Any]:
        """POST /api/v1/orgs/:orgId/teams"""
        return self._request("POST", f"/api/v1/orgs/{_quote(org_id)}/teams", {"name": name})

    def list_team_workspaces(self, team_id: str) -> List[Dict[str, Any]]:
        """GET /api/v1/teams/:teamId/workspaces"""
        res = self._request("GET", f"/api/v1/teams/{_quote(team_id)}/workspaces")
        return res.get("data", []) if res else []

    def create_workspace(self, team_id: str, name: str) -> Dict[str, Any]:
        """POST /api/v1/teams/:teamId/workspaces"""
        return self._request("POST", f"/api/v1/teams/{_quote(team_id)}/workspaces", {"name": name})

    def register_gateway(self, name: str, deployment_target: str) -> Dict[str, Any]:
        """POST /api/v1/gateways"""
        return self._request(
            "POST", "/api/v1/gateways", {"name": name, "deploymentTarget": deployment_target}
        )

    def list_gateways(self) -> List[Dict[str, Any]]:
        """GET /api/v1/gateways"""
        res = self._request("GET", "/api/v1/gateways")
        return res.get("data", []) if res else []

    def get_gateway_status(self, gateway_id: str) -> Dict[str, Any]:
        """GET /api/v1/gateways/:id/status"""
        return self._request("GET", f"/api/v1/gateways/{_quote(gateway_id)}/status")

    def rotate_gateway_token(self, gateway_id: str) -> Dict[str, Any]:
        """POST /api/v1/gateways/:id/rotate"""
        return self._request("POST", f"/api/v1/gateways/{_quote(gateway_id)}/rotate", {})

    def revoke_gateway(self, gateway_id: str, reason: Optional[str] = None) -> None:
        """DELETE /api/v1/gateways/:id"""
        self._request("DELETE", f"/api/v1/gateways/{_quote(gateway_id)}", {"reason": reason})

    def set_gateway_config(
        self,
        gateway_id: str,
        require_vk: Optional[bool] = None,
        require_provisioned_key: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """PATCH /api/v1/gateways/:id/config"""
        body: Dict[str, Any] = {}
        if require_vk is not None:
            body["requireVk"] = require_vk
        if require_provisioned_key is not None:
            body["requireProvisionedKey"] = require_provisioned_key
        return self._request("PATCH", f"/api/v1/gateways/{_quote(gateway_id)}/config", body)

    def assign_workspace_gateway(self, gateway_id: Optional[str]) -> Dict[str, Any]:
        """PATCH /api/v1/workspace/gateway -- pass None to clear the override."""
        return self._request("PATCH", "/api/v1/workspace/gateway", {"gatewayId": gateway_id})

    def assign_org_gateway(self, org_id: str, gateway_id: Optional[str]) -> Dict[str, Any]:
        """PATCH /api/v1/orgs/:orgId/gateway -- pass None to clear the org default."""
        return self._request(
            "PATCH", f"/api/v1/orgs/{_quote(org_id)}/gateway", {"gatewayId": gateway_id}
        )

    def resolve_gateway(self) -> Dict[str, Any]:
        """GET /api/v1/workspace/gateway-resolution"""
        return self._request("GET", "/api/v1/workspace/gateway-resolution")

    def list_provider_credentials(self) -> List[Dict[str, Any]]:
        """GET /api/v1/workspace/provider-credentials"""
        res = self._request("GET", "/api/v1/workspace/provider-credentials")
        return res.get("data", []) if res else []

    def set_provider_credential(self, provider: str, fields: Dict[str, str]) -> Dict[str, Any]:
        """PUT /api/v1/workspace/provider-credentials/:provider"""
        return self._request(
            "PUT", f"/api/v1/workspace/provider-credentials/{_quote(provider)}", fields
        )

    def unset_provider_credential(self, provider: str) -> None:
        """DELETE /api/v1/workspace/provider-credentials/:provider"""
        self._request("DELETE", f"/api/v1/workspace/provider-credentials/{_quote(provider)}")


def _quote(segment: str) -> str:
    from urllib.parse import quote

    return quote(segment, safe="")
