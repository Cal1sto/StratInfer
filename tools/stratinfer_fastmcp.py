#!/usr/bin/env python3
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from mcp.server.fastmcp import FastMCP


WORKSPACE = Path(os.environ.get("STRATINFER_MCP_WORKSPACE", Path.cwd())).resolve()
MEMORY_DB = Path(os.environ.get("STRATINFER_MCP_MEMORY_DB", WORKSPACE / ".stratinfer-mcp" / "memory.sqlite3")).resolve()
MEMORY_MAX_BYTES = int(os.environ.get("STRATINFER_MCP_MEMORY_MAX_BYTES", str(32 * 1024 ** 3)))
BASE_URL = os.environ.get("STRATINFER_BASE", "http://127.0.0.1:11441").rstrip("/")
MAX_FILE_BYTES = 1_000_000
MAX_RESULT_CHARS = 24_000

base_parts = urlsplit(BASE_URL)
if base_parts.scheme != "http" or base_parts.hostname not in {"127.0.0.1", "localhost", "::1"}:
    raise RuntimeError("STRATINFER_BASE must be a loopback HTTP URL")
if MEMORY_MAX_BYTES < 1:
    raise RuntimeError("STRATINFER_MCP_MEMORY_MAX_BYTES must be positive")

mcp = FastMCP(
    "StratInfer FastMCP",
    instructions="Fast local tools for StratInfer coding agents. Workspace access is read-only and root-confined.",
    log_level="WARNING",
)


def _workspace_path(relative_path: str, *, require_file: bool = False) -> Path:
    candidate = (WORKSPACE / relative_path).resolve()
    try:
        candidate.relative_to(WORKSPACE)
    except ValueError as error:
        raise ValueError("path escapes the configured workspace") from error
    if require_file and not candidate.is_file():
        raise ValueError(f"file not found: {relative_path}")
    return candidate


def _get_json(path: str, timeout: float = 3.0) -> dict[str, Any]:
    request = urllib.request.Request(BASE_URL + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(MAX_RESULT_CHARS).decode("utf-8"))


def _run(arguments: list[str], timeout: float = 8.0) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment.update({"GIT_TERMINAL_PROMPT": "0", "GIT_PAGER": "cat", "PAGER": "cat"})
    return subprocess.run(
        arguments,
        cwd=WORKSPACE,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
        env=environment,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )


def _memory_connection() -> sqlite3.Connection:
    MEMORY_DB.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(MEMORY_DB, timeout=5.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY,
          created_at REAL NOT NULL,
          category TEXT NOT NULL,
          importance REAL NOT NULL,
          tags TEXT NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL UNIQUE
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content, category, tags, content='memories', content_rowid='id'
        );
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, category, tags)
          VALUES (new.id, new.content, new.category, new.tags);
        END;
        """
    )
    return connection


@mcp.tool()
def runtime_snapshot() -> dict[str, Any]:
    """Return live StratInfer health and native MCP status."""
    started = time.perf_counter()
    health = _get_json("/health")
    status = _get_json("/mcp")
    servers = status.get("servers", [])
    protocols = sorted({server.get("info", {}).get("protocol") for server in servers if server.get("info", {}).get("protocol")})
    return {
        "health": health,
        "mcp": {
            "ready": bool(servers) and all(server.get("status") == "ready" for server in servers),
            "servers": len(servers),
            "tools": status.get("tools", 0),
            "protocols": protocols,
            "settings": status.get("settings", {}),
        },
        "workspace": str(WORKSPACE),
        "memory": {
            "path": str(MEMORY_DB),
            "bytes": MEMORY_DB.stat().st_size if MEMORY_DB.exists() else 0,
            "max_bytes": MEMORY_MAX_BYTES,
        },
        "probe_ms": round((time.perf_counter() - started) * 1000, 2),
    }


@mcp.tool()
def code_search(query: str, relative_path: str = ".", glob: str = "", max_results: int = 40) -> dict[str, Any]:
    """Search workspace text with ripgrep; paths cannot leave the configured root."""
    if not query or len(query) > 500:
        raise ValueError("query must contain 1 to 500 characters")
    if len(glob) > 200:
        raise ValueError("glob must contain at most 200 characters")
    if not 1 <= max_results <= 200:
        raise ValueError("max_results must be between 1 and 200")
    target = _workspace_path(relative_path)
    if not target.exists():
        raise ValueError(f"path not found: {relative_path}")
    ripgrep = shutil.which("rg")
    if not ripgrep:
        raise RuntimeError("ripgrep is not installed")
    arguments = [ripgrep, "--line-number", "--column", "--no-heading", "--color", "never", "--hidden", "--glob", "!.git/**"]
    if glob:
        arguments.extend(["--glob", glob])
    arguments.extend(["--", query, str(target)])
    started = time.perf_counter()
    result = _run(arguments)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr.strip() or f"ripgrep failed with exit code {result.returncode}")
    matches = result.stdout.splitlines()[:max_results]
    return {
        "matches": matches,
        "count": len(matches),
        "truncated": len(result.stdout.splitlines()) > max_results,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
    }


@mcp.tool()
def file_read(relative_path: str, start_line: int = 1, max_lines: int = 200) -> dict[str, Any]:
    """Read a bounded UTF-8 text range from one workspace file."""
    if start_line < 1:
        raise ValueError("start_line must be positive")
    if not 1 <= max_lines <= 500:
        raise ValueError("max_lines must be between 1 and 500")
    path = _workspace_path(relative_path, require_file=True)
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f"file exceeds {MAX_FILE_BYTES} bytes")
    raw = path.read_bytes()
    if b"\0" in raw:
        raise ValueError("binary files are not supported")
    lines = raw.decode("utf-8", errors="replace").splitlines()
    selected = lines[start_line - 1:start_line - 1 + max_lines]
    return {
        "path": str(path.relative_to(WORKSPACE)),
        "start_line": start_line,
        "end_line": start_line + len(selected) - 1,
        "total_lines": len(lines),
        "text": "\n".join(selected)[:MAX_RESULT_CHARS],
    }


@mcp.tool()
def git_status() -> dict[str, Any]:
    """Return branch and concise Git status for the configured workspace."""
    result = _run(["git", "status", "--short", "--branch"], timeout=5.0)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git status failed")
    return {"workspace": str(WORKSPACE), "status": result.stdout.strip()}


@mcp.tool()
def memory_remember(content: str, category: str = "note", importance: float = 0.5, tags: str = "") -> dict[str, Any]:
    """Store one durable coding-memory record in the configured SSD database."""
    content = content.strip()
    category = category.strip().lower()
    tags = tags.strip().lower()
    if not 1 <= len(content) <= 8_000:
        raise ValueError("content must contain 1 to 8000 characters")
    if not re.fullmatch(r"[a-z0-9_-]{1,32}", category):
        raise ValueError("category must match [a-z0-9_-]{1,32}")
    if len(tags) > 1_000:
        raise ValueError("tags must contain at most 1000 characters")
    if not 0 <= importance <= 1:
        raise ValueError("importance must be between 0 and 1")
    memory_bytes = sum(Path(str(MEMORY_DB) + suffix).stat().st_size for suffix in ("", "-wal", "-shm") if Path(str(MEMORY_DB) + suffix).exists())
    if memory_bytes >= MEMORY_MAX_BYTES:
        raise RuntimeError(f"memory database reached its {MEMORY_MAX_BYTES}-byte budget")
    digest = hashlib.sha256(f"{category}\0{tags}\0{content}".encode("utf-8")).hexdigest()
    with _memory_connection() as connection:
        cursor = connection.execute(
            "INSERT OR IGNORE INTO memories(created_at, category, importance, tags, content, content_hash) VALUES(?, ?, ?, ?, ?, ?)",
            (time.time(), category, importance, tags, content, digest),
        )
        row = connection.execute("SELECT id, created_at FROM memories WHERE content_hash = ?", (digest,)).fetchone()
    return {"id": row["id"], "created_at": row["created_at"], "inserted": cursor.rowcount == 1, "sha256": digest}


@mcp.tool()
def memory_recall(query: str, limit: int = 8) -> dict[str, Any]:
    """Recall relevant durable coding-memory records from the SSD database."""
    if len(query) > 500:
        raise ValueError("query must contain at most 500 characters")
    terms = re.findall(r"[\w-]+", query.lower(), flags=re.UNICODE)
    if not terms:
        raise ValueError("query must contain searchable words")
    if not 1 <= limit <= 50:
        raise ValueError("limit must be between 1 and 50")
    expression = " OR ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in terms[:20])
    started = time.perf_counter()
    with _memory_connection() as connection:
        rows = connection.execute(
            """
            SELECT m.id, m.created_at, m.category, m.importance, m.tags, m.content, bm25(memories_fts) AS rank
            FROM memories_fts
            JOIN memories AS m ON m.id = memories_fts.rowid
            WHERE memories_fts MATCH ?
            ORDER BY rank, m.importance DESC, m.created_at DESC
            LIMIT ?
            """,
            (expression, limit),
        ).fetchall()
    return {
        "records": [dict(row) for row in rows],
        "count": len(rows),
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
    }


if __name__ == "__main__":
    mcp.run(transport="stdio")
