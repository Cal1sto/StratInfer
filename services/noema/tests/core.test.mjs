import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTransition,
  classifyAction,
  isProtectedPath,
  promotionDecision,
  scanSecrets,
  stableStringify,
  validateCampaignSpec,
} from "../src/core.mjs";

test("campaign specifications are bounded and receive safe defaults", () => {
  const spec = validateCampaignSpec({ objective: "Improve the project", workspace: "." });
  assert.equal(spec.resourceProfile, "agent-max");
  assert.equal(spec.riskBudget, "R2");
  assert.equal(spec.codexPolicy.required, true);
  assert.equal(spec.codexPolicy.maxTurns, 64);
  assert.throws(() => validateCampaignSpec({ objective: "", workspace: "." }), /objective/);
});

test("campaign transitions fail closed", () => {
  assert.doesNotThrow(() => assertTransition("created", "planning"));
  assert.throws(() => assertTransition("created", "completed"), /invalid campaign transition/);
  assert.throws(() => assertTransition("completed", "running"), /invalid campaign transition/);
});

test("risk classification and promotion enforce human and Codex gates", () => {
  assert.equal(classifyAction({ kind: "read" }), "R0");
  assert.equal(classifyAction({ kind: "patch", target: "src/a.mjs" }), "R1");
  assert.equal(classifyAction({ kind: "engine-configuration" }), "R2");
  assert.equal(classifyAction({ kind: "push", external: true }), "R3");
  assert.equal(classifyAction({ kind: "purchase", irreversible: true }), "R4");
  const candidate = { riskClass: "R2", localVerdict: "PASS", codexVerdict: "PASS", rollback: { command: "git restore" } };
  assert.equal(promotionDecision(candidate).allowed, true);
  assert.equal(promotionDecision(candidate, { codexAvailable: false }).allowed, false);
  assert.equal(promotionDecision({ ...candidate, riskClass: "R3" }).allowed, false);
  assert.equal(promotionDecision({ ...candidate, riskClass: "R3" }, { humanApproved: true }).allowed, true);
});

test("protected paths and common secrets are rejected", () => {
  assert.equal(isProtectedPath("services/noema/src/core.mjs"), true);
  assert.equal(isProtectedPath("services/noema/src/server.mjs"), true);
  assert.equal(isProtectedPath("scripts/start-noema.ps1"), true);
  assert.equal(isProtectedPath("configs/noema-resource-profiles.json"), true);
  assert.equal(isProtectedPath("src/feature.mjs"), false);
  assert.equal(isProtectedPath("README.md"), false);
  assert.deepEqual(scanSecrets("-----BEGIN PRIVATE KEY-----"), ["private-key"]);
  assert.deepEqual(scanSecrets("ordinary checkpoint evidence"), []);
});

test("stable JSON ordering is deterministic", () => {
  assert.equal(stableStringify({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
});
