# Candidate patches

Each file is one proposed engine-configuration change: the delta, where the idea came from,
the **acceptance criteria written before applying it**, the rollback, and the verdict with
numbers once measured. Nothing here is applied automatically — every candidate requires a
scripted, consented cutover (see `scripts/cutover-template.ps1` and docs/methodology.md).

Verdicts summary (details in RESULTS.md): C2 kept, C3a kept, C1 rejected (+0.6 % vs a
1.8× component claim), C4 rejected (stock default already optimal), C3b not attempted
(interacts with VRAM headroom reserved for other local workloads), C5/C6 pending a
cutover window.
