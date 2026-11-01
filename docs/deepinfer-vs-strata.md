# DeepInfer to Strata mapping

This is the short decision log. The detailed hardware and implementation analysis is
in [`deepinfer-sm120-port.md`](deepinfer-sm120-port.md).

Studied revisions:

- DeepInfer `5537415`, DeepSeek-V4.1-Flash, SM100/Ascend-oriented;
- Strata `870aedd`, Qwen3.8-Flash-Next, GGUF/offloaded-expert-oriented;
- target hardware: one RTX 5090, CUDA architecture `sm_120`.

| DeepInfer capability | Native Strata/Qwen counterpart | Decision |
|---|---|---|
| FlashMLA | QSA prompt/decode attention | Keep native layouts and kernels |
| DeepGEMM | MMQ and IQ/NVFP4 paths | Keep native quantization kernels |
| DeepEP and EPLB | expert cache, adaptive placement, PCIe streaming | Import measurement policy, not collectives |
| DeepSelect | QSA selector/top-k | Already model-specific in Strata |
| TileLang kernels | AOT CUDA plus captured graphs | Do not add a second runtime without evidence |
| Attention DP/CP | layer split and pipeline windows | No one-GPU port |
| DSpark/NextN | MTP, DFlash2, `DraftPolicy` | Sweep and simulate; fixed default won |
| SWA bounded replay/YoCo | exact checkpoints, session and conversation cache | Measure exact replay; do not copy approximate model logic |
| Zero-overhead scheduler | CUDA graphs, batch groups, async tiers | Add concurrency benchmark; no default change yet |
| Batch-invariant sampling | position-keyed Philox | Verify live interleaving; repair Qwen3.6 sampler |
| Structured outputs | previously absent | Implement strict JSON-Schema overlay and CUDA mask |
| Persistent KV service | local conversation cache | Tune and measure local policy |
| Disaggregated serving | no workstation cluster control plane | Out of scope |

## Decisions backed by measurements

- `STRATA_GDN_CHUNKED`: +0.6%, inside noise; rejected.
- `k8v4`: +8.0% decode for about -4.2% fresh prefill; kept.
- conversation cache 4096 MiB: eliminated measured budget rejections; kept.
- speculation depth 3/5: slower than the default depth 4; rejected.
- confidence scheduling: +0.1% in the calibrated simulation; rejected as stated.
- strict grammar overlay: builds and passes four tests; live end-to-end gate pending.

The central rule is model correctness before kernel reuse. Shared terminology does not
make DeepSeek SM100 tensor layouts compatible with Qwen GGUF layouts on `sm_120`.
