import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NoemaStore } from "../src/store.mjs";

async function temporaryStore(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noema-store-"));
  const store = new NoemaStore({ root });
  context.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return store;
}

test("campaigns, checkpoints and reviews create a valid event chain", async (context) => {
  const store = await temporaryStore(context);
  const campaign = store.createCampaign({ objective: "Qualify a change", workspace: process.cwd() });
  store.transitionCampaign(campaign.id, "planning", "governor");
  const checkpoint = store.createCheckpoint(campaign.id, { phase: "architecture", actor: "architect", summary: "Plan complete", tests: [], metrics: {} });
  assert.equal(store.jarvisRuns().tasks[0].steps[0].status, "pending");
  const review = store.addReview(campaign.id, checkpoint.id, "codex", {
    verdict: "PASS",
    summary: "Evidence is sufficient",
    findings: [],
    requiredCorrections: [],
    confidence: 0.9,
    riskClass: "R1",
  });
  assert.equal(review.decision.verdict, "PASS");
  assert.equal(store.verifyEventChain(campaign.id).valid, true);
  assert.equal(store.jarvisRuns().tasks[0].steps.length, 1);
  assert.equal(store.jarvisRuns().tasks[0].steps[0].status, "verified");
  assert.equal(store.jarvisRuns().tasks[0].steps[0].codexVerdict, "PASS");
});

test("Jarvis compatibility never reports an unqualified checkpoint as verified", async (context) => {
  const store = await temporaryStore(context);
  const campaign = store.createCampaign({ objective: "Expose honest status", workspace: process.cwd() });
  const checkpoint = store.createCheckpoint(campaign.id, { phase: "tests", actor: "tester", summary: "Evidence incomplete", tests: [], metrics: {} });
  store.addReview(campaign.id, checkpoint.id, "codex", {
    verdict: "REVISE",
    summary: "Missing evidence",
    findings: ["No trace"],
    requiredCorrections: ["Attach trace"],
    confidence: 0.95,
    riskClass: "R1",
  });
  const step = store.jarvisRuns().tasks[0].steps[0];
  assert.equal(step.status, "blocked");
  assert.equal(step.codexVerdict, "REVISE");
  assert.equal(step.verifiedAt, null);
});

test("approvals and candidates enforce promotion policy", async (context) => {
  const store = await temporaryStore(context);
  const campaign = store.createCampaign({ objective: "Release safely", workspace: process.cwd() });
  const approval = store.requestApproval(campaign.id, { kind: "push", target: "origin" }, "R3");
  assert.equal(store.decideApproval(approval.id, { decision: "approved", reason: "Reviewed" }).status, "approved");
  const candidate = store.createCandidate(campaign.id, {
    riskClass: "R3",
    baseRevision: "abc123",
    diff: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n",
    rollback: { command: "git revert" },
    localVerdict: "PASS",
    codexVerdict: "PASS",
  });
  assert.throws(() => store.promoteCandidate(candidate.id), /requires human approval/);
  assert.equal(store.promoteCandidate(candidate.id, { humanApproved: true }).status, "promoted");
  assert.equal(store.rollbackCandidate(candidate.id).status, "rolled-back");
});

test("durable memory is searchable with campaign scoping", async (context) => {
  const store = await temporaryStore(context);
  const campaign = store.createCampaign({ objective: "Remember invariants", workspace: process.cwd() });
  store.remember({ campaignId: campaign.id, kind: "invariant", role: "architect", trust: 1, content: "Never promote without a Codex PASS verdict" });
  store.remember({ kind: "global", role: "main", trust: 0.8, content: "Rollback plans are mandatory" });
  const records = store.recall("Codex promotion rollback", { campaignId: campaign.id });
  assert.equal(records.length, 2);
  assert.ok(records.some((record) => record.kind === "invariant"));
  assert.equal(store.metrics().memoryVectors, 2);
  assert.ok(records.every((record) => Number.isFinite(record.matrixScore)));
});

test("skills remain quarantined until both reviewers pass", async (context) => {
  const store = await temporaryStore(context);
  const skill = store.createSkill({
    name: "safe-review",
    version: "1.0.0",
    permissions: ["read"],
    procedure: ["inspect", "report"],
    tests: ["rejects missing evidence"],
    rollback: { action: "disable" },
  });
  assert.equal(skill.status, "quarantined");
  assert.throws(() => store.promoteSkill(skill.id, { localVerdict: "PASS", codexVerdict: "REVISE" }), /requires local and Codex PASS/);
  assert.equal(store.promoteSkill(skill.id, { localVerdict: "PASS", codexVerdict: "PASS" }).status, "active");
  assert.equal(store.metrics().activeSkills, 1);
});
