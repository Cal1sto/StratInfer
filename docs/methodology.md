# Methodology — how to A/B a live engine without wrecking it

The whole point of this harness: config changes on a live inference engine are downtime,
and measurement noise on a single GPU is large enough to fake wins. The protocol below is
what separated real gains (+8 %, 18× resume) from fake ones (+0.6 % noise, +5.4 % artifact)
in this project.

## 1. Telemetry before anything (48 h)

`scripts/audit.mjs --watch --every 300` appends one JSON line per sample from read-only
endpoints (`/health`, `/metrics`, `/status`): decode tok/s, expert-cache hit rate, reused
prompt ratio, draft acceptance, engine knobs in effect. `--report` aggregates mean/p95.
Two purposes: a real baseline (not one lucky run), and surfacing silent pathologies — the
biggest win of the whole project (C2) came from *counting log lines*, not from an idea.

## 2. Two benches, for two different lies

- `bench_ab.mjs` — fixed suite (code / prose / 32K-token agent), repeats. Catches regressions
  and measures decode speed. **Lies about prefill once a prompt cache exists**: the second
  run reuses instead of re-prefilling.
- `bench_fresh.mjs` — every trial embeds a unique random marker, zero cache reuse. This is
  the only honest prefill measurement under an aggressive cache. Both are needed; C1 was
  only decidable with the fresh one.

## 3. Noise band first

Repeat runs before any change; record the spread (here ±3 %). Nothing is a "win" below
2× the noise band. Acceptance criteria are written into each candidate file *before* the
cutover, e.g. "prefill may cost 2–5 % only if decode gains ≥ 5 %" (C3a passed exactly this
rule; C1 died by it).

## 4. Cutovers are scripted, reversible, and consented

`scripts/cutover-template.ps1`: timestamped profile backup → validate anchor strings exist
(stop/start commands, health URL, profile path) → stop engine → apply args/env delta →
start → poll `/health` with timeout → **failsafe: if the engine does not come back, restore
the backup automatically**. A restart kills whatever agents run on the engine — always
schedule it explicitly, never as a side effect of "just testing". Keep named backups
(`configs/backups/` is machine-local and gitignored); restore *by name*, not "latest".

## 5. Model-based studies are only as good as their cost curve

The DSpark simulation (RFC-02) flipped from "+5.4 %" to "+0.1 %" when the verification-cost
model changed from an affine fit to exact interpolation through three measured points. Rule:
a simulated policy gain is only trustworthy if the simulation reproduces the measured
*fixed* baselines within noise first. `proto/dspark_sim.py` prints that calibration check.

## 6. Negative results ship

C1 (doc-promised 1.8× → +0.6 %), C4 (depth sweep → default optimal), RFC-02 (scheduling →
refuted) are documented with their tables, because they bound what the next person should
not spend a weekend on.
