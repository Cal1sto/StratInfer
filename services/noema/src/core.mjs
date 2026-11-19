import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export const RISK_CLASSES = Object.freeze(["R0", "R1", "R2", "R3", "R4"]);
export const REVIEW_VERDICTS = Object.freeze(["PASS", "REVISE", "BLOCKED", "ESCALATE"]);
export const CAMPAIGN_STATUSES = Object.freeze([
  "created",
  "planning",
  "running",
  "awaiting_codex",
  "awaiting_human",
  "paused",
  "blocked",
  "failed",
  "completed",
  "cancelled",
]);

const transitions = new Map([
  ["created", new Set(["planning", "running", "paused", "cancelled", "failed"])],
  ["planning", new Set(["running", "awaiting_codex", "awaiting_human", "paused", "blocked", "failed", "cancelled"])],
  ["running", new Set(["planning", "awaiting_codex", "awaiting_human", "paused", "blocked", "failed", "completed", "cancelled"])],
  ["awaiting_codex", new Set(["planning", "running", "awaiting_human", "paused", "blocked", "failed", "cancelled"])],
  ["awaiting_human", new Set(["planning", "running", "paused", "blocked", "failed", "cancelled"])],
  ["paused", new Set(["planning", "running", "awaiting_codex", "awaiting_human", "blocked", "failed", "cancelled"])],
  ["blocked", new Set(["planning", "running", "paused", "cancelled"])],
  ["failed", new Set(["planning", "running", "cancelled"])],
  ["completed", new Set([])],
  ["cancelled", new Set([])],
]);

const protectedPathPatterns = [
  /(^|[\\/])\.git([\\/]|$)/i,
  /(^|[\\/])\.env(?:\.|$)/i,
  /(^|[\\/])(?:secrets?|credentials?|private[-_]?keys?)([\\/]|\.|$)/i,
  /(^|[\\/])services[\\/]noema[\\/](?:src|tests)([\\/]|$)/i,
  /(^|[\\/])services[\\/]noema[\\/](?:package\.json|noema\.config\.example\.json)$/i,
  /(^|[\\/])scripts[\\/](?:start|stop|enable|set)-noema[^\\/]*\.ps1$/i,
  /(^|[\\/])tools[\\/]noema_control_fastmcp\.py$/i,
  /(^|[\\/])configs[\\/]noema-resource-profiles\.json$/i,
];

const secretPatterns = [
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "github-token", pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}={0,2}\b/i },
  { name: "password-assignment", pattern: /\b(?:password|passwd|pwd|client_secret)\s*[:=]\s*["']?[^\s"']{12,}/i },
];

export function stableStringify(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry) ?? "null").join(",")}]`;
  const entries = Object.keys(value).sort().map((key) => [key, stableStringify(value[key])]).filter(([, encoded]) => encoded !== undefined);
  return `{${entries.map(([key, encoded]) => `${JSON.stringify(key)}:${encoded}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function identifier(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

export function boundedString(value, name, { min = 1, max = 100_000 } = {}) {
  const result = String(value ?? "").trim();
  if (result.length < min || result.length > max) throw new Error(`${name} must contain ${min} to ${max} characters`);
  return result;
}

export function validateRiskClass(value) {
  const risk = String(value ?? "").toUpperCase();
  if (!RISK_CLASSES.includes(risk)) throw new Error(`invalid risk class: ${value}`);
  return risk;
}

export function validateVerdict(value) {
  const verdict = String(value ?? "").toUpperCase();
  if (!REVIEW_VERDICTS.includes(verdict)) throw new Error(`invalid review verdict: ${value}`);
  return verdict;
}

export function validateCampaignSpec(input) {
  const spec = structuredClone(assertObject(input, "campaign"));
  spec.objective = boundedString(spec.objective, "objective", { max: 20_000 });
  spec.workspace = path.resolve(boundedString(spec.workspace, "workspace", { max: 1024 }));
  spec.acceptanceCriteria = Array.isArray(spec.acceptanceCriteria)
    ? spec.acceptanceCriteria.map((item) => boundedString(item, "acceptance criterion", { max: 4000 })).slice(0, 100)
    : [];
  spec.capabilities = Array.isArray(spec.capabilities)
    ? [...new Set(spec.capabilities.map((item) => boundedString(item, "capability", { max: 80 })))].slice(0, 64)
    : ["text", "coding"];
  spec.resourceProfile = spec.resourceProfile === "voice-balanced" ? "voice-balanced" : "agent-max";
  spec.riskBudget = validateRiskClass(spec.riskBudget ?? "R2");
  spec.maxCorrectionCycles = Number.isInteger(spec.maxCorrectionCycles)
    ? Math.max(0, Math.min(10, spec.maxCorrectionCycles))
    : 3;
  spec.codexPolicy = {
    required: spec.codexPolicy?.required !== false,
    checkpoints: spec.codexPolicy?.checkpoints ?? "all",
    maxTurns: Math.max(1, Math.min(256, Number(spec.codexPolicy?.maxTurns ?? 64))),
    maxTurnsPerCheckpoint: Math.max(1, Math.min(10, Number(spec.codexPolicy?.maxTurnsPerCheckpoint ?? 3))),
  };
  spec.allowedExternalTargets = Array.isArray(spec.allowedExternalTargets)
    ? spec.allowedExternalTargets.map(String).slice(0, 100)
    : [];
  return spec;
}

export function assertTransition(current, next) {
  if (!CAMPAIGN_STATUSES.includes(next)) throw new Error(`invalid campaign status: ${next}`);
  if (current === next) return;
  if (!transitions.get(current)?.has(next)) throw new Error(`invalid campaign transition: ${current} -> ${next}`);
}

export function classifyAction(action) {
  const input = assertObject(action, "action");
  const kind = String(input.kind ?? "").toLowerCase();
  const target = String(input.target ?? "");
  if (input.riskClass) return validateRiskClass(input.riskClass);
  if (input.irreversible || /(?:purchase|payment|identity|account|permission|delete-permanent)/.test(kind)) return "R4";
  if (input.external || /(?:push|merge|publish|deploy|email|message|upload)/.test(kind)) return "R3";
  if (/(?:engine|moai|service|registry|system|configuration)/.test(kind)) return "R2";
  if (/(?:write|patch|create|rename|delete)/.test(kind) || target) return "R1";
  return "R0";
}

export function promotionDecision(candidate, { codexAvailable = true, humanApproved = false } = {}) {
  const value = assertObject(candidate, "candidate");
  const risk = validateRiskClass(value.riskClass);
  if (!codexAvailable) return { allowed: false, reason: "Codex is unavailable; promotion is frozen" };
  if (value.localVerdict !== "PASS" || value.codexVerdict !== "PASS") {
    return { allowed: false, reason: "local and Codex verdicts must both be PASS" };
  }
  if (!value.rollback || Object.keys(value.rollback).length === 0) {
    return { allowed: false, reason: "a rollback plan is required" };
  }
  if (["R3", "R4"].includes(risk) && !humanApproved) {
    return { allowed: false, reason: `${risk} requires human approval` };
  }
  return { allowed: true, level: ["R0", "R1"].includes(risk) ? "local-staging" : risk === "R2" ? "local-integration" : "human-approved" };
}

export function isProtectedPath(relativePath) {
  const normalized = String(relativePath ?? "").replaceAll("\\", "/");
  return protectedPathPatterns.some((pattern) => pattern.test(normalized));
}

export function scanSecrets(value) {
  const text = typeof value === "string" ? value : stableStringify(value);
  return secretPatterns.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

export function validateCheckpointBundle(input) {
  const bundle = structuredClone(assertObject(input, "checkpoint"));
  bundle.phase = boundedString(bundle.phase, "phase", { max: 120 });
  bundle.actor = boundedString(bundle.actor, "actor", { max: 120 });
  bundle.summary = boundedString(bundle.summary, "summary", { max: 100_000 });
  bundle.decisions = Array.isArray(bundle.decisions) ? bundle.decisions.map(String).slice(0, 200) : [];
  bundle.commands = Array.isArray(bundle.commands) ? bundle.commands.slice(0, 500) : [];
  bundle.tests = Array.isArray(bundle.tests) ? bundle.tests.slice(0, 500) : [];
  bundle.metrics = bundle.metrics && typeof bundle.metrics === "object" ? bundle.metrics : {};
  bundle.risks = Array.isArray(bundle.risks) ? bundle.risks.map(String).slice(0, 200) : [];
  bundle.uncertainties = Array.isArray(bundle.uncertainties) ? bundle.uncertainties.map(String).slice(0, 200) : [];
  const secrets = scanSecrets(bundle);
  if (secrets.length) throw new Error(`checkpoint contains possible secrets: ${secrets.join(", ")}`);
  return bundle;
}

export const reviewOutputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "requiredCorrections", "confidence", "riskClass"],
  properties: {
    verdict: { type: "string", enum: REVIEW_VERDICTS },
    summary: { type: "string", minLength: 1, maxLength: 20_000 },
    findings: { type: "array", maxItems: 100, items: { type: "string", maxLength: 4000 } },
    requiredCorrections: { type: "array", maxItems: 100, items: { type: "string", maxLength: 4000 } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    riskClass: { type: "string", enum: RISK_CLASSES },
  },
});

export function validateReviewDecision(input) {
  const review = structuredClone(assertObject(input, "review"));
  review.verdict = validateVerdict(review.verdict);
  review.summary = boundedString(review.summary, "review summary", { max: 20_000 });
  review.findings = Array.isArray(review.findings) ? review.findings.map(String).slice(0, 100) : [];
  review.requiredCorrections = Array.isArray(review.requiredCorrections) ? review.requiredCorrections.map(String).slice(0, 100) : [];
  review.confidence = Math.max(0, Math.min(1, Number(review.confidence) || 0));
  review.riskClass = validateRiskClass(review.riskClass);
  return review;
}
