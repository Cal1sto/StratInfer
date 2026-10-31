#!/usr/bin/env node
// audit.mjs — READ-ONLY telemetry of a local Strata-family server.
// Writes nothing to the server, never restarts it. GET only.
// Usage:
//   node audit.mjs --once                 -> instant snapshot on stdout + logs/audit-<ts>.json
//   node audit.mjs --watch --every 300    -> continuous sampling -> logs/baseline.jsonl
//   node audit.mjs --report               -> aggregate logs/baseline.jsonl (mean/p95) on stdout
import { mkdirSync, readFileSync, appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGS = join(ROOT, "logs");
const BASE = process.env.STRATINFER_BASE || "http://127.0.0.1:11440";

async function get(path) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

function stats(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, mean: +mean.toFixed(2), p95: s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] };
}

function summarize(metrics) {
  const reqs = metrics.requests || [];
  const eng = metrics.engine || {};
  const num = (f) => reqs.map(r => r[f]).filter(v => typeof v === "number");
  const acceptRatio = reqs.filter(r => r.drafts_offered > 0)
    .map(r => r.drafts_accepted / r.drafts_offered);
  const reuseRatio = reqs.filter(r => r.prompt_total > 0)
    .map(r => r.reused / r.prompt_total);
  return {
    at: new Date().toISOString(),
    model: eng.model, engine: eng.engine,
    expert_cache_mib: eng.expert_cache_mib, expert_slots: eng.expert_slots,
    prefill_cap: eng.prefill_cap, pcie_frac: eng.pcie_frac,
    spec_effective: eng.spec, mtp_max: eng.mtp_max, spec_min_p: eng.spec_min_p,
    decode_tok_s: stats(num("decode_tok_s")),
    hit_rate: stats(num("hit_rate")),
    reused_ratio: stats(reuseRatio),
    draft_accept: stats(acceptRatio),
    requests_sampled: reqs.length,
    conversation_cache: metrics.conversation_cache ?? null,
  };
}

const args = process.argv.slice(2);
mkdirSync(LOGS, { recursive: true });

if (args.includes("--report")) {
  const f = join(LOGS, "baseline.jsonl");
  if (!existsSync(f)) { console.error("pas de baseline.jsonl — lancer --watch d'abord"); process.exit(1); }
  const rows = readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const agg = {};
  for (const k of ["decode_tok_s", "hit_rate", "reused_ratio", "draft_accept"]) {
    agg[k] = stats(rows.map(r => r[k]?.mean).filter(v => typeof v === "number"));
  }
  console.log(JSON.stringify({ samples: rows.length, window: [rows[0]?.at, rows.at(-1)?.at], agg }, null, 2));
  process.exit(0);
}

if (args.includes("--watch")) {
  const every = +(args[args.indexOf("--every") + 1] || 300) * 1000;
  const out = join(LOGS, "baseline.jsonl");
  console.error(`audit: ${BASE} every ${every / 1000}s -> ${out} (Ctrl-C to stop)`);
  for (;;) {
    try {
      const m = await get("/metrics");
      const s = summarize(m);
      appendFileSync(out, JSON.stringify(s) + "\n");
      console.error(`${s.at} reqs=${s.requests_sampled} decode=${s.decode_tok_s?.mean ?? "-"} hit=${s.hit_rate?.mean ?? "-"}`);
    } catch (e) { console.error(`erreur: ${e.message}`); }
    await new Promise(r => setTimeout(r, every));
  }
}

// --once (défaut)
const [health, metrics, status] = await Promise.all([
  get("/health").catch(e => ({ error: e.message })),
  get("/metrics").catch(e => ({ error: e.message })),
  get("/status").catch(e => ({ error: e.message })),
]);
if (metrics.error) { console.error(JSON.stringify(metrics)); process.exit(1); }
const s = summarize(metrics);
s.health = health; s.status = status;
const f = join(LOGS, `audit-${Date.now()}.json`);
writeFileSync(f, JSON.stringify(s, null, 2));
console.log(JSON.stringify(s, null, 2));
console.error(`-> ${f}`);
