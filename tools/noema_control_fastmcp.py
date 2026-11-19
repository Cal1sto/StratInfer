#!/usr/bin/env python3
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Literal

from mcp.server.fastmcp import FastMCP


BASE_URL = os.environ.get("NOEMA_BASE", "http://127.0.0.1:12160").rstrip("/")
TOKEN_FILE = os.environ.get("NOEMA_TOKEN_FILE", "")
TOKEN = os.environ.get("NOEMA_TOKEN", "")
if not TOKEN and TOKEN_FILE:
    TOKEN = open(TOKEN_FILE, "r", encoding="utf-8").read().strip()
parts = urllib.parse.urlsplit(BASE_URL)
if parts.scheme != "http" or parts.hostname not in {"127.0.0.1", "localhost", "::1"}:
    raise RuntimeError("NOEMA_BASE must be a loopback HTTP URL")
if not TOKEN:
    raise RuntimeError("NOEMA_TOKEN or NOEMA_TOKEN_FILE is required")

mcp = FastMCP(
    "NOEMA Control",
    instructions="Inspect and supervise NOEMA campaigns.",
    log_level="WARNING",
)


def _request(path: str, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        BASE_URL + path,
        data=data,
        method=method,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {TOKEN}",
            **({} if data is None else {"Content-Type": "application/json"}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=1800) as response:
            return json.loads(response.read(2_000_000).decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read(24_000).decode("utf-8", errors="replace")
        raise RuntimeError(f"NOEMA HTTP {error.code}: {detail}") from error


@mcp.tool()
def inspect(kind: Literal["campaign", "checkpoint", "candidate"], object_id: str) -> dict[str, Any]:
    """Read a campaign, checkpoint, or candidate."""
    routes = {
        "campaign": "/v1/campaigns/",
        "checkpoint": "/v1/checkpoints/",
        "candidate": "/v1/candidates/",
    }
    return _request(routes[kind] + urllib.parse.quote(object_id, safe=""))


@mcp.tool()
def review(campaign_id: str) -> dict[str, Any]:
    """Run the independent Codex checkpoint review."""
    return _request(f"/v1/campaigns/{urllib.parse.quote(campaign_id, safe='')}/review", "POST", {})


@mcp.tool()
def approval(campaign_id: str, action: dict[str, Any]) -> dict[str, Any]:
    """Request human approval for an R3/R4 action."""
    if not isinstance(action, dict):
        raise ValueError("action must be an object")
    return _request("/v1/approvals", "POST", {"campaignId": campaign_id, "action": action})


@mcp.tool()
def resource_plan(profile: str, helper_free_mib: int, helper_total_mib: int, host_free_gib: float) -> dict[str, Any]:
    """Plan memory without changing live resources."""
    return _request(
        "/v1/resources/plan",
        "POST",
        {
            "profile": profile,
            "helperFreeMiB": helper_free_mib,
            "helperTotalMiB": helper_total_mib,
            "hostFreeGiB": host_free_gib,
        },
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")
