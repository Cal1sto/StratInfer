# Hot reload and fast determinism - 2026-11-18

## Outcome

StratInfer now shortens hot continuation lookup, avoids repeatedly parking an unchanged
large K/V snapshot, and provides a separate fast deterministic profile. The normal
performance profile remains active. The deterministic profile is opt-in because exact
sampled output costs decode throughput and energy efficiency.

## Changes

- `ConversationCache::best` accepts the live/batch prefix already proved by the caller.
  Parked token vectors that cannot beat that prefix are no longer compared.
- `--conversation-cache-park-gain 2048` keeps the last exact snapshot until the active
  conversation grows by another 2,048 tokens.
- `bench_replay.mjs --continuations N` records each continuation instead of only one.
- The generated deterministic profile disables prompt reuse and adaptive movement,
  fixes the PCIe miss fraction at zero, and synchronizes expert commits.
- The engine overlay remains reproducible through `patches/hot-reload-cache.patch` and
  `scripts/apply-to-strata.ps1`.

## Hot-reload measurements

All accepted live requests targeted `http://127.0.0.1:11441` on the RTX 5090 StratInfer
profile. Exact reuse means the cached prefix was restored exactly; it does not mean that
the model output was forced deterministic.

| Scenario | Before | After | Result |
|---|---:|---:|---:|
| 25.4K prompt, hot lookup median | 499.3 ms (3 runs) | 429.3 ms (5 runs) | -14.0% |
| 25.4K cold prefill median | 7,181.4 ms | about 7,135 ms | no observed regression |
| 158.4K first hot resume | historical 1,546.1 ms | 1,493.1 ms | -3.4% |

The 158K case is dominated by the required first snapshot: 2,791,903,816 bytes were
parked in 1,173.7 ms. The new lookup reduces CPU token comparison, but cannot remove that
one-time transfer.

The park-growth setting targets the following short turns. One 39.7K-token live chain
produced:

| Request | Prompt read/reused | Prompt time |
|---|---:|---:|
| cold | 39,679 / 0 | 7,693.7 ms |
| continuation 1 | 34 / 39,674 | 612.3 ms |
| continuation 2 | 37 / 39,703 | 370.5 ms |
| continuation 3 | 37 / 39,735 | 412.7 ms |

The first continuation parked 964,367,448 bytes in 308.7 ms. No second large park was
logged. The median of continuations 2 and 3 is 391.6 ms: 36.0% below the first resume
and 94.9% below the cold prompt. The threshold deliberately delays a refreshed branch
snapshot by at most 2,047 new tokens; exact active-session reuse is preserved throughout.

## Deterministic profile

The accepted profile applies:

```text
--prompt-cache 0
--adapt-every 0
--adapt-swaps 0
--adapt-async 0
--pcie-frac 0
STRATA_ADAPT_ASYNC=0
STRATA_COMMIT_SYNC=1
STRATA_IQ_MT_MIN=1
```

Prompt-cache restoration, adaptive CPU/GPU expert placement and non-zero PCIe miss
routing each exposed numerically different logits in rejected variants. Seeded Philox
sampling can only reproduce output when it receives the same logits, so all three route
changes are disabled in strict mode.

| Determinism gate | Result |
|---|---:|
| seed 424242, 128 output tokens, 5 serial + 8 interleaved | 13/13 identical |
| seed 8675309, 96 output tokens, 3 serial + 3 interleaved | 6/6 identical |
| combined | 19/19 identical |

## Performance cost

Three requests per profile, 128 generated tokens:

| Metric | Performance | Fast deterministic | Delta |
|---|---:|---:|---:|
| decode median | 126.8 tok/s | 109.0 tok/s | -14.0% |
| TTFT median | 532.2 ms | 528.0 ms | -0.8% |
| total tokens/J median | 0.5324 | 0.4961 | -6.8% |
| incremental tokens/J median | 0.6191 | 0.5178 | -16.4% |
| peak RTX 5090 memory | 29,947 MiB | 29,831 MiB | -116 MiB |

The TTFT difference is inside normal run-to-run noise. The decode and energy penalties
are large enough to keep deterministic mode opt-in, but far smaller than the obsolete
2.1-2.7 tok/s fixed-placement result from the earlier investigation.

## Validation and deployment

- `conversation_cache_test`: 4,844 checks passed.
- Deterministic profile unit tests: 3/3 passed.
- Clean upstream overlay preflight and application: passed.
- Built engine SHA-256:
  `E052E8C025158C97D1AE58E8CCF3C6B45EDE39DE241C75FD1E3CE96D3E0363BA`.
- Live profile contains `--conversation-cache-park-gain 2048`.
- Separate `profile.fast-deterministic.json` contains the strict settings and the same
  park-growth limit.
- MOAI returned to `stratinfer`; Qwen ASR PID 58792 and Qwen TTS PID 12992 were preserved.

## Reproduction

```powershell
$env:STRATINFER_BASE = "http://127.0.0.1:11441"
node scripts/bench_replay.mjs `
  --expect-base http://127.0.0.1:11441 --tokens 25000 --continuations 3
node scripts/verify_determinism.mjs `
  --expect-base http://127.0.0.1:11441 `
  --seed 424242 --serial 5 --rounds 8 --concurrency 4 `
  --tokens 128 --noise-tokens 16 --pcie-frac 0
```

Raw evidence is under
`reports/data/hot-deterministic-2026-11-18/`. The 39.7K run is
`park-gain-patched/replay-1795022620879.json`; accepted hashes are under
`accepted-fast-deterministic/`; paired efficiency files are under `throughput/`.

## Limits

- The hot-reload A/B has 3 baseline and 5 patched lookup runs; the park-growth chain is
  one controlled three-continuation run.
- The first large snapshot transfer remains necessary after a cold prompt or a branch
  change.
- Strict mode validates sampled text output only. Vision kernels, MCP tool side effects,
  ASR and TTS are not claimed byte-deterministic by this gate.
- One exploratory replay accidentally targeted port 11440 and is retained under
  `rejected-wrong-endpoint/`; it is excluded from every accepted metric above.
