export const BASE = (process.env.STRATINFER_BASE || "http://127.0.0.1:11440").replace(/\/$/, "");

export function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) throw new Error(`${name} needs a value`);
  return args[index + 1];
}

export function positiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function finiteNumber(value, name, minimum = -Infinity, maximum = Infinity) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return parsed;
}

export async function fetchJson(path, init = {}, timeoutMs = 30_000) {
  const response = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${body.slice(0, 500)}`);
  try { return JSON.parse(body); }
  catch { throw new Error(`${path} returned invalid JSON: ${body.slice(0, 200)}`); }
}

export function chat(payload, timeoutMs = 600_000) {
  return fetchJson("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, timeoutMs);
}

export async function metrics() {
  const payload = await fetchJson("/metrics");
  return Array.isArray(payload.requests) ? payload.requests : [];
}

function metricKey(row) {
  if (row?.id) return `id:${row.id}`;
  if (!row || !Number.isFinite(row.time)) return null;
  return `legacy:${row.time}:${row.prompt_total ?? row.prompt_tokens ?? ""}:${row.output_tokens ?? ""}:${row.duration_s ?? ""}`;
}

export function metricIds(rows) {
  return new Set(rows.map(metricKey).filter(Boolean));
}

export function matchingMetric(rows, previousIds, usage) {
  const fresh = rows.filter(row => {
    const key = metricKey(row);
    return key && !previousIds.has(key);
  });
  if (!fresh.length) return null;
  const completion = usage?.completion_tokens;
  const prompt = usage?.prompt_tokens;
  return fresh.find(row =>
    (completion == null || row.output_tokens === completion) &&
    (prompt == null || row.prompt_tokens === prompt || row.prompt_total === prompt)) ?? fresh[0];
}

export async function waitForMetric(previousIds, usage, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = matchingMetric(await metrics(), previousIds, usage);
    if (match) return match;
    await sleep(250);
  }
  throw new Error(`the completed request did not appear in /metrics within ${timeoutMs} ms`);
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
