import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { MoaiResourceClient, planResourceProfile } from "../src/resources.mjs";

async function fakeMoai(context, { failAsrRelease = false } = {}) {
  const state = { asr: true, speech: true, selected: "strata", calls: [] };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    state.calls.push(`${request.method} ${url.pathname}`);
    if (url.pathname !== "/health" && request.headers.authorization !== "Bearer admin-secret") {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Authentication required" }));
      return;
    }
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/health") return send(200, { asr: { ready: state.asr, busy: false, pending: 0 }, speech: { ready: state.speech, busy: false, pending: 0 } });
    if (url.pathname === "/api/status") return send(200, { telemetry: { gpus: [{ uuid: "helper", name: "NVIDIA GeForce RTX 4080 SUPER", totalBytes: 16_376 * 1024 ** 2, usedBytes: 1000 * 1024 ** 2, freeBytes: 15_376 * 1024 ** 2 }] } });
    if (url.pathname === "/api/text/engine" && request.method === "GET") return send(200, { selected: state.selected, choices: [{ id: "strata" }, { id: "stratinfer" }] });
    if (url.pathname === "/api/text/engine" && request.method === "POST") { const body = JSON.parse(await new Response(request).text()); state.selected = body.id; return send(200, { selected: state.selected }); }
    if (url.pathname === "/api/speech/release") { state.speech = false; return send(200, { ready: false }); }
    if (url.pathname === "/api/asr/release") {
      if (failAsrRelease) return send(409, { error: "ASR release failed" });
      state.asr = false;
      return send(200, { ready: false });
    }
    if (url.pathname === "/api/speech/prepare") { state.speech = true; return send(200, { ready: true }); }
    if (url.pathname === "/api/asr/prepare") { state.asr = true; return send(200, { ready: true }); }
    return send(404, { error: "unknown" });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { state, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test("agent-max preserves four GiB and sizes only measured free VRAM", () => {
  const plan = planResourceProfile({ profile: "agent-max", helperFreeMiB: 15_500, helperTotalMiB: 16_376, hostFreeGiB: 38 });
  assert.equal(plan.viable, true);
  assert.equal(plan.helper.cacheMiB, 10_240);
  assert.equal(plan.helper.reserveMiB, 4096);
  assert.equal(plan.helper.estimatedHotSnapshots, 4);
  assert.equal(plan.host.cacheMiB, 16_384);
});

test("unsafe helper capacity fails closed", () => {
  const plan = planResourceProfile({ profile: "agent-max", helperFreeMiB: 10_000, helperTotalMiB: 16_376, hostFreeGiB: 20 });
  assert.equal(plan.viable, false);
  assert.ok(plan.errors.length);
  assert.equal(plan.host.cacheMiB, 8192);
});

test("MOAI mutations authenticate, release voice transactionally and restore prior readiness", async (context) => {
  const fixture = await fakeMoai(context);
  const client = new MoaiResourceClient({ baseUrl: fixture.baseUrl, token: "admin-secret" });
  assert.equal((await client.helperGpuMemory()).freeMiB, 15_376);
  assert.equal((await client.activateTextEngine("stratinfer")).selected, "stratinfer");
  const released = await client.releaseVoice();
  assert.equal(fixture.state.asr, false);
  assert.equal(fixture.state.speech, false);
  await client.restoreVoice(released);
  assert.equal(fixture.state.asr, true);
  assert.equal(fixture.state.speech, true);
  assert.ok(fixture.state.calls.indexOf("POST /api/speech/release") < fixture.state.calls.indexOf("POST /api/asr/release"));
});

test("a partial MOAI release restores speech before failing", async (context) => {
  const fixture = await fakeMoai(context, { failAsrRelease: true });
  const client = new MoaiResourceClient({ baseUrl: fixture.baseUrl, token: "admin-secret" });
  await assert.rejects(client.releaseVoice(), /ASR release failed/);
  assert.equal(fixture.state.asr, true);
  assert.equal(fixture.state.speech, true);
  assert.ok(fixture.state.calls.includes("POST /api/speech/prepare"));
});

test("MOAI mutations fail before I/O without an administrator token", async () => {
  const client = new MoaiResourceClient({ baseUrl: "http://127.0.0.1:12150" });
  await assert.rejects(client.releaseVoice(), /administrator token/);
  assert.throws(() => client.activateTextEngine("stratinfer"), /administrator token/);
});
