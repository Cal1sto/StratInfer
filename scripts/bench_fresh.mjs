#!/usr/bin/env node
// bench_fresh.mjs — FRESH prompts every trial (unique timestamped marker in the content):
// mandatory once a conversation cache exists (a repeated prompt would re-read ~5 tokens
// instead of prefilling). Measures raw-prompt prefill speed.
// Usage: node bench_fresh.mjs --label C1-on --tokens 16000 --trials 3
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.STRATINFER_BASE || "http://127.0.0.1:11440";
const args = process.argv.slice(2);
const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : "run";
const tokens = +(args.includes("--tokens") ? args[args.indexOf("--tokens") + 1] : 16000);
const trials = +(args.includes("--trials") ? args[args.indexOf("--trials") + 1] : 3);

// ~10.5 tokens per filler-sentence repetition — adjust the loop for your tokenizer
const FILLER = "The Strata engine pages MoE experts between VRAM, RAM and SSD with a routing profile. ";
const reps = Math.ceil(tokens / 10.5);
const results = [];
for (let t = 1; t <= trials; t++) {
  const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = `MARKER ${marker} ` + FILLER.repeat(reps); // unique content => zero cache reuse
  const r0 = await (await fetch(BASE + "/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "strata", max_tokens: 8, temperature: 0,
      messages: [{ role: "user", content: body + "\nAnswer with the marker only." }] }),
    signal: AbortSignal.timeout(600_000),
  })).json();
  const m = (await (await fetch(BASE + "/metrics")).json()).requests?.[0] ?? {};
  const rate = m.prompt_read > 500 ? m.prompt_read * 1000 / m.prompt_ms : null;
  results.push({ trial: t, marker, prompt_total: m.prompt_total, prompt_read: m.prompt_read,
    prompt_ms: m.prompt_ms, prompt_tok_s: rate ? +rate.toFixed(0) : null,
    finish: r0.choices?.[0]?.finish_reason });
  console.error(`${label} trial ${t}: read=${m.prompt_read} in ${m.prompt_ms} ms -> ${rate ? rate.toFixed(0) : "?"} tok/s`);
}
const rates = results.map(r => r.prompt_tok_s).filter(Boolean);
const mean = rates.length ? +(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(0) : null;
mkdirSync(join(ROOT, "logs"), { recursive: true });
const out = join(ROOT, "logs", `fresh-${label}-${Date.now()}.json`);
writeFileSync(out, JSON.stringify({ label, tokens, at: new Date().toISOString(), mean_prompt_tok_s: mean, results }, null, 2));
console.error(`${label}: mean ${mean} tok/s -> ${out}`);
