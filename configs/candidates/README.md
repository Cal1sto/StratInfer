# Candidate changes

Each JSON file records one proposed change: inspiration, exact delta, acceptance criteria,
rollback, and verdict. Nothing here is applied automatically. Live changes require the
reversible process in `scripts/cutover-template.ps1` and an explicit cutover window.

| Candidate | Status |
|---|---|
| C1 chunked GDN | Rejected: +0.6%, inside noise |
| C2 conversation cache | Kept: parking rejections eliminated |
| C3 `k8v4` | Kept: +8% decode, about -4.2% fresh prefill |
| C3b VRAM reserve | Not attempted |
| C4 speculation depth | Rejected: stock depth 4 won |
| C5 prompt cache spread | Pending |
| C6 host core placement | Pending |
| C7 cache budget 8 GiB | Pending |
| C8 strict grammar mask | Built/tested; live correctness and throughput pending |
| C9 deterministic sampling | Unit-tested; live interleaving gate pending |
| C10 concurrency and replay | Harness ready; live baseline pending |
| C11 RTX 4080 + SSD long-session memory | Offline validated; 24-hour cutover pending |
