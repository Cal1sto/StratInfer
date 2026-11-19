# NOEMA live activation and benchmark report

Date: 18 November 2026

## Executive verdict

MOAI can activate StratInfer through NOEMA, and the integration is now active locally.
The final live state is:

- MOAI `1.0.15` selects `stratinfer` on port `11441`;
- NOEMA listens on loopback port `12160`;
- the StratInfer profile uses a 4,096 MiB RTX 4080 helper cap and 12,288 MiB host cache;
- Qwen3-ASR and Qwen3-TTS remain ready on the RTX 4080;
- both FastMCP servers are ready, with six StratInfer tools and four compact NOEMA tools;
- ordinary requests do not enable MCP and therefore receive no NOEMA prompt-schema cost.

The solution is accepted for controlled local use. A 24-hour run, a 72-hour run, an
SSD-pressure run and a committed immutable release revision remain qualification gates.

## Defects found and corrected

| Finding | Risk | Correction |
|---|---|---|
| NOEMA had no MOAI admin credential | resource and engine mutations always failed | the start script decrypts the current-user DPAPI credential and injects it only into the child-process environment |
| voice release could stop one service before the second failed | partial voice outage | speech is released first and restored automatically if ASR release fails |
| voice preparation omitted MOAI authentication | restoration failure | all prepare and release calls now carry the admin bearer token |
| MOAI switch timeout was 30 seconds | false failure during normal model reload | text-engine activation now allows 12 minutes; voice preparation allows 3 minutes |
| profile declared 6,144 MiB while MOAI advertised 4,096 MiB | admission drift and possible overcommit | the live profile and registry are aligned to 4,096 MiB |
| process identity comparison failed after JSON converted the timestamp to `DateTime` | NOEMA could not be safely restarted | both timestamps are normalized to UTC ISO-8601 before comparison |
| `agent-max` measured while the existing helper cache was still active | false capacity rejection and unnecessary voice restart | acquisition now fails before eviction until MOAI is on Strata; measurement occurs after drain |
| first post-eviction telemetry was stale | safe cache was underestimated at 8,704 MiB | NOEMA waits 2.5 seconds for fresh MOAI telemetry |
| six NOEMA tools added avoidable schema tokens | MCP prompt and latency overhead | three read tools were merged into `inspect`; four tools retain all functions |
| benchmark counted HTTP completion as tool success | retries and format failures could be hidden | reports now separate tool execution, exact reply and strict success |

## Reproducible evidence

The machine-readable qualification receipt is
[`data/noema-2026-11-18/qualification-final-v2/noema-live-qualification-1794997577256.json`](data/noema-2026-11-18/qualification-final-v2/noema-live-qualification-1794997577256.json).
It includes the exact Git head, dirty-tree disclosure, hashes of trust-base files and the
active profile, full test output, live health, MCP state, switch responses, GPU telemetry,
event-chain head and rollback instructions. It contains no bearer token.

| Check | Result |
|---|---:|
| combined Node tests | 48/48 passed |
| focused NOEMA tests | 23/23 passed |
| unauthorized NOEMA mutation | HTTP 403 |
| event-chain verification | valid |
| completion without current qualification | rejected |
| stale `PASS` after a newer checkpoint | rejected |
| completion with corrupted event chain | rejected |
| MCP servers | `stratinfer: ready`, `noema_control: ready` |
| MCP tools | 10 total |
| ASR PID across text double-switch | preserved |
| TTS PID across text double-switch | preserved |
| functional TTS-to-ASR round trip | passed before and after switch |
| legacy-profile rollback and restoration | passed |
| active profile helper cap | 4,096 MiB |
| active profile host cache | 12,288 MiB |

The independent Codex review initially returned `BLOCKED` with 0.97 confidence because
the checkpoint referenced results without embedding a timestamped receipt, exact
before/after state and executable rollback. The final checkpoint embedded the receipt,
functional voice evidence and rollback evidence. Codex returned `PASS` with 0.90
confidence, no required corrections, and the campaign
`campaign-852fe941-eddb-4160-b262-1d608b0d5817` completed. The reviewer retained the
limits listed below and noted that it relied on supplied receipts rather than independently
recomputing their hashes. This sequence is evidence that the fail-closed reviewer detects
unsupported claims and only opens the completion gate after current evidence passes.

Additional machine-readable evidence:

- [`data/noema-2026-11-18/qualification-final/voice-roundtrip.json`](data/noema-2026-11-18/qualification-final/voice-roundtrip.json): identical 176,684-byte WAV and identical transcript before and after the double switch;
- [`data/noema-2026-11-18/qualification-final/rollback-drill.json`](data/noema-2026-11-18/qualification-final/rollback-drill.json): original six-tool profile, `ROLLBACK_OK` canary, then restoration of both MCP servers and ten tools.

## Control-plane benchmark

Raw data:
[`data/noema-2026-11-18/control-plane/noema-control-plane-1794994966229.json`](data/noema-2026-11-18/control-plane/noema-control-plane-1794994966229.json).

The benchmark used a temporary SQLite database, 250 sequential health reads, 250
authenticated metric reads, 250 concurrent reads, 100 durable checkpoints, 1,000
matrix-memory inserts and 100 hybrid recalls.

| Operation | Median | p95 |
|---|---:|---:|
| health | 15.546 ms | 16.365 ms |
| authenticated metrics | 15.431 ms | 16.331 ms |
| rejected unauthorized mutation | 15.337 ms | 16.838 ms |
| durable checkpoint and event | 15.397 ms | 17.203 ms |
| event-chain read and verification | 15.476 ms | 16.586 ms |
| matrix-memory commit | 15.393 ms | 17.245 ms |
| hybrid recall over 1,000 records | 29.193 ms | 35.366 ms |

Measured throughput was 67.7 checkpoint commits/s, 68.2 matrix-memory commits/s and
3,502 concurrent health reads/s. The 1,000-record run used 8.922 MiB, approximately
9,355 bytes per memory record including SQLite/WAL overhead and 512 float dimensions.
Process RSS grew by 76.9 MiB during that synthetic load. The idle live NOEMA process
was separately observed at 81.52 MiB working set and 90.02 MiB private memory.

## Idle LLM overhead

Three 30-request plain-completion arms ran on the same loaded StratInfer process:

| NOEMA service | Median wall time |
|---|---:|
| running, first arm | 104.1 ms |
| stopped | 101.6 ms |
| running, second arm | 99.0 ms |

The average of the two running medians is 101.55 ms versus 101.6 ms stopped. The
observed difference is -0.05 ms and is noise, not a speed gain. NOEMA is out of the
ordinary inference path.

Raw arms are under `data/noema-2026-11-18/idle-on-1`, `idle-off` and `idle-on-2`.

## MCP overhead and correction

Five-trial medians isolate deterministic schema growth from variable model latency:

| Configuration | Tools | Advertised prompt | Advertised wall | Real StratInfer tool wall |
|---|---:|---:|---:|---:|
| original StratInfer MCP | 6 | 827 tokens | 1,629.8 ms | 2,882.3 ms |
| initial NOEMA integration | 12 | 1,376 tokens | 2,054.0 ms | 3,306.3 ms |
| compact NOEMA integration | 10 | 1,231 tokens | 1,942.8 ms | 3,218.1 ms |

The initial six-tool NOEMA bridge added 549 tokens. Compacting to four tools reduced
that incremental cost to 404 tokens, a 26.4% reduction in NOEMA schema overhead. It
also reduced the measured advertised median by 111.2 ms and the tool-call median by
88.2 ms relative to the initial integration.

The final hardened ten-trial run achieved:

- 10/10 exact plain replies;
- 10/10 exact MCP-advertised replies;
- 10/10 successful StratInfer tool calls;
- 10/10 successful NOEMA `inspect` calls;
- 10/10 exact `NOEMA_OK` final replies;
- 15 ms median NOEMA tool execution;
- 3,288.2 ms median end-to-end NOEMA tool request.

The end-to-end time is dominated by two LLM rounds and 1,804 prompt tokens, not the
15 ms control-plane call. Raw data:
[`data/noema-2026-11-18/noema-tool-hardened/fastmcp-1794995882389.json`](data/noema-2026-11-18/noema-tool-hardened/fastmcp-1794995882389.json).

## Final inference battery

The pre-integration arm had two repeats; the final arm has five. Results are useful as
a regression screen but not as proof that NOEMA improves inference speed.

| Suite | Before | Final | Delta |
|---|---:|---:|---:|
| code-8k decode | 93.50 tok/s | 102.92 tok/s | +10.1% |
| prose-2k decode | 84.50 tok/s | 91.44 tok/s | +8.2% |
| agent-32k decode | 72.45 tok/s | 72.72 tok/s | +0.4% |
| aggregate decode | 83.48 tok/s | 89.03 tok/s | +6.6% |
| aggregate hit rate | 0.93 | 0.93 | unchanged |
| speculative draft acceptance | 0.708 | 0.693 | -1.5 points |

The agent-32k case is effectively unchanged, so the corrected 4 GiB profile did not
show a long-context decode regression in this battery. The positive aggregate delta is
not attributed to NOEMA because restart state, cache warmth and the unequal sample
counts are confounders.

Raw final data:
[`data/noema-2026-11-18/final/run-noema-final-1794996607986.json`](data/noema-2026-11-18/final/run-noema-final-1794996607986.json).

## Context replay

| Requested context | Actual prompt | Reused | Prompt read | Cold prefill | Resume prefill |
|---|---:|---:|---:|---:|---:|
| 16k | 25,453 | 25,425 | 28 | 7,279.8 ms | 562.7 ms |
| 64k | 101,452 | 101,424 | 28 | 26,507.4 ms | 1,081.0 ms |

The resumed 64k-derived prompt reread 0.0276% of tokens and reduced measured prompt
time by 95.9%. Both runs reported exact reuse.

## RTX 4080 profiles

### Voice-balanced, active

- 4,096 MiB helper cap;
- 4,096 MiB preserved reserve;
- one estimated 128k hot snapshot;
- ASR and TTS remain resident;
- 12,288 MiB host cache.

### Agent-max, qualified capacity only

`agent-max` must first switch MOAI to Strata so the existing helper cache is absent,
then evict ASR/TTS and wait for fresh telemetry. The final canary measured:

| Metric | Result |
|---|---:|
| RTX 4080 free after drain | 15,137 MiB via fresh MOAI telemetry |
| selected helper cache | 10,240 MiB |
| preserved reserve | 4,096 MiB |
| estimated hot snapshots | 4 |
| lease acquisition | 4,100.3 ms |
| voice readiness while leased | ASR off, TTS off |
| restoration | ASR ready, TTS ready, StratInfer active |

An earlier immediate measurement saw only 13,056 MiB and selected 8,704 MiB because
telemetry was still settling. The 2.5-second delay fixed the measurement without
weakening the reserve. `agent-max` capacity is qualified, but the live system remains
on `voice-balanced`; no claim is made that ASR/TTS can coexist with the 10 GiB cache.

The measured text-engine transitions took approximately 31.6 seconds to Strata and
50.4 seconds back to StratInfer. One voice restoration canary took 20.4 seconds. These
are operational disadvantages of changing profiles, not per-request overhead.

## Advantages

- fail-closed campaign, checkpoint, promotion and approval state;
- independent Codex review catches unsupported evidence claims;
- immutable hash-chained events and content-addressed candidate diffs;
- reversible worktrees and explicit R0-R4 boundaries;
- durable hybrid memory with sub-36 ms p95 recall at 1,000 records;
- negligible measured idle impact on ordinary LLM requests;
- MOAI-owned engine switching preserves the live voice processes;
- safe, measured access to four hot-snapshot equivalents when voice is intentionally released.

## Disadvantages and limits

- MCP opt-in adds 404 prompt tokens beyond the original six-tool configuration;
- a real NOEMA tool request needs two model rounds and measured 3.29 seconds median;
- the service adds roughly 80-90 MiB of resident/private memory;
- `agent-max` interrupts voice and requires slow engine transitions;
- Windows WDDM does not expose reliable per-process VRAM, so drain-first measurement is mandatory;
- the worktree executor is not an OS sandbox;
- the qualified tree is dirty and therefore identified by file hashes, not an immutable commit;
- the independent reviewer consumed supplied receipts but did not separately recompute their hashes;
- functional voice continuity was qualified for `voice-balanced`, not while `agent-max` holds its lease;
- 24-hour, 72-hour and SSD-pressure endurance gates remain pending.

## Rollback

1. Pause campaigns and record the latest event sequence.
2. Switch MOAI to `strata` using the campaign-scoped endpoint.
3. Stop NOEMA with `scripts/stop-noema.ps1`.
4. Restore `E:\Data\JarvisMarc\StratInferRuntime\51f355f\profile.json.noema-mcp-20261118T104319.bak`.
5. Keep MOAI `helperVramBytes` at 4,294,967,296 bytes.
6. Switch MOAI back to `stratinfer`.
7. Verify MOAI health, ASR/TTS readiness, the original StratInfer MCP server, the
   4,096 MiB helper cap and one plain completion.

This removes the NOEMA MCP dependency while preserving the corrected voice-balanced
cache setting. This exact rollback was exercised successfully, including a plain
`ROLLBACK_OK` completion, then reversed to restore the qualified ten-tool profile. The
NOEMA SQLite database can remain for forensic inspection.
