#!/usr/bin/env node
// Summarizes paired Strata/StratInfer benchmark folders into one auditable JSON file.
// Usage: node scripts/summarize_comparison.mjs --root reports/data/<campaign> [--out summary.json]
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { option, percentile } from "./lib/strata-api.mjs";

const args = process.argv.slice(2);
const rootArg = option(args, "--root", "reports/data/strata-vs-stratinfer-2026-11-01");
const root = isAbsolute(rootArg) ? rootArg : resolve(rootArg);
const outArg = option(args, "--out", join(root, "summary.json"));
const out = isAbsolute(outArg) ? outArg : resolve(outArg);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function latest(folder, prefix) {
  const files = readdirSync(folder)
    .filter(file => file.startsWith(prefix) && file.endsWith(".json"))
    .map(file => join(folder, file))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  if (!files.length) throw new Error(`no ${prefix}*.json in ${folder}`);
  return files[0];
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function stats(values) {
  const numeric = values.filter(Number.isFinite);
  const average = mean(numeric);
  return {
    n: numeric.length,
    mean: round(average),
    median: round(percentile(numeric, 0.5)),
    min: round(Math.min(...numeric)),
    max: round(Math.max(...numeric)),
    standard_deviation: round(standardDeviation(numeric)),
    cv_pct: average === 0 ? null : round(standardDeviation(numeric) / average * 100),
  };
}

function pairedRelative(baseRows, testRows, key, identity) {
  const testById = new Map(testRows.map(row => [identity(row), row]));
  const deltas = baseRows.flatMap(base => {
    const test = testById.get(identity(base));
    return test && Number.isFinite(base[key]) && Number.isFinite(test[key]) && base[key] !== 0
      ? [(test[key] / base[key] - 1) * 100] : [];
  });
  const average = mean(deltas);
  const standardError = deltas.length > 1 ? standardDeviation(deltas) / Math.sqrt(deltas.length) : 0;
  const t95 = ({ 2: 12.706, 3: 4.303, 4: 3.182, 5: 2.776, 6: 2.571, 7: 2.447,
    8: 2.365, 9: 2.306, 10: 2.262, 15: 2.145 }[deltas.length] ?? 1.96);
  return {
    n: deltas.length,
    mean_pct: round(average),
    median_pct: round(percentile(deltas, 0.5)),
    ci95_low_pct: round(average - t95 * standardError),
    ci95_high_pct: round(average + t95 * standardError),
  };
}

function pct(test, base) {
  return round((test / base - 1) * 100);
}

const folders = { strata: join(root, "strata"), stratinfer: join(root, "stratinfer") };
const sourceFiles = {};
const arms = {};
for (const [arm, folder] of Object.entries(folders)) {
  sourceFiles[arm] = {
    fixed: latest(folder, "run-"),
    fresh: latest(folder, "fresh-"),
    concurrency: latest(folder, "concurrency-"),
    replay: latest(folder, "replay-"),
    quality: latest(folder, "quality-"),
    efficiency: latest(folder, "efficiency-"),
    determinism: latest(folder, "determinism-"),
  };
  arms[arm] = Object.fromEntries(Object.entries(sourceFiles[arm]).map(([name, file]) => [name, readJson(file)]));
}

const fixedCases = [...new Set(arms.strata.fixed.results.map(row => row.case))];
const fixed = fixedCases.map(testCase => {
  const baseRows = arms.strata.fixed.results.filter(row => row.case === testCase);
  const testRows = arms.stratinfer.fixed.results.filter(row => row.case === testCase);
  const base = stats(baseRows.map(row => row.decode_tok_s));
  const test = stats(testRows.map(row => row.decode_tok_s));
  return { case: testCase, strata: base, stratinfer: test, mean_gain_pct: pct(test.mean, base.mean),
    paired_gain: pairedRelative(baseRows, testRows, "decode_tok_s", row => row.trial) };
});

const fixedAllBase = arms.strata.fixed.results;
const fixedAllTest = arms.stratinfer.fixed.results;
const fixedBaseStats = stats(fixedAllBase.map(row => row.decode_tok_s));
const fixedTestStats = stats(fixedAllTest.map(row => row.decode_tok_s));
const freshBaseStats = stats(arms.strata.fresh.results.map(row => row.prompt_tok_s));
const freshTestStats = stats(arms.stratinfer.fresh.results.map(row => row.prompt_tok_s));

const concurrency = arms.strata.concurrency.summary.map(baseSummary => {
  const level = baseSummary.concurrency;
  const testSummary = arms.stratinfer.concurrency.summary.find(row => row.concurrency === level);
  const baseRows = arms.strata.concurrency.rows.filter(row => row.concurrency === level);
  const testRows = arms.stratinfer.concurrency.rows.filter(row => row.concurrency === level);
  return {
    concurrency: level,
    strata: baseSummary,
    stratinfer: testSummary,
    throughput_gain_pct: pct(testSummary.aggregate_tok_s_median, baseSummary.aggregate_tok_s_median),
    latency_p95_delta_pct: pct(testSummary.latency_p95_ms, baseSummary.latency_p95_ms),
    paired_throughput_gain: pairedRelative(baseRows, testRows, "aggregate_tok_s", row => row.trial),
  };
});

function replaySummary(report) {
  return {
    prompt_total: report.resumed.prompt_total,
    cold_prompt_ms: report.cold.prompt_ms,
    resumed_prompt_ms: report.resumed.prompt_ms,
    reused_tokens: report.resumed.reused,
    reuse_pct: round(report.resumed.reused / report.resumed.prompt_total * 100, 4),
    speedup_x: round(report.cold.prompt_ms / report.resumed.prompt_ms),
    exact_reuse: report.exact_reuse,
  };
}

const replay = { strata: replaySummary(arms.strata.replay), stratinfer: replaySummary(arms.stratinfer.replay) };
replay.cold_prompt_delta_pct = pct(replay.stratinfer.cold_prompt_ms, replay.strata.cold_prompt_ms);
replay.resumed_prompt_delta_pct = pct(replay.stratinfer.resumed_prompt_ms, replay.strata.resumed_prompt_ms);

const qualityLongContext = [...new Set(arms.strata.quality.rows
  .filter(row => row.category === "long-context").map(row => row.case))].map(testCase => {
  const baseRows = arms.strata.quality.rows.filter(row => row.case === testCase);
  const testRows = arms.stratinfer.quality.rows.filter(row => row.case === testCase);
  const baseLatency = stats(baseRows.map(row => row.latency_ms));
  const testLatency = stats(testRows.map(row => row.latency_ms));
  return { case: testCase, prompt_tokens: baseRows[0]?.prompt_tokens ?? null,
    strata_latency_ms: baseLatency, stratinfer_latency_ms: testLatency,
    mean_latency_delta_pct: pct(testLatency.mean, baseLatency.mean) };
});

const energyFields = ["ttft_ms_median", "ttft_ms_p95", "decode_tok_s_median", "wall_ms_median", "energy_j_median",
  "incremental_energy_j_median", "average_power_w_median", "peak_power_w", "tokens_per_joule_median",
  "incremental_tokens_per_joule_median", "peak_memory_mib"];
const energyDelta = Object.fromEntries(energyFields.map(field => [field, pct(
  arms.stratinfer.efficiency.summary[field], arms.strata.efficiency.summary[field])]));

const summary = {
  generated_at: new Date().toISOString(),
  sources: Object.fromEntries(Object.entries(sourceFiles).map(([arm, files]) => [arm,
    Object.fromEntries(Object.entries(files).map(([name, file]) => [name, relative(root, file).replaceAll("\\", "/")]))])),
  fixed_decode: {
    cases: fixed,
    overall: {
      strata: fixedBaseStats,
      stratinfer: fixedTestStats,
      mean_gain_pct: pct(fixedTestStats.mean, fixedBaseStats.mean),
      paired_gain: pairedRelative(fixedAllBase, fixedAllTest, "decode_tok_s", row => `${row.trial}:${row.case}`),
    },
  },
  fresh_prefill: {
    strata: freshBaseStats,
    stratinfer: freshTestStats,
    mean_gain_pct: pct(freshTestStats.mean, freshBaseStats.mean),
    paired_gain: pairedRelative(arms.strata.fresh.results, arms.stratinfer.fresh.results, "prompt_tok_s", row => row.trial),
  },
  concurrency,
  replay,
  quality: { strata: arms.strata.quality.summary, stratinfer: arms.stratinfer.quality.summary,
    long_context_latency: qualityLongContext },
  efficiency: {
    strata: arms.strata.efficiency.summary,
    stratinfer: arms.stratinfer.efficiency.summary,
    stratinfer_delta_pct: energyDelta,
  },
  determinism: {
    strata: { pass: arms.strata.determinism.pass, runs: arms.strata.determinism.observations.length,
      mismatches: arms.strata.determinism.mismatches.length },
    stratinfer: { pass: arms.stratinfer.determinism.pass, runs: arms.stratinfer.determinism.observations.length,
      mismatches: arms.stratinfer.determinism.mismatches.length },
  },
};

writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ out, fixed_decode_gain_pct: summary.fixed_decode.overall.mean_gain_pct,
  fresh_prefill_gain_pct: summary.fresh_prefill.mean_gain_pct,
  concurrency: summary.concurrency.map(row => ({ concurrency: row.concurrency, gain_pct: row.throughput_gain_pct,
    latency_delta_pct: row.latency_p95_delta_pct })),
  ttft_delta_pct: summary.efficiency.stratinfer_delta_pct.ttft_ms_median,
  tokens_per_joule_delta_pct: summary.efficiency.stratinfer_delta_pct.tokens_per_joule_median }, null, 2));
