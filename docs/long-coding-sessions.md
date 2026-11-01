# Long coding sessions

This profile keeps exact model state and durable project context separate. Exact K/V
state makes a known conversation cheap to resume. The canonical context ledger keeps
the objective, constraints and accepted decisions visible even after transcript
compaction or a specialist handoff.

## Memory hierarchy

| Tier | Capacity | Contents | Failure behavior |
|---|---:|---|---|
| Active RTX 5090 | model/session dependent | current Strata session | normal inference path |
| RTX 4080 helper | 4,096 MiB | exact parked K/V tensors | falls back to the host snapshot if unavailable or too small |
| Host conversation cache | 8,192 MiB | parked conversations and checkpoints | bounded by the existing RAM floor |
| SSD session store | 32 GiB per project | exact Strata session files, one current file per specialist | LRU removes unpinned specialist files first |
| Canonical context + matrix | inside the SSD budget | objective, invariants, decisions, transcripts and 512-dimensional hashed retrieval rows | canonical context is always injected; it is not similarity-dependent |

`STRATA_PARK_VRAM_DEVICE=1` extends Strata's existing opt-in VRAM parking. The K/V
slot is allocated on CUDA device 1 and copied with `cudaMemcpyPeerAsync`. The host
image is still produced, so an evicted helper slot remains restorable. Unset variables
leave Strata's default path unchanged.

The helper cache does not increase the model's 524,288-token context limit. It avoids
re-reading exact saved prefixes. The matrix is feature-hashed lexical retrieval, not an
embedding model and not a replacement for the canonical context.

## Specialist roles

The default pipeline is sequential because native session save/restore is a single-slot
operation:

1. `architect` preserves invariants and defines acceptance criteria.
2. `implementer` proposes the smallest root-cause patch.
3. `reviewer` searches for correctness, race, security and compatibility failures.
4. `tester` defines deterministic, capacity and performance validation.
5. `documenter` produces operator guidance, limits and the durable handoff.

Each role has an isolated transcript and exact `.bin` session. Every request receives
the canonical main context, relevant matrix records and the previous role's handoff.
Model output is appended as supporting memory but never silently rewrites canonical
decisions.

## Engine setup

Build the overlay first. The build registers and runs both the normal snapshot test and
the two-GPU snapshot test.

Set these variables before starting the engine:

```powershell
$env:STRATA_PARK_ASYNC = "1"
$env:STRATA_PARK_VRAM_MIB = "4096"
$env:STRATA_PARK_VRAM_DEVICE = "1"
$env:STRATA_CKPT_ASYNC = "1"
$env:STRATA_CKPT_GATHER = "1"
$env:STRATA_CKPT_POOL = "1"
```

Add these engine arguments:

```text
--conversation-cache-mib 8192
--conversation-cache-slots 8
--conversation-cache-min-tokens 2048
--prompt-cache-spread
--session-min-free-mib 4096
--session-save-reclaim
```

Session endpoints require `--slot-save-path DIR` on the Python server, not the C++
engine. Parallel slots must stay disabled. The directory must exactly match the
`sessions_path` printed by the status command below.

## Initialize and run

```powershell
node scripts/long_session.mjs init `
  --project stratinfer `
  --objective "Maintain and improve StratInfer without losing accepted invariants" `
  --constraint "Never restart the active inference engine outside a cutover window"

node scripts/long_session.mjs status --project stratinfer
```

Restart a dedicated server with the printed directory as `--slot-save-path`. Then add
durable facts and launch a specialist pass:

```powershell
node scripts/long_session.mjs core --project stratinfer `
  --field decisions --text "Use RTX 4080 device 1 only for the 4096 MiB parked K/V tier"

node scripts/long_session.mjs remember --project stratinfer `
  --kind invariant --role main --importance 1 --pin `
  --text "The canonical objective must be present in every specialist prompt"

node scripts/long_session.mjs run --project stratinfer `
  --task "Implement the next accepted change and validate it"
```

Use `--roles architect,reviewer,tester` for a subset. Set `STRATINFER_MEMORY_DIR` to
place the 32 GiB store on a chosen SSD and `STRATINFER_API_URL` for another dedicated
server. `STRATINFER_API_KEY` is used when configured.

## Operations and recovery

- `status` reports used bytes, free bytes, snapshots and the required engine settings.
- `context --query "..." --role reviewer` shows exactly what a role will receive.
- `prune` enforces 32 GiB and the 4 GiB filesystem free-space floor.
- The `architect` snapshot is pinned by default. Canonical JSON and matrix files are
  never deleted by snapshot LRU.
- If a role snapshot is evicted, its transcript remains and the next request rebuilds
  the exact state with a cold prefill.
- If the helper GPU has less than 5.5 GiB free, Strata keeps the host path rather than
  overcommitting device 1.
- Restore only session files written by the same model files, engine version and
  arithmetic settings.

Do not run this orchestrator against a shared live conversation. Save/restore replaces
the engine's current session. Use a dedicated long-session profile or a controlled
cutover.

## Validation

```powershell
powershell -File scripts/test-long-session.ps1 -BuildDir C:\build\strata-sm120

# Individual components:
node --test scripts/tests/context-memory.test.mjs scripts/tests/agent-orchestrator.test.mjs
node scripts/bench_long_memory.mjs 2000 100
C:\build\strata-sm120\peer_cache_bench.exe 0 1 512 5
ctest --test-dir C:\build\strata-sm120 `
  -R "conversation_snapshot_test$|conversation_snapshot_test_park_peer" `
  --output-on-failure
```

Measured results and limitations are in
[`reports/long-session-memory-2026-11-01.md`](../reports/long-session-memory-2026-11-01.md).
