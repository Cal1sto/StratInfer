#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { option } from "./lib/strata-api.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
const noemaBase = option(arguments_, "--noema-base", "http://127.0.0.1:12160").replace(/\/$/, "");
const moaiBase = option(arguments_, "--moai-base", "http://127.0.0.1:12150").replace(/\/$/, "");
const strataBase = option(arguments_, "--stratinfer-base", "http://127.0.0.1:11441").replace(/\/$/, "");
const tokenFile = path.resolve(option(arguments_, "--token-file", "E:/Data/NOEMA/control-token.txt"));
const profileFile = path.resolve(option(arguments_, "--profile", "E:/Data/JarvisMarc/StratInferRuntime/51f355f/profile.json"));
const campaignId = option(arguments_, "--campaign", "");
const outputArgument = option(arguments_, "--out", "reports/data/noema-2026-11-18/qualification");
const outputDirectory = path.isAbsolute(outputArgument) ? outputArgument : path.resolve(ROOT, outputArgument);
if (!campaignId) throw new Error("--campaign is required for the audited MOAI switch canary");

const token = readFileSync(tokenFile, "utf8").trim();
if (!token) throw new Error("NOEMA token file is empty");

function hashFile(file) {
  const value = readFileSync(file);
  return { path: file, bytes: value.length, sha256: createHash("sha256").update(value).digest("hex") };
}

function command(commandName, args, { allowFailure = false } = {}) {
  const started = performance.now();
  const result = spawnSync(commandName, args, { cwd: ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 ** 2 });
  const receipt = {
    command: [commandName, ...args],
    exitCode: result.status,
    signal: result.signal,
    elapsedMs: +(performance.now() - started).toFixed(1),
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message ?? null,
  };
  if (!allowFailure && (result.status !== 0 || result.error)) throw new Error(`command failed: ${commandName} ${args.join(" ")}\n${result.stderr || result.error?.message}`);
  return receipt;
}

async function jsonRequest(base, route, { method = "GET", authenticated = false, body, timeoutMs = 30_000 } = {}) {
  const started = performance.now();
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      accept: "application/json",
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { payload = { invalidJson: text.slice(0, 1000) }; }
  return { status: response.status, elapsedMs: +(performance.now() - started).toFixed(1), payload };
}

async function waitForSelection(id, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await jsonRequest(moaiBase, "/health");
    if (health.status === 200 && health.payload.textEngine?.selected === id && !health.payload.textEngine?.switching) return health.payload;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`MOAI did not settle on ${id}`);
}

function testFiles(folder) {
  return readdirSync(path.join(ROOT, folder)).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => path.join(folder, name));
}

const startedAt = new Date().toISOString();
const profile = JSON.parse(readFileSync(profileFile, "utf8"));
const helperIndex = Array.prototype.indexOf.call(profile.args, "--conversation-cache-mib");
const beforeHealth = (await jsonRequest(moaiBase, "/health")).payload;
const beforeMcp = await jsonRequest(strataBase, "/mcp");
const noemaHealth = await jsonRequest(noemaBase, "/health");
const noemaMoai = await jsonRequest(noemaBase, "/v1/moai/status", { authenticated: true });
const unauthorized = await jsonRequest(noemaBase, "/v1/campaigns", { method: "POST", body: { objective: "must be rejected", workspace: ROOT } });

const tests = command(process.execPath, ["--test", ...testFiles("scripts/tests"), ...testFiles("services/noema/tests")]);
const switchToStrata = await jsonRequest(noemaBase, `/v1/campaigns/${campaignId}/moai/text-engine`, { method: "POST", authenticated: true, body: { id: "strata" }, timeoutMs: 12 * 60_000 });
if (switchToStrata.status !== 200) throw new Error(`switch to Strata failed: ${JSON.stringify(switchToStrata.payload)}`);
await waitForSelection("strata");
const switchToStratInfer = await jsonRequest(noemaBase, `/v1/campaigns/${campaignId}/moai/text-engine`, { method: "POST", authenticated: true, body: { id: "stratinfer" }, timeoutMs: 12 * 60_000 });
if (switchToStratInfer.status !== 200) throw new Error(`switch to StratInfer failed: ${JSON.stringify(switchToStratInfer.payload)}`);
const afterHealth = await waitForSelection("stratinfer");
const afterMcp = await jsonRequest(strataBase, "/mcp");
const campaignEvents = await jsonRequest(noemaBase, `/v1/campaigns/${campaignId}/events`, { authenticated: true });
const gpu = command("nvidia-smi", ["--query-gpu=index,uuid,name,memory.total,memory.used,memory.free,utilization.gpu,power.draw", "--format=csv,noheader,nounits"]);
const gitHead = command("git", ["rev-parse", "HEAD"]);
const gitStatus = command("git", ["status", "--short"]);

const trustFiles = [
  "services/noema/src/core.mjs",
  "services/noema/src/store.mjs",
  "services/noema/src/server.mjs",
  "services/noema/src/resources.mjs",
  "services/noema/src/codex-app-server.mjs",
  "services/noema/src/worktree.mjs",
  "tools/noema_control_fastmcp.py",
  "scripts/start-noema.ps1",
  "scripts/stop-noema.ps1",
  "scripts/set-noema-resource-profile.ps1",
  "scripts/enable-noema-control.ps1",
  "scripts/bench_noema.mjs",
  "scripts/bench_fastmcp.mjs",
].map((file) => hashFile(path.join(ROOT, file)));

const receipt = {
  schema: 1,
  startedAt,
  completedAt: new Date().toISOString(),
  qualifiedTree: {
    gitHead: gitHead.stdout.trim(),
    dirty: Boolean(gitStatus.stdout.trim()),
    status: gitStatus.stdout.trim().split(/\r?\n/).filter(Boolean),
    trustFiles,
    profile: hashFile(profileFile),
  },
  configuration: {
    helperCacheMiB: Number(profile.env.STRATA_PARK_VRAM_MIB),
    helperDevice: Number(profile.env.STRATA_PARK_VRAM_DEVICE),
    hostCacheMiB: helperIndex >= 0 ? Number(profile.args[helperIndex + 1]) : null,
    mcpServers: Object.keys(profile.mcp_servers ?? {}),
  },
  tests,
  authentication: {
    unauthorizedMutationStatus: unauthorized.status,
    rejected: unauthorized.status === 403,
    tokenPersistedInReceipt: false,
  },
  live: {
    noemaHealth,
    noemaMoai,
    before: { moai: beforeHealth, mcp: beforeMcp },
    switchToStrata,
    switchToStratInfer,
    after: { moai: afterHealth, mcp: afterMcp },
    voicePidPreserved: {
      asr: beforeHealth.asr?.pid === afterHealth.asr?.pid,
      speech: beforeHealth.speech?.pid === afterHealth.speech?.pid,
    },
    campaignEvents,
    gpu,
  },
  rollback: {
    triggers: ["NOEMA health failure", "MCP server not ready", "voice PID change during text-only switch", "event-chain failure", "helper cache mismatch"],
    knownGoodProfileBackup: `${profileFile}.noema-mcp-20261118T104319.bak`,
    steps: [
      "Pause active campaigns and record the latest event sequence.",
      "Switch MOAI text engine to strata through the campaign-scoped endpoint.",
      "Stop NOEMA with scripts/stop-noema.ps1 so PID, executable, and start time are checked.",
      "Restore the known-good profile backup and keep MOAI helperVramBytes at 4294967296.",
      "Switch MOAI text engine back to stratinfer.",
      "Verify /health, both voice services, /mcp readiness, helper cap 4096 MiB, and a plain completion.",
    ],
  },
  boundaries: {
    network: "NOEMA and MOAI accept loopback HTTP only; NOEMA mutations require its bearer token.",
    codex: "Read-only app-server reviewer with approvalPolicy never.",
    worktree: "Path and command allowlist; not an OS/VM sandbox.",
    externalTargets: "R3/R4 promotion requires recorded human approval.",
  },
};

if (tests.exitCode !== 0) throw new Error("qualification tests failed");
if (!receipt.authentication.rejected) throw new Error("unauthorized mutation was not rejected");
if (beforeMcp.status !== 200 || afterMcp.status !== 200 || afterMcp.payload.servers?.some((server) => server.status !== "ready")) throw new Error("MCP readiness failed");
if (!receipt.live.voicePidPreserved.asr || !receipt.live.voicePidPreserved.speech) throw new Error("voice PID changed during the text-engine switch canary");
if (!campaignEvents.payload.chain?.valid) throw new Error("campaign event chain is invalid");
if (receipt.configuration.helperCacheMiB !== 4096) throw new Error("voice-balanced helper cache is not 4096 MiB");

mkdirSync(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, `noema-live-qualification-${Date.now()}.json`);
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ output, tests: { exitCode: tests.exitCode, elapsedMs: tests.elapsedMs }, voicePidPreserved: receipt.live.voicePidPreserved, mcpServers: receipt.configuration.mcpServers, unauthorizedStatus: unauthorized.status, helperCacheMiB: receipt.configuration.helperCacheMiB }, null, 2));
