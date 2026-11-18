# ChatGPT export memory import

StratInfer can ingest a ChatGPT data-export ZIP into both durable memory layers without
changing model weights:

- long-session context memory, which injects relevant records into specialist prompts;
- FastMCP SQLite memory, which the model can query with `memory_recall` when a request
  enables `"strata_mcp": true`.

The importer reads `conversations-*.json` and `codex.json` directly from the export. It
keeps only visible user and assistant text on each conversation's selected branch.
System messages, tool traffic, hidden messages, abandoned response branches, account
PII and attachments are excluded.

Every record carries a stable source key and archive provenance. Reimporting the same
or a newer export does not duplicate messages already seen. Imported text is prefixed
as untrusted historical context so old prompts cannot silently become current
instructions or authorization. Historical assistant responses receive lower retrieval
importance than user messages because they may be outdated or incorrect.

## Import

Stop neither Strata nor FastMCP. SQLite WAL mode permits the bounded transactional
write while the local runtime is active.

```powershell
powershell -File scripts/import-chatgpt-export.ps1 `
  -Archive E:\Exports\chatgpt-data.zip `
  -Project personal-chatgpt-history `
  -FastMcpDb E:\Data\StratInferSessions\fastmcp-context.sqlite3
```

The command extracts only the structural JSON files into a guarded temporary directory,
hashes the original ZIP, creates a consistent FastMCP backup, imports both memories and
removes the temporary files. The source ZIP is never modified.

Use `-SkipContextMemory` or `-SkipFastMcp` to target one layer. Use
`-NoFastMcpBackup` only for a repeated idempotency check after a successful backed-up
import.

## Verify

The JSON report contains source counts, inserted counts, duplicate counts, destination
paths and the FastMCP backup path. A second import should report zero inserted records
and all records as duplicate sources.

```powershell
node scripts/long_session.mjs context `
  --project personal-chatgpt-history `
  --query "a topic from the archive"
```

For direct model recall, send an OpenAI-compatible request with `"strata_mcp": true`
and instruct the agent to call `memory_recall` before answering. Plain requests do not
advertise MCP tools and therefore do not consult the FastMCP archive automatically.

This is retrieval-augmented memory, not fine-tuning. It improves access to prior context
while retaining provenance and deletion/rollback boundaries; it does not teach facts
irreversibly into the model weights.
