# Results

This file separates live end-to-end measurements, offline simulations, build/test
evidence, and isolated kernel microbenchmarks. Numbers from one evidence level are not
promoted to another.

## Test environment

- one RTX 5090, 32 GiB;
- Windows workstation;
- approximately 28 GiB IQ3_S quantized MoE;
- 248,320-token vocabulary and up to 512K context;
- CUDA 13.1 for the overlay build;
- Strata overlay based on commit `870aedd`;
- llama.cpp pinned to `3cf0325` for the validated build;
- repeated live baseline noise at or below approximately 3%.

## Live configuration results

| Candidate | Primary result | Verdict |
|---|---|---|
| C2 conversation cache, 512 to 4096 MiB | 1,441 parking budget rejections/day to 0 | Kept |
| C3 `k8v4` | decode 91.38 to 98.65 tok/s (+8.0%); fresh prefill about -4.2% | Kept |
| C1 chunked GDN | +0.6% fresh prefill, inside noise | Rejected |
| C4 speculation depth | depth 5: -10.6%; depth 3: -3.5% against depth 4 | Rejected |

### C2: conversation cache

The initial 512 MiB budget was smaller than observed 2.2-2.6 GiB snapshots and made
parking structurally unavailable for long agent conversations. Raising it to 4096 MiB,
with eight slots and a 2,048-token minimum, produced:

- zero budget rejections in the matched overnight log;
- a 131,363-token continuation with 130,990 reused tokens and 373 read tokens in 1.3 s,
  instead of roughly 24 s cold;
- a 15,383-token continuation in 55 ms instead of roughly 3.5 s cold;
- about 3.5 GiB additional host-memory budget on a machine with ample free RAM.

### C3: `k8v4`

The acceptance rule was written before cutover: a 2-5% fresh-prefill cost required at
least 5% decode improvement.

- decode: 98.65 versus 91.38 tok/s across six trials (+8.0%);
- fresh 65K prefill: -4.3%;
- fresh 16K prefill: -4.1%;
- expert-cache hit rate remained about 0.94.

The candidate passed its declared trade-off and stayed enabled.

### C1: chunked GDN

Fresh unique prompts were required so the conversation cache could not convert a prefill
test into reuse.

| Prompt | GDN on | GDN off | Delta |
|---|---:|---:|---:|
| 65K tokens | 4,502 tok/s | 4,475 tok/s | +0.6% |
| 16K tokens | 4,179 tok/s | 4,153 tok/s | +0.6% |

The result is inside the +/-3% noise band. An isolated recurrence multiplier did not
translate to full MoE prefill on this quantization and hardware, so the option was removed.

### C4: speculation depth

| Configuration | Decode | Pooled acceptance |
|---|---:|---:|
| depth 4, stock | 98.6 tok/s | 0.613 |
| depth 5, min-p 0.45 | 88.2 tok/s | 0.566 |
| depth 3, min-p 0.50 | 95.2 tok/s | 0.683 |

Higher draft acceptance did not compensate for verification cost. The stock depth 4
configuration remained enabled.

## Structured-output studies

### Client-side prototype

The Python reference automaton uses byte-level whole-token validation against the real
248,320-token vocabulary.

- exhaustive HTTP `logit_bias`: semantically correct but 39.1 s per generated token with
  an approximately 3.7 MB request payload;
- partial assistant prefill: rejected by the serving template, which closes the assistant
  turn and restarts generation;
- turn-level lazy rejection: 3/3 strictly schema-valid outputs versus 3/6 unconstrained
  in the small battery.

The prototype established that token-level enforcement belongs inside the engine. It did
not establish production throughput.

### Draft-chain simulation

`proto/s2_draftchain.py` advances the grammar along the speculative chain, rejects the
first invalid draft and its dependent suffix, then draws a masked replacement. A fresh
2,000-tour run with seed 7 used the measured 35 ms depth-4 window cost and 0.613 pooled
acceptance.

| Metric | Free generation | Grammar rule |
|---|---:|---:|
| schema validity | 52.9% | 100% |
| windows per completed tour | 48.28 | 48.70 |
| attempts per guaranteed-valid output | 1.89 | 1.00 |
| simulated effective valid-output wall time | baseline | 1.87x |

This is an offline algorithm result. The 1.87x value comes from avoiding regenerate loops
in that calibrated workload; it is not a live Strata speedup claim.

## DeepInfer-style speculation policy

`proto/dspark_sim.py` uses 2,759 real requests and exact interpolation through measured
verification costs: 32.0 ms at depth 3, 35.0 ms at depth 4, and 43.4 ms at depth 5.

- fixed-policy simulation reproduced the measured ordering: depth 3 -5.0%, depth 4
  baseline, depth 5 -10.4%;
- the per-request best-depth policy improved only +0.1%;
- an earlier affine cost fit had falsely reported +5.4%.

The confidence policy is rejected as stated. A future policy needs per-rank acceptance
evidence and a cost model that reproduces all fixed baselines inside the measured noise.

## Integrated `sm_120` overlay

The overlay was applied to a fresh Strata worktree and built in Release mode with CUDA
13.1 and `CMAKE_CUDA_ARCHITECTURES=120-real`.

### Build products

- `strata.exe`, approximately 79.9 MB;
- `strata-q36.exe`, approximately 60.6 MB;
- `grammar_mask_parity.exe` with embedded `sm_120` cubins.

`cuobjdump` reported both grammar parity cubins as `sm_120`.

### Tests

CTest result: 4/4 passed.

| Test | Coverage |
|---|---|
| `json_automaton_test` | strict JSON, schema, enum, duplicate-key, and draft-chain cases |
| `gguf_tokens_test` | bounded token metadata and EOS/EOT control-token policy |
| `qwen35_philox_test` | position-keyed draw and order invariance |
| `grammar_mask_parity` | CPU/GPU effective-bias parity on CUDA |

The fresh overlay installer also passed `git apply --check --recount`, a real apply, and
`git diff --check` against an unmodified Strata worktree.

### Grammar-mask microbenchmark

For a 248,320-token vocabulary:

| Isolated operation | Result |
|---|---:|
| kernel only | 7.337 us/launch |
| pinned 30.3 KiB upload plus kernel | 104.321 us/state change |
| packed allowed-token transfer | 30.3 KiB |
| equivalent dense FP32 bias | about 970 KiB |

The state-signature cache avoids rebuilding or uploading an unchanged mask. These are
component measurements only; the end-to-end decode gate remains open.

## Determinism

The Qwen3.8 verifier already keys Philox by seed and token position. The overlay adds a
live serial/interleaving hash harness. The separate Qwen3.6 host sampler was changed from
a mutable `mt19937_64` stream to the same position-keyed contract, and its unit test passes.

The live interleaving matrix is still pending because it must run against a separate test
profile without disrupting the active engine.

## Remaining gates

No result in this section is claimed complete yet:

- at least 10,000 grammar-constrained live samples over representative schemas;
- zero invalid committed output with speculation on and off;
- at least 95% of unconstrained decode throughput;
- serial/interleaved determinism across multiple seeds;
- concurrency 1/2/4 aggregate throughput and p95 latency baseline;
- exact replay cold/resume measurements from the new harness.

The running engine was not restarted to manufacture these results. They require an
explicit, reversible cutover window.
