# MOAI engine switch

MOAI 1.0.15 can select the official Strata runtime or the opt-in StratInfer long-session
runtime without restarting Qwen3-ASR or Qwen3-TTS. The switch is local, owner-only and
refused while non-idle work is active.

## Runtime layout

| Service | Endpoint | Placement | Lifecycle |
|---|---|---|---|
| Strata fallback | `http://127.0.0.1:11440` | Qwen3.8-Flash-Next on RTX 5090 | server remains online; model is unloaded while StratInfer is selected |
| StratInfer | `http://127.0.0.1:11441` | Qwen3.8-Flash-Next, `sm_120`, RTX 5090 | managed process with an identity file and exact rollback |
| Qwen3-ASR 0.6B | stable MOAI voice API | RTX 4080 | resident process must keep the same PID across a text switch |
| Qwen3-TTS 0.6B | stable MOAI voice API | RTX 4080 | resident process must keep the same PID across a text switch |

The selected runtime changes MOAI's in-memory and persisted `qwenOrigin`. Status and
telemetry therefore follow the active endpoint instead of remaining bound to port
11440.

## Transaction

1. MOAI verifies that rendering, text work and voice changes are idle.
2. Qwen text residency is paused; ASR and TTS residency remains enabled.
3. The current text model is unloaded or its managed process is stopped.
4. The RTX 5090 must report at least 24,000 MiB free before the other runtime starts.
5. The target runtime loads and answers a deterministic `OK` canary.
6. MOAI persists the engine and origin, runs its own canary, and verifies both voice
   PIDs.
7. Any failure selects and verifies the previous runtime before the API returns an
   error.

The Strata fallback server stays bound to port 11440 because an already elevated legacy
process cannot safely be terminated by a non-elevated manager. Using a second port
avoids process takeover, port reuse and privilege escalation.

## RTX 4080 helper cache

The StratInfer profile sets:

```text
STRATA_PARK_ASYNC=1
STRATA_PARK_VRAM_MIB=4096
STRATA_PARK_VRAM_DEVICE=1
```

The 4,096 MiB value is an exact upper bound, not a permanent allocation. Device memory
is consumed by eligible parked K/V snapshots and released under pressure. Strata keeps
the host snapshot as a fallback and requires 1.5 GiB to remain free on the helper GPU.
Qwen3-ASR and Qwen3-TTS therefore remain the first-class resident workloads on the RTX
4080.

## API

The authenticated owner can inspect and select the engine:

```http
GET /api/text/engine
POST /api/text/engine
Content-Type: application/json

{"id":"stratinfer"}
```

Valid identifiers are `strata` and `stratinfer`. The response reports the selected
engine, switch state, endpoint port and helper-cache budget. Application clients keep
using MOAI's stable `/v1/chat/completions`, speech and transcription APIs.

## Recovery

- A managed StratInfer process is identified by PID, creation time, executable, profile
  and port before it can be stopped.
- The launcher is not treated as the engine PID; the state file is rewritten with the
  real Python server process during startup.
- Stray processes are never killed by name alone.
- If port 11441 is occupied without a valid state file, startup fails closed.
- A failed cutover leaves the previous engine selected and keeps ASR/TTS available.

Live measurements and remaining limits are in
[`../reports/moai-live-cutover-2026-11-01.md`](../reports/moai-live-cutover-2026-11-01.md).
