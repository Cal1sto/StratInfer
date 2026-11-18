import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { classifyAction, scanSecrets } from "./core.mjs";
import { planResourceProfile } from "./resources.mjs";

const BODY_LIMIT = 2 * 1024 ** 2;

function writeJson(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > BODY_LIMIT) throw new Error(`request body exceeds ${BODY_LIMIT} bytes`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function tokenMatches(expected, provided) {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(provided));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function requestToken(request) {
  const authorization = String(request.headers.authorization ?? "");
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "");
  return String(request.headers["x-noema-token"] ?? "");
}

function routeParts(pathname) {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

function statusForError(error) {
  if (/not found/i.test(error.message)) return 404;
  if (/unauthorized/i.test(error.message)) return 403;
  if (/timed out|unavailable|exited/i.test(error.message)) return 503;
  if (/invalid|must|require(?:d|s)?|contains|exceeds|outside|escape|blocked|already|only|unknown|failed|no checkpoint/i.test(error.message)) return 409;
  return 500;
}

function codexStatusAfterReview(verdict) {
  if (verdict === "PASS") return "running";
  if (verdict === "REVISE") return "planning";
  if (verdict === "ESCALATE") return "awaiting_human";
  return "blocked";
}

export function createNoemaServer({
  store,
  codex = null,
  worktrees = null,
  moai = null,
  token,
  host = "127.0.0.1",
  port = 12160,
  allowUnauthenticatedMutations = false,
} = {}) {
  if (!store) throw new Error("store is required");
  if (!allowUnauthenticatedMutations && !token) throw new Error("NOEMA token is required");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("NOEMA must listen on loopback");

  const authorize = (request) => {
    if (allowUnauthenticatedMutations) return;
    if (!tokenMatches(token, requestToken(request))) throw new Error("unauthorized");
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${host}:${port}`);
    const parts = routeParts(url.pathname);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return writeJson(response, 200, { service: "NOEMA", version: "0.1.0", status: "ok", codex: Boolean(codex), worktrees: Boolean(worktrees), moai: Boolean(moai), metrics: store.metrics() });
      }
      if (request.method === "GET" && url.pathname === "/api/agent/runs") return writeJson(response, 200, store.jarvisRuns());
      authorize(request);
      if (request.method === "GET" && url.pathname === "/metrics") return writeJson(response, 200, store.metrics());
      if (request.method === "GET" && url.pathname === "/v1/moai/status") {
        if (!moai) throw new Error("MOAI integration is unavailable");
        const [health, textEngine, helper] = await Promise.all([moai.health(), moai.textEngine(), moai.helperGpuMemory()]);
        return writeJson(response, 200, { health, textEngine, helper });
      }
      if (request.method === "GET" && url.pathname === "/v1/campaigns") return writeJson(response, 200, { campaigns: store.listCampaigns(Number(url.searchParams.get("limit") ?? 100)) });
      if (request.method === "POST" && url.pathname === "/v1/campaigns") return writeJson(response, 201, store.createCampaign(await readBody(request)));
      if (parts[0] === "v1" && parts[1] === "campaigns" && parts[2]) {
        const campaignId = parts[2];
        if (request.method === "GET" && parts.length === 3) {
          return writeJson(response, 200, { ...store.getCampaign(campaignId), worktree: store.worktree(campaignId), codexThread: store.codexThread(campaignId) });
        }
        if (request.method === "GET" && parts[3] === "events") {
          if (request.headers.accept?.includes("text/event-stream")) {
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
            let after = Number(url.searchParams.get("after") ?? 0);
            const flush = () => {
              for (const event of store.events(campaignId, after, 1000)) {
                after = event.seq;
                response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
              }
            };
            flush();
            const timer = setInterval(flush, 1000);
            request.on("close", () => clearInterval(timer));
            return;
          }
          return writeJson(response, 200, { events: store.events(campaignId, Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("limit") ?? 1000)), chain: store.verifyEventChain(campaignId) });
        }
        if (request.method === "POST" && ["pause", "resume", "cancel", "complete"].includes(parts[3])) {
          if (parts[3] === "complete") {
            const campaign = store.getCampaign(campaignId);
            if (!campaign.currentCheckpoint) throw new Error("campaign has no checkpoint to qualify completion");
            const review = store.latestReview(campaign.currentCheckpoint, "codex");
            if (review?.decision?.verdict !== "PASS") throw new Error("campaign completion requires a Codex PASS on the current checkpoint");
            if (!store.verifyEventChain(campaignId).valid) throw new Error("campaign completion requires a valid event chain");
          }
          const next = parts[3] === "pause" ? "paused" : parts[3] === "resume" ? "running" : parts[3] === "cancel" ? "cancelled" : "completed";
          return writeJson(response, 200, store.transitionCampaign(campaignId, next, "user", await readBody(request)));
        }
        if (request.method === "POST" && parts[3] === "checkpoints" && parts.length === 4) {
          const checkpoint = store.createCheckpoint(campaignId, await readBody(request));
          return writeJson(response, 201, checkpoint);
        }
        if (request.method === "POST" && parts[3] === "review") {
          if (!codex) throw new Error("Codex is unavailable; promotion is frozen");
          const campaign = store.getCampaign(campaignId);
          if (!campaign.currentCheckpoint) throw new Error("campaign has no checkpoint to review");
          if (campaign.status === "created") store.transitionCampaign(campaignId, "planning", "system", { reason: "first Codex review" });
          const current = store.getCampaign(campaignId);
          if (current.status !== "awaiting_codex") store.transitionCampaign(campaignId, "awaiting_codex", "system", { checkpointId: campaign.currentCheckpoint });
          const thread = store.codexThread(campaignId);
          if (thread && thread.turnCount >= campaign.spec.codexPolicy.maxTurns) throw new Error("Codex campaign turn limit reached");
          try {
            const threadId = thread?.threadId ?? await codex.startThread({ cwd: campaign.workspace });
            if (!thread) store.saveCodexThread(campaignId, threadId, campaign.currentCheckpoint);
            const checkpoint = store.getCheckpoint(campaign.currentCheckpoint);
            const decision = await codex.review({ threadId, campaign, checkpoint });
            const review = store.addReview(campaignId, checkpoint.id, "codex", decision);
            store.incrementCodexTurn(campaignId, checkpoint.id);
            store.transitionCampaign(campaignId, codexStatusAfterReview(decision.verdict), "codex", { reviewId: review.id, verdict: decision.verdict });
            return writeJson(response, 200, review);
          } catch (error) {
            store.appendEvent(campaignId, "codex.unavailable", "system", { error: error.message });
            if (store.getCampaign(campaignId).status === "awaiting_codex") store.transitionCampaign(campaignId, "running", "system", { promotionFrozen: true });
            throw error;
          }
        }
        if (request.method === "POST" && parts[3] === "worktree") {
          if (!worktrees) throw new Error("worktree support is unavailable");
          if (store.worktree(campaignId)) throw new Error("campaign already has a worktree");
          const body = await readBody(request);
          const campaign = store.getCampaign(campaignId);
          return writeJson(response, 201, store.saveWorktree(campaignId, await worktrees.create(campaign.workspace, body.revision ?? "HEAD")));
        }
        if (request.method === "GET" && parts[3] === "worktree" && parts[4] === "diff") {
          if (!worktrees) throw new Error("worktree support is unavailable");
          const worktree = store.worktree(campaignId);
          if (!worktree) throw new Error("campaign worktree not found");
          return writeJson(response, 200, await worktrees.diff(worktree.path));
        }
        if (request.method === "POST" && parts[3] === "worktree" && parts[4] === "apply") {
          if (!worktrees) throw new Error("worktree support is unavailable");
          const body = await readBody(request);
          const worktree = store.worktree(campaignId);
          if (!worktree) throw new Error("campaign worktree not found");
          const result = await worktrees.applyPatch(worktree.path, body.patch);
          store.appendEvent(campaignId, "worktree.patch-applied", "local-agent", { status: result.status, diffBytes: result.diff.length });
          return writeJson(response, 200, result);
        }
        if (request.method === "POST" && parts[3] === "worktree" && parts[4] === "run") {
          if (!worktrees) throw new Error("worktree support is unavailable");
          const body = await readBody(request);
          const worktree = store.worktree(campaignId);
          if (!worktree) throw new Error("campaign worktree not found");
          const result = await worktrees.run(worktree.path, body.command, body.args, { timeoutMs: body.timeoutMs, relativeCwd: body.relativeCwd });
          store.appendEvent(campaignId, "worktree.command", "local-agent", { command: body.command, args: body.args, code: result.code });
          return writeJson(response, 200, result);
        }
        if (request.method === "POST" && parts[3] === "resources" && parts[4] === "acquire") {
          if (!moai) throw new Error("MOAI integration is unavailable");
          const campaign = store.getCampaign(campaignId);
          let voice = { preserved: true };
          let helper = null;
          let plan = null;
          try {
            if (campaign.spec.resourceProfile === "agent-max") {
              const textEngine = await moai.textEngine();
              if (textEngine.selected !== "strata") throw new Error("agent-max measurement requires MOAI text engine strata so the existing helper cache is drained first");
              voice = await moai.releaseVoice();
            }
            helper = await moai.helperGpuMemory({ settleMs: campaign.spec.resourceProfile === "agent-max" ? 2500 : 0 });
            plan = planResourceProfile({ profile: campaign.spec.resourceProfile, helperFreeMiB: helper.freeMiB, helperTotalMiB: helper.totalMiB });
            if (!plan.viable) throw new Error(plan.errors.join("; "));
            const lease = store.createResourceLease(campaignId, campaign.spec.resourceProfile, { voice, helper, plan });
            return writeJson(response, 201, lease);
          } catch (error) {
            if (campaign.spec.resourceProfile === "agent-max" && !voice.preserved) await moai.restoreVoice(voice).catch(() => {});
            store.appendEvent(campaignId, "resource.acquire-failed", "system", { profile: campaign.spec.resourceProfile, error: error.message, helper, plan });
            throw error;
          }
        }
        if (request.method === "POST" && parts[3] === "resources" && parts[4] === "release") {
          if (!moai) throw new Error("MOAI integration is unavailable");
          const body = await readBody(request);
          const lease = store.resourceLease(body.leaseId);
          if (lease.campaignId !== campaignId) throw new Error("resource lease does not belong to campaign");
          const voice = lease.profile === "agent-max" ? await moai.restoreVoice(lease.details.voice) : { preserved: true };
          return writeJson(response, 200, store.releaseResourceLease(lease.id, { voice }));
        }
        if (parts[3] === "moai" && parts[4] === "text-engine") {
          if (!moai) throw new Error("MOAI integration is unavailable");
          if (request.method === "GET") return writeJson(response, 200, await moai.textEngine());
          if (request.method === "POST") {
            const body = await readBody(request);
            const before = await moai.textEngine();
            const target = String(body.id ?? "");
            if (!before.choices?.some((choice) => choice.id === target)) throw new Error(`unknown MOAI text engine: ${target}`);
            if (before.selected === target) return writeJson(response, 200, { changed: false, before, after: before, rollback: { id: before.selected } });
            const after = await moai.activateTextEngine(target);
            store.appendEvent(campaignId, "moai.text-engine-activated", "user", { from: before.selected, to: after.selected });
            return writeJson(response, 200, { changed: true, before, after, rollback: { id: before.selected } });
          }
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/resources/plan") return writeJson(response, 200, planResourceProfile(await readBody(request)));
      if (parts[0] === "v1" && parts[1] === "checkpoints" && parts[2] && request.method === "GET") {
        return writeJson(response, 200, store.getCheckpoint(parts[2]));
      }
      if (request.method === "POST" && url.pathname === "/v1/memory") {
        const body = await readBody(request);
        const secrets = scanSecrets(body.content ?? "");
        if (secrets.length) throw new Error(`memory contains possible secrets: ${secrets.join(", ")}`);
        return writeJson(response, 201, store.remember(body));
      }
      if (request.method === "GET" && url.pathname === "/v1/memory") {
        return writeJson(response, 200, { records: store.recall(url.searchParams.get("query") ?? "", { campaignId: url.searchParams.get("campaignId"), limit: Number(url.searchParams.get("limit") ?? 12) }) });
      }
      if (request.method === "POST" && url.pathname === "/v1/approvals") {
        const body = await readBody(request);
        const riskClass = classifyAction(body.action ?? {});
        return writeJson(response, 201, store.requestApproval(body.campaignId, body.action, riskClass));
      }
      if (parts[0] === "v1" && parts[1] === "approvals" && parts[2] && request.method === "POST" && parts[3] === "decision") {
        return writeJson(response, 200, store.decideApproval(parts[2], await readBody(request)));
      }
      if (request.method === "POST" && url.pathname === "/v1/candidates") {
        const body = await readBody(request);
        return writeJson(response, 201, store.createCandidate(body.campaignId, body));
      }
      if (parts[0] === "v1" && parts[1] === "candidates" && parts[2]) {
        if (request.method === "GET" && parts.length === 3) return writeJson(response, 200, store.getCandidate(parts[2]));
        if (request.method === "POST" && parts[3] === "promote") return writeJson(response, 200, store.promoteCandidate(parts[2], await readBody(request)));
        if (request.method === "POST" && parts[3] === "rollback") return writeJson(response, 200, store.rollbackCandidate(parts[2], "user"));
      }
      if (request.method === "GET" && url.pathname === "/v1/skills") return writeJson(response, 200, { skills: store.listSkills() });
      if (request.method === "POST" && url.pathname === "/v1/skills") return writeJson(response, 201, store.createSkill(await readBody(request)));
      if (parts[0] === "v1" && parts[1] === "skills" && parts[2]) {
        if (request.method === "GET" && parts.length === 3) return writeJson(response, 200, store.getSkill(parts[2]));
        if (request.method === "POST" && parts[3] === "promote") return writeJson(response, 200, store.promoteSkill(parts[2], await readBody(request)));
      }
      return writeJson(response, 404, { error: "route not found" });
    } catch (error) {
      return writeJson(response, statusForError(error), { error: error.message });
    }
  });

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      codex?.stop();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
