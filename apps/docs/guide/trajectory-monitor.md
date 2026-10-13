# Trajectory Monitor <Badge type="tip" text="Cloud" />

The trajectory monitor is a parallel reviewer that reads a session's
trajectory — the sequence of tool calls, model turns and their outcomes — and
judges whether the session is still doing what it was asked to do. It runs on
the control plane, beside the session, never in front of it: the agent's
request is answered whether or not the monitor has finished.

## The three modes

| Mode | What happens on a bad verdict | Default |
|---|---|---|
| `PASSIVE` | The verdict is recorded and an alert is raised for review. Nothing changes for the agent. | **Yes** — every workspace, unless changed |
| `ACTIVE` | The alert records a suggested `KILL` (critical verdict) or `HIJACK` (the LLM review's intervene verdict), and each intervene verdict counts as a `WORKFLOW_GOAL_DRIFT` finding toward [repeat-finding enforcement](/reference/workspace-settings) (`anomaly_enforcement`), which steers or blocks the session only if that is enabled. This is one of the two opt-in paths by which a judged finding can escalate to enforcement — see [Enforcement Actions](/concepts/enforcement-actions). | No |
| `OFF` | The monitor does not run for the workspace. Capability-miss detection is separate and still runs. | No |

The default is `PASSIVE`. An earlier design document specified `OFF`;
the platform has shipped with `PASSIVE` as the effective default since the
monitor landed, and defaulting an unset value to `OFF` now would switch the
monitor off platform-wide, so the code and this page say `PASSIVE`.

## What runs on which plan

`PASSIVE` and `ACTIVE` run on every plan, Free included, and so do the
monitor's deterministic checks: budget spent past 95%, runaway token
velocity, repeated identical tool calls, error storms and tool-call bursts.
A budget past 95% is a critical verdict, which `ACTIVE` escalates on any
plan.

A window where only an error storm or a tool-call burst fired is ambiguous.
On Self-serve, Biz Org, Enterprise and Self-host, and in the 14-day Free and
Enterprise trials, a self-hosted model reviews that window and decides its
verdict, like every other LLM judge ([Tier Matrix](/guide/tier-matrix)).
Free has no LLM review: the window is recorded as a warning that
raises an alert and never escalates, the same verdict the monitor reaches
when the review model cannot be reached. Each alert says which happened in
`trajectoryWindow.judge`: `ran`, `failed`, `not_in_plan`, or
`plan_unreadable` (the plan could not be read, so the review was skipped).

## Changing the mode

**Settings › Security › Trajectory Monitoring** (the **Monitor mode** control), or the API:

```bash
curl -X PUT "$INTUTIC_CONTROL_PLANE_URL/api/v1/workspace/settings" \
  -H "Authorization: Bearer $INTUTIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"trajectory_monitor_mode": "ACTIVE"}'
```

A workspace owner or admin can set any of the three modes, on any plan. A
self-hosted control plane runs the monitor only with
`FF_TRAJECTORY_MONITOR=true` in its environment; without it, every window
is answered `PASS` with `monitoringEnabled: false`.
Turning `ACTIVE` on does not change any verdict already recorded; it changes
what the next bad verdict does.

## What `ACTIVE` escalates, and what it does not

`ACTIVE` only ever escalates a verdict the monitor has already reached, and
only through repeat-finding enforcement: with `anomaly_enforcement` off (the
default), `ACTIVE` changes the action recorded on the alert and nothing else.
With it on, the session is steered or blocked once it has `minRepeats`
intervene verdicts at or above `minConfidence` in one session (the count lapses after an hour without one), using that
setting's `action` (`HIJACK` by default; set `KILL` to block). It does not add
checks, lower thresholds, or touch any other session. A [break-glass](/guide/break-glass) grant scoped to a rule
or detector does not exempt a session from the monitor, because the monitor
is not a rule the grant can name.

## Related

- [Session Safety & Budgets](/guide/loops)
- [Enforcement Actions](/concepts/enforcement-actions)
