#!/usr/bin/env node
// Measures cold read then continuation reuse, the portable analogue of bounded replay.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, chat, metricIds, metrics, option, positiveInt, waitForMetric } from "./lib/strata-api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const FILLER = "A bounded replay policy retains a checkpoint and replays only the suffix needed for exact state restoration. ";

try {
  const tokens = positiveInt(option(args, "--tokens", "16000"), "--tokens");
  const continuations = positiveInt(option(args, "--continuations", "1"), "--continuations");
  const expectedBase = option(args, "--expect-base", null)?.replace(/\/$/, "");
  if (expectedBase && expectedBase !== BASE)
    throw new Error(`endpoint mismatch: STRATINFER_BASE=${BASE}, --expect-base=${expectedBase}`);
  const outArg = option(args, "--out", "logs");
  const outDir = isAbsolute(outArg) ? outArg : resolve(ROOT, outArg);
  const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const firstUser = `Marker ${marker}. ${FILLER.repeat(Math.ceil(tokens / 12))}\nReply with exactly: checkpoint-ready`;
  const firstMessages = [{ role: "user", content: firstUser }];

  const beforeCold = metricIds(await metrics());
  const coldResponse = await chat({ model: "strata", temperature: 0, max_tokens: 16, messages: firstMessages });
  const cold = await waitForMetric(beforeCold, coldResponse.usage);
  const continuationMessages = [...firstMessages];
  let assistant = coldResponse.choices?.[0]?.message?.content ?? "checkpoint-ready";
  const resumes = [];
  for (let index = 1; index <= continuations; ++index) {
    continuationMessages.push({ role: "assistant", content: assistant },
      { role: "user", content: `Continuation ${index}. Reply with exactly: replay-ready-${index}` });
    const beforeResume = metricIds(await metrics());
    const response = await chat({ model: "strata", temperature: 0, max_tokens: 16, messages: continuationMessages });
    const metric = await waitForMetric(beforeResume, response.usage);
    resumes.push({ index, request_id: metric.id, prompt_total: metric.prompt_total, prompt_read: metric.prompt_read,
      reused: metric.reused, prompt_ms: metric.prompt_ms });
    assistant = response.choices?.[0]?.message?.content ?? `replay-ready-${index}`;
  }
  const resumed = resumes[0];
  const report = {
    base: BASE, expected_base: expectedBase, at: new Date().toISOString(), marker, requested_tokens: tokens,
    cold: { request_id: cold.id, prompt_total: cold.prompt_total, prompt_read: cold.prompt_read,
      reused: cold.reused, prompt_ms: cold.prompt_ms },
    resumed,
    resumes,
    replay_fraction: resumed.prompt_total > 0 ? resumed.prompt_read / resumed.prompt_total : null,
    exact_reuse: resumed.reused > 0 && resumed.prompt_read < resumed.prompt_total,
  };
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `replay-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, out }, null, 2));
} catch (error) {
  console.error(`bench_replay: ${error.message}`);
  process.exitCode = 1;
}
