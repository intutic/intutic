# Audit Timeline <Badge type="tip" text="Cloud" />

**Settings › Audit Timeline** (`/settings/audit`) answers "who reached this workspace, and who approved what" for one day at a time. Owners and Admins only.

## What it shows

One list per day (UTC), newest first. Each event carries a type badge, a title, a detail line and, where one is known, the person who acted:

| Type | Title and detail |
|------|------------------|
| **Login** | The member who signed in, the sign-in method (password, SSO, magic link, GitHub or Google; signing up counts as the new owner's first sign-in) and, when recorded, the IP address. Refused sign-ins are not listed here; they stream to [SIEM export](/guide/siem-export), and a notification rule on `auth.login.failed` [announces them](/guide/settings#rule-filters) |
| **Enforcement** | The tool and the verdict, with the reason |
| **Decision** | A resolved decision's summary, with its outcome and status |
| **Incident** | A resolved incident's anomaly type and severity, with its description, attributed to whoever resolved it |
| **Settings change** | "Workspace settings changed", with the setting keys that changed, attributed to the person or, for an automated change, to the system |
| **Adjudication** | A detector finding's ruling (true or false positive), with the anomaly kind, attributed to whoever ruled |
| **MCP server** | An [MCP server registry](/guide/mcp-governance#the-registry) decision (approved, blocked, returned to the approval queue, a tool switched on or off) or a scored change to a server's tools, attributed to the owner or admin who decided, or to the risk scorer |
| **Evidence export** | A compliance evidence download: the SOC 2 evidence archive, a framework coverage report (with its framework) or the human-oversight export, the format, the period and whether it was signed, attributed to whoever downloaded it |
| **Credential** | A virtual key, self-hosted gateway token or SCIM token created, rotated or revoked, or a provider key added, replaced or removed: which credential (its id and name, never its value) and what happened, attributed to whoever did it, or to the system for keys revoked when a member was offboarded |

Events with no timestamp, such as a decision that has not been decided yet, are left out. A person is named only when the record links to a workspace member. Most proxy traffic carries no authenticated member, so an enforcement row often has no "by" line.

## Choosing a day

The page opens on today (UTC). **Prev** and **Next** move one day; the **Day (UTC)** field picks any past day; **Today** returns to the current day. The toolbar shows how many events the day holds. A day with nothing recorded says so and offers **Show the previous day**.

## Who can open it

Only Owners and Admins see the page in the Settings area, and the control plane refuses anyone else. It is narrower than the Owner, Admin and EM gate on incidents and decisions because it also shows who signed in.

## API

The page reads one endpoint:

```
GET /api/v1/audit/timeline?workspaceId=<id>&date=YYYY-MM-DD
```

`date` is a UTC calendar day. You can instead pass `from` and `to` as ISO-8601 datetimes (inclusive), which take precedence over `date`; with neither, the range is today (UTC). The response holds separate arrays for logins, enforcement, decisions, incidents, settings changes, detector adjudications, MCP server changes (`mcpServerChanges`), evidence exports (`evidenceExports`) and credential changes (`credentialChanges`).

## Related

- [Security & Identity](/guide/security) — roles and which pages each can open
- [Governed Decisions Log](/guide/decisions-log)
- [Settings & Configuration](/guide/settings)
