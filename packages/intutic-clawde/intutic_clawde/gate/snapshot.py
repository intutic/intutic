"""Policy-snapshot reader — a port of the shipped gate contract.

Source of truth:
  services/sync-daemon/src/harness/gateBody.ts
    - RULES_COLUMNS / toRulesLine()  :124-140   the `.rules` line layout
    - intuticLoadSnapshot()                     parsing + integrity
    - intuticGate()                  :452       evaluation order

The sync-daemon compiles a workspace's SOPs into `~/.intutic/hooks/policy-snapshot.rules`
and every harness gate reads it. Three readers exist in the shipped harnesses
(bash, JS, the Open WebUI filter). This is the SDK's reader, for harnesses that
have no adapter of their own — it consumes the same documented artifact rather
than inventing a channel.

Deliberate fidelity points, each of which the upstream comments call out as a
past defect:

  * Subjects are tested SEPARATELY, never concatenated. Joining them lets a
    pattern match across the seam between two innocuous values.
  * The block reason is the rule's own text plus `[id]`. hookEvents.resolveSeverity
    greps that text for "governance-protected" to file the incident CRITICAL; a
    generic message silently downgrades it to MEDIUM.
  * INTUTIC_GUARD_DISABLE=1 drops ONLY the `destructive.*` family, never the
    compiled floor and never a workspace's own rules.
  * A snapshot rule whose regex will not compile is dropped, not fatal.
  * Snapshot health is reported as an event. "Snapshot missing on 400 machines"
    must not look identical to "snapshot present and healthy".

One honest divergence: the `.rules` regexes are authored as JavaScript regular
expressions and we compile them with Python's `re`. The two agree on everything
the shipped rules actually use (character classes, alternation, anchors,
quantifiers); they differ on lookbehind syntax and some Unicode escapes. A rule
Python cannot compile is dropped exactly as an uncompilable rule is dropped in
the JS reader, and reported, so the failure is visible rather than silent.
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

SNAPSHOT_STALE_AFTER_DAYS = 7

# Severity tiers, in the order intuticGate() handles them.
SEV_SHADOW = "shadow"
SEV_WARN = "warn"
SEV_BLOCK = "block"


@dataclass
class Rule:
    id: str
    severity: str
    subject: str          # tool | command | target | any
    reason: str
    pattern: re.Pattern


@dataclass
class Snapshot:
    rules: list[Rule] = field(default_factory=list)
    digest: str = "none"
    state: str = "absent"   # ok | absent | invalid | empty | stale
    workspace_id: str = ""
    generated_at: str = ""
    age_days: int = 0
    dropped_rules: int = 0  # regexes that would not compile

    @property
    def health_message(self) -> str:
        return {
            "absent": "No policy snapshot — built-in protections only",
            "invalid": "Policy snapshot failed its digest or workspace check — dynamic rules dropped",
            "empty": "Policy snapshot contains no rules — the compile produced nothing",
            "stale": f"Policy snapshot is {self.age_days} days old and still enforced",
        }.get(self.state, "")


@dataclass
class Decision:
    severity: str | None    # None == allow
    reason: str = ""
    rule_id: str = ""


def snapshot_path() -> str:
    return os.environ.get(
        "INTUTIC_SNAPSHOT_RULES",
        os.path.join(os.path.expanduser("~"), ".intutic", "hooks", "policy-snapshot.rules"),
    )


def _normalise(value) -> str:
    """Lowercase and collapse whitespace, as the shipped gates do."""
    return " ".join(str(value or "").lower().split())


def load_snapshot(workspace_id: str = "", path: str | None = None) -> Snapshot:
    p = path or snapshot_path()
    snap = Snapshot()
    try:
        with open(p, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return snap  # state stays 'absent'

    snap.state = "ok"
    for line in text.split("\n"):
        if line.startswith("#digest "):
            snap.digest = line[8:].strip(); continue
        if line.startswith("#workspace "):
            snap.workspace_id = line[11:].strip(); continue
        if line.startswith("#generated "):
            snap.generated_at = line[11:].strip(); continue
        if not line or line.startswith("#"):
            continue
        f = line.split("\t")
        # Column order: id, severity, flags, subject, reason, source(regex).
        if len(f) < 6 or not f[5]:
            continue
        try:
            snap.rules.append(Rule(
                id=f[0], severity=f[1], subject=f[3] or "any", reason=f[4],
                pattern=re.compile(f[5], re.IGNORECASE if f[2] == "i" else 0),
            ))
        except re.error:
            snap.dropped_rules += 1
            continue

    # Integrity. A digest nobody recomputes is a comment; a workspace id nobody
    # compares means workspace A's rules get enforced on B's machine and B's
    # events attribute A's policy to B.
    body = "\n".join(l for l in text.split("\n") if l and not l.startswith("#"))
    actual = hashlib.sha256(body.encode("utf-8")).hexdigest()[:32]
    if snap.digest != "none" and actual != snap.digest:
        snap.state = "invalid"

    if snap.state == "ok" and snap.workspace_id and workspace_id and snap.workspace_id != workspace_id:
        snap.state = "invalid"

    # Distinct from absent: the writer always ships the destructive tier, so no
    # rules means the compile produced nothing.
    if snap.state == "ok" and not snap.rules:
        snap.state = "empty"

    if snap.state == "invalid":
        snap.rules = []   # additive tier — dropping it returns to yesterday's behaviour

    if snap.state == "ok" and snap.generated_at:
        try:
            t = datetime.fromisoformat(snap.generated_at.replace("Z", "+00:00"))
            snap.age_days = max(0, (datetime.now(timezone.utc) - t).days)
            if snap.age_days > SNAPSHOT_STALE_AFTER_DAYS:
                snap.state = "stale"   # staleness governs alerting, not enforcement
        except ValueError:
            pass

    return snap


def evaluate(tool_name: str, target: str, command: str, snap: Snapshot,
             guard_disabled: bool = False) -> Decision:
    """Evaluate one tool call against the snapshot. First match wins."""
    rules = list(snap.rules)
    if guard_disabled:
        # Only the destructive family is skippable. The alternative a blocked
        # developer reaches for is chflags nouchg on the hook itself, which is
        # strictly worse; every use is recorded by the caller.
        rules = [r for r in rules if not r.id.startswith("destructive.")]

    n_tool, n_command, n_target = _normalise(tool_name), _normalise(command), _normalise(target)

    for rule in rules:
        if rule.subject == "tool":
            subjects = [n_tool]
        elif rule.subject == "command":
            subjects = [n_command]
        elif rule.subject == "target":
            subjects = [n_target]
        else:
            subjects = [n_command, n_target]

        for subject in subjects:
            if not rule.pattern.search(subject):
                continue
            if rule.severity == SEV_SHADOW:
                return Decision(SEV_SHADOW, f"{rule.reason} [{rule.id}]", rule.id)
            if rule.severity == SEV_WARN:
                verb = n_command.strip().split(" ")[0] if n_command else ""
                return Decision(SEV_WARN, f"{rule.reason} [{rule.id}] verb={verb}", rule.id)
            # The rule's own reason, not a generic one — resolveSeverity reads it.
            return Decision(SEV_BLOCK, f"{rule.reason} [{rule.id}]", rule.id)

    return Decision(None)


def guard_disabled_from_env() -> bool:
    return os.environ.get("INTUTIC_GUARD_DISABLE") == "1"
