import { safeName } from "./context-memory.mjs";

function responseText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("");
  }
  throw new Error("the model response has no assistant content");
}

function trimTranscript(messages, maxChars) {
  let chars = messages.reduce((total, message) => total + String(message.content ?? "").length, 0);
  let start = 0;
  while (chars > maxChars && start < messages.length - 2) {
    chars -= String(messages[start].content ?? "").length;
    start += 1;
  }
  return { messages: messages.slice(start), compacted: start > 0 };
}

export class StrataClient {
  constructor({ baseUrl, apiKey = "", model, timeoutMs = 30 * 60 * 1000 }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async post(route, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const source = await response.text();
      let payload;
      try {
        payload = source ? JSON.parse(source) : {};
      } catch {
        payload = { raw: source };
      }
      if (!response.ok) {
        throw new Error(`${route} returned HTTP ${response.status}: ${source.slice(0, 1200)}`);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async chat(messages, { maxTokens = 4096, temperature = 0.2 } = {}) {
    const payload = await this.post("/v1/chat/completions", {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    });
    return { text: responseText(payload), payload };
  }

  restoreSession(filename) {
    return this.post("/slots/0?action=restore", { filename: safeName(filename) });
  }

  saveSession(filename) {
    return this.post("/slots/0?action=save", { filename: safeName(filename) });
  }
}

export class AgentOrchestrator {
  constructor({ memory, client, config }) {
    this.memory = memory;
    this.client = client;
    this.config = config;
  }

  async run({ task, roles = this.config.default_roles }) {
    const objective = String(task ?? "").trim();
    if (!objective) throw new Error("task is required");
    const outputs = [];
    let handoff = "none";
    for (const requestedRole of roles) {
      const role = safeName(requestedRole);
      const roleConfig = this.config.roles[role];
      if (!roleConfig) throw new Error(`unknown agent role: ${role}`);
      const transcript = await this.memory.loadTranscript(role);
      const trimmed = trimTranscript(transcript, this.config.max_transcript_chars);
      const envelope = await this.memory.contextEnvelope(`${objective}\n${handoff}`, {
        role,
        limit: this.config.memory_results,
        maxChars: this.config.memory_chars,
      });
      const userMessage = [
        envelope,
        "CURRENT SPECIALIST ROLE",
        role,
        "CURRENT TASK",
        objective,
        "PREVIOUS SPECIALIST HANDOFF",
        handoff,
        "REQUIRED HANDOFF FORMAT",
        "RESULT\nDECISIONS\nFILES\nTESTS\nRISKS\nNEXT",
      ].join("\n\n");
      let restored = false;
      if (this.config.disk_sessions && !trimmed.compacted && await this.memory.hasSnapshot(role)) {
        await this.client.restoreSession(this.memory.snapshotFilename(role));
        await this.memory.touchSnapshot(role);
        restored = true;
      }
      const messages = [
        { role: "system", content: roleConfig.system },
        ...trimmed.messages,
        { role: "user", content: userMessage },
      ];
      const answer = await this.client.chat(messages, {
        maxTokens: roleConfig.max_tokens ?? this.config.max_tokens,
        temperature: roleConfig.temperature ?? this.config.temperature,
      });
      const nextTranscript = [
        ...trimmed.messages,
        { role: "user", content: userMessage },
        { role: "assistant", content: answer.text },
      ];
      await this.memory.saveTranscript(role, nextTranscript);
      await this.memory.remember({
        kind: "handoff",
        role,
        importance: role === "reviewer" || role === "tester" ? 0.75 : 0.6,
        text: answer.text.slice(0, this.config.max_memory_record_chars),
      });
      let checkpoint = null;
      if (this.config.disk_sessions) {
        await this.memory.pruneSnapshots();
        checkpoint = await this.client.saveSession(this.memory.snapshotFilename(role));
        await this.memory.recordSnapshot(role, {
          bytes: checkpoint.n_written ?? checkpoint.bytes ?? 0,
          pinned: this.config.pinned_roles.includes(role),
        });
        await this.memory.pruneSnapshots();
      }
      handoff = answer.text.slice(0, this.config.max_handoff_chars);
      outputs.push({ role, restored, compacted: trimmed.compacted, checkpoint, content: answer.text });
    }
    await this.memory.updateCore({
      last_task: objective,
      last_completed_roles: outputs.map((output) => output.role),
    });
    return outputs;
  }
}

export { trimTranscript };
