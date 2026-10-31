// include/strata/grammar/draft_chain.hpp
// S2 draft-chain rule on top of json_automaton.hpp: apply the schema automaton
// along a verify window's draft tokens, truncate the accepted prefix at the
// first grammar-invalid draft, and mask the replacement draw.
//
// This is host-side code by design: the verifier's accepted-prefix loop
// (`while (a < T-1 && window[a+1] == out[a]) ++a` in Verifier::pl_finish) runs
// on the host after out[] is copied, and the per-row candidate list the sampler
// drew from holds at most kSelMax (64) entries. The grammar decision is a
// byte-prefix test over <= 64 entries per row: no new GPU kernel is required.
//
// Engine contract (see s2-integration.patch):
//   - tokens: window's draft token ids (row t proposes token for pos0+t+1)
//   - bytes(t): detokenized UTF-8 bytes of token t (engine detok table)
//   - keep = number of window rows to commit before the first invalid draft
//   - if the row at `keep` (bonus / replacement) is invalid, redraw from the
//     masked candidate list with the dedicated Philox counter space pos|1<<60
//     (disjoint from u_pick/u_accept/u_resid/u_draft; reproducible).
#ifndef STRATA_GRAMMAR_DRAFT_CHAIN_HPP
#define STRATA_GRAMMAR_DRAFT_CHAIN_HPP

#include "json_automaton.hpp"

#include <cstdint>
#include <random>
#include <vector>

namespace strata {
namespace grammar {

class DraftChain {
 public:
  explicit DraftChain(const Spec& root) : A_(root), st_(A_.initial()) {}

  // Commit tokens whose bytes all kept the automaton feasible. Stops at the
  // first token that would make the JSON prefix infeasible; that token and all
  // later rows of the window are invalid and must not be committed.
  // Returns how many leading tokens of `tok` are committed (prefix is fed).
  // The advance is PROVISIONAL: the engine may still cut the window earlier on
  // an ordinary speculation miss; call confirm(k) from pl_commit_async with the
  // number of rows actually committed to reconcile the automaton state.
  int commitWindow(const std::vector<const char*>& tokBytes) {
    snapshot_ = st_;
    lastBytes_.clear();
    for (const char* b : tokBytes) lastBytes_.emplace_back(b);
    int keep = 0;
    for (size_t t = 0; t < tokBytes.size(); ++t) {
      State probe = st_;
      if (!feedAll(probe, tokBytes[t])) break;
      st_ = probe;
      ++keep;
    }
    return keep;
  }

  // Reconcile with the engine's real commit count for the last window.
  void confirm(int k) {
    st_ = snapshot_;
    for (int i = 0; i < k && i < (int)lastBytes_.size(); ++i) feedAll(st_, lastBytes_[i].c_str());
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

  // Deterministic redraw at a row position from the masked candidate set.
  // counter = pos | (1ull<<60): disjoint from the sampler's three streams.
  int redraw(uint64_t pos, const std::vector<int>& allowed, uint64_t seed) const {
    if (allowed.empty()) return -1;  // schema unsatisfiable at this point: caller must abort the turn
    std::mt19937_64 rng(seed ^ (pos | (1ull << 60)));
    return allowed[rng() % allowed.size()];
  }

  bool done() const { return st_.done; }
  State& state() { return st_; }

 private:
  bool feedAll(State& s, const char* bytes) const {
    for (const char* p = bytes; *p; ++p)
      if (!A_.feed(s, (uint8_t)*p)) return false;
    return true;
  }

  Automaton A_;
  State st_;
  State snapshot_;                    // pre-window state for confirm()
  std::vector<std::string> lastBytes_;  // last window's token bytes
};

}  // namespace grammar
}  // namespace strata
#endif
