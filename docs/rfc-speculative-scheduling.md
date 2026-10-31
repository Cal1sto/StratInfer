# RFC-02 — confidence-scheduled speculation: the study, and the refutation

The idea (from DeepInfer's DSpark-style design): speculative draft depth should not be a
constant; each window should spend verification budget where draft acceptance is likely.
We tested it **offline, on real engine data, before touching the engine** — and the naive
form does not pay on this machine. Documented in full because the failure is instructive.

## Measurements that motivated it (C4, live A/B)

| depth (drafts/window) | decode tok/s | pooled acceptance |
|---|---|---|
| spec 4 (stock default) | **98.6** | 0.613 |
| spec 5 | 88.2 (−10.6 %) | 0.566 |
| spec 3 | 95.2 (−3.5 %) | 0.683 |

A fixed depth is clearly load-sensitive — so: pick per-request depth k*(r) = argmax of
expected committed tokens ÷ window cost.

## Simulation (`proto/dspark_sim.py`)

- **Data**: 2 759 real requests from the engine log (`drafts accepted X of Y` per request);
  per-request acceptance rate is the confidence signal (exactly what an in-engine
  scheduler could estimate from the drafter's own probabilities).
- **Acceptance model**: position i accepted with prob a^(gamma·i); gamma + a scale grid-
  searched **under the constraint of reproducing the three measured pools** (0.683 / 0.613 /
  0.566) — achieved within ≤ 0.019 total error.
- **Window cost**: t(k) interpolated *exactly* through the three measured points
  (32.0 / 35.0 / 43.4 ms; convex), with adjacent-slope extrapolation at the edges.

### Result

| policy | decode |
|---|---|
| fixed k=4 (stock) | 98.8 tok/s (sim reproduces the measured C4 curve: k3 −5.0 %, k5 −10.4 %) |
| per-request k*(r) | **+0.1 %** |

k=4 is chosen for 2 376/2 759 requests. With the true cost curve, the stock fixed depth
already sits at the top across the *entire observed acceptance distribution*. The idea is
refuted as stated on this workload.

### The artifact worth remembering

A first version fit the window cost **affinely** (t4 → 37.7 ms instead of measured 35.0).
That invented surcharge at k=4 made the optimizer deviate and reported **+5.4 %** — a
pure modeling artifact. The scheduling gain is more sensitive to cost-curve fidelity than
to the confidence signal. Any serious attempt must reproduce measured fixed-depth
throughputs within noise before trusting its dynamic number.

## What headroom could still exist

Per-request pooled acceptance is a blunt signal. The interesting regime is **per-rank**:
requests whose draft #1 is reliably good but drafts #2+ decay faster than average (and the
reverse). The engine logs only aggregate offered/accepted per request, so this cannot be
measured today. Concrete upstream ask (posted on the engine's tracker): expose a histogram
of accepted prefix lengths per window depth — as cheap as the existing counters. With it,
the simulation can be re-run honestly; without it, depth tuning stays a blind fixed-constant
choice that happens, on this machine, to already be optimal.
