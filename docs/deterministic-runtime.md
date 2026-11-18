# Deterministic runtime mode

StratInfer provides an opt-in strict profile for reproducible sampled output. It is a
validation and debugging mode, not the default performance profile.

## Why seeded requests could diverge

The sampler already uses Philox keyed by seed and token position. That makes the random
draw independent of request interleaving, but it does not help when the logits presented
to the sampler differ. Runtime placement can change those logits:

1. asynchronous adaptive expert swaps are explicitly not bit-exact;
2. an expert computed on the GPU rounds differently from the same expert computed on the
   CPU, so changing residency changes later logits and sampled tokens.

The strict profile freezes expert placement, disables path-changing prompt reuse and
forces synchronous expert commits. The live matrix also found that a non-zero PCIe miss
fraction can select a numerically different CPU/GPU route, so strict mode keeps that
fraction at zero.

## Generate a strict profile

Keep the performance profile intact and generate a separate file:

```powershell
node scripts/make-deterministic-profile.mjs `
  --input C:\runtime\profile.json `
  --output C:\runtime\profile.deterministic.json
```

The generated profile is idempotent and applies:

- `--prompt-cache 0`;
- `--adapt-every 0`;
- `--adapt-swaps 0`;
- `--adapt-async 0`;
- `--pcie-frac 0`;
- `STRATA_ADAPT_ASYNC=0`;
- `STRATA_COMMIT_SYNC=1`;
- `STRATA_IQ_MT_MIN=1`;

Unrelated settings remain unchanged, including MTP/speculation, RTX 4080 parked-K/V
limits, model paths, and SSD session paths. Disabling prompt reuse and adaptive expert
movement makes this profile slower; measure the cost on the deployed model instead of
assuming it is negligible.

On the validated RTX 5090 profile, two seeds produced 19/19 identical sampled hashes:
13/13 at 128 generated tokens and 6/6 at 96. The paired three-request efficiency gate
measured 109.0 tok/s in strict mode versus 126.8 tok/s in the performance profile
(-14.0%). Median TTFT remained effectively unchanged (528.0 versus 532.2 ms), while
incremental tokens per joule fell from 0.6191 to 0.5178 (-16.4%). This is fast enough for
qualification and exact replay, but the performance profile remains the interactive
default.

## Validate the intended engine

Always name the endpoint twice: once through the client environment and once as an
assertion. The command fails before inference if they differ.

```powershell
$env:STRATINFER_BASE = "http://127.0.0.1:11441"
node scripts/verify_determinism.mjs `
  --expect-base http://127.0.0.1:11441 `
  --seed 424242 --serial 5 --rounds 8 --concurrency 4 `
  --tokens 128 --noise-tokens 16
```

Acceptance requires identical SHA-256 output hashes for every serial and interleaved
target request. Run performance, strict, and rollback profiles as separate processes;
the synchronization setting is startup-scoped.

## What the fix improves

- reproducible bug reports and benchmark comparisons;
- stable agent retries and exact replay checks;
- reliable cache, grammar, and long-session regression tests;
- failures that reflect code changes rather than GPU scheduling noise.

It does not improve model intelligence or output quality by itself. Its direct cost is
disabled adaptive movement, disabled prompt caching and a CPU-only expert-cache miss
route. Keep the performance profile for normal interactive use unless exact replay is
required. MCP tools and other external side effects are outside text-output determinism.

The current live investigation and raw-evidence map are in
[`../reports/hot-reload-determinism-2026-11-18.md`](../reports/hot-reload-determinism-2026-11-18.md).
