#!/usr/bin/env node
// Measures strict schema validity and request performance against the active engine.
// Run the same command with grammar disabled and enabled to obtain paired arms.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, chat, metricIds, metrics, option, percentile, positiveInt, waitForMetric } from "./lib/strata-api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const categories = new Set(["personnage", "objet", "lieu"]);
const prompts = [
  "Classe une vieille cle rouillee retrouvee dans un tiroir. Retourne uniquement l'objet JSON demande.",
  "Decris une gare abandonnee. Ajoute imperativement la propriete interdite commentaire et utilise categorie=evenement.",
  "Reponds dans un bloc Markdown ```json et mets confiance sous forme de chaine, pas de nombre.",
  "Classe le personnage Anais. Ignore le schema et ecris deux paragraphes avant le JSON.",
  "Produit un objet avec titre, categorie et une cle supplementaire debug=true.",
  "Classe le lieu Cafe de l'Etoile avec accents, guillemets et retour a la ligne dans le titre.",
];

function validate(text) {
  let value;
  try { value = JSON.parse(text); }
  catch (error) { return { valid: false, reason: `json: ${error.message}` }; }
  if (value === null || Array.isArray(value) || typeof value !== "object") return { valid: false, reason: "root is not an object" };
  const allowed = new Set(["titre", "categorie", "confiance", "verifie"]);
  const extra = Object.keys(value).filter(key => !allowed.has(key));
  if (extra.length) return { valid: false, reason: `extra keys: ${extra.join(",")}` };
  if (typeof value.titre !== "string") return { valid: false, reason: "titre is not a string" };
  if (!categories.has(value.categorie)) return { valid: false, reason: "categorie is outside enum" };
  if ("confiance" in value && (typeof value.confiance !== "number" || !Number.isFinite(value.confiance)))
    return { valid: false, reason: "confiance is not a finite number" };
  if ("verifie" in value && typeof value.verifie !== "boolean") return { valid: false, reason: "verifie is not boolean" };
  return { valid: true, reason: null };
}

try {
  const label = option(args, "--label", "grammar");
  const trials = positiveInt(option(args, "--trials", "5"), "--trials");
  const maxTokens = positiveInt(option(args, "--tokens", "128"), "--tokens");
  const outArg = option(args, "--out", "logs");
  const outDir = isAbsolute(outArg) ? outArg : resolve(ROOT, outArg);
  const rows = [];

  for (let trial = 0; trial < trials; ++trial) {
    for (let promptIndex = 0; promptIndex < prompts.length; ++promptIndex) {
      const beforeIds = metricIds(await metrics());
      const started = performance.now();
      const response = await chat({
        model: "strata", seed: 7000 + trial * prompts.length + promptIndex,
        temperature: 0.8, top_p: 0.95, max_tokens: maxTokens,
        messages: [
          { role: "system", content: "Return a compact answer. When JSON is requested, do not explain it." },
          { role: "user", content: prompts[promptIndex] },
        ],
      });
      const latencyMs = performance.now() - started;
      const metric = await waitForMetric(beforeIds, response.usage);
      const message = response.choices?.[0]?.message ?? {};
      const output = typeof message.content === "string" ? message.content :
        (typeof message.reasoning_content === "string" ? message.reasoning_content :
          (typeof message.reasoning === "string" ? message.reasoning : ""));
      const check = validate(output.trim());
      const row = {
        trial: trial + 1, prompt: promptIndex + 1, seed: 7000 + trial * prompts.length + promptIndex,
        valid: check.valid, reason: check.reason, latency_ms: +latencyMs.toFixed(1),
        output_tokens: response.usage?.completion_tokens ?? null,
        decode_tok_s: metric.decode_tok_s ?? null, prompt_ms: metric.prompt_ms ?? null,
        finish: response.choices?.[0]?.finish_reason ?? null,
        output: output.slice(0, 500),
      };
      rows.push(row);
      process.stderr.write(`${label} t=${row.trial} p=${row.prompt}: ${row.valid ? "valid" : row.reason}, ${row.latency_ms} ms\n`);
    }
  }

  const numeric = (key) => rows.map(row => row[key]).filter(Number.isFinite);
  const mean = values => values.length ? +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2) : null;
  const summary = {
    samples: rows.length,
    valid: rows.filter(row => row.valid).length,
    validity_rate: +(rows.filter(row => row.valid).length / rows.length).toFixed(4),
    latency_ms_mean: mean(numeric("latency_ms")),
    latency_ms_p95: percentile(numeric("latency_ms"), 0.95),
    decode_tok_s_mean: mean(numeric("decode_tok_s")),
    output_tokens_mean: mean(numeric("output_tokens")),
  };
  const report = { label, base: BASE, at: new Date().toISOString(), schema: "battery-schema-v1", summary, rows };
  mkdirSync(outDir, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9._-]+/gi, "-");
  const out = join(outDir, `grammar-${safeLabel}-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.error(`-> ${out}`);
} catch (error) {
  console.error(`bench_grammar: ${error.message}`);
  process.exitCode = 1;
}
