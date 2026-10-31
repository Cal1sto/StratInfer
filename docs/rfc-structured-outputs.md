# RFC: strict structured output inside Strata

Status: opt-in overlay implemented, compiled, and unit/GPU tested. Live 10,000-sample
correctness and end-to-end throughput gates remain pending.

## Problem

Prompting plus response validation detects invalid JSON only after generation. It does
not prevent an invalid token from being sampled. Client-side exhaustive `logit_bias`
was also measured at 39.1 seconds per generated token for a 248,320-token vocabulary,
so the constraint must execute inside the engine.

DeepInfer demonstrates the product capability with precompiled regex, JSON Schema, and
EBNF automata. StratInfer ports the portable JSON-Schema concept, not DeepInfer's
model-specific kernels.

## Supported contract

`STRATA_GRAMMAR_SCHEMA` points to one schema loaded at process startup. The loader accepts
a bounded subset:

- types: `object`, `array`, `string`, `number`, `boolean`, `null`;
- keywords: `properties`, `required`, `additionalProperties`, `items`, `enum`;
- strict JSON strings, escapes, Unicode escapes, numbers, delimiters, and EOF.

Unsupported keywords or malformed schemas fail closed. The automaton rejects duplicate
keys, missing required keys, trailing commas, malformed numeric forms, invalid escapes,
and tokens that only match an enum prefix.

The GGUF reader derives token bytes from `tokenizer.ggml.tokens` with explicit bounds.
After a complete root value, only configured EOS/EOT IDs are admitted. Other control or
empty tokens are forbidden rather than treated as valid JSON bytes.

## Verifier integration

The verifier owns a `DraftChain` and resets it for every request. For each automaton state:

1. build the allowed-token bitset from the real GGUF token bytes;
2. combine it with the request's existing base bias;
3. upload the packed bitset only when the state signature changes;
4. sample from target logits after forbidden IDs become negative infinity;
5. confirm only the prefix actually committed by speculative verification.

### Stale speculative rows

MTP rows can be sampled before preceding rows establish the final grammar state. Treating
such a row as a sentinel is incorrect because the sentinel could be emitted. The overlay
checks rows sequentially along the actual emitted path. If a later row is invalid under
the advanced state, it refreshes the mask and re-samples that row from the unchanged
target logits using the same position-keyed Philox draw. Rows after the first ordinary
draft mismatch are unused. Commit/rollback then reconciles the automaton exactly.

## RTX 5090 mask kernel

`src/kernels/cuda/grammar_mask.cu` expands a packed allowed-token bitset into the effective
device bias. One thread handles one vocabulary ID, preserves the request's base bias, and
writes negative infinity for forbidden IDs.

For 248,320 tokens on CUDA 13.1, Release, `120-real`:

| isolated operation | measurement |
|---|---:|
| kernel only | 7.337 us per launch |
| pinned 30.3 KiB upload plus kernel | 104.321 us per state change |
| equivalent dense FP32 bias | about 970 KiB |

These are isolated component measurements. They do not establish end-to-end decode speed.

## Safety boundary

The current automaton is process-shared. Grammar mode therefore refuses batch slots,
pipeline windows, and layer split instead of sharing state incorrectly across requests.
Unset `STRATA_GRAMMAR_SCHEMA` leaves the default path unchanged.

Not implemented:

- per-request schema fields and schema-hash cache;
- regex or EBNF parsers;
- independent per-slot automata;
- an end-to-end performance verdict.

## Acceptance gates

Before enabling grammar mode for clients:

1. build both engines and pass all four overlay tests for `120-real`;
2. run at least 10,000 samples over roughly 20 representative schemas;
3. require zero invalid committed outputs with speculation both on and off;
4. require at least 95% of unconstrained decode throughput;
5. verify identical seeded output in serial and interleaved request schedules;
6. perform the test on a separate profile with scripted rollback.

## Future protocol shape

The next safe extension is an immutable automaton per request, backed by a process-wide
cache keyed by schema hash. It can then be plumbed beside request sampling parameters and
used by batch slots independently. Regex and EBNF should remain separate parsers sharing
the same verifier mask interface rather than being advertised before implementation.
