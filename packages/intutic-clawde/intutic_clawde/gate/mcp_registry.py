"""The MCP server registry and allowlist decisions, read from the policy snapshot.

A transliteration of packages/shared-types/src/mcpRegistryRecord.ts: the
registry decision (evaluateMcpRegistry), the allowlist decision
(evaluateMcpAllowlist), and the snapshot's @mcp_registry and @mcp_allowlist
records. The control plane's hook gate, the MCP proxy and the JavaScript hook
gates run the TypeScript; the bash hook gates and this package run this file,
and every one of them runs packages/shared-types/fixtures/mcp-registry-vectors.json,
so all of them refuse a call with the same code, rule id and reason.

The bash gates emit this file verbatim (services/sync-daemon/src/lib/mcpRegistryPy.ts
holds a byte-identical copy, which a test compares). It must stay
self-contained: the standard library only, no module state beyond the
constants below, and no backtick or dollar-brace, which the TypeScript copy
cannot hold.

Both records sit inside the snapshot's digest. When the digest fails, a gate
keeps what they refuse and drops what they admit: the registry loses its
approvals, and the allowlist admits no server and refuses at block.
"""

import base64
import json

MCP_REGISTRY_RECORD_TAG = "@mcp_registry"
MCP_ALLOWLIST_RECORD_TAG = "@mcp_allowlist"


def split_mcp_tool_name(tool):
    """(server, tool) for a harness name mcp__<server>__<tool>, else None.

    The server is the part before the first double underscore; the tool, the
    rest, may hold more of them.
    """
    if not isinstance(tool, str) or not tool.startswith("mcp__"):
        return None
    rest = tool[len("mcp__"):]
    sep = rest.find("__")
    if sep <= 0:
        return None
    return rest[:sep], rest[sep + 2:]


def _strings(value):
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def parse_registry(value):
    """The registry as the control plane sends it, or None for a non-object.

    Wrong-typed lists read as empty, and any default but deny as allow.
    """
    if not isinstance(value, dict):
        return None
    disabled = {}
    if isinstance(value.get("disabledTools"), dict):
        for server, tools in value["disabledTools"].items():
            names = _strings(tools)
            if names:
                disabled[server] = names
    return {
        "defaultPolicy": "deny" if value.get("defaultPolicy") == "deny" else "allow",
        "approvedServers": _strings(value.get("approvedServers")),
        "blockedServers": _strings(value.get("blockedServers")),
        "heldServers": _strings(value.get("heldServers")),
        "disabledTools": disabled,
    }


def decode_registry_record(line):
    """The @mcp_registry line's registry; None for another line or a damaged one."""
    parts = line.split("\t")
    if len(parts) != 2 or parts[0] != MCP_REGISTRY_RECORD_TAG or not parts[1]:
        return None
    try:
        return parse_registry(json.loads(base64.b64decode(parts[1], validate=True).decode("utf-8")))
    except Exception:
        return None


def evaluate_registry(registry, server, tool):
    """(code, rule_id, reason) refusing one MCP call, or None to let it continue.

    A blocked server, then a held one, then (under deny) one not approved,
    then a disabled tool.
    """
    if server in registry["blockedServers"]:
        return (
            "SERVER_BLOCKED",
            "mcp_registry." + server,
            "MCP server \"" + server + "\" is blocked in this workspace's MCP server registry. "
            "An owner or admin can change that on the MCP Servers page.",
        )
    if server in registry["heldServers"]:
        return (
            "SERVER_HELD",
            "mcp_registry." + server,
            "MCP server \"" + server + "\" changed its tools in a way scored high risk, and this workspace "
            "holds such a server until it is approved again. It is waiting in the approval queue on the MCP "
            "Servers page for an owner or admin.",
        )
    if registry["defaultPolicy"] == "deny" and server not in registry["approvedServers"]:
        return (
            "SERVER_NOT_APPROVED",
            "mcpDefaultPolicy",
            "MCP server \"" + server + "\" is not approved in this workspace's MCP server registry, "
            "and the workspace refuses unapproved servers (mcpDefaultPolicy: deny). It is waiting in "
            "the approval queue on the MCP Servers page for an owner or admin.",
        )
    if tool in registry["disabledTools"].get(server, []):
        return (
            "TOOL_DISABLED",
            "mcp_registry." + server + "." + tool,
            "Tool \"" + tool + "\" is disabled on MCP server \"" + server + "\" in this workspace's "
            "MCP server registry. An owner or admin can re-enable it on the MCP Servers page.",
        )
    return None


def decode_allowlist_record(line):
    """The @mcp_allowlist line as {"severity", "servers"}; None for another line.

    A severity other than shadow reads as block, so a damaged one refuses.
    """
    parts = line.split("\t")
    if len(parts) != 3 or parts[0] != MCP_ALLOWLIST_RECORD_TAG:
        return None
    return {
        "severity": "shadow" if parts[1] == "shadow" else "block",
        "servers": [s for s in parts[2].split(",") if s],
    }


def evaluate_allowlist(allowlist, server):
    """(code, rule_id, reason) for a server the allowlist does not name, else None.

    Under shadow the caller records the refusal instead of enforcing it.
    """
    if server in allowlist["servers"]:
        return None
    return (
        "SERVER_NOT_ALLOWED",
        "mcp_allowlist",
        "MCP server \"" + server + "\" is not on the MCP server allowlist for this workspace",
    )
