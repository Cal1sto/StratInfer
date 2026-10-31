# RFC — grammar-constrained decoding, and why it must live inside the engine

Status: prototype outside the engine proved the semantics; token-level enforcement proved
impossible from the client side. Upstream tracking: Strata issue
[Niko1221/Strata#3758](https://github.com/Niko1221/Strata/issues/3758) (independent author
proposing the same feature; our measured contribution is in that thread — don't duplicate it).

## The gap, in the engine's own words

`serve/structured.py`: *"The native engine has no grammar decoder."* `response_format:
json_schema` today = schema prompting + post-validation: the model may still wander outside
the schema and the request fails; nothing constrains generation token by token. DeepInfer
does have this (regex / JSON schema / EBNF, automata compiled ahead of the request).

## Why the engine is closer than the docstring suggests

Reading the engine source (pinned at `870aedd`, MIT):

1. **Final sampling is host-side** — `run()'s host-side sampling, Philox(seed, pos0 + t)`
   in `src/core/verify.cpp` (~line 5005) — over candidate lists capped at `kSelMax` ≤ 64
   (`include/strata/core/spec_prob.hpp`). A grammar mask there is a set intersection on ≤ 64
   entries: no new GPU kernel, no per-step device traffic.
2. **The mask semantics already exist end to end**: `Verifier::set_logit_bias`
   (`verify.cpp` ~759, propagates across layer split) and `include/strata/core/logit_bias.hpp`
   already defines `-100` as a hard exclusion (its own tests exercise 103k-entry bans).
3. **MTP drafts are a chain, not a tree.** Grammar over a chain reduces to: advance the
   automaton along the draft prefix; the first draft token outside the grammar invalidates
   the verify rows at and after it; the window commits at the divergence and the automaton
   re-syncs on the replacement token.

## Why it cannot be bolted on over HTTP (both walls measured, not theorized)

`proto/s1_grammar.py` implements the exact automaton client-side (JSON-schema prefix
automaton over the model's real 248 320-token vocabulary; 14 selftests; whole-token
byte-level validation):

- **Exhaustive per-step mask**: banned-set = ~248k ids → 3.7 MB payload → **39.1 s per
  generated token**. Semantics correct, economically dead. (The engine's own `logit_bias`
  normalization is fast — ~170 ms cached — but the round trip plus engine-side handling of
  248k biases dominates. In-engine, this cost simply does not exist.)
- **Partial assistant prefill**: the chat template closes the assistant turn, so feeding a
  half-written JSON prefix as a prefill is refused in practice (prefilling `{"ville":` makes
  the model restart from scratch — direct test). There is also no raw-prompt/tokenize
  endpoint on that server. Token-by-token steering from HTTP is structurally unavailable.
- **What does work client-side**: *turn-level lazy rejection* — generate whole, replay the
  automaton, ban the first illegal token's ids (pair-list `logit_bias` form, server-cached),
  regenerate. Battery: 3/3 strictly valid vs 3/6 unconstrained, 0 regenerations needed on
  those prompts. Good enough as an adoption ramp; not a substitute.

## Proposed shape (unchanged from our issue-thread contribution)

- incremental GBNF/JSON-schema prefix automaton in the engine, compiled once per schema
  hash, cached process-wide (DeepInfer compiles ahead of the request — same idea);
- per-request `grammar` on the native protocol, plumbed like `logit_bias`;
  `response_format.grammar` passes through, existing validation kept as a safety net;
- masks computed on the host at the sampler, overlapping GPU verification (the same
  overlap principle as DeepInfer's zero-overhead scheduler).

Acceptance gates we would hold a PR to: 100 % schema-valid over ≥ 10k sampled runs across
~20 schemas (with speculation both on and off); ≥ 95 % of unconstrained decode tok/s;
bit-exactness under the engine's own reproducibility recipe; off by default.

## Adoption caveat, measured honestly

On the study machine, **0 of 3 091 logged requests used `response_format`** — clients went
through native tool calls. The grammar gap is real in the engine and valued in upstream
discourse; locally it produced no time savings because nobody consumed the feature. Ship
the guarantee, then move clients onto it, then re-measure.
