"""HTTP client for the Intutic control plane's gate endpoints.

Endpoints used:

  POST /api/v1/hook-gate       synchronous allow/deny  -> {allowed, reason, incidentId?}
  POST /api/v1/hook-events     batched telemetry       -> creates governance_incidents rows
  POST /api/v1/judge/finalize  LLM judge verdict       -> {verdict, triggered, ...}
  POST /api/v1/decisions       review queue (advisory) -> renders on /decisions

Uses `requests`, like the rest of this package, through a small injectable
`transport` so tests can stub the wire without a server.

Two behaviours that must not be "improved":

  * The hook-gate SERVER fails OPEN on its own error paths — it returns
    {allowed:true} on malformed input, schema mismatch, or DB error, because
    blocking a developer over a bad payload teaches people to disable the
    hook. This CLIENT, by contrast, defaults to FAIL-CLOSED (`fail_closed=True`)
    for blocking decisions: a transport error or non-2xx response means we have
    no verdict at all to defer to, so `hook_gate` reports `allowed=False`. Set
    `fail_closed=False` to treat the tier as advisory, mirroring the server's
    own posture.
  * `emit` NEVER raises. Telemetry that can break a run is worse than no
    telemetry.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, Tuple

import requests

DEFAULT_TIMEOUT = 2.0
EVENT_TIMEOUT = 2.0
JUDGE_TIMEOUT = 120.0

# Mirrors HookEventSchema in services/control-plane/src/routes/hookEvents.ts:376.
VALID_EVENTS = {
    "tool_blocked", "tool_allowed", "tool_flagged", "tool_would_block",
    "config_tamper", "network_bypass", "guards_disabled",
    "snapshot_absent", "snapshot_stale", "snapshot_invalid", "snapshot_empty",
}

REASON_MAX = 512   # control plane truncates at 512; do it here so logs match

# transport(url, body, headers, timeout) -> (status_code, parsed_json_or_{})
Transport = Callable[[str, Dict[str, Any], Dict[str, str], float], Tuple[int, Dict[str, Any]]]


def _requests_transport(url: str, body: Dict[str, Any],
                        headers: Dict[str, str], timeout: float) -> Tuple[int, Dict[str, Any]]:
    res = requests.post(url, json=body, headers=headers, timeout=timeout)
    try:
        parsed = res.json() if res.text else {}
    except ValueError:
        parsed = {}
    return res.status_code, parsed


@dataclass
class GateResponse:
    allowed: bool
    reason: str = ""
    incident_id: Optional[str] = None
    reached: bool = True   # False when the call failed and fail_closed decided


class GateClient:
    """Control-plane client for the pre-execution gate.

    `harness` defaults to "langgraph" and is sent as `harnessType` on every
    gate call and event, so incidents attribute to the right adapter. Override
    it when wrapping a different framework.
    """

    def __init__(self, base_url: Optional[str] = None, api_key: str = "",
                 workspace_id: str = "", session_id: str = "",
                 harness: str = "langgraph", fail_closed: bool = True,
                 timeout: float = DEFAULT_TIMEOUT,
                 transport: Optional[Transport] = None):
        self.base_url = (base_url or os.environ.get("INTUTIC_CONTROL_PLANE_URL")
                         or "https://api.intutic.ai").rstrip("/")
        self.api_key = api_key
        self.workspace_id = workspace_id
        self.session_id = session_id
        self.harness = harness
        self.fail_closed = fail_closed
        self.timeout = timeout
        self.transport = transport or _requests_transport

    def _post(self, path: str, body: Dict[str, Any], timeout: float) -> Dict[str, Any]:
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "X-Workspace-Id": self.workspace_id,
        }
        status, parsed = self.transport(self.base_url + path, body, headers, timeout)
        if not 200 <= status < 300:
            raise requests.HTTPError(f"HTTP {status} from {path}")
        return parsed

    # ---------------------------------------------------------------- gate

    def hook_gate(self, tool_name: str, tool_input: dict) -> GateResponse:
        """Synchronous allow/deny for one tool call.

        Worth being precise about: the endpoint matches ~19 DLP regexes
        against the serialised toolInput, plus SOP rules. It is defence in
        depth on top of the local tiers, not a replacement for them.

        When the call itself fails (transport error, non-2xx), the verdict is
        decided by `fail_closed`: True (the default) reports BLOCK, because a
        client with no verdict has nothing to defer to; False reports allow,
        mirroring the server's own fail-open error paths.
        """
        try:
            d = self._post("/api/v1/hook-gate", {
                "toolName": tool_name,
                "toolInput": tool_input,
                "workspaceId": self.workspace_id,
                "sessionId": self.session_id,
                "harnessType": self.harness,
            }, self.timeout)
            return GateResponse(
                allowed=bool(d.get("allowed", True)),
                reason=str(d.get("reason", "")),
                incident_id=d.get("incidentId"),
            )
        except Exception as exc:
            if self.fail_closed:
                return GateResponse(
                    allowed=False,
                    reason=f"hook-gate unreachable ({type(exc).__name__}) — "
                           f"failing closed (fail_closed=True)",
                    reached=False,
                )
            return GateResponse(
                allowed=True,
                reason=f"hook-gate unreachable ({type(exc).__name__}) — "
                       f"failing open (fail_closed=False)",
                reached=False,
            )

    # -------------------------------------------------------------- events

    def emit(self, event: str, tool_name: str, reason: str = "",
             tool_input: Optional[dict] = None, incident_id: Optional[str] = None,
             file_path: Optional[str] = None) -> bool:
        """Fire-and-forget telemetry. Never raises.

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
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        if tool_input is not None:
            ev["toolInput"] = tool_input
        if incident_id:
            ev["incidentId"] = incident_id
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
        independent}. `verdict` is 'PASS' | 'TRIGGERED' from the control plane,
        or 'UNAVAILABLE' — set by the control plane on its own failures (it
        returns HTTP 503, which raises in _post and lands in the except below)
        and by this method on transport errors. Branch on `verdict`: anything
        other than 'PASS'/'TRIGGERED' means NO grading happened.

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

    def hold_for_review(self, hold_id: str, tool_name: str, reason: str) -> bool:
        """Add an entry to the Review Queue at /decisions.

        Observe-only: routes/decisions.ts is explicit that this blocks nothing.
        It is a display surface for a block that already happened elsewhere.
        `reason` is the one free-form field (1-512 chars) we control.
        """
        try:
            self._post("/api/v1/decisions", {"holds": [{
                "v": 1,
                "holdId": hold_id,
                "tool": tool_name,
                "reason": (reason or "")[:REASON_MAX],
                "sessionId": self.session_id,
                "workspaceId": self.workspace_id,
                "at": datetime.now(timezone.utc).isoformat(),
            }]}, self.timeout)
            return True
        except Exception:
            return False

    # ------------------------------------------------------------- factory

    @classmethod
    def from_env(cls, session_id: Optional[str] = None,
                 harness: str = "langgraph", fail_closed: bool = True) -> "GateClient":
        """Build a client from the environment, falling back to CLI credentials.

        Reading ~/.intutic/credentials.json means the gate works with whatever
        workspace `intutic login` already bound, instead of duplicating the key.
        """
        base = os.environ.get("INTUTIC_CONTROL_PLANE_URL", "https://api.intutic.ai")
        key = os.environ.get("INTUTIC_API_KEY", "")
        ws = os.environ.get("INTUTIC_WORKSPACE_ID", "")

        if not key or not ws:
            cred_path = os.path.join(os.path.expanduser("~"), ".intutic", "credentials.json")
            try:
                with open(cred_path, encoding="utf-8") as fh:
                    c = json.load(fh)
                key = key or c.get("apiKey", "")
                ws = ws or c.get("workspaceId", "")
            except OSError:
                pass

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
