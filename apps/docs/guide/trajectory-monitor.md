# Trajectory Monitor <Badge type="warning" text="Cloud / Team" />

The trajectory monitor is a parallel reviewer that reads a session's
trajectory — the sequence of tool calls, model turns and their outcomes — and
judges whether the session is still doing what it was asked to do. It runs on
the control plane, beside the session, never in front of it: the agent's
request is answered whether or not the monitor has finished.

## The three modes

| Mode | What happens on a bad verdict | Default |
|---|---|---|
| `PASSIVE` | The verdict is recorded and an alert is raised for review. Nothing changes for the agent. | **Yes** — every workspace, unless changed |
| `ACTIVE` | The verdict suggests a `KILL` for that session, which the loop governor then applies. This is one of the two opt-in paths by which a judged finding can escalate to enforcement — see [Enforcement Actions](/concepts/enforcement-actions). | No |
| `OFF` | The monitor does not run for the workspace. | No |

The default is `PASSIVE`. An earlier design document (LLD 52) specified `OFF`;
the platform has shipped with `PASSIVE` as the effective default since the
monitor landed, and defaulting an unset value to `OFF` now would switch the
monitor off platform-wide, so the code and this page say `PASSIVE`.

## Changing the mode

Workspace **Settings → Session Safety**, or the API:

```bash
curl -X PUT "$INTUTIC_CONTROL_PLANE_URL/api/v1/workspace/settings" \
  -H "Authorization: Bearer $INTUTIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"trajectory_monitor_mode": "ACTIVE"}'
```

`ACTIVE` is available on Enterprise plans. Turning it on does not change any
verdict already recorded; it changes what the next bad verdict does.

## What `ACTIVE` escalates, and what it does not

`ACTIVE` only ever turns a verdict the monitor has already reached into a
`KILL` for that session. It does not add checks, lower thresholds, or touch
any other session. A [break-glass](/guide/break-glass) grant scoped to a rule
or detector does not exempt a session from the monitor, because the monitor
is not a rule the grant can name.

## Related

- [Session Safety & Budgets](/guide/loops)
- [Enforcement Actions](/concepts/enforcement-actions)
