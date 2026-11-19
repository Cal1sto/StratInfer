import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const GIB = 1024 ** 3;

function databaseBytes(file) {
  return Promise.all(["", "-wal", "-shm"].map(async (suffix) => {
    try {
      return (await fs.stat(`${file}${suffix}`)).size;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  })).then((sizes) => sizes.reduce((sum, size) => sum + size, 0));
}

function schema(database) {
  database.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY,
      created_at REAL NOT NULL,
      category TEXT NOT NULL,
      importance REAL NOT NULL,
      tags TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, category, tags, content='memories', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category, tags)
      VALUES (new.id, new.content, new.category, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category, tags)
      VALUES ('delete', old.id, old.content, old.category, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category, tags)
      VALUES ('delete', old.id, old.content, old.category, old.tags);
      INSERT INTO memories_fts(rowid, content, category, tags)
      VALUES (new.id, new.content, new.category, new.tags);
    END;
    CREATE TABLE IF NOT EXISTS memory_sources (
      source_key TEXT PRIMARY KEY,
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_json TEXT NOT NULL,
      imported_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_sources_memory_id ON memory_sources(memory_id);
  `);
}

function backupName(databaseFile) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${databaseFile}.pre-chatgpt-${stamp}.bak`;
}

export async function importFastMcpRecords({ databaseFile, records, createBackup = true, maxBytes = 32 * GIB }) {
  const target = path.resolve(databaseFile);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const beforeBytes = await databaseBytes(target);
  const estimate = records.reduce((total, record) => total + Buffer.byteLength(record.text, "utf8") * 4 + 4096, 0);
  if (beforeBytes + estimate > maxBytes) throw new Error(`FastMCP memory budget would be exceeded: ${beforeBytes + estimate} > ${maxBytes}`);
  const database = new DatabaseSync(target);
  let backupFile = null;
  try {
    schema(database);
    if (createBackup && beforeBytes > 0) {
      backupFile = backupName(target);
      await backup(database, backupFile);
    }
    const sourceExists = database.prepare("SELECT memory_id FROM memory_sources WHERE source_key = ?");
    const insertMemory = database.prepare("INSERT OR IGNORE INTO memories(created_at, category, importance, tags, content, content_hash) VALUES(?, ?, ?, ?, ?, ?)");
    const selectMemory = database.prepare("SELECT id FROM memories WHERE content_hash = ?");
    const insertSource = database.prepare("INSERT INTO memory_sources(source_key, memory_id, source_type, source_json, imported_at) VALUES(?, ?, ?, ?, ?)");
    let importedSources = 0;
    let newMemories = 0;
    let duplicateSources = 0;
    let reusedMemories = 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        if (sourceExists.get(record.sourceKey)) {
          duplicateSources += 1;
          continue;
        }
        const digest = createHash("sha256").update(`${record.category}\0${record.tags}\0${record.text}`).digest("hex");
        const timestamp = record.source?.created_at ? new Date(record.source.created_at).valueOf() / 1000 : Date.now() / 1000;
        const inserted = insertMemory.run(timestamp, record.category, record.importance, record.tags, record.text, digest);
        if (Number(inserted.changes) === 1) newMemories += 1;
        else reusedMemories += 1;
        const memory = selectMemory.get(digest);
        insertSource.run(record.sourceKey, memory.id, record.source?.type ?? "chatgpt-export", JSON.stringify(record.source ?? {}), Date.now() / 1000);
        importedSources += 1;
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return {
      database: target,
      backup: backupFile,
      imported_sources: importedSources,
      new_memories: newMemories,
      reused_memories: reusedMemories,
      duplicate_sources: duplicateSources,
      bytes_before: beforeBytes,
      bytes_after: await databaseBytes(target),
    };
  } finally {
    database.close();
  }
}

export { databaseBytes };
