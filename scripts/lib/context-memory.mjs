import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const GIB = 1024 ** 3;

function normalizeText(value) {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export function safeName(value) {
  const safe = normalizeText(value).replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe || safe === "." || safe === "..") throw new Error(`invalid name: ${value}`);
  return safe.slice(0, 96);
}

export function tokenize(value) {
  return normalizeText(value).match(/[a-z0-9_./:-]{2,}/g) ?? [];
}

function hashFeature(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function featureVector(text, dimensions = 512) {
  if (!Number.isInteger(dimensions) || dimensions < 64 || dimensions > 4096) {
    throw new Error("matrix_dimensions must be an integer from 64 to 4096");
  }
  const vector = new Float32Array(dimensions);
  const tokens = tokenize(text);
  const add = (feature, weight) => {
    const hash = hashFeature(feature);
    const index = hash % dimensions;
    vector[index] += (hash & 0x80000000) === 0 ? weight : -weight;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    add(tokens[index], 1);
    if (index > 0) add(`${tokens[index - 1]}\u0001${tokens[index]}`, 0.65);
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm > 0) {
    const scale = 1 / Math.sqrt(norm);
    for (let index = 0; index < vector.length; index += 1) vector[index] *= scale;
  }
  return vector;
}

function vectorBuffer(vector) {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) buffer.writeFloatLE(vector[index], index * 4);
  return buffer;
}

function uniqueTerms(text, limit = 96) {
  return [...new Set(tokenize(text))].slice(0, limit);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

async function pathBytes(root) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += await pathBytes(target);
    else if (entry.isFile()) total += (await fs.stat(target)).size;
  }
  return total;
}

function mergeCore(current, update) {
  const next = structuredClone(current);
  for (const [key, value] of Object.entries(update)) {
    if (Array.isArray(value)) {
      const existing = Array.isArray(next[key]) ? next[key] : [];
      next[key] = [...new Set([...existing, ...value.map(String)])];
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  next.updated_at = new Date().toISOString();
  return next;
}

export class ContextMemory {
  constructor({
    root,
    project,
    dimensions = 512,
    budgetBytes = 32 * GIB,
    minFreeBytes = 0,
    maxRecords = 250_000,
    candidateRecords = 4096,
    recentRecords = 2048,
    sessionsPath = null,
  }) {
    this.root = path.resolve(root);
    this.project = safeName(project);
    this.dimensions = dimensions;
    this.budgetBytes = budgetBytes;
    this.minFreeBytes = minFreeBytes;
    this.maxRecords = maxRecords;
    this.candidateRecords = candidateRecords;
    this.recentRecords = recentRecords;
    this.projectPath = path.join(this.root, this.project);
    this.sessionsPath = sessionsPath ? path.resolve(sessionsPath) : path.join(this.projectPath, "sessions");
    this.externalSessions = !this.sessionsPath.startsWith(`${this.projectPath}${path.sep}`);
    this.transcriptsPath = path.join(this.projectPath, "transcripts");
    this.runsPath = path.join(this.projectPath, "runs");
    this.coreFile = path.join(this.projectPath, "core.json");
    this.ledgerFile = path.join(this.projectPath, "ledger.jsonl");
    this.matrixFile = path.join(this.projectPath, "context-matrix.f32");
    this.manifestFile = path.join(this.projectPath, "manifest.json");
  }

  async init(core = {}) {
    await fs.mkdir(this.sessionsPath, { recursive: true });
    await fs.mkdir(this.transcriptsPath, { recursive: true });
    await fs.mkdir(this.runsPath, { recursive: true });
    const current = await readJson(this.coreFile, {
      objective: "",
      constraints: [],
      invariants: [],
      decisions: [],
      accepted_results: [],
      risks: [],
      files: [],
      next_actions: [],
      created_at: new Date().toISOString(),
    });
    await writeJsonAtomic(this.coreFile, mergeCore(current, core));
    const manifest = await readJson(this.manifestFile, { version: 1, snapshots: {} });
    await writeJsonAtomic(this.manifestFile, manifest);
    await fs.appendFile(this.ledgerFile, "", "utf8");
    await fs.appendFile(this.matrixFile, Buffer.alloc(0));
    await this.verifyMatrix({ repair: true });
    return this.status();
  }

  async readCore() {
    return readJson(this.coreFile, {});
  }

  async updateCore(update) {
    const next = mergeCore(await this.readCore(), update);
    await writeJsonAtomic(this.coreFile, next);
    return next;
  }

  async remember({ kind = "fact", text, role = "main", importance = 0.5, pinned = false }) {
    const result = await this.rememberMany([{ kind, text, role, importance, pinned }]);
    return result.records[0];
  }

  async rememberMany(entries) {
    if (!Array.isArray(entries)) throw new Error("memory entries must be an array");
    if (entries.length === 0) return { inserted: 0, skipped: 0, records: [] };
    const rowBytes = this.dimensions * 4;
    const matrixBytesBefore = (await fs.stat(this.matrixFile)).size;
    if (matrixBytesBefore % rowBytes !== 0) {
      throw new Error(`context matrix size ${matrixBytesBefore} is not aligned to ${rowBytes}-byte rows`);
    }
    const existingCount = matrixBytesBefore / rowBytes;
    const incomingHasSourceKeys = entries.some((entry) => String(entry?.sourceKey ?? entry?.source_key ?? "").trim());
    const sourceKeys = incomingHasSourceKeys
      ? new Set((await this.records()).map((record) => record.source_key).filter(Boolean))
      : new Set();
    const records = [];
    let skipped = 0;
    for (const entry of entries) {
      const content = String(entry?.text ?? "").trim();
      if (!content) throw new Error("memory text is required");
      const sourceKey = String(entry?.sourceKey ?? entry?.source_key ?? "").trim();
      if (sourceKey && sourceKeys.has(sourceKey)) {
        skipped += 1;
        continue;
      }
      if (sourceKey.length > 1000 || sourceKey.includes("\0")) throw new Error("invalid memory source key");
      const at = entry?.at ? new Date(entry.at) : new Date();
      if (Number.isNaN(at.valueOf())) throw new Error("invalid memory timestamp");
      const record = {
        id: sourceKey
          ? `src-${createHash("sha256").update(sourceKey).digest("hex").slice(0, 24)}`
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        at: at.toISOString(),
        kind: safeName(entry?.kind ?? "fact"),
        role: safeName(entry?.role ?? "main"),
        importance: Math.max(0, Math.min(1, Number(entry?.importance) || 0)),
        pinned: Boolean(entry?.pinned),
        text: content,
        search_terms: uniqueTerms(content),
      };
      if (sourceKey) {
        record.source_key = sourceKey;
        sourceKeys.add(sourceKey);
      }
      if (entry?.source && typeof entry.source === "object") record.source = structuredClone(entry.source);
      records.push(record);
    }
    if (records.length === 0) return { inserted: 0, skipped, records: [] };
    if (existingCount + records.length > this.maxRecords) {
      throw new Error(`context memory record limit exceeded: ${existingCount + records.length} requested, ${this.maxRecords} allowed`);
    }
    const ledgerBytes = (await fs.stat(this.ledgerFile)).size;
    const ledger = records.map((record) => `${JSON.stringify(record)}\n`).join("");
    const matrix = Buffer.concat(records.map((record) => vectorBuffer(featureVector(record.text, this.dimensions))));
    try {
      await fs.appendFile(this.ledgerFile, ledger, "utf8");
      await fs.appendFile(this.matrixFile, matrix);
    } catch (error) {
      await Promise.allSettled([
        fs.truncate(this.ledgerFile, ledgerBytes),
        fs.truncate(this.matrixFile, matrixBytesBefore),
      ]);
      throw error;
    }
    return { inserted: records.length, skipped, records };
  }

  async records() {
    const source = await fs.readFile(this.ledgerFile, "utf8");
    return source.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`invalid ledger record at line ${index + 1}`);
      }
    });
  }

  async verifyMatrix({ repair = false } = {}) {
    const records = await this.records();
    const expectedBytes = records.length * this.dimensions * 4;
    const actualBytes = (await fs.stat(this.matrixFile)).size;
    if (actualBytes === expectedBytes) return { valid: true, records: records.length, bytes: actualBytes, repaired: false };
    if (!repair) {
      throw new Error(`context matrix mismatch: ${actualBytes} bytes found, ${expectedBytes} expected for ${records.length} records`);
    }
    const temporary = `${this.matrixFile}.${process.pid}.${Date.now()}.tmp`;
    const file = await fs.open(temporary, "w");
    let writtenBytes = 0;
    try {
      for (let start = 0; start < records.length; start += 2048) {
        const batch = records.slice(start, start + 2048);
        const matrix = Buffer.concat(batch.map((record) => vectorBuffer(featureVector(record.text, this.dimensions))));
        let offset = 0;
        while (offset < matrix.length) {
          const { bytesWritten } = await file.write(matrix, offset, matrix.length - offset, writtenBytes);
          if (bytesWritten < 1) throw new Error("context matrix rebuild made no write progress");
          offset += bytesWritten;
          writtenBytes += bytesWritten;
        }
      }
    } finally {
      await file.close();
    }
    await fs.rename(temporary, this.matrixFile);
    return { valid: true, records: records.length, bytes: writtenBytes, repaired: true };
  }

  candidateRows(records, query, role) {
    if (records.length <= this.candidateRecords) return records.map((_, row) => row);
    const queryTerms = new Set(tokenize(query));
    const selected = new Set();
    records.forEach((record, row) => {
      if (record.pinned) selected.add(row);
    });
    const recentStart = Math.max(0, records.length - this.recentRecords);
    for (let row = recentStart; row < records.length; row += 1) selected.add(row);
    const scored = records.map((record, row) => {
      const terms = record.search_terms ?? uniqueTerms(record.text);
      let overlap = 0;
      for (const term of terms) if (queryTerms.has(term)) overlap += 1;
      const roleBonus = record.role === role || record.role === "main" ? 0.75 : 0;
      const recency = records.length > 1 ? row / (records.length - 1) : 1;
      return { row, score: overlap * 2 + record.importance + roleBonus + recency * 0.25 };
    }).sort((left, right) => right.score - left.score || right.row - left.row);
    for (const candidate of scored) {
      if (selected.size >= this.candidateRecords) break;
      selected.add(candidate.row);
    }
    return [...selected].sort((left, right) => left - right);
  }

  async matrixRows(rows, rowBytes, totalRows) {
    const matrixBytes = (await fs.stat(this.matrixFile)).size;
    const expectedBytes = totalRows * rowBytes;
    if (matrixBytes !== expectedBytes) {
      throw new Error(`context matrix mismatch: ${matrixBytes} bytes found, ${expectedBytes} expected`);
    }
    if (matrixBytes <= 128 * 1024 ** 2 || rows.length >= totalRows / 3) {
      const matrix = await fs.readFile(this.matrixFile);
      return new Map(rows.map((row) => [row, matrix.subarray(row * rowBytes, (row + 1) * rowBytes)]));
    }
    const file = await fs.open(this.matrixFile, "r");
    try {
      const vectors = new Map();
      for (const row of rows) {
        const vector = Buffer.allocUnsafe(rowBytes);
        const { bytesRead } = await file.read(vector, 0, rowBytes, row * rowBytes);
        if (bytesRead !== rowBytes) throw new Error(`short context matrix read at row ${row}`);
        vectors.set(row, vector);
      }
      return vectors;
    } finally {
      await file.close();
    }
  }

  async retrieve(query, { role = "main", limit = 8, maxChars = 12000 } = {}) {
    const records = await this.records();
    if (records.length === 0) return [];
    const queryVector = featureVector(query, this.dimensions);
    const rowBytes = this.dimensions * 4;
    const candidateRows = this.candidateRows(records, query, role);
    const vectors = await this.matrixRows(candidateRows, rowBytes, records.length);
    const scored = candidateRows.map((row) => {
      const record = records[row];
      let similarity = 0;
      const vector = vectors.get(row);
      for (let column = 0; column < this.dimensions; column += 1) {
        similarity += queryVector[column] * vector.readFloatLE(column * 4);
      }
      const roleBonus = record.role === role || record.role === "main" ? 0.04 : 0;
      const recency = records.length > 1 ? (row / (records.length - 1)) * 0.02 : 0.02;
      return { ...record, score: similarity + record.importance * 0.08 + roleBonus + recency };
    });
    const pinned = scored.filter((record) => record.pinned).sort((left, right) => right.importance - left.importance);
    const relevant = scored.filter((record) => !record.pinned).sort((left, right) => right.score - left.score);
    const selected = [];
    let chars = 0;
    for (const record of [...pinned, ...relevant]) {
      if (selected.some((item) => item.id === record.id)) continue;
      if (selected.length >= limit && !record.pinned) continue;
      const cost = record.text.length + 80;
      if (chars + cost > maxChars && selected.length > 0) continue;
      selected.push(record);
      chars += cost;
    }
    return selected;
  }

  async contextEnvelope(query, options = {}) {
    const core = await this.readCore();
    const memories = await this.retrieve(query, options);
    const memoryText = memories.map((record) =>
      `- [${record.kind}/${record.role}${record.pinned ? "/pinned" : ""}] ${record.text}`).join("\n");
    return [
      "CANONICAL MAIN CONTEXT (never override silently)",
      JSON.stringify(core, null, 2),
      "RETRIEVED SUPPORTING MEMORY",
      memoryText || "- none",
    ].join("\n\n");
  }

  transcriptFile(role) {
    return path.join(this.transcriptsPath, `${safeName(role)}.json`);
  }

  async loadTranscript(role) {
    return readJson(this.transcriptFile(role), []);
  }

  async saveTranscript(role, messages) {
    await writeJsonAtomic(this.transcriptFile(role), messages);
  }

  runFile(runId) {
    return path.join(this.runsPath, `${safeName(runId)}.json`);
  }

  async loadRun(runId) {
    return readJson(this.runFile(runId), null);
  }

  async saveRun(runId, state) {
    const next = { ...structuredClone(state), run_id: safeName(runId), updated_at: new Date().toISOString() };
    await writeJsonAtomic(this.runFile(runId), next);
    return next;
  }

  snapshotFilename(role) {
    return `${this.project}--${safeName(role)}.bin`;
  }

  snapshotPath(role) {
    return path.join(this.sessionsPath, this.snapshotFilename(role));
  }

  async hasSnapshot(role) {
    try {
      return (await fs.stat(this.snapshotPath(role))).isFile();
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async recordSnapshot(role, { bytes = 0, pinned = false } = {}) {
    const key = safeName(role);
    const manifest = await readJson(this.manifestFile, { version: 1, snapshots: {} });
    let actual = Number(bytes) || 0;
    try {
      actual = (await fs.stat(this.snapshotPath(key))).size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    manifest.snapshots[key] = {
      file: this.snapshotFilename(key),
      bytes: actual,
      pinned: Boolean(pinned),
      last_used_at: new Date().toISOString(),
    };
    await writeJsonAtomic(this.manifestFile, manifest);
    return manifest.snapshots[key];
  }

  async touchSnapshot(role) {
    const key = safeName(role);
    const manifest = await readJson(this.manifestFile, { version: 1, snapshots: {} });
    if (manifest.snapshots[key]) {
      manifest.snapshots[key].last_used_at = new Date().toISOString();
      await writeJsonAtomic(this.manifestFile, manifest);
    }
  }

  async pruneSnapshots() {
    const manifest = await readJson(this.manifestFile, { version: 1, snapshots: {} });
    let used = await this.managedBytes(manifest);
    let free = null;
    try {
      const stats = await fs.statfs(this.root);
      free = Number(stats.bavail * stats.bsize);
    } catch {}
    const removed = [];
    const candidates = Object.entries(manifest.snapshots)
      .filter(([, snapshot]) => !snapshot.pinned)
      .sort(([, left], [, right]) => String(left.last_used_at).localeCompare(String(right.last_used_at)));
    for (const [role] of candidates) {
      if (used <= this.budgetBytes && (free === null || free >= this.minFreeBytes)) break;
      const target = this.snapshotPath(role);
      let bytes = 0;
      try {
        bytes = (await fs.stat(target)).size;
        await fs.unlink(target);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      used = Math.max(0, used - bytes);
      if (free !== null) free += bytes;
      delete manifest.snapshots[role];
      removed.push({ role, bytes });
    }
    await writeJsonAtomic(this.manifestFile, manifest);
    if (used > this.budgetBytes) {
      throw new Error(`SSD memory budget exceeded: ${used} bytes used, ${this.budgetBytes} allowed; pinned snapshots were preserved`);
    }
    if (free !== null && free < this.minFreeBytes) {
      throw new Error(`SSD free-space floor violated: ${free} bytes free, ${this.minFreeBytes} required; pinned snapshots were preserved`);
    }
    return { used_bytes: used, budget_bytes: this.budgetBytes, filesystem_free_bytes: free, min_free_bytes: this.minFreeBytes, removed };
  }

  async managedBytes(manifest = null) {
    let used = await pathBytes(this.projectPath);
    if (!this.externalSessions) return used;
    const current = manifest ?? await readJson(this.manifestFile, { version: 1, snapshots: {} });
    for (const snapshot of Object.values(current.snapshots)) {
      try {
        used += (await fs.stat(path.join(this.sessionsPath, snapshot.file))).size;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return used;
  }

  async status() {
    const manifest = await readJson(this.manifestFile, { version: 1, snapshots: {} });
    const records = await this.records();
    const matrixBytes = (await fs.stat(this.matrixFile)).size;
    let freeBytes = null;
    try {
      const stats = await fs.statfs(this.root);
      freeBytes = Number(stats.bavail * stats.bsize);
    } catch {}
    return {
      project: this.project,
      path: this.projectPath,
      sessions_path: this.sessionsPath,
      runs_path: this.runsPath,
      dimensions: this.dimensions,
      records: records.length,
      max_records: this.maxRecords,
      candidate_records: this.candidateRecords,
      recent_records: this.recentRecords,
      matrix_bytes: matrixBytes,
      matrix_valid: matrixBytes === records.length * this.dimensions * 4,
      used_bytes: await this.managedBytes(manifest),
      budget_bytes: this.budgetBytes,
      min_free_bytes: this.minFreeBytes,
      filesystem_free_bytes: freeBytes,
      snapshots: manifest.snapshots,
    };
  }
}

export { GIB };
