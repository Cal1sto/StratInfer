import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNoemaServer } from "../src/server.mjs";
import { NoemaStore } from "../src/store.mjs";

async function request(base, route, { method = "GET", token = "", body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test("HTTP API authenticates mutations and completes a Codex-reviewed checkpoint", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noema-server-"));
  const store = new NoemaStore({ root });
  const codex = {
    stopped: false,
    async startThread({ cwd }) { assert.equal(cwd, process.cwd()); return "thread-test"; },
    async review() {
      return { verdict: "PASS", summary: "Qualified", findings: [], requiredCorrections: [], confidence: 0.9, riskClass: "R1" };
    },
    stop() { this.stopped = true; },
  };
  const runtime = createNoemaServer({ store, codex, token: "secret", port: 0 });
  const address = await runtime.listen();
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await runtime.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal((await request(base, "/health")).status, 200);
  assert.equal((await request(base, "/v1/campaigns", { method: "POST", body: { objective: "Denied", workspace: process.cwd() } })).status, 403);
  const created = await request(base, "/v1/campaigns", { method: "POST", token: "secret", body: { objective: "Validate HTTP orchestration", workspace: process.cwd() } });
  assert.equal(created.status, 201);
  const campaignId = created.body.id;
  const checkpoint = await request(base, `/v1/campaigns/${campaignId}/checkpoints`, {
    method: "POST",
    token: "secret",
    body: { phase: "architecture", actor: "architect", summary: "Complete checkpoint", tests: [{ name: "unit", status: "passed" }] },
  });
  assert.equal(checkpoint.status, 201);
  const review = await request(base, `/v1/campaigns/${campaignId}/review`, { method: "POST", token: "secret", body: {} });
  assert.equal(review.status, 200);
  assert.equal(review.body.decision.verdict, "PASS");
  const campaign = await request(base, `/v1/campaigns/${campaignId}`, { token: "secret" });
  assert.equal(campaign.body.status, "running");
  assert.equal(campaign.body.codexThread.turnCount, 1);
  const completed = await request(base, `/v1/campaigns/${campaignId}/complete`, { method: "POST", token: "secret", body: { reason: "qualified" } });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.status, "completed");
  const events = await request(base, `/v1/campaigns/${campaignId}/events`, { token: "secret" });
  assert.equal(events.body.chain.valid, true);
  assert.ok(events.body.events.some((event) => event.type === "checkpoint.reviewed"));
  const monitor = await request(base, "/api/agent/runs");
  assert.equal(monitor.body.tasks[0].id, campaignId);
  assert.equal(monitor.body.tasks[0].finalVerified, true);
});

test("resource planner is exposed without mutating GPU state", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noema-server-plan-"));
  const store = new NoemaStore({ root });
  const runtime = createNoemaServer({ store, token: "secret", port: 0 });
  const address = await runtime.listen();
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await runtime.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const plan = await request(base, "/v1/resources/plan", {
    method: "POST",
    token: "secret",
    body: { profile: "agent-max", helperFreeMiB: 15500, helperTotalMiB: 16376, hostFreeGiB: 40 },
  });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.helper.cacheMiB, 10240);
});

test("MOAI activation is authenticated, campaign-scoped and auditable", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noema-server-moai-"));
  const store = new NoemaStore({ root });
  const state = { selected: "strata" };
  const moai = {
    async health() { return { service: "MOAI", loaded: true }; },
    async textEngine() { return { selected: state.selected, choices: [{ id: "strata" }, { id: "stratinfer" }] }; },
    async activateTextEngine(id) { state.selected = id; return this.textEngine(); },
    async helperGpuMemory() { return { name: "RTX 4080", totalMiB: 16_376, freeMiB: 10_177, usedMiB: 6199 }; },
  };
  const runtime = createNoemaServer({ store, moai, token: "secret", port: 0 });
  const address = await runtime.listen();
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await runtime.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const created = await request(base, "/v1/campaigns", { method: "POST", token: "secret", body: { objective: "Activate StratInfer", workspace: process.cwd(), resourceProfile: "voice-balanced" } });
  const status = await request(base, "/v1/moai/status", { token: "secret" });
  assert.equal(status.status, 200);
  assert.equal(status.body.textEngine.selected, "strata");
  const activation = await request(base, `/v1/campaigns/${created.body.id}/moai/text-engine`, { method: "POST", token: "secret", body: { id: "stratinfer" } });
  assert.equal(activation.status, 200);
  assert.equal(activation.body.after.selected, "stratinfer");
  assert.equal(activation.body.rollback.id, "strata");
  const events = await request(base, `/v1/campaigns/${created.body.id}/events`, { token: "secret" });
  assert.ok(events.body.events.some((event) => event.type === "moai.text-engine-activated"));
});

test("agent-max fails before voice eviction until the helper engine is drained", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noema-server-drain-"));
  const store = new NoemaStore({ root });
  let releaseCalls = 0;
  const moai = {
    async textEngine() { return { selected: "stratinfer", choices: [{ id: "strata" }, { id: "stratinfer" }] }; },
    async releaseVoice() { releaseCalls += 1; return {}; },
  };
  const runtime = createNoemaServer({ store, moai, token: "secret", port: 0 });
  const address = await runtime.listen();
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await runtime.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const campaign = await request(base, "/v1/campaigns", { method: "POST", token: "secret", body: { objective: "Drain safely", workspace: process.cwd(), resourceProfile: "agent-max" } });
  const acquire = await request(base, `/v1/campaigns/${campaign.body.id}/resources/acquire`, { method: "POST", token: "secret", body: {} });
  assert.equal(acquire.status, 409);
  assert.match(acquire.body.error, /helper cache is drained/);
  assert.equal(releaseCalls, 0);
  const events = await request(base, `/v1/campaigns/${campaign.body.id}/events`, { token: "secret" });
  assert.ok(events.body.events.some((event) => event.type === "resource.acquire-failed"));
});

test("completion rejects missing, stale and invalid-chain qualification", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noema-server-completion-"));
  const store = new NoemaStore({ root });
  const runtime = createNoemaServer({ store, token: "secret", port: 0 });
  const address = await runtime.listen();
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await runtime.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const createCampaign = (objective) => store.createCampaign({ objective, workspace: process.cwd() });
  const pass = { verdict: "PASS", summary: "Qualified", findings: [], requiredCorrections: [], confidence: 0.9, riskClass: "R1" };

  const missing = createCampaign("Missing review");
  store.transitionCampaign(missing.id, "running");
  const missingResult = await request(base, `/v1/campaigns/${missing.id}/complete`, { method: "POST", token: "secret", body: {} });
  assert.equal(missingResult.status, 409);
  assert.match(missingResult.body.error, /no checkpoint/);

  const stale = createCampaign("Stale review");
  store.transitionCampaign(stale.id, "running");
  const reviewedCheckpoint = store.createCheckpoint(stale.id, { phase: "one", actor: "tester", summary: "Reviewed" });
  store.addReview(stale.id, reviewedCheckpoint.id, "codex", pass);
  store.createCheckpoint(stale.id, { phase: "two", actor: "tester", summary: "Changed after review" });
  const staleResult = await request(base, `/v1/campaigns/${stale.id}/complete`, { method: "POST", token: "secret", body: {} });
  assert.equal(staleResult.status, 409);
  assert.match(staleResult.body.error, /current checkpoint/);

  const corrupted = createCampaign("Corrupted chain");
  store.transitionCampaign(corrupted.id, "running");
  const current = store.createCheckpoint(corrupted.id, { phase: "final", actor: "tester", summary: "Reviewed" });
  store.addReview(corrupted.id, current.id, "codex", pass);
  store.database.prepare("UPDATE events SET hash = ? WHERE campaign_id = ? AND seq = (SELECT MIN(seq) FROM events WHERE campaign_id = ?)")
    .run("f".repeat(64), corrupted.id, corrupted.id);
  const corruptedResult = await request(base, `/v1/campaigns/${corrupted.id}/complete`, { method: "POST", token: "secret", body: {} });
  assert.equal(corruptedResult.status, 409);
  assert.match(corruptedResult.body.error, /valid event chain/);
});
