# RESULTS — every measured number

Machine: consumer Windows workstation, one RTX 5090 (32 GiB), engine serving a ~28 GiB
IQ3_S-quantized MoE (248 320-token vocab, 512K context) through a llama.cpp-style
CPU-offloaded expert cache. Engine 0.1.45. All benches `temperature 0`, same suite,
same GPU idle before each run. Baseline run-to-run variance measured at ≤ 3 %.

## Baseline (stock configuration)

| metric | value |
|---|---|
| decode | 91.4 tok/s mean (code 96–99, prose 91–97, 32K-token agent case 83) |
| expert-cache hit rate | 0.90–0.94 |
| draft acceptance (speculation) | 0.60 pooled |
| fresh-prompt prefill | 4 475 tok/s (65K), 4 153 tok/s (16K) |
| telemetry gaps | 1441 `skip parking` engine-log lines/day (see C2) |

## C2 — conversation-cache budget 512→4096 MiB — KEPT

Problem was in the engine's own log: `conversation cache: skip parking (snapshot 2303 MiB
exceeds available budget)` — 1 441 occurrences/day, snapshots 2 225–2 577 MiB vs a 512 MiB
budget. The feature was structurally inoperative for agent-sized conversations.

- After raising the budget (+slots 4→8, min-tokens 2048 to protect long conversations from
  short-query eviction): **0 budget rejections**, overnight log.
- Resuming a real 131 363-token agent conversation: **130 990 tokens reused, 373 read, 1.3 s**
  (vs ~24 s cold re-prefill). A 15 383-token case: 55 ms vs 3.5 s.
- Cost: ~3.5 GiB of otherwise-free RAM (machine had 43 GiB free; budget = 3 % of it).

## C3a — KV cache int8→k8v4 — KEPT

Acceptance rule written before the cutover: "if fresh prefill costs 2–5 %, require decode
≥ +5 %".

- decode: **98.65 vs 91.38 tok/s (+8.0 %)**, 6 trials
- fresh prefill: **−4.3 %** (65K), **−4.1 %** (16K) — inside the documented 2–5 % cost window
- hit rate unchanged (0.94): the ~180 MiB KV savings did not convert into more resident
  experts on this machine (other budget terms bind first)

## C1 — chunked Gated-DeltaNet prefill (`STRATA_GDN_CHUNKED=1`) — REJECTED

Upstream docs claim **1.8× prefill on RTX 5090**. Measured with fresh unique prompts
(the only way to measure prefill once C2 is active — cached prompts reuse instead of re-read):

| prompt | GDN on | GDN off | delta |
|---|---|---|---|
| 65K tokens | 4 502 tok/s | 4 475 tok/s | **+0.6 %** |
| 16K tokens | 4 179 tok/s | 4 153 tok/s | **+0.6 %** |

Trial-to-trial noise ±3 %. Verdict: the 1.8× applies to the isolated DeltaNet recurrence;
diluted in a full MoE prefill (attention + expert routing + expert PCIe traffic) on this
card and quantization it is invisible. Removed from the live config.

## C4 — speculation depth sweep — REJECTED (default already optimal)

Same bench suite, only the speculation flags change:

| config | decode | acceptance |
|---|---|---|
| spec 4 (stock default) | **98.6 tok/s** | 0.613 |
| spec 5 / min-p 0.45 | 88.2 (−10.6 %) | 0.566 |
| spec 3 / min-p 0.50 | 95.2 (−3.5 %) | 0.683 |

More drafts ≠ more throughput: window verification cost grows superlinearly at the top
(see RFC-02 cost curve). Restored the stock default via scripted backup revert.

## S1 — schema-constrained generation prototype — WORKS (with an adoption caveat)

Automaton: JSON-schema prefix validator over the model's real 248 320-token vocabulary
(byte-level, whole-token validation, `--selftest` covers 14 cases).

- Exhaustive per-step mask via `logit_bias` over HTTP: semantically correct,
  **39.1 s per token** (3.7 MB payload). Dead end outside the engine.
- Partial assistant prefill: **refused by the chat template** (the server closes the
  assistant turn; `{"ville":` → model restarts from scratch). Token-level constraint is
  not bolt-on-able from HTTP — which is the argument for engine-side grammars.
- **Turn-level lazy rejection** (generate whole JSON → replay automaton → ban the first
  illegal token's ids → regenerate): battery result **3/3 strictly schema-valid, 0
  regenerations needed, vs 3/6 valid unconstrained**.
- Demand reality check: 0 of 3 091 logged requests used `response_format` at all — the
  clients used native tool calls. The win is real but gated on adoption.

## jsonschema quick-win

The server's optional `jsonschema` dependency was missing from the running venv, so
`response_format: json_schema` validation silently degraded to "parses as a JSON object"
(warning logged exactly once, on startup). Installing it changed nothing observable except
that invalid-schema answers now fail closed. Lesson: verify optional deps of the *running*
environment by reading its stdout log, not the docs.

## RFC-02 — confidence-scheduled speculation (the DSpark idea) — REFUTED as stated

Offline simulation (`proto/dspark_sim.py`) on **2 759 real requests** from the engine log
(`drafts accepted X of Y` lines), model calibrated to reproduce the three measured C4 pools
(error ≤ 0.019), window cost interpolated exactly through the three measured points
(t3=32.0 ms, t4=35.0 ms, t5=43.4 ms; convex).

- fixed depths: k=3 −5.0 %, k=4 0 %, k=5 −10.4 % — reproduces the measured C4 table
- per-request best-depth policy: **+0.1 %** (k=4 chosen for 2 376/2 759 requests)

Method warning that cost us a false positive: an **affine** cost fit (t4 → 37.7 ms instead
of the measured 35.0) produced a spurious +5.4 %. The scheduling gain depends more on the
cost-curve fidelity than on the confidence signal. Any headroom that remains needs a
**per-rank** acceptance signal (drafts 2+), which engine logs do not expose — the concrete
upstream ask that came out of this study.

## S2 — draft-chain grammar masks: algorithm validated offline (2026-10-31)

`proto/s2_draftchain.py` simulates the proposed in-engine rule — automaton advanced
along the MTP draft chain, first grammar-invalid draft kills its row and all later
rows in the window, window commits the surviving prefix and draws a replacement from
the masked candidate list — using the real schema automaton (the `s1_grammar`
implementation), measured window cost (35 ms at spec4) and measured pooled draft
acceptance (0.613), with the off-grammar proposal rate calibrated to reproduce the
observed free-decode tour validity (3/6 -> 51.9% in sim).

| metric (2 000 tours/arm) | free | grammar ON |
|---|---|---|
| schema validity | 51.9 % | **100 %** (0 violations committed, property holds) |
| windows per complete tour | 48.62 | 48.60 (**cost per attempt unchanged**) |
| attempts per guaranteed-valid output | 1.93 | 1.00 |
| **effective wall-clock, valid output** | — | **1.93x faster** |

Grammar blocked on average 0.83 off-grammar drafts per tour; the masked replacement
reuses windows that would commit fewer tokens anyway - hence zero net decode cost.
Host-side machinery in simulation: ~35 us per tour (Python; in-engine it is a
set-intersection over <= 64 candidate entries). This retires the main correctness
risk of the in-engine grammar before any C++ is written.

## S2 C++ port: the engine patch exists and its module tests pass (2026-10-31)

The offline simulation above retired the correctness risk, so the algorithm was ported
to the engine's own language on branch `stratinfer-s2` (patch exported as
`src/core/verify.cpp.patched` + `verify.hpp.patched` alongside the originals):

| component | file | status |
|---|---|---|
| byte-wise schema automaton (fixed POD state, no hot-path allocs) | `include/strata/grammar/json_automaton.hpp` | compiles standalone, tests green |
| draft-chain rule: provisional advance, `confirm(k)` reconciliation, vocab filter, masked redraw | `include/strata/grammar/draft_chain.hpp` | tests green (truncation at first invalid draft; rollback on shorter real commit) |
| strict-JSON schema subset loader | `include/strata/grammar/schema_loader.hpp` | tests green |
| unit tests (same vectors as the Python reference) | `src/core/json_automaton_test.cpp` | **ALL OK** under MSVC 19 (`cl /std:c++17`) |
| engine integration: 4 hunks in `verify.cpp`/`verify.hpp` | `src/core/*.patched` | authored, NOT compiled locally |

Integration design (zero-GPU-kernel): `pl_finish` copies `out[]` to the host, the
automaton truncates the window at the first grammar-invalid draft using the engine's
own `kProposalSamplerErrorToken` reject channel, `pl_commit_async(n_keep)` reconciles
the automaton with the rows actually committed, and the ban-list for the current
automaton state class rides the existing `logit_bias` device array (-100 hard
exclusion). Feature is inert (`grammar_ == null`) unless a caller injects a schema.

Honest limits: full engine build not run here (this machine has CUDA 11.2, the engine
needs 12.9/sm_120); the caller-side plumbing of the token->bytes table (`tokText`)
belongs to the serve layer; bonus-row redraw at a banned position can livelock if the
unmasked head keeps proposing invalid ids, which the mask recomputed per state class
is meant to prevent but has not been stress-tested on real GPU runs.
