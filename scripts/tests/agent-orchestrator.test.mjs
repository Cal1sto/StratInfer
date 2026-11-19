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
    const gate = messages.at(-1).content.includes("QUALITY GATE");
    return { text: `RESULT ${role}\nNEXT continue${gate ? "\nVERDICT: PASS" : ""}`, payload: {} };
  }

  async saveSession(filename) {
    this.calls.push({ action: "save", filename });
    await fs.writeFile(path.join(this.memory.sessionsPath, filename), Buffer.alloc(256, 3));
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
  assert.equal((await client.chat([{ role: "user", content: "ping" }], { mcp: true })).text, "ready");
  await client.saveSession("tester.bin");
  await client.restoreSession("tester.bin");
  assert.deepEqual(requests.map((request) => request.url), [
    "/v1/chat/completions",
    "/slots/0?action=save",
    "/slots/0?action=restore",
  ]);
  assert.ok(requests.every((request) => request.authorization === "Bearer secret"));
  assert.equal(requests[0].body.strata_mcp, true);
  assert.equal(requests[0].body.chat_template_kwargs.enable_thinking, true);
});

test("quality workflow reaches release only after final gates pass", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stratinfer-workflow-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const memory = new ContextMemory({ root, project: "workflow", dimensions: 128, budgetBytes: 1024 * 1024 });
  await memory.init({ objective: "Converge on verified changes" });
  const workflowConfig = {
    ...config(),
    disk_sessions: false,
    default_roles: ["architect", "tester"],
    workflow: {
      initial_roles: ["architect"],
      gate_roles: ["tester"],
      remediation_role: "architect",
      final_gate_roles: ["tester"],
      final_roles: ["architect"],
      max_revision_cycles: 1,
    },
  };
  const client = new FakeClient(memory);
  const orchestrator = new AgentOrchestrator({ memory, client, config: workflowConfig });
  const outputs = await orchestrator.run({ task: "Implement safely", runId: "quality-run" });
  assert.deepEqual(outputs.map((output) => output.phase), [
    "foundation",
    "initial-review",
    "integration-0",
    "verification-0",
    "release",
  ]);
  assert.equal(outputs.find((output) => output.phase === "verification-0").verdict, "PASS");
  assert.equal((await memory.loadRun("quality-run")).status, "completed");
});

test("MCP stages get a tool-free conclusion when the first answer is incomplete", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stratinfer-conclusion-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const memory = new ContextMemory({ root, project: "conclusion", dimensions: 128, budgetBytes: 1024 * 1024 });
  await memory.init({ objective: "Always conclude quality gates" });
  const calls = [];
  const client = {
    async chat(messages, options) {
      calls.push({ messages, options });
      if (options.mcp) {
        return {
          text: "<tool_call>read more</tool_call>",
          payload: { choices: [{ message: { strata_mcp: [
            { event: "result", tool: "file_read", ok: true, text: "verified evidence" },
          ] } }] },
        };
      }
      return { text: "RESULT\nEvidence reviewed.\nDECISIONS\nNone.\nFILES\nNone.\nTESTS\nNone.\nRISKS\nNone.\nNEXT\nProceed.\nVERDICT: PASS", payload: {} };
    },
  };
  const gateConfig = {
    ...config(),
    disk_sessions: false,
    roles: { tester: { system: "tester-system", mcp: true } },
  };
  const orchestrator = new AgentOrchestrator({ memory, client, config: gateConfig });
  const output = await orchestrator.runStage({
    objective: "Verify the repository",
    stage: { role: "tester", phase: "verification", gate: true },
    handoff: "none",
    findings: "none",
    runId: "conclusion-run",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.mcp, true);
  assert.equal(calls[1].options.mcp, false);
  assert.match(calls[1].messages.at(-1).content, /verified evidence/);
  assert.equal(output.conclusion_retried, true);
  assert.equal(output.verdict, "PASS");
});

test("an incomplete detached gate conclusion fails closed", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stratinfer-blocked-conclusion-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const memory = new ContextMemory({ root, project: "blocked", dimensions: 128, budgetBytes: 1024 * 1024 });
  await memory.init({ objective: "Fail closed" });
  const client = {
    async chat() {
      return { text: "<tool_call>read again</tool_call>", payload: {} };
    },
  };
  const orchestrator = new AgentOrchestrator({
    memory,
    client,
    config: { ...config(), disk_sessions: false, roles: { tester: { system: "tester-system", mcp: true } } },
  });
  const output = await orchestrator.runStage({
    objective: "Verify",
    stage: { role: "tester", phase: "verification", gate: true },
    handoff: "<tool_call>old request</tool_call>",
    findings: "none",
    runId: "blocked-run",
  });
  assert.equal(output.conclusion_retried, true);
  assert.equal(output.verdict, "BLOCKED");
  assert.match(output.content, /No file modification is claimed/);
  assert.doesNotMatch(output.content, /<tool_call>/);
});

test("failed workflow resumes from the stored stage", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stratinfer-resume-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const memory = new ContextMemory({ root, project: "resume", dimensions: 128, budgetBytes: 1024 * 1024 });
  await memory.init({ objective: "Resume without losing completed work" });
  const client = new FakeClient(memory);
  let failed = false;
  const originalChat = client.chat.bind(client);
  client.chat = async (messages) => {
    if (!failed && messages[0].content === "tester-system") {
      failed = true;
      throw new Error("simulated interruption");
    }
    return originalChat(messages);
  };
  const orchestrator = new AgentOrchestrator({ memory, client, config: { ...config(), disk_sessions: false } });
  await assert.rejects(orchestrator.run({ task: "Continue reliably", runId: "resume-run" }), /simulated interruption/);
  assert.equal((await memory.loadRun("resume-run")).next_stage, 1);
  const outputs = await orchestrator.run({ task: "Continue reliably", runId: "resume-run", resume: true });
  assert.deepEqual(outputs.map((output) => output.role), ["architect", "tester"]);
  assert.equal((await memory.loadRun("resume-run")).status, "completed");
});
