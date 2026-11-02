#!/usr/bin/env python3
import argparse
import asyncio
import json
import os
import statistics
import sys
import tempfile
import time
from datetime import timedelta
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


EXPECTED_TOOLS = {
    "runtime_snapshot",
    "code_search",
    "file_read",
    "git_status",
    "memory_remember",
    "memory_recall",
}


async def run(arguments: argparse.Namespace) -> dict:
    root = Path(arguments.workspace).resolve()
    server = Path(arguments.server).resolve()
    memory = Path(tempfile.gettempdir()) / f"stratinfer-fastmcp-test-{os.getpid()}.sqlite3"
    for suffix in ("", "-shm", "-wal"):
        Path(str(memory) + suffix).unlink(missing_ok=True)
    env = dict(os.environ)
    env.update({
        "STRATINFER_MCP_WORKSPACE": str(root),
        "STRATINFER_MCP_MEMORY_DB": str(memory),
        "STRATINFER_BASE": arguments.base,
    })
    parameters = StdioServerParameters(command=arguments.python, args=[str(server)], cwd=root, env=env)
    async with stdio_client(parameters) as (reader, writer):
        async with ClientSession(reader, writer, read_timeout_seconds=timedelta(seconds=60)) as session:
            await session.initialize()
            print("FastMCP initialized", file=sys.stderr)
            listed = await session.list_tools()
            names = {tool.name for tool in listed.tools}
            missing = EXPECTED_TOOLS - names
            if missing:
                raise RuntimeError(f"missing tools: {sorted(missing)}")

            calls = [
                ("runtime_snapshot", {}),
                ("code_search", {"query": "StratInfer", "relative_path": "README.md", "max_results": 3}),
                ("file_read", {"relative_path": "README.md", "max_lines": 3}),
                ("git_status", {}),
                ("memory_remember", {"content": "FastMCP validation record", "category": "test", "importance": 0.8, "tags": "mcp,validation"}),
                ("memory_recall", {"query": "FastMCP validation", "limit": 3}),
            ]
            results = {}
            for name, payload in calls:
                print(f"checking {name}", file=sys.stderr)
                result = await session.call_tool(name, payload)
                if result.isError:
                    raise RuntimeError(f"{name} failed: {result.content}")
                results[name] = result.structuredContent

            escaped = await session.call_tool("file_read", {"relative_path": "..\\README.md"})
            if not escaped.isError:
                raise RuntimeError("file_read accepted a path outside the workspace")
            results["path_escape_rejected"] = True

            latencies = []
            for _ in range(arguments.iterations):
                started = time.perf_counter()
                result = await session.call_tool("git_status", {})
                if result.isError:
                    raise RuntimeError(f"latency call failed: {result.content}")
                latencies.append((time.perf_counter() - started) * 1000)

    for suffix in ("", "-shm", "-wal"):
        Path(str(memory) + suffix).unlink(missing_ok=True)
    ordered = sorted(latencies)
    return {
        "status": "passed",
        "tools": sorted(names),
        "checks": results,
        "git_status_latency_ms": {
            "iterations": len(latencies),
            "median": round(statistics.median(latencies), 3),
            "p95": round(ordered[max(0, int(len(ordered) * 0.95) - 1)], 3),
            "minimum": round(min(latencies), 3),
            "maximum": round(max(latencies), 3),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    repo = Path(__file__).resolve().parents[1]
    parser.add_argument("--python", default=os.environ.get("STRATINFER_PYTHON", os.sys.executable))
    parser.add_argument("--server", default=str(repo / "tools" / "stratinfer_fastmcp.py"))
    parser.add_argument("--workspace", default=str(repo))
    parser.add_argument("--base", default=os.environ.get("STRATINFER_BASE", "http://127.0.0.1:11441"))
    parser.add_argument("--iterations", type=int, default=25)
    arguments = parser.parse_args()
    if arguments.iterations < 1:
        parser.error("--iterations must be positive")
    print(json.dumps(asyncio.run(run(arguments)), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
