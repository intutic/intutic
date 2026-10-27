"""HTTP client for the Intutic control plane's gate endpoints.

Endpoints used:

  POST /api/v1/hook-gate       synchronous allow/deny  -> {allowed, reason, incidentId?, code?, degraded?, decisionId?}
  POST /api/v1/hook-events     batched telemetry       -> creates governance_incidents rows
  POST /api/v1/judge/finalize  LLM judge verdict       -> {verdict, triggered, ...}
  POST /api/v1/decisions       record a hold           -> joins the review queue (hold.py)
  GET  /api/v1/decisions/approved-bypasses             -> approvals that let a held call through

Uses `requests`, like the rest of this package, through small injectable
`transport` (POST) and `get_transport` (GET) functions so tests can stub the
wire without a server.

Two behaviours that must not be "improved":

  * The hook gate fails CLOSED, on both sides. The server refuses a call
    whose checks could not run (403 GOVERNANCE_UNAVAILABLE; a shadow-mode
    workspace gets a degraded allow instead) and a body it cannot read (400
    INVALID_REQUEST). This client treats GOVERNANCE_UNAVAILABLE exactly as it
    treats a control plane it cannot reach, a non-2xx answer, or an answer
    with no boolean `allowed`: there is no verdict to defer to, and
    `fail_closed` (default True) decides, reporting `allowed=False`. Set
    `fail_closed=False` to treat the tier as advisory during an outage. A 400
    is refused whatever `fail_closed` says: it is this client's request that
    is wrong, not the control plane that is down, and allowing would hide it.
    So is a 403 INSUFFICIENT_SCOPE: the key lacks the scope the hook gate
    needs (`gateway:use`), a fault in its configuration.
  * `emit` NEVER raises. Telemetry that can break a run is worse than no
    telemetry.

A client with no API key is LOCAL-ONLY (`GateClient.local_only`): it cannot
authenticate, so it makes no request at all. Its hook gate answers allow with
code LOCAL_ONLY and says why, its events and holds are not sent, and the Gate
skips the SOP register. The local tiers (policy snapshot, SSO groups from the
snapshot, MCP registry, image integrity) are unaffected. A client WITH a key
that the control plane refuses (401) is not local-only: that is an
authentication fault, and fails closed as above.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.parse
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, Tuple

import requests

from ..control_plane import NO_CONTROL_PLANE_URL, resolve_control_plane_url

DEFAULT_TIMEOUT = 2.0
EVENT_TIMEOUT = 2.0
JUDGE_TIMEOUT = 120.0

# Mirrors HookEventSchema in the control plane.
VALID_EVENTS = {
    "tool_blocked", "tool_allowed", "tool_flagged", "tool_would_block",
    "config_tamper", "network_bypass", "guards_disabled",
    "snapshot_absent", "snapshot_stale", "snapshot_invalid", "snapshot_empty",
    "snapshot_format_newer", "tool_held", "hold_approved_bypass_used",
    # `intutic rollback` writes it; listed so a caller reporting a restore of
    # its own is not dropped.
    "tool_reverted",
}

REASON_MAX = 512   # control plane truncates at 512; do it here so logs match

# The hook gate's code for a call whose checks could not run.
GOVERNANCE_UNAVAILABLE = "GOVERNANCE_UNAVAILABLE"

# The control plane's code for a key without a scope the route needs
# (`requiredScopes`; the hook gate needs `gateway:use`). A fault in the key's
# configuration, not an outage, so it refuses whatever fail_closed says.
INSUFFICIENT_SCOPE = "INSUFFICIENT_SCOPE"

# The code on a local-only client's hook-gate answer: no key, so no call was made.
LOCAL_ONLY = "LOCAL_ONLY"

# transport(url, body, headers, timeout) -> (status_code, parsed_json_or_{})
Transport = Callable[[str, Dict[str, Any], Dict[str, str], float], Tuple[int, Dict[str, Any]]]
# get_transport(url, headers, timeout) -> (status_code, parsed_json_or_{})
GetTransport = Callable[[str, Dict[str, str], float], Tuple[int, Dict[str, Any]]]


def _parsed(res: requests.Response) -> Dict[str, Any]:
    try:
        return res.json() if res.text else {}
    except ValueError:
        return {}


def _requests_transport(url: str, body: Dict[str, Any],
                        headers: Dict[str, str], timeout: float) -> Tuple[int, Dict[str, Any]]:
    res = requests.post(url, json=body, headers=headers, timeout=timeout)
    return res.status_code, _parsed(res)


def _requests_get_transport(url: str, headers: Dict[str, str],
                            timeout: float) -> Tuple[int, Dict[str, Any]]:
    res = requests.get(url, headers=headers, timeout=timeout)
    return res.status_code, _parsed(res)


class LocalOnlyError(RuntimeError):
    """Raised before any request a local-only client would otherwise send."""

    def __init__(self, path: str):
        super().__init__(f"no API key: {path} not called (local-only client)")


class HttpStatusError(requests.HTTPError):
    """A non-2xx answer, with its status and whatever JSON body it carried."""

    def __init__(self, path: str, status: int, body: Dict[str, Any]):
        super().__init__(f"HTTP {status} from {path}")
        self.status = status
        self.body = body


def _insufficient_scope_reason(body: Dict[str, Any]) -> str:
    """The reason for an INSUFFICIENT_SCOPE answer: the scope(s) the key
    lacks, and the server's detail."""
    required = body.get("requiredScopes")
    scopes = [s for s in required if isinstance(s, str)] if isinstance(required, list) else []
    needs = ("a scope it lacks" if not scopes else f"the {scopes[0]} scope" if len(scopes) == 1
             else f"one of the scopes {', '.join(scopes)}")
    detail = body.get("detail")
    return (f"hook-gate refused the API key ({INSUFFICIENT_SCOPE}): it needs {needs}"
            + (f" — {detail}" if isinstance(detail, str) else ""))


@dataclass
class GateResponse:
    allowed: bool
    reason: str = ""
    incident_id: Optional[str] = None
    reached: bool = True   # False when the hook gate gave no verdict and fail_closed decided
    # The code the hook gate names, when it names one: the MCP registry's on its
    # refusals, GOVERNANCE_UNAVAILABLE when its checks could not run,
    # INVALID_REQUEST when it could not read the request, and
    # INSUFFICIENT_SCOPE when the API key lacks the scope it needs.
    code: Optional[str] = None
    # The hook gate's id for this decision, when this answer is its own
    # verdict: every verdict it gives names one, and a GOVERNANCE_UNAVAILABLE
    # refusal keeps it only while fail_closed refuses too. The gate reports the
    # call with it (`gateDecisionId`), so the control plane exports the
    # decision to SIEM once and files its incident once.
    decision_id: Optional[str] = None


# `intutic login` (CLI 3.x) keeps the token in the OS keychain and leaves this word in
# credentials.json's `apiKey`. Reading the field as a key sends `Bearer keychain`, and
# every control-plane tier then answers 401. The names below are the ones
# tools/cli/src/config/keychain.ts writes (the VS Code extension reads them the same way).
KEYCHAIN_SENTINEL = "keychain"
_KEYCHAIN_SERVICE = "intutic"
_KEYCHAIN_ACCOUNT = "token"


def _keychain_token(workspace_id: str) -> str:
    """The token `intutic login` stored for this workspace, or "" when there is none."""
    if not workspace_id:
        return ""
    target = f"{_KEYCHAIN_SERVICE}:workspace:{workspace_id}"
    if sys.platform == "darwin":
        cmd = ["security", "find-generic-password", "-a", _KEYCHAIN_ACCOUNT, "-s", target, "-w"]
    elif sys.platform.startswith("linux"):
        cmd = ["secret-tool", "lookup", "workspace", workspace_id, "service", _KEYCHAIN_SERVICE]
    else:
        return ""  # Windows: the CLI's PasswordVault entry is not read from here
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=10, check=True)
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout.strip()


class GateClient:
    """Control-plane client for the pre-execution gate.

    `base_url` is the control plane's address, else `INTUTIC_CONTROL_PLANE_URL`
    (this release has no default control plane). Without an `api_key` the
    client is `local_only` and needs no address; with one and no address,
    `ValueError`. `harness` defaults to "langgraph" and is sent as
    `harnessType` on every gate call and event, so incidents attribute to the
    right adapter. Override it when wrapping a different framework.
    `fail_closed` blocks a call when the hook gate gives no verdict (the
    control plane cannot be reached, answers without one, or answers
    `GOVERNANCE_UNAVAILABLE`); False lets such a call go ahead. `timeout` is
    how long one control-plane request may take, in seconds. `transport` and
    `get_transport` replace the HTTP POST and GET calls, for tests.
    """

    def __init__(self, base_url: Optional[str] = None, api_key: str = "",
                 workspace_id: str = "", session_id: str = "",
                 harness: str = "langgraph", fail_closed: bool = True,
                 timeout: float = DEFAULT_TIMEOUT,
                 transport: Optional[Transport] = None,
                 get_transport: Optional[GetTransport] = None):
        self.base_url = (resolve_control_plane_url(base_url) or "").rstrip("/")
        if api_key and not self.base_url:
            # A key says the caller wants the control-plane tiers; dropping to
            # local-only would skip the hook gate without a word.
            raise ValueError(NO_CONTROL_PLANE_URL)
        self.api_key = api_key
        self.workspace_id = workspace_id
        self.session_id = session_id
        self.harness = harness
        self.fail_closed = fail_closed
        self.timeout = timeout
        self.transport = transport or _requests_transport
        self.get_transport = get_transport or _requests_get_transport

    @property
    def local_only(self) -> bool:
        """True when there is no API key. Such a client cannot authenticate, so
        it sends nothing: the control-plane tiers (SOP register, hook gate) are
        skipped, events and holds are not reported, and the local tiers decide."""
        return not self.api_key

    def _post(self, path: str, body: Dict[str, Any], timeout: float) -> Dict[str, Any]:
        if self.local_only:
            raise LocalOnlyError(path)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "X-Workspace-Id": self.workspace_id,
        }
        status, parsed = self.transport(self.base_url + path, body, headers, timeout)
        if not 200 <= status < 300:
            raise HttpStatusError(path, status, parsed if isinstance(parsed, dict) else {})
        return parsed

    def _get(self, path: str, timeout: float) -> Dict[str, Any]:
        if self.local_only:
            raise LocalOnlyError(path)
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "X-Workspace-Id": self.workspace_id,
        }
        status, parsed = self.get_transport(self.base_url + path, headers, timeout)
        if not 200 <= status < 300:
            raise requests.HTTPError(f"HTTP {status} from {path}")
        return parsed

    # ---------------------------------------------------------------- gate

    def hook_gate(self, tool_name: str, tool_input: dict) -> GateResponse:
        """Synchronous allow/deny for one tool call.

        Worth being precise about: the endpoint matches ~19 DLP regexes
        against the serialised toolInput, plus SOP rules. It is defence in
        depth on top of the local tiers, not a replacement for them.

        When there is no verdict (the control plane cannot be reached, answers
        non-2xx or without a boolean `allowed`, or answers
        GOVERNANCE_UNAVAILABLE because its own checks could not run), the
        verdict is decided by `fail_closed`: True (the default) reports BLOCK,
        because a client with no verdict has nothing to defer to; False
        reports allow. A 400 INVALID_REQUEST, and a 403 INSUFFICIENT_SCOPE (the
        key lacks `gateway:use`), are a BLOCK whatever `fail_closed` says. A
        shadow-mode workspace's {allowed: true, degraded: true} is an
        allow.

        A `local_only` client makes no call and answers allow with code
        LOCAL_ONLY, whatever `fail_closed` says: with no key there is no
        control-plane tier to fail, only local ones, which have already run.
        """
        if self.local_only:
            return GateResponse(
                allowed=True, reached=False, code=LOCAL_ONLY,
                reason="hook-gate skipped — no API key, so this client is local-only: the "
                       "control-plane tiers (SOP register, hook gate) did not run; the policy "
                       "snapshot, SSO-group and image tiers did")
        try:
            d = self._post("/api/v1/hook-gate", {
                "toolName": tool_name,
                "toolInput": tool_input,
                "workspaceId": self.workspace_id,
                "sessionId": self.session_id,
                "harnessType": self.harness,
            }, self.timeout)
        except HttpStatusError as exc:
            if exc.status == 400:
                why = exc.body.get("reason")
                return GateResponse(
                    allowed=False,
                    reason=f"hook-gate rejected the request (INVALID_REQUEST): "
                           f"{why if isinstance(why, str) else exc}",
                    code="INVALID_REQUEST",
                )
            if exc.body.get("code") == INSUFFICIENT_SCOPE:
                return GateResponse(allowed=False, reason=_insufficient_scope_reason(exc.body),
                                    code=INSUFFICIENT_SCOPE)
            if exc.body.get("code") == GOVERNANCE_UNAVAILABLE:
                return self._no_verdict(f"governance check unavailable ({GOVERNANCE_UNAVAILABLE})",
                                        GOVERNANCE_UNAVAILABLE, exc.body.get("decisionId"))
            return self._no_verdict(f"unreachable ({type(exc).__name__})")
        except Exception as exc:
            return self._no_verdict(f"unreachable ({type(exc).__name__})")
        if d.get("allowed") is False and d.get("code") == GOVERNANCE_UNAVAILABLE:
            return self._no_verdict(f"governance check unavailable ({GOVERNANCE_UNAVAILABLE})",
                                    GOVERNANCE_UNAVAILABLE, d.get("decisionId"))
        if not isinstance(d.get("allowed"), bool):
            return self._no_verdict("answered without a verdict")
        return GateResponse(
            allowed=d["allowed"],
            reason=str(d.get("reason", "")),
            incident_id=d.get("incidentId"),
            code=d.get("code") if isinstance(d.get("code"), str) else None,
            decision_id=d.get("decisionId") if isinstance(d.get("decisionId"), str) else None,
        )

    def _no_verdict(self, what: str, code: Optional[str] = None,
                    decision_id: Any = None) -> GateResponse:
        """The answer when the hook gate gave no verdict: `fail_closed` decides.

        A GOVERNANCE_UNAVAILABLE refusal's `decision_id` is kept when failing
        closed, which refuses as the hook gate did, and dropped when failing
        open: the call then runs, and its report must not stand for the
        refusal.
        """
        if self.fail_closed:
            return GateResponse(allowed=False, reached=False, code=code,
                                decision_id=decision_id if isinstance(decision_id, str) else None,
                                reason=f"hook-gate {what} — failing closed (fail_closed=True)")
        return GateResponse(allowed=True, reached=False, code=code,
                            reason=f"hook-gate {what} — failing open (fail_closed=False)")

    # -------------------------------------------------------------- events

    def emit(self, event: str, tool_name: str, reason: str = "",
             tool_input: Optional[dict] = None, incident_id: Optional[str] = None,
             file_path: Optional[str] = None, gate_decision_id: Optional[str] = None) -> bool:
        """Fire-and-forget telemetry. Never raises.

        `gate_decision_id` is the hook gate's `decisionId` for the call this
        event reports: the control plane then files the decision's incident
        once and does not export it to SIEM a second time.

        A `tool_blocked` event creates a governance_incidents row whose
        description embeds our reason verbatim:

          [Hook Gate] Tool "shell" blocked by local SOP enforcement.
          Reason: <reason>  Harness: langgraph

        That string is what appears on the incidents dashboard.
        """
        if event not in VALID_EVENTS:
            return False
        ev: Dict[str, Any] = {
            "event": event,
            "toolName": tool_name,
            "reason": (reason or "")[:REASON_MAX],
            "workspaceId": self.workspace_id,
            "sessionId": self.session_id,
            "harnessType": self.harness,
            # No daemon reports an SDK gate, so the control plane expects one
            # from its own events: one that keeps reporting and stops is a
            # silent gate.
            "gateSource": "sdk",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            # The event's id, made once: if this post is ever repeated, the
            # control plane processes the event once.
            "eventId": uuid.uuid4().hex,
        }
        if tool_input is not None:
            ev["toolInput"] = tool_input
        if incident_id:
            ev["incidentId"] = incident_id
        if gate_decision_id:
            ev["gateDecisionId"] = gate_decision_id
        if file_path:
            ev["filePath"] = file_path[:512]
        try:
            self._post("/api/v1/hook-events", {"events": [ev]}, EVENT_TIMEOUT)
            return True
        except Exception:
            return False

    # --------------------------------------------------------------- judge

    def judge_finalize(self, full_content: str, monitored_model: str,
                       personal_sops: Optional[list] = None) -> dict:
        """Grade generated text against the workspace's active SOP.

        `POST /api/v1/judge/finalize`. Note that plain `/api/v1/judge` does NOT
        exist — it is a JWT-bypass prefix in PUBLIC_ROUTES, not a handler, and
        returns 404.

        The endpoint interpolates the active SOP's markdown verbatim into the
        judge's system prompt, which is what makes it usable as a general
        "does this text contradict this document" check. The SOP must be
        VALIDATED and active; only one is ever loaded (newest by updatedAt).

        Returns {verdict, triggered, personalTriggered, correctionSummary,
        independent}. `verdict` is 'PASS' | 'TRIGGERED' | 'REVIEW' from the
        control plane, or 'UNAVAILABLE' — set by the control plane on its own
        failures (it returns HTTP 503, which raises in _post and lands in the
        except below) and by this method on transport errors. Branch on
        `verdict`, and treat only 'PASS' as clean:

        - 'TRIGGERED': a violation was found.
        - 'REVIEW': the response was held for human review. The typed judge
          was unsure, or did not answer in time (the judge GPU was busy). No
          org verdict exists yet: `triggered` is False because nothing was
          decided, not because the response is clean. A fail-closed caller
          must treat REVIEW as not clean. The control plane records the
          interim verdict and the reviewer's ruling on its side.
        - 'UNAVAILABLE' (or any other value): NO grading happened.

        **This cannot block.** `lib/monitorModel.ts` is explicit: no LLM
        verdict blocks a request; the KILL sites in the proxy are
        deterministic. The caller must branch on the verdict itself.

        History worth keeping: the endpoint used to fail OPEN — every internal
        failure (LiteLLM down, 30s timeout, unparsable verdict) returned HTTP
        200 {triggered: false}, indistinguishable from a clean pass, and this
        client's except-branch only caught transport errors. The control plane
        now 503s with verdict:'UNAVAILABLE' on every failure mode, which routes
        them all through the except below — so a fail-closed caller finally
        covers what it always claimed to.
        """
        body: Dict[str, Any] = {
            "workspaceId": self.workspace_id,
            "sessionId": self.session_id,
            "fullContent": full_content,
            # Drives resolveMonitor(): when the monitor model equals the judged
            # model the incident is stamped [self-graded], because a model
            # grading its own output is weak evidence and the reviewer needs to
            # know which they are reading.
            "monitoredModel": monitored_model,
        }
        if personal_sops:
            body["personalSops"] = personal_sops
        try:
            res = self._post("/api/v1/judge/finalize", body, JUDGE_TIMEOUT)
            # An old control plane omits `verdict`; synthesize it so callers
            # can branch on one field regardless of server version.
            if "verdict" not in res:
                res["verdict"] = "TRIGGERED" if (
                    res.get("triggered") or res.get("personalTriggered")
                ) else "PASS"
            return res
        except Exception as exc:
            return {"verdict": "UNAVAILABLE", "triggered": False,
                    "correctionSummary": "",
                    "error": f"{type(exc).__name__}: {exc}"}

    # ----------------------------------------------------------- decisions

    def record_hold(self, hold: Dict[str, Any]) -> bool:
        """Record one hold in the review queue (`POST /api/v1/decisions`), the
        way the hook gates' records reach it. Never raises; False when the
        control plane did not accept it, so the refusal can say there is
        nothing to approve yet."""
        try:
            d = self._post("/api/v1/decisions", {"holds": [hold]}, self.timeout)
            return d.get("accepted") == 1
        except Exception:
            return False

    def approved_bypasses(self) -> Optional[list]:
        """The workspace's approved bypasses
        (`GET /api/v1/decisions/approved-bypasses`), or None when they cannot
        be read. Never raises: a hold that cannot be checked for an approval
        stays held."""
        try:
            d = self._get("/api/v1/decisions/approved-bypasses", self.timeout)
        except Exception:
            return None
        bypasses = d.get("bypasses")
        return bypasses if isinstance(bypasses, list) else None

    def session_plan(self, session_id: str):
        """The session's plan (`GET /api/v1/plans/session/:sessionId`) as Tier
        R reads it: (status, body), status None when the control plane could
        not be reached. A local-only client has no plans to read: 404. Never
        raises."""
        if self.local_only:
            return 404, None
        headers = {"Authorization": f"Bearer {self.api_key}", "X-Workspace-Id": self.workspace_id}
        try:
            return self.get_transport(
                self.base_url + "/api/v1/plans/session/" + urllib.parse.quote(session_id, safe=""), headers, self.timeout)
        except Exception:
            return None, None

    # ------------------------------------------------------------- factory

    @classmethod
    def from_env(cls, session_id: Optional[str] = None,
                 harness: str = "langgraph", fail_closed: bool = True) -> "GateClient":
        """Build a client from the environment, falling back to CLI credentials.

        Reading ~/.intutic/credentials.json means the gate works with whatever
        workspace `intutic login` already bound, instead of duplicating the key:
        its key, workspace and the control plane it logged in to. With no key in
        either place the client is `local_only`.
        """
        base = os.environ.get("INTUTIC_CONTROL_PLANE_URL", "")
        key = os.environ.get("INTUTIC_API_KEY", "")
        ws = os.environ.get("INTUTIC_WORKSPACE_ID", "")

        if not key or not ws or not base:
            cred_path = os.path.join(os.path.expanduser("~"), ".intutic", "credentials.json")
            try:
                with open(cred_path, encoding="utf-8") as fh:
                    c = json.load(fh)
                key = key or c.get("apiKey", "")
                ws = ws or c.get("workspaceId", "")
                base = base or c.get("controlPlaneUrl", "")
            except OSError:
                pass
            if key == KEYCHAIN_SENTINEL:
                # An unreadable keychain leaves the client local_only rather than
                # sending the marker as a credential.
                key = _keychain_token(ws)

        sess = session_id or os.environ.get("INTUTIC_SESSION_ID", "")
        if not sess:
            # The proxy defaults an unset x-session-id to the literal "unknown",
            # which collapses every run onto one dashboard row. Refuse instead.
            raise RuntimeError(
                "No session id. Set INTUTIC_SESSION_ID or pass session_id — an unset "
                "x-session-id becomes the literal 'unknown' in the proxy and merges "
                "every run into a single dashboard session."
            )
        return cls(base, key, ws, sess, harness=harness, fail_closed=fail_closed)
