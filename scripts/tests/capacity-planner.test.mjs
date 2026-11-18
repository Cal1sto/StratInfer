import assert from "node:assert/strict";
import test from "node:test";
import { GIB, planAgentCapacity } from "../lib/capacity-planner.mjs";

function configuration() {
  return {
    ssd_budget_gib: 64,
    ssd_min_free_gib: 32,
    matrix_dimensions: 512,
    roles: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`role-${index}`, {}])),
    required_engine_env: { STRATA_PARK_VRAM_MIB: "6144" },
    required_engine_args: ["--conversation-cache-mib", "12288"],
    capacity: {
      target_agents: 8,
      target_context_tokens_per_agent: 131072,
      model_context_tokens: 524288,
      snapshot_bytes_per_token: 16333,
      snapshot_safety_factor: 1.2,
      ssd_metadata_reserve_gib: 8,
      helper_vram_mib: 6144,
      helper_vram_min_free_mib: 4096,
      host_cache_mib: 12288,
      host_min_free_gib: 8,
      matrix_max_records: 250000,
    },
  };
}

test("capacity plan fits eight 128K specialists with guarded VRAM and SSD", () => {
  const plan = planAgentCapacity(configuration(), {
    helper_vram_free_bytes: 11 * GIB,
    host_free_bytes: 30 * GIB,
    ssd_free_bytes: 1700 * GIB,
  });
  assert.equal(plan.viable, true);
  assert.equal(plan.effective_agents, 8);
  assert.equal(plan.role_capacity.helper_vram_hot, 2);
  assert.equal(plan.role_capacity.host_hot, 5);
  assert.ok(plan.role_capacity.ssd >= 8);
  assert.equal(plan.storage.matrix_gib_at_limit, 0.477);
});

test("capacity plan rejects an unsafe helper-GPU reservation", () => {
  const plan = planAgentCapacity(configuration(), {
    helper_vram_free_bytes: 8 * GIB,
    host_free_bytes: 30 * GIB,
    ssd_free_bytes: 1700 * GIB,
  });
  assert.equal(plan.viable, false);
  assert.match(plan.errors.join("\n"), /helper GPU/);
});
