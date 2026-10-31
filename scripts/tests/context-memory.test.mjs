import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContextMemory, featureVector, safeName } from "../lib/context-memory.mjs";

async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stratinfer-memory-"));
  const memory = new ContextMemory({ root, project: "Long Coding", dimensions: 128, ...options });
  await memory.init({ objective: "Keep the compiler migration correct", invariants: ["Never lose the main objective"] });
  return { root, memory };
}

test("feature matrix is normalized and deterministic", () => {
  const first = featureVector("CUDA context cache on RTX 4080", 128);
  const second = featureVector("CUDA context cache on RTX 4080", 128);
  assert.deepEqual(first, second);
  const norm = Math.sqrt([...first].reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-5);
});

test("canonical context is always present and relevant memory wins", async (context) => {
  const { root, memory } = await fixture();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await memory.remember({ kind: "decision", role: "architect", text: "Use cudaMemcpyPeerAsync for the RTX 4080 K/V cache", importance: 0.9 });
  await memory.remember({ kind: "fact", role: "documenter", text: "The README uses compact tables", importance: 0.2 });
  await memory.remember({ kind: "invariant", role: "main", text: "The active inference engine must never be stopped", importance: 1, pinned: true });
  const records = await memory.retrieve("How is CUDA K/V moved to the second GPU?", { role: "implementer", limit: 2 });
  assert.match(records[0].text, /active inference engine|cudaMemcpyPeerAsync/);
  assert.ok(records.some((record) => record.text.includes("cudaMemcpyPeerAsync")));
  const envelope = await memory.contextEnvelope("GPU cache", { role: "implementer", limit: 3 });
  assert.match(envelope, /Keep the compiler migration correct/);
  assert.match(envelope, /Never lose the main objective/);
  assert.match(envelope, /active inference engine must never be stopped/);
  const matrix = await fs.stat(memory.matrixFile);
  assert.equal(matrix.size, 3 * 128 * 4);
});

test("transcripts are isolated by specialist role", async (context) => {
  const { root, memory } = await fixture();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await memory.saveTranscript("architect", [{ role: "assistant", content: "architecture" }]);
  await memory.saveTranscript("tester", [{ role: "assistant", content: "tests" }]);
  assert.equal((await memory.loadTranscript("architect"))[0].content, "architecture");
  assert.equal((await memory.loadTranscript("tester"))[0].content, "tests");
});

test("SSD quota evicts LRU snapshots but preserves pinned state", async (context) => {
  const { root, memory } = await fixture();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const baseline = (await memory.status()).used_bytes;
  memory.budgetBytes = baseline + 800;
  await fs.writeFile(memory.snapshotPath("architect"), Buffer.alloc(400, 1));
  await memory.recordSnapshot("architect", { pinned: true });
  await fs.writeFile(memory.snapshotPath("tester"), Buffer.alloc(400, 2));
  await memory.recordSnapshot("tester", { pinned: false });
  const result = await memory.pruneSnapshots();
  assert.equal(await memory.hasSnapshot("architect"), true);
  assert.equal(await memory.hasSnapshot("tester"), false);
  assert.deepEqual(result.removed.map((entry) => entry.role), ["tester"]);
});

test("unsafe names cannot escape the memory root", () => {
  assert.equal(safeName("Reviewer Agent"), "reviewer-agent");
  assert.throws(() => safeName("../"), /invalid name/);
});

test("core, matrix and transcript survive a process restart", async (context) => {
  const { root, memory } = await fixture();
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await memory.remember({ kind: "decision", role: "main", text: "Retain exact K/V on the helper GPU", pinned: true });
  await memory.saveTranscript("reviewer", [{ role: "assistant", content: "No blocker" }]);
  const reopened = new ContextMemory({ root, project: "Long Coding", dimensions: 128 });
  assert.equal((await reopened.readCore()).objective, "Keep the compiler migration correct");
  assert.match((await reopened.contextEnvelope("helper GPU")), /Retain exact K\/V/);
  assert.equal((await reopened.loadTranscript("reviewer"))[0].content, "No blocker");
});
