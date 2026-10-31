# StratInfer

Measurement-first convergence of [DeepInfer](https://github.com/deepseek-ai/DeepInfer) ideas
into [Strata](https://github.com/Niko1221/Strata), validated with real A/B runs against a live
inference engine. Not a fork, not a runtime: a harness + RFCs + verdicts.

The premise: DeepInfer is a datacenter framework (SM100-class GPUs, Linux) — its kernels are not
importable onto a consumer card, and its ideas are documented in benchmark prose nobody verifies
on other hardware. Strata is a strong consumer-GPU MoE engine that documents opt-in switches with
promises ("1.8× prefill on RTX 5090") that are true only for isolated components. **StratInfer
measures everything on one live machine and keeps only what survives.**

## What shipped (net effect vs the engine's stock configuration)

All numbers from the same machine (RTX 5090, 248k-vocab quantized MoE at IQ3_S, 512K context)
and the same benches; baseline variance ≤ 3%:

| Change | Measured effect | Verdict |
|---|---|---|
| Conversation-cache budget 512→4096 MiB (C2) | parking rejections 1 441/day → **0**; resuming a 131 363-token agent conversation: **1.3 s** instead of ~24 s | **kept** |
| KV cache `k8v4` (C3a) | decode **91.4 → 98.7 tok/s (+8 %)**; cost: fresh prefill −4.2 % | **kept** |
| Server-side schema validation (missing optional dep) | `response_format: json_schema` silently degraded to "is a JSON object" → now actually validates | **fixed** |
| Schema-constrained decoding prototype (S1) | **3/3 outputs fully schema-valid vs 3/6 unconstrained** | works, see caveat |
| Draft-chain grammar masks (S2 rule, simulated offline) | 100 % valid, **zero per-attempt decode cost** (48.60 vs 48.62 windows), **1.93x** effective vs regenerate-loop | algorithm validated |
| S2 C++ engine port (automaton + draft chain + verify.cpp patch) | unit tests ALL OK (MSVC); inert unless a schema is injected | patch authored; GPU build pending upstream toolchain |
| Chunked Gated-DeltaNet prefill (C1, doc promises 1.8×) | **+0.6 %** (under noise) — the 1.8× applies to the isolated recurrence, not full MoE prefill on this card+quant | **rejected** |
| Speculation depth sweep (C4) | spec5: −10.6 %, spec3: −3.5 % — shipped default already optimal | **rejected** |
| Confidence-scheduled speculation ("DSpark localized", RFC-02) | offline simulation on 2 759 real requests: **+0.1 %** | **refuted as stated** |

The last three rows are the useful part: negative results, reproducible, with the measurement
error bars. `RESULTS.md` has every table; `docs/` has the RFCs and methodology.

## Quick start

```bash
node scripts/audit.mjs --once          # read-only live snapshot (/health /metrics /status)
node scripts/audit.mjs --watch --every 300   # baseline telemetry -> logs/baseline.jsonl
node scripts/bench_ab.mjs --label baseline --repeat 2   # fixed suite A/B harness
node scripts/bench_fresh.mjs --label fresh --tokens 16000 --trials 3  # fresh prompts (prefill)

python proto/extract_vocab.py <model.gguf>    # dump vocabulary cache
python proto/s1_grammar.py --selftest         # schema automaton unit tests (no network)
python proto/dspark_sim.py --log <engine.log> # speculative-scheduling simulation
python proto/s2_draftchain.py             # draft-chain grammar-mask simulation (no network)
```

Point everything at your server with `STRATINFER_BASE` (default `http://127.0.0.1:11440`).

## The rules this project enforces

1. **Baseline first.** 48 h of read-only telemetry before touching any config.
2. **Acceptance criteria are written before the cutover**, inside each candidate
   (`configs/candidates/`), with rollback defined. Examples: "decode ≥ +5 % to accept a
   −4 % prefill cost", "noise band measured on repeated runs, no cherry-picking".
3. **Cutovers are scripted** (backup → stop → start → health probe → failsafe restore),
   see `scripts/cutover-template.ps1`. A live engine restart means real downtime: never
   without consent, never without the failsafe.
4. **Negative results are first-class deliverables** (see C1/C4/RFC-02 above).
5. Component benchmarks from upstream docs are hypotheses, not budgets — the GDN case.

## Layout

- `docs/deepinfer-vs-strata.md` — idea-by-idea mapping and importability verdicts
- `docs/methodology.md` — how the A/B protocol works (fixed vs fresh prompts, noise, metrics)
- `docs/rfc-structured-outputs.md` — grammar-constrained decoding: where it must live and why
  (host-side sampling discovery, measured HTTP walls)
- `docs/rfc-speculative-scheduling.md` — the DSpark-style idea, its simulation, and its refutation
- `RESULTS.md` — every measured number, per experiment
- `configs/candidates/` — the patch corpus: deltas, inspirations, acceptance criteria, verdicts
- `proto/` — working prototypes (schema automaton, GGUF vocabulary extractor, DSpark simulator)

## Honest caveats

- All numbers are for one consumer rig (one GPU, one quantization, one agent-heavy workload
  mix). The method is portable; the numbers are not.
- The schema-constraint win is measured on a battery, not demand: 0 of 3 091 logged requests
  on that box even used `response_format`. Adoption, not availability, was the bottleneck.
- Upstream tracking exists: grammar-constrained decoding is open as Strata issue
  [Niko1221/Strata#3758](https://github.com/Niko1221/Strata/issues/3758) — our measured
  contribution is in that thread, not duplicated here.

MIT — see `LICENSE`.

## Attribution

`src/core/verify.cpp.patched`, `verify.hpp.patched` and the upstream commit graph referenced here derive from **Strata** (Copyright (c) 2026 Niko1221 and the Strata contributors, MIT - see `LICENSE.Strata`). The S2 grammar module is original StratInfer code offered under the same MIT terms.
