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
  constructor({ root, project, dimensions = 512, budgetBytes = 32 * GIB, minFreeBytes = 0 }) {
    this.root = path.resolve(root);
    this.project = safeName(project);
    this.dimensions = dimensions;
    this.budgetBytes = budgetBytes;
    this.minFreeBytes = minFreeBytes;
    this.projectPath = path.join(this.root, this.project);
    this.sessionsPath = path.join(this.projectPath, "sessions");
    this.transcriptsPath = path.join(this.projectPath, "transcripts");
    this.coreFile = path.join(this.projectPath, "core.json");
    this.ledgerFile = path.join(this.projectPath, "ledger.jsonl");
    this.matrixFile = path.join(this.projectPath, "context-matrix.f32");
    this.manifestFile = path.join(this.projectPath, "manifest.json");
  }

  async init(core = {}) {
    await fs.mkdir(this.sessionsPath, { recursive: true });
    await fs.mkdir(this.transcriptsPath, { recursive: true });
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
    const content = String(text ?? "").trim();
    if (!content) throw new Error("memory text is required");
    const record = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      at: new Date().toISOString(),
      kind: safeName(kind),
      role: safeName(role),
      importance: Math.max(0, Math.min(1, Number(importance) || 0)),
      pinned: Boolean(pinned),
      text: content,
    };
    await fs.appendFile(this.ledgerFile, `${JSON.stringify(record)}\n`, "utf8");
    await fs.appendFile(this.matrixFile, vectorBuffer(featureVector(content, this.dimensions)));
    return record;
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

  async retrieve(query, { role = "main", limit = 8, maxChars = 12000 } = {}) {
    const records = await this.records();
    if (records.length === 0) return [];
    const matrix = await fs.readFile(this.matrixFile);
    const queryVector = featureVector(query, this.dimensions);
    const rowBytes = this.dimensions * 4;
    const scored = records.map((record, row) => {
      let similarity = 0;
      const offset = row * rowBytes;
      if (offset + rowBytes <= matrix.length) {
        for (let column = 0; column < this.dimensions; column += 1) {
          similarity += queryVector[column] * matrix.readFloatLE(offset + column * 4);
        }
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

  snapshotFilename(role) {
    return `${safeName(role)}.bin`;
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
    let used = await pathBytes(this.projectPath);
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

  async status() {
    const manifest = await readJson(this.manifestFile, { version: 1, snapshots: {} });
    let freeBytes = null;
    try {
      const stats = await fs.statfs(this.root);
      freeBytes = Number(stats.bavail * stats.bsize);
    } catch {}
    return {
      project: this.project,
      path: this.projectPath,
      sessions_path: this.sessionsPath,
      dimensions: this.dimensions,
      used_bytes: await pathBytes(this.projectPath),
      budget_bytes: this.budgetBytes,
      min_free_bytes: this.minFreeBytes,
      filesystem_free_bytes: freeBytes,
      snapshots: manifest.snapshots,
    };
  }
}

export { GIB };
