import os from "node:os";

const MIB = 1024 ** 2;

export function planResourceProfile({
  profile = "agent-max",
  helperFreeMiB,
  helperTotalMiB,
  hostFreeGiB = os.freemem() / 1024 ** 3,
  snapshotMiB = 2451,
} = {}) {
  if (!Number.isFinite(helperFreeMiB) || !Number.isFinite(helperTotalMiB)) throw new Error("helper GPU memory measurements are required");
  if (!['agent-max', 'voice-balanced'].includes(profile)) throw new Error(`unknown resource profile: ${profile}`);
  const reserveMiB = 4096;
  const targetMiB = profile === "agent-max" ? 10_240 : 4096;
  const availableMiB = Math.max(0, Math.floor(helperFreeMiB - reserveMiB));
  const helperCacheMiB = Math.max(0, Math.min(targetMiB, Math.floor(availableMiB / 512) * 512));
  const hostCacheMiB = hostFreeGiB >= 32 ? 16_384 : hostFreeGiB >= 24 ? 12_288 : 8192;
  const errors = [];
  if (profile === "agent-max" && helperCacheMiB < 8192) errors.push("agent-max requires at least 8 GiB of safe helper cache after the 4 GiB reserve");
  if (profile === "voice-balanced" && helperCacheMiB < 4096) errors.push("voice-balanced requires 4 GiB of safe helper cache");
  return {
    profile,
    viable: errors.length === 0,
    errors,
    helper: {
      totalMiB: helperTotalMiB,
      freeMiB: helperFreeMiB,
      reserveMiB,
      targetMiB,
      cacheMiB: helperCacheMiB,
      estimatedHotSnapshots: Math.floor(helperCacheMiB / snapshotMiB),
    },
    host: { freeGiB: Number(hostFreeGiB.toFixed(2)), cacheMiB: hostCacheMiB, minFreeGiB: 16 },
    ssd: { globalBudgetGiB: 128, campaignBudgetGiB: 64, minFreeGiB: 256 },
  };
}

export class MoaiResourceClient {
  constructor({ baseUrl = "http://127.0.0.1:12150", token = "", timeoutMs = 30_000 } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("MOAI base URL must be loopback HTTP");
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = "GET", body = null, admin = false, timeoutMs = this.timeoutMs } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body === null ? {} : { "content-type": "application/json" }),
        ...(admin && this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`MOAI ${path} returned ${response.status}: ${payload.error ?? text}`);
    return payload;
  }

  health() {
    return this.request("/health");
  }

  requireAdminToken() {
    if (!this.token) throw new Error("MOAI administrator token is required for supervised mutations");
  }

  status() {
    this.requireAdminToken();
    return this.request("/api/status", { admin: true });
  }

  textEngine() {
    this.requireAdminToken();
    return this.request("/api/text/engine", { admin: true });
  }

  async activateTextEngine(id, { pollIntervalMs = 1000, maxWaitMs = 12 * 60_000 } = {}) {
    this.requireAdminToken();
    const target = String(id);
    const activation = await this.request("/api/text/engine", { method: "POST", body: { id: target }, admin: true, timeoutMs: maxWaitMs });
    const deadline = Date.now() + maxWaitMs;
    let lastHealth = null;
    while (Date.now() < deadline) {
      lastHealth = await this.health();
      const selected = lastHealth.textEngine?.selected;
      const active = lastHealth.textEngine?.choices?.find((choice) => choice.id === target)?.active;
      const qwen = lastHealth.residentModels?.qwen;
      if (selected === target && active === true && lastHealth.textEngine?.switching === false && lastHealth.loaded === true && qwen?.ready === true && qwen?.loading !== true) {
        return { ...activation, selected: target, readiness: { loaded: true, qwenReady: true } };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(5000, pollIntervalMs))));
    }
    throw new Error(`MOAI text engine ${target} did not become ready within ${maxWaitMs} ms: ${JSON.stringify(lastHealth?.residentModels?.qwen ?? null)}`);
  }

  async helperGpuMemory({ settleMs = 0 } = {}) {
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, settleMs)));
    const status = await this.status();
    const helper = status.telemetry?.gpus?.find((gpu) => /RTX\s*4080/i.test(gpu.name));
    if (!helper || !Number.isFinite(helper.totalBytes) || !Number.isFinite(helper.freeBytes)) {
      throw new Error("MOAI did not report usable RTX 4080 memory telemetry");
    }
    return {
      uuid: helper.uuid,
      name: helper.name,
      totalMiB: Math.floor(helper.totalBytes / MIB),
      freeMiB: Math.floor(helper.freeBytes / MIB),
      usedMiB: Number.isFinite(helper.usedBytes) ? Math.ceil(helper.usedBytes / MIB) : null,
    };
  }

  async releaseVoice() {
    this.requireAdminToken();
    const before = await this.health();
    if (before.asr?.busy || before.asr?.pending || before.speech?.busy || before.speech?.pending) throw new Error("voice work is active");
    const speech = await this.request("/api/speech/release", { method: "POST", body: {}, admin: true, timeoutMs: 60_000 });
    let asr;
    try {
      asr = await this.request("/api/asr/release", { method: "POST", body: {}, admin: true, timeoutMs: 60_000 });
    } catch (error) {
      if (before.speech?.ready) await this.request("/api/speech/prepare", { method: "POST", body: {}, admin: true, timeoutMs: 180_000 }).catch(() => {});
      throw error;
    }
    const after = await this.health();
    if (after.asr?.ready || after.speech?.ready) throw new Error("voice services remained resident after release");
    return { before: { asr: before.asr, speech: before.speech }, released: { asr, speech }, after: { asr: after.asr, speech: after.speech } };
  }

  async restoreVoice(snapshot = null) {
    this.requireAdminToken();
    const restoreAsr = snapshot?.before?.asr?.ready ?? true;
    const restoreSpeech = snapshot?.before?.speech?.ready ?? true;
    const asr = restoreAsr ? await this.request("/api/asr/prepare", { method: "POST", body: {}, admin: true, timeoutMs: 180_000 }) : { skipped: true };
    const speech = restoreSpeech ? await this.request("/api/speech/prepare", { method: "POST", body: {}, admin: true, timeoutMs: 180_000 }) : { skipped: true };
    const after = await this.health();
    if ((restoreAsr && !after.asr?.ready) || (restoreSpeech && !after.speech?.ready)) throw new Error("voice services failed to return to their previous readiness state");
    return { asr, speech, after: { asr: after.asr, speech: after.speech } };
  }
}

export function bytesToMiB(value) {
  return Math.round(Number(value) / MIB);
}
