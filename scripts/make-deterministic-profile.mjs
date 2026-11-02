#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { makeStrictDeterministicProfile } from "./lib/deterministic-profile.mjs";
import { option } from "./lib/strata-api.mjs";

const args = process.argv.slice(2);

try {
  const inputArg = option(args, "--input", null);
  const outputArg = option(args, "--output", null);
  if (!inputArg || !outputArg) throw new Error("usage: --input <profile.json> --output <profile.deterministic.json>");
  const input = resolve(inputArg);
  const output = resolve(outputArg);
  if (input === output) throw new Error("input and output must differ; keep the performance profile as rollback");
  const profile = JSON.parse(await readFile(input, "utf8"));
  const deterministic = makeStrictDeterministicProfile(profile);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(deterministic, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ input, output, mode: "strict-deterministic" }, null, 2));
} catch (error) {
  console.error(`make-deterministic-profile: ${error.message}`);
  process.exitCode = 1;
}
