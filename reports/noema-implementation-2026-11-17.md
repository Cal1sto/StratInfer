# NOEMA implementation report

> Historical foundation report. Live activation, subsequent corrections and comparative
> benchmarks are documented in
> [`noema-live-benchmarks-2026-11-18.md`](noema-live-benchmarks-2026-11-18.md).

Date: 17 November 2026

## Scope completed

- loopback HTTP control plane with token authentication;
- transactional SQLite state and hash-chained events;
- campaigns, checkpoints, reviews, approvals, candidates and rollback records;
- persistent Codex app-server threads and strict structured review output;
- secret screening before Codex review;
- detached Git worktrees and bounded command execution;
- R0-R4 risk and promotion policy;
- content-addressed diff storage;
- FTS5 plus 512-dimensional matrix memory;
- signed and quarantined skill registry;
- MOAI ASR/TTS release and restore client;
- measured RTX 4080 resource profiles;
- separate NOEMA FastMCP control server;
- hidden start and identity-checked stop scripts.

## Executed evidence

| Check | Result |
|---|---:|
| pre-existing StratInfer Node suite | 25/25 passed |
| NOEMA Node suite after trust-base/status integration | 17/17 passed |
| worktree create, patch and confinement | passed in a temporary Git repository |
| unauthorized HTTP mutation | rejected with HTTP 403 |
| event-chain verification | passed |
| promotion without human R3 approval | rejected |
| promotion while Codex unavailable | rejected by policy test |
| Python NOEMA MCP compilation | passed |
| NOEMA MCP profile generation, `-CheckOnly` | passed without live-profile mutation |
| hidden process health and identity-checked stop | passed on port 12161 |
| real Codex app-server thread and review | completed |

The live Codex canary returned `BLOCKED` with 0.99 confidence. It correctly identified
that a summary claiming 15 passing tests did not include revision-linked test output,
a sanitized request trace or verified unchanged-workspace evidence. This demonstrates
the intended independent fail-closed behaviour; it is not presented as task-quality
improvement evidence.

## Live capacity observation

The RTX 4080 reported 16,376 MiB total and 10,177 MiB free while Qwen3-ASR and
Qwen3-TTS were resident.

| Profile check | Result |
|---|---:|
| `voice-balanced` safe helper cache | 4,096 MiB |
| remaining reserve | at least 4,096 MiB |
| estimated 128K hot snapshots | 1 |
| `agent-max` with voice still resident | refused |
| safe cache computed before voice release | 5,632 MiB |
| minimum accepted for `agent-max` | 8,192 MiB |

The scripts therefore do not claim that stopping voice releases the declared 8 GiB
budget. They require a new measurement after the processes are actually evicted. The
agent target remains capped at 10,240 MiB and still preserves a 4,096 MiB reserve.

## Security properties exercised

- service binds only to loopback;
- mutations require a constant-time token comparison;
- token is generated outside Git and receives a user-only Windows ACL;
- PID, executable and process creation time are verified before stop;
- Codex runs as a read-only reviewer and cannot request interactive approvals;
- patches cannot touch `.git`, common secret paths or the NOEMA service, tests,
  deployment, MCP and resource-policy trust base;
- inline Node/Python execution and arbitrary shells are refused;
- R3/R4 operations require a recorded human decision;
- candidate diffs and event records are hashed.

## Limits and open qualification gates

- The live MOAI voice release was not executed during this implementation run because
  it requires an owner-authenticated operational cutover. The current voice stack
  remained available.
- The active StratInfer process was not restarted, so the live profile still needs the
  documented cutover before NOEMA MCP or a new helper cap is loaded.
- A 24-hour campaign, 72-hour campaign, SSD-pressure test and physical four-snapshot
  RTX 4080 pressure test remain pending.
- Matrix retrieval is feature-hashed hybrid retrieval, not a neural embedding result.
- Worktree command and path confinement is an application allowlist, not an OS/VM
  sandbox; untrusted generated code still requires an external disposable sandbox.
- General image, video and audio models remain routed through MOAI; NOEMA currently
  provides their control and evidence envelope, not new model weights.
- JEPA world modelling, LoRA training and non-autoregressive response generation remain
  research tracks and are not included in the validated control-plane claim.

## Verdict

The deployable NOEMA control-plane foundation is implemented and passes its focused
tests. It is ready for a controlled local canary with existing voice preserved. The
`agent-max` live cutover and endurance claims remain gated and must not be described as
completed performance gains.
