import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ARCHIVE_WARNING, loadChatgptExportDirectory } from "../lib/chatgpt-export.mjs";
import { ContextMemory } from "../lib/context-memory.mjs";
import { importFastMcpRecords } from "../lib/fastmcp-memory.mjs";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stratinfer-chatgpt-import-"));
  const conversations = [{
    id: "conversation-1",
    title: "Selected branch",
    current_node: "assistant-new",
    mapping: {
      root: { id: "root", parent: null, children: ["user"], message: { id: "system", author: { role: "system" }, content: { parts: ["hidden system"] } } },
      user: { id: "user", parent: "root", children: ["assistant-old", "assistant-new"], message: { id: "user-message", author: { role: "user" }, create_time: 1700000000, content: { parts: ["Remember my preferred compiler"] } } },
      "assistant-old": { id: "assistant-old", parent: "user", children: [], message: { id: "old-answer", author: { role: "assistant" }, recipient: "all", content: { parts: ["abandoned answer"] } } },
      "assistant-new": { id: "assistant-new", parent: "user", children: [], message: { id: "new-answer", author: { role: "assistant" }, recipient: "all", create_time: 1700000001, content: { parts: ["Use the selected compiler"] } } },
    },
  }];
  const codex = [{
    id: "codex-1",
    title: "Compiler task",
    turns: [{
      id: "turn-1",
      input_items: [{ type: "message", role: "user", content: [{ content_type: "text", text: "Inspect the build" }] }],
      output_items: [{ type: "message", role: "assistant", content: [{ content_type: "text", text: "Build inspected" }, { content_type: "repo_file_citation", path: "build.ps1" }] }],
    }],
  }];
  await fs.writeFile(path.join(root, "conversations-000.json"), JSON.stringify(conversations));
  await fs.writeFile(path.join(root, "codex.json"), JSON.stringify(codex));
  return root;
}

test("ChatGPT and Codex exports keep only visible selected text", async (context) => {
  const root = await fixture();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const loaded = await loadChatgptExportDirectory(root, { sourceId: "a".repeat(64), chunkChars: 6000 });
  assert.equal(loaded.stats.chatgpt_conversations, 1);
  assert.equal(loaded.stats.codex_threads, 1);
  assert.equal(loaded.stats.visible_messages, 4);
  assert.equal(loaded.records.length, 4);
  const combined = loaded.records.map((record) => record.text).join("\n");
  assert.match(combined, new RegExp(ARCHIVE_WARNING.split(" ")[0]));
  assert.match(combined, /preferred compiler/);
  assert.match(combined, /Build inspected/);
  assert.doesNotMatch(combined, /hidden system|abandoned answer|repo_file_citation/);
});

test("both StratInfer memories import idempotently", async (context) => {
  const root = await fixture();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const loaded = await loadChatgptExportDirectory(root, { sourceId: "b".repeat(64), chunkChars: 6000 });
  const memory = new ContextMemory({ root: path.join(root, "context"), project: "archive", dimensions: 128 });
  await memory.init();
  const firstContext = await memory.rememberMany(loaded.records);
  const secondContext = await memory.rememberMany(loaded.records);
  assert.equal(firstContext.inserted, 4);
  assert.equal(secondContext.inserted, 0);
  assert.equal(secondContext.skipped, 4);

  const databaseFile = path.join(root, "fastmcp.sqlite3");
  const firstFastMcp = await importFastMcpRecords({ databaseFile, records: loaded.records, createBackup: false });
  const secondFastMcp = await importFastMcpRecords({ databaseFile, records: loaded.records, createBackup: false });
  assert.equal(firstFastMcp.imported_sources, 4);
  assert.equal(secondFastMcp.imported_sources, 0);
  assert.equal(secondFastMcp.duplicate_sources, 4);
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT count(*) AS count FROM memories").get().count, 4);
    assert.equal(database.prepare("SELECT count(*) AS count FROM memory_sources").get().count, 4);
    assert.ok(database.prepare("SELECT count(*) AS count FROM memories_fts WHERE memories_fts MATCH 'compiler'").get().count >= 1);
  } finally {
    database.close();
  }
});
