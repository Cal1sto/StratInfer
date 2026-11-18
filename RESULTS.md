# Results

This file separates live end-to-end measurements, offline simulations, build/test
evidence, and isolated kernel microbenchmarks. Numbers from one evidence level are not
promoted to another.

## Test environment

- RTX 5090, 32,607 MiB, compute capability 12.0, driver 610.88;
- Intel Core i9-14900K, 24 cores / 32 threads, 127.7 GiB RAM;
- Windows 11 Professional 10.0.22631;
- approximately 28 GiB IQ3_S quantized MoE;
- 248,320-token vocabulary and up to 512K context;
- CUDA 13.1 for the overlay build;
- Strata overlay based on commit `870aedd`;
- llama.cpp pinned to `3cf0325` for the validated build;
- repeated live baseline noise at or below approximately 3%.

## RTX 5090 battery, 2026-10-31

The complete protocol, limitations, raw-file links, and per-case tables are published in
[`reports/rtx5090-2026-10-31.md`](reports/rtx5090-2026-10-31.md).

| Measurement | Reference | Overlay | Delta / verdict |
|---|---:|---:|---|
| fixed decode, 9 runs | 113.46 tok/s | 115.29 tok/s | +1.62%, inside historical noise |
| fresh prefill, 5 runs | 4,885 tok/s | 4,955 tok/s | +1.43% |
| concurrency 1 | 128.01 tok/s | 136.61 tok/s | +6.72%, p95 -20.11% |
| concurrency 2 | 138.92 tok/s | 144.09 tok/s | +3.72%, p95 -6.60% |
| concurrency 4 | 137.47 tok/s | 143.68 tok/s | +4.52%, p95 -4.36% |
| exact replay | 99.89% reused | 99.89% reused | exact in both arms |
| unconstrained schema validity | 0/30 | 0/30 | engine constraint is necessary |
| live determinism | 6/7 mismatches | 6/7 mismatches | failed in both arms |

The constrained functional smoke passed 6/6 on the secondary RTX 4080 SUPER. It is not
reported as RTX 5090 performance. The final `sm_120` clean build passes all four tests.

## Long-session memory, 2026-11-01

The opt-in C11 profile adds exact K/V parking on CUDA device 1 (RTX 4080 SUPER), a
32 GiB per-project SSD session budget, an always-injected canonical context, and five
isolated specialist roles. The initial component campaign did not restart the active
full-model engine, so its copy and snapshot figures remain component results rather
than a full-model throughput A/B. A later live cutover is reported separately below.

| Measurement | Result |
|---|---:|
| standard snapshot test | 4,195 checks, pass |
| RTX 5090 to RTX 4080 snapshot test | 4,195 checks, pass |
| helper-GPU budget fallback test | 4,195 checks, pass |
| 5090 to 4080 copy, 512 MiB x5 | 10.836 GiB/s |
| 4080 to 5090 copy, 512 MiB x5 | 11.460 GiB/s |
| memory/orchestrator tests | 9/9 pass |
| matrix insertion, 2,000 records | 3,002 records/s |
| matrix retrieval, 100 queries | 13.792 ms mean |
| synthetic keyed top-5 recall | 100% |

Both directions report no direct peer access. `cudaMemcpyPeerAsync` still passes the
byte validation, but the result is a driver-staged PCIe path, not an NVLink claim. The
observed 2.2-3.44 GiB long-conversation snapshots fit under the 4 GiB helper budget;
larger snapshots retain Strata's host fallback. The 32 GiB quota policy was tested at a
reduced scale, not by writing 32 GiB physically.

See [`reports/long-session-memory-2026-11-01.md`](reports/long-session-memory-2026-11-01.md)
for protocol, raw files, limits and the pending 24-hour cutover gate.

### MOAI live cutover

MOAI 1.0.15 now selects Strata or StratInfer transactionally. Strata remains online but
unloaded on port 11440 while StratInfer serves on port 11441. The first clean cutover
took 51.8 seconds; a reverse/forward cycle took 28.3 and 40.5 seconds. Qwen3-ASR and
Qwen3-TTS retained their process identities throughout, and a live text canary returned
`OK` in 1.03 seconds. The final selected engine is StratInfer with a 524,288-token
context. This validates operation and rollback, not the pending 24-hour stability gate.

See [`reports/moai-live-cutover-2026-11-01.md`](reports/moai-live-cutover-2026-11-01.md).

### Eight-agent capacity cutover, 2026-11-10

C12 adds a capacity-checked eight-role workflow, per-stage crash recovery and bounded
quality-gate revision. The live profile now exposes 12,288 MiB host conversation cache
and a 6,144 MiB RTX 4080 helper cap, while the orchestrator enforces 64 GiB per-project
SSD storage with a 32 GiB filesystem floor. The local plan supports eight 131,072-token
target contexts, five target snapshots hot in host cache, two in helper VRAM and 23 in
the SSD snapshot partition.

The transactional restart preserved ASR PID 8808 and TTS PID 16296, returned `OK`, and
kept FastMCP 6/6. A first real architect turn wrote the 248,816,800-byte
`stratinfer--architect.bin`; the next turn restored it successfully. The revised
10,000×500 matrix run kept 100% synthetic top-5 recall and reduced mean query time from
72.40 to 48.05 ms, while write throughput decreased from 3,100.10 to 2,218.94 records/s.
The 24-hour and full quota-pressure gates remain open. See
[`reports/multi-agent-capacity-2026-11-10.md`](reports/multi-agent-capacity-2026-11-10.md).

## Live configuration results

| Candidate | Primary result | Verdict |
|---|---|---|
| C2 conversation cache, 512 to 4096 MiB | 1,441 parking budget rejections/day to 0 | Kept |
| C3 `k8v4` | decode 91.38 to 98.65 tok/s (+8.0%); fresh prefill about -4.2% | Kept |
| C9 deterministic sampling | fixed placement 13/13; performance placement 1/13 at 128 tokens | Strict profile accepted; opt-in |
| C12 eight-agent capacity | 8 × 128K target; live save/restore; ASR/TTS PIDs preserved | Live smoke passed; endurance pending |
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
| kernel only, median of 10 | 7.931 us/launch (7.657-8.396) |
| pinned 30.3 KiB upload plus kernel, median of 10 | 94.652 us/state change (89.388-101.457) |
| packed allowed-token transfer | 30.3 KiB |
| equivalent dense FP32 bias | about 970 KiB |

The state-signature cache avoids rebuilding or uploading an unchanged mask. These are
component measurements only; the end-to-end decode gate remains open.

## Determinism

The Qwen3.8 verifier already keys Philox by seed and token position. The overlay adds a
live serial/interleaving hash harness. The separate Qwen3.6 host sampler was changed from
a mutable `mt19937_64` stream to the same position-keyed contract, and its unit test passes.

The original live matrix ran with seed 424242. Both the reference and overlay produced
six hashes different from the first result across seven observations. A later 13-run
campaign isolated adaptive expert residency as the cause: an expert computed on CPU and
GPU rounds differently, and the asynchronous adaptive tier changes that placement.

A fixed-placement profile passed 13/13 serial/interleaved hashes on port 11441, while
synchronous adaptation passed only 4/5 and the restored performance profile passed 1/13
at 128 tokens. Fixed placement decoded the short strict gate at 2.1-2.7 tok/s; the
restored performance profile reached a 143.7 tok/s median in its retained 128-token
metrics. Strict determinism is therefore accepted as a separate opt-in profile, not as
the interactive default. See
[`reports/determinism-fix-2026-11-02.md`](reports/determinism-fix-2026-11-02.md).

## FastMCP deployment, 2026-11-02

The active StratInfer profile now starts a pinned FastMCP 1.26 server over stdio. Six
tools are available only to requests that set `strata_mcp: true`; ordinary LLM and
vision requests do not receive their schemas. The server is root-confined and read-only
for the repository, except for a dedicated FTS5 memory database capped at 32 GiB.

| Measurement | Result |
|---|---:|
| direct protocol and tool checks | 6/6 passed |
| path traversal rejection | passed |
| end-to-end Qwen tool call | `MCP_OK` |
| end-to-end MOAI proxy tool call | `MOAI_MCP_OK` |
| memory after forced MCP restart | `STORED` then `FOUND` |
| automatic MCP restart | passed, new PID |
| `git_status` tool latency | 28.8 ms median, 30.4 ms p95 |
| FastMCP idle working set | 64.5 MiB |
| plain request | 172.8 ms median, 35 prompt tokens |
| MCP advertised, no call | 1,204.3 ms median, 827 prompt tokens |
| one real tool call | 2,016.8 ms median, 1,154 prompt tokens |
| real tool execution within that call | 30 ms median |

The main cost is therefore model-side schema prefill and the second inference round,
not stdio execution. Keeping MCP opt-in avoids this cost for normal chat, vision, ASR and
TTS. MCP results and external state are not covered by strict text determinism. Full
configuration, raw evidence and caveats are in
[`reports/fastmcp-2026-11-02.md`](reports/fastmcp-2026-11-02.md).

The quantified use-case synthesis converts these live measurements into explicit coding,
long-context, multi-agent, replay, energy, memory and MCP scenarios. Projected values are
kept separate from directly measured values and are regenerated from raw JSON with
`scripts/project_use_cases.mjs`. See
[`reports/stratinfer-vs-strata-use-cases-2026-11-02.md`](reports/stratinfer-vs-strata-use-cases-2026-11-02.md).

## NOEMA supervised control plane, 2026-11-17

NOEMA adds a loopback campaign service, persistent Codex app-server review, immutable
checkpoints, R0-R4 approval policy, isolated worktrees, content-addressed candidates,
FTS5 plus 512-dimensional matrix memory, signed skill quarantine and measured RTX 4080
resource profiles.

The pre-existing Node suite passed 25/25 and the focused NOEMA suite passed 23/23,
for 48/48 combined tests. The first real Codex checkpoint review returned `BLOCKED`
because the canary omitted revision-linked proof. After adding the hashed qualification
receipt, completion-gate negative tests, a functional voice round trip and an exercised
rollback, the final independent review returned `PASS` with 0.90 confidence and the
campaign completed. This validates fail-closed review transport; it is not an inference
quality-gain claim. With voice resident, the live 4080 measurement accepted the 4,096 MiB
`voice-balanced` cache and refused `agent-max`, because only 5,632 MiB remained after
the 4,096 MiB reserve. Full evidence and limits are in
[`reports/noema-implementation-2026-11-17.md`](reports/noema-implementation-2026-11-17.md).

The 18 November live activation aligns the helper cap to 4,096 MiB, enables four
compact NOEMA MCP tools, preserves ASR/TTS PIDs across text-engine switches and
qualifies a drained 10,240 MiB `agent-max` budget while preserving 4,096 MiB. The
ordinary inference path showed no measurable idle NOEMA cost; MCP opt-in adds 404
schema tokens beyond the original six tools. Voice ASR/TTS processes survived the
engine switches, and the legacy six-tool profile was restored and exercised before the
qualified ten-tool profile was re-enabled. Full results and raw evidence are in
[`reports/noema-live-benchmarks-2026-11-18.md`](reports/noema-live-benchmarks-2026-11-18.md).

## Heavy Strata versus StratInfer load, 2026-11-18

An identical 169-request battery per engine produced 338 paired inference requests.
StratInfer improved aggregate fixed decode by 8.05%, fresh 122K-token prefill by 14.80%,
concurrency-eight throughput by 16.19%, median TTFT by 11.64% and tokens per joule by
9.43%. Both engines passed 30/30 targeted quality checks and both failed live
determinism with 12 divergences in 13 observations. Exact 158K-token replay succeeded in
both, but StratInfer's hot resume was 10.26% slower. Forty measured MCP/NOEMA calls were
strictly successful. The campaign also found and corrected an activation race that
returned before Qwen readiness. The corrected suite passes 25/25 focused and 50/50
combined tests; an independent Codex review returned `PASS` with 0.89 confidence and
completed the campaign. Full results are in
[`reports/heavy-strata-vs-stratinfer-2026-11-18.md`](reports/heavy-strata-vs-stratinfer-2026-11-18.md).

## Remaining gates

No result in this section is claimed complete yet:

- at least 10,000 grammar-constrained live samples over representative schemas;
- zero invalid committed output with speculation on and off at that scale;
- at least 95% of unconstrained decode throughput on the RTX 5090;
- strict serial/interleaved determinism across multiple seeds and longer outputs;
- longer concurrency runs to confirm the observed +3.72% to +6.72% signal.

Concurrency and exact replay now have live baselines. The remaining constrained RTX 5090
gates require an explicit, reversible cutover window.
