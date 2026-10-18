"""The enforcement point.

Intutic ships PreToolUse hooks for the harnesses in the sync-daemon's gate
registry (packages/shared-types/src/gateKind.ts); frameworks outside that list
(LangGraph, CrewAI, AutoGen, hand-rolled loops) have no adapter, and the
sync-daemon writes no PreToolUse hook for them. The proxy's response gate
(plugins/response_gate.rs, default-on) can withhold a model-emitted
tool_calls[] before the client's tool runner sees it — but that gate enforces
at tool-NAME level on what crosses the proxy; an ARGUMENT-level rule like
"kubectl apply only with a pinned digest" still has no enforcement point in
stock Intutic before the call runs locally.

This module is that enforcement point: the missing adapter, written against
Intutic's own published gate contract.

Six tiers, in order:

  A0  SSO group policy  from the policy snapshot       unknown groups refused
  A1  policy snapshot   port of intuticGate()          fails CLOSED
  M   MCP registry      from the policy snapshot       unverified snapshot admits none
  A3  SOP rules         authored in the product        fails OPEN (A2 covers it)
  A2  image integrity   local check                    fails CLOSED
  B   POST /hook-gate   control-plane check            fail posture set by GateClient

Tier M applies the workspace's MCP server registry and mcpAllowedServers list
to an mcp__<server>__<tool> call, from the snapshot's @mcp_registry and
@mcp_allowlist records, with the decision, codes, rule ids and reasons the hook
gates and the MCP proxy use (mcp_registry.py). On a snapshot that fails its
integrity check, Tier M refuses every MCP call with POLICY_SNAPSHOT_UNVERIFIED,
observe-only or not: a deleted or edited record cannot be told from the
workspace's own. A refusal of an unapproved
server reaches the control plane as a tool_blocked event whose reason ends
[mcpDefaultPolicy], which puts the server in the approval queue, as a hook
gate's refusal does.

A1 and A2 are load-bearing and local. Tier B contributes the DLP regexes and
workspace policy from the control plane; whether an unreachable control plane,
or one whose checks could not run (GOVERNANCE_UNAVAILABLE), blocks is the
client's `fail_closed` setting (default True — see client.py; the demo that
fathered this code ran it advisory/fail-open). A client with no API key is
local-only (`GateClient.local_only`): A3 and B are skipped and the hook-gate
answer says so (code LOCAL_ONLY), while A0, A1, M and A2 run.

Tier A3 applies rules written in the SOP register rather than in code —
possible since intutic-enterprise#14 taught SOP titles a ` WHERE ` clause, so
a rule can finally say "kubectl apply without a digest" instead of only "any
shell call". It runs BEFORE A2 so that a block, when both would fire, is
attributed to the authored policy rather than to the hardcoded one. It fails
open because A2 covers the identical case and fails closed: A3 moves where the
policy is *written*, and is not what makes the run safe. See soprules.py.

A hold rule in A1 or A3 (a REQUIRE_APPROVAL: SOP, or a local review_before:
token) raises IntuticGateHold after recording the hold for review, unless an
approved bypass lets this exact call through — the hook gates' and the MCP
proxy's mechanism, through the same decisions API. See hold.py.

Under a chaos run (intutic chaos run, which sets INTUTIC_CHAOS_PLAN and
INTUTIC_CHAOS_EVENTS), Gate.guard reports each call to the run's events file
and injects the plan's tool.error and permission.deny_or_delay faults into a
call every tier allowed, exactly as the hook gates do: the same decoding and
counter files (chaos.py, which the bash gates emit verbatim). A fault raises
IntuticGateRefusal with code CHAOS_FAULT; a held call raises IntuticGateHold
with no hold_id, until its identical retry is let through or denied.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import os
from dataclasses import dataclass
from typing import Optional

from ..errors import ClawdeError
from . import chaos, decide_record, imagecheck, mcp_registry, snapshot, soprules, sso_groups
from .actions import is_deploy, touches_infra
from .client import INSUFFICIENT_SCOPE, GateClient
from .hold import hold_key, hold_message, request_hold
from .limits import too_large_reason
from .opaque import OPAQUE_REFUSAL_MESSAGE


# Tools that cannot change anything. They still get the local snapshot check
# (Tier A), but skip the remote gate call (Tier B) — see Gate.guard().
READ_ONLY_TOOLS = frozenset({"read_file", "list_files", "read", "cat", "view"})


# Whether this gate evaluates the decide rules a snapshot carries. Until it
# does, a decide rule's fallback line refuses its tools, as in a gate that
# reads no @decide records, so no decide rule goes unenforced. Set only where
# the decide tier runs.
CAN_EVALUATE_DECIDE = False


#: Every `code` an IntuticGateRefusal can carry: the tier that refused, or for
#: the image-integrity tier the specific failure. Held to
#: packages/shared-types/fixtures/refusal-codes.json (`gate`) by a test, as the
#: TypeScript gate's list and the gate SDK reference are.
GATE_REFUSAL_CODES = (
    "SSO_GROUP",
    "SNAPSHOT",
    "HELD",
    # The MCP server registry and allowlist, from the policy snapshot or the
    # control plane's hook gate.
    "SERVER_BLOCKED",
    "SERVER_HELD",
    "SERVER_NOT_APPROVED",
    "TOOL_DISABLED",
    "SERVER_NOT_ALLOWED",
    # Any MCP call on a policy snapshot that failed its integrity check.
    "POLICY_SNAPSHOT_UNVERIFIED",
    "SOP_RULE",
    "HOOK_GATE",
    # The API key lacks the scope the hook gate needs (client.py).
    INSUFFICIENT_SCOPE,
    # The call is too large to evaluate (limits.py), before any tier runs.
    "COMMAND_TOO_LARGE",
    # A chaos run's fault, injected after every tier allowed the call, or its
    # unreadable plan (chaos.py). Never a governance decision.
    "CHAOS_FAULT",
    imagecheck.E_UNPINNED_LATEST,
    imagecheck.E_UNPINNED_TAG,
    imagecheck.E_UNKNOWN_REGISTRY,
    imagecheck.E_UNKNOWN_IMAGE,
    imagecheck.E_DIGEST_MISMATCH,
    imagecheck.E_MANIFEST_UNPARSEABLE,
    # A decide rule (the Decide tier, after every deterministic tier allowed
    # the call): refused, escalated with no way to ask, or its engine unavailable.
    "DECIDE_REFUSED",
    "DECIDE_ESCALATED",
    "GOVERNANCE_UNAVAILABLE",
)


class IntuticGateRefusal(ClawdeError):
    """Raised when a tool call must not run.

    The python-raise contract: the exception's message begins
    `[Intutic Governance] BLOCKED:` — the same family the Open WebUI filter
    raises — so harnesses and log scrapers that already recognise that prefix
    recognise this refusal too. The structured fields (`reason`, `code`, one
    of GATE_REFUSAL_CODES, and `incident_id`) carry the machine-readable
    version.
    """

    def __init__(self, reason: str, code: str, incident_id: Optional[str] = None):
        super().__init__(f"[Intutic Governance] BLOCKED: {reason}")
        self.reason = reason
        self.code = code
        self.incident_id = incident_id


class IntuticGateHold(IntuticGateRefusal):
    """Raised when a hold rule stopped the call to ask a person first (`code`
    HELD). A subclass, so a caller that stops on every refusal stops on this
    too; one that tells the user about holds catches it first.

    `hold_id` names the hold in the review queue, and is None when the hold
    could not be recorded (no control plane to record it in), in which case
    there is nothing to approve yet. The message starts
    `[Intutic Governance] HELD:`, as the hook gates print a hold, and says who
    can approve it and when a retry passes. See hold.py.
    """

    def __init__(self, reason: str, hold_id: Optional[str]):
        super().__init__(reason, "HELD")
        self.args = (f"[Intutic Governance] HELD: {reason}",)
        self.hold_id = hold_id


@dataclass
class GateConfig:
    """How a `Gate` evaluates calls. Every field has a default."""

    repo_root: str = "."
    """Where relative manifest and allowlist paths resolve from."""
    workspace_id: str = ""
    """Compared with the workspace the policy snapshot was compiled for, and
    scopes the SOP-rule fetch."""
    allowlist_path: str = ".intutic/image-allowlist.json"
    """The image allowlist, relative to `repo_root` unless absolute."""
    enforce: bool = True
    """False turns `Gate.guard()` into a no-op."""
    use_hook_gate: bool = True
    """Call the control plane's hook gate (needs a client)."""
    use_sop_rules: bool = True
    """Fetch and apply the workspace's SOP rules (needs a client)."""

    def allowlist_abs(self) -> str:
        p = self.allowlist_path
        return p if os.path.isabs(p) else os.path.join(self.repo_root, p)


class Gate:
    """The pre-execution gate. `guard()` evaluates one tool call against the
    local tiers (SSO group policy, policy snapshot, MCP servers, image
    integrity) and, with a `GateClient`, the control-plane tiers (SOP rules,
    hook gate), and raises `IntuticGateRefusal` to refuse it. Without a
    client only the local tiers run.
    """

    def __init__(self, cfg: GateConfig, client: Optional[GateClient] = None):
        self.cfg = cfg
        self.client = client
        self._snapshot: Optional[snapshot.Snapshot] = None
        self._snapshot_reported = False
        self._policy: Optional[dict] = None
        # None = not fetched yet. A failed fetch caches [] so one unreachable
        # control plane does not add a 3s timeout to every subsequent tool call.
        self._sop_rules: Optional[list] = None
        # The SOP register said the workspace is OPAQUE (read with its rules).
        self._register_opaque = False
        # A chaos run's plan, events path and why the plan cannot be used: read
        # from the environment on the first call.
        self._chaos: Optional[tuple] = None

    # ------------------------------------------------------------ loading

    def snapshot(self) -> snapshot.Snapshot:
        if self._snapshot is None:
            self._snapshot = snapshot.load_snapshot(self.cfg.workspace_id, evaluates_decide=CAN_EVALUATE_DECIDE)
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
        if self._sop_rules is None and self.client is not None and self.client.local_only:
            # No key: the register cannot be read, and saying so is not news.
            self._sop_rules = []
        if self._sop_rules is None:
            fetched = None
            if self.client is not None:
                register = soprules.fetch_register(
                    self.client.base_url, self.client.api_key, self.cfg.workspace_id)
                if register is not None:
                    fetched = register.rules
                    self._register_opaque = register.opaque
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
              file_path: Optional[str] = None, gate_decision_id: Optional[str] = None) -> None:
        if self.client is not None:
            # Passed only when there is one, so a client subclass whose emit
            # predates the parameter keeps working.
            extra = {"gate_decision_id": gate_decision_id} if gate_decision_id else {}
            self.client.emit(event, tool, reason, tool_input, incident_id, file_path, **extra)

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
        if snap.format_version > decide_record.SNAPSHOT_FORMAT:
            self._emit(
                "snapshot_format_newer",
                tool,
                f"Policy snapshot format {snap.format_version} is newer than this gate reads "
                f"({decide_record.SNAPSHOT_FORMAT}) — records it does not know are skipped and their "
                "fallback lines enforced",
            )

    def _chaos_state(self) -> tuple:
        """A chaos run's (plan, events, error), from INTUTIC_CHAOS_PLAN and
        INTUTIC_CHAOS_EVENTS, read once."""
        if self._chaos is None:
            raw = os.environ.get("INTUTIC_CHAOS_PLAN", "")
            events = os.environ.get("INTUTIC_CHAOS_EVENTS", "")
            plan, error = None, None
            if raw:
                plan, error = chaos.chaos_decode(raw)
                if error is None and not events:
                    plan, error = None, ("INTUTIC_CHAOS_PLAN is set but INTUTIC_CHAOS_EVENTS is not, "
                                         "so nothing the run does could be reported")
            self._chaos = (plan, events, error)
        return self._chaos

    # --------------------------------------------------------------- guard

    def _shown(self, reason: str) -> str:
        """What the agent is told of a refusal on workspace policy: the reason,
        or in an OPAQUE workspace (the snapshot's @intervention_mode record)
        the generic sentence, so it cannot learn the rule to route around it.
        The code is unchanged, and the event always carries the full reason."""
        return OPAQUE_REFUSAL_MESSAGE if self._opaque() else reason

    def _opaque(self) -> bool:
        """Whether the workspace is OPAQUE: the policy snapshot's record when
        there is a snapshot, the SOP register's interventionMode when there is
        none. Without a snapshot the only tiers that refuse on workspace policy
        are the register's (A3, which reads the mode with its rules) and the
        hook gate, which applies the mode itself."""
        snap = self.snapshot()
        return snap.opaque or (snap.state == "absent" and self._register_opaque)

    def guard(self, tool_name: str, tool_input: dict) -> None:
        """Raise IntuticGateRefusal if this call must not run. Return to allow.

        Under a chaos run's plan, the call is reported to the run's events file
        whatever the tiers decide, and a call they allowed can still be refused
        by the fault that is due (CHAOS_FAULT, or IntuticGateHold for a held
        one). A plan that is set but unreadable refuses every call: an
        experiment run without the faults it asked for reports a resilience it
        never measured.
        """
        if not self.cfg.enforce:
            return
        plan, events, error = self._chaos_state()
        if error is not None:
            reason = (error + " — refusing the call rather than running the experiment "
                      "without the faults it asked for")
            self._emit("tool_blocked", tool_name, reason)
            raise IntuticGateRefusal(reason, "CHAOS_FAULT")
        if plan is None:
            self._decide(tool_name, tool_input, None)
            return

        note = {"ruleId": None, "destructive": False, "policyHit": False}

        def report(decision: str, policy_hit: bool, key: str = ""):
            return chaos.chaos_call(plan, events, {
                "tool": tool_name, "decision": decision, "ruleId": note["ruleId"],
                "destructive": note["destructive"], "policyHit": policy_hit or note["policyHit"], "key": key,
            }, chaos.chaos_now())

        try:
            self._decide(tool_name, tool_input, note)
        except IntuticGateRefusal as exc:
            # A refusal a tier decided is a policy hit; a call too large to read is not.
            report("hold" if isinstance(exc, IntuticGateHold) else "deny", exc.code != "COMMAND_TOO_LARGE")
            raise
        except BaseException:
            report("deny", False)
            raise
        tool_name_normalized, target_hash = hold_key(tool_name, tool_input)
        fault = report("allow", False, hashlib.sha256(
            (tool_name_normalized + "\0" + target_hash).encode("utf-8")).hexdigest())
        if fault is None:
            return
        if fault["kind"] == "hold":
            raise IntuticGateHold(fault["reason"], None)
        raise IntuticGateRefusal(fault["reason"], "CHAOS_FAULT")

    def _decide(self, tool_name: str, tool_input: dict, note: Optional[dict]) -> None:
        """The tiers: raises to refuse, returns to allow. note collects a chaos
        run's record of the call: the rule that fired, whether a destructive
        rule fires, and whether an approved bypass let a hold through."""
        target = tool_input.get("path") or tool_input.get("file_path") or ""
        command = tool_input.get("command") or ""

        # ---- Size: refused before any tier reads the call ------------------
        # Every built-in rule is linear, but a workspace's own WHERE patterns
        # need not be, and the bound keeps a crafted call from holding the
        # agent. See limits.py.
        too_large = too_large_reason(str(command), tool_input)
        if too_large is not None:
            self._emit("tool_blocked", tool_name, too_large)
            raise IntuticGateRefusal(too_large, "COMMAND_TOO_LARGE")

        self._report_snapshot_health_once(tool_name)

        # ---- Tier A0: SSO group policy, from the snapshot ------------------
        # The workspace's group policy decided for the member the snapshot was
        # issued to — the same evaluator, and so the same answer, as the
        # control plane's hook gate. Not skippable by INTUTIC_GUARD_DISABLE: it
        # is the workspace's own policy, not the destructive family.
        record = self.snapshot().sso_groups
        if record is not None:
            d = sso_groups.evaluate(record.policy, tool_name, record.member_groups)
            if d.clearance != sso_groups.GRANTED:
                if note is not None:
                    note["ruleId"] = d.rule_id
                reason = f"{d.reason} [{d.rule_id}]"
                self._emit("tool_blocked", tool_name, reason, tool_input)
                raise IntuticGateRefusal(self._shown(reason), "SSO_GROUP")

        # ---- Tier A1: policy snapshot -------------------------------------
        disabled = snapshot.guard_disabled_from_env()
        if disabled:
            self._emit("guards_disabled", tool_name,
                       "INTUTIC_GUARD_DISABLE=1 — policy-snapshot rules skipped; "
                       "built-in protections still active")

        # Hold rules an approved bypass let through on this call, so the
        # register's copy of the same rule in Tier A3 does not hold it again.
        approved: set[str] = set()
        d = snapshot.evaluate(tool_name, target, command, self.snapshot(), disabled)
        if note is not None:
            if d.rule_id:
                note["ruleId"] = d.rule_id
            # Destructive whether or not a rule decided the call, the escape
            # hatch included: what a chaos run's no_destructive_attempt reads.
            destructive = dataclasses.replace(
                self.snapshot(), rules=[r for r in self.snapshot().rules if r.id.startswith("destructive.")])
            note["destructive"] = snapshot.evaluate(tool_name, target, command, destructive, False).severity is not None
        # As the rendered gates: every shadow or warn match is recorded, and an
        # approved hold lets evaluation continue, so a later block still refuses.
        while True:
            for a in d.advisories:
                self._emit("tool_flagged" if a.severity == snapshot.SEV_WARN else "tool_would_block",
                           tool_name, a.reason, tool_input)
            if d.severity == snapshot.SEV_BLOCK:
                self._emit("tool_blocked", tool_name, d.reason, tool_input)
                raise IntuticGateRefusal(self._shown(d.reason), "SNAPSHOT")
            if d.severity != snapshot.SEV_HOLD:
                break
            self._hold(d.rule_id, d.reason, tool_name, tool_input)
            approved.add(d.rule_id)
            if note is not None:
                note["policyHit"] = True
            d = snapshot.evaluate(tool_name, target, command, self.snapshot(), disabled, d.next)

        # ---- Tier M: the MCP server registry and allowlist ----------------
        self._guard_mcp(tool_name, tool_input, note)

        # ---- Tier A3: SOP rules authored in the product --------------------
        #
        # Runs before A2 on purpose. When both would fire, the block should be
        # attributed to the policy someone wrote in the register, not to the
        # one we hardcoded — that is the whole point of the tier.
        if self.cfg.use_sop_rules and tool_name not in READ_ONLY_TOOLS:
            rule = soprules.first_match(self.sop_rules(), tool_name, tool_input)
            if rule is not None:
                # The deciding rule's id, or the first that fired when none decides.
                if note is not None and (rule.action != soprules.ACTION_WARN or not note["ruleId"]):
                    note["ruleId"] = f"sop.{rule.id}"
                reason = f"[sop:{rule.id}] {rule.reason}"
                if rule.action == soprules.ACTION_BLOCK:
                    self._emit("tool_blocked", tool_name, reason, tool_input)
                    raise IntuticGateRefusal(self._shown(reason), "SOP_RULE")
                if rule.action == soprules.ACTION_APPROVAL:
                    # Held for a person, under the id the snapshot gives the
                    # same rule (sop.<id>), so one approval covers the call in
                    # either tier.
                    hold_rule_id = f"sop.{rule.id}"
                    if hold_rule_id not in approved:
                        self._hold(hold_rule_id, rule.reason, tool_name, tool_input)
                    if note is not None:
                        note["policyHit"] = True
                else:
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
        # Whether an unreachable control plane, or one whose checks could not
        # run (GOVERNANCE_UNAVAILABLE), blocks here is the client's
        # fail_closed setting (default True); see client.hook_gate.
        decision_id: Optional[str] = None
        if self.cfg.use_hook_gate and self.client is not None and tool_name not in READ_ONLY_TOOLS:
            resp = self.client.hook_gate(tool_name, tool_input)
            # Every answer is reported: the event drives the incident, rule
            # evidence and plan tracking. It carries the hook gate's decision
            # id, which the control plane exported to SIEM itself and filed its
            # DLP refusal's incident under, so neither happens twice.
            decision_id = resp.decision_id
            if not resp.allowed:
                self._emit("tool_blocked", tool_name, resp.reason, tool_input, gate_decision_id=resp.decision_id)
                # The hook gate names the MCP registry's own code when the
                # registry refused, and INSUFFICIENT_SCOPE when the key lacks
                # its scope; anything else it refuses is HOOK_GATE.
                code = resp.code if resp.code in MCP_CODES or resp.code == INSUFFICIENT_SCOPE else "HOOK_GATE"
                raise IntuticGateRefusal(self._shown(resp.reason), code, resp.incident_id)

        if tool_name not in READ_ONLY_TOOLS:
            self._emit("tool_allowed", tool_name, "", tool_input, gate_decision_id=decision_id)

    def _guard_mcp(self, tool_name: str, tool_input: dict, note: Optional[dict] = None) -> None:
        """Raise when the workspace's MCP server registry or allowlist refuses
        an mcp__<server>__<tool> call: the registry first, as every gate orders
        them. An allowlist in shadow records the refusal and lets the call on.
        A snapshot that failed its integrity check admits no MCP server."""
        call = mcp_registry.split_mcp_tool_name(tool_name)
        if call is None:
            return
        snap = self.snapshot()
        if snap.state == "invalid":
            code, rule_id, reason = mcp_registry.unverified_refusal(call[0])
            if note is not None:
                note["ruleId"] = rule_id
            self._emit("tool_blocked", tool_name, f"{reason} [{rule_id}]", tool_input)
            raise IntuticGateRefusal(f"{reason} [{rule_id}]", code)
        if snap.mcp_registry is not None:
            refusal = mcp_registry.evaluate_registry(snap.mcp_registry, call[0], call[1])
            if refusal is not None:
                code, rule_id, reason = refusal
                if note is not None:
                    note["ruleId"] = rule_id
                self._emit("tool_blocked", tool_name, f"{reason} [{rule_id}]", tool_input)
                raise IntuticGateRefusal(self._shown(f"{reason} [{rule_id}]"), code)
        if snap.mcp_allowlist is not None:
            refusal = mcp_registry.evaluate_allowlist(snap.mcp_allowlist, call[0])
            if refusal is not None:
                code, rule_id, reason = refusal
                if note is not None and (snap.mcp_allowlist["severity"] != "shadow" or not note["ruleId"]):
                    note["ruleId"] = rule_id
                if snap.mcp_allowlist["severity"] == "shadow":
                    self._emit("tool_would_block", tool_name, f"{reason} [{rule_id}]", tool_input)
                    return
                self._emit("tool_blocked", tool_name, f"{reason} [{rule_id}]", tool_input)
                raise IntuticGateRefusal(self._shown(f"{reason} [{rule_id}]"), code)

    def _hold(self, rule_id: str, rule_reason: str, tool_name: str, tool_input: dict) -> None:
        """A hold rule matched: returns when an approved bypass lets this exact
        call through (the remaining tiers still apply), and otherwise raises
        IntuticGateHold after recording the hold."""
        outcome = request_hold(self.client, rule_id, rule_reason, tool_name, tool_input)
        if outcome.kind == "bypassed":
            # Let through, loudly: a bypass nobody can see used is no better
            # than no review at all.
            self._emit("hold_approved_bypass_used", tool_name,
                       f"Approved bypass for {rule_id} — approved by "
                       f"{outcome.decided_by or 'an approver'} on hold {outcome.hold_id}", tool_input)
            return
        self._emit("tool_held", tool_name, f"{rule_reason} [{rule_id}]", tool_input)
        # An OPAQUE workspace's hold names the hold, not the rule.
        opaque = self._opaque()
        raise IntuticGateHold(hold_message(OPAQUE_REFUSAL_MESSAGE if opaque else rule_reason,
                                           "" if opaque else rule_id, outcome),
                              outcome.hold_id if outcome.recorded else None)


#: The refusal codes of the MCP registry and allowlist, which the hook gate may also return.
MCP_CODES = frozenset({"SERVER_BLOCKED", "SERVER_HELD", "SERVER_NOT_APPROVED", "TOOL_DISABLED", "SERVER_NOT_ALLOWED"})


# Module-level active gate, so decorated tools do not need the instance
# threaded through every call site.
_ACTIVE: Optional[Gate] = None


def install(gate: Gate) -> None:
    """Set the process-wide gate that `@guard` and `guard_tools` use."""
    global _ACTIVE
    _ACTIVE = gate


def active() -> Optional[Gate]:
    """The process-wide gate `install` set, or None."""
    return _ACTIVE
