import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorktreeManager, runProcess } from "../src/worktree.mjs";

test("worktree execution is confined and command arguments are bounded", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noema-worktree-"));
  const repository = path.join(root, "repository");
  const worktrees = path.join(root, "worktrees");
  await fs.mkdir(repository);
  await runProcess("git", ["init"], { cwd: repository });
  await runProcess("git", ["config", "user.email", "noema@example.invalid"], { cwd: repository });
  await runProcess("git", ["config", "user.name", "NOEMA Test"], { cwd: repository });
  await fs.writeFile(path.join(repository, "sample.txt"), "old\n");
  await runProcess("git", ["add", "sample.txt"], { cwd: repository });
  await runProcess("git", ["commit", "-m", "baseline"], { cwd: repository });
  const manager = new WorktreeManager({ root: worktrees, allowedWorkspaceRoots: [root] });
  const worktree = await manager.create(repository);
  const result = await manager.applyPatch(worktree.path, "diff --git a/sample.txt b/sample.txt\n--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-old\n+new\n");
  assert.match(result.diff, /\+new/);
  await assert.rejects(manager.run(worktree.path, "node", ["-e", "console.log('unsafe')"]), /not allowed/);
  await assert.rejects(manager.applyPatch(worktree.path, "diff --git a/services/noema/src/core.mjs b/services/noema/src/core.mjs\n--- a/services/noema/src/core.mjs\n+++ b/services/noema/src/core.mjs\n@@ -0,0 +1 @@\n+unsafe\n"), /protected path/);
  context.after(() => fs.rm(root, { recursive: true, force: true }));
});
