#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "./codex-app-server.mjs";
import { MoaiResourceClient } from "./resources.mjs";
import { createNoemaServer } from "./server.mjs";
import { NoemaStore } from "./store.mjs";
import { WorktreeManager } from "./worktree.mjs";

async function readConfiguration() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const configured = process.env.NOEMA_CONFIG;
  let fileConfig = {};
  if (configured) fileConfig = JSON.parse(await fs.readFile(path.resolve(configured), "utf8"));
  const dataRoot = path.resolve(process.env.NOEMA_ROOT ?? fileConfig.dataRoot ?? "E:/Data/NOEMA");
  let token = process.env.NOEMA_TOKEN ?? fileConfig.token ?? "";
  const tokenFile = process.env.NOEMA_TOKEN_FILE ?? fileConfig.tokenFile;
  if (!token && tokenFile) token = (await fs.readFile(path.resolve(tokenFile), "utf8")).trim();
  return {
    dataRoot,
    host: process.env.NOEMA_HOST ?? fileConfig.host ?? "127.0.0.1",
    port: Number(process.env.NOEMA_PORT ?? fileConfig.port ?? 12160),
    token,
    allowedWorkspaceRoots: fileConfig.allowedWorkspaceRoots ?? [path.resolve(here, "..", "..", "..", "..")],
    codex: {
      enabled: process.env.NOEMA_CODEX_ENABLED !== "0" && fileConfig.codex?.enabled !== false,
      command: process.env.NOEMA_CODEX_COMMAND ?? fileConfig.codex?.command ?? process.env.CODEX_CLI_PATH ?? "codex",
      model: process.env.NOEMA_CODEX_MODEL ?? fileConfig.codex?.model ?? null,
      reasoningEffort: fileConfig.codex?.reasoningEffort ?? "high",
    },
    moai: {
      enabled: process.env.NOEMA_MOAI_ENABLED !== "0" && fileConfig.moai?.enabled !== false,
      baseUrl: process.env.NOEMA_MOAI_BASE ?? fileConfig.moai?.baseUrl ?? "http://127.0.0.1:12150",
      token: process.env.NOEMA_MOAI_TOKEN ?? fileConfig.moai?.token ?? "",
    },
  };
}

const config = await readConfiguration();
if (!config.token) throw new Error("Set NOEMA_TOKEN or configure a local token before starting NOEMA");
const store = new NoemaStore({ root: config.dataRoot });
const worktrees = new WorktreeManager({ root: path.join(config.dataRoot, "worktrees"), allowedWorkspaceRoots: config.allowedWorkspaceRoots });
const codex = config.codex.enabled ? new CodexAppServer(config.codex) : null;
const moai = config.moai.enabled ? new MoaiResourceClient(config.moai) : null;
const runtime = createNoemaServer({ store, codex, worktrees, moai, token: config.token, host: config.host, port: config.port });
const address = await runtime.listen();
process.stdout.write(`NOEMA ready on http://${config.host}:${address.port}\n`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await runtime.close();
  store.close();
}
process.on("SIGINT", () => void close().finally(() => process.exit(0)));
process.on("SIGTERM", () => void close().finally(() => process.exit(0)));
