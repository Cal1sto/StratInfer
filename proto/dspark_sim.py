#!/usr/bin/env python3
"""dspark_sim — confidence-scheduled speculation, offline, calibrated to measured data.

Replays per-request draft-acceptance from an engine log (lines like
'drafts accepted X of Y'), models per-position acceptance as a^(gamma*i) with (gamma,
scale) grid-searched TO REPRODUCE the measured pooled acceptances of a fixed-depth sweep,
then compares fixed-depth throughput against a per-request best-depth policy.

The window-cost curve t(k) MUST pass exactly through measured points: an affine fit
produced a spurious +5.4% in an earlier study; exact interpolation of the convex curve
yields +0.1% on the same data (see docs/rfc-speculative-scheduling.md).

Usage:
  python proto/dspark_sim.py --log engine.log \
      --pools "3:0.683,4:0.613,5:0.566" --costs "3:32.0,4:35.0,5:43.4"

The defaults are the 2026-10-30 measurements (spec 3/4/5 A/B on an RTX 5090, IQ3_S MoE).
"""
import argparse, json, re, sys
from collections import Counter

PAT = re.compile(r"drafts accepted (\d+) of (\d+)")
KS = list(range(2, 8))

def rates(path, min_y=8):
    out = []
    for line in open(path, encoding="utf-8", errors="replace"):
        m = PAT.search(line)
        if m:
            x, y = int(m.group(1)), int(m.group(2))
            if y >= min_y: out.append(x / y)
    return out

def pairs(spec):
    return {int(t.split(":")[0]): float(t.split(":")[1]) for t in spec.split(",")} if spec else {}

def pool_of(rs, gamma, ks):
    res = {}
    for k in ks:
        s = 0.0
        for a in rs:
            p, e = 1.0, 0.0
            for _ in range(k):
                p *= (a ** gamma); e += p
            s += e
        res[k] = s / len(rs) / k
    return res

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True, help="engine log with 'drafts accepted X of Y' lines")
    ap.add_argument("--pools", default="3:0.683,4:0.613,5:0.566", help="measured pooled acceptance per fixed depth, as k:pool")
    ap.add_argument("--costs", default="3:32.0,4:35.0,5:43.4", help="measured window cost in ms per depth, as k:ms")
    ap.add_argument("--out", default="dspark-sim.json")
    a = ap.parse_args()
    measured_pools = pairs(a.pools)
    t_ms = pairs(a.costs)

    # edge extrapolation by adjacent slopes (the curve is convex in the measured range)
    ks_meas = sorted(t_ms)
    slope_lo = (t_ms[ks_meas[0]] - t_ms[ks_meas[1]]) / (ks_meas[1] - ks_meas[0]) if len(ks_meas) > 1 else 0
    slope_hi = (t_ms[ks_meas[-1]] - t_ms[ks_meas[-2]]) / (ks_meas[-1] - ks_meas[-2]) if len(ks_meas) > 1 else 0
    lo, hi = ks_meas[0], ks_meas[-1]
    for k in KS:
        if k not in t_ms:
            t_ms[k] = t_ms[lo] + slope_lo * (k - lo) if k < lo else t_ms[hi] + slope_hi * (k - hi)

    rs = rates(a.log)
    if len(rs) < 20:
        print("too few parseable requests in the log"); return 1
    best = (9e9, 1.0, 1.0, [], {})
    for g10 in range(1, 61):
        gamma = g10 / 10
        for s10 in range(5, 26):
            scale = s10 / 10
            r2 = [x ** scale for x in rs]
            p = pool_of(r2, gamma, measured_pools)
            err = sum(abs(p[k] - measured_pools[k]) for k in measured_pools)
            if err < best[0]:
                best = (err, gamma, scale, r2, p)
    err, gamma, scale, r2, p = best
    print(f"requests: {len(rs)} | calibration gamma={gamma} scale={scale} err_pools={err:.4f}")
    for k in sorted(measured_pools): print(f"  pool({k}): sim {p[k]:.3f} vs measured {measured_pools[k]:.3f}")

    def th(k, x):
        pr, e = 1.0, 0.0
        for _ in range(k):
            pr *= (x ** gamma); e += pr
        return (1 + e) / t_ms[k] * 1000.0

    n = len(r2)
    base = sum(th(4, x) for x in r2) / n
    print("\nk  fixed-throughput(tok/s)  vs_k4")
    for k in KS:
        d = sum(th(k, x) for x in r2) / n
        print(f"{k}   {d:8.1f}      {100*(d/base-1):+5.1f}%")
    dyn = sum(max(th(k, x) for k in KS) for x in r2) / n
    ks = Counter(max(KS, key=lambda k: th(k, x)) for x in r2)
    print(f"\nper-request policy: {dyn:.1f} vs fixed-4 {base:.1f} -> {100*(dyn/base-1):+.1f}%")
    print("chosen k:", dict(sorted(ks.items())))
    json.dump({"n": n, "gamma": gamma, "scale": scale,
               "pool_check": {str(k): round(p[k], 3) for k in measured_pools},
               "fixed": {str(k): round(sum(th(k, x) for x in r2)/n, 1) for k in KS},
               "dynamic": round(dyn, 1),
               "policy_ks": {str(k): v for k, v in sorted(ks.items())}}, open(a.out, "w"))
    print(f"-> {a.out}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
