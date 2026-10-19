# Decide escalation by harness <Badge type="tip" text="Open-Core" />

A [decide rule](/guide/decide) whose answers are unknown escalates. With `"escalate": "ask"`, the default, the gate asks a person through the harness's own prompt where the harness has one on that path, and refuses with `DECIDE_ESCALATED` where it does not. An escalation never allows a call on its own: the call runs only when a person says yes in the harness.

A rule with `"escalate": "refuse"` refuses with `DECIDE_ESCALATED` on every harness, and `"escalate": "review"` is treated as `ask`.

The table is what each generated gate writes, from the harnesses' documented hook contracts. A harness that accepts an ask but then runs the call is listed as refusing, because there an ask would allow.

| Harness | Escalation | What the gate does |
| :--- | :--- | :--- |
| [Claude Code](/integrations/claude-code) | asks | Exits 0 with `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"…"}}`. Claude Code documents that a non-interactive run (`-p`) denies an ask and passes the reason to the model |
| [Cursor](/integrations/cursor) | asks on shell and MCP calls; refuses on others | On `beforeShellExecution` and `beforeMCPExecution`, exits 0 with `{"permission":"ask","user_message":"…","agent_message":"…"}`. Cursor accepts an ask on `preToolUse` and does not enforce it, so a call there refuses (exit 2) |
| [GitHub Copilot](/integrations/github-copilot) | asks | Exits 0 with `permissionDecision: "ask"` and its reason, both at the top level (the Copilot CLI) and under `hookSpecificOutput` (VS Code). Copilot documents that the cloud agent and autopilot turn an ask into a deny |
| [Antigravity](/integrations/antigravity) (the Antigravity 2.0 app and CLI) | asks | Exits 0 with `{"decision":"force_ask","reason":"…"}`, which prompts even where the user chose "Always Allow" |
| Gemini CLI | refuses | Its hook has no ask; exits 2 |
| [Hermes](/integrations/hermes) | asks | Exits 0 with `{"action":"approve","message":"…"}`, Hermes' human approval. The gate never writes `{"decision":"approve"}`, which Hermes reads as an allow |
| [OpenClaw](/integrations/openclaw) | asks | Returns `requireApproval` with the reason and the decisions `allow-once` and `deny`, so an approval covers that call only |
| [dsh](/integrations/dsh) | asks | Returns `{kind: 'ask', reason}`, which dsh's approval service asks. dsh turns it into a deny when no approval service is mounted. Needs `@intutic/gate` 3.0 in the profile: a profile still on 2.x refuses the rule's tools through its fallback line |
| [Codex](/integrations/codex) | refuses | Codex parses an ask, reports it as unsupported and runs the call, so the gate refuses (exit 2) instead |
| [Windsurf](/integrations/windsurf), [Muse Code](/integrations/muse-code) | refuses | Exit codes only; exits 2 |
| [Cline](/integrations/cline) | refuses | `{"cancel":true,…}` with `code: "DECIDE_ESCALATED"`; Cline's file hooks have no ask |
| [Grok Build](/integrations/grok) | refuses | `{"decision":"deny",…}` with `code: "DECIDE_ESCALATED"`; Grok Build's hooks have no ask |
| [Goose](/integrations/goose), [OpenHands](/integrations/openhands) | refuses | Shell gates through `intutic decide check`; exit 2 |
| [Pi](/integrations/pi) | refuses | The extension returns `{block: true}`; Pi's `tool_call` result has no ask |
| [OpenCode](/integrations/opencode) | refuses | 1.x: the plugin throws, as for any refusal; its `permission.ask` hook is never called. 2.x: the decide tier does not run (see below) |
| [n8n](/integrations/n8n) | refuses | Through `intutic decide check`; the workflow gate throws, which stops the workflow |
| SDK gates (`@intutic/gate`, `intutic_clawde`) | the caller decides | `Gate.guard` throws `IntuticGateEscalation`, a subclass of `IntuticGateRefusal` with the code `DECIDE_ESCALATED`. A caller that can ask its user asks with `reason` and runs the call on a yes; one that does not know the subclass treats it as the refusal it also is |

Open WebUI's filter gates prompts, not tool calls, and evaluates no decide rule. Aider, Continue, Roo Code and Claude Desktop have no gate.

**OpenCode 2.x** registers its gate synchronously, because whether OpenCode 2.x waits for a hook that returns a promise is not verified. The decide tier needs the engine and cannot run there, so a call that an enforcing decide rule names is refused, and shadow rules are not evaluated.

**Claude Code's permission modes.** A Claude Code session that skips permission prompts may run an asked call without asking. This has not been verified. If you run sessions that way, give the rules that matter `"escalate": "refuse"`.

## The reason a person sees

The ask, or the refusal, carries the rule's title and the questions the model could not answer:

```
[Intutic Governance] ASK: Needs a person: Production data handling — Where does the data go? [decide.local:data.md#prod-data-export]
```

In a workspace whose intervention mode hides rule ids, the id is left out, as it is for every refusal.

## Time limits

The gate asks only once the engine has answered, inside the harness's decide budget (see [Limits](/guide/decide#limits)). A rule the engine cannot answer in the time left, by the per-call p95 `intutic doctor` stored, is not asked at all: an enforcing rule escalates, as the table above says, and the reason names the time budget. A rule that is asked and gets no answer in time makes the engine unavailable, which refuses an enforcing rule with `GOVERNANCE_UNAVAILABLE` rather than asking. GitHub Copilot runs a call whose hook times out, which is why every gate stops a second before its harness's hook timeout ([Hook timeouts](/reference/harness-security-matrix#hook-timeouts)).

## Related

- [Decide rules](/guide/decide)
- [Refusal codes in a JSON decision](/reference/harness-security-matrix#hook-refusal-codes)
- [Tool Gate SDK: refusals](/reference/gate-sdk#refusals)
