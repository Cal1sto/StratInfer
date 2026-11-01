#!/usr/bin/env node
// Fresh unique prompts: measures prefill without conversation-cache reuse.
// Usage: node scripts/bench_fresh.mjs --label C1-on --tokens 16000 --trials 3 [--out logs]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, chat, metricIds, metrics, option, positiveInt, sleep, waitForMetric } from "./lib/strata-api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const FILLER = "The Strata engine pages MoE experts between VRAM, RAM and SSD with a routing profile. ";

try {
  const label = option(args, "--label", "run");
  const tokens = positiveInt(option(args, "--tokens", "16000"), "--tokens");
  const trials = positiveInt(option(args, "--trials", "3"), "--trials");
  const outArg = option(args, "--out", "logs");
  const outDir = isAbsolute(outArg) ? outArg : resolve(ROOT, outArg);
  const fileLabel = label.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "run";
  const reps = Math.ceil(tokens / 10.5);
  const results = [];

  for (let trial = 1; trial <= trials; ++trial) {
    const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = `MARKER ${marker} ${FILLER.repeat(reps)}\nAnswer with the marker only.`;
    const beforeIds = metricIds(await metrics());
    const response = await chat({ model: "strata", max_tokens: 8, temperature: 0,
      messages: [{ role: "user", content: body }] });
    const metric = await waitForMetric(beforeIds, response.usage);
    const rate = metric.prompt_read > 500 && metric.prompt_ms > 0 ? metric.prompt_read * 1000 / metric.prompt_ms : null;
    results.push({ trial, request_id: metric.id, marker, prompt_total: metric.prompt_total,
      prompt_read: metric.prompt_read, reused: metric.reused, prompt_ms: metric.prompt_ms,
      prompt_tok_s: rate == null ? null : +rate.toFixed(0), finish: response.choices?.[0]?.finish_reason });
    console.error(`${label} trial ${trial}: read=${metric.prompt_read} in ${metric.prompt_ms} ms -> ${rate?.toFixed(0) ?? "?"} tok/s`);
    await sleep(1000);
  }

  const rates = results.map(row => row.prompt_tok_s).filter(Number.isFinite);
  const mean = rates.length ? +(rates.reduce((sum, value) => sum + value, 0) / rates.length).toFixed(0) : null;
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `fresh-${fileLabel}-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify({ label, base: BASE, tokens, at: new Date().toISOString(), mean_prompt_tok_s: mean, results }, null, 2));
  console.error(`${label}: mean ${mean ?? "?"} tok/s -> ${out}`);
} catch (error) {
  console.error(`bench_fresh: ${error.message}`);
  process.exitCode = 1;
}
