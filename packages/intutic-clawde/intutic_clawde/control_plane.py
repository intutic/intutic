"""Control-plane management client -- org/team/gateway/credentials
administration, as distinct from ClawdeClient's data-plane chat calls.

Deliberately a separate class, not new methods on ClawdeClient:
ClawdeClient.base_url targets the *proxy* (default http://localhost:4000);
the control plane is a different origin entirely (default
https://app.intutic.ai, or a self-hosted CONTROL_PLANE_URL). Bolting
management calls onto ClawdeClient would silently need a second base URL
on a class whose whole contract today is "one client, one proxy."

Every endpoint here comes from the control-plane calls in
tools/cli/src/commands/* -- the CLI's own already-tested contracts, not
re-derived -- and the TypeScript SDK's control-plane.ts has the same methods
in camelCase, with the same arguments (its trailing options object is the
keyword arguments here). packages/shared-types/fixtures/control-plane-operations.json
lists every method with the request it makes and the answer it returns, and
both SDKs' tests run against it, so neither can grow a method the other
lacks. Method names follow one pattern for whatever is added next: a verb
(list, get, create, update, delete, rotate_..._secret, download, or the CLI
subcommand's own verb, such as approve or promote), then the resource.

Not included: session establishment (login/logout; an SDK caller supplies
api_key directly, and ClawdeClient registers its own session), the CLI's
workspace budget (ClawdeClient.check_budget()), and commands that act on the
machine they run on: init, setup, doctor, install-daemon, connect,
disconnect, exec, start, sync-context, rollback, enforce, rules, judge, skill
(its loop commands are here), sops status, guardrails pull, and policy
compile|install|snapshot|list-local.

Works unmodified against a self-hosted control plane -- there is no
SaaS-vs-self-hosted branch anywhere in this file. An open-core user who
runs the proxy standalone with no control plane configured simply never
constructs this class (or does, points it at nothing, and gets a
ClawdeConnectionError on the first call) -- the same framing whoami.ts
already uses: "This command needs an Intutic control plane, which open
core does not include."

Auth: the same api_key type ClawdeClient accepts -- a vk_ token or a JWT
both satisfy services/control-plane/src/middleware/auth.ts, which resolves
either to an AuthContext with a role. A call the role may not make raises
ClawdeConnectionError with the control plane's answer; for a 403 that names
the roles allowed (``detail``), the message is that sentence, as the CLI
prints it.
"""

import hashlib
import json
import os
import requests
from typing import Any, Dict, List, Optional, Sequence, Union, cast
from urllib.parse import quote, quote_plus
from .errors import ClawdeConnectionError
from .toon import unwrap_toon_envelope
from .types import (
    AttenuationResult,
    AuthoredGuardrailInput,
    AuthoredGuardrailWriteResult,
    BundleUploadResult,
    CommitUsageResponse,
    BranchUsageResponse,
    ConfigChain,
    CostPrediction,
    DecisionReviewResult,
    DeviceDisconnect,
    EvidenceCollectResult,
    FindingAdjudication,
    FindingStats,
    FrameworkCoverage,
    GateLiveness,
    GatewayStatus,
    GitHubWebhookInfo,
    GitHubWebhookSecret,
    GuardrailReplay,
    GuardrailTransitionResult,
    Incident,
    IncidentList,
    IntegrityChain,
    IntegrityRecompute,
    IntegrityRootDetail,
    IntegrityRootList,
    InventorySummary,
    LoopRunActionResult,
    McpServerDecision,
    McpServerList,
    MemberUsageResponse,
    NotificationRule,
    NotificationRuleInput,
    NotificationSecretRotation,
    PolicyChangeResult,
    PolicySourceInput,
    PolicySourceSyncResult,
    PredictCostParams,
    PullRequestRefreshResult,
    PullRequestUsageResponse,
    ResponseEchoReport,
    RuleCandidateSource,
    SiemDestination,
    SiemDestinationInput,
    SiemDestinationList,
    SiemSecretRotation,
    SiemSources,
    SigningJwks,
    SopCreateResult,
    SopInput,
    TeamUsageResponse,
    TraceList,
    WasmReplayResult,
)

DEFAULT_CONTROL_PLANE_URL = "https://app.intutic.ai"

#: The connector providers ``intutic guardrails sources`` lists: the ones that are policy sources.
POLICY_SOURCE_PROVIDERS = frozenset({"notion", "confluence", "github", "gdrive"})

#: The coverage report's format names on the route, by the CLI's names.
COVERAGE_FORMATS = {"json": "json", "md": "markdown", "csv": "csv", "pdf": "pdf"}

_GUARDRAILS = "/api/v1/policy-guardrails"


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

    def _send(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        auth: bool = True,
        files: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, str]] = None,
    ) -> requests.Response:
        # A multipart body sets its own content type, boundary included.
        headers: Dict[str, str] = {} if files else {"Content-Type": "application/json"}
        if auth:
            headers["Authorization"] = f"Bearer {self.api_key}"
        kwargs: Dict[str, Any] = {"files": files, "data": data} if files else {"json": body}
        try:
            return requests.request(
                method, f"{self.base_url}{path}", headers=headers, timeout=30.0, **kwargs
            )
        except requests.RequestException as e:
            raise ClawdeConnectionError(
                f"Could not reach control plane at {self.base_url}: {e}"
            )

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        auth: bool = True,
        answers: Sequence[int] = (),
        files: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, str]] = None,
    ) -> Any:
        """A JSON call. ``answers`` lists the error statuses whose body is the
        answer rather than a failure: the integrity chain walk answers a break
        with 409."""
        res = self._send(method, path, body, auth, files, data)
        if not res.ok and res.status_code not in answers:
            raise _failure(method, path, res.status_code, res.text)

        if not res.content:
            return None
        return unwrap_toon_envelope(res.json())

    def _download(self, path: str) -> bytes:
        """A file download: the body as bytes. Its errors are JSON, as every other call's."""
        res = self._send("GET", path)
        if not res.ok:
            raise _failure("GET", path, res.status_code, res.text)
        return res.content

    def _list(self, path: str, key: str) -> List[Dict[str, Any]]:
        res = self._request("GET", path)
        return (res or {}).get(key) or []

    def whoami(self) -> Dict[str, Any]:
        """GET /api/v1/auth/me"""
        return self._request("GET", "/api/v1/auth/me")

    def signup_org(self, email: str, password: str, name: str, org_name: str) -> Dict[str, Any]:
        """POST /api/v1/auth/signup/org -- unauthenticated, creates the calling user.

        Closed by default in production (INTUTIC_PUBLIC_ORG_SIGNUP, off
        unless a deployment has built its own anonymous domain-verification
        story): creating a real org auto-provisions a real managed gateway
        cell, so org creation now requires DNS domain-ownership
        proof, and an anonymous caller has no session to own a verification
        attempt against. Prefer start_domain_verification +
        check_domain_verification + create_org with an already-authenticated
        api_key -- the same flow the CLI's `intutic org create` and the
        dashboard's "Create Organization" modal use.
        """
        return self._request(
            "POST",
            "/api/v1/auth/signup/org",
            {"email": email, "password": password, "name": name, "orgName": org_name},
            auth=False,
        )

    def start_domain_verification(self, domain: str) -> Dict[str, Any]:
        """POST /api/v1/domain-verification/start -- mints a DNS TXT-record
        verification token for `domain`. Publish a TXT record at
        `txtRecordName` with value `txtRecordValue`, then poll
        check_domain_verification until `status` is 'verified'.
        """
        return self._request("POST", "/api/v1/domain-verification/start", {"domain": domain})

    def check_domain_verification(self, verification_id: str) -> Dict[str, Any]:
        """GET /api/v1/domain-verification/:id -- re-checks DNS for the TXT
        record. Safe to call repeatedly; performs a fresh lookup every call.
        """
        return self._request("GET", f"/api/v1/domain-verification/{_quote(verification_id)}")

    def create_org(
        self, org_name: str, domain: str, verification_id: str, region: Optional[str] = None
    ) -> Dict[str, Any]:
        """POST /api/v1/orgs -- creates a real org from an already-authenticated
        caller. Requires a 'verified', unconsumed domain verification (see
        start_domain_verification); the verification is consumed atomically
        inside the org-insert transaction, so it backs exactly this one org.
        `region` picks the managed gateway cell's placement ('us', 'eu', ...);
        omitted, the deployment's home region applies. Server-validated.
        """
        body: Dict[str, Any] = {
            "orgName": org_name,
            "domain": domain,
            "verificationId": verification_id,
        }
        if region is not None:
            body["region"] = region
        return self._request("POST", "/api/v1/orgs", body)

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

    def get_gateway_status(self, gateway_id: str) -> GatewayStatus:
        """GET /api/v1/gateways/:id/status"""
        return cast(GatewayStatus, self._request("GET", f"/api/v1/gateways/{_quote(gateway_id)}/status"))

    def rotate_gateway_token(self, gateway_id: str) -> Dict[str, Any]:
        """POST /api/v1/gateways/:id/rotate"""
        return self._request("POST", f"/api/v1/gateways/{_quote(gateway_id)}/rotate", {})

    def revoke_gateway(self, gateway_id: str, reason: Optional[str] = None) -> None:
        """DELETE /api/v1/gateways/:id"""
        self._request("DELETE", f"/api/v1/gateways/{_quote(gateway_id)}", {"reason": reason})

    def get_gateway_config(self, gateway_id: str) -> Dict[str, Any]:
        """GET /api/v1/gateways/:id/config -- the flags set on the gateway
        (``requireVk``, ``requireProvisionedKey``) and ``configVersion``, as the
        gateway pulls them. A flag never set is absent: the gateway runs its
        deployment's own value.
        """
        return self._request("GET", f"/api/v1/gateways/{_quote(gateway_id)}/config")

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

    def get_workspace_settings(self) -> Dict[str, Any]:
        """GET /api/v1/workspace/settings -- every setting, resolved with its default."""
        return self._request("GET", "/api/v1/workspace/settings")

    def update_workspace_settings(self, settings: Dict[str, Any]) -> Dict[str, Any]:
        """PUT /api/v1/workspace/settings -- the route ``intutic settings set`` calls.

        Only the keys given change; the rest are kept (``featureFlags`` merges
        one level deeper, so one flag does not switch the others off). The
        control plane is the authority on which keys exist and what each
        accepts: an unknown key or a bad value is refused with a 400 naming
        it, a setting the workspace's plan does not include (the group policy
        below Biz Org) with a 403 "Upgrade required", and a member below
        OWNER or ADMIN with a 403. Each refusal raises ClawdeConnectionError
        carrying the server's answer.
        """
        return self._request("PUT", "/api/v1/workspace/settings", settings)

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

    def list_provider_models(self, provider: str) -> Dict[str, Any]:
        """GET /api/v1/workspace/provider-credentials/:provider/models -- the
        models the stored key can reach, as the provider listed them when the
        key was last checked: ``{"provider", "models", "checkedAt"}``, with
        ``models`` and ``checkedAt`` None until a check has recorded a list."""
        return self._request(
            "GET", f"/api/v1/workspace/provider-credentials/{_quote(provider)}/models"
        )

    # ─── MCP server registry (intutic mcp) ───

    def list_mcp_servers(self) -> McpServerList:
        """GET /api/v1/mcp/servers -- every server the workspace's MCP proxies
        have reported, and the registry-wide policy."""
        return cast(McpServerList, self._request("GET", "/api/v1/mcp/servers"))

    def approve_mcp_server(self, server_id: str) -> McpServerDecision:
        """POST /api/v1/mcp/servers/:serverId/status -- approve a server (OWNER, ADMIN)."""
        return self._set_mcp_server_status(server_id, "approved")

    def block_mcp_server(self, server_id: str) -> McpServerDecision:
        """POST /api/v1/mcp/servers/:serverId/status -- block a server (OWNER, ADMIN)."""
        return self._set_mcp_server_status(server_id, "blocked")

    def reset_mcp_server(self, server_id: str) -> McpServerDecision:
        """POST /api/v1/mcp/servers/:serverId/status -- return a server to the
        approval queue (OWNER, ADMIN)."""
        return self._set_mcp_server_status(server_id, "candidate")

    def enable_mcp_tool(self, server_id: str, tool: str) -> McpServerDecision:
        """POST /api/v1/mcp/servers/:serverId/tools -- switch one tool on (OWNER, ADMIN)."""
        return cast(McpServerDecision, self._request(
            "POST", f"/api/v1/mcp/servers/{_quote(server_id)}/tools", {"tool": tool, "enabled": True}
        ))

    def disable_mcp_tool(self, server_id: str, tool: str) -> McpServerDecision:
        """POST /api/v1/mcp/servers/:serverId/tools -- switch one tool off (OWNER, ADMIN)."""
        return cast(McpServerDecision, self._request(
            "POST", f"/api/v1/mcp/servers/{_quote(server_id)}/tools", {"tool": tool, "enabled": False}
        ))

    def _set_mcp_server_status(self, server_id: str, status: str) -> McpServerDecision:
        return cast(McpServerDecision, self._request(
            "POST", f"/api/v1/mcp/servers/{_quote(server_id)}/status", {"status": status}
        ))

    # ─── Notification rules (intutic notifications) ───

    def list_notification_rules(self) -> List[NotificationRule]:
        """GET /api/v1/notifications/rules"""
        return cast(List[NotificationRule], self._list("/api/v1/notifications/rules", "rules"))

    def create_notification_rule(self, rule: NotificationRuleInput) -> NotificationRule:
        """POST /api/v1/notifications/rules. A webhook rule comes back with its
        ``signingSecret``, which is not shown again."""
        return cast(NotificationRule, self._request("POST", "/api/v1/notifications/rules", dict(rule)))

    def update_notification_rule(self, rule_id: str, changes: NotificationRuleInput) -> NotificationRule:
        """PUT /api/v1/notifications/rules/:ruleId -- only the fields given
        change. A switch to the webhook channel comes back with the new
        ``signingSecret``."""
        return cast(NotificationRule, self._request(
            "PUT", f"/api/v1/notifications/rules/{_quote(rule_id)}", dict(changes)
        ))

    def delete_notification_rule(self, rule_id: str) -> None:
        """DELETE /api/v1/notifications/rules/:ruleId"""
        self._request("DELETE", f"/api/v1/notifications/rules/{_quote(rule_id)}")

    def rotate_notification_rule_secret(self, rule_id: str) -> NotificationSecretRotation:
        """POST /api/v1/notifications/rules/:ruleId/signing-secret -- deliveries
        are signed with the new secret from now on."""
        return cast(NotificationSecretRotation, self._request(
            "POST", f"/api/v1/notifications/rules/{_quote(rule_id)}/signing-secret"
        ))

    # ─── SIEM export (intutic siem) ───

    def list_siem_destinations(self) -> SiemDestinationList:
        """GET /api/v1/siem/destinations -- the destinations and the event
        sources they can receive."""
        return cast(SiemDestinationList, self._request("GET", "/api/v1/siem/destinations"))

    def get_siem_destination(self, destination_id: str) -> SiemDestination:
        """GET /api/v1/siem/destinations/:destinationId"""
        return cast(SiemDestination, self._request("GET", f"/api/v1/siem/destinations/{_quote(destination_id)}"))

    def list_siem_sources(self) -> SiemSources:
        """The event sources a destination can receive; ``defaults`` are the
        ones an empty ``sourceTables`` means."""
        return self.list_siem_destinations()["sources"]

    def create_siem_destination(self, destination: SiemDestinationInput) -> SiemDestination:
        """POST /api/v1/siem/destinations (OWNER, ADMIN). The control plane
        refuses a destination that points at an internal address. A webhook
        destination comes back with its ``signingSecret``, which is not shown
        again."""
        return cast(SiemDestination, self._request("POST", "/api/v1/siem/destinations", dict(destination)))

    def update_siem_destination(self, destination_id: str, changes: SiemDestinationInput) -> SiemDestination:
        """PUT /api/v1/siem/destinations/:destinationId (OWNER, ADMIN) -- only the fields given change."""
        return cast(SiemDestination, self._request(
            "PUT", f"/api/v1/siem/destinations/{_quote(destination_id)}", dict(changes)
        ))

    def delete_siem_destination(self, destination_id: str) -> None:
        """DELETE /api/v1/siem/destinations/:destinationId (OWNER, ADMIN) --
        deactivates it; ``update_siem_destination(id, {"isActive": True})``
        turns it back on."""
        self._request("DELETE", f"/api/v1/siem/destinations/{_quote(destination_id)}")

    def rotate_siem_destination_secret(self, destination_id: str) -> SiemSecretRotation:
        """POST /api/v1/siem/destinations/:destinationId/signing-secret (OWNER, ADMIN)"""
        return cast(SiemSecretRotation, self._request(
            "POST", f"/api/v1/siem/destinations/{_quote(destination_id)}/signing-secret"
        ))

    # ─── Usage (intutic usage) ───
    #
    # OWNER, ADMIN and EM see the whole workspace; anyone else their own calls
    # (scope "self"). get_team_usage is refused below EM.

    def get_member_usage(self, period: str = "monthly") -> MemberUsageResponse:
        """GET /api/v1/usage/members -- ``period`` is "daily" or "monthly"."""
        return cast(MemberUsageResponse, self._request("GET", f"/api/v1/usage/members{_query(period=period)}"))

    def get_team_usage(self, period: str = "monthly") -> TeamUsageResponse:
        """GET /api/v1/usage/teams -- per SCIM group."""
        return cast(TeamUsageResponse, self._request("GET", f"/api/v1/usage/teams{_query(period=period)}"))

    def get_branch_usage(self, period: str = "monthly") -> BranchUsageResponse:
        """GET /api/v1/usage/branches"""
        return cast(BranchUsageResponse, self._request("GET", f"/api/v1/usage/branches{_query(period=period)}"))

    def get_commit_usage(self, period: str = "monthly") -> CommitUsageResponse:
        """GET /api/v1/usage/commits"""
        return cast(CommitUsageResponse, self._request("GET", f"/api/v1/usage/commits{_query(period=period)}"))

    def get_pull_request_usage(self, period: str = "monthly") -> PullRequestUsageResponse:
        """GET /api/v1/usage/pull-requests"""
        return cast(PullRequestUsageResponse, self._request(
            "GET", f"/api/v1/usage/pull-requests{_query(period=period)}"
        ))

    def refresh_pull_request_usage(self) -> PullRequestRefreshResult:
        """POST /api/v1/usage/pull-requests/refresh -- look the branches up on
        GitHub now (OWNER, ADMIN, EM)."""
        return cast(PullRequestRefreshResult, self._request("POST", "/api/v1/usage/pull-requests/refresh"))

    # ─── AI inventory (intutic inventory) ───
    #
    # OWNER, ADMIN and EM see every machine; a DEVELOPER only their own.

    def get_inventory_summary(self) -> InventorySummary:
        """GET /api/v1/inventory/summary"""
        return cast(InventorySummary, self._request("GET", "/api/v1/inventory/summary")["data"])

    def list_inventory_devices(self) -> List[Dict[str, Any]]:
        """GET /api/v1/inventory/devices -- one row per machine."""
        return self._list("/api/v1/inventory/devices", "data")

    def list_inventory_harnesses(
        self,
        status: Optional[str] = None,
        harness: Optional[str] = None,
        device: Optional[str] = None,
        search: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """GET /api/v1/inventory/harnesses -- ``device`` is a device id;
        ``search`` matches the harness name and the machine's hostname."""
        return self._list(f"/api/v1/inventory/harnesses{_inventory_query(status, harness, device, search)}", "data")

    def list_inventory_mcp_servers(
        self,
        status: Optional[str] = None,
        harness: Optional[str] = None,
        device: Optional[str] = None,
        search: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """GET /api/v1/inventory/mcp-servers"""
        return self._list(f"/api/v1/inventory/mcp-servers{_inventory_query(status, harness, device, search)}", "data")

    def list_inventory_skills(self, device: Optional[str] = None, search: Optional[str] = None) -> List[Dict[str, Any]]:
        """GET /api/v1/inventory/skills"""
        return self._list(f"/api/v1/inventory/skills{_inventory_query(None, None, device, search)}", "data")

    def list_inventory_disconnects(self, limit: Optional[int] = None) -> List[DeviceDisconnect]:
        """GET /api/v1/inventory/disconnects -- machines that ran
        ``intutic disconnect``, newest first (default 100, at most 500)."""
        return cast(List[DeviceDisconnect], self._list(f"/api/v1/inventory/disconnects{_query(limit=limit)}", "data"))

    def download_inventory_harnesses_csv(
        self,
        status: Optional[str] = None,
        harness: Optional[str] = None,
        device: Optional[str] = None,
        search: Optional[str] = None,
    ) -> bytes:
        """GET /api/v1/inventory/harnesses?format=csv -- the CSV the dashboard downloads."""
        return self._download(f"/api/v1/inventory/harnesses{_inventory_query(status, harness, device, search, csv=True)}")

    def download_inventory_mcp_servers_csv(
        self,
        status: Optional[str] = None,
        harness: Optional[str] = None,
        device: Optional[str] = None,
        search: Optional[str] = None,
    ) -> bytes:
        """GET /api/v1/inventory/mcp-servers?format=csv"""
        return self._download(f"/api/v1/inventory/mcp-servers{_inventory_query(status, harness, device, search, csv=True)}")

    # ─── Compliance (intutic compliance) ───

    def get_framework_coverage(self, framework_id: str) -> FrameworkCoverage:
        """GET /api/v1/compliance/frameworks/:frameworkId/coverage --
        ``eu_ai_act``, ``iso_42001``, ``nist_ai_rmf`` or ``mitre_atlas``."""
        return cast(FrameworkCoverage, self._request(
            "GET", f"/api/v1/compliance/frameworks/{_quote(framework_id)}/coverage"
        ))

    def download_framework_coverage(self, framework_id: str, format: str) -> bytes:
        """GET /api/v1/compliance/frameworks/:frameworkId/coverage?format= --
        the report as a file: ``format`` is "json", "md", "csv" or "pdf".
        Unsigned: the signed copies are the ones sealed in the evidence
        archive."""
        route_format = COVERAGE_FORMATS.get(format)
        if route_format is None:
            raise ValueError(f"format must be one of {', '.join(COVERAGE_FORMATS)}, got \"{format}\"")
        return self._download(
            f"/api/v1/compliance/frameworks/{_quote(framework_id)}/coverage{_query(format=route_format)}"
        )

    def collect_evidence(
        self, period_start: Optional[str] = None, period_end: Optional[str] = None
    ) -> EvidenceCollectResult:
        """POST /api/v1/compliance/soc2-collect (OWNER, ADMIN) -- run a fresh
        evidence collection and seal it. The period bounds are ISO 8601."""
        return cast(EvidenceCollectResult, self._request(
            "POST",
            "/api/v1/compliance/soc2-collect",
            _defined(periodStart=period_start, periodEnd=period_end),
        ))

    def download_evidence(self, run_id: str) -> bytes:
        """GET /api/v1/compliance/soc2-export/:runId (OWNER, ADMIN) -- a stored
        archive, as the file. Check it with ``verify_evidence_archive``."""
        return self._download(f"/api/v1/compliance/soc2-export/{_quote(run_id)}")

    def get_signing_keys(self) -> SigningJwks:
        """GET /.well-known/intutic-trace-signing.json -- the published signing
        keys, fetched without credentials. ``verify_evidence_archive`` takes them."""
        return cast(SigningJwks, self._request("GET", "/.well-known/intutic-trace-signing.json", auth=False))

    # ─── Gate liveness and the GitHub webhook ───

    def get_gate_liveness(self) -> GateLiveness:
        """GET /api/v1/governance/gate-liveness (OWNER, ADMIN, EM) -- whether
        each installed harness's gate is reporting."""
        return cast(GateLiveness, self._request("GET", "/api/v1/governance/gate-liveness"))

    def get_github_webhook(self) -> GitHubWebhookInfo:
        """GET /api/v1/integrations/github/webhook (OWNER, ADMIN) -- the payload
        URL; never the secret."""
        return cast(GitHubWebhookInfo, self._request("GET", "/api/v1/integrations/github/webhook"))

    def rotate_github_webhook_secret(self) -> GitHubWebhookSecret:
        """POST /api/v1/integrations/github/webhook/secret (OWNER, ADMIN) --
        make the webhook, or replace its secret. Deliveries signed with an
        earlier secret are refused from then on."""
        return cast(GitHubWebhookSecret, self._request("POST", "/api/v1/integrations/github/webhook/secret"))

    # ─── Policy guardrails (intutic guardrails) ───

    def list_policy_sources(self) -> List[Dict[str, Any]]:
        """GET /api/v1/connectors -- the workspace's policy sources (Notion,
        Confluence, GitHub, Google Drive)."""
        items = self._list("/api/v1/connectors", "items")
        return [c for c in items if c.get("provider") in POLICY_SOURCE_PROVIDERS]

    def add_policy_source(self, source: PolicySourceInput) -> Dict[str, Any]:
        """POST /api/v1/connectors"""
        return self._request("POST", "/api/v1/connectors", {"config": {}, **source})

    def sync_policy_source(self, connector_id: str) -> PolicySourceSyncResult:
        """POST /api/v1/connectors/:connectorId/sync"""
        return cast(PolicySourceSyncResult, self._request("POST", f"/api/v1/connectors/{_quote(connector_id)}/sync", {}))

    def list_policy_documents(self) -> List[Dict[str, Any]]:
        """GET /api/v1/policy-guardrails/documents"""
        return self._list(f"{_GUARDRAILS}/documents", "documents")

    def get_policy_document(self, doc_id: str) -> Dict[str, Any]:
        """GET /api/v1/policy-guardrails/documents/:docId -- passages, clauses
        and extraction runs."""
        return self._request("GET", f"{_GUARDRAILS}/documents/{_quote(doc_id)}")["document"]

    def extract_policy_document(self, doc_id: str, llm: bool = True) -> Dict[str, Any]:
        """POST /api/v1/policy-guardrails/documents/:docId/extract -- propose
        guardrails from the document's clauses. ``llm=False`` runs only the
        front-matter lift, with no model call."""
        return self._request("POST", f"{_GUARDRAILS}/documents/{_quote(doc_id)}/extract", {"llm": llm})["result"]

    def get_guardrail_coverage(self, token: str) -> Dict[str, Any]:
        """GET /api/v1/policy-guardrails/coverage?token= -- the passages that
        mention a tool or action, and the guardrails on them."""
        return self._request("GET", f"{_GUARDRAILS}/coverage{_query(token=token)}")["coverage"]

    def search_policy_passages(self, text: str) -> Dict[str, Any]:
        """GET /api/v1/policy-guardrails/search?q= -- full-text search over live
        passages, best match first."""
        return self._request("GET", f"{_GUARDRAILS}/search{_query(q=text)}")["search"]

    def get_guardrail_impact(self, doc_id: Optional[str] = None, passage_id: Optional[str] = None) -> Dict[str, Any]:
        """GET /api/v1/policy-guardrails/impact -- what a change to a document
        or a passage reaches. Name one of them."""
        return self._request("GET", f"{_GUARDRAILS}/impact{_query(docId=doc_id, passageId=passage_id)}")["impact"]

    def list_guardrail_duplicates(self, min_jaccard: Optional[float] = None) -> Dict[str, Any]:
        """GET /api/v1/policy-guardrails/duplicates -- overlapping passages and
        rules cited more than once. ``min_jaccard`` is 0 to 1."""
        return self._request("GET", f"{_GUARDRAILS}/duplicates{_query(minJaccard=min_jaccard)}")["duplicates"]

    def list_guardrails(
        self,
        status: Optional[str] = None,
        target: Optional[str] = None,
        provenance: Optional[str] = None,
        doc_id: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """GET /api/v1/policy-guardrails/guardrails"""
        query = _query(status=status, target=target, provenance=provenance, docId=doc_id, limit=limit)
        return self._list(f"{_GUARDRAILS}/guardrails{query}", "guardrails")

    def get_guardrail(self, guardrail_id: str) -> Dict[str, Any]:
        """GET /api/v1/policy-guardrails/guardrails/:guardrailId"""
        return self._request("GET", f"{_GUARDRAILS}/guardrails/{_quote(guardrail_id)}")["guardrail"]

    def get_guardrail_readiness(self, guardrail_id: str) -> Dict[str, Any]:
        """GET /api/v1/policy-guardrails/guardrails/:guardrailId/readiness --
        whether a SHADOW guardrail's evidence clears promotion."""
        return self._request("GET", f"{_GUARDRAILS}/guardrails/{_quote(guardrail_id)}/readiness")["readiness"]

    def approve_guardrail_shadow(self, guardrail_id: str) -> GuardrailTransitionResult:
        """POST .../guardrails/:guardrailId/approve-shadow -- into SHADOW:
        distributed as warn, measuring, enforcing nothing."""
        return self._transition_guardrail(guardrail_id, "approve-shadow", {})

    def promote_guardrail(self, guardrail_id: str, acknowledge_no_traffic: bool = False) -> GuardrailTransitionResult:
        """POST .../guardrails/:guardrailId/promote -- into ENFORCING. Refused
        with a 409 until the shadow evidence clears the thresholds; a guardrail
        that never fired needs ``acknowledge_no_traffic``."""
        return self._transition_guardrail(guardrail_id, "promote", {"acknowledgeNoTraffic": acknowledge_no_traffic is True})

    def reject_guardrail(self, guardrail_id: str, reason: str) -> GuardrailTransitionResult:
        """POST .../guardrails/:guardrailId/reject -- recorded with the reason."""
        return self._transition_guardrail(guardrail_id, "reject", {"reason": reason})

    def retire_guardrail(self, guardrail_id: str) -> GuardrailTransitionResult:
        """POST .../guardrails/:guardrailId/retire -- gone from every rule
        endpoint on the next poll."""
        return self._transition_guardrail(guardrail_id, "retire", {})

    def reconfirm_guardrail(self, guardrail_id: str) -> GuardrailTransitionResult:
        """POST .../guardrails/:guardrailId/reconfirm -- re-confirm a stale
        citation against a live passage."""
        return self._transition_guardrail(guardrail_id, "reconfirm", {})

    def create_guardrail(self, guardrail: AuthoredGuardrailInput) -> AuthoredGuardrailWriteResult:
        """POST /api/v1/policy-guardrails/guardrails (OWNER, ADMIN) -- an
        authored guardrail, created PROPOSED. An IR a check refuses is a 400
        naming the check."""
        return cast(AuthoredGuardrailWriteResult, self._request("POST", f"{_GUARDRAILS}/guardrails", dict(guardrail)))

    def update_guardrail(self, guardrail_id: str, changes: AuthoredGuardrailInput) -> AuthoredGuardrailWriteResult:
        """PUT /api/v1/policy-guardrails/guardrails/:guardrailId (OWNER, ADMIN).
        A changed IR creates the next version (``forked``), PROPOSED with no
        evidence; a name or description edit keeps the evidence."""
        return cast(AuthoredGuardrailWriteResult, self._request(
            "PUT", f"{_GUARDRAILS}/guardrails/{_quote(guardrail_id)}", dict(changes)
        ))

    def delete_guardrail(self, guardrail_id: str) -> GuardrailTransitionResult:
        """DELETE /api/v1/policy-guardrails/guardrails/:guardrailId (OWNER,
        ADMIN) -- retires it; its history is kept."""
        return cast(GuardrailTransitionResult, self._request("DELETE", f"{_GUARDRAILS}/guardrails/{_quote(guardrail_id)}"))

    def replay_guardrail(self, guardrail_id: str) -> GuardrailReplay:
        """POST .../guardrails/:guardrailId/replay -- what the guardrail would
        have done on captured traffic."""
        return cast(GuardrailReplay, self._request(
            "POST", f"{_GUARDRAILS}/guardrails/{_quote(guardrail_id)}/replay", {}
        )["replay"])

    def list_guardrail_conflicts(self) -> List[Dict[str, Any]]:
        """GET /api/v1/policy-guardrails/conflicts -- live guardrails and
        front-matter rules that contradict each other."""
        return self._list(f"{_GUARDRAILS}/conflicts", "conflicts")

    def _transition_guardrail(self, guardrail_id: str, action: str, body: Dict[str, Any]) -> GuardrailTransitionResult:
        return cast(GuardrailTransitionResult, self._request(
            "POST", f"{_GUARDRAILS}/guardrails/{_quote(guardrail_id)}/{action}", body
        ))

    # ─── Held decisions and loop runs (intutic decision, intutic loop) ───

    def approve_decision(self, hold_id: str, reason: Optional[str] = None) -> DecisionReviewResult:
        """POST /api/v1/decisions/:holdId/review (OWNER, ADMIN, EM) -- approve a held call."""
        return cast(DecisionReviewResult, self._request(
            "POST", f"/api/v1/decisions/{_quote(hold_id)}/review", _defined(action="approve", reason=reason)
        ))

    def reject_decision(self, hold_id: str, reason: Optional[str] = None) -> DecisionReviewResult:
        """POST /api/v1/decisions/:holdId/review (OWNER, ADMIN, EM) -- reject a held call."""
        return cast(DecisionReviewResult, self._request(
            "POST", f"/api/v1/decisions/{_quote(hold_id)}/review", _defined(action="reject", reason=reason)
        ))

    def start_loop_run(
        self,
        name: str,
        budget_limit_usd: Optional[Union[float, str]] = None,
        sops: Optional[List[str]] = None,
        auto_judge: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """POST /api/v1/loops/start -- register a loop run. Send its id with
        the run's requests (INTUTIC_LOOP_RUN_ID, as ``intutic loop exec`` sets
        it) so the proxy files them under it."""
        body = _defined(name=name, budgetLimitUsd=budget_limit_usd, sops=sops, autoJudge=auto_judge)
        return self._request("POST", "/api/v1/loops/start", body)["loop"]

    def get_loop_run(self, loop_run_id: str) -> Dict[str, Any]:
        """GET /api/v1/loops/:loopRunId"""
        return self._request("GET", f"/api/v1/loops/{_quote(loop_run_id)}")["loop"]

    def list_loop_runs(self) -> List[Dict[str, Any]]:
        """GET /api/v1/loops"""
        return self._list("/api/v1/loops", "loops")

    def complete_loop_run(self, loop_run_id: str, outcome: Optional[str] = None) -> LoopRunActionResult:
        """POST /api/v1/loops/:loopRunId/complete -- ``outcome`` ("SUCCEEDED"
        or "FAILED") records how the run ended."""
        body = None if outcome is None else {"outcome": outcome}
        return cast(LoopRunActionResult, self._request("POST", f"/api/v1/loops/{_quote(loop_run_id)}/complete", body))

    def kill_loop_run(self, loop_run_id: str) -> LoopRunActionResult:
        """POST /api/v1/loops/:loopRunId/kill"""
        return cast(LoopRunActionResult, self._request("POST", f"/api/v1/loops/{_quote(loop_run_id)}/kill"))

    def approve_loop_run(self, loop_run_id: str, note: Optional[str] = None) -> LoopRunActionResult:
        """POST /api/v1/loops/:loopRunId/review (OWNER, ADMIN, EM) -- approve a
        run held for review; it is ACTIVE again."""
        return cast(LoopRunActionResult, self._request(
            "POST", f"/api/v1/loops/{_quote(loop_run_id)}/review", _defined(action="approve", note=note)
        ))

    def reject_loop_run(self, loop_run_id: str, note: Optional[str] = None) -> LoopRunActionResult:
        """POST /api/v1/loops/:loopRunId/review (OWNER, ADMIN, EM) -- reject a
        run held for review; it is KILLED."""
        return cast(LoopRunActionResult, self._request(
            "POST", f"/api/v1/loops/{_quote(loop_run_id)}/review", _defined(action="reject", note=note)
        ))

    # ─── Findings (intutic findings) ───

    def list_findings(
        self, unadjudicated: bool = False, detector_id: Optional[str] = None, limit: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """GET /api/v1/findings -- detector findings, newest first;
        ``unadjudicated=True`` keeps only the ones nobody has ruled on."""
        query = _query(unadjudicated="true" if unadjudicated else None, detector_id=detector_id, limit=limit)
        return self._list(f"/api/v1/findings{query}", "findings")

    def adjudicate_finding(self, finding_id: str, outcome: str, note: Optional[str] = None) -> FindingAdjudication:
        """POST /api/v1/findings/:findingId/adjudicate -- ``outcome`` is
        "TRUE_POSITIVE" or "FALSE_POSITIVE"; the ruling is recorded under the
        key's member."""
        return cast(FindingAdjudication, self._request(
            "POST", f"/api/v1/findings/{_quote(finding_id)}/adjudicate", _defined(outcome=outcome, note=note)
        ))

    def get_finding_stats(self) -> FindingStats:
        """GET /api/v1/findings/stats -- false-positive rate per detector, over
        adjudicated findings."""
        return cast(FindingStats, self._request("GET", "/api/v1/findings/stats"))

    def get_response_echo_report(self, since: Optional[str] = None, until: Optional[str] = None) -> ResponseEchoReport:
        """GET /api/v1/findings/response-echo/report -- the bounds are ISO 8601."""
        return cast(ResponseEchoReport, self._request(
            "GET", f"/api/v1/findings/response-echo/report{_query(since=since, until=until)}"
        ))

    # ─── Traces (intutic traces) ───

    def list_incidents(
        self,
        status: Optional[str] = None,
        severity: Optional[str] = None,
        type: Optional[str] = None,
        page: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> IncidentList:
        """GET /api/v1/incidents (OWNER, ADMIN, EM) -- ranked by review
        priority. ``status`` is OPEN, RESOLVED or AUTO_RESOLVED; ``severity``
        CRITICAL, HIGH, MEDIUM or LOW; ``type`` an anomaly category such as
        SCOPE_VIOLATION, or WASM_RULE_REFUSED or SYSTEM_ANOMALY, and the
        control plane refuses one it does not know. ``limit`` is 1 to 100
        (default 20)."""
        query = _query(status=status, severity=severity, type=type, page=page, limit=limit)
        return cast(IncidentList, self._request("GET", f"/api/v1/incidents{query}"))

    def get_incident(self, incident_id: str) -> Incident:
        """GET /api/v1/incidents/:incidentId"""
        return cast(Incident, self._request("GET", f"/api/v1/incidents/{_quote(incident_id)}")["data"])

    def list_traces(
        self,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        since: Optional[str] = None,
        enforcement: Optional[str] = None,
        model: Optional[str] = None,
    ) -> TraceList:
        """GET /api/v1/traces -- newest first. ``limit`` is 1 to 100 (default
        20); ``since`` is ISO 8601 or a relative duration such as "24h"."""
        query = _query(limit=limit, offset=offset, since=since, enforcement=enforcement, model=model)
        return cast(TraceList, self._request("GET", f"/api/v1/traces{query}"))

    def get_trace(self, trace_id: str) -> Dict[str, Any]:
        """GET /api/v1/traces/:traceId"""
        return self._request("GET", f"/api/v1/traces/{_quote(trace_id)}")

    # ─── Trace integrity (intutic integrity) ───

    def list_integrity_roots(self, loop_run_id: Optional[str] = None) -> IntegrityRootList:
        """GET /api/v1/integrity/roots -- the sealed trace roots."""
        return cast(IntegrityRootList, self._request("GET", f"/api/v1/integrity/roots{_query(loopRunId=loop_run_id)}"))

    def get_integrity_root(self, root_id: str) -> IntegrityRootDetail:
        """GET /api/v1/integrity/roots/:rootId -- the root, its signature and its leaves."""
        return cast(IntegrityRootDetail, self._request("GET", f"/api/v1/integrity/roots/{_quote(root_id)}"))

    def recompute_integrity_root(self, root_id: str) -> IntegrityRecompute:
        """POST /api/v1/integrity/roots/:rootId/recompute -- re-derive the root
        from the stored traces."""
        return cast(IntegrityRecompute, self._request("POST", f"/api/v1/integrity/roots/{_quote(root_id)}/recompute", {}))

    def get_integrity_chain(self) -> IntegrityChain:
        """GET /api/v1/integrity/chain -- the root chain walk; ``intact: False``
        lists the breaks (the control plane answers a break with a 409, which
        is still the walk)."""
        return cast(IntegrityChain, self._request("GET", "/api/v1/integrity/chain", answers=(409,)))

    def get_integrity_config_chain(self) -> ConfigChain:
        """GET /api/v1/integrity/config-chain -- the harness config snapshot chain walk."""
        return cast(ConfigChain, self._request("GET", "/api/v1/integrity/config-chain", answers=(409,)))

    # ─── Compliance policies and WASM rules (intutic policy) ───

    def list_policies(self) -> List[Dict[str, Any]]:
        """GET /api/v1/policies"""
        return self._list("/api/v1/policies", "policies")

    def enable_policy(self, policy_id: str) -> PolicyChangeResult:
        """POST /api/v1/policies/:policyId/enable"""
        return cast(PolicyChangeResult, self._request("POST", f"/api/v1/policies/{_quote(policy_id)}/enable"))

    def disable_policy(self, policy_id: str) -> PolicyChangeResult:
        """POST /api/v1/policies/:policyId/disable"""
        return cast(PolicyChangeResult, self._request("POST", f"/api/v1/policies/{_quote(policy_id)}/disable"))

    def rollback_policy(self, policy_id: str, version: int) -> PolicyChangeResult:
        """POST /api/v1/policies/:policyId/rollback"""
        return cast(PolicyChangeResult, self._request(
            "POST", f"/api/v1/policies/{_quote(policy_id)}/rollback", {"version": version}
        ))

    def get_rule_candidate_source(self, candidate_id: str) -> RuleCandidateSource:
        """GET /api/v1/rule-candidates/:candidateId/source -- the source of
        record a candidate's bundle must be compiled from. A source that does
        not hash to the ``sourceSha256`` served with it is refused
        (ClawdeConnectionError): something between the control plane and this
        process changed it."""
        res = self._request("GET", f"/api/v1/rule-candidates/{_quote(candidate_id)}/source")
        local = hashlib.sha256(res["source"].encode("utf-8")).hexdigest()
        stated = res["sourceSha256"].lower()
        if local != stated:
            raise ClawdeConnectionError(
                f"The served source hashes to {local}, not the {stated} the control plane states."
            )
        return cast(RuleCandidateSource, {**res, "sourceSha256": stated})

    def upload_rule_candidate_bundle(
        self, candidate_id: str, wasm: bytes, source_sha256: str, file_name: str = "rule.wasm"
    ) -> BundleUploadResult:
        """POST /api/v1/rule-candidates/:candidateId/bundle (OWNER, ADMIN) --
        upload a compiled rule with the hash of the source it was compiled
        from. The control plane runs its gates; ``accepted`` says whether the
        rule went into shadow, and ``gates`` why."""
        return cast(BundleUploadResult, self._request(
            "POST",
            f"/api/v1/rule-candidates/{_quote(candidate_id)}/bundle",
            files={"file": (file_name, wasm, "application/wasm")},
            data={"source_sha256": source_sha256},
        ))

    def replay_wasm_rule(self, rule_id: str, limit: Optional[int] = None, since: Optional[str] = None) -> WasmReplayResult:
        """POST /api/v1/wasm-rules/:ruleId/replay -- what a rule would have
        done on sampled traffic, without enforcing."""
        return cast(WasmReplayResult, self._request(
            "POST", f"/api/v1/wasm-rules/{_quote(rule_id)}/replay", _defined(limit=limit, since=since)
        ))

    # ─── SOPs (intutic sops) ───

    def list_sops(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """GET /api/v1/sops"""
        return self._list(f"/api/v1/sops{_query(limit=limit)}", "items")

    def get_sop(self, sop_id: str) -> Dict[str, Any]:
        """GET /api/v1/sops/:sopId"""
        return self._request("GET", f"/api/v1/sops/{_quote(sop_id)}")

    def create_sop(self, sop: SopInput) -> SopCreateResult:
        """POST /api/v1/sops -- one workspace SOP; ``markdown_content`` without front matter."""
        return cast(SopCreateResult, self._request("POST", "/api/v1/sops", dict(sop)))

    def list_org_sops(self) -> List[Dict[str, Any]]:
        """GET /api/v1/workspace/org-sops -- the org-wide SOP floors of the key's org."""
        return self._list("/api/v1/workspace/org-sops", "data")

    def create_org_sop(self, sop: SopInput) -> Dict[str, Any]:
        """POST /api/v1/workspace/org-sops -- a mandatory org-wide floor (OWNER,
        ADMIN of a workspace in the org); ``title``, ``markdown_content`` and
        an optional ``risk_tier``."""
        return self._request("POST", "/api/v1/workspace/org-sops", dict(sop))

    def delete_org_sop(self, org_sop_id: str) -> None:
        """DELETE /api/v1/workspace/org-sops/:orgSopId -- answers 404 both for
        no such SOP and for a member without admin access."""
        self._request("DELETE", f"/api/v1/workspace/org-sops/{_quote(org_sop_id)}")

    # ─── Key attenuation, cost prediction, routing ───

    def attenuate_key(
        self, parent_key_id: str, requested_caps: List[str], ttl_seconds: Optional[int] = None
    ) -> AttenuationResult:
        """POST /api/v1/attenuate -- a child key narrowed to a subset of the
        parent key's capabilities (``ttl_seconds`` 60 to 86400). The child key
        is in the response once and never stored."""
        return cast(AttenuationResult, self._request(
            "POST",
            "/api/v1/attenuate",
            _defined(parentKeyId=parent_key_id, requestedCaps=requested_caps, ttlSeconds=ttl_seconds),
        ))

    def get_attenuation_chain(self, chain_id: str) -> List[Dict[str, Any]]:
        """GET /api/v1/attenuate/chain/:chainId (OWNER, ADMIN) -- the delegation lineage."""
        return self._list(f"/api/v1/attenuate/chain/{_quote(chain_id)}", "chain")

    def predict_cost(self, params: PredictCostParams) -> CostPrediction:
        """POST /api/v1/predict-cost -- estimate a call's cost before it runs.
        Size the input with ``inputTokenCount`` or ``inputText``."""
        return cast(CostPrediction, self._request("POST", "/api/v1/predict-cost", dict(params)))

    def get_mirror_adoption_report(self, candidate_model: str) -> Dict[str, Any]:
        """GET /api/v1/routing/mirror-adoption-report -- how a mirror-tested
        candidate model compared. Reported only; changes nothing."""
        return self._request("GET", f"/api/v1/routing/mirror-adoption-report{_query(candidateModel=candidate_model)}")


def _quote(segment: str) -> str:
    # encodeURIComponent's set, so a path names a resource the way the
    # TypeScript SDK's does.
    return quote(segment, safe="!'()*")


def _query_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _query(**params: Any) -> str:
    """A query string of the parameters that are set, with its ``?``; empty
    when none is. Encoded as URLSearchParams encodes, so both SDKs send the
    same request."""
    pairs = [
        f"{quote_plus(k, safe='*')}={quote_plus(_query_value(v), safe='*')}".replace("~", "%7E")
        for k, v in params.items()
        if v is not None
    ]
    return f"?{'&'.join(pairs)}" if pairs else ""


def _inventory_query(
    status: Optional[str], harness: Optional[str], device: Optional[str], search: Optional[str], csv: bool = False
) -> str:
    return _query(status=status, harness=harness, device=device, q=search, format="csv" if csv else None)


def _defined(**body: Any) -> Dict[str, Any]:
    """The members that are set, which is also what the TypeScript SDK's JSON sends."""
    return {k: v for k, v in body.items() if v is not None}


def _failure(method: str, path: str, status: int, text: str) -> ClawdeConnectionError:
    """The error a failed call raises. A 403 carries the control plane's
    ``detail`` when it gives one (a role guard names the roles that may make
    the call), so the message says which role can, as the CLI's does."""
    if status == 403:
        try:
            body = json.loads(text)
        except ValueError:
            body = None
        if isinstance(body, dict) and isinstance(body.get("detail"), str):
            return ClawdeConnectionError(f"Control plane {method} {path} refused (403): {body['detail']}")
    return ClawdeConnectionError(f"Control plane {method} {path} failed ({status}): {text}")
