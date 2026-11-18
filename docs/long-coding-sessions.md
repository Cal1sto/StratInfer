# Long coding sessions

This profile keeps exact model state and durable project context separate. Exact K/V
state makes a known conversation cheap to resume. The canonical context ledger keeps
the objective, constraints and accepted decisions visible even after transcript
compaction or a specialist handoff.

## Memory hierarchy

| Tier | Capacity | Contents | Failure behavior |
|---|---:|---|---|
| Active RTX 5090 | model/session dependent | current Strata session | normal inference path |
| RTX 4080 helper | 6,144 MiB | exact parked K/V tensors, about two target-sized snapshots | falls back to the host snapshot if unavailable or too small |
| Host conversation cache | 12,288 MiB | parked conversations and checkpoints, about five target-sized snapshots | bounded by the RAM floor |
| SSD session store | 64 GiB per project, 32 GiB free-space floor | exact session files, workflow checkpoints and transcripts | LRU removes unpinned specialist files first |
| Canonical context + matrix | 8 GiB reserved inside the SSD budget | core state and up to 250,000 active 512-dimensional rows | matrix mismatch is rebuilt from the durable ledger |

`STRATA_PARK_VRAM_DEVICE=1` extends Strata's existing opt-in VRAM parking. The K/V
slot is allocated on CUDA device 1 and copied with `cudaMemcpyPeerAsync`. The host
image is still produced, so an evicted helper slot remains restorable. Unset variables
leave Strata's default path unchanged.

The helper cache does not increase the model's 524,288-token context limit. It avoids
re-reading exact saved prefixes. The matrix is feature-hashed lexical retrieval, not an
embedding model and not a replacement for the canonical context.

## Capacity rationale

The profile targets eight specialists with 131,072 useful context tokens per role. The
measured `k8v4` density is about 16,333 snapshot bytes per token. A 20% safety factor
therefore estimates **2.393 GiB per role**. On the validated local machine this gives:

- 23 target-sized snapshots inside the 56 GiB SSD snapshot partition;
- five target-sized snapshots in the 12 GiB host cache;
- two target-sized snapshots inside the 6 GiB helper-VRAM cap;
- 0.477 GiB for 250,000 dense matrix rows at 512 dimensions.

The target is deliberately 128K rather than 524K. Eight maximum-size contexts would
consume roughly 76 GiB of snapshots after safety margin and would not fit the bounded
store. Run `node scripts/long_session.mjs plan` after any hardware or quota change; the
planner rejects insufficient helper VRAM or SSD instead of silently overcommitting.

## Specialist roles

The default pipeline remains sequential because native session save/restore is a
single-slot operation. Eight roles cover distinct failure domains:

1. `architect` preserves invariants and defines acceptance criteria.
2. `analyst` verifies repository and runtime facts with read-only MCP tools.
3. `implementer` produces the smallest root-cause patch or exact edit set.
4. `reviewer` searches for correctness, security, race and compatibility failures.
5. `tester` defines deterministic, restart, failure and capacity validation.
6. `performance` checks RAM, VRAM, SSD, context, throughput and energy claims.
7. `integrator` resolves all findings into one coherent change set.
8. `documenter` records only the verified final state and rollback.

Reviewer, tester and performance turns must emit `VERDICT: PASS`, `REVISE` or
`BLOCKED`. After integration, reviewer and tester run again. A non-pass result triggers
at most two additional integration cycles; exhaustion is stored as a blocked run rather
than being mislabeled successful.

Each role has an isolated transcript and exact `.bin` session. Every request receives
the canonical main context, relevant matrix records and the previous role's handoff.
Model output is appended as supporting memory but never silently rewrites canonical
decisions.

The live MOAI server uses one shared `engine_sessions_path`. Snapshot filenames are
therefore project-prefixed, for example `stratinfer--architect.bin`, so two projects or
roles cannot silently overwrite one another. MCP is enabled only for roles configured
with `mcp: true`; the deployed repository tools remain read-only. This orchestrator can
inspect, reason, produce exact patches and validate plans, but an external approved
writer must still apply filesystem changes.

## Engine setup

Build the overlay first. The build registers and runs both the normal snapshot test and
the two-GPU snapshot test.

Set these variables before starting the engine:

```powershell
$env:STRATA_PARK_ASYNC = "1"
$env:STRATA_PARK_VRAM_MIB = "6144"
$env:STRATA_PARK_VRAM_DEVICE = "1"
$env:STRATA_CKPT_ASYNC = "1"
$env:STRATA_CKPT_GATHER = "1"
$env:STRATA_CKPT_POOL = "1"
```

Add these engine arguments:

```text
--conversation-cache-mib 12288
--conversation-cache-slots 8
--conversation-cache-min-tokens 2048
--conversation-cache-park-gain 2048
--prompt-cache-spread
--session-min-free-mib 4096
--session-save-reclaim
```

`--conversation-cache-park-gain 2048` preserves the last exact snapshot until the
conversation grows by at least 2,048 tokens. Short agent turns therefore restore the
same checkpoint without copying a multi-gigabyte K/V snapshot again after every reply.

Apply the two profile limits with an automatic backup, then use the transactional MOAI
Strata/StratInfer switch so the new process reads them:

```powershell
powershell -File scripts/configure-multi-agent-profile.ps1 `
  -ProfileJson E:\Data\JarvisMarc\StratInferRuntime\51f355f\profile.json
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
node scripts/long_session.mjs plan --project stratinfer
```

Restart a dedicated server with the printed directory as `--slot-save-path`. Then add
durable facts and launch a specialist pass:

```powershell
node scripts/long_session.mjs core --project stratinfer `
  --field decisions --text "Use RTX 4080 device 1 only for the 6144 MiB parked K/V tier"

node scripts/long_session.mjs remember --project stratinfer `
  --kind invariant --role main --importance 1 --pin `
  --text "The canonical objective must be present in every specialist prompt"

node scripts/long_session.mjs run --project stratinfer `
  --run-id next-change `
  --task "Implement the next accepted change and validate it"

# Resume after a process, MCP or model interruption without rerunning passed stages.
node scripts/long_session.mjs resume --project stratinfer --run-id next-change
```

Use `--roles architect,reviewer,tester` for a subset. Set `STRATINFER_MEMORY_DIR` to
place the 64 GiB store on a chosen SSD and `STRATINFER_API_URL` for another dedicated
server. `STRATINFER_API_KEY` is used when configured.

Set `enable_thinking: false` only for short mechanical roles or canaries. The default is
enabled for development specialists; a small output limit can otherwise be consumed by
reasoning before Qwen emits final assistant content.

## Operations and recovery

- `plan` probes the live GPUs, host RAM and selected filesystem and reports whether all
  eight target contexts fit.
- `status` reports storage, matrix integrity, run paths, capacity and engine settings.
- `context --query "..." --role reviewer` shows exactly what a role will receive.
- `verify-matrix --repair` rebuilds a truncated or interrupted matrix from the ledger.
- `prune` enforces 64 GiB and the 32 GiB filesystem free-space floor.
- The `architect` snapshot is pinned by default. Canonical JSON and matrix files are
  never deleted by snapshot LRU.
- If a role snapshot is evicted, its transcript remains and the next request rebuilds
  the exact state with a cold prefill.
- The planner requires the 6 GiB helper cap plus a 4 GiB safety reserve. Strata itself
  still falls back to the host path when an individual allocation is unsafe.
- Retrieval preselects at most 4,096 candidates while always retaining pinned and the
  2,048 newest records, then applies the dense matrix score. This avoids an unbounded
  dense scan while preserving exact old query-term matches.
- Runs are checkpointed after every specialist. `resume --run-id ID` restarts at the
  failed stage and preserves all completed outputs and gate findings.
- Restore only session files written by the same model files, engine version and
  arithmetic settings.

Do not run this orchestrator against a shared live conversation. Save/restore replaces
the engine's current session. Use a dedicated long-session profile or a controlled
cutover.

## Validation

```powershell
powershell -File scripts/test-long-session.ps1 -BuildDir C:\build\strata-sm120

# Individual components:
node --test scripts/tests/capacity-planner.test.mjs scripts/tests/context-memory.test.mjs scripts/tests/agent-orchestrator.test.mjs
node scripts/long_session.mjs plan --project stratinfer
node scripts/bench_long_memory.mjs 2000 100
C:\build\strata-sm120\peer_cache_bench.exe 0 1 512 5
ctest --test-dir C:\build\strata-sm120 `
  -R "conversation_snapshot_test$|conversation_snapshot_test_park_peer" `
  --output-on-failure
```

Measured results and limitations are in
[`reports/long-session-memory-2026-11-01.md`](../reports/long-session-memory-2026-11-01.md).
