#!/usr/bin/env node
// bench_ab.mjs — A/B harness for StratInfer. Sends a FIXED suite of prompts to the engine
// and reads /metrics for decode_tok_s, hit_rate, drafts, reused.
// Restarts NOTHING: applying a config patch is a separate, scripted, consented cutover.
// Usage:
//   node bench_ab.mjs --label baseline [--repeat 2]
//   node bench_ab.mjs --label C3a-kv-k8v4 --repeat 2
// Compare afterwards: node bench_ab.mjs --compare   (aggregates every logs/run-*.json)
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.STRATINFER_BASE || "http://127.0.0.1:11440";

// Short but meaningful suite; extend with 16K/32K prompts to probe prefill paths.
// NOTE: under an aggressive prompt cache, EVERY repeated prompt here measures reuse,
// not prefill — use bench_fresh.mjs for honest prefill numbers.
const SUITE = [
  { name: "code-8k",  kind: "prompt", tokens: "compose",
    messages: [{ role: "user", content: "Write a complete CSV parser in TypeScript (quotes, escapes, streams), with tests. No explanations, code only." }] },
  { name: "prose-2k", kind: "decode",
    messages: [{ role: "user", content: "Tell a 900-word sci-fi story about a sentimental GPU. Sober style." }], max_tokens: 900 },
  { name: "agent-32k", kind: "prompt32k", // long prompt -> prefill/cache-sensitive
    messages: [
      { role: "system", content: "You are an auditor. Answer in at most 200 words." },
      { role: "user", content: "CONTEXT:\n" + ("Strata pages MoE experts between VRAM, RAM and SSD. ".repeat(900)) + "\nQUESTION: what are the three levers of hit_rate?" },
    ], max_tokens: 300 },
];

async function chat(m, maxTokens) {
  const r = await fetch(BASE + "/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "strata", messages: m, max_tokens: maxTokens, temperature: 0 }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function lastMetrics() {
  const m = await (await fetch(BASE + "/metrics")).json();
  return m.requests?.[0] ?? null;
}

const args = process.argv.slice(2);
if (args.includes("--compare")) {
  const files = readdirSync(join(ROOT, "logs")).filter(f => f.startsWith("run-") && f.endsWith(".json"))
    .map(f => join(ROOT, "logs", f));
  const agg = files.map(f => {
    const run = JSON.parse(readFileSync(f, "utf8"));
    const mean = (rows, k) => {
      const v = rows.map(r => r[k]).filter(x => typeof x === "number");
      return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null;
    };
    return { label: run.label, at: run.at,
      decode_tok_s: mean(run.results, "decode_tok_s"),
      hit_rate: mean(run.results, "hit_rate"),
      draft_accept: run.results.filter(r => r.drafts_offered).length
        ? +(run.results.reduce((a, r) => a + (r.drafts_accepted || 0), 0) /
            run.results.reduce((a, r) => a + (r.drafts_offered || 0), 0)).toFixed(3) : null };
  });
  console.log(JSON.stringify(agg, null, 2));
  process.exit(0);
}

const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : "run";
const repeat = +(args.includes("--repeat") ? args[args.indexOf("--repeat") + 1] : 2);

const results = [];
for (let i = 0; i < repeat; i++) {
  for (const t of SUITE) {
    process.stderr.write(`[${label}] trial ${i + 1}/${repeat} ${t.name} ... `);
    const r = await chat(t.messages, t.max_tokens ?? 512);
    const m = await lastMetrics();
    process.stderr.write(`decode=${m?.decode_tok_s} tok/s hit=${m?.hit_rate} drafts=${m?.drafts_accepted}/${m?.drafts_offered}\n`);
    results.push({ trial: i + 1, case: t.name,
      output_tokens: r.usage?.completion_tokens, reused: m?.reused,
      prompt_read: m?.prompt_read, prompt_ms: m?.prompt_ms, decode_tok_s: m?.decode_tok_s,
      hit_rate: m?.hit_rate, drafts_offered: m?.drafts_offered, drafts_accepted: m?.drafts_accepted,
      finish: r.choices?.[0]?.finish_reason });
    await new Promise(r => setTimeout(r, 3000)); // let the GPU breathe (shared with other local workloads)
  }
}
const out = join(ROOT, "logs", `run-${label}-${Date.now()}.json`);
mkdirSync(join(ROOT, "logs"), { recursive: true });
writeFileSync(out, JSON.stringify({ label, base: BASE, at: new Date().toISOString(), results }, null, 2));
console.error(`-> ${out}`);
