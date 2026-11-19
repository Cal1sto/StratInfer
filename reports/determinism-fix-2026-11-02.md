# Determinism correction — 2 November 2026

## Result

The deterministic failure was reproduced on the original Strata and StratInfer
performance profiles: each produced 12 mismatches across 13 seeded target requests.
The random generator was not the cause. Both engines already use Philox keyed by seed
and token position; repeated first-token distributions were stable.

The divergence came from adaptive expert residency. Strata states that its asynchronous
adaptive tier is not bit-exact, and its runtime reports that the same expert rounds
differently on CPU and GPU. Residency changes therefore alter later logits even when the
sampled random draw is identical.

## Accepted correction

`scripts/make-deterministic-profile.mjs` creates a separate strict profile and leaves the
performance profile untouched. It disables adaptive swaps, asynchronous adaptation,
PCIe balancing, and prompt caching, and selects the deterministic i-quant path. MTP,
speculation, the 4 GiB RTX 4080 parked-K/V cap, and SSD session paths are preserved.

The harness now accepts `--expect-base`, which fails before inference when
`STRATINFER_BASE` points at the wrong engine. It also accepts `--noise-tokens` so the
interleaving gate can stress scheduling without spending most of the run on irrelevant
noise output.

## RTX 5090 evidence

| Profile | Endpoint | Gate | Result |
|---|---|---:|---:|
| Original Strata performance | `11440` | 5 serial + 8 interleaved | 1/13 identical |
| Original StratInfer performance | `11441` | 5 serial + 8 interleaved | 1/13 identical |
| Restored current performance profile | `11441` | 5 serial + 8 interleaved, 128 tokens | 1/13 identical |
| Synchronous adaptive placement | `11441` | 3 serial + 2 interleaved | 4/5 identical |
| Fixed expert placement | `11441` | 5 serial + 8 interleaved | **13/13 identical** |

The accepted fixed-placement gate used seed `424242`, temperature `0.8`, 32 target
tokens, four-way interleaving, and eight noise tokens per unrelated request. Prompt-cache
reuse occurred during the run, so the result covers both cold and reused target prompts.

Raw evidence:

- original comparison: `reports/data/strata-vs-stratinfer-2026-11-01/summary.json`;
- restored-performance recheck: `reports/data/deterministic-sm120/performance-current-extended/determinism-1793618104748.json`;
- accepted gate: `reports/data/deterministic-sm120/fixed-placement-extended/determinism-1793617643217.json`;
- rejected synchronous adaptation: `reports/data/deterministic-sm120/sync-adapt-correct-port/determinism-1793616704290.json`.

## Performance trade-off

Fixed placement decoded this short live workload at 2.1-2.7 tok/s. The restored
performance profile reached 140.0-154.6 tok/s across the retained 128-token metrics,
with a 143.7 tok/s median; the previous full performance battery measured 153.7 tok/s.
This is not a paired
same-length throughput comparison, but it is sufficient to reject strict mode as the
interactive default. A device-wide synchronization experiment was also rejected: it did
not restore the adaptive path's numerical invariants and stayed in the same low-throughput
range.

The operational decision is therefore two profiles:

- performance mode for normal MOAI and long coding sessions;
- strict deterministic mode for exact replay, regression tests, incident reproduction,
  and benchmark correctness gates.

## Corrections to the investigation

Three early exploratory CLI reports accidentally used the default `11440` endpoint
because `STRATA_BASE_URL` was set instead of the supported `STRATINFER_BASE`. They were
discarded and are not included above. The accepted and rejected records listed here all
embed `http://127.0.0.1:11441` in their JSON.
