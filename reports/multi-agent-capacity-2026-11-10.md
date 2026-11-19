# Multi-agent long-session capacity — live validation

Date: 10 November 2026

Machine: RTX 5090 + RTX 4080 SUPER, 127.7 GiB RAM, SSD `E:`

## Critical findings

The previous five-role design had enough durable storage for ordinary sessions, but it
had four structural limits: no capacity gate, no workflow checkpoint, no bounded review
loop, and a session directory that did not match the live MOAI server. Increasing quotas
alone would not have produced a reliable multi-agent system.

The revised design keeps one active model slot and eight sequential durable specialists.
It does **not** claim eight simultaneous Qwen replicas. This preserves the 524,288-token
model window and avoids duplicating a model that already occupies about 29.8 GiB on the
RTX 5090.

## Dimensioning

| Item | Revised value | Basis |
|---|---:|---|
| specialist roles | 8 | architecture, analysis, implementation, review, test, performance, integration, documentation |
| target context per role | 131,072 tokens | useful long-coding window without pretending every role can retain 524K |
| snapshot density | 16,333 bytes/token | measured 3,438,997,384-byte snapshot at 210,552 tokens |
| safety factor | 1.20 | allocation and metadata margin |
| estimated snapshot per role | 2.393 GiB | calculated, not physically filled to 128K in this run |
| RTX 4080 helper cap | 6,144 MiB | two target snapshots; 4,096 MiB planner reserve for voice and safety |
| host conversation cache | 12,288 MiB | five target snapshots |
| SSD project budget | 64 GiB | 56 GiB snapshots plus 8 GiB metadata/matrix reserve |
| SSD free-space floor | 32 GiB | fail-closed storage guard |
| active matrix | 250,000 × 512 float32 | 0.477 GiB dense rows at the configured limit |

The live hardware probe measured about 11.0 GiB free on RTX 4080, 30.4 GiB free host
RAM and 1,795.5 GiB free on `E:`. The planner therefore reported capacity for two
target snapshots in helper VRAM, five in host cache and 23 in the SSD snapshot partition.

## Orchestration changes

- every stage receives a token-derived transcript and memory budget;
- every specialist has an isolated transcript and project-prefixed exact snapshot;
- run state is written atomically after every stage and can resume at the failed stage;
- reviewer, tester and performance agents emit `PASS`, `REVISE` or `BLOCKED`;
- final reviewer/tester gates run after integration;
- at most two correction cycles are allowed; exhaustion is blocked, never reported as success;
- MCP schemas are enabled only for roles that inspect repository evidence;
- MCP repository access remains read-only; applying model-generated patches still needs
  an external approved writer.

## Matrix and persistence results

The matrix remains 512-dimensional because the earlier 10,000-record campaign already
showed perfect synthetic top-5 recall; increasing dimensions would mostly double storage
and arithmetic. The new retrieval preselects 4,096 candidates while always retaining
pinned records, 2,048 recent records and old exact term matches.

On the revised implementation, 10,000 inserts and 500 queries measured:

| Measurement | Result |
|---|---:|
| writes | 2,218.94 records/s |
| mean query | 48.05 ms |
| top-5 synthetic recall | 100% |
| matrix bytes | 20,480,000 |
| total temporary project bytes | 23,495,916 |

Compared with the previous published 10,000×500 run, mean query time improved from
72.40 ms to 48.05 ms (**-33.6%**). Writes decreased from 3,100.10/s to 2,218.94/s
(**-28.4%**) because records now retain source-deduplication and search terms. This is
an explicit trade-off, not a universal improvement; agent workflows write only a few
records per stage, while retrieval occurs on every specialist turn.

## Tests and live cutover

- 23/23 complete Node tests passed, including the pre-existing ChatGPT import tests;
- FastMCP exposed 6/6 tools and rejected path traversal;
- live profile changed from 4,096 to 6,144 MiB helper cap;
- live host conversation cache changed from 8,192 to 12,288 MiB;
- Qwen canary returned `OK` after transactional restart;
- ASR PID `8808` and TTS PID `16296` were unchanged across the cutover;
- first live architect run created `stratinfer--architect.bin`, 248,816,800 bytes;
- second live architect run reported `restored: true`;
- FastMCP remained ready with six tools.

The active profile backup is
`E:\Data\JarvisMarc\StratInferRuntime\51f355f\profile.json.multi-agent-20261110T194908.bak`.

## Remaining gates

- run an uninterrupted 24-hour eight-role coding workload;
- physically pressure helper VRAM with two approximately 128K snapshots;
- physically pressure the 64 GiB SSD quota and verify LRU plus the 32 GiB free floor;
- measure quality improvement against the former five-role pipeline on the same tasks;
- confirm that repeated revision cycles converge rather than merely increase token cost;
- keep write-capable repository tools disabled until an explicit approval and rollback
  policy is implemented.
