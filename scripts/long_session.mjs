#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentOrchestrator, StrataClient } from "./lib/agent-orchestrator.mjs";
import { inspectCapacityHardware, planAgentCapacity } from "./lib/capacity-planner.mjs";
import { ContextMemory, GIB } from "./lib/context-memory.mjs";

function parseArguments(argv) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    const parsed = next !== undefined && !next.startsWith("--") ? argv[++index] : true;
    const current = options.get(key) ?? [];
    current.push(parsed);
    options.set(key, current);
  }
  return {
    command: positional[0] ?? "status",
    option(name, fallback = undefined) {
      const values = options.get(name);
      return values?.[values.length - 1] ?? fallback;
    },
    options(name) {
      return options.get(name) ?? [];
    },
  };
}

function expandPath(value) {
  let expanded = String(value)
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? `%${name}%`)
    .replace(/\$\{([^}]+)}/g, (_, name) => process.env[name] ?? `\${${name}}`);
  if (!path.isAbsolute(expanded)) expanded = path.resolve(expanded);
  return expanded;
}

async function loadConfiguration(file) {
  const config = JSON.parse(await fs.readFile(file, "utf8"));
  const required = ["api_url", "model", "roles", "default_roles", "ssd_budget_gib", "memory_root"];
  for (const key of required) if (config[key] === undefined) throw new Error(`missing config key: ${key}`);
  const configuredRoles = new Set(Object.keys(config.roles));
  for (const role of config.default_roles) if (!configuredRoles.has(role)) throw new Error(`default role is not configured: ${role}`);
  if (config.workflow) {
    const workflowRoles = [
      ...config.workflow.initial_roles,
      ...config.workflow.gate_roles,
      config.workflow.remediation_role,
      ...config.workflow.final_gate_roles,
      ...config.workflow.final_roles,
    ];
    for (const role of workflowRoles) if (!configuredRoles.has(role)) throw new Error(`workflow role is not configured: ${role}`);
    if (!Number.isInteger(config.workflow.max_revision_cycles) || config.workflow.max_revision_cycles < 0) {
      throw new Error("workflow.max_revision_cycles must be a non-negative integer");
    }
  }
  const staticPlan = planAgentCapacity(config);
  if (!staticPlan.viable) throw new Error(`invalid capacity configuration: ${staticPlan.errors.join("; ")}`);
  return config;
}

function print(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const configFile = path.resolve(args.option("config", path.join(here, "..", "configs", "long-session-4080.json")));
  const config = await loadConfiguration(configFile);
  const root = expandPath(process.env.STRATINFER_MEMORY_DIR ?? config.memory_root);
  const project = args.option("project", path.basename(process.cwd()));
  const memory = new ContextMemory({
    root,
    project,
    dimensions: config.matrix_dimensions,
    budgetBytes: Number(config.ssd_budget_gib) * GIB,
    minFreeBytes: Number(config.ssd_min_free_gib ?? 0) * GIB,
    maxRecords: Number(config.capacity?.matrix_max_records ?? 250_000),
    candidateRecords: Number(config.capacity?.matrix_candidate_records ?? 4096),
    recentRecords: Number(config.capacity?.matrix_recent_records ?? 2048),
    sessionsPath: config.engine_sessions_path ? expandPath(config.engine_sessions_path) : null,
  });

  if (args.command === "plan") {
    const hardware = await inspectCapacityHardware({
      storageRoot: root,
      helperDevice: Number(config.required_engine_env?.STRATA_PARK_VRAM_DEVICE ?? 1),
    });
    print(planAgentCapacity(config, hardware));
    return;
  }

  if (args.command === "init") {
    const constraints = args.options("constraint").map(String);
    const invariants = args.options("invariant").map(String);
    print(await memory.init({
      objective: String(args.option("objective", "")),
      constraints,
      invariants,
    }));
    return;
  }

  await memory.init();
  if (args.command === "remember") {
    print(await memory.remember({
      kind: args.option("kind", "fact"),
      role: args.option("role", "main"),
      text: args.option("text", ""),
      importance: Number(args.option("importance", 0.5)),
      pinned: args.option("pin", false) === true || args.option("pin") === "true",
    }));
    return;
  }
  if (args.command === "core") {
    const field = String(args.option("field", "")).trim();
    const text = String(args.option("text", "")).trim();
    if (!field || !text) throw new Error("core requires --field and --text");
    const arrays = new Set(["constraints", "invariants", "decisions", "accepted_results", "risks", "files", "next_actions"]);
    print(await memory.updateCore({ [field]: arrays.has(field) ? [text] : text }));
    return;
  }
  if (args.command === "context") {
    print(await memory.contextEnvelope(args.option("query", ""), {
      role: args.option("role", "main"),
      limit: Number(args.option("limit", config.memory_results)),
      maxChars: Number(args.option("max-chars", config.memory_chars)),
    }));
    return;
  }
  if (args.command === "prune") {
    print(await memory.pruneSnapshots());
    return;
  }
  if (args.command === "verify-matrix") {
    print(await memory.verifyMatrix({ repair: args.option("repair", false) === true || args.option("repair") === "true" }));
    return;
  }
  if (args.command === "status") {
    const hardware = await inspectCapacityHardware({
      storageRoot: root,
      helperDevice: Number(config.required_engine_env?.STRATA_PARK_VRAM_DEVICE ?? 1),
    });
    print({
      ...(await memory.status()),
      capacity_plan: planAgentCapacity(config, hardware),
      required_engine_env: config.required_engine_env,
      required_engine_args: config.required_engine_args,
      slot_save_path: memory.sessionsPath,
      default_roles: config.default_roles,
    });
    return;
  }
  if (args.command === "run" || args.command === "resume") {
    const apiKey = config.api_key_env ? process.env[config.api_key_env] ?? "" : "";
    const client = new StrataClient({
      baseUrl: process.env.STRATINFER_API_URL ?? config.api_url,
      apiKey,
      model: config.model,
      timeoutMs: config.timeout_ms,
    });
    const orchestrator = new AgentOrchestrator({ memory, client, config });
    const selectedRoles = args.option("roles", null);
    const roles = selectedRoles === null
      ? null
      : String(selectedRoles).split(",").map((role) => role.trim()).filter(Boolean);
    const resume = args.command === "resume" || args.option("resume", false) === true || args.option("resume") === "true";
    const runId = args.option("run-id", "");
    if (resume && !runId) throw new Error("resume requires --run-id");
    const stored = resume ? await memory.loadRun(runId) : null;
    const task = String(args.option("task", stored?.objective ?? ""));
    print(await orchestrator.run({ task, roles, ...(runId ? { runId } : {}), resume }));
    return;
  }
  throw new Error(`unknown command: ${args.command}`);
}

main().catch((error) => {
  process.stderr.write(`long_session: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
