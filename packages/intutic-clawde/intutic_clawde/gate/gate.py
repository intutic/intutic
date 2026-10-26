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

Eight tiers, in order:

  A0  SSO group policy  from the policy snapshot       unknown groups refused
  A1  policy snapshot   port of intuticGate()          fails CLOSED
  R   rule records      the snapshot's @rule records   fails CLOSED (a rule failure)
  M   MCP registry      from the policy snapshot       unverified snapshot admits none
  A3  SOP rules         authored in the product        fails OPEN (A2 covers it)
  A2  image integrity   local check                    fails CLOSED
  D   decide rules      the self-hosted decide engine  fails CLOSED when enforcing
  B   POST /hook-gate   control-plane check            fail posture set by GateClient

Tier R evaluates the snapshot's @rule records (rule_record.py): a
qualified `requires_before: action:run_tests[ok] -> X` refuses X with
PREREQUISITE_UNMET unless the latest test run this gate recorded for the
session (Gate.record_outcome, which @guard and guard_tools call) passed and
no file changed since; `scope_paths_mode: enforce` refuses a file change
outside the scope with OUT_OF_SCOPE; `plan_approval:` refuses with
PLAN_NOT_APPROVED until the session's plan is approved (GET
/api/v1/plans/session/:id, cached PLAN_CACHE_S), and under `strict` a tool off
the plan with OFF_PLAN. A plan that cannot be read refuses whatever
fail_closed says: rule failures always fail closed.

Tier D runs only on a call every deterministic tier allowed: the snapshot's
decide rules on the tool, asked of the self-hosted engine configured in
~/.intutic/decide/engine.json and INTUTIC_DECIDE_*, within
INTUTIC_DECIDE_BUDGET_MS (default DECIDE_BUDGET_MS). A rule refuses with
DECIDE_REFUSED; one that cannot decide raises IntuticGateEscalation
(DECIDE_ESCALATED), which a caller that can ask its user turns into a
question; an engine that cannot answer refuses an enforcing rule with
GOVERNANCE_UNAVAILABLE and lets a shadow rule's call on (decide_evaluate.py
holds the protections).

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
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from ..errors import ClawdeError
from . import chaos, decide_log, decide_record, imagecheck, mcp_registry, snapshot, soprules, sso_groups
from .decide_engine import DecideEngineError, create_decide_engine, resolve_decide_engine_config
from .decide_evaluate import (
    CanaryFileStore, decide_decision, decide_shadow_findings, decide_stored_q95_ms, decide_unavailable_decision,
    evaluate_decide_call,
)
from . import refusal_detail, rule_record, test_outcome
from .actions import classify, is_deploy, lane_of, touches_infra
from .scope_match import is_file_write_call
from .client import INSUFFICIENT_SCOPE, GateClient
from .hold import hold_key, hold_message, request_hold
from .limits import DECIDE_BUDGET_MS, too_large_reason
from .opaque import OPAQUE_REFUSAL_MESSAGE


# Tools that cannot change anything. They still get the local snapshot check
# (Tier A), but skip the remote gate call (Tier B) — see Gate.guard().
READ_ONLY_TOOLS = frozenset({"read_file", "list_files", "read", "cat", "view"})


# Whether this gate evaluates the decide rules a snapshot carries (Tier D).
# Only a gate that does skips a decide rule's fallback line, and only when the
# rule's record decoded; otherwise the fallback line refuses its tools, as in
# a gate that reads no @decide records.
CAN_EVALUATE_DECIDE = True

# Whether this gate evaluates the @rule records a snapshot carries (Tier R).
# Only a gate that does skips a record's fallback line, and only when the
# record decoded.
CAN_EVALUATE_RULE_RECORDS = True

# How long Tier R keeps a session's plan before reading it again, in seconds.
PLAN_CACHE_S = 30.0


def _decide_budget_ms() -> int:
    """The decide tier's budget for one call: INTUTIC_DECIDE_BUDGET_MS, or DECIDE_BUDGET_MS."""
    raw = os.environ.get("INTUTIC_DECIDE_BUDGET_MS", "").strip()
    return int(raw) if raw.isdigit() and int(raw) > 0 else DECIDE_BUDGET_MS


def _decide_deps():
    """The engine (or the error creating it raised), its URL, the canary cache,
    the per-call p95 ``intutic doctor`` stored with the engine's parallel
    (for the budget estimate), and the resolved configuration for the decide
    log (None when it does not resolve), read from ~/.intutic/decide/ and the
    environment for each call that needs them."""
    folder = Path.home() / ".intutic" / "decide"
    url = ""
    q95_ms = None
    parallel = 1
    resolved = None
    try:
        try:
            file = json.loads((folder / "engine.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            file = None
        except (OSError, ValueError) as exc:
            raise DecideEngineError("not_configured", f"engine.json does not read: {exc}")
        q95_ms = decide_stored_q95_ms(file)
        cfg = resolve_decide_engine_config(file, os.environ)
        resolved = cfg
        url = cfg.url
        parallel = cfg.parallel
        engine = create_decide_engine(cfg)
    except DecideEngineError as err:
        engine = err
    except Exception as err:  # noqa: BLE001 - an engine that cannot be made is not configured
        engine = DecideEngineError("not_configured", str(err))
    return engine, url, CanaryFileStore(folder / "canary.json"), q95_ms, parallel, resolved


#: Every `code` an IntuticGateRefusal can carry: the tier that refused, or for
#: the image-integrity tier the specific failure. Held to
#: packages/shared-types/fixtures/refusal-codes.json (`gate`) by a test, as the
#: TypeScript gate's list and the gate SDK reference are.
GATE_REFUSAL_CODES = (
    "SSO_GROUP",
    "SNAPSHOT",
    "HELD",
    # Tier R, the snapshot's rule records (rule_record.py): a qualified
    # requires_before, scope_paths_mode: enforce, plan_approval.
    "PREREQUISITE_UNMET",
    "OUT_OF_SCOPE",
    "OFF_PLAN",
    "PLAN_NOT_APPROVED",
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

    def __init__(self, reason: str, code: str, incident_id: Optional[str] = None,
                 scope: Optional[dict] = None, evidence: Optional[list] = None):
        super().__init__(f"[Intutic Governance] BLOCKED: {reason}")
        self.reason = reason
        self.code = code
        self.incident_id = incident_id
        # Where the refusal applies, so a retry can stay out of it, and what
        # the refuser saw, bounded as refusal_detail.py says; None when the
        # refusal names none, and always in an OPAQUE workspace.
        self.scope = scope
        self.evidence = evidence


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


class IntuticGateEscalation(IntuticGateRefusal):
    """Raised when a decide rule could not decide the call and a person
    should (`code` DECIDE_ESCALATED): the answers fell between its bands, or
    the option orders disagreed. A subclass, so a caller that stops on every
    refusal stops on this too; one that can ask its user asks with `reason`
    and runs the call only on a yes. `rule_id` names the rule
    (`decide.<ruleRef>`), and is None in an OPAQUE workspace.
    """

    def __init__(self, reason: str, rule_id: Optional[str]):
        super().__init__(reason, "DECIDE_ESCALATED")
        self.rule_id = rule_id


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
        # Tier R: each session's outcome state (test_outcome.py), and its plan
        # as last read with when, by session id, in memory.
        self._outcomes: dict = {}
        self._plans: dict = {}

    # ------------------------------------------------------------ loading

    def snapshot(self) -> snapshot.Snapshot:
        if self._snapshot is None:
            self._snapshot = snapshot.load_snapshot(self.cfg.workspace_id, evaluates_decide=CAN_EVALUATE_DECIDE,
                                                    evaluates_rules=CAN_EVALUATE_RULE_RECORDS)
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
            held = isinstance(exc, (IntuticGateHold, IntuticGateEscalation))
            report("hold" if held else "deny", exc.code != "COMMAND_TOO_LARGE")
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

        # The call as the gates serialize it, for the WHERE clause of a snapshot rule.
        input_json = json.dumps(tool_input or {}, separators=(",", ":"), ensure_ascii=False)
        # Hold rules an approved bypass let through on this call, so the
        # register's copy of the same rule in Tier A3 does not hold it again.
        approved: set[str] = set()
        d = snapshot.evaluate(tool_name, target, command, self.snapshot(), disabled,
                              tool_input_json=input_json)
        if note is not None:
            if d.rule_id:
                note["ruleId"] = d.rule_id
            # Destructive whether or not a rule decided the call, the escape
            # hatch included: what a chaos run's no_destructive_attempt reads.
            destructive = dataclasses.replace(
                self.snapshot(), rules=[r for r in self.snapshot().rules if r.id.startswith("destructive.")])
            note["destructive"] = snapshot.evaluate(tool_name, target, command, destructive, False,
                                              tool_input_json=input_json).severity is not None
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
            d = snapshot.evaluate(tool_name, target, command, self.snapshot(), disabled, d.next,
                                  tool_input_json=input_json)

        # ---- Tier R: the snapshot's rule records ---------------------------
        self._guard_rules(tool_name, tool_input, note)

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

        # ---- Tier D: decide rules -----------------------------------------
        # Only here, after every deterministic tier allowed the call: a refusal
        # above never reaches the engine.
        self._guard_decide(tool_name, tool_input, note)

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

    def record_outcome(self, tool_name: str, tool_input: dict, exit_code: Optional[int] = None,
                       is_error: Optional[bool] = None, output: Optional[str] = None) -> None:
        """Records how a call that ran went, for Tier R. A test run
        (action:run_tests) records its outcome (test_outcome.py: the exit code,
        else one read from `output`, the error flag and the runner summaries);
        any other call marks earlier outcomes as no longer adjacent, and a call
        that changed files makes an earlier pass stale. Kept in memory per
        client session id; with no session id nothing is kept, and a qualified
        rule stays unmet. @guard and guard_tools call this after every call
        they ran."""
        session = self.client.session_id if self.client is not None else ""
        if not session:
            return
        state = self._outcomes.get(session) or test_outcome.empty_outcome_state()
        if "action:run_tests" in classify(tool_name, tool_input):
            out = output if isinstance(output, str) else None
            code = exit_code if isinstance(exit_code, int) and not isinstance(exit_code, bool) else test_outcome.extract_exit_code(out)
            decision = test_outcome.decide_test_outcome({"exitCode": code, "isError": is_error, "output": out})
            self._outcomes[session] = test_outcome.record_test_outcome(state, "action:run_tests", decision, time.time() * 1000)
        else:
            self._outcomes[session] = test_outcome.note_completed_call(state, is_file_write_call(tool_name, tool_input))

    def _session_plan(self, session_id: str) -> dict:
        """The session's plan, read at most every PLAN_CACHE_S seconds; an unreadable one is not cached."""
        if self.client is None or not session_id:
            return {"status": "none"}
        cached = self._plans.get(session_id)
        if cached is not None and time.monotonic() - cached[0] < PLAN_CACHE_S:
            return cached[1]
        status, body = self.client.session_plan(session_id)
        plan = rule_record.gate_rule_plan_from_response(status, body)
        if plan["status"] != "unavailable":
            self._plans[session_id] = (time.monotonic(), plan)
        return plan

    def _guard_rules(self, tool_name: str, tool_input: dict, note: Optional[dict] = None) -> None:
        """Tier R. Raises IntuticGateRefusal when an enforcing rule record
        refuses the call (PREREQUISITE_UNMET, OUT_OF_SCOPE, OFF_PLAN,
        PLAN_NOT_APPROVED), with the refusal's scope; each shadow record's
        finding is reported as tool_would_block and the call goes on."""
        if not CAN_EVALUATE_RULE_RECORDS:
            return
        records = self.snapshot().rule_records
        if not records:
            return
        session = self.client.session_id if self.client is not None else ""
        cwd = os.getcwd()
        plan = self._session_plan(session) if any(r["kind"] == "plan_approval" for r in records) else {"status": "none"}
        ev = rule_record.evaluate_gate_rule_records(records, {
            "tool": tool_name, "input": tool_input, "actions": classify(tool_name, tool_input),
            "cwd": cwd, "root": _workspace_root(cwd), "sessionId": session,
            "harness": self.client.harness if self.client is not None else "sdk",
            "outcomes": self._outcomes.get(session), "observable": True, "plan": plan,
            "nowMs": time.time() * 1000,
        })
        for f in ev["shadow"]:
            self._emit("tool_would_block", tool_name, f"{f['reason']} [{f['ruleId']}]", tool_input)
        f = ev["refusal"]
        if f is None:
            return
        if note is not None:
            note["ruleId"] = f["ruleId"]
        reason = f"{f['reason']} [{f['ruleId']}]"
        self._emit("tool_blocked", tool_name, reason, tool_input)
        detail = refusal_detail.refusal_detail_for_mode("OPAQUE" if self._opaque() else "TRANSPARENT", f["scope"], [])
        raise IntuticGateRefusal(self._shown(reason), f["code"], scope=detail.get("scope"), evidence=detail.get("evidence"))

    def _guard_decide(self, tool_name: str, tool_input: dict, note: Optional[dict] = None) -> None:
        """Tier D. Raises when a decide rule on this tool refuses the call
        (IntuticGateRefusal, DECIDE_REFUSED or GOVERNANCE_UNAVAILABLE) or could
        not decide it (IntuticGateEscalation). Each shadow rule's finding is
        recorded; the call goes on."""
        if not CAN_EVALUATE_DECIDE:
            return
        rules = [r for r in self.snapshot().decide_rules
                 if r["ir"].get("on") == "tool_call" and tool_name in (r["ir"].get("tools") or [])]
        if not rules:
            return
        budget = _decide_budget_ms()
        try:
            engine, url, canary, q95_ms, parallel, cfg = _decide_deps()
            started = time.monotonic()
            cwd = os.getcwd()
            # A rule the stored p95 says cannot be answered within the budget
            # is not asked: an enforcing one escalates.
            ev = evaluate_decide_call(
                deterministic="allow", tool=tool_name, tool_input=tool_input, cwd=cwd, rules=rules,
                deadline_s=started + budget / 1000.0, engine=engine, engine_url=url, canary=canary,
                q95_ms=q95_ms, parallel=parallel,
            )
            self._log_decide(ev, rules, tool_name, tool_input, cwd, budget, started, cfg)
            for f in decide_shadow_findings(ev, rules):
                self._emit("tool_would_block", tool_name, f"{f['reason']} [{f['ruleId']}]", tool_input)
            decision = decide_decision(ev, rules)
        except Exception as exc:  # noqa: BLE001 - a tier that cannot finish is unavailable
            decision = decide_unavailable_decision(
                rules, tool_name, f"the decide rules on {tool_name} could not be evaluated ({type(exc).__name__})")
        if decision["outcome"] == "allow":
            return
        rule_id = decision["ruleId"]
        if note is not None and rule_id:
            note["ruleId"] = rule_id
        reason = f"{decision['reason']} [{rule_id}]" if rule_id else decision["reason"]
        if decision["outcome"] == "escalate":
            self._emit("tool_flagged", tool_name, f"DECIDE_ESCALATED — asked a person: {reason}", tool_input)
            raise IntuticGateEscalation(self._shown(reason), None if self._opaque() else rule_id)
        self._emit("tool_blocked", tool_name, reason, tool_input)
        raise IntuticGateRefusal(self._shown(reason), decision["code"] or "GOVERNANCE_UNAVAILABLE")

    def _log_decide(self, ev, rules, tool_name: str, tool_input: dict, cwd: str, budget_ms: int, started: float, cfg) -> None:
        """Appends the call's decide record to ~/.intutic/logs/decide-<date>.jsonl
        and updates each rule's drift stats, as ``intutic decide check`` does
        for the shell gates. Never raises: a log that cannot be written never
        changes the decision."""
        try:
            decide_log.write_decide_call_log(
                ev, rules,
                {
                    "atMs": decide_log.now_ms(),
                    "harness": self.client.harness if self.client is not None else "sdk",
                    "workspaceId": self.cfg.workspace_id,
                    "sessionId": self.client.session_id if self.client is not None else "",
                    "tool": tool_name,
                    "toolInput": tool_input,
                    "cwd": cwd,
                    "budgetMs": budget_ms,
                    "latencyMs": round((time.monotonic() - started) * 1000),
                    "engine": decide_log.decide_log_engine(cfg, ev),
                    "redact": decide_log.DECIDE_LOG_REDACTION_SOURCES,
                    # The call's reversibility class; a gate has no revert rates.
                    "lane": lane_of(classify(tool_name, tool_input)),
                    "revertRate": None,
                },
                lambda t: hashlib.sha256(t.encode("utf-8")).hexdigest(),
                lambda rule_hash, run_id: decide_log.read_decide_eval_run_baseline(decide_log.default_decide_dir(), rule_hash, run_id),
            )
        except Exception:  # noqa: BLE001 - a log that cannot be written never changes the decision
            pass

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


def _workspace_root(cwd: str) -> str:
    """The nearest directory at or above cwd holding .git, else cwd: what Tier R makes paths relative to."""
    d = cwd
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return cwd
        d = parent


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
