import os
import json
from pathlib import Path
from typing import Dict, Any

def resolve_context() -> Dict[str, Any]:
    config_path = Path.home() / ".intutic" / "config.json"
    
    # 1. Primary: Read from sync-daemon config
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
                return {
                    "gitBranch": config.get("gitBranch"),
                    "jiraTicket": config.get("jiraTicket"),
                    "pagerdutyIncident": config.get("pagerdutyIncident"),
                    "ciPipeline": config.get("ciPipeline"),
                    "workingDirectory": config.get("workingDirectory", os.getcwd()),
                    "workspaceId": config.get("workspaceId"),
                    "sessionId": config.get("sessionId"),
                }
        except Exception:
            pass
            
    # 2. Fallback: Environment variables
    return {
        "workspaceId": os.environ.get("INTUTIC_WORKSPACE_ID"),
        "sessionId": os.environ.get("INTUTIC_SESSION_ID"),
        "gitBranch": os.environ.get("GIT_BRANCH"),
        "ciPipeline": os.environ.get("GITHUB_RUN_ID") 
            or os.environ.get("BUILDKITE_BUILD_ID") 
            or os.environ.get("CIRCLE_BUILD_NUM"),
        "pagerdutyIncident": os.environ.get("PD_INCIDENT_ID"),
        "workingDirectory": os.getcwd(),
    }
