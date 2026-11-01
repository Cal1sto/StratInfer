# StratInfer

StratInfer is a measurement-first port of useful
[DeepInfer](https://github.com/deepseek-ai/DeepInfer) ideas to
[Strata](https://github.com/Niko1221/Strata), Qwen3.8-Flash-Next, and one RTX 5090
(`sm_120`). It combines an opt-in engine overlay, reproducible benchmark harnesses,
and documented accept/reject decisions.

The project does not relabel SM100 datacenter kernels as RTX 5090 kernels. DeepInfer
features are imported only when their model, numerical, and hardware invariants match.
Otherwise StratInfer keeps Strata's native implementation or re-derives a small,
testable equivalent.

## Current status

| Work item | Evidence | Verdict |
|---|---|---|
| Conversation cache, 512 to 4096 MiB | 1,441 daily parking rejections to 0; 131k-token resume in 1.3 s | Kept |
| KV cache `k8v4` | decode 91.4 to 98.7 tok/s; fresh prefill about -4.2% | Kept |
| Chunked GDN prefill | +0.6%, inside the measured +/-3% noise band | Rejected |
| Speculation depth sweep | spec5 -10.6%, spec3 -3.5% against spec4 | Rejected |
| Confidence-scheduled speculation | +0.1% in a calibrated 2,759-request simulation | Rejected as stated |
| RTX 5090 overlay A/B | +1.62% fixed decode; +1.43% fresh prefill; +3.72% to +6.72% concurrent throughput | Promising, sequential gain inside noise |
| Live Strata 0.1.45 vs StratInfer 0.1.54 | +9.19% fixed decode; +9.64% fresh prefill; +16.77% to +20.45% concurrent throughput | StratInfer selected; hot replay +6.42% remains to fix |
| Strict JSON-Schema overlay | 4/4 `sm_120` tests and 6/6 constrained smoke outputs | Functional smoke passed |
| Packed grammar-mask CUDA kernel | median 7.931 us kernel-only; 94.652 us pinned upload plus kernel | Component result only |
| End-to-end constrained RTX 5090 throughput | final constrained cutover not run | Pending |
| Long-session memory on RTX 4080 + SSD | 12,585 exact snapshot checks; 10.84/11.46 GiB/s peer copies; live MOAI cutover and rollback | Opt-in live profile active; 24-hour gate pending |

Full measurements and caveats are in [`RESULTS.md`](RESULTS.md). The latest raw battery
and analysis are in [`reports/rtx5090-2026-10-31.md`](reports/rtx5090-2026-10-31.md).
The long-session report is
[`reports/long-session-memory-2026-11-01.md`](reports/long-session-memory-2026-11-01.md).
The live MOAI selector and voice-preservation validation are in
[`reports/moai-live-cutover-2026-11-01.md`](reports/moai-live-cutover-2026-11-01.md).
The complete deployed-engine comparison, including quality, TTFT, energy, concurrency,
long context and negative results, is
[`reports/strata-vs-stratinfer-2026-11-01.md`](reports/strata-vs-stratinfer-2026-11-01.md).

## DeepInfer capabilities

The overlay implements or validates the portable parts:

- strict JSON-Schema constrained decoding inside the verifier;
- position-keyed Philox sampling and an interleaving determinism test;
- concurrency, exact replay, fixed-prompt, fresh-prompt, and schema-validity benchmarks;
- packed `sm_120` grammar masks with a GPU parity test;
- exact parked K/V on a helper RTX 4080, bounded SSD sessions, canonical context,
  matrix retrieval, and specialist-agent handoffs;
- acceptance gates and reversible cutover tooling.

DeepInfer's FlashMLA, DeepGEMM, DeepEP, DeepSelect, TileLang, attention DP/CP,
MoE EP/EPLB, and YoCo kernels target different models, dtypes, and multi-GPU
topologies. They are mapped to native Strata equivalents rather than copied. See
[`docs/deepinfer-sm120-port.md`](docs/deepinfer-sm120-port.md) for the complete matrix.

## Repository layout

- `include/strata/` and `src/`: grammar, GGUF token handling, Philox, CUDA mask,
  parity tests, and patched Strata verifier sources.
- `patches/strata-integration.patch`: CMake, engine wiring, and Qwen3.6 sampler
  integration against the pinned Strata revision.
- `scripts/apply-to-strata.ps1`: clean preflight and overlay installation.
- `scripts/build-engine.bat`: CUDA 13.1, `120-real`, both engines, grammar tests,
  and standard/helper-device snapshot tests.
- `scripts/bench_*.mjs`: fixed, fresh, concurrency, replay, quality, energy, and grammar measurements.
- `scripts/summarize_comparison.mjs`: paired statistics and comparison summary.
- `scripts/long_session.mjs`: durable context and specialist-agent orchestration.
- `scripts/verify_determinism.mjs`: serial versus interleaved output hashes.
- `configs/candidates/`: changes, acceptance criteria, rollback, and verdicts.
- `proto/`: Python reference automaton and simulations.

## Quick checks

These commands do not restart an engine:

```powershell
python proto/s1_grammar.py --selftest
python proto/s2_draftchain.py --runs 2000 --seed 7
node --check scripts/bench_concurrency.mjs
node --check scripts/bench_grammar.mjs
node --check scripts/bench_quality.mjs
node --check scripts/bench_efficiency.mjs
node --check scripts/verify_determinism.mjs
node --check scripts/summarize_comparison.mjs
node --test scripts/tests/context-memory.test.mjs scripts/tests/agent-orchestrator.test.mjs
node scripts/bench_long_memory.mjs 2000 100
node scripts/audit.mjs --once
```

Live scripts use `STRATINFER_BASE`, defaulting to `http://127.0.0.1:11440`:

```powershell
$env:STRATINFER_BASE = "http://127.0.0.1:11440"
node scripts/bench_ab.mjs --label baseline --repeat 2
node scripts/bench_fresh.mjs --label baseline --tokens 16000 --trials 3
node scripts/bench_concurrency.mjs --levels 1,2,4 --trials 3 --tokens 256
node scripts/bench_replay.mjs --tokens 16000
node scripts/bench_quality.mjs --label baseline --trials 2 --tokens 512 --nonce baseline-v1
node scripts/bench_efficiency.mjs --label baseline --trials 5 --tokens 512
node scripts/bench_grammar.mjs --label unconstrained --trials 5 --tokens 512
node scripts/verify_determinism.mjs --seed 424242 --concurrency 4
```

The validated MOAI deployment keeps the fallback Strata server on port `11440` and
serves StratInfer on port `11441`; set `STRATINFER_BASE` explicitly when benchmarking
that live profile. See [`docs/moai-engine-switch.md`](docs/moai-engine-switch.md).

## Apply the overlay

The installer refuses a dirty Strata checkout unless `-AllowDirty` is explicit.
Validate first, then apply:

```powershell
powershell -File scripts/apply-to-strata.ps1 `
  -StrataPath C:\src\Strata -CheckOnly
powershell -File scripts/apply-to-strata.ps1 `
  -StrataPath C:\src\Strata
```

The patch is pinned and validated against Strata commit `870aedd`. Review upstream
changes before applying it to another revision.

## Build for RTX 5090

Validated prerequisites:

- Visual Studio 2022 Build Tools;
- CUDA Toolkit 13.1;
- CMake and Ninja from `requirements-build.txt`;
- llama.cpp at the commit recorded by Strata's
  `<strata-checkout>\third_party\ggml\VERSION.txt` (`3cf0325` in the validated build).

```powershell
python -m pip install -r requirements-build.txt
$env:GGML = "C:\src\llama.cpp"
cmd /c scripts\build-engine.bat C:\src\Strata C:\build\strata-sm120
```

The build requests `CMAKE_CUDA_ARCHITECTURES=120-real`, produces `strata.exe` and
`strata-q36.exe`, then runs:

- `json_automaton_test`;
- `gguf_tokens_test`;
- `qwen35_philox_test`;
- `grammar_mask_parity`;
- `conversation_snapshot_test`, `conversation_snapshot_test_park_peer`, and the
  constrained-budget helper-GPU fallback variant.

The build also produces `peer_cache_bench.exe` for repeatable RTX 5090 to RTX 4080
copy measurements.

## Long coding sessions

The opt-in long-session profile keeps the model on RTX 5090, reserves up to 4,096 MiB
on RTX 4080 for exact parked K/V, and bounds per-project SSD sessions at 32 GiB. Five
isolated roles share a canonical context and explicit handoffs:

```powershell
node scripts/long_session.mjs init --project stratinfer `
  --objective "Improve StratInfer without losing accepted invariants"
node scripts/long_session.mjs status --project stratinfer
node scripts/long_session.mjs run --project stratinfer `
  --task "Implement and validate the next accepted change"
```

The server must use the status command's `sessions_path` as `--slot-save-path`, with
parallel slots disabled. Use a dedicated server or a controlled cutover because a
session restore replaces the engine's current conversation. Full setup, recovery and
limits are in [`docs/long-coding-sessions.md`](docs/long-coding-sessions.md). The
transactional MOAI deployment is documented in
[`docs/moai-engine-switch.md`](docs/moai-engine-switch.md).

`CUDA_ARCH` defaults to `120-real`; set `CUDA_ARCH=89-real` only for a separate Ada
functional-smoke build. Use a clean build after changing overlay headers.

## Enable structured output

Grammar mode is opt-in and startup-scoped:

```powershell
$env:STRATA_GRAMMAR_SCHEMA = "C:\schemas\response.schema.json"
```

The adversarial benchmark schema is available at
`configs/schemas/battery-schema.json`; use it on a separate test profile before running
`bench_grammar.mjs` as the constrained arm.

Unset means the original path is unchanged. The supported strict subset is `object`,
`array`, `string`, `number`, `boolean`, `null`, `enum`, `properties`, `required`,
`items`, and `additionalProperties`. Unsupported schema features fail closed.

Current constraints are deliberate:

- one schema per process, not a per-request protocol field;
- one serial, single-GPU request stream;
- no batch slots, pipeline windows, or layer split in grammar mode;
- JSON Schema only; regex and EBNF are not implemented;
- no end-to-end throughput claim until the 10,000-sample live gate passes.

The six-case adversarial smoke passes 6/6 after dead-end key, escape, Unicode-prefix,
and exhausted-property transitions were fixed. This is not the 10,000-sample gate.

See [`docs/rfc-structured-outputs.md`](docs/rfc-structured-outputs.md) for exact
semantics, speculative-row handling, and acceptance gates.

## Measurement rules

1. Establish a repeated baseline and noise band first.
2. Write acceptance criteria and rollback before a cutover.
3. Use fresh prompts for prefill and fixed prompts for decode regressions.
4. Separate component microbenchmarks from end-to-end claims.
5. Never restart the live engine without an explicit cutover window.
6. Publish negative results.

The full protocol is in [`docs/methodology.md`](docs/methodology.md).

## Attribution

Files derived from Strata remain under Strata's MIT terms; see `LICENSE.Strata`.
The StratInfer grammar, harness, and integration overlay are provided under `LICENSE`.
