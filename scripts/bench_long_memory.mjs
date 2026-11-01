#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ContextMemory } from "./lib/context-memory.mjs";

const entries = Number(process.argv[2] ?? 2000);
const queries = Number(process.argv[3] ?? 100);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "stratinfer-bench-"));
try {
  const memory = new ContextMemory({ root, project: "bench", dimensions: 512, budgetBytes: 32 * 1024 ** 3 });
  await memory.init({ objective: "Preserve main coding context" });
  const startWrite = performance.now();
  for (let index = 0; index < entries; index += 1) {
    await memory.remember({
      kind: index % 17 === 0 ? "decision" : "fact",
      role: ["architect", "implementer", "reviewer", "tester"][index % 4],
      importance: (index % 10) / 10,
      text: `module-${index} cache invariant token-${index} ${index % 17 === 0 ? "cuda peer context" : "ordinary implementation detail"}`,
    });
  }
  const writeMs = performance.now() - startWrite;
  let hits = 0;
  const startRead = performance.now();
  for (let index = 0; index < queries; index += 1) {
    const wanted = (index * 17) % entries;
    const found = await memory.retrieve(`module-${wanted} token-${wanted} cuda peer`, { role: "tester", limit: 5 });
    if (found.some((record) => record.text.includes(`module-${wanted} `))) hits += 1;
  }
  const readMs = performance.now() - startRead;
  const status = await memory.status();
  process.stdout.write(`${JSON.stringify({
    entries,
    queries,
    dimensions: 512,
    matrix_bytes: (await fs.stat(memory.matrixFile)).size,
    write_ms: writeMs,
    writes_per_second: entries / (writeMs / 1000),
    query_ms_total: readMs,
    query_ms_mean: readMs / queries,
    top5_recall: hits / queries,
    used_bytes: status.used_bytes,
  }, null, 2)}\n`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
