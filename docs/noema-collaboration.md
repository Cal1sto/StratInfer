# NOEMA supervised collaboration

NOEMA is StratInfer's local control plane for durable campaigns, specialist agents,
independent Codex reviews, human approvals, resource leases and reversible promotion.
It does not replace StratInfer or MOAI: StratInfer remains the local inference engine,
MOAI owns model placement, and NOEMA owns the canonical workflow state.

## Implemented boundary

The current implementation provides:

- a loopback-only HTTP service on `127.0.0.1:12160`;
- SQLite WAL campaign state and a SHA-256 chained event ledger;
- immutable checkpoints and structured `PASS`, `REVISE`, `BLOCKED` or `ESCALATE`
  reviews;
- one persistent Codex app-server thread per campaign, with a read-only sandbox;
- Git worktrees for candidate changes and bounded test commands;
- R0 to R4 risk policy, human approval records and promotion quarantine;
- content-addressed diff storage and mandatory rollback metadata;
- FTS5 plus 512-dimensional matrix memory;
- signed, quarantined skill manifests;
- MOAI voice release/restore leases;
- measured RTX 4080 profile planning;
- a separate FastMCP control server.

NOEMA does not perform online base-weight training. LoRA or other model changes must be
qualified as separate model artifacts. The 24-hour and 72-hour endurance campaigns,
automatic multimodal skill discovery and JEPA experiments remain explicit qualification
gates rather than completed claims.

## Trust model

| Actor | Authority |
|---|---|
| local Qwen specialists | analyse, propose, patch an isolated worktree and run bounded tests |
| Codex | independently review supplied checkpoints; no tool or write access in the supervisor thread |
| deterministic evaluators | provide build, test, security and performance evidence |
| NOEMA | enforce transitions, risk, quotas, promotion and rollback |
| owner | approve R3/R4 operations such as push, merge, deployment, identity or destructive actions |

Codex unavailability does not stop local analysis, but promotion remains frozen because
both the local and Codex verdicts must be `PASS`.

## Start and stop

Node.js 24 or newer is required. The start script creates a random token outside the
repository, restricts its Windows ACL, writes a PID plus creation-time identity file and
starts a hidden process.

```powershell
powershell -File scripts/start-noema.ps1
Invoke-RestMethod http://127.0.0.1:12160/health

# Identity-checked stop; it never kills a process by name alone.
powershell -File scripts/stop-noema.ps1
```

Use `-NoCodex` or `-NoMoai` for an isolated test. Runtime data defaults to
`E:\Data\NOEMA`; the Git repository contains no token, database or campaign artifact.

## Campaign flow

Read the token without printing it, then create a campaign:

```powershell
$token = (Get-Content E:\Data\NOEMA\control-token.txt -Raw).Trim()
$headers = @{ Authorization = "Bearer $token" }
$campaign = Invoke-RestMethod http://127.0.0.1:12160/v1/campaigns `
  -Method Post -Headers $headers -ContentType application/json -Body (@{
    objective = 'Correct and qualify the next StratInfer defect'
    workspace = 'E:\DEV\StratInfer\public-repo'
    acceptanceCriteria = @('All focused and repository tests pass', 'Rollback is documented')
    capabilities = @('coding','mcp','vision')
    resourceProfile = 'agent-max'
    riskBudget = 'R2'
  } | ConvertTo-Json)
```

Create the detached worktree and submit a checkpoint:

```powershell
Invoke-RestMethod "http://127.0.0.1:12160/v1/campaigns/$($campaign.id)/worktree" `
  -Method Post -Headers $headers -ContentType application/json -Body '{"revision":"HEAD"}'

$checkpoint = Invoke-RestMethod "http://127.0.0.1:12160/v1/campaigns/$($campaign.id)/checkpoints" `
  -Method Post -Headers $headers -ContentType application/json -Body (@{
    phase = 'architecture'
    actor = 'architect'
    summary = 'Objective, invariants, edits, tests and rollback are defined.'
    tests = @()
    risks = @('No live deployment in this checkpoint')
  } | ConvertTo-Json -Depth 8)

Invoke-RestMethod "http://127.0.0.1:12160/v1/campaigns/$($campaign.id)/review" `
  -Method Post -Headers $headers -ContentType application/json -Body '{}'
```

The Codex adapter uses `initialize`, `thread/start` and `turn/start`. It supplies a strict
review output schema and consumes the final agent message rather than concatenating the
streaming deltas with that final message. Codex is pinned to `read-only` and
`approvalPolicy: never`; all writes go through NOEMA's confined worktree executor.

## Worktree executor

The default command surface is deliberately narrow:

- `node --test` and `node --check`;
- `python -m pytest` and `python -m compileall`;
- read-only `git status`, `diff`, `show`, `rev-parse` and `log`;
- `npm test` or one named `npm run` script;
- `cmake --build` and `ctest`.

Inline `node -e`, `python -c`, PowerShell, arbitrary shells and Git writes are refused.
Patches are checked before application and cannot alter `.git`, secret files or the
NOEMA service, tests, deployment scripts, MCP bridge and resource-policy trust base.
This executor is a path and command allowlist inside the current Windows account; it is
not an OS or VM sandbox. Run untrusted generated code only inside an additional Windows
Sandbox, container or disposable VM.

## Risk and promotion

| Risk | Examples | Promotion |
|---|---|---|
| R0 | read and analysis | automatic |
| R1 | reversible worktree patch | automatic to local staging after two PASS verdicts |
| R2 | local engine or configuration change | local integration only, with rollback |
| R3 | push, merge, publication, deployment | owner approval required |
| R4 | destructive, payment, identity, account or personal-data action | owner approval required |

Every candidate stores its base revision, diff hash, local verdict, Codex verdict and
rollback. A missing Codex connection, non-PASS verdict or empty rollback blocks
promotion. Large diffs are content-addressed under `blobs/sha256`.

## Matrix memory and skills

Each memory record is inserted transactionally into:

- the durable SQLite record table;
- FTS5 for exact lexical retrieval;
- a normalized 512-dimensional feature matrix.

Recall combines at most 4,096 lexical and 4,096 recent candidates, then ranks them by
matrix similarity, lexical match and trust. Records retain campaign, role, sensitivity,
source hash and metadata. This is fast hybrid retrieval, not a semantic embedding claim.

Skill manifests require semantic versions, tests and rollback. Their canonical JSON is
hashed, and they remain quarantined until local and Codex verdicts both pass.

## RTX 4080 profiles

`configs/noema-resource-profiles.json` is the single repository source for the two
profiles:

| Profile | Voice | Helper target | Reserve | Host cache |
|---|---|---:|---:|---:|
| `voice-balanced` | resident | 4,096 MiB | 4,096 MiB | 12,288 MiB |
| `agent-max` | stopped for the campaign | up to 10,240 MiB | 4,096 MiB | 16,384 MiB |

The target is never allocated blindly. The script subtracts the reserve from measured
free VRAM, rounds down to 512 MiB and refuses `agent-max` below 8 GiB. Because Windows
WDDM does not expose reliable per-process VRAM, `agent-max` must first switch MOAI to
Strata so the existing helper cache is drained, then release ASR/TTS and wait for fresh
telemetry. Measuring while StratInfer is active fails before voice is touched.

The final live canary measured 15,137 MiB free after drain, selected 10,240 MiB for the
helper cache and preserved the 4,096 MiB reserve. Apply the profile only while voice is
released:

```powershell
powershell -File scripts/set-noema-resource-profile.ps1 `
  -Profile agent-max `
  -StratInferProfileJson E:\Data\JarvisMarc\StratInferRuntime\51f355f\profile.json `
  -CheckOnly
```

Without `-CheckOnly`, both the StratInfer profile and MOAI's advertised helper budget
are generated, validated, backed up and replaced transactionally. The engine still
needs the existing controlled MOAI cutover before the startup environment takes effect.

## NOEMA MCP

Start NOEMA before adding its control MCP server:

```powershell
powershell -File scripts/enable-noema-control.ps1 `
  -ProfileJson E:\Data\JarvisMarc\StratInferRuntime\51f355f\profile.json `
  -CheckOnly
```

The MCP process receives the token file path, not the token value. It exposes campaign
checkpoint and candidate inspection, Codex review requests, human approval requests
and non-mutating resource plans through four compact tools. The existing repository
FastMCP remains read-only. Normal requests do not enable MCP; the schema cost appears
only when `strata_mcp` is true.

## Validation

```powershell
node --test services/noema/tests/*.test.mjs
node --test scripts/tests/*.test.mjs
python -m py_compile tools/noema_control_fastmcp.py
node scripts/bench_noema.mjs
```

The live Codex canary must be expected to return `BLOCKED` when a checkpoint only claims
tests without providing revision-linked evidence. That is the required fail-closed
behaviour, not a canary failure.

Campaign completion additionally requires a current checkpoint, a `PASS` review for
that exact checkpoint and a valid event chain. Tests cover the successful path and reject
missing qualification, a stale `PASS` superseded by a newer checkpoint and a corrupted
chain. The 18 November live qualification passed 23/23 focused and 48/48 combined tests;
the final independent review returned `PASS` with 0.90 confidence and completed the
campaign after functional voice and rollback drills.

Measured implementation results and remaining endurance gates are in
[`../reports/noema-implementation-2026-11-17.md`](../reports/noema-implementation-2026-11-17.md).
The live MOAI activation and comparative battery are in
[`../reports/noema-live-benchmarks-2026-11-18.md`](../reports/noema-live-benchmarks-2026-11-18.md).

## Recovery

1. Pause the campaign and record the last event sequence.
2. Stop NOEMA with the identity-checked stop script.
3. Restore the backed-up StratInfer profile and MOAI registry if a resource profile was applied.
4. Restart the previous controlled text profile.
5. Prepare ASR and TTS and run their canaries.
6. Keep the SQLite database and blob store; they are not required by the legacy
   `long_session.mjs` orchestrator.

The legacy long-session workflow therefore remains a complete fallback while NOEMA is
qualified.
