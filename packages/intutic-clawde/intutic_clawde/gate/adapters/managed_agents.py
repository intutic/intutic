"""Anthropic Managed Agents (public beta since 2026-04-08) — a session
confirmation responder, plus guidance for the two execution surfaces this
adapter does NOT cover the same way.

Managed Agents is architecturally different from every other adapter in this
package: the customer's process does not run the tool-call loop. Anthropic
hosts a "session" that emits an event stream, and the customer's backend
answers it. There is no local function call to wrap the way `@guard` wraps a
CrewAI tool.

**Verified against a real install, not assumed.** ``anthropic==0.122.0`` (the
latest published release at the time this adapter was built; the TypeScript
twin, `@intutic/gate/managed-agents`, was checked against
``@anthropic-ai/sdk@0.117.1`` — its latest) was downloaded and its shipped
source read directly:

* ``anthropic/resources/beta/sessions/events.py`` — every request this
  package issues (``.list()``, ``.send()``, ``.stream()``) sends
  ``anthropic-beta: managed-agents-2026-04-01`` automatically; this module
  never needs to set that header itself, but {@link MANAGED_AGENTS_BETA}
  documents the value for callers building their own request.
* ``anthropic/types/beta/sessions/beta_managed_agents_user_tool_confirmation_event_params.py``
  — the wire shape this module builds: ``{"type": "user.tool_confirmation",
  "tool_use_id", "result": "allow"|"deny", "deny_message"?, "session_thread_id"?}``.
* ``anthropic/types/beta/sessions/beta_managed_agents_agent_tool_use_event.py``
  and ``..._agent_mcp_tool_use_event.py`` — both carry
  ``evaluated_permission: "allow"|"ask"|"deny"|None``. A tool call the server
  evaluated to ``"ask"`` (e.g. because its ``permission_policy`` is
  ``always_ask`` — Anthropic's docs mark MCP toolsets as ``always_ask`` by
  default; check current docs for built-in agent-toolset tools, whose default
  is not encoded in the SDK types) PAUSES the session — Anthropic's own docs:
  "Denied tools do not run." A ``"deny"`` verdict means the SERVER already
  denied the call (no confirmation is expected or accepted); ``"allow"`` or
  unset means the call never paused at all. **This is the real, documented
  pre-execution veto this module answers — it is not observe-only.**
* ``anthropic/lib/tools/_beta_session_runner.py`` (``SessionToolRunner``) is
  Anthropic's OWN reference dispatcher: it executes ``agent.tool_use`` /
  ``agent.custom_tool_use`` calls and posts their results, but it does
  **not** decide ``allow``/``deny`` for an ``ask``-gated call itself — it
  blocks until *something* sends the matching ``user.tool_confirmation``
  event. That "something" is what this module provides:
  {@link confirmation_for_event} / {@link IntuticSessionConfirmer} turn a
  paused ``agent.tool_use`` / ``agent.mcp_tool_use`` event into a
  ``Gate.guard()``-driven verdict.
* ``anthropic/lib/environments/_worker.py`` (``EnvironmentWorker``, the
  self-hosted sandbox driver) composes ``SessionToolRunner`` internally for
  built-in agent-toolset tools (bash, edit, read, write, glob, grep,
  web_fetch, web_search — ``anthropic/types/beta/beta_managed_agents_agent_tool_config.py``).
  **This means self-hosted built-in tools pause and resolve through the
  IDENTICAL ``agent.tool_use`` / ``evaluated_permission`` /
  ``user.tool_confirmation`` mechanism as hosted ones** — this adapter
  covers them the same way, contrary to an assumption that a self-hosted
  sandbox has no governance hook. What differs for self-hosted is only WHERE
  the tool body executes (the customer's own worker process), not how the
  pre-execution veto works.
* ``agent.mcp_tool_use`` is explicitly excluded from ``SessionToolRunner``'s
  own dispatch (its own module doc: "the runner never sees a result to post
  for them" — MCP tools run server-side at Anthropic). But the confirmation
  gate is a SEPARATE mechanism from execution: ``BetaManagedAgentsAgentMCPToolUseEvent``
  carries ``evaluated_permission`` exactly like the built-in event does, so
  this module answers MCP pauses too, even though nothing in the official SDK
  dispatches their execution locally.

## What this module does NOT cover the same way — custom tools

``agent.custom_tool_use`` (``beta_managed_agents_agent_custom_tool_use_event.py``)
has **no** ``evaluated_permission`` field and no ``permission_policy`` concept
at all: a custom tool always executes wherever the client that owns its name
is listening, with no pause. It is answered with ``user.custom_tool_result``
(``custom_tool_use_id`` + ``content`` + ``is_error``), not
``user.tool_confirmation``. This is the "customer's own process runs the
call" surface the phase brief anticipated — the natural integration point IS
this package's existing ``@guard`` decorator, exactly as the brief guessed.
BUT verify the wrapping layer, because a naive port of `guard_tools()`'s
existing `.func`-swap trick silently does NOT work here:

``anthropic.lib.tools._beta_functions.BaseFunctionTool.__init__`` captures
``self._func_with_validate = pydantic.validate_call(func)`` at CONSTRUCTION
time, and ``BetaFunctionTool.call()`` invokes ``self._func_with_validate``,
**not** ``self.func``. `guard_tools()` (``framework.py``) only ever patches
`.func` in place (the LangChain/smolagents convention) — for a
``@beta_tool``-decorated custom tool that patch is a silent no-op: the gate
never runs. The correct pattern is to gate the underlying function BEFORE
``@beta_tool`` wraps it, so the validated copy IS the guarded one::

    from anthropic.lib.tools import beta_tool
    from intutic_clawde.gate import guard

    @beta_tool
    @guard                      # innermost: gate wraps the raw function first
    def read_internal_doc(doc_id: str) -> str:
        ...

Decorator order matters: ``@guard`` must be the one closest to ``def``. See
TD-427.

## What this module does NOT cover at all — the sandbox tool BODY

The self-hosted ``EnvironmentWorker`` gates tool PAUSES exactly like the
hosted path (see above) — but the tool's actual execution (the real
``bash``/``edit``/... implementation, `anthropic.lib.tools.agent_toolset`)
runs inside the customer's own worker process, outside this adapter's reach,
same as every other Intutic adapter's posture toward a framework's built-in
tool bodies (see openai.ts's module doc for the precedent: "no client-side
hook exists" is stated plainly rather than pretended otherwise). This module
governs WHETHER the call runs; it does not — and cannot — inspect or modify
what the tool body does once allowed.

## Webhook vs. streamed/polled delivery — both are real, verified live

``anthropic/resources/beta/webhooks.py``: ``client.beta.webhooks.unwrap(payload,
headers=..., key=...)`` verifies the HMAC signature and returns a typed
event; for a pause it is ``session.requires_action``
(``beta_webhook_session_requires_action_event_data.py`` — carries only
``id`` (the session id), ``organization_id``, ``workspace_id``: NOT the tool
call itself). A webhook is therefore a NOTIFICATION to re-poll, not a
self-contained payload — {@link IntuticSessionConfirmer.handle_webhook} does
exactly that: re-lists the session's unanswered events and answers them.
``events.stream()``/``events.list()`` (``resources/beta/sessions/events.py``)
are the poll/stream alternative this module also supports directly via
{@link IntuticSessionConfirmer.poll} / {@link IntuticSessionConfirmer.watch}.

## Fail-closed posture

Matches every other adapter in this package: no gate configured, or an
unexpected exception out of `Gate.guard()`, both produce a ``"deny"`` verdict
— never a silently-allowed, unevaluated call. Only `IntuticGateRefusal` is
distinguished (its own message becomes `deny_message`); anything else is
wrapped in a generic "gate crashed" `deny_message`.
"""

from __future__ import annotations

from typing import Any, Dict, Iterator, List, Optional, Set

from ..gate import Gate, IntuticGateRefusal, active

#: The beta header every Sessions-API request needs. The real SDK
#: (`anthropic/resources/beta/sessions/events.py`) sets this on every
#: `.list()`/`.send()`/`.stream()` call automatically — this constant exists
#: for callers building their own request against the endpoint directly.
MANAGED_AGENTS_BETA = "managed-agents-2026-04-01"

#: The two session-event types that carry `evaluated_permission` and are
#: answered with `user.tool_confirmation`. `agent.custom_tool_use` is
#: deliberately absent — see the module doc.
_CONFIRMABLE_EVENT_TYPES = frozenset({"agent.tool_use", "agent.mcp_tool_use"})

#: Event types signalling the session is over — `IntuticSessionConfirmer`
#: stops on these rather than treating them as more work to answer.
_TERMINAL_EVENT_TYPES = frozenset({"session.status_terminated", "session.deleted"})


def _field(obj: Any, name: str, default: Any = None) -> Any:
    """Read `name` off `obj`, whether it's an SDK pydantic model or a plain
    dict (e.g. a caller who parsed a webhook body themselves rather than
    going through `client.beta.webhooks.unwrap()`)."""
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _no_gate_result() -> str:
    return (
        "[Intutic Governance] BLOCKED: no gate configured — call "
        "intutic_clawde.gate.install(Gate(...)) before constructing the "
        "confirmer, or pass gate= to it. Refusing to approve an unevaluated "
        "call."
    )


def confirmation_for_event(event: Any, *, gate: Optional[Gate] = None) -> Optional[Dict[str, Any]]:
    """Build the `user.tool_confirmation` params answering `event`, or
    `None` if `event` needs no answer from this module.

    `None` covers three cases, all correct to send nothing for:
    the event isn't `agent.tool_use`/`agent.mcp_tool_use` (including
    `agent.custom_tool_use` — see the module doc); its
    `evaluated_permission` is `"allow"` or unset (the call never paused);
    or it is already `"deny"` (the SERVER already resolved it — sending a
    confirmation for an id the server considers closed would just error).

    Anything else — `"ask"`, or a permission value this module doesn't
    recognise — is treated as a pause needing a verdict, matching
    `SessionToolRunner`'s own fail-closed handling of unrecognised wire
    values (hold/deny rather than dispatch).

    `gate` overrides the process-wide instance from `intutic_clawde.gate.install()`.
    Pure function: makes no network call itself, so it is the unit-testable
    core both `IntuticSessionConfirmer` and a caller with their own event
    loop can use directly.
    """
    event_type = _field(event, "type")
    if event_type not in _CONFIRMABLE_EVENT_TYPES:
        return None

    permission = _field(event, "evaluated_permission")
    if permission in (None, "allow", "deny"):
        return None

    event_id = _field(event, "id")
    if not event_id:
        return None

    tool_name = str(_field(event, "name") or "tool")
    tool_input: Dict[str, Any] = dict(_field(event, "input") or {})
    if event_type == "agent.mcp_tool_use":
        server = _field(event, "mcp_server_name")
        if server:
            tool_input.setdefault("mcp_server_name", server)

    result: Dict[str, Any] = {
        "type": "user.tool_confirmation",
        "tool_use_id": event_id,
        "result": "allow",
    }
    session_thread_id = _field(event, "session_thread_id")
    if session_thread_id:
        result["session_thread_id"] = session_thread_id

    g = gate or active()
    if g is None:
        result["result"] = "deny"
        result["deny_message"] = _no_gate_result()
        return result

    try:
        g.guard(tool_name, tool_input)
    except IntuticGateRefusal as exc:
        result["result"] = "deny"
        result["deny_message"] = str(exc)
    except Exception as exc:  # noqa: BLE001 - fail closed on ANY unexpected error
        result["result"] = "deny"
        result["deny_message"] = (
            f"[Intutic Governance] BLOCKED: gate crashed ({type(exc).__name__}: {exc}) — "
            "failing closed rather than allowing an unevaluated call."
        )
    return result


class IntuticSessionConfirmer:
    """Attaches Intutic governance to one Managed Agents session's
    confirmation pauses.

    Duck-typed on `client`: only `client.beta.sessions.events.list(session_id,
    ...)`, `.send(session_id, events=[...])`, and `.stream(session_id)` are
    ever called, matching every field/method name in the real
    `anthropic.Anthropic` / `anthropic.AsyncAnthropic`... — this module
    targets the SYNC client (`anthropic.Anthropic`), matching this package's
    synchronous `Gate.guard()`. No import of `anthropic` itself: pass any
    object exposing that shape (a real client, or a test double).

    Usage — polling (e.g. a cron/worker loop, or right after creating a
    session)::

        from anthropic import Anthropic
        from intutic_clawde.gate import Gate, GateConfig, install
        from intutic_clawde.gate.adapters.managed_agents import IntuticSessionConfirmer

        install(Gate(GateConfig()))
        client = Anthropic()
        confirmer = IntuticSessionConfirmer(client, session.id)
        confirmer.poll()   # answers every currently-pending tool_use/mcp_tool_use pause

    Usage — webhook (`session.requires_action`)::

        event = client.beta.webhooks.unwrap(raw_body, headers=request.headers)
        if event.data.type == "session.requires_action":
            IntuticSessionConfirmer(client, event.data.id).poll()

    Usage — live stream, single connection (see `watch()`'s doc for why this
    does not reconnect on its own)::

        for sent in confirmer.watch():
            print(sent["tool_use_id"], sent["result"])
    """

    def __init__(self, client: Any, session_id: str, *, gate: Optional[Gate] = None) -> None:
        self._client = client
        self.session_id = session_id
        self._gate = gate
        #: Tool-call event ids already answered (by this instance), so a
        #: `poll()` that overlaps a live `watch()` — or a re-delivered
        #: webhook — never double-sends a confirmation for the same id.
        self._answered: Set[str] = set()

    def _note_confirmation_event(self, event: Any) -> None:
        tool_use_id = _field(event, "tool_use_id")
        if tool_use_id:
            self._answered.add(tool_use_id)

    def handle_event(self, event: Any) -> Optional[Dict[str, Any]]:
        """Answer one event if it needs an answer; returns the sent params,
        or `None` if nothing was sent (already answered, or
        `confirmation_for_event` returned `None` — see its doc)."""
        event_id = _field(event, "id")
        if event_id is None or event_id in self._answered:
            return None
        confirmation = confirmation_for_event(event, gate=self._gate)
        if confirmation is None:
            return None
        self._client.beta.sessions.events.send(self.session_id, events=[confirmation])
        self._answered.add(event_id)
        return confirmation

    def poll(self, *, limit: int = 1000) -> List[Dict[str, Any]]:
        """List recent events and answer every unanswered
        `agent.tool_use`/`agent.mcp_tool_use` pause found. Returns the list of
        confirmation params sent, in event order.

        Filters the listing to the three event types this module reads
        (`types=[...]`), so a busy session's message/thinking/usage events
        never cross the wire for nothing.
        """
        sent: List[Dict[str, Any]] = []
        events = self._client.beta.sessions.events.list(
            self.session_id,
            limit=limit,
            types=["agent.tool_use", "agent.mcp_tool_use", "user.tool_confirmation"],
        )
        for event in events:
            if _field(event, "type") == "user.tool_confirmation":
                self._note_confirmation_event(event)
                continue
            confirmation = self.handle_event(event)
            if confirmation is not None:
                sent.append(confirmation)
        return sent

    def handle_webhook(self, unwrapped_event: Any) -> List[Dict[str, Any]]:
        """Answer the pause a `session.requires_action` webhook signalled.

        `unwrapped_event` is what `client.beta.webhooks.unwrap(raw_body,
        headers=...)` returns (or its `.data`, or a plain dict of the same
        shape — see `_field`'s doc). Anything other than a
        `session.requires_action` payload is a no-op (returns `[]`): this
        module only ever answers tool-confirmation pauses, so every other
        webhook event type is intentionally ignored here.

        The webhook payload carries only the session id — it does NOT carry
        the tool call itself (verified against
        `beta_webhook_session_requires_action_event_data.py`) — so this always
        falls through to a `poll()`.
        """
        data = _field(unwrapped_event, "data", unwrapped_event)
        if _field(data, "type") != "session.requires_action":
            return []
        webhook_session_id = _field(data, "id")
        if webhook_session_id is not None and webhook_session_id != self.session_id:
            raise ValueError(
                f"webhook session id {webhook_session_id!r} does not match this "
                f"confirmer's session_id {self.session_id!r}; construct a confirmer "
                "per session rather than reusing one across sessions"
            )
        return self.poll()

    def watch(self) -> Iterator[Dict[str, Any]]:
        """Catch up on anything already pending, then follow the live event
        stream, yielding each confirmation as it is sent.

        Ends when the session terminates (`session.status_terminated` /
        `session.deleted`) or the stream itself ends. Deliberately NOT a
        production-grade reconnect loop the way
        `anthropic.lib.tools.SessionToolRunner` is (reconnect with capped
        backoff, idle watchdog, partial-fulfillment bookkeeping — see that
        module's real implementation for the scope of what a fully robust
        version would need): a dropped connection here simply ends iteration.
        Wrap `watch()` in your own retry loop for a long-running confirmer, or
        prefer `poll()` from a webhook/cron trigger, which is naturally
        idempotent and needs no reconnect logic at all. See TD-428.
        """
        for confirmation in self.poll():
            yield confirmation
        with self._client.beta.sessions.events.stream(self.session_id) as stream:
            for event in stream:
                event_type = _field(event, "type")
                if event_type in _TERMINAL_EVENT_TYPES:
                    return
                if event_type == "user.tool_confirmation":
                    self._note_confirmation_event(event)
                    continue
                confirmation = self.handle_event(event)
                if confirmation is not None:
                    yield confirmation
