#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, fetchJson, option, percentile, positiveInt, sleep } from "./lib/strata-api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);

function median(values) {
  return percentile(values.filter(Number.isFinite), 0.5);
}

async function completion(mode, trial) {
  const marker = `${mode}-${trial}-${Date.now()}`;
  const common = {
    model: "strata",
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
  };
  let payload;
  if (mode === "plain") {
    payload = { ...common, max_tokens: 64, messages: [{ role: "user", content: `Reply only READY. Marker ${marker}.` }] };
  } else if (mode === "mcp-advertised") {
    payload = { ...common, strata_mcp: true, max_tokens: 64,
      messages: [{ role: "user", content: `Do not call a tool. Reply only READY. Marker ${marker}.` }] };
  } else {
    payload = { ...common, strata_mcp: true, max_tokens: 512, messages: [{ role: "user",
      content: `Call runtime_snapshot exactly once. Reply only MCP_OK if health.loaded and mcp.ready are true. Marker ${marker}.` }] };
  }
  const started = performance.now();
  const response = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.text();
  const wallMs = performance.now() - started;
  if (!response.ok) throw new Error(`${mode} HTTP ${response.status}: ${body.slice(0, 500)}`);
  const parsed = JSON.parse(body);
  const message = parsed.choices?.[0]?.message ?? {};
  const events = message.strata_mcp ?? [];
  const result = events.find(event => event.event === "result");
  return {
    mode,
    trial,
    marker,
    wall_ms: +wallMs.toFixed(1),
    reply: message.content,
    finish_reason: parsed.choices?.[0]?.finish_reason,
    prompt_tokens: parsed.usage?.prompt_tokens ?? null,
    cached_tokens: parsed.usage?.prompt_tokens_details?.cached_tokens ?? null,
    completion_tokens: parsed.usage?.completion_tokens ?? null,
    predicted_tokens_final_round: parsed.timings?.predicted_n ?? null,
    decode_tok_s_final_round: parsed.timings?.predicted_per_second ?? null,
    mcp_events: events.length,
    tool_ms: result?.ms ?? null,
    tool_chars: result?.chars ?? null,
    tool_ok: result?.ok ?? null,
  };
}

function summarize(rows) {
  const successful = rows.filter(row => !row.error);
  return {
    successful: successful.length,
    total: rows.length,
    wall_ms_median: median(successful.map(row => row.wall_ms)),
    wall_ms_p95: percentile(successful.map(row => row.wall_ms).filter(Number.isFinite), 0.95),
    prompt_tokens_median: median(successful.map(row => row.prompt_tokens)),
    cached_tokens_median: median(successful.map(row => row.cached_tokens)),
    completion_tokens_median: median(successful.map(row => row.completion_tokens)),
    decode_tok_s_final_round_median: median(successful.map(row => row.decode_tok_s_final_round)),
    tool_ms_median: median(successful.map(row => row.tool_ms)),
    tool_chars_median: median(successful.map(row => row.tool_chars)),
  };
}

try {
  const trials = positiveInt(option(arguments_, "--trials", "7"), "--trials");
  const outArgument = option(arguments_, "--out", "reports/data/fastmcp-2026-11-02");
  const outDirectory = isAbsolute(outArgument) ? outArgument : resolve(ROOT, outArgument);
  const mcpStatus = await fetchJson("/mcp");
  if (mcpStatus.tools < 1 || mcpStatus.servers?.some(server => server.status !== "ready"))
    throw new Error(`MCP is not ready: ${JSON.stringify(mcpStatus)}`);

  const modes = ["plain", "mcp-advertised", "mcp-tool"];
  const warmups = [];
  for (const mode of modes) {
    warmups.push(await completion(mode, 0));
    await sleep(300);
  }

  const rows = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    for (const mode of modes) {
      try {
        const row = await completion(mode, trial);
        rows.push(row);
        console.error(`${mode} ${trial}/${trials}: ${row.wall_ms} ms, ${row.prompt_tokens} prompt tokens`);
      } catch (error) {
        rows.push({ mode, trial, error: error.message });
        console.error(`${mode} ${trial}/${trials}: ERROR ${error.message}`);
      }
      await sleep(300);
    }
  }

  const byMode = Object.fromEntries(modes.map(mode => [mode, summarize(rows.filter(row => row.mode === mode))]));
  const plain = byMode.plain;
  const advertised = byMode["mcp-advertised"];
  const called = byMode["mcp-tool"];
  const percent = (value, base) => base ? +((value / base - 1) * 100).toFixed(1) : null;
  const report = {
    at: new Date().toISOString(),
    base: BASE,
    trials,
    mcp_status: mcpStatus,
    summary: byMode,
    deltas: {
      advertised_wall_ms: +(advertised.wall_ms_median - plain.wall_ms_median).toFixed(1),
      advertised_wall_pct: percent(advertised.wall_ms_median, plain.wall_ms_median),
      advertised_prompt_tokens: advertised.prompt_tokens_median - plain.prompt_tokens_median,
      tool_call_wall_ms: +(called.wall_ms_median - plain.wall_ms_median).toFixed(1),
      tool_call_wall_pct: percent(called.wall_ms_median, plain.wall_ms_median),
      tool_call_prompt_tokens: called.prompt_tokens_median - plain.prompt_tokens_median,
    },
    warmups,
    rows,
  };
  mkdirSync(outDirectory, { recursive: true });
  const output = join(outDirectory, `fastmcp-${Date.now()}.json`);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, summary: report.summary, deltas: report.deltas }, null, 2));
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
