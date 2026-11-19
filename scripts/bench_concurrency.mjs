#!/usr/bin/env node
// Measures aggregate decode throughput and latency as batch composition changes.
// Usage: node scripts/bench_concurrency.mjs --levels 1,2,4,8 --trials 3 --tokens 256
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, chat, option, percentile, positiveInt, sleep } from "./lib/strata-api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

try {
  const levels = option(args, "--levels", "1,2,4").split(",").map((value, index) => positiveInt(value, `--levels[${index}]`));
  const trials = positiveInt(option(args, "--trials", "3"), "--trials");
  const maxTokens = positiveInt(option(args, "--tokens", "256"), "--tokens");
  const outArg = option(args, "--out", "logs");
  const outDir = isAbsolute(outArg) ? outArg : resolve(ROOT, outArg);
  const rows = [];

  for (const concurrency of levels) {
    for (let trial = 1; trial <= trials; ++trial) {
      const started = performance.now();
      const requests = Array.from({ length: concurrency }, async (_, index) => {
        const requestStart = performance.now();
        const response = await chat({ model: "strata", temperature: 0, max_tokens: maxTokens,
          messages: [{ role: "user", content: `Concurrency ${concurrency}, trial ${trial}, lane ${index}: explain bounded cache replay with one example.` }] });
        return { latency_ms: performance.now() - requestStart, tokens: response.usage?.completion_tokens ?? 0 };
      });
      const completed = await Promise.all(requests);
      const wallMs = performance.now() - started;
      const outputTokens = completed.reduce((sum, row) => sum + row.tokens, 0);
      const latencies = completed.map(row => row.latency_ms);
      const row = { concurrency, trial, wall_ms: +wallMs.toFixed(1), output_tokens: outputTokens,
        aggregate_tok_s: +(outputTokens * 1000 / wallMs).toFixed(2),
        latency_p50_ms: +percentile(latencies, 0.5).toFixed(1), latency_p95_ms: +percentile(latencies, 0.95).toFixed(1) };
      rows.push(row);
      console.error(`c=${concurrency} trial=${trial}: ${row.aggregate_tok_s} tok/s, p95=${row.latency_p95_ms} ms`);
      await sleep(1000);
    }
  }
  const summary = levels.map(concurrency => {
    const group = rows.filter(row => row.concurrency === concurrency);
    return { concurrency,
      aggregate_tok_s_median: percentile(group.map(row => row.aggregate_tok_s), 0.5),
      latency_p95_ms: percentile(group.map(row => row.latency_p95_ms), 0.95) };
  });
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `concurrency-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify({ base: BASE, at: new Date().toISOString(), max_tokens: maxTokens, summary, rows }, null, 2));
  console.log(JSON.stringify({ summary, out }, null, 2));
} catch (error) {
  console.error(`bench_concurrency: ${error.message}`);
  process.exitCode = 1;
}
