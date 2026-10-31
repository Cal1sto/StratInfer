# DeepInfer capabilities on Strata and RTX 5090 (`sm_120`)

This document maps DeepInfer commit `5537415` to Strata commit `870aedd` and the
Qwen3.8-Flash-Next execution path. The rule is deliberately strict: copy an idea when
the model and hardware invariants match; otherwise use Strata's native equivalent or
reject the port. A kernel name shared by two projects does not imply binary or numerical
compatibility.

## Hardware boundary

DeepInfer's public NVIDIA target is SM100 and its published benchmark topology uses four
GPUs for prefill and 64 GPUs for decode. FlashMLA, DeepGEMM, DeepEP, DeepSelect and the
TileLang kernels assume DeepSeek-V4.1-Flash layouts, datacenter dtypes, and frequently an
NVLink/NVSwitch expert-parallel fabric. Qwen3.8-Flash-Next on one RTX 5090 uses different
GDN/QSA layouts, GGUF quantization, PCIe expert streaming and Windows/WDDM.

For that reason, the SM100 kernel sources are not compiled for `sm_120`. Strata's native
CUDA kernels are retained where they already implement the same role, and new CUDA is
added only where a measured Strata bottleneck exists.

## Capability matrix

| DeepInfer capability | Strata / Qwen3.8 counterpart | RTX 5090 decision | StratInfer status |
|---|---|---|---|
| FlashMLA | QSA prompt/decode attention and QSA selector kernels | Re-derive only; tensor layouts differ | Keep Strata kernels; no unsafe source transplant |
| DeepGEMM | MMQ plus native IQ/NVFP4 W4A4/W4A8 paths | Re-derive only; quantization and tensor-core contracts differ | Keep Strata's existing `sm_120` paths |
| DeepEP | Expert cache, hybrid CPU/GPU execution, PCIe streaming | Not portable to one GPU; no EP fabric exists | Use cache/adaptive placement; benchmark concurrency |
| DeepSelect | QSA indexer/select/top-k kernels | Role already implemented for Qwen | Keep Strata implementation |
| TileKernels / TileLang | Ahead-of-time CUDA kernels and captured graphs | JIT stack adds no demonstrated benefit here | Do not add a second kernel runtime |
| Attention DP / balanced CP | Layer split, multi-GPU pipeline windows | Datacenter topology feature | No one-GPU port; preserve Strata split support |
| MoE EP + EPLB | Expert popularity profile, resident cache, adaptive swaps | Import policy, not collective kernels | Existing adaptive tier; evaluate with fixed A/B harnesses |
| DSpark / NextN verification | MTP, DFlash2, `DraftPolicy`, measured per-rank acceptance | Idea portable; fixed depth already near optimum | Depth sweep rejected; confidence simulation only +0.1% |
| DFlash draft head | Strata DFlash2 for Qwen3.8-Flash-Next | Already model-specific and native | No duplicate implementation |
| SWA bounded replay / YoCo | GDN/QSA checkpoints, conversation cache, session files | YoCo replay is architecture-specific and approximate | Preserve exact checkpoints; add bounded-replay measurement harness |
| Zero-overhead scheduler | CUDA graphs, batch groups, pipeline windows, async adaptive tier | Policy is portable; scheduler source is not | Add concurrency and replay benches; no unmeasured default change |
| Batch-invariant inference | Main verifier already uses Philox by seed and position | Portable invariant | Add live interleaving verifier; fix Qwen3.6 host sampler too |
| Structured outputs | No native Strata grammar decoder before this overlay | Portable with a model tokenizer table | Strict JSON-Schema subset plus packed GPU mask and speculative redraw |
| Regex / EBNF structured output | No equivalent parser in this overlay | Portable later, but separate parsers are required | Not implemented; fail documentation rather than imply parity |
| Multimodal execution | Strata vision sidecar and model-specific image path | Existing independent implementation | No DeepInfer kernel transplant |
| Persistent KV service | Conversation cache and session snapshots | DeepInfer README says the public repo omits the KV service | Keep and measure Strata's local cache; C2/C7 cover policy |
| Prefill/decode disaggregation | Separate Strata processes are possible, no cluster router here | DeepInfer README says full service is not included | Out of scope for one workstation |
| Replica load balancing / autoscaling | No workstation equivalent | Cluster control-plane feature | Out of scope |

## Implemented overlay

### Strict structured output

- A bounded, allocation-free JSON prefix automaton rejects malformed numbers, escapes,
  Unicode escapes, duplicate keys, missing required keys and trailing commas.
- The schema loader accepts a documented subset: object, array, string, number, boolean,
  null and enum. Unsupported schema features fail closed at startup.
- GGUF tokenizer metadata is parsed with size limits. Only EOS/EOT token IDs are admitted
  after a complete root value; other control and empty tokens remain forbidden.
- Every request resets the automaton. Grammar mode currently refuses batch slots, layer
  split and pipelined windows because one shared automaton would be incorrect there.
- A speculative row sampled under an older grammar state is checked against its real
  prefix. The first invalid row is re-sampled from the unchanged target logits after
  applying the advanced grammar mask; later unused rows are ignored.

### `sm_120` packed-mask kernel

`src/kernels/cuda/grammar_mask.cu` expands one packed allowed-token bit per vocabulary ID
into the effective device logit bias. It preserves the request's base bias and writes
negative infinity for forbidden IDs. The production path uses a persistent pinned host
bitset and an asynchronous 30.3 KiB upload for a 248,320-token vocabulary.

Measured locally on the RTX 5090 with CUDA 13.1, Release and `120-real`:

| isolated operation | result |
|---|---:|
| kernel only, 248,320 tokens | 7.337 microseconds per launch |
| pinned bitset upload plus kernel | 104.321 microseconds per state change |
| packed transfer | 30.3 KiB |
| equivalent dense FP32 bias | about 970 KiB |

These are component measurements, not an end-to-end throughput claim. The mask is rebuilt
only when the automaton state signature changes; free-text states reuse the existing mask.

### Deterministic sampling

The Qwen3.8 main verifier already keys Philox by `(seed, token position)`. The separate
Qwen3.6 engine used a mutable `mt19937_64` stream, so request interleaving could consume a
different draw sequence. The overlay changes it to the same position-keyed Philox formula
and adds an order-invariance unit test. `scripts/verify_determinism.mjs` checks the stronger
live property: the same seeded request must match when run alone and beside other requests.

### Runtime evidence harnesses

- `scripts/bench_concurrency.mjs`: aggregate throughput and p50/p95 latency by concurrency.
- `scripts/bench_replay.mjs`: cold prompt versus exact continuation reuse.
- `scripts/verify_determinism.mjs`: serial and interleaved seeded-output hashes.
- `scripts/bench_ab.mjs`: fixed workload A/B and offline comparison of result files.
- `scripts/bench_fresh.mjs`: unique prompts that cannot hide prefill behind cache reuse.

## Validation gates

The overlay is opt-in and must keep the default path unchanged when
`STRATA_GRAMMAR_SCHEMA` is unset. Before adoption:

1. Apply it to the pinned Strata revision with `scripts/apply-to-strata.ps1`.
2. Build `strata`, `strata-q36` and all four overlay tests for `120-real`.
3. Require unit and GPU parity tests to pass.
4. Run at least 10,000 structured samples across representative schemas, speculation on
   and off, with zero invalid committed tokens.
5. Require at least 95% of unconstrained decode throughput before enabling it for clients.
6. Run the deterministic interleaving and fixed/fresh A/B suites against a separate test
   profile. Never restart the live engine without an explicit cutover window.

## Known limits

- Startup-scoped JSON Schema only; no per-request native protocol field yet.
- JSON-Schema subset only; regex and EBNF are not implemented.
- Serial, single-GPU request stream only while a single automaton is shared.
- No end-to-end grammar throughput result yet; only module, build and isolated kernel data.
- No SM100 library is presented as an RTX 5090 port. Equivalent Strata kernels remain the
  supported path until a model-correct A/B result demonstrates a replacement is better.
