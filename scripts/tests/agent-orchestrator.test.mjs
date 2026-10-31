import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentOrchestrator, StrataClient, trimTranscript } from "../lib/agent-orchestrator.mjs";
import { ContextMemory } from "../lib/context-memory.mjs";

class FakeClient {
  constructor(memory) {
    this.memory = memory;
    this.calls = [];
  }

  async chat(messages) {
    const role = messages[0].content;
    this.calls.push({ action: "chat", role, messages });
    return { text: `RESULT ${role}\nNEXT continue`, payload: {} };
  }

  async saveSession(filename) {
    this.calls.push({ action: "save", filename });
    const role = path.basename(filename, ".bin");
    await fs.writeFile(this.memory.snapshotPath(role), Buffer.alloc(256, 3));
    return { n_written: 256 };
  }

  async restoreSession(filename) {
    this.calls.push({ action: "restore", filename });
    return { n_restored: 1 };
  }
}

function config() {
  return {
    default_roles: ["architect", "tester"],
    roles: {
      architect: { system: "architect-system" },
      tester: { system: "tester-system" },
    },
    max_transcript_chars: 100000,
    memory_results: 4,
    memory_chars: 8000,
    max_memory_record_chars: 4000,
    max_handoff_chars: 2000,
    max_tokens: 1000,
    temperature: 0,
    disk_sessions: true,
    pinned_roles: ["architect"],
  };
}

test("specialists keep separate sessions and restore on the next run", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stratinfer-agents-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const memory = new ContextMemory({ root, project: "agents", dimensions: 128, budgetBytes: 1024 * 1024 });
  await memory.init({ objective: "Build a reliable long-session engine" });
  const client = new FakeClient(memory);
  const orchestrator = new AgentOrchestrator({ memory, client, config: config() });
  const first = await orchestrator.run({ task: "Implement and test context memory" });
  assert.deepEqual(first.map((entry) => entry.role), ["architect", "tester"]);
  assert.equal(first.some((entry) => entry.restored), false);
  const testerChat = client.calls.find((call) => call.action === "chat" && call.role === "tester-system");
  assert.match(testerChat.messages.at(-1).content, /RESULT architect-system/);
  assert.match(testerChat.messages.at(-1).content, /Build a reliable long-session engine/);
  client.calls.length = 0;
  const second = await orchestrator.run({ task: "Continue validation", roles: ["architect"] });
  assert.equal(second[0].restored, true);
  assert.deepEqual(client.calls.slice(0, 2).map((call) => call.action), ["restore", "chat"]);
  assert.equal((await memory.loadTranscript("tester")).length, 2);
});

test("transcript compaction keeps the newest turns", () => {
  const result = trimTranscript([
    { role: "user", content: "a".repeat(100) },
    { role: "assistant", content: "b".repeat(100) },
    { role: "user", content: "latest" },
    { role: "assistant", content: "answer" },
  ], 30);
  assert.equal(result.compacted, true);
  assert.deepEqual(result.messages.map((message) => message.content), ["latest", "answer"]);
});

test("Strata client uses chat and native slot session endpoints", async (context) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/chat/completions") {
        response.end(JSON.stringify({ choices: [{ message: { content: "ready" } }] }));
      } else {
        response.end(JSON.stringify({ n_written: 1234, n_restored: 42 }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const client = new StrataClient({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "secret", model: "qwen" });
  assert.equal((await client.chat([{ role: "user", content: "ping" }])).text, "ready");
  await client.saveSession("tester.bin");
  await client.restoreSession("tester.bin");
  assert.deepEqual(requests.map((request) => request.url), [
    "/v1/chat/completions",
    "/slots/0?action=save",
    "/slots/0?action=restore",
  ]);
  assert.ok(requests.every((request) => request.authorization === "Bearer secret"));
});
