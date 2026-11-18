#!/usr/bin/env node
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNoemaServer } from "../services/noema/src/server.mjs";
import { NoemaStore } from "../services/noema/src/store.mjs";
import { option, percentile, positiveInt } from "./lib/strata-api.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);

function median(values) {
  return percentile(values, 0.5);
}

function summarize(values) {
  const finite = values.filter(Number.isFinite);
  return {
    samples: finite.length,
    median_ms: +median(finite).toFixed(3),
    p95_ms: +percentile(finite, 0.95).toFixed(3),
    max_ms: +Math.max(...finite).toFixed(3),
    mean_ms: +(finite.reduce((sum, value) => sum + value, 0) / finite.length).toFixed(3),
  };
}

async function timed(operation) {
  const started = performance.now();
  const value = await operation();
  return { value, elapsed: performance.now() - started };
}

async function request(base, route, { method = "GET", token = "", body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json();
  return { status: response.status, body: payload };
}

async function measureSequential(count, operation) {
  const values = [];
  for (let index = 0; index < count; index += 1) values.push((await timed(() => operation(index))).elapsed);
  return values;
}

async function measureConcurrent(count, concurrency, operation) {
  const values = [];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < count) {
      const index = cursor;
      cursor += 1;
      values.push((await timed(() => operation(index))).elapsed);
    }
  });
  const wallStarted = performance.now();
  await Promise.all(workers);
  return { values, wallMs: performance.now() - wallStarted };
}

async function directoryBytes(folder) {
  let total = 0;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    total += (await stat(path.join(folder, entry.name))).size;
  }
  return total;
}

const healthTrials = positiveInt(option(arguments_, "--health-trials", "250"), "--health-trials");
const checkpointTrials = positiveInt(option(arguments_, "--checkpoints", "100"), "--checkpoints");
const memoryRecords = positiveInt(option(arguments_, "--memory-records", "1000"), "--memory-records");
const recallTrials = positiveInt(option(arguments_, "--recalls", "100"), "--recalls");
const concurrency = positiveInt(option(arguments_, "--concurrency", "16"), "--concurrency");
const outputArgument = option(arguments_, "--out", "reports/data/noema-2026-11-18/control-plane");
const outputDirectory = path.isAbsolute(outputArgument) ? outputArgument : path.resolve(ROOT, outputArgument);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "noema-bench-"));
const token = "benchmark-token";
const store = new NoemaStore({ root: temporaryRoot });
const runtime = createNoemaServer({ store, token, port: 0 });

try {
  const address = await runtime.listen();
  const base = `http://127.0.0.1:${address.port}`;
  for (let index = 0; index < 20; index += 1) await request(base, "/health");
  const memoryBefore = process.memoryUsage();

  const healthLatency = await measureSequential(healthTrials, async () => {
    const response = await request(base, "/health");
    if (response.status !== 200) throw new Error(`health returned ${response.status}`);
  });
  const metricsLatency = await measureSequential(healthTrials, async () => {
    const response = await request(base, "/metrics", { token });
    if (response.status !== 200) throw new Error(`metrics returned ${response.status}`);
  });
  const unauthorized = await measureSequential(25, async (index) => {
    const response = await request(base, "/v1/campaigns", { method: "POST", body: { objective: `Denied ${index}`, workspace: ROOT } });
    if (response.status !== 403) throw new Error(`unauthorized mutation returned ${response.status}`);
  });
  const concurrent = await measureConcurrent(healthTrials, concurrency, async () => {
    const response = await request(base, "/health");
    if (response.status !== 200) throw new Error(`concurrent health returned ${response.status}`);
  });

  const campaignResponse = await request(base, "/v1/campaigns", {
    method: "POST",
    token,
    body: { objective: "Benchmark NOEMA control-plane durability", workspace: ROOT, resourceProfile: "voice-balanced" },
  });
  if (campaignResponse.status !== 201) throw new Error(`campaign creation failed: ${JSON.stringify(campaignResponse.body)}`);
  const campaignId = campaignResponse.body.id;
  const checkpointLatency = await measureSequential(checkpointTrials, async (index) => {
    const response = await request(base, `/v1/campaigns/${campaignId}/checkpoints`, {
      method: "POST",
      token,
      body: { phase: `benchmark-${index}`, actor: "benchmark", summary: `Checkpoint ${index} with bounded evidence`, tests: [{ name: "synthetic", status: "passed" }], metrics: { index } },
    });
    if (response.status !== 201) throw new Error(`checkpoint ${index} returned ${response.status}`);
  });
  const eventLatency = await measureSequential(50, async () => {
    const response = await request(base, `/v1/campaigns/${campaignId}/events`, { token });
    if (response.status !== 200 || !response.body.chain?.valid) throw new Error("event chain verification failed");
  });

  const memoryStarted = performance.now();
  const memoryLatency = await measureSequential(memoryRecords, async (index) => {
    const response = await request(base, "/v1/memory", {
      method: "POST",
      token,
      body: {
        campaignId,
        kind: index % 10 === 0 ? "invariant" : "observation",
        role: `specialist-${index % 8}`,
        trust: index % 10 === 0 ? 1 : 0.7,
        content: `NOEMA memory record ${index}: checkpoint rollback invariant context shard ${index % 17} specialist ${index % 8}`,
        metadata: { index, shard: index % 17 },
      },
    });
    if (response.status !== 201) throw new Error(`memory ${index} returned ${response.status}`);
  });
  const memoryWallMs = performance.now() - memoryStarted;
  const recallLatency = await measureSequential(recallTrials, async (index) => {
    const query = encodeURIComponent(`rollback invariant context shard ${index % 17} specialist ${index % 8}`);
    const response = await request(base, `/v1/memory?campaignId=${campaignId}&limit=12&query=${query}`, { token });
    if (response.status !== 200 || response.body.records.length === 0) throw new Error(`recall ${index} returned no records`);
  });

  const finalMetrics = await request(base, "/metrics", { token });
  const memoryAfter = process.memoryUsage();
  const storageBytes = await directoryBytes(temporaryRoot);
  const report = {
    at: new Date().toISOString(),
    node: process.version,
    configuration: { healthTrials, checkpointTrials, memoryRecords, recallTrials, concurrency },
    latency: {
      health: summarize(healthLatency),
      authenticatedMetrics: summarize(metricsLatency),
      rejectedUnauthorizedMutation: summarize(unauthorized),
      concurrentHealth: { ...summarize(concurrent.values), wall_ms: +concurrent.wallMs.toFixed(3), requests_per_second: +(healthTrials / (concurrent.wallMs / 1000)).toFixed(1) },
      checkpointCommit: summarize(checkpointLatency),
      eventChainReadAndVerify: summarize(eventLatency),
      matrixMemoryCommit: summarize(memoryLatency),
      hybridRecall: summarize(recallLatency),
    },
    throughput: {
      checkpoint_commits_per_second: +(1000 / (checkpointLatency.reduce((sum, value) => sum + value, 0) / checkpointLatency.length)).toFixed(1),
      memory_commits_per_second: +(memoryRecords / (memoryWallMs / 1000)).toFixed(1),
    },
    resources: {
      rss_delta_mib: +((memoryAfter.rss - memoryBefore.rss) / 1024 ** 2).toFixed(2),
      heap_used_delta_mib: +((memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024 ** 2).toFixed(2),
      temporary_storage_mib: +(storageBytes / 1024 ** 2).toFixed(3),
      bytes_per_memory_record: Math.round(storageBytes / memoryRecords),
    },
    integrity: {
      unauthorized_mutations_rejected: 25,
      event_chain_valid: true,
      final_metrics: finalMetrics.body,
    },
  };
  await mkdir(outputDirectory, { recursive: true });
  const output = path.join(outputDirectory, `noema-control-plane-${Date.now()}.json`);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, report }, null, 2));
} finally {
  await runtime.close();
  store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
