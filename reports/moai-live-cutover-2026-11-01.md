# MOAI live cutover — 1 November 2026

## Scope

This report validates the operational switch between Strata and StratInfer on the
target workstation. It covers rollback, endpoint routing, process ownership, the live
Qwen text canary and preservation of Qwen3-ASR/TTS on the RTX 4080. It does not replace
the earlier RTX 5090 throughput battery or the pending 24-hour long-session gate.

## Configuration

| Component | Configuration |
|---|---|
| MOAI | 1.0.15 |
| Text model | Qwen3.8-Flash-Next IQ3_S |
| StratInfer build | revision `51f355f`, CUDA `120-real` |
| Active text GPU | RTX 5090, CUDA device 0 |
| Voice/helper GPU | RTX 4080 SUPER, CUDA device 1 |
| Context | 524,288 tokens, `k8v4`, 65,536 resident tokens |
| Helper cache | exact parked K/V, maximum 4,096 MiB |
| Host conversation cache | 8,192 MiB, eight slots |
| SSD sessions | bounded at 32 GiB by the long-session orchestrator |

## Live results

| Check | Result | Verdict |
|---|---:|---|
| clean Strata to StratInfer cutover | 51.8 s | passed |
| StratInfer to Strata | 28.3 s | passed |
| Strata back to StratInfer | 40.5 s | passed |
| MOAI text canary after cutover | `OK`, 1.03 s wall time | passed |
| active context | 524,288 tokens | passed |
| Qwen3-ASR PID across round trip | unchanged | passed |
| Qwen3-TTS PID across round trip | unchanged | passed |
| Qwen3-TTS live synthesis | 3.6 s audio in 3.49 s | functional |
| Qwen3-ASR live transcription | 0.93 s wall, 891 ms worker | functional |
| MOAI test suite | 142/142 | passed |

The ASR round trip transcribed the synthetic French sentence approximately rather than
verbatim. It is a service and placement canary, not a speech-quality score.

At the final observation, Windows reported 29,811 MiB used on the RTX 5090 and 4,655
MiB used on the RTX 4080. These are whole-card WDDM values, not per-model allocations.
The helper cache is capped at 4,096 MiB but is allocated only for eligible parked K/V;
the cap must not be added to idle card usage as if it were permanently resident.

## Failure and rollback coverage

The integration exposed and fixed five operational failures before the accepted run:

1. an elevated legacy Strata process could not be terminated safely;
2. a launcher PID could exit before the real Python server;
3. text residency could race an explicit unload;
4. stale loading processes could become visible after an API timeout;
5. `nvidia-smi` returned measurements with a non-zero Windows exit code.

The accepted implementation uses separate ports, pauses only text residency, tracks the
real server identity, waits on the measured free-VRAM value and always verifies the
previous engine after a failed transaction. Failed trials restored Strata while keeping
both Qwen voice processes alive.

## Final state

- selected engine: **StratInfer**;
- MOAI text origin: `http://127.0.0.1:11441`;
- Strata fallback: listening on port 11440 with its model unloaded;
- Qwen3-ASR and Qwen3-TTS: ready on the RTX 4080;
- helper cache: device 1, exact maximum 4,096 MiB;
- switching status: idle.

## Remaining gates

- run a continuous 24-hour coding session with specialist handoffs;
- prove zero lost canonical invariants after compaction and restart;
- measure real parked-K/V hit rate and restore latency under voice load;
- keep SSD use below 32 GiB and verify LRU recovery on full-size session files;
- run a speech-quality corpus if ASR/TTS quality, rather than service availability, is
  part of the acceptance decision.

Structured evidence is stored in
[`data/moai-live-cutover-2026-11-01/validation.json`](data/moai-live-cutover-2026-11-01/validation.json).
