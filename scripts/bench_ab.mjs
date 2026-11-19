#!/usr/bin/env node
// Fixed-suite A/B harness for a running Strata server. It never restarts the engine.
// Usage:
//   node scripts/bench_ab.mjs --label baseline [--repeat 2] [--out logs]
//   node scripts/bench_ab.mjs --compare "logs/run-*.json"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, chat, metricIds, metrics, option, positiveInt, sleep, waitForMetric } from "./lib/strata-api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SUITE = [
  { name: "code-8k", messages: [{ role: "user", content: "Write a complete streaming CSV parser in TypeScript (quotes and escapes), with tests. Return code only." }] },
  { name: "prose-2k", messages: [{ role: "user", content: "Write a 900-word science-fiction story about a sentimental GPU. Use a restrained style." }], max_tokens: 900 },
  { name: "agent-32k", messages: [
    { role: "system", content: "You are an auditor. Answer in no more than 200 words." },
    { role: "user", content: "CONTEXT:\n" + ("Strata pages MoE experts between VRAM, RAM and SSD. ".repeat(900)) + "\nQUESTION: what are the three hit-rate levers?" },
  ], max_tokens: 300 },
];

function wildcardRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function resolveCompareFiles(patterns) {
  const requested = patterns.length ? patterns : ["logs/run-*.json"];
  const found = new Set();
  for (const pattern of requested) {
    const absolute = isAbsolute(pattern) ? pattern : resolve(ROOT, pattern);
    if (!/[?*]/.test(absolute)) {
      if (!existsSync(absolute)) throw new Error(`comparison file not found: ${pattern}`);
      found.add(absolute);
      continue;
    }
    const folder = dirname(absolute);
    const matcher = wildcardRegex(basename(absolute));
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder)) if (matcher.test(file)) found.add(join(folder, file));
  }
  const files = [...found].sort();
  if (!files.length) throw new Error("no benchmark run matches --compare");
  return files;
}

function compareRuns(files) {
  const mean = (rows, key) => {
    const values = rows.map(row => row[key]).filter(Number.isFinite);
    return values.length ? +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2) : null;
  };
  return files.map(file => {
    const run = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(run.results)) throw new Error(`invalid run file: ${file}`);
    const offered = run.results.reduce((sum, row) => sum + (Number.isFinite(row.drafts_offered) ? row.drafts_offered : 0), 0);
    const accepted = run.results.reduce((sum, row) => sum + (Number.isFinite(row.drafts_accepted) ? row.drafts_accepted : 0), 0);
    return {
      file: basename(file), label: run.label, at: run.at,
      decode_tok_s: mean(run.results, "decode_tok_s"),
      hit_rate: mean(run.results, "hit_rate"),
      draft_accept: offered > 0 ? +(accepted / offered).toFixed(3) : null,
    };
  });
}

const args = process.argv.slice(2);
try {
  const compareIndex = args.indexOf("--compare");
  if (compareIndex >= 0) {
    console.log(JSON.stringify(compareRuns(resolveCompareFiles(args.slice(compareIndex + 1))), null, 2));
    process.exit(0);
  }

  const label = option(args, "--label", "run");
  const repeat = positiveInt(option(args, "--repeat", "2"), "--repeat");
  const outArg = option(args, "--out", "logs");
  const outDir = isAbsolute(outArg) ? outArg : resolve(ROOT, outArg);
  const fileLabel = label.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "run";

  const results = [];
  for (let trial = 1; trial <= repeat; ++trial) {
    for (const testCase of SUITE) {
      process.stderr.write(`[${label}] trial ${trial}/${repeat} ${testCase.name} ... `);
      const beforeIds = metricIds(await metrics());
      const response = await chat({ model: "strata", messages: testCase.messages,
        max_tokens: testCase.max_tokens ?? 512, temperature: 0 });
      const metric = await waitForMetric(beforeIds, response.usage);
      process.stderr.write(`decode=${metric.decode_tok_s ?? "-"} tok/s hit=${metric.hit_rate ?? "-"} drafts=${metric.drafts_accepted ?? "-"}/${metric.drafts_offered ?? "-"}\n`);
      results.push({
        trial, case: testCase.name, request_id: metric.id,
        output_tokens: response.usage?.completion_tokens, reused: metric.reused,
        prompt_read: metric.prompt_read, prompt_ms: metric.prompt_ms, decode_tok_s: metric.decode_tok_s,
        hit_rate: metric.hit_rate, drafts_offered: metric.drafts_offered, drafts_accepted: metric.drafts_accepted,
        finish: response.choices?.[0]?.finish_reason,
      });
      await sleep(3000);
    }
  }
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `run-${fileLabel}-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify({ label, base: BASE, at: new Date().toISOString(), results }, null, 2));
  console.error(`-> ${out}`);
} catch (error) {
  console.error(`bench_ab: ${error.message}`);
  process.exitCode = 1;
}
