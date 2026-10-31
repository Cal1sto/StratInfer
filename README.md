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
| Strict JSON-Schema overlay | both engines and four tests build with CUDA 13.1 for `120-real` | Built and tested |
| Packed grammar-mask CUDA kernel | 7.337 us kernel-only; 104.321 us pinned upload plus kernel | Component result only |
| End-to-end grammar throughput | live A/B not run yet | Pending |

Full measurements and caveats are in [`RESULTS.md`](RESULTS.md).

## DeepInfer capabilities

The overlay implements or validates the portable parts:

- strict JSON-Schema constrained decoding inside the verifier;
- position-keyed Philox sampling and an interleaving determinism test;
- concurrency, exact replay, fixed-prompt, and fresh-prompt benchmarks;
- packed `sm_120` grammar masks with a GPU parity test;
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
- `scripts/build-engine.bat`: CUDA 13.1, `120-real`, both engines, and four tests.
- `scripts/bench_*.mjs`: fixed, fresh, concurrency, and replay measurements.
- `scripts/verify_determinism.mjs`: serial versus interleaved output hashes.
- `configs/candidates/`: changes, acceptance criteria, rollback, and verdicts.
- `proto/`: Python reference automaton and simulations.

## Quick checks

These commands do not restart an engine:

```powershell
python proto/s1_grammar.py --selftest
python proto/s2_draftchain.py --runs 2000 --seed 7
node --check scripts/bench_concurrency.mjs
node --check scripts/verify_determinism.mjs
node scripts/audit.mjs --once
```

Live scripts use `STRATINFER_BASE`, defaulting to `http://127.0.0.1:11440`:

```powershell
$env:STRATINFER_BASE = "http://127.0.0.1:11440"
node scripts/bench_ab.mjs --label baseline --repeat 2
node scripts/bench_fresh.mjs --label baseline --tokens 16000 --trials 3
node scripts/bench_concurrency.mjs --levels 1,2,4 --trials 3 --tokens 256
node scripts/bench_replay.mjs --tokens 16000
node scripts/verify_determinism.mjs --seed 424242 --concurrency 4
```

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
- `grammar_mask_parity`.

## Enable structured output

Grammar mode is opt-in and startup-scoped:

```powershell
$env:STRATA_GRAMMAR_SCHEMA = "C:\schemas\response.schema.json"
```

Unset means the original path is unchanged. The supported strict subset is `object`,
`array`, `string`, `number`, `boolean`, `null`, `enum`, `properties`, `required`,
`items`, and `additionalProperties`. Unsupported schema features fail closed.

Current constraints are deliberate:

- one schema per process, not a per-request protocol field;
- one serial, single-GPU request stream;
- no batch slots, pipeline windows, or layer split in grammar mode;
- JSON Schema only; regex and EBNF are not implemented;
- no end-to-end throughput claim until the 10,000-sample live gate passes.

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
