# AI inventory on developer machines <Badge type="tip" text="Cloud" />

The **AI Inventory** page (Activity → AI Inventory) lists every AI coding harness, MCP server and skill bundle on your developers' connected machines, and marks the ones that run outside governance. It covers machines that run `intutic connect` and nothing else: it does not read an EDR, an identity provider or a cloud account, so an agent on a machine that never ran `intutic connect` does not appear.

## Who sees what

| Role | Sees |
|---|---|
| Owner, Admin, Engineering manager | Every machine in the workspace |
| Developer | The machines whose latest report was sent with their own credentials |
| Viewer | Nothing; the page is hidden and the API answers 403 |

## What is collected

`intutic connect` collects the inventory on the machine and sends it to the control plane with the [agent facets](/guide/agents) it already reports.

| Item | Fields |
|---|---|
| Machine | A fingerprint (a hash of the hostname, platform and machine id, the same one [`intutic enforce`](/reference/cli) reports), the hostname, the platform, the CLI version, the `intutic connect` workspace folder relative to your home directory, and the member whose credentials sent the report |
| Harnesses | Every harness whose detection rule matches the machine or the connected workspace, plus every harness `intutic connect` is configured for. For each: its type; its version where the install records it in a folder name (the Cline, Roo Code and Continue VS Code extensions); whether `intutic connect` is configured for it; how its gate works (a hook file, an SDK gate inside the harness, another harness's gate, an external bridge, or no gate); whether the gate file is on disk and where, relative to your home directory; the time of the newest event the gate wrote on this machine; and the time of the newest event it wrote with guards disabled (`INTUTIC_GUARD_DISABLE=1`) |
| MCP servers | Every server in the MCP configs Intutic reads for Claude Code, Claude Desktop, Cursor, Cline, Windsurf, OpenHands, Continue, Goose, Muse Code, Grok Build and OpenCode: its name, the harness whose config declares it, its transport, whether the MCP governance proxy fronts it, and why not when the daemon can tell. A remote server's URL is sent without its user name, password, query string and fragment, and a path segment that looks like a token (16 or more characters mixing letters and digits) is replaced with `[redacted]` |
| Skill bundles | Each folder under `.agents/skills` and `.claude/skills` in the connected workspace and under `~/.claude/skills`: its name, the folder it was found in, the SHA-256 of its `SKILL.md`, whether the [content scan](/guide/skill-scanning) ran and how many findings it had, and how many files are bundled with it |
| Guard probes | The local proxy's last scheduled guard-probe run: how many probes ran and how many failed, when the proxy answers |

### What is never collected

- The contents of any file: rules files, `SKILL.md`, bundled scripts, MCP configs, hook logs.
- Environment variables and their values, including those an MCP config sets for a server.
- An MCP server's command line or arguments, and a remote server's headers.
- Paths outside your home directory; one is sent as `[redacted]`.

The control plane removes credentials from MCP server URLs a second time when it stores them.

## How often

| Step | When |
|---|---|
| A machine sends its inventory | When `intutic connect` starts, then every five minutes (every tenth poll at the default 30-second interval) |
| A gate's latest event is recorded | When `intutic connect` drains the hook-event log: when the log changes, and at least once a minute. Cline and n8n gates keep their own log, which is read when the inventory is collected |
| Status is decided | On every page load and API read, from the latest report and the current time |
| A machine is shown as not reporting | 72 hours after its last report, the same threshold device posture uses |

## How status is decided

A **harness** is:

| Status | When |
|---|---|
| **Ungoverned** | It has no tool-call hook a gate can attach to; or it was detected but is not one of the machine's `intutic connect` harnesses and no gate file is present; or it is connected and its gate file is missing; or its gate ran with guards disabled in the last 48 hours |
| **Gate stale** | Its gate file is present, it has been on the machine for more than an hour, and the gate has written no event in the last 48 hours, the same window as the [Gate Stopped Reporting](/guide/settings#notifications) alert |
| **Unverified** | Its gate was installed less than an hour ago and has not written an event yet; or its gate runs inside the harness's own process, in another harness or in an external service (LangChain, CrewAI, the OpenAI Agents SDK and the other SDK-gated frameworks, Xirp, Agentic Orchestrator) and no event from it has reached the machine |
| **Governed** | Its gate is installed, guards are on, and it wrote an event in the last 48 hours |

A gate writes an event for every tool call it sees, allowed calls included, so a harness nobody used for two days shows **Gate stale** until it is used again.

An **MCP server** is **Ungoverned** when the MCP governance proxy does not front it, and **Governed** when it does.

## Notifications

The first time a machine reports an ungoverned harness or MCP server, the control plane sends an **Ungoverned AI Tool Found** notification (`inventory.ungoverned.detected`, severity MEDIUM). It is sent once per machine and item: not again when the item disappears and comes back, and not when only the time-based statuses change (a stale gate already raises **Gate Stopped Reporting**). Add the event to a [notification rule](/guide/settings#notifications) to receive it, and [SIEM export](/guide/siem-export) carries it under `governance_alerts`.

## Export and API

The Harnesses and MCP servers views download as CSV with the filters on screen. A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'`, so a spreadsheet opens it as text.

| Endpoint | Returns |
|---|---|
| `GET /api/v1/inventory/summary` | Machine, harness, MCP server and skill counts, and the governed percentage |
| `GET /api/v1/inventory/devices` | One row per machine |
| `GET /api/v1/inventory/harnesses` | Harnesses by machine, filtered by `status`, `harness`, `device` and `q`; `format=csv` for a download |
| `GET /api/v1/inventory/mcp-servers` | MCP servers by machine, with the same filters and CSV |
| `GET /api/v1/inventory/skills` | Skill bundles by machine, filtered by `device` and `q` |

## Limits

- Inventory is self-reported by the machine, like the device posture under [Settings → Security](/guide/settings#security). A member could send a false report for a machine they control.
- Harness detection runs against the connected workspace and the home directory. A framework detected from a project's dependencies (LangChain, Mastra and the like) is found only in the workspace `intutic connect` runs in.
- A machine that stops running `intutic connect` keeps its last report, marked as not reporting after 72 hours.
