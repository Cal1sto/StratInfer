import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredArgument(config, name, fallback) {
  const args = config.required_engine_args ?? [];
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? finiteNumber(args[index + 1], fallback) : fallback;
}

export function estimateSnapshotBytes(contextTokens, {
  bytesPerToken = 16_333,
  safetyFactor = 1.2,
} = {}) {
  return Math.ceil(positiveInteger(contextTokens, 1) * finiteNumber(bytesPerToken, 16_333) * finiteNumber(safetyFactor, 1.2));
}

export function planAgentCapacity(config, hardware = {}) {
  const capacity = config.capacity ?? {};
  const roles = Object.keys(config.roles ?? {});
  const targetAgents = positiveInteger(capacity.target_agents, roles.length || 1);
  const targetContextTokens = positiveInteger(capacity.target_context_tokens_per_agent, 131_072);
  const modelContextTokens = positiveInteger(capacity.model_context_tokens, 524_288);
  const snapshotBytes = estimateSnapshotBytes(targetContextTokens, {
    bytesPerToken: capacity.snapshot_bytes_per_token,
    safetyFactor: capacity.snapshot_safety_factor,
  });
  const ssdBudgetBytes = finiteNumber(config.ssd_budget_gib, 32) * GIB;
  const ssdMetadataReserveBytes = finiteNumber(capacity.ssd_metadata_reserve_gib, 4) * GIB;
  const snapshotBudgetBytes = Math.max(0, ssdBudgetBytes - ssdMetadataReserveBytes);
  const helperVramBytes = finiteNumber(capacity.helper_vram_mib, finiteNumber(config.required_engine_env?.STRATA_PARK_VRAM_MIB, 0)) * MIB;
  const hostCacheBytes = finiteNumber(capacity.host_cache_mib, configuredArgument(config, "--conversation-cache-mib", 0)) * MIB;
  const helperReserveBytes = finiteNumber(capacity.helper_vram_min_free_mib, 4096) * MIB;
  const hostReserveBytes = finiteNumber(capacity.host_min_free_gib, 8) * GIB;
  const matrixMaxRecords = positiveInteger(capacity.matrix_max_records, 250_000);
  const matrixDimensions = positiveInteger(config.matrix_dimensions, 512);
  const matrixBytes = matrixMaxRecords * matrixDimensions * 4;
  const roleCapacity = {
    ssd: Math.floor(snapshotBudgetBytes / snapshotBytes),
    host_hot: Math.floor(hostCacheBytes / snapshotBytes),
    helper_vram_hot: Math.floor(helperVramBytes / snapshotBytes),
    configured_roles: roles.length,
  };
  const warnings = [];
  const errors = [];
  if (targetContextTokens > modelContextTokens) errors.push("target context exceeds the model context window");
  if (roles.length < targetAgents) errors.push(`only ${roles.length} roles are configured for a ${targetAgents}-agent target`);
  if (roleCapacity.ssd < targetAgents) errors.push(`SSD budget retains only ${roleCapacity.ssd} target-sized agent snapshots`);
  if (roleCapacity.host_hot < 2) warnings.push("host cache cannot keep two target-sized agent snapshots hot");
  if (roleCapacity.helper_vram_hot < 1) warnings.push("helper VRAM cannot keep one target-sized agent snapshot hot");
  if (hardware.helper_vram_free_bytes !== undefined && hardware.helper_vram_free_bytes < helperVramBytes + helperReserveBytes) {
    errors.push("helper GPU free VRAM is below the configured cache plus safety reserve");
  }
  if (hardware.host_free_bytes !== undefined && hardware.host_free_bytes < hostCacheBytes + hostReserveBytes) {
    warnings.push("host RAM headroom is below the configured cache plus safety reserve");
  }
  if (hardware.ssd_free_bytes !== undefined && hardware.ssd_free_bytes < ssdBudgetBytes + finiteNumber(config.ssd_min_free_gib, 4) * GIB) {
    errors.push("SSD free space is below the project budget plus filesystem reserve");
  }
  const effectiveAgents = Math.min(targetAgents, roles.length, roleCapacity.ssd);
  return {
    viable: errors.length === 0,
    target_agents: targetAgents,
    effective_agents: effectiveAgents,
    execution_model: "single-active-slot-sequential-specialists",
    target_context_tokens_per_agent: targetContextTokens,
    model_context_tokens: modelContextTokens,
    estimated_snapshot_bytes_per_agent: snapshotBytes,
    estimated_snapshot_gib_per_agent: Number((snapshotBytes / GIB).toFixed(3)),
    storage: {
      ssd_budget_gib: Number((ssdBudgetBytes / GIB).toFixed(3)),
      ssd_metadata_reserve_gib: Number((ssdMetadataReserveBytes / GIB).toFixed(3)),
      host_cache_gib: Number((hostCacheBytes / GIB).toFixed(3)),
      helper_vram_gib: Number((helperVramBytes / GIB).toFixed(3)),
      matrix_max_records: matrixMaxRecords,
      matrix_dimensions: matrixDimensions,
      matrix_gib_at_limit: Number((matrixBytes / GIB).toFixed(3)),
    },
    role_capacity: roleCapacity,
    hardware,
    warnings,
    errors,
  };
}

function parseNvidiaSmi(source) {
  return source.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [index, name, totalMiB, usedMiB, freeMiB] = line.split(",").map((value) => value.trim());
    return {
      index: Number(index),
      name,
      total_bytes: Number(totalMiB) * MIB,
      used_bytes: Number(usedMiB) * MIB,
      free_bytes: Number(freeMiB) * MIB,
    };
  });
}

export async function inspectCapacityHardware({ storageRoot, helperDevice = 1 } = {}) {
  const hardware = { host_free_bytes: os.freemem(), host_total_bytes: os.totalmem() };
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=index,name,memory.total,memory.used,memory.free",
      "--format=csv,noheader,nounits",
    ], { windowsHide: true, timeout: 5000 });
    hardware.gpus = parseNvidiaSmi(stdout);
    const helper = hardware.gpus.find((gpu) => gpu.index === Number(helperDevice));
    if (helper) hardware.helper_vram_free_bytes = helper.free_bytes;
  } catch (error) {
    hardware.gpu_probe_error = error.message;
  }
  if (storageRoot) {
    try {
      await fs.mkdir(storageRoot, { recursive: true });
      const stats = await fs.statfs(storageRoot);
      hardware.ssd_free_bytes = Number(stats.bavail * stats.bsize);
      hardware.ssd_total_bytes = Number(stats.blocks * stats.bsize);
    } catch (error) {
      hardware.storage_probe_error = error.message;
    }
  }
  return hardware;
}

export { GIB, MIB };
