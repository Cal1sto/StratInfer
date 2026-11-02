#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = path => JSON.parse(readFileSync(join(root, path), "utf8").replace(/^\uFEFF/, ""));
const round = (value, digits = 3) => Number(value.toFixed(digits));
const secondsForTokens = (tokens, tokensPerSecond) => tokens / tokensPerSecond;

const engine = read("reports/data/strata-vs-stratinfer-2026-11-01/summary.json");
const mcp = read("reports/data/fastmcp-2026-11-02/fastmcp-1793622017851.json");
const matrix = read("reports/data/strata-vs-stratinfer-2026-11-01/stratinfer/matrix-memory-10000x500.json");
const peer = read("reports/data/strata-vs-stratinfer-2026-11-01/stratinfer/peer-cache-live.json");

const efficiency = engine.efficiency;
const generationCounts = [1, 100, 1000].map(count => {
  const strataSeconds = efficiency.strata.wall_ms_median * count / 1000;
  const stratinferSeconds = efficiency.stratinfer.wall_ms_median * count / 1000;
  const strataEnergyJ = efficiency.strata.energy_j_median * count;
  const stratinferEnergyJ = efficiency.stratinfer.energy_j_median * count;
  return {
    count,
    output_tokens: 512 * count,
    strata_seconds: round(strataSeconds),
    stratinfer_seconds: round(stratinferSeconds),
    saved_seconds: round(strataSeconds - stratinferSeconds),
    strata_energy_j: round(strataEnergyJ, 2),
    stratinfer_energy_j: round(stratinferEnergyJ, 2),
    saved_energy_j: round(strataEnergyJ - stratinferEnergyJ, 2),
    saved_energy_wh: round((strataEnergyJ - stratinferEnergyJ) / 3600, 3),
  };
});

const fixedDecode = engine.fixed_decode.cases.map(row => {
  const tokens = 100_000;
  const strataSeconds = secondsForTokens(tokens, row.strata.mean);
  const stratinferSeconds = secondsForTokens(tokens, row.stratinfer.mean);
  return {
    case: row.case,
    output_tokens: tokens,
    strata_seconds: round(strataSeconds),
    stratinfer_seconds: round(stratinferSeconds),
    saved_seconds: round(strataSeconds - stratinferSeconds),
    measured_gain_pct: row.mean_gain_pct,
    ci95_low_pct: row.paired_gain.ci95_low_pct,
    ci95_high_pct: row.paired_gain.ci95_high_pct,
  };
});

const prefillTokens = 61_000;
const prefillStrataSeconds = secondsForTokens(prefillTokens, engine.fresh_prefill.strata.mean);
const prefillStratInferSeconds = secondsForTokens(prefillTokens, engine.fresh_prefill.stratinfer.mean);

const concurrency = engine.concurrency.map(row => {
  const tokens = 100_000;
  const strataSeconds = secondsForTokens(tokens, row.strata.aggregate_tok_s_median);
  const stratinferSeconds = secondsForTokens(tokens, row.stratinfer.aggregate_tok_s_median);
  return {
    concurrency: row.concurrency,
    output_tokens: tokens,
    strata_seconds: round(strataSeconds),
    stratinfer_seconds: round(stratinferSeconds),
    saved_seconds: round(strataSeconds - stratinferSeconds),
    throughput_gain_pct: row.throughput_gain_pct,
    strata_p95_ms: row.strata.latency_p95_ms,
    stratinfer_p95_ms: row.stratinfer.latency_p95_ms,
    p95_saved_ms: round(row.strata.latency_p95_ms - row.stratinfer.latency_p95_ms),
  };
});

const replay = {
  prompt_tokens: engine.replay.strata.prompt_total,
  cold_saved_ms: round(engine.replay.strata.cold_prompt_ms - engine.replay.stratinfer.cold_prompt_ms),
  resumed_penalty_ms: round(engine.replay.stratinfer.resumed_prompt_ms - engine.replay.strata.resumed_prompt_ms),
  resumed_penalty_100_runs_s: round((engine.replay.stratinfer.resumed_prompt_ms - engine.replay.strata.resumed_prompt_ms) / 10),
  exact_reuse_pct: engine.replay.stratinfer.reuse_pct,
};

const plain = mcp.summary.plain;
const advertised = mcp.summary["mcp-advertised"];
const tool = mcp.summary["mcp-tool"];
const mcpPolicies = [0, 5, 20, 50, 100].map(toolTurns => {
  const turns = 100;
  const plainTurns = turns - toolTurns;
  const selectiveMs = plainTurns * plain.wall_ms_median + toolTurns * tool.wall_ms_median;
  const alwaysMs = plainTurns * advertised.wall_ms_median + toolTurns * tool.wall_ms_median;
  const selectivePromptTokens = plainTurns * plain.prompt_tokens_median + toolTurns * tool.prompt_tokens_median;
  const alwaysPromptTokens = plainTurns * advertised.prompt_tokens_median + toolTurns * tool.prompt_tokens_median;
  return {
    turns,
    tool_turns: toolTurns,
    tool_rate_pct: toolTurns,
    selective_seconds: round(selectiveMs / 1000),
    always_on_seconds: round(alwaysMs / 1000),
    selective_saves_seconds: round((alwaysMs - selectiveMs) / 1000),
    selective_prompt_tokens: selectivePromptTokens,
    always_on_prompt_tokens: alwaysPromptTokens,
    selective_saves_prompt_tokens: alwaysPromptTokens - selectivePromptTokens,
  };
});

const report = {
  report_date: "2026-11-02",
  evidence: {
    measured: "Values copied from the published live engine and FastMCP campaigns.",
    projected: "Linear arithmetic over measured medians or means; not a separately executed workload.",
  },
  measured: {
    efficiency_512_tokens: efficiency,
    long_context: engine.quality.long_context_latency,
    quality: {
      strata: engine.quality.strata,
      stratinfer: engine.quality.stratinfer,
    },
    mcp: mcp.summary,
    matrix_memory: matrix,
    peer_cache: peer,
  },
  projections: {
    repeated_512_token_generations: generationCounts,
    fixed_decode_100k_output_tokens: fixedDecode,
    fresh_prefill_61k_tokens: {
      input_tokens: prefillTokens,
      strata_seconds: round(prefillStrataSeconds),
      stratinfer_seconds: round(prefillStratInferSeconds),
      saved_seconds: round(prefillStrataSeconds - prefillStratInferSeconds),
    },
    concurrent_100k_output_tokens: concurrency,
    exact_replay: replay,
    mcp_policy_100_turns: mcpPolicies,
    peer_copy_3_44_gib: {
      gib: 3.44,
      source_to_cache_ms: round(3.44 / peer.source_to_cache_gib_s * 1000),
      cache_to_source_ms: round(3.44 / peer.cache_to_source_gib_s * 1000),
      note: "Raw copy projection only; it excludes complete session restore work.",
    },
  },
};

const output = join(root, "reports/data/stratinfer-vs-strata-use-cases-2026-11-02/scenario-projections.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(output);
