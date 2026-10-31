#!/usr/bin/env node
// DeepInfer-style deterministic and batch-invariant sampling check against a live server.
// The same seeded sampled request must be identical alone and beside unrelated requests.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, chat, finiteNumber, option, positiveInt } from "./lib/strata-api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const digest = text => createHash("sha256").update(text).digest("hex");

try {
  const seed = positiveInt(option(args, "--seed", "424242"), "--seed");
  const serial = positiveInt(option(args, "--serial", "3"), "--serial");
  const rounds = positiveInt(option(args, "--rounds", "4"), "--rounds");
  const concurrency = positiveInt(option(args, "--concurrency", "4"), "--concurrency");
  const maxTokens = positiveInt(option(args, "--tokens", "128"), "--tokens");
  const temperature = finiteNumber(option(args, "--temperature", "0.8"), "--temperature", 0.001, 5);
  const outArg = option(args, "--out", "logs");
  const outDir = isAbsolute(outArg) ? outArg : resolve(ROOT, outArg);
  const target = {
    model: "strata", seed, temperature, top_p: 0.95, max_tokens: maxTokens,
    messages: [{ role: "user", content: "Write a compact fictional incident report about a GPU scheduler. Include exactly five numbered findings." }],
  };
  const run = async payload => {
    const response = await chat(payload);
    const message = response.choices?.[0]?.message ?? {};
    const content = typeof message.content === "string" ? message.content :
      (typeof message.reasoning_content === "string" ? message.reasoning_content : message.reasoning);
    if (typeof content !== "string") throw new Error("chat response has no content or reasoning text");
    return { hash: digest(content), content, usage: response.usage };
  };

  const observations = [];
  for (let index = 0; index < serial; ++index) observations.push({ mode: "serial", index, ...(await run(target)) });
  const expected = observations[0].hash;
  for (let round = 0; round < rounds; ++round) {
    const noise = Array.from({ length: Math.max(0, concurrency - 1) }, (_, index) => chat({
      model: "strata", temperature: 0, max_tokens: 64,
      messages: [{ role: "user", content: `Noise request ${round}/${index}: list three cache invariants.` }],
    }));
    const targetPromise = run(target);
    const [sample] = await Promise.all([targetPromise, ...noise]);
    observations.push({ mode: "concurrent", round, concurrency, ...sample });
  }
  const mismatches = observations.filter(row => row.hash !== expected);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `determinism-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify({ base: BASE, at: new Date().toISOString(), seed, temperature,
    max_tokens: maxTokens, expected, pass: mismatches.length === 0,
    observations: observations.map(({ content, ...row }) => row), mismatches: mismatches.map(row => row.hash) }, null, 2));
  console.log(JSON.stringify({ pass: mismatches.length === 0, runs: observations.length,
    mismatches: mismatches.length, expected, out }, null, 2));
  if (mismatches.length) process.exitCode = 1;
} catch (error) {
  console.error(`verify_determinism: ${error.message}`);
  process.exitCode = 1;
}
