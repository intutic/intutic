"""The enforcement point.

Intutic ships PreToolUse hooks for 18 harnesses; frameworks outside that list
(LangGraph, CrewAI, AutoGen, hand-rolled loops) have no adapter, and the
sync-daemon writes no PreToolUse hook for them. The proxy's response gate
(plugins/response_gate.rs, default-on) can withhold a model-emitted
tool_calls[] before the client's tool runner sees it — but that gate enforces
at tool-NAME level on what crosses the proxy; an ARGUMENT-level rule like
"kubectl apply only with a pinned digest" still has no enforcement point in
stock Intutic before the call runs locally.

This module is that enforcement point: the missing adapter, written against
Intutic's own published gate contract.

Four tiers, in order:

  A1  policy snapshot   port of intuticGate()          fails CLOSED
  A3  SOP rules         authored in the product        fails OPEN (A2 covers it)
  A2  image integrity   local check                    fails CLOSED
  B   POST /hook-gate   control-plane check            fail posture set by GateClient

A1 and A2 are load-bearing and local. Tier B contributes the DLP regexes and
workspace policy from the control plane; whether an unreachable control plane
blocks is the client's `fail_closed` setting (default True — see client.py;
the demo that fathered this code ran it advisory/fail-open).

Tier A3 applies rules written in the SOP register rather than in code —
possible since intutic-enterprise#14 taught SOP titles a ` WHERE ` clause, so
a rule can finally say "kubectl apply without a digest" instead of only "any
shell call". It runs BEFORE A2 so that a block, when both would fire, is
attributed to the authored policy rather than to the hardcoded one. It fails
open because A2 covers the identical case and fails closed: A3 moves where the
policy is *written*, and is not what makes the run safe. See soprules.py.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Optional

from ..errors import ClawdeError
from . import imagecheck, snapshot, soprules
from .actions import is_deploy, touches_infra
from .client import GateClient


# Tools that cannot change anything. They still get the local snapshot check
# (Tier A), but skip the remote gate call (Tier B) — see Gate.guard().
READ_ONLY_TOOLS = frozenset({"read_file", "list_files", "read", "cat", "view"})


class IntuticGateRefusal(ClawdeError):
    """Raised when a tool call must not run.

    The python-raise contract: the exception's message begins
    `[Intutic Governance] BLOCKED:` — the same family the Open WebUI filter
    raises — so harnesses and log scrapers that already recognise that prefix
    recognise this refusal too. The structured fields (`reason`, `code`,
    `incident_id`) carry the machine-readable version.
    """

    def __init__(self, reason: str, code: str, incident_id: Optional[str] = None):
        super().__init__(f"[Intutic Governance] BLOCKED: {reason}")
        self.reason = reason
        self.code = code
        self.incident_id = incident_id


@dataclass
class GateConfig:
    repo_root: str = "."
    workspace_id: str = ""
    allowlist_path: str = ".intutic/image-allowlist.json"
    enforce: bool = True
    use_hook_gate: bool = True
    use_sop_rules: bool = True

    def allowlist_abs(self) -> str:
        p = self.allowlist_path
        return p if os.path.isabs(p) else os.path.join(self.repo_root, p)


class Gate:
    def __init__(self, cfg: GateConfig, client: Optional[GateClient] = None):
        self.cfg = cfg
        self.client = client
        self._snapshot: Optional[snapshot.Snapshot] = None
        self._snapshot_reported = False
        self._policy: Optional[dict] = None
        # None = not fetched yet. A failed fetch caches [] so one unreachable
        # control plane does not add a 3s timeout to every subsequent tool call.
        self._sop_rules: Optional[list] = None

    # ------------------------------------------------------------ loading

    def snapshot(self) -> snapshot.Snapshot:
        if self._snapshot is None:
            self._snapshot = snapshot.load_snapshot(self.cfg.workspace_id)
        return self._snapshot

    def policy(self) -> dict:
        """Load the image allowlist.

        A missing or malformed allowlist is NOT treated as "allow everything".
        An empty policy with require_digest still refuses every unpinned image,
        which is the safe direction; a policy we cannot read at all raises, and
        the caller turns that into a block.
        """
        if self._policy is None:
            path = self.cfg.allowlist_abs()
            try:
                with open(path, encoding="utf-8") as fh:
                    self._policy = json.load(fh)
            except FileNotFoundError:
                raise IntuticGateRefusal(
                    f"[image-integrity] {imagecheck.E_MANIFEST_UNPARSEABLE}: "
                    f"image allowlist not found at {path}; refusing to approve an "
                    f"image against a policy that does not exist",
                    imagecheck.E_MANIFEST_UNPARSEABLE)
            except (ValueError, OSError) as exc:
                raise IntuticGateRefusal(
                    f"[image-integrity] {imagecheck.E_MANIFEST_UNPARSEABLE}: "
                    f"image allowlist at {path} is unreadable ({type(exc).__name__})",
                    imagecheck.E_MANIFEST_UNPARSEABLE)
        return self._policy

    def sop_rules(self) -> list:
        """Active SOP rules, fetched once per process.

        Deliberately not refreshed on a timer the way `policy.ts` does: a rule
        set that changes mid-run makes a verdict depend on when the fetch
        landed. Construct a new Gate (or clear `_sop_rules`) to refresh.
        """
        if self._sop_rules is None:
            fetched = None
            if self.client is not None:
                fetched = soprules.fetch_rules(
                    self.client.base_url, self.client.api_key, self.cfg.workspace_id)
            if fetched is None:
                # Could not read the register. Say so once, then stay quiet —
                # Tier A2 still fails closed on the same condition.
                self._emit("tool_flagged", "sop_rules",
                           "SOP rule register unreachable; SOP-rule tier inactive for "
                           "this run (image-integrity check unaffected)")
                fetched = []
            self._sop_rules = fetched
        return self._sop_rules

    # ------------------------------------------------------------ emitting

    def _emit(self, event: str, tool: str, reason: str = "",
              tool_input: Optional[dict] = None, incident_id: Optional[str] = None,
              file_path: Optional[str] = None) -> None:
        if self.client is not None:
            self.client.emit(event, tool, reason, tool_input, incident_id, file_path)

    def _report_snapshot_health_once(self, tool: str) -> None:
        """Report snapshot condition exactly once per process.

        The upstream comment is the justification: these states were computed
        and never read, so an operator could not distinguish "snapshot missing
        on 400 machines" from "snapshot healthy".
        """
        if self._snapshot_reported:
            return
        self._snapshot_reported = True
        snap = self.snapshot()
        if snap.state != "ok":
            self._emit(f"snapshot_{snap.state}", tool, snap.health_message)

    # --------------------------------------------------------------- guard

    def guard(self, tool_name: str, tool_input: dict) -> None:
        """Raise IntuticGateRefusal if this call must not run. Return to allow."""
        if not self.cfg.enforce:
            return

        target = tool_input.get("path") or tool_input.get("file_path") or ""
        command = tool_input.get("command") or ""

        self._report_snapshot_health_once(tool_name)

        # ---- Tier A1: policy snapshot -------------------------------------
        disabled = snapshot.guard_disabled_from_env()
        if disabled:
            self._emit("guards_disabled", tool_name,
                       "INTUTIC_GUARD_DISABLE=1 — policy-snapshot rules skipped; "
                       "built-in protections still active")

        d = snapshot.evaluate(tool_name, target, command, self.snapshot(), disabled)
        if d.severity == snapshot.SEV_BLOCK:
            self._emit("tool_blocked", tool_name, d.reason, tool_input)
            raise IntuticGateRefusal(d.reason, "SNAPSHOT")
        if d.severity == snapshot.SEV_WARN:
            self._emit("tool_flagged", tool_name, d.reason, tool_input)
        elif d.severity == snapshot.SEV_SHADOW:
            self._emit("tool_would_block", tool_name, d.reason, tool_input)

        # ---- Tier A3: SOP rules authored in the product --------------------
        #
        # Runs before A2 on purpose. When both would fire, the block should be
        # attributed to the policy someone wrote in the register, not to the
        # one we hardcoded — that is the whole point of the tier.
        if self.cfg.use_sop_rules and tool_name not in READ_ONLY_TOOLS:
            rule = soprules.first_match(self.sop_rules(), tool_name, tool_input)
            if rule is not None:
                reason = f"[sop:{rule.id}] {rule.reason}"
                if rule.action == soprules.ACTION_BLOCK:
                    self._emit("tool_blocked", tool_name, reason, tool_input)
                    raise IntuticGateRefusal(reason, "SOP_RULE")
                if rule.action == soprules.ACTION_APPROVAL:
                    # No human is at the keyboard during an agent run, so an
                    # approval that cannot be granted is a block. Treating it
                    # as a warning would let the call through precisely when
                    # someone asked to be consulted.
                    self._emit("tool_blocked", tool_name,
                               f"{reason} (approval required; no reviewer in an "
                               f"unattended run)", tool_input)
                    raise IntuticGateRefusal(reason, "SOP_RULE_APPROVAL")
                self._emit("tool_flagged", tool_name, reason, tool_input)

        # ---- Tier A2: image integrity -------------------------------------
        # Nothing else in Intutic does this. See imagecheck.py.
        if is_deploy(tool_name, tool_input):
            verdict = imagecheck.check_command(command, self.cfg.repo_root, self.policy())
            if not verdict.ok:
                reason = f"{verdict.reason} — policy {self.cfg.allowlist_path}"
                self._emit("tool_blocked", tool_name, reason, tool_input)
                raise IntuticGateRefusal(reason, verdict.code)

        # A write to infrastructure gets the same check one turn earlier, as a
        # flag rather than a block: the dashboard then shows the bad manifest
        # being authored before it is applied. Blocking the write would be
        # defensible too, but flagging preserves the authoring trail — the
        # agent writing something wrong, then being stopped at the moment it
        # matters.
        if target and touches_infra(target) and "content" in tool_input:
            v = imagecheck.check_written_manifest(target, tool_input["content"], self.policy())
            if not v.ok:
                self._emit("tool_flagged", tool_name,
                           f"{v.reason} (authoring-time check; the apply will be refused)",
                           tool_input, file_path=target)

        # ---- Tier B: control plane gate -----------------------------------
        #
        # Skipped for read-only tools. Tier B is a network round trip whose
        # checks are DLP regexes over the arguments and SOP rules — neither of
        # which can say anything useful about a directory listing. Calling it
        # anyway costs a round trip per read and fills the incidents feed with
        # `tool_allowed` noise, which buries the events that matter.
        #
        # Tier A still runs for reads: a snapshot rule legitimately blocks
        # reading a credential path, and that check is local and free.
        #
        # Whether an unreachable control plane blocks here is the client's
        # fail_closed setting (default True); see client.hook_gate.
        if self.cfg.use_hook_gate and self.client is not None and tool_name not in READ_ONLY_TOOLS:
            resp = self.client.hook_gate(tool_name, tool_input)
            if not resp.allowed:
                self._emit("tool_blocked", tool_name, resp.reason, tool_input, resp.incident_id)
                raise IntuticGateRefusal(resp.reason, "HOOK_GATE", resp.incident_id)

        if tool_name not in READ_ONLY_TOOLS:
            self._emit("tool_allowed", tool_name, "", tool_input)


# Module-level active gate, so decorated tools do not need the instance
# threaded through every call site.
_ACTIVE: Optional[Gate] = None


def install(gate: Gate) -> None:
    global _ACTIVE
    _ACTIVE = gate


def active() -> Optional[Gate]:
    return _ACTIVE
