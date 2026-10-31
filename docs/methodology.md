# Methodology: A/B a live engine safely

Single-GPU inference is noisy, prompt caches hide prefill work, and an engine restart is
real downtime. StratInfer uses the following protocol to distinguish useful changes from
component-only wins and simulation artifacts.

## 1. Record a baseline

Run `scripts/audit.mjs --watch --every 300` for a representative window. Capture decode
speed, prompt reuse, expert-cache hit rate, draft acceptance, and active configuration.
Repeat fixed benches to establish the noise band before changing anything.

## 2. Match each question to a benchmark

- `bench_ab.mjs`: fixed prompts for decode and regression comparisons.
- `bench_fresh.mjs`: unique prompts so cache reuse cannot fake prefill speed.
- `bench_concurrency.mjs`: aggregate throughput and p50/p95 request latency by load.
- `bench_replay.mjs`: cold prompt cost versus exact continuation reuse.
- `bench_grammar.mjs`: adversarial JSON-Schema validity and request performance.
- `verify_determinism.mjs`: same seeded output alone and under interleaving.

All live scripts read `STRATINFER_BASE` and write machine-readable JSON reports. Use
`bench_ab.mjs --compare <files...>` to summarize saved runs instead of copying one lucky
console number.

## 3. Define acceptance and rollback first

Every candidate records its delta, acceptance threshold, rollback, and final verdict in
`configs/candidates/`. A change below twice the measured noise band is not a win. A local
trade-off must satisfy its predeclared budget; for example, `k8v4` was accepted only if a
2-5% prefill cost bought at least 5% decode speed.

## 4. Separate evidence levels

Report each result as one of:

1. source analysis;
2. unit or parity test;
3. isolated component microbenchmark;
4. offline calibrated simulation;
5. live end-to-end A/B.

Never turn a kernel launch time into an end-to-end throughput claim. A simulation must
first reproduce measured fixed-policy baselines within the noise band.

## 5. Preserve invariants

Correctness gates precede throughput:

- constrained decoding commits no invalid token;
- deterministic sampling is stable under request interleaving;
- replay restores exact conversation state;
- opt-in features leave the default path unchanged;
- unsupported deployment modes fail closed.

## 6. Use a reversible cutover

`scripts/cutover-template.ps1` takes explicit stop and start command arrays, creates a
timestamped backup, starts the candidate, and health-checks it. On failure it restores the
backup and starts the reference profile. Never use the current live profile as a scratch
configuration, and never restart it without an agreed cutover window.

## 7. Publish negative results

Rejected candidates prevent repeated work. This repository records the +0.6% GDN result,
the slower speculation depths, and the +0.1% confidence policy alongside accepted wins.
