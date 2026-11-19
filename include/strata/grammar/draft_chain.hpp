// include/strata/grammar/draft_chain.hpp
// S2 draft-chain rule on top of json_automaton.hpp: apply the schema automaton
// along a verify window's draft tokens, truncate the accepted prefix at the
// first grammar-invalid draft, and mask the replacement draw.
//
// This is host-side code by design: the verifier's accepted-prefix loop
// (`while (a < T-1 && window[a+1] == out[a]) ++a` in Verifier::pl_finish) runs
// on the host after out[] is copied, and the per-row candidate list the sampler
// drew from holds at most kSelMax (64) entries. The grammar decision is a
// byte-prefix test over <= 64 entries per row. The separate full-vocabulary
// state mask is packed and expanded by grammar_mask.cu.
//
// Engine contract (see s2-integration.patch):
//   - tokens: window's draft token ids (row t proposes token for pos0+t+1)
//   - bytes(t): detokenized UTF-8 bytes of token t (engine detok table)
//   - each sampled output row is checked against its actual preceding prefix
//   - a stale invalid row is re-sampled by Verifier from the unchanged target
//     logits after the full-vocabulary mask advances to that prefix.
#ifndef STRATA_GRAMMAR_DRAFT_CHAIN_HPP
#define STRATA_GRAMMAR_DRAFT_CHAIN_HPP

#include "json_automaton.hpp"

#include <cstdint>
#include <vector>

namespace strata {
namespace grammar {

class DraftChain {
 public:
  explicit DraftChain(const Spec& root) : A_(root), st_(A_.initial()) {}

  void reset() {
    st_ = A_.initial();
    snapshot_ = st_;
    lastBytes_.clear();
    lastKeep_ = 0;
  }

  void beginWindow() {
    snapshot_ = st_;
    lastBytes_.clear();
    lastKeep_ = 0;
  }

  bool appendWindowToken(const char* bytes) {
    State probe = st_;
    if (bytes == nullptr || !feedAll(probe, bytes)) return false;
    st_ = probe;
    lastBytes_.emplace_back(bytes);
    ++lastKeep_;
    return true;
  }

  // Commit tokens whose bytes all kept the automaton feasible. Stops at the
  // first token that would make the JSON prefix infeasible; that token and all
  // later rows of the window are invalid and must not be committed.
  // Returns how many leading tokens of `tok` are committed (prefix is fed).
  // The advance is PROVISIONAL: the engine may still cut the window earlier on
  // an ordinary speculation miss; call confirm(k) from pl_commit_async with the
  // number of rows actually committed to reconcile the automaton state.
  int commitWindow(const std::vector<const char*>& tokBytes) {
    beginWindow();
    for (const char* bytes : tokBytes)
      if (!appendWindowToken(bytes)) break;
    return lastKeep_;
  }

  // Reconcile with the engine's real commit count for the last window.
  // Returns false instead of feeding a row the grammar already rejected.
  bool confirm(int k) {
    if (k < 0 || k > lastKeep_) return false;
    st_ = snapshot_;
    for (int i = 0; i < k; ++i)
      if (!feedAll(st_, lastBytes_[i].c_str())) { st_ = snapshot_; return false; }
    return true;
  }

  // True if `bytes` keeps the current prefix feasible (vocab filter for the
  // logit_bias mask: O(vocabulary) once per automaton state class).
  bool feasible(const char* bytes) const {
    State s = st_;
    return feedAll(s, bytes);
  }

  // Mask a replacement candidate list (detok bytes) against the current state;
  // returns indices of feasible candidates, in order.
  std::vector<int> mask(const std::vector<const char*>& tokBytes) const {
    std::vector<int> keep;
    for (size_t i = 0; i < tokBytes.size(); ++i) {
      State probe = st_;
      if (feedAll(probe, tokBytes[i])) keep.push_back((int)i);
    }
    return keep;
  }

  // Deterministic reference redraw used by the standalone tests. The engine
  // path uses Strata's native sampler and its position-keyed Philox draw.
  int redraw(uint64_t pos, const std::vector<int>& allowed, uint64_t seed) const {
    if (allowed.empty()) return -1;  // schema unsatisfiable at this point: caller must abort the turn
    const uint64_t scaled = (uint64_t)philoxWord(seed, pos | (1ull << 60)) * allowed.size();
    return allowed[(size_t)(scaled >> 32)];
  }

  bool done() const { return st_.done; }
  State& state() { return st_; }
  const State& state() const { return st_; }

 private:
  static uint32_t philoxWord(uint64_t seed, uint64_t counter) {
    uint32_t c0 = (uint32_t)counter, c1 = (uint32_t)(counter >> 32);
    uint32_t c2 = (uint32_t)seed, c3 = (uint32_t)(seed >> 32);
    for (uint32_t round = 0; round < 10; ++round) {
      const uint32_t hi0 = (uint32_t)(((uint64_t)0x9E3779B9u * c0) >> 32);
      const uint32_t hi1 = (uint32_t)(((uint64_t)0xBB67AE85u * c2) >> 32);
      const uint32_t lo0 = 0x9E3779B9u * c0;
      const uint32_t lo1 = 0xBB67AE85u * c2;
      const uint32_t n0 = hi1 ^ c1 ^ round;
      const uint32_t n1 = lo1;
      const uint32_t n2 = hi0 ^ c3;
      const uint32_t n3 = lo0;
      c0 = n0; c1 = n1; c2 = n2; c3 = n3;
    }
    return c0;
  }

  bool feedAll(State& s, const char* bytes) const {
    for (const char* p = bytes; *p; ++p)
      if (!A_.feed(s, (uint8_t)*p)) return false;
    return true;
  }

  Automaton A_;
  State st_;
  State snapshot_;                    // pre-window state for confirm()
  std::vector<std::string> lastBytes_;  // last window's token bytes
  int lastKeep_ = 0;
};

}  // namespace grammar
}  // namespace strata
#endif
