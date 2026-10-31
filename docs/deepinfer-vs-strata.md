# DeepInfer ↔ Strata — idea mapping and importability

DeepInfer (deepseek-ai/DeepInfer, studied at `5537415`) is a DeepSeek-V4.1-Flash serving
framework for SM100-class datacenter GPUs (B200/GB300 class) and Ascend 950. Strata
(Niko1221/Strata, studied at `870aedd`) is a consumer/prosumer MoE engine (offloaded experts,
hierarchical VRAM/RAM/SSD cache, speculative MTP). Mapping each DeepInfer idea to its Strata
counterpart and whether it can be imported, ported, or must be re-derived and re-measured:

| DeepInfer idea | Strata counterpart | Importable? | What we did |
|---|---|---|---|
| Chunked GDN/linear-attention kernels | `STRATA_GDN_CHUNKED` opt-in | kernels: no (SM100-only); the switch exists | measured it: +0.6 % not 1.8× (see RESULTS C1) — doc claim is component-local |
| KV budget vs compute tuning | `--kv k8v4`, KV streaming | technique: yes | adopted k8v4: +8 % decode, −4 % prefill (RESULTS C3a) |
| NextN decode + per-token confidence scheduling (`DEEPINFER_USE_NEXTN_DECODE=5` default) | `--spec`/`--spec-min-p`, MTP draft chain | idea: testable | swept depth (C4: default optimal); simulated confidence scheduling (RFC-02: +0.1 %, refuted as stated) |
| 72 h KV/context persistence, 96 % hit rate | conversation cache (`--conversation-cache-*`), session files | policy: yes | found the feature structurally off due to a 512 MiB budget; fixed → 0 rejections, 18× faster resume (RESULTS C2) |
| Grammar-constrained decoding (regex / JSON schema / EBNF, precompiled automata) | none — `structured.py` documents prompting + validation | idea: port to engine | built the automaton, proved the insertion point (host-side sampling), proved why HTTP cannot do it (RFC-01/05) |
| Zero-overhead CPU/GPU scheduler | per-size CUDA graphs, host-side sampler overlap | partial | identified free overlap window at the sampler (host computes masks while GPU verifies); C6 (thread placement) not yet measured |
| NVFP4/BF16 datacenter kernels | IQ3_S/GGUF quant path | no (different hardware class) | nothing to port; noted to stop hoping |

Cross-cutting lessons taken from DeepInfer's engineering culture rather than its code:
publish acceptance tests per feature; treat speculative-decoding depth as a scheduled
resource, not a constant; make long-lived context the default customer experience.

Cross-cutting lessons about reading *any* upstream doc (Strata's own, in this case): a
measured multiplier quoted "per card" may describe one component in isolation. Component
claims → re-measure end-to-end on the real workload before believing the budget.
