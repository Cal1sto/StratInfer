#!/usr/bin/env node
// Measures streaming TTFT, decode throughput, board power and tokens/joule on GPU 0.
// Usage: node scripts/bench_efficiency.mjs --label strata --trials 5 --tokens 384 [--gpu 0] [--out logs]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, metricIds, metrics, option, percentile, positiveInt, sleep, waitForMetric } from "./lib/strata-api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function finiteOption(value, name, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) throw new Error(`${name} must be at least ${minimum}`);
  return parsed;
}

function median(values) {
  return percentile(values.filter(Number.isFinite), 0.5);
}

function queryGpu(index) {
  return new Promise(resolveSample => {
    const started = performance.now();
    const child = spawn("nvidia-smi", ["-i", String(index),
      "--query-gpu=power.draw,utilization.gpu,memory.used,temperature.gpu",
      "--format=csv,noheader,nounits"], { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.on("error", () => resolveSample(null));
    child.on("close", () => {
      const values = stdout.trim().split(/\r?\n/)[0]?.split(",").map(value => Number(value.trim()));
      if (!values || values.length < 4 || values.some(value => !Number.isFinite(value))) return resolveSample(null);
      resolveSample({ t_ms: (started + performance.now()) / 2, power_w: values[0], utilization_pct: values[1],
        memory_mib: values[2], temperature_c: values[3] });
    });
  });
}

async function collectIdle(index, seconds) {
  const samples = [];
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline) {
    const sample = await queryGpu(index);
    if (sample) samples.push(sample);
    await sleep(150);
  }
  return samples;
}

function integrate(samples, idlePower) {
  let joules = 0;
  let incrementalJoules = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const seconds = (current.t_ms - previous.t_ms) / 1000;
    joules += ((previous.power_w + current.power_w) / 2) * seconds;
    incrementalJoules += Math.max(0, ((previous.power_w + current.power_w) / 2) - idlePower) * seconds;
  }
  return { joules, incrementalJoules };
}

async function streamChat(payload, onSample) {
  const started = performance.now();
  const response = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let firstTokenMs = null;
  let firstContentMs = null;
  let firstTokenKind = null;
  let usage = null;
  let finish = null;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      const content = event.choices?.[0]?.delta?.content ?? "";
      const reasoning = event.choices?.[0]?.delta?.reasoning_content ?? "";
      if ((content || reasoning) && firstTokenMs == null) {
        firstTokenMs = performance.now() - started;
        firstTokenKind = content ? "content" : "reasoning";
      }
      if (content && firstContentMs == null) firstContentMs = performance.now() - started;
      output += content;
      usage = event.usage ?? usage;
      finish = event.choices?.[0]?.finish_reason ?? finish;
      if (onSample) onSample(event);
    }
  }
  return { output, usage, finish, ttft_ms: firstTokenMs, ttfc_ms: firstContentMs,
    first_token_kind: firstTokenKind, wall_ms: performance.now() - started };
}

try {
  const label = option(args, "--label", "run");
  const trials = positiveInt(option(args, "--trials", "5"), "--trials");
  const maxTokens = positiveInt(option(args, "--tokens", "384"), "--tokens");
  const gpu = finiteOption(option(args, "--gpu", "0"), "--gpu", 0);
  const idleSeconds = finiteOption(option(args, "--idle-seconds", "3"), "--idle-seconds", 1);
  const outArg = option(args, "--out", "logs");
  const outDir = isAbsolute(outArg) ? outArg : resolve(ROOT, outArg);
  const fileLabel = label.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "run";

  console.error(`${label}: measuring ${idleSeconds}s idle baseline on GPU ${gpu}`);
  const idleBefore = await collectIdle(gpu, idleSeconds);
  const rows = [];

  for (let trial = 1; trial <= trials; trial += 1) {
    const beforeIds = metricIds(await metrics());
    const samples = [];
    let collecting = true;
    const sampler = (async () => {
      while (collecting) {
        const sample = await queryGpu(gpu);
        if (sample) samples.push(sample);
        await sleep(100);
      }
      const finalSample = await queryGpu(gpu);
      if (finalSample) samples.push(finalSample);
    })();
    const marker = `${label}-${trial}-${Date.now()}`;
    const requestStarted = performance.now();
    try {
      const streamed = await streamChat({
        model: "strata",
        temperature: 0,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: `Marker ${marker}. Write a production-grade TypeScript bounded LRU cache with TTL, tests, and usage examples. Return code only and continue until the output limit.` }],
      });
      collecting = false;
      await sampler;
      const metric = await waitForMetric(beforeIds, streamed.usage);
      rows.push({
        trial,
        marker,
        ttft_ms: streamed.ttft_ms == null ? null : +streamed.ttft_ms.toFixed(1),
        ttfc_ms: streamed.ttfc_ms == null ? null : +streamed.ttfc_ms.toFixed(1),
        first_token_kind: streamed.first_token_kind,
        wall_ms: +streamed.wall_ms.toFixed(1),
        request_wall_ms: +(performance.now() - requestStarted).toFixed(1),
        output_tokens: metric.output_tokens ?? streamed.usage?.completion_tokens ?? null,
        decode_tok_s: metric.decode_tok_s ?? null,
        finish: streamed.finish,
        output_sha256: createHash("sha256").update(streamed.output).digest("hex"),
        samples,
      });
      console.error(`${label} trial ${trial}/${trials}: ttft=${rows.at(-1).ttft_ms}ms decode=${rows.at(-1).decode_tok_s} tok/s`);
    } catch (error) {
      collecting = false;
      await sampler;
      rows.push({ trial, marker, error: error.message, samples });
      console.error(`${label} trial ${trial}/${trials}: ERROR ${error.message}`);
    }
    await sleep(750);
  }

  console.error(`${label}: measuring final idle baseline`);
  const idleAfter = await collectIdle(gpu, idleSeconds);
  const idlePowerW = median([...idleBefore, ...idleAfter].map(sample => sample.power_w)) ?? 0;
  for (const row of rows) {
    if (row.error) continue;
    const { joules, incrementalJoules } = integrate(row.samples, idlePowerW);
    row.energy_j = +joules.toFixed(2);
    row.incremental_energy_j = +incrementalJoules.toFixed(2);
    row.average_power_w = row.samples.length ? +(row.samples.reduce((sum, sample) => sum + sample.power_w, 0) / row.samples.length).toFixed(2) : null;
    row.peak_power_w = row.samples.length ? Math.max(...row.samples.map(sample => sample.power_w)) : null;
    row.average_utilization_pct = row.samples.length ? +(row.samples.reduce((sum, sample) => sum + sample.utilization_pct, 0) / row.samples.length).toFixed(1) : null;
    row.peak_memory_mib = row.samples.length ? Math.max(...row.samples.map(sample => sample.memory_mib)) : null;
    row.tokens_per_joule = joules > 0 && row.output_tokens ? +(row.output_tokens / joules).toFixed(4) : null;
    row.incremental_tokens_per_joule = incrementalJoules > 0 && row.output_tokens ? +(row.output_tokens / incrementalJoules).toFixed(4) : null;
  }

  const successful = rows.filter(row => !row.error);
  const fieldMedian = field => median(successful.map(row => row[field]));
  const report = {
    label,
    base: BASE,
    at: new Date().toISOString(),
    gpu,
    max_tokens: maxTokens,
    idle_power_w: idlePowerW,
    idle_samples: { before: idleBefore, after: idleAfter },
    summary: {
      successful_requests: successful.length,
      total_requests: rows.length,
      request_success_rate: +(successful.length / rows.length).toFixed(4),
      ttft_ms_median: fieldMedian("ttft_ms"),
      ttft_ms_p95: percentile(successful.map(row => row.ttft_ms).filter(Number.isFinite), 0.95),
      ttfc_ms_median: fieldMedian("ttfc_ms"),
      decode_tok_s_median: fieldMedian("decode_tok_s"),
      wall_ms_median: fieldMedian("wall_ms"),
      energy_j_median: fieldMedian("energy_j"),
      incremental_energy_j_median: fieldMedian("incremental_energy_j"),
      average_power_w_median: fieldMedian("average_power_w"),
      peak_power_w: successful.length ? Math.max(...successful.map(row => row.peak_power_w).filter(Number.isFinite)) : null,
      tokens_per_joule_median: fieldMedian("tokens_per_joule"),
      incremental_tokens_per_joule_median: fieldMedian("incremental_tokens_per_joule"),
      peak_memory_mib: successful.length ? Math.max(...successful.map(row => row.peak_memory_mib).filter(Number.isFinite)) : null,
    },
    rows,
  };
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `efficiency-${fileLabel}-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ summary: report.summary, out }, null, 2));
  if (!successful.length) process.exitCode = 1;
} catch (error) {
  console.error(`bench_efficiency: ${error.message}`);
  process.exitCode = 1;
}
