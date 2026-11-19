import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertTransition,
  identifier,
  promotionDecision,
  sha256,
  stableStringify,
  validateCampaignSpec,
  validateCheckpointBundle,
  validateReviewDecision,
  validateRiskClass,
} from "./core.mjs";
import { featureVector } from "../../../scripts/lib/context-memory.mjs";

const MEMORY_DIMENSIONS = 512;

function vectorBuffer(vector) {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) buffer.writeFloatLE(vector[index], index * 4);
  return buffer;
}

function vectorSimilarity(query, bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length !== query.length * 4) return 0;
  let score = 0;
  for (let index = 0; index < query.length; index += 1) score += query[index] * buffer.readFloatLE(index * 4);
  return score;
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  return JSON.parse(value);
}

function rowCampaign(row) {
  if (!row) return null;
  return {
    id: row.id,
    objective: row.objective,
    workspace: row.workspace,
    status: row.status,
    spec: parseJson(row.spec_json, {}),
    currentCheckpoint: row.current_checkpoint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class NoemaStore {
  constructor({ root, now = () => new Date() }) {
    this.root = path.resolve(root);
    this.now = now;
    this.databasePath = path.join(this.root, "noema.sqlite3");
    this.blobRoot = path.join(this.root, "blobs", "sha256");
    mkdirSync(this.blobRoot, { recursive: true });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        workspace TEXT NOT NULL,
        status TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        current_checkpoint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
      );
      CREATE INDEX IF NOT EXISTS events_campaign_seq ON events(campaign_id, seq);
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        parent_id TEXT,
        phase TEXT NOT NULL,
        actor TEXT NOT NULL,
        bundle_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
      );
      CREATE INDEX IF NOT EXISTS checkpoints_campaign_created ON checkpoints(campaign_id, created_at);
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
        FOREIGN KEY(checkpoint_id) REFERENCES checkpoints(id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        risk_class TEXT NOT NULL,
        action_hash TEXT NOT NULL,
        action_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        decision_json TEXT,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
      );
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        risk_class TEXT NOT NULL,
        status TEXT NOT NULL,
        base_revision TEXT NOT NULL,
        diff_sha256 TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        rollback_json TEXT NOT NULL,
        local_verdict TEXT NOT NULL,
        codex_verdict TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
      );
      CREATE TABLE IF NOT EXISTS codex_threads (
        campaign_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        last_checkpoint TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
      );
      CREATE TABLE IF NOT EXISTS resource_leases (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        profile TEXT NOT NULL,
        state TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
      );
      CREATE TABLE IF NOT EXISTS worktrees (
        campaign_id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL,
        path TEXT NOT NULL,
        repository TEXT NOT NULL,
        revision TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
      );
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        campaign_id TEXT,
        kind TEXT NOT NULL,
        role TEXT NOT NULL,
        trust REAL NOT NULL,
        sensitivity TEXT NOT NULL,
        source_hash TEXT,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, kind, role, content='memory_records', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_records BEGIN
        INSERT INTO memory_fts(rowid, content, kind, role) VALUES (new.rowid, new.content, new.kind, new.role);
      END;
      CREATE TABLE IF NOT EXISTS memory_vectors (
        memory_id TEXT PRIMARY KEY,
        dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL,
        FOREIGN KEY(memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(name, version)
      );
    `);
  }

  close() {
    this.database.close();
  }

  at() {
    return this.now().toISOString();
  }

  transaction(operation) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  putBlob(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const digest = sha256(buffer);
    const folder = path.join(this.blobRoot, digest.slice(0, 2));
    const target = path.join(folder, digest.slice(2));
    mkdirSync(folder, { recursive: true });
    if (existsSync(target)) return { sha256: digest, bytes: buffer.length, path: target };
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, buffer, { flag: "wx" });
      renameSync(temporary, target);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      if (!existsSync(target)) throw error;
    }
    return { sha256: digest, bytes: buffer.length, path: target };
  }

  appendEvent(campaignId, type, actor, payload) {
    const previous = this.database.prepare("SELECT hash FROM events WHERE campaign_id = ? ORDER BY seq DESC LIMIT 1").get(campaignId)?.hash ?? "0".repeat(64);
    const at = this.at();
    const payloadJson = stableStringify(payload ?? {});
    const digest = sha256(`${previous}\n${campaignId}\n${type}\n${actor}\n${at}\n${payloadJson}`);
    const result = this.database.prepare(`
      INSERT INTO events(campaign_id, type, actor, payload_json, previous_hash, hash, at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(campaignId, type, actor, payloadJson, previous, digest, at);
    return { seq: Number(result.lastInsertRowid), campaignId, type, actor, payload: parseJson(payloadJson), previousHash: previous, hash: digest, at };
  }

  createCampaign(input) {
    const spec = validateCampaignSpec(input);
    const id = identifier("campaign");
    const at = this.at();
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO campaigns(id, objective, workspace, status, spec_json, created_at, updated_at)
        VALUES(?, ?, ?, 'created', ?, ?, ?)
      `).run(id, spec.objective, spec.workspace, stableStringify(spec), at, at);
      this.appendEvent(id, "campaign.created", "user", { spec });
      return this.getCampaign(id);
    });
  }

  getCampaign(id) {
    const campaign = rowCampaign(this.database.prepare("SELECT * FROM campaigns WHERE id = ?").get(id));
    if (!campaign) throw new Error(`campaign not found: ${id}`);
    return campaign;
  }

  listCampaigns(limit = 100) {
    return this.database.prepare("SELECT * FROM campaigns ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(2000, Number(limit) || 100))).map(rowCampaign);
  }

  transitionCampaign(id, next, actor = "system", details = {}) {
    return this.transaction(() => {
      const current = this.getCampaign(id);
      assertTransition(current.status, next);
      const at = this.at();
      this.database.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(next, at, id);
      this.appendEvent(id, "campaign.transition", actor, { from: current.status, to: next, details });
      return this.getCampaign(id);
    });
  }

  createCheckpoint(campaignId, input) {
    const campaign = this.getCampaign(campaignId);
    if (["completed", "cancelled"].includes(campaign.status)) throw new Error(`campaign is ${campaign.status}`);
    const bundle = validateCheckpointBundle(input);
    const id = identifier("checkpoint");
    const at = this.at();
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO checkpoints(id, campaign_id, parent_id, phase, actor, bundle_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(id, campaignId, campaign.currentCheckpoint, bundle.phase, bundle.actor, stableStringify(bundle), at);
      this.database.prepare("UPDATE campaigns SET current_checkpoint = ?, updated_at = ? WHERE id = ?").run(id, at, campaignId);
      this.appendEvent(campaignId, "checkpoint.created", bundle.actor, { checkpointId: id, phase: bundle.phase });
      return this.getCheckpoint(id);
    });
  }

  getCheckpoint(id) {
    const row = this.database.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id);
    if (!row) throw new Error(`checkpoint not found: ${id}`);
    return {
      id: row.id,
      campaignId: row.campaign_id,
      parentId: row.parent_id,
      phase: row.phase,
      actor: row.actor,
      bundle: parseJson(row.bundle_json, {}),
      createdAt: row.created_at,
    };
  }

  addReview(campaignId, checkpointId, reviewer, input) {
    const checkpoint = this.getCheckpoint(checkpointId);
    if (checkpoint.campaignId !== campaignId) throw new Error("checkpoint does not belong to campaign");
    const decision = validateReviewDecision(input);
    const id = identifier("review");
    const at = this.at();
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO reviews(id, campaign_id, checkpoint_id, reviewer, decision_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `).run(id, campaignId, checkpointId, reviewer, stableStringify(decision), at);
      this.appendEvent(campaignId, "checkpoint.reviewed", reviewer, { checkpointId, reviewId: id, decision });
      return { id, campaignId, checkpointId, reviewer, decision, createdAt: at };
    });
  }

  latestReview(checkpointId, reviewer = "codex") {
    const row = this.database.prepare(`
      SELECT * FROM reviews
      WHERE checkpoint_id = ? AND lower(reviewer) = lower(?)
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(checkpointId, reviewer);
    return row ? {
      id: row.id,
      campaignId: row.campaign_id,
      checkpointId: row.checkpoint_id,
      reviewer: row.reviewer,
      decision: parseJson(row.decision_json, {}),
      createdAt: row.created_at,
    } : null;
  }

  requestApproval(campaignId, action, riskClass) {
    this.getCampaign(campaignId);
    const risk = validateRiskClass(riskClass);
    if (!["R3", "R4"].includes(risk)) throw new Error("human approval is reserved for R3 and R4 actions");
    const actionJson = stableStringify(action);
    const id = identifier("approval");
    const at = this.at();
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO approvals(id, campaign_id, risk_class, action_hash, action_json, status, requested_at)
        VALUES(?, ?, ?, ?, ?, 'pending', ?)
      `).run(id, campaignId, risk, sha256(actionJson), actionJson, at);
      this.appendEvent(campaignId, "approval.requested", "system", { approvalId: id, riskClass: risk, actionHash: sha256(actionJson) });
      return this.getApproval(id);
    });
  }

  getApproval(id) {
    const row = this.database.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    if (!row) throw new Error(`approval not found: ${id}`);
    return {
      id: row.id,
      campaignId: row.campaign_id,
      riskClass: row.risk_class,
      actionHash: row.action_hash,
      action: parseJson(row.action_json, {}),
      status: row.status,
      requestedAt: row.requested_at,
      decidedAt: row.decided_at,
      decision: parseJson(row.decision_json),
    };
  }

  decideApproval(id, { decision, actor = "user", reason = "" }) {
    const approval = this.getApproval(id);
    if (approval.status !== "pending") throw new Error(`approval is already ${approval.status}`);
    if (!['approved', 'denied'].includes(decision)) throw new Error("decision must be approved or denied");
    const at = this.at();
    const payload = { decision, actor, reason: String(reason).slice(0, 10_000) };
    return this.transaction(() => {
      this.database.prepare("UPDATE approvals SET status = ?, decided_at = ?, decision_json = ? WHERE id = ?")
        .run(decision, at, stableStringify(payload), id);
      this.appendEvent(approval.campaignId, "approval.decided", actor, { approvalId: id, ...payload });
      return this.getApproval(id);
    });
  }

  createCandidate(campaignId, input) {
    this.getCampaign(campaignId);
    const id = identifier("candidate");
    const at = this.at();
    const riskClass = validateRiskClass(input.riskClass);
    const diff = String(input.diff ?? "");
    if (!diff) throw new Error("candidate diff is required");
    const blob = this.putBlob(diff);
    const rollback = input.rollback && typeof input.rollback === "object" ? input.rollback : {};
    const { diff: _diff, ...candidateInput } = input;
    const payload = { ...candidateInput, diffBlob: blob };
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO candidates(id, campaign_id, risk_class, status, base_revision, diff_sha256, payload_json, rollback_json, local_verdict, codex_verdict, created_at, updated_at)
        VALUES(?, ?, ?, 'quarantined', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        campaignId,
        riskClass,
        String(input.baseRevision ?? "unknown"),
        blob.sha256,
        stableStringify(payload),
        stableStringify(rollback),
        String(input.localVerdict ?? "UNKNOWN"),
        String(input.codexVerdict ?? "UNKNOWN"),
        at,
        at,
      );
      this.appendEvent(campaignId, "candidate.created", "system", { candidateId: id, riskClass, diffSha256: blob.sha256 });
      return this.getCandidate(id);
    });
  }

  getCandidate(id) {
    const row = this.database.prepare("SELECT * FROM candidates WHERE id = ?").get(id);
    if (!row) throw new Error(`candidate not found: ${id}`);
    return {
      id: row.id,
      campaignId: row.campaign_id,
      riskClass: row.risk_class,
      status: row.status,
      baseRevision: row.base_revision,
      diffSha256: row.diff_sha256,
      payload: parseJson(row.payload_json, {}),
      rollback: parseJson(row.rollback_json, {}),
      localVerdict: row.local_verdict,
      codexVerdict: row.codex_verdict,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  promoteCandidate(id, options = {}) {
    return this.transaction(() => {
      const candidate = this.getCandidate(id);
      const decision = promotionDecision(candidate, options);
      if (!decision.allowed) throw new Error(decision.reason);
      const at = this.at();
      this.database.prepare("UPDATE candidates SET status = 'promoted', updated_at = ? WHERE id = ?").run(at, id);
      this.appendEvent(candidate.campaignId, "candidate.promoted", options.actor ?? "system", { candidateId: id, level: decision.level });
      return { ...this.getCandidate(id), promotionLevel: decision.level };
    });
  }

  rollbackCandidate(id, actor = "system") {
    return this.transaction(() => {
      const candidate = this.getCandidate(id);
      if (candidate.status !== "promoted") throw new Error("only promoted candidates can be rolled back");
      const at = this.at();
      this.database.prepare("UPDATE candidates SET status = 'rolled-back', updated_at = ? WHERE id = ?").run(at, id);
      this.appendEvent(candidate.campaignId, "candidate.rolled-back", actor, { candidateId: id, rollback: candidate.rollback });
      return this.getCandidate(id);
    });
  }

  saveCodexThread(campaignId, threadId, checkpointId = null) {
    const at = this.at();
    this.database.prepare(`
      INSERT INTO codex_threads(campaign_id, thread_id, status, last_checkpoint, turn_count, updated_at)
      VALUES(?, ?, 'ready', ?, 0, ?)
      ON CONFLICT(campaign_id) DO UPDATE SET thread_id=excluded.thread_id, status='ready', last_checkpoint=excluded.last_checkpoint, updated_at=excluded.updated_at
    `).run(campaignId, threadId, checkpointId, at);
  }

  codexThread(campaignId) {
    const row = this.database.prepare("SELECT * FROM codex_threads WHERE campaign_id = ?").get(campaignId);
    return row ? { campaignId: row.campaign_id, threadId: row.thread_id, status: row.status, lastCheckpoint: row.last_checkpoint, turnCount: row.turn_count, updatedAt: row.updated_at } : null;
  }

  incrementCodexTurn(campaignId, checkpointId) {
    this.database.prepare("UPDATE codex_threads SET turn_count = turn_count + 1, last_checkpoint = ?, updated_at = ? WHERE campaign_id = ?")
      .run(checkpointId, this.at(), campaignId);
  }

  saveWorktree(campaignId, worktree) {
    this.getCampaign(campaignId);
    const at = this.at();
    this.database.prepare(`
      INSERT INTO worktrees(campaign_id, worktree_id, path, repository, revision, state, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(campaign_id) DO UPDATE SET worktree_id=excluded.worktree_id, path=excluded.path, repository=excluded.repository, revision=excluded.revision, state='active', updated_at=excluded.updated_at
    `).run(campaignId, worktree.id, worktree.path, worktree.repository, worktree.revision, at, at);
    this.appendEvent(campaignId, "worktree.created", "system", { worktreeId: worktree.id, path: worktree.path, revision: worktree.revision });
    return this.worktree(campaignId);
  }

  worktree(campaignId) {
    const row = this.database.prepare("SELECT * FROM worktrees WHERE campaign_id = ?").get(campaignId);
    return row ? {
      campaignId: row.campaign_id,
      id: row.worktree_id,
      path: row.path,
      repository: row.repository,
      revision: row.revision,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  createResourceLease(campaignId, profile, details = {}) {
    this.getCampaign(campaignId);
    const id = identifier("lease");
    const at = this.at();
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO resource_leases(id, campaign_id, profile, state, details_json, created_at, updated_at)
        VALUES(?, ?, ?, 'active', ?, ?, ?)
      `).run(id, campaignId, profile, stableStringify(details), at, at);
      this.appendEvent(campaignId, "resource.acquired", "system", { leaseId: id, profile, details });
      return this.resourceLease(id);
    });
  }

  resourceLease(id) {
    const row = this.database.prepare("SELECT * FROM resource_leases WHERE id = ?").get(id);
    if (!row) throw new Error(`resource lease not found: ${id}`);
    return {
      id: row.id,
      campaignId: row.campaign_id,
      profile: row.profile,
      state: row.state,
      details: parseJson(row.details_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  releaseResourceLease(id, details = {}) {
    return this.transaction(() => {
      const lease = this.resourceLease(id);
      if (lease.state !== "active") throw new Error(`resource lease is ${lease.state}`);
      const at = this.at();
      this.database.prepare("UPDATE resource_leases SET state = 'released', details_json = ?, updated_at = ? WHERE id = ?")
        .run(stableStringify({ ...lease.details, release: details }), at, id);
      this.appendEvent(lease.campaignId, "resource.released", "system", { leaseId: id, details });
      return this.resourceLease(id);
    });
  }

  remember({ campaignId = null, kind = "fact", role = "main", trust = 0.5, sensitivity = "internal", sourceHash = null, content, metadata = {} }) {
    if (campaignId) this.getCampaign(campaignId);
    const text = String(content ?? "").trim();
    if (!text || text.length > 100_000) throw new Error("memory content must contain 1 to 100000 characters");
    const id = identifier("memory");
    const at = this.at();
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO memory_records(id, campaign_id, kind, role, trust, sensitivity, source_hash, content, metadata_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        campaignId,
        String(kind).slice(0, 80),
        String(role).slice(0, 80),
        Math.max(0, Math.min(1, Number(trust) || 0)),
        String(sensitivity).slice(0, 40),
        sourceHash,
        text,
        stableStringify(metadata),
        at,
      );
      this.database.prepare("INSERT INTO memory_vectors(memory_id, dimensions, vector) VALUES(?, ?, ?)")
        .run(id, MEMORY_DIMENSIONS, vectorBuffer(featureVector(text, MEMORY_DIMENSIONS)));
      if (campaignId) this.appendEvent(campaignId, "memory.remembered", role, { memoryId: id, kind, trust });
      return { id, campaignId, kind, role, trust, sensitivity, sourceHash, content: text, metadata, createdAt: at };
    });
  }

  recall(query, { campaignId = null, limit = 12 } = {}) {
    const terms = String(query ?? "").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
    if (!terms.length) throw new Error("memory query requires searchable terms");
    const expression = terms.slice(0, 20).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    const lexical = this.database.prepare(`
      SELECT m.*, bm25(memory_fts) AS lexical_rank
      FROM memory_fts
      JOIN memory_records AS m ON m.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ? AND (? IS NULL OR m.campaign_id = ? OR m.campaign_id IS NULL)
      ORDER BY lexical_rank, m.trust DESC, m.created_at DESC
      LIMIT 4096
    `).all(expression, campaignId, campaignId);
    const recent = this.database.prepare(`
      SELECT m.*, NULL AS lexical_rank
      FROM memory_records AS m
      WHERE (? IS NULL OR m.campaign_id = ? OR m.campaign_id IS NULL)
      ORDER BY m.created_at DESC
      LIMIT 4096
    `).all(campaignId, campaignId);
    const candidates = new Map();
    for (const row of [...recent, ...lexical]) {
      const existing = candidates.get(row.id);
      if (!existing || (row.lexical_rank !== null && row.lexical_rank < (existing.lexical_rank ?? Infinity))) candidates.set(row.id, row);
    }
    const queryVector = featureVector(query, MEMORY_DIMENSIONS);
    const vectorStatement = this.database.prepare("SELECT vector FROM memory_vectors WHERE memory_id = ? AND dimensions = ?");
    const rows = [...candidates.values()].map((row) => {
      const vector = vectorStatement.get(row.id, MEMORY_DIMENSIONS)?.vector;
      const matrixScore = vector ? vectorSimilarity(queryVector, vector) : 0;
      const lexicalBonus = row.lexical_rank === null ? 0 : 0.08 / (1 + Math.max(0, row.lexical_rank));
      return { ...row, matrix_score: matrixScore, score: matrixScore + lexicalBonus + row.trust * 0.08 };
    }).sort((left, right) => right.score - left.score || right.created_at.localeCompare(left.created_at))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 12)));
    return rows.map((row) => ({
      id: row.id,
      campaignId: row.campaign_id,
      kind: row.kind,
      role: row.role,
      trust: row.trust,
      sensitivity: row.sensitivity,
      sourceHash: row.source_hash,
      content: row.content,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
      lexicalRank: row.lexical_rank,
      matrixScore: row.matrix_score,
      score: row.score,
    }));
  }

  createSkill(input) {
    const manifest = structuredClone(input);
    const name = String(manifest.name ?? "").trim();
    const version = String(manifest.version ?? "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(name)) throw new Error("skill name is invalid");
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/i.test(version)) throw new Error("skill version must use semantic versioning");
    if (!Array.isArray(manifest.tests) || manifest.tests.length === 0) throw new Error("skill tests are required");
    if (!manifest.rollback || typeof manifest.rollback !== "object") throw new Error("skill rollback is required");
    const manifestJson = stableStringify(manifest);
    const signature = sha256(manifestJson);
    const id = identifier("skill");
    const at = this.at();
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO skills(id, name, version, status, manifest_json, signature, created_at, updated_at)
        VALUES(?, ?, ?, 'quarantined', ?, ?, ?, ?)
      `).run(id, name, version, manifestJson, signature, at, at);
      return this.getSkill(id);
    });
  }

  getSkill(id) {
    const row = this.database.prepare("SELECT * FROM skills WHERE id = ?").get(id);
    if (!row) throw new Error(`skill not found: ${id}`);
    return { id: row.id, name: row.name, version: row.version, status: row.status, manifest: parseJson(row.manifest_json, {}), signature: row.signature, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  listSkills() {
    return this.database.prepare("SELECT id FROM skills ORDER BY updated_at DESC").all().map((row) => this.getSkill(row.id));
  }

  promoteSkill(id, { localVerdict, codexVerdict } = {}) {
    return this.transaction(() => {
      const skill = this.getSkill(id);
      if (skill.status !== "quarantined") throw new Error(`skill is ${skill.status}`);
      if (localVerdict !== "PASS" || codexVerdict !== "PASS") throw new Error("skill promotion requires local and Codex PASS verdicts");
      const at = this.at();
      this.database.prepare("UPDATE skills SET status = 'active', updated_at = ? WHERE id = ?").run(at, id);
      return this.getSkill(id);
    });
  }

  events(campaignId, after = 0, limit = 1000) {
    this.getCampaign(campaignId);
    return this.database.prepare("SELECT * FROM events WHERE campaign_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(campaignId, Math.max(0, Number(after) || 0), Math.max(1, Math.min(10_000, Number(limit) || 1000)))
      .map((row) => ({
        seq: row.seq,
        campaignId: row.campaign_id,
        type: row.type,
        actor: row.actor,
        payload: parseJson(row.payload_json, {}),
        previousHash: row.previous_hash,
        hash: row.hash,
        at: row.at,
      }));
  }

  verifyEventChain(campaignId) {
    let previous = "0".repeat(64);
    for (const event of this.events(campaignId, 0, 10_000)) {
      const expected = sha256(`${previous}\n${campaignId}\n${event.type}\n${event.actor}\n${event.at}\n${stableStringify(event.payload)}`);
      if (event.previousHash !== previous || event.hash !== expected) return { valid: false, seq: event.seq };
      previous = event.hash;
    }
    return { valid: true, head: previous };
  }

  jarvisRuns() {
    const campaigns = this.listCampaigns(2000);
    return {
      tasks: campaigns.map((campaign) => ({
        id: campaign.id,
        parentId: null,
        role: "governor",
        request: campaign.objective,
        status: campaign.status,
        updatedAt: campaign.updatedAt,
        finalVerified: campaign.status === "completed",
        approval: campaign.status === "awaiting_human" ? { reason: "Human approval required" } : null,
        plan: { objective: campaign.objective },
        steps: this.database.prepare(`
          SELECT c.phase, c.actor, c.created_at,
            (
              SELECT json_extract(r.decision_json, '$.verdict')
              FROM reviews AS r
              WHERE r.checkpoint_id = c.id AND lower(r.reviewer) = 'codex'
              ORDER BY r.created_at DESC, r.rowid DESC
              LIMIT 1
            ) AS codex_verdict,
            (
              SELECT r.created_at
              FROM reviews AS r
              WHERE r.checkpoint_id = c.id AND lower(r.reviewer) = 'codex'
              ORDER BY r.created_at DESC, r.rowid DESC
              LIMIT 1
            ) AS reviewed_at
          FROM checkpoints AS c
          WHERE c.campaign_id = ?
          ORDER BY c.created_at
        `).all(campaign.id).map((row) => {
          const status = row.codex_verdict === "PASS" ? "verified" : row.codex_verdict ? "blocked" : "pending";
          return {
            action: `${row.actor}: ${row.phase}`,
            status,
            codexVerdict: row.codex_verdict,
            verifiedAt: status === "verified" ? row.reviewed_at : null,
          };
        }),
      })),
      orchestration: {
        active: campaigns.filter((campaign) => !["completed", "cancelled", "failed"].includes(campaign.status)).map((campaign) => campaign.id),
        maxWorkers: 4,
        inference: { localLanes: 1, codexReviewers: 1 },
      },
    };
  }

  metrics() {
    const count = (table) => this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    return {
      campaigns: count("campaigns"),
      checkpoints: count("checkpoints"),
      events: count("events"),
      pendingApprovals: this.database.prepare("SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'").get().count,
      quarantinedCandidates: this.database.prepare("SELECT COUNT(*) AS count FROM candidates WHERE status = 'quarantined'").get().count,
      memoryRecords: count("memory_records"),
      memoryVectors: count("memory_vectors"),
      activeSkills: this.database.prepare("SELECT COUNT(*) AS count FROM skills WHERE status = 'active'").get().count,
      root: this.root,
      databasePath: this.databasePath,
    };
  }
}
