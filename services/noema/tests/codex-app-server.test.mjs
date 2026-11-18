import assert from "node:assert/strict";
import test from "node:test";
import { parseStructuredReview } from "../src/codex-app-server.mjs";

test("Codex review parsing accepts strict and fenced JSON", () => {
  const payload = { verdict: "PASS", summary: "Verified", findings: [], requiredCorrections: [], confidence: 0.95, riskClass: "R1" };
  assert.equal(parseStructuredReview(JSON.stringify(payload)).verdict, "PASS");
  assert.equal(parseStructuredReview(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``).confidence, 0.95);
});

test("Codex review parsing rejects missing verdicts", () => {
  assert.throws(() => parseStructuredReview('{"summary":"missing"}'), /invalid review verdict/);
});
