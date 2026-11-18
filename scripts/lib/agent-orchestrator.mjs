import { safeName } from "./context-memory.mjs";

function responseText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("");
  }
  throw new Error("the model response has no assistant content");
}

function estimateTokens(value, charsPerToken = 3.5) {
  return Math.ceil(String(value ?? "").length / charsPerToken);
}

function trimTranscript(messages, maxChars, maxTokens = Infinity, charsPerToken = 3.5) {
  let chars = messages.reduce((total, message) => total + String(message.content ?? "").length, 0);
  let start = 0;
  while ((chars > maxChars || Math.ceil(chars / charsPerToken) > maxTokens) && start < messages.length - 2) {
    chars -= String(messages[start].content ?? "").length;
    start += 1;
  }
  return { messages: messages.slice(start), compacted: start > 0, chars, estimated_tokens: Math.ceil(chars / charsPerToken) };
}

function parseVerdict(text) {
  const match = String(text).match(/(?:^|\n)\s*VERDICT\s*:\s*(PASS|REVISE|BLOCKED)\b/i);
  return match ? match[1].toUpperCase() : "UNKNOWN";
}

function mcpEvidence(payload, maxChars = 12_000) {
  const events = payload?.choices?.[0]?.message?.strata_mcp;
  if (!Array.isArray(events)) return "No structured MCP result was returned.";
  const evidence = events
    .filter((event) => event?.event === "result")
    .map((event) => [
      `TOOL: ${event.tool ?? event.name ?? "unknown"}`,
      `STATUS: ${event.ok === false ? "ERROR" : "OK"}`,
      String(event.text ?? ""),
    ].join("\n"))
    .join("\n\n");
  return (evidence || "No MCP tool result completed before the tool phase closed.").slice(-maxChars);
}

function needsConclusion(text, gate) {
  if (gate && parseVerdict(text) === "UNKNOWN") return true;
  return !/(?:^|\n)\s*RESULT\b/i.test(String(text));
}

function withoutToolMarkup(value) {
  return String(value ?? "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "[unfinished tool request omitted]")
    .replace(/<function=[\s\S]*?<\/function>/gi, "[unfinished tool request omitted]");
}

function blockedConclusion(role, phase, gate) {
  return [
    "RESULT",
    `The ${role} specialist did not produce a complete handoff after the bounded MCP phase and detached conclusion pass.`,
    "DECISIONS",
    "Do not infer approval from an incomplete specialist response.",
    "FILES",
    "No file modification is claimed.",
    "TESTS",
    "No additional executed test evidence was produced in this stage.",
    "RISKS",
    `The ${phase} review remains incomplete and must be repeated with narrower evidence.`,
    "NEXT",
    "Retry the specialist with a focused question or provide the missing evidence explicitly.",
    ...(gate ? ["VERDICT: BLOCKED"] : []),
  ].join("\n");
}

function runIdentifier() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

  async chat(messages, { maxTokens = 4096, temperature = 0.2, mcp = false, enableThinking = true } = {}) {
    const payload = await this.post("/v1/chat/completions", {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
      chat_template_kwargs: { enable_thinking: Boolean(enableThinking) },
      ...(mcp ? { strata_mcp: true } : {}),
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

  contextBudget(roleConfig) {
    const capacity = this.config.capacity ?? {};
    const charsPerToken = Number(capacity.chars_per_token ?? 3.5);
    const targetTokens = Number(roleConfig.context_tokens ?? capacity.target_context_tokens_per_agent ?? 131_072);
    const outputTokens = Number(roleConfig.max_tokens ?? this.config.max_tokens ?? 4096);
    const reserveTokens = Number(capacity.context_reserve_tokens ?? 8192);
    const inputTokens = Math.max(4096, targetTokens - outputTokens - reserveTokens);
    const transcriptTokens = Math.floor(inputTokens * Number(capacity.transcript_context_fraction ?? 0.72));
    const memoryTokens = Math.floor(inputTokens * Number(capacity.memory_context_fraction ?? 0.16));
    return {
      target_tokens: targetTokens,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      reserve_tokens: reserveTokens,
      transcript_tokens: transcriptTokens,
      transcript_chars: Math.min(Number(this.config.max_transcript_chars), Math.floor(transcriptTokens * charsPerToken)),
      memory_chars: Math.min(Number(this.config.memory_chars), Math.floor(memoryTokens * charsPerToken)),
      chars_per_token: charsPerToken,
    };
  }

  workflowQueue(explicitRoles) {
    if (explicitRoles) return explicitRoles.map((role) => ({ role, phase: "selected" }));
    const workflow = this.config.workflow;
    if (!workflow) return this.config.default_roles.map((role) => ({ role, phase: "default" }));
    const queue = [];
    for (const role of workflow.initial_roles) queue.push({ role, phase: "foundation" });
    workflow.gate_roles.forEach((role, index) => queue.push({
      role,
      phase: "initial-review",
      gate: true,
      gate_group_end: index === workflow.gate_roles.length - 1,
    }));
    queue.push({ role: workflow.remediation_role, phase: "integration-0" });
    workflow.final_gate_roles.forEach((role, index) => queue.push({
      role,
      phase: "verification-0",
      gate: true,
      gate_group_end: index === workflow.final_gate_roles.length - 1,
      verification_cycle: 0,
    }));
    return queue;
  }

  async runStage({ objective, stage, handoff, findings, runId }) {
    const role = safeName(stage.role);
    const roleConfig = this.config.roles[role];
    if (!roleConfig) throw new Error(`unknown agent role: ${role}`);
    const budget = this.contextBudget(roleConfig);
    const transcript = await this.memory.loadTranscript(role);
    const trimmed = trimTranscript(transcript, budget.transcript_chars, budget.transcript_tokens, budget.chars_per_token);
    const envelope = await this.memory.contextEnvelope(`${objective}\n${handoff}\n${findings}`, {
      role,
      limit: roleConfig.memory_results ?? this.config.memory_results,
      maxChars: roleConfig.memory_chars ?? budget.memory_chars,
    });
    const gateContract = stage.gate
      ? "QUALITY GATE\nEnd with exactly one line: VERDICT: PASS, VERDICT: REVISE, or VERDICT: BLOCKED. PASS requires evidence for every relevant acceptance criterion."
      : "QUALITY CONTRACT\nSeparate verified facts, measurements, assumptions and remaining risks. Do not claim success without evidence.";
    const userMessage = [
      envelope,
      "RUN",
      runId,
      "CURRENT SPECIALIST ROLE",
      role,
      "WORKFLOW PHASE",
      stage.phase,
      "CURRENT TASK",
      objective,
      "PREVIOUS SPECIALIST HANDOFF",
      handoff,
      "ACCUMULATED REVIEW FINDINGS",
      findings || "none",
      gateContract,
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
    let answer = await this.client.chat(messages, {
      maxTokens: budget.output_tokens,
      temperature: roleConfig.temperature ?? this.config.temperature,
      mcp: roleConfig.mcp === true,
      enableThinking: roleConfig.enable_thinking !== false,
    });
    let conclusionRetried = false;
    if (roleConfig.mcp === true && needsConclusion(answer.text, Boolean(stage.gate))) {
      conclusionRetried = true;
      const conclusionMessages = [
        {
          role: "system",
          content: `${roleConfig.system}\n\nFINALIZATION-ONLY MODE: no tools exist in this pass. Never emit tool XML or request another read. Produce the handoff from supplied evidence only.`,
        },
        {
          role: "user",
          content: [
            "TOOL PHASE CLOSED",
            "Conclude now from the verified evidence already returned below and the prior handoff.",
            "If evidence is insufficient, state that explicitly. A quality gate with insufficient evidence must use VERDICT: BLOCKED or VERDICT: REVISE, never omit its verdict.",
            "Return the required sections RESULT, DECISIONS, FILES, TESTS, RISKS and NEXT.",
            stage.gate ? "Finish with exactly one final verdict line." : "Do not claim that files were modified.",
            "CURRENT TASK",
            objective,
            "WORKFLOW PHASE",
            stage.phase,
            "PREVIOUS HANDOFF WITHOUT TOOL MARKUP",
            withoutToolMarkup(handoff).slice(-this.config.max_handoff_chars),
            "STRUCTURED MCP EVIDENCE",
            mcpEvidence(answer.payload, Number(this.config.max_mcp_evidence_chars ?? 12_000)),
          ].join("\n\n"),
        },
      ];
      answer = await this.client.chat(conclusionMessages, {
        maxTokens: budget.output_tokens,
        temperature: Math.min(Number(roleConfig.temperature ?? this.config.temperature ?? 0.2), 0.1),
        mcp: false,
        enableThinking: false,
      });
      if (needsConclusion(answer.text, Boolean(stage.gate))) {
        answer = { text: blockedConclusion(role, stage.phase, Boolean(stage.gate)), payload: answer.payload };
      }
    }
    const nextTranscript = [
      ...trimmed.messages,
      { role: "user", content: userMessage },
      { role: "assistant", content: answer.text },
    ];
    await this.memory.saveTranscript(role, nextTranscript);
    await this.memory.remember({
      kind: stage.gate ? "quality-gate" : "handoff",
      role,
      importance: stage.gate ? 0.85 : 0.65,
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
    return {
      run_id: runId,
      role,
      phase: stage.phase,
      gate: Boolean(stage.gate),
      verdict: stage.gate ? parseVerdict(answer.text) : null,
      conclusion_retried: conclusionRetried,
      restored,
      compacted: trimmed.compacted,
      context_budget: budget,
      estimated_prompt_tokens: messages.reduce((total, message) => total + estimateTokens(message.content, budget.chars_per_token), 0),
      checkpoint,
      content: answer.text,
    };
  }

  async run({ task, roles = null, runId = runIdentifier(), resume = false }) {
    const objective = String(task ?? "").trim();
    if (!objective) throw new Error("task is required");
    const workflow = this.config.workflow;
    let state = resume ? await this.memory.loadRun(runId) : null;
    if (resume && !state) throw new Error(`run not found: ${runId}`);
    if (state && state.objective !== objective) throw new Error("resume task does not match the stored run objective");
    if (state?.status === "completed") return state.outputs;
    if (state?.status === "blocked") throw new Error(state.blocked_reason ?? "run is blocked");
    if (state) {
      state.status = "running";
      delete state.error;
    }
    if (!state) {
      state = {
        status: "running",
        objective,
        queue: this.workflowQueue(roles),
        next_stage: 0,
        outputs: [],
        handoff: "none",
        findings: "",
        revision_cycles: 0,
        created_at: new Date().toISOString(),
      };
      await this.memory.saveRun(runId, state);
    }
    try {
      while (state.next_stage < state.queue.length) {
        const stage = state.queue[state.next_stage];
        const output = await this.runStage({
          objective,
          stage,
          handoff: state.handoff,
          findings: state.findings,
          runId,
        });
        state.outputs.push(output);
        state.handoff = output.content.slice(0, this.config.max_handoff_chars);
        if (output.gate) {
          state.findings = `${state.findings}\n\n[${output.role}/${output.phase}/${output.verdict}]\n${output.content}`.slice(-this.config.max_handoff_chars * 2);
        }
        state.next_stage += 1;
        if (stage.gate_group_end && stage.phase.startsWith("verification-") && workflow) {
          const group = state.outputs.filter((entry) => entry.phase === stage.phase);
          const blocked = group.some((entry) => entry.verdict === "BLOCKED");
          const passed = group.every((entry) => entry.verdict === "PASS");
          if (blocked) {
            state.status = "blocked";
            state.blocked_reason = `quality gate blocked during ${stage.phase}`;
          } else if (passed) {
            for (const role of workflow.final_roles) state.queue.push({ role, phase: "release" });
          } else if (state.revision_cycles < workflow.max_revision_cycles) {
            state.revision_cycles += 1;
            const cycle = state.revision_cycles;
            state.queue.push({ role: workflow.remediation_role, phase: `integration-${cycle}` });
            workflow.final_gate_roles.forEach((role, index) => state.queue.push({
              role,
              phase: `verification-${cycle}`,
              gate: true,
              gate_group_end: index === workflow.final_gate_roles.length - 1,
              verification_cycle: cycle,
            }));
          } else {
            state.status = "blocked";
            state.blocked_reason = `quality gates did not pass after ${workflow.max_revision_cycles} revision cycles`;
          }
        }
        await this.memory.saveRun(runId, state);
        if (state.status === "blocked") throw new Error(state.blocked_reason);
      }
      state.status = "completed";
      state.completed_at = new Date().toISOString();
      await this.memory.saveRun(runId, state);
    } catch (error) {
      if (state.status !== "blocked") state.status = "failed";
      state.error = error.message;
      await this.memory.saveRun(runId, state);
      throw error;
    }
    await this.memory.updateCore({
      last_task: objective,
      last_run_id: runId,
      last_completed_roles: state.outputs.map((output) => output.role),
    });
    return state.outputs;
  }
}

export { estimateTokens, parseVerdict, trimTranscript };
