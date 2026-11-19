# FastMCP coding tools

StratInfer can start a local FastMCP server with the model runtime. The validated
deployment uses the Python MCP SDK 1.26, protocol revision `2025-06-18`, and the stdio
transport. It opens no additional TCP port.

## Architecture

1. MOAI starts StratInfer from its normal JSON profile.
2. Strata reads the profile's `mcp_servers` block and starts the pinned FastMCP script.
3. `GET /mcp` exposes server readiness and the six available tools.
4. A request with `"strata_mcp": true` gives those tools to Qwen.
5. Strata executes the selected tool, adds its bounded result to the conversation, and
   lets Qwen produce the final response.

Plain requests do not receive the tool schemas and follow the original inference path.
MOAI forwards the opt-in field, so the same mechanism works through its authenticated
OpenAI-compatible endpoint.

## Tools

| Tool | Access | Purpose |
|---|---|---|
| `runtime_snapshot` | local HTTP read | health, MCP readiness and memory budget |
| `code_search` | workspace read | bounded ripgrep search |
| `file_read` | workspace read | bounded UTF-8 line range |
| `git_status` | workspace read | branch and concise status |
| `memory_remember` | memory DB write | durable coding fact with category and importance |
| `memory_recall` | memory DB read | FTS5 lexical recall ranked with importance |

Tool names are exposed to the model with the `stratinfer__` namespace.

## Installation

Install the pinned MCP SDK into the Python used by the Strata server:

```powershell
python -m pip install -r requirements-mcp.txt
```

Apply the configuration with a backup:

```powershell
powershell -File scripts/enable-fastmcp.ps1 `
  -ProfileJson E:\Data\StratInferRuntime\profile.json `
  -PythonExe C:\Python312\python.exe `
  -MemoryDb E:\Data\StratInferSessions\fastmcp-context.sqlite3
```

The script validates the SDK, copies the server beside the runtime as a pinned artifact,
backs up the JSON profile, and writes these limits:

- 15-second tool and startup timeouts;
- 24,000 result characters;
- four model/tool rounds;
- 32 GiB maximum memory-database size;
- image results disabled.

Restart StratInfer transactionally through MOAI, then check:

```powershell
Invoke-RestMethod http://127.0.0.1:11441/mcp
python scripts/test-fastmcp.py --iterations 30
$env:STRATINFER_BASE = 'http://127.0.0.1:11441'
node scripts/bench_fastmcp.mjs --trials 10
```

## Request example

```json
{
  "model": "strata",
  "messages": [
    {"role": "user", "content": "Call git_status, then summarize the repository state."}
  ],
  "strata_mcp": true,
  "temperature": 0,
  "max_tokens": 512
}
```

Do not set `strata_mcp` on turns that cannot benefit from a tool. In the validated
10-trial run, advertising the schemas without calling a tool added 792 prompt tokens and
1,031.5 ms median wall time.

## Security

- FastMCP uses stdio and has no independent network listener.
- Workspace paths are resolved before access and must remain under the configured root.
- The code tools are read-only; no shell, arbitrary process, file-write or delete tool is
  exposed.
- Child commands receive a closed stdin, and Git prompts and pagers are disabled.
- Search, reads, result size, rounds and execution time are bounded.
- Durable writes are limited to the dedicated SQLite database on the SSD.
- The active Strata API remains bound to `127.0.0.1`; it must not be exposed without an
  API key and an additional authorization boundary.

Files and tool results can still contain prompt injection. Keep the workspace root
narrow, review new tools before deployment, and do not add side-effecting tools without
an explicit approval policy.

## Measured trade-off

| Mode | Median wall | p95 wall | Median prompt | Tool time |
|---|---:|---:|---:|---:|
| plain request | 172.8 ms | 314.2 ms | 35 tokens | n/a |
| MCP advertised, no tool | 1,204.3 ms | 1,228.2 ms | 827 tokens | n/a |
| one `runtime_snapshot` call | 2,016.8 ms | 2,131.6 ms | 1,154 tokens | 30 ms median |

The tool itself is cheap. The measurable cost is primarily schema prefill plus the
second model round needed to consume the tool result. The FastMCP process used 64.5 MiB
working set at idle and no GPU memory. LLM and vision canaries still passed after
activation, and the transactional restart preserved the Qwen3-ASR and Qwen3-TTS process
identities.

MCP calls are intentionally excluded from strict replay guarantees: tool data, Git state,
timestamps and external services can change even when text sampling is deterministic.

## Recovery and rollback

If the FastMCP child exits, Strata restarts it on the next call. The forced-exit test
returned a valid tool result under a new PID, and the SSD memory record remained
available after restart.

To disable MCP, restore the profile backup printed by `enable-fastmcp.ps1`, then perform
the same MOAI Strata to StratInfer transaction. The pinned script and memory database can
remain on disk; neither is used when `mcp_servers` is absent.
