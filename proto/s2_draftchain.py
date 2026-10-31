#!/usr/bin/env python3
"""S2 draft-chain semantics, simulated host-side (no engine changes, no CUDA).

Question: if the host sampler (verify.cpp: Philox host-side sampling over <=64-entry
candidate lists) intersects a grammar mask into the candidate list, what happens to
MTP speculation along the draft CHAIN?

Rule under test (derived from the engine's chain-of-drafts structure, docs/06):
advance the automaton along the draft prefix; the first draft token invalid BY GRAMMAR
invalidates verify rows at and after its position; the window commits the surviving
prefix and draws a replacement from the MASKED candidate list at the surviving state
(legal by construction). In the free arm the same off-grammar token is drawn from the
UNMASKED list and may be committed -> the tour is poisoned (the real battery failure:
3/6 valid in free decode).

Measured anchors (RESULTS.md): window verify cost 35.0 ms at spec4 (RTX 5090); pooled
draft acceptance 0.613; free-decode tour validity 3/6 on the strict-schema battery;
eager HTTP-side mask 39.1 s/token (why this must live in-engine).

Calibration (declared assumption): P_OFF_BRANCH (drafter proposes an off-grammar token
at a structurally-constrained head) is bisected so the FREE arm reproduces the observed
~50% tour validity; P_COMMIT_OFF is the share of off-grammar proposals the target model
also wants (verifier accepts -> violation committed).

Run: python proto/s2_draftchain.py [--runs 2000] [--seed N]
"""
import argparse, os, random, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from s1_grammar import initial_state, clone, feed_byte

# local strict schema (English keys) - same shape as s1_grammar's battery schema
SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "category": {"enum": ["character", "object", "location"]},
        "confidence": {"type": "number"},
        "verified": {"type": "boolean"},
    },
    "required": ["title", "category"],
    "additionalProperties": False,
}

TOUR = b'{"title":"The Silent Star","category":"character","confidence":0.9,"verified":false}'
K_DRAFTS = 4
ACCEPT = 0.613          # measured pooled verifier acceptance (same in both arms)
P_OFF_OTHER = 0.0      # non-branch bytes inside free strings are unconstrained by the schema:
                       # the drafter can't be "off-grammar" there — only branch heads can
P_COMMIT_OFF = 0.6      # share of off proposals the target model also deviates on

def find_branches():
    """Positions where the next byte is structurally constrained: first byte after an
    opening quote of a key/value, and heads of number/bool literals."""
    br = set()
    s = initial_state(SCHEMA)
    for i, b in enumerate(TOUR):
        mode = s["mode"]
        if i > 0 and TOUR[i-1:i] == b'"' and mode == "instr" and not s["buf"]:
            br.add(i)                                   # first char of a key or string value
        if mode == "value":
            br.add(i)                                   # head of enum/number/bool/string value
        s = feed_byte(s, b)
        assert s is not None, f"script invalid at {i}: {TOUR[:i+1]!r}"
    return br

BRANCH = find_branches()

def off_byte(b):
    alt = b ^ 0x20
    if alt == b or alt < 0x20: alt = ord('x')
    return alt

def simulate(rng, grammar, p_off_branch):
    """One full schema tour through verify windows. Faithful to the rule: after a
    grammar-block (or ordinary disagreement), the window COMMITS the accepted run and
    ends - rows at/after the divergence are invalid for this window.
    Returns (valid_tour, windows, committed, blocked_by_grammar)."""
    st = initial_state(SCHEMA)
    i = windows = committed = blocked = 0
    n = len(TOUR)
    while i < n:
        windows += 1
        if windows > 1000: return False, windows, committed, blocked
        ns = clone(st)          # state after the accepted run inside this window
        run = 0                 # tokens accepted from the draft chain
        replacement = None      # masked/free redraw at the divergence
        for j in range(K_DRAFTS):
            pos = i + run
            if pos >= n: break
            intended = TOUR[pos]
            is_branch = pos in BRANCH
            p_off = p_off_branch if is_branch else P_OFF_OTHER
            if rng.random() < p_off:
                # drafter proposes an OFF-GRAMMAR token at pos
                if grammar:
                    blocked += 1
                    ns2 = feed_byte(clone(ns), intended)   # masked replacement: legal by construction
                    assert ns2 is not None
                    replacement = ns2
                    break
                elif rng.random() < P_COMMIT_OFF:
                    # target model deviates too -> verifier accepts -> violation COMMITTED
                    return False, windows, committed + run + 1, blocked
                else:
                    break                                 # disagreement; window ends at run
            if rng.random() < ACCEPT:
                ns2 = feed_byte(clone(ns), intended)
                assert ns2 is not None
                ns = ns2; run += 1
            else:
                break                                     # ordinary speculation miss
        if run > 0:
            st = ns; committed += run; i += run
        if replacement is not None:
            st = replacement; committed += 1; i += 1
        elif run == 0 and i < n:
            # window advanced nothing: head redraw (masked or unmasked)
            intended = TOUR[i]
            if grammar:
                st = feed_byte(st, intended); committed += 1; i += 1
            else:
                is_branch = i in BRANCH
                if rng.random() < (p_off_branch if is_branch else P_OFF_OTHER) \
                   and rng.random() < P_COMMIT_OFF:
                    return False, windows, committed + 1, blocked
                st = feed_byte(st, intended); committed += 1; i += 1
    return True, windows, committed, blocked

def calibrate(target, seed=7, trials=300):
    lo, hi = 0.0, 1.0
    for _ in range(24):
        mid = (lo + hi) / 2
        rng = random.Random(seed)
        ok = sum(simulate(rng, False, mid)[0] for _ in range(trials))
        if ok / trials > target: lo = mid
        else: hi = mid
    return (lo + hi) / 2

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=20261031)
    ap.add_argument("--free-target", type=float, default=3/6)
    a = ap.parse_args()
    p_off = calibrate(a.free_target)
    print(f"calibrated P_OFF_BRANCH={p_off:.3f} -> free validity ~{100*a.free_target:.0f}% (the battery's 3/6)")
    print(f"tour {len(TOUR)} bytes, {len(BRANCH)} branch points, K={K_DRAFTS} drafts/window")

    rng = random.Random(a.seed)
    t0 = time.perf_counter(); fr = [simulate(rng, False, p_off) for _ in range(a.runs)]
    free_us = (time.perf_counter() - t0) / a.runs * 1e6
    ok_f = sum(v for v, *_ in fr)
    t0 = time.perf_counter(); gr = [simulate(rng, True, p_off) for _ in range(a.runs)]
    gram_us = (time.perf_counter() - t0) / a.runs * 1e6
    ok_g = sum(v for v, *_ in gr)

    wf_all = sum(w for _, w, _, _ in fr) / a.runs
    wf = (sum(w for v, w, _, _ in fr if v) / ok_f) if ok_f else float("nan")  # windows per VALID tour
    wg = sum(w for _, w, _, _ in gr) / a.runs
    bg = sum(b for _, _, _, b in gr) / a.runs
    print(f"\nvalidity   free: {ok_f}/{a.runs} ({100*ok_f/a.runs:.1f}%)   grammar: {ok_g}/{a.runs} ({100*ok_g/a.runs:.1f}%)")
    print(f"windows per complete tour  free: {wf:.2f}   grammar: {wg:.2f}   (grammar blocks {bg:.2f} off drafts/tour)")
    print(f"wall per complete tour @35 ms/window: free {wf*35:.0f} ms   grammar {wg*35:.0f} ms "
          f"({100*(wg/wf-1):+.1f}% per attempt)")
    if ok_f and ok_g:
        attempts = a.runs / ok_f          # S1-style regeneration loop: a full retry per poisoned tour
        eff = attempts * wf / wg          # cost of one GUARANTEED-valid output, equal window cost
        print(f"\nturn-level economics (measured S1 loop: poison -> regenerate the tour):")
        print(f"  free: {attempts:.2f} full attempts per valid output x {wf:.1f} windows"
              f"   grammar: 1.00 x {wg:.1f}")
        print(f"  -> effective wall-clock for one guaranteed-valid output: {eff:.2f}x faster with grammar")
    print(f"host mask machinery cost in sim: {gram_us - free_us:+.1f} us/tour "
          f"(set-intersections over <=64-entry lists; no GPU work added)")
    if ok_g != a.runs:
        print("PROPERTY VIOLATED: grammar arm committed an off-schema token"); return 1
    print(f"invariant holds: 0 off-schema tokens committed in {a.runs} grammar-arm tours")
    return 0

if __name__ == "__main__":
    sys.exit(main())
