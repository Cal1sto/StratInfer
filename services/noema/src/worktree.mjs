import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { identifier, isProtectedPath, scanSecrets } from "./core.mjs";

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function runProcess(command, args, { cwd, timeoutMs = 120_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000_000); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ command, args, cwd, code, signal, stdout, stderr });
    });
  });
}

export class WorktreeManager {
  constructor({ root, allowedWorkspaceRoots = [], commandAllowlist = ["node", "npm", "python", "git", "cmake", "ctest"] }) {
    this.root = path.resolve(root);
    this.allowedWorkspaceRoots = allowedWorkspaceRoots.map((entry) => path.resolve(entry));
    this.commandAllowlist = new Set(commandAllowlist.map((entry) => entry.toLowerCase()));
  }

  assertWorkspace(workspace) {
    const resolved = path.resolve(workspace);
    if (!this.allowedWorkspaceRoots.some((root) => isInside(root, resolved))) throw new Error(`workspace is outside allowed roots: ${resolved}`);
    return resolved;
  }

  assertWorktree(worktree) {
    const resolved = path.resolve(worktree);
    if (!isInside(this.root, resolved)) throw new Error("worktree escapes NOEMA worktree root");
    return resolved;
  }

  async create(workspace, revision = "HEAD", id = identifier("worktree")) {
    const repository = this.assertWorkspace(workspace);
    const target = this.assertWorktree(path.join(this.root, id));
    await fs.mkdir(this.root, { recursive: true });
    const top = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd: repository });
    if (top.code !== 0) throw new Error(top.stderr || "workspace is not a Git repository");
    const sourceRoot = path.resolve(top.stdout.trim());
    this.assertWorkspace(sourceRoot);
    const resolvedRevision = await runProcess("git", ["rev-parse", "--verify", `${revision}^{commit}`], { cwd: sourceRoot });
    if (resolvedRevision.code !== 0) throw new Error(resolvedRevision.stderr || `invalid revision: ${revision}`);
    const add = await runProcess("git", ["worktree", "add", "--detach", target, resolvedRevision.stdout.trim()], { cwd: sourceRoot, timeoutMs: 300_000 });
    if (add.code !== 0) throw new Error(add.stderr || "git worktree add failed");
    return { id, path: target, repository: sourceRoot, revision: resolvedRevision.stdout.trim() };
  }

  async applyPatch(worktree, patchText) {
    const cwd = this.assertWorktree(worktree);
    const patch = String(patchText ?? "");
    if (!patch) throw new Error("patch is required");
    const secrets = scanSecrets(patch);
    if (secrets.length) throw new Error(`patch contains possible secrets: ${secrets.join(", ")}`);
    const changedPaths = [...patch.matchAll(/^(?:\+\+\+|---)\s+(?:[ab]\/)?(.+)$/gm)].map((match) => match[1]).filter((value) => value !== "/dev/null");
    if (changedPaths.some(isProtectedPath)) throw new Error("patch modifies a protected path");
    const check = await this.gitApply(cwd, patch, true);
    if (check.code !== 0) throw new Error(check.stderr || "git apply --check failed");
    const applied = await this.gitApply(cwd, patch, false);
    if (applied.code !== 0) throw new Error(applied.stderr || "git apply failed");
    return this.diff(cwd);
  }

  gitApply(cwd, patch, check) {
    return new Promise((resolve, reject) => {
      const args = ["apply", "--whitespace=nowarn", ...(check ? ["--check"] : []), "-"];
      const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
      child.stdin.end(patch);
    });
  }

  async diff(worktree) {
    const cwd = this.assertWorktree(worktree);
    const [status, diff] = await Promise.all([
      runProcess("git", ["status", "--short"], { cwd }),
      runProcess("git", ["diff", "--binary", "--no-ext-diff"], { cwd }),
    ]);
    if (status.code !== 0 || diff.code !== 0) throw new Error(status.stderr || diff.stderr || "git diff failed");
    return { status: status.stdout, diff: diff.stdout };
  }

  async run(worktree, command, args = [], { timeoutMs = 30 * 60 * 1000, relativeCwd = "." } = {}) {
    const root = this.assertWorktree(worktree);
    const executable = path.basename(command).replace(/\.exe$/i, "").toLowerCase();
    if (!this.commandAllowlist.has(executable)) throw new Error(`command is not allowlisted: ${command}`);
    this.assertCommandArguments(executable, args.map(String));
    const cwd = path.resolve(root, relativeCwd);
    if (!isInside(root, cwd)) throw new Error("command cwd escapes worktree");
    const result = await runProcess(command, args.map(String), { cwd, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" } });
    return { ...result, stdout: result.stdout.slice(-200_000), stderr: result.stderr.slice(-200_000) };
  }

  assertCommandArguments(executable, args) {
    const forbidden = new Set(["-e", "--eval", "-c", "--command", "-command", "-file", "--require", "-r"]);
    if (args.some((argument) => forbidden.has(argument.toLowerCase()))) throw new Error("inline or external script execution is not allowed");
    if (executable === "node" && !["--test", "--check"].includes(args[0])) throw new Error("node is limited to --test and --check");
    if (executable === "python" && !(args[0] === "-m" && ["pytest", "compileall"].includes(args[1]))) {
      throw new Error("python is limited to -m pytest and -m compileall");
    }
    if (executable === "git" && !["status", "diff", "show", "rev-parse", "log"].includes(args[0])) throw new Error("git command is read-only in the worktree executor");
    if (executable === "npm" && !(args[0] === "test" || (args[0] === "run" && /^[a-z0-9:_-]{1,80}$/i.test(args[1] ?? "")))) {
      throw new Error("npm is limited to test or a named run script");
    }
    if (executable === "cmake" && !["--build", "--version"].includes(args[0])) throw new Error("cmake is limited to --build and --version");
  }
}

export { isInside };
