import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { reviewOutputSchema, scanSecrets, stableStringify, validateReviewDecision } from "./core.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function extractItemText(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) return item.content.map((part) => part?.text ?? "").join("");
  return "";
}

function parseStructuredReview(text) {
  const source = String(text ?? "").trim();
  if (!source) throw new Error("Codex returned no review content");
  try {
    return validateReviewDecision(JSON.parse(source));
  } catch (firstError) {
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return validateReviewDecision(JSON.parse(fenced));
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start >= 0 && end > start) return validateReviewDecision(JSON.parse(source.slice(start, end + 1)));
    throw firstError;
  }
}

export class CodexAppServer {
  constructor({
    command = process.env.CODEX_CLI_PATH ?? "codex",
    model = null,
    reasoningEffort = "high",
    timeoutMs = 30 * 60 * 1000,
    spawnProcess = spawn,
  } = {}) {
    this.command = command;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.turnBuffers = new Map();
    this.turnFinals = new Map();
    this.completedTurns = new Map();
    this.stderr = "";
  }

  async start() {
    if (this.child) return;
    const args = [
      "app-server",
      "--stdio",
      "--strict-config",
      "-c", 'sandbox_mode="read-only"',
      "-c", 'approval_policy="never"',
      "-c", 'approvals_reviewer="user"',
    ];
    this.child = this.spawnProcess(this.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env },
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-24_000);
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.onLine(line));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? signal}): ${this.stderr.slice(-2000)}`);
      this.child = null;
      this.failAll(error);
    });
    await this.request("initialize", {
      clientInfo: { name: "stratinfer-noema", title: "NOEMA supervisor", version: "0.1.0" },
      capabilities: { experimentalApi: true, requiredHumanApproval: false },
    });
    this.notify("initialized", {});
  }

  stop() {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
  }

  failAll(error) {
    for (const request of this.pending.values()) request.reject(error);
    for (const turn of this.turns.values()) turn.reject(error);
    this.pending.clear();
    this.turns.clear();
    this.turnBuffers.clear();
    this.turnFinals.clear();
    this.completedTurns.clear();
  }

  send(message) {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method, params) {
    await this.startIfNeeded(method);
    const id = this.nextId++;
    const result = deferred();
    this.pending.set(id, result);
    this.send({ jsonrpc: "2.0", id, method, params });
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) result.reject(new Error(`Codex request timed out: ${method}`));
    }, this.timeoutMs);
    try {
      return await result.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  async startIfNeeded(method) {
    if (!this.child && method !== "initialize") await this.start();
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderr = `${this.stderr}\ninvalid stdout: ${line}`.slice(-24_000);
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? stableStringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "NOEMA reviewer does not permit interactive tools or approvals" } });
      return;
    }
    const params = message.params ?? {};
    if (message.method === "item/agentMessage/delta") {
      const turn = this.turns.get(params.turnId);
      const delta = String(params.delta ?? "");
      if (turn) turn.text += delta;
      else this.turnBuffers.set(params.turnId, `${this.turnBuffers.get(params.turnId) ?? ""}${delta}`);
      return;
    }
    if (message.method === "item/completed") {
      const turn = this.turns.get(params.turnId);
      const text = extractItemText(params.item);
      if (turn && text) turn.finalText = text;
      else if (!turn && text) this.turnFinals.set(params.turnId, text);
      return;
    }
    if (message.method === "turn/completed") {
      const turnId = params.turn?.id;
      const turn = this.turns.get(turnId);
      if (!turn) {
        this.completedTurns.set(turnId, params.turn);
        return;
      }
      this.turns.delete(turnId);
      if (params.turn?.status === "failed") turn.reject(new Error(params.turn?.error?.message ?? "Codex review failed"));
      else turn.resolve(turn.finalText || turn.text);
    }
  }

  async startThread({ cwd, baseInstructions = "" }) {
    await this.start();
    const response = await this.request("thread/start", {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      sandbox: "read-only",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      serviceName: "noema-supervisor",
      ephemeral: false,
      ...(this.model ? { model: this.model } : {}),
      baseInstructions: [
        "You are the independent NOEMA qualification supervisor.",
        "Never edit files, execute tools, or claim tests that are absent from the supplied checkpoint.",
        "Review objective coverage, evidence, security, regressions, rollback and uncertainty.",
        "Return only JSON conforming to the supplied output schema.",
        baseInstructions,
      ].filter(Boolean).join("\n"),
    });
    const threadId = response?.thread?.id;
    if (!threadId) throw new Error("Codex did not return a thread id");
    return threadId;
  }

  async review({ threadId, campaign, checkpoint }) {
    const payload = { campaign, checkpoint };
    const secrets = scanSecrets(payload);
    if (secrets.length) throw new Error(`Codex payload contains possible secrets: ${secrets.join(", ")}`);
    const prompt = [
      "Review this NOEMA checkpoint independently.",
      "A PASS requires objective coverage, executed evidence, no unresolved critical risk, and a usable rollback.",
      "Use REVISE for correctable defects, BLOCKED for missing indispensable evidence, and ESCALATE for a required human decision.",
      "CHECKPOINT_BUNDLE",
      JSON.stringify(payload, null, 2),
    ].join("\n\n");
    const response = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      effort: this.reasoningEffort,
      outputSchema: reviewOutputSchema,
      turnTrigger: "noema-checkpoint",
    });
    const turnId = response?.turn?.id;
    if (!turnId) throw new Error("Codex did not return a turn id");
    const completed = deferred();
    completed.text = this.turnBuffers.get(turnId) ?? "";
    completed.finalText = this.turnFinals.get(turnId) ?? "";
    this.turnBuffers.delete(turnId);
    this.turnFinals.delete(turnId);
    this.turns.set(turnId, completed);
    const earlyCompletion = this.completedTurns.get(turnId);
    if (earlyCompletion) {
      this.completedTurns.delete(turnId);
      this.turns.delete(turnId);
      if (earlyCompletion.status === "failed") completed.reject(new Error(earlyCompletion.error?.message ?? "Codex review failed"));
      else completed.resolve(completed.finalText || completed.text);
    }
    const timer = setTimeout(() => {
      if (this.turns.delete(turnId)) completed.reject(new Error("Codex review turn timed out"));
    }, this.timeoutMs);
    try {
      return parseStructuredReview(await completed.promise);
    } finally {
      clearTimeout(timer);
    }
  }
}

export { parseStructuredReview };
