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

The strict profile freezes expert placement and disables other path-changing caches. A
device-wide fence was also tested and rejected: it did not remove the placement trade-off
and reduced decode to the same low-throughput range.

## Generate a strict profile

Keep the performance profile intact and generate a separate file:

```powershell
node scripts/make-deterministic-profile.mjs `
  --input C:\runtime\profile.json `
  --output C:\runtime\profile.deterministic.json
```

The generated profile is idempotent and applies:

- `--prompt-cache 0`;
- `--adapt-swaps 0`;
- `--adapt-async 0`;
- `--pcie-frac 0`;
- `STRATA_ADAPT_ASYNC=0`;
- `STRATA_IQ_MT_MIN=1`;

Unrelated settings remain unchanged, including MTP/speculation, RTX 4080 parked-K/V
limits, model paths, and SSD session paths. Disabling prompt reuse and adaptive expert
movement makes this profile slower; measure the cost on the deployed model instead of
assuming it is negligible.

On the validated RTX 5090 profile, fixed placement produced 13/13 identical sampled
hashes while synchronous adaptive placement produced 4/5. Fixed-placement decode was
2.1-2.7 tok/s in this short gate, versus a 153.7 tok/s median for the previously measured
performance profile. These prompts and output lengths are not a paired throughput A/B,
but the regression is too large to make strict mode the interactive default.

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
disabled adaptive movement and disabled prompt caching in the strict
profile. Keep the performance profile for normal interactive use unless exact replay is
required.

The live investigation and raw-evidence map are in
[`../reports/determinism-fix-2026-11-02.md`](../reports/determinism-fix-2026-11-02.md).
