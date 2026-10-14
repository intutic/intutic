import os
import json
from pathlib import Path
from typing import Dict, Any, Optional


def _str(v: Any) -> Optional[str]:
    """A non-empty string, or None."""
    return v if isinstance(v, str) and v else None


def resolve_context() -> Dict[str, Any]:
    """Each field comes from ~/.intutic/config.json when that file carries it,
    and from the environment otherwise. The file `intutic init` writes holds
    none of these fields, so reading it must not hide the environment."""
    config_path = Path.home() / ".intutic" / "config.json"

    config: Dict[str, Any] = {}
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                parsed = json.load(f)
            if isinstance(parsed, dict):
                config = parsed
        except Exception:
            pass  # unreadable: the environment alone decides

    return {
        "workspaceId": _str(config.get("workspaceId")) or os.environ.get("INTUTIC_WORKSPACE_ID"),
        "sessionId": _str(config.get("sessionId")) or os.environ.get("INTUTIC_SESSION_ID"),
        "gitBranch": _str(config.get("gitBranch")) or os.environ.get("GIT_BRANCH"),
        "jiraTicket": _str(config.get("jiraTicket")),
        "ciPipeline": _str(config.get("ciPipeline"))
            or os.environ.get("GITHUB_RUN_ID")
            or os.environ.get("BUILDKITE_BUILD_ID")
            or os.environ.get("CIRCLE_BUILD_NUM"),
        "pagerdutyIncident": _str(config.get("pagerdutyIncident")) or os.environ.get("PD_INCIDENT_ID"),
        "workingDirectory": _str(config.get("workingDirectory")) or os.getcwd(),
    }
