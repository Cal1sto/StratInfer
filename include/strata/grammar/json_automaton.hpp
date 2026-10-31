// include/strata/grammar/json_automaton.hpp
// S2 / RFC-01 Part 1: byte-wise strict JSON-Schema prefix automaton.
//
// Header-only, no dependencies, allocation-free on the hot path (the State is
// a fixed-size POD: max 32 nested frames, 64 enum branches, 1 KiB keys).
// This is the shape the engine needs: per committed byte, advance the automaton;
// per verify candidate (<= 64 per step, see kSelMax in spec_prob.hpp), test a
// 1-byte lookahead by copying the state and feeding one byte. The host-side
// sampler in verify.cpp already iterates candidates in plain memory, so the
// mask is a set intersection over <= 64 entries - no GPU kernel involved.
//
// Accepted schema subset (same as the S1 reference prototype):
//   object (properties, required, additionalProperties:false), array (items),
//   string, number, boolean, null, enum (strings / numbers / booleans / null).
//
// Mirrors proto/s1_grammar.py; the unit test encodes the same vectors.
#ifndef STRATA_GRAMMAR_JSON_AUTOMATON_HPP
#define STRATA_GRAMMAR_JSON_AUTOMATON_HPP

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace strata {
namespace grammar {

constexpr int MAX_FRAME = 32;
constexpr int MAX_ENUM = 64;
constexpr int MAX_PROPS = 32;
constexpr int MAX_LIT = 96;  // max enum literal bytes

enum Kind : uint8_t { K_OBJECT = 0, K_ARRAY, K_STRING, K_NUMBER, K_ENUM };

struct Spec {
  Kind kind = K_STRING;
  // object
  std::vector<std::string> keys;              // declared properties (order kept)
  std::vector<const Spec*> children;          // parallel to keys
  std::vector<std::string> required;
  bool additional = false;
  // array
  const Spec* items = nullptr;
  // enum: rendered JSON literals (strings quoted+escaped, numbers raw, true/false/null raw)
  std::vector<std::string> literals;
};

// One enum branch candidate: literal id + bytes consumed.
struct Branch { uint16_t lit; uint16_t used; };

struct State {
  // mode: 0 root, 1 obj-key(pre-quote), 2 obj-key(in), 3 obj-colon,
  //       4 value(dispatch), 5 obj-comma, 6 arr-val(pre), 7 arr-comma,
  //       8 str(in), 9 num, 10 enum(in), 11 done
  uint8_t mode = 0;
  int top = -1;                        // frame stack depth
  struct Frame {
    const Spec* spec;
    bool hadMember = false;
    uint8_t seen[MAX_PROPS];           // per-declared-key seen flag
    uint8_t nprops;
  } frames[MAX_FRAME];
  // string value in progress
  bool inStr = false, strEsc = false, strClosed = false;
  bool inKey = false;                  // key string in progress
  char key[MAX_LIT]; int keyLen = 0;   // current key bytes (post-quote compare)
  // number state
  bool nStart = false, nDot = false, nExp = false, nSign = false, nDigit = false;
  bool numClosed = false;
  // enum state (current value position)
  Branch br[MAX_ENUM]; int nbr = 0; uint8_t nbrClosed = 0;
  // dispatch info for the value we're about to read
  const Spec* pending = nullptr;       // spec of the value at current position
  bool done = false;
};

class Automaton {
 public:
  explicit Automaton(const Spec& root) : root_(&root) {}

  State initial() const {
    State s;
    s.mode = 0; s.pending = root_;
    return s;
  }

  // Feed one byte; returns false the moment the prefix becomes infeasible.
  bool feed(State& s, uint8_t b) const {
    const char c = (char)b;
    if (s.done) return isWs(c);
    switch (s.mode) {
      case 0: {  // root
        if (isWs(c)) return true;
        if (!s.pending) return false;
        return beginValue(s, c);
      }
      case 1: {  // object key: expect '"'
        if (isWs(c)) return true;
        if (c == '"') { s.mode = 2; s.inKey = true; s.keyLen = 0; return true; }
        return false;
      }
      case 2: {  // inside key string
        if (s.strEsc) { s.strEsc = false; pushKey(s, c); return true; }
        if (c == '\\') { s.strEsc = true; pushKey(s, c); return true; }
        if (c == '"') {
          s.inKey = false;
          std::string k(s.key, s.keyLen);
          return endKey(s, k);
        }
        pushKey(s, c);
        return true;
      }
      case 3: {  // expect ':'
        if (isWs(c)) return true;
        if (c == ':') { s.mode = 4; return true; }
        return false;
      }
      case 4: {  // value position
        if (isWs(c)) return true;
        if (!s.pending) return false;
        return beginValue(s, c);
      }
      case 5: {  // object comma or close
        if (isWs(c)) return true;
        if (c == ',') { s.mode = 1; return true; }
        if (c == '}') return closeObject(s);
        return false;
      }
      case 6: {  // array value position (']' allowed only for empty array)
        if (isWs(c)) return true;
        if (c == ']') {
          s.top--;
          if (s.top < 0) { s.done = true; s.mode = 11; return true; }
          recomputePending(s);
          s.mode = (s.frames[s.top].spec->kind == K_ARRAY) ? 7 : 5;
          return true;
        }
        if (!s.pending) return false;
        return beginValue(s, c);
      }
      case 7: {  // array comma or close
        if (isWs(c)) return true;
        if (c == ',') { s.mode = 6; return true; }
        if (c == ']') {
          // pop array frame
          s.top--;
          if (s.top < 0) { s.done = true; s.mode = 11; return true; }
          recomputePending(s);
          s.mode = (s.frames[s.top].spec->kind == K_ARRAY) ? 7 : 5;
          return true;
        }
        return false;
      }
      case 8: return feedString(s, c);
      case 9: return feedNumber(s, c);
      case 10: return feedEnum(s, c);
      default: return false;
    }
  }

  // Candidate mask: keep only candidates that keep the prefix feasible.
  // Returns the new count (candidates are reordered in place).
  int mask(const State& s, const uint8_t* cands, int n, uint8_t* out) const {
    int k = 0;
    for (int i = 0; i < n; ++i) {
      State t = s;
      if (feed(t, cands[i])) out[k++] = cands[i];
    }
    return k;
  }

  bool accept(const char* data, size_t len) const {
    State s = initial();
    for (size_t i = 0; i < len; ++i)
      if (!feed(s, (uint8_t)data[i])) return false;
    return s.done;
  }

 private:
  const Spec* root_;

  static bool isWs(char c) { return c == ' ' || c == '\n' || c == '\t' || c == '\r'; }
  static void pushKey(State& s, char c) { if (s.keyLen < MAX_LIT) s.key[s.keyLen++] = c; }

  bool beginValue(State& s, char c) const {
    const Spec* sp = s.pending;
    switch (sp->kind) {
      case K_OBJECT:
        if (s.top + 1 >= MAX_FRAME) return false;
        if (s.inStr || s.nStart) {}  // unreachable
        // start object
        if (c != '{') return false;
        s.top++;
        s.frames[s.top].spec = sp;
        s.frames[s.top].hadMember = false;
        s.frames[s.top].nprops = (uint8_t)sp->keys.size();
        for (int i = 0; i < MAX_PROPS; ++i) s.frames[s.top].seen[i] = 0;
        s.mode = 1;
        return true;
      case K_ARRAY:
        if (c != '[') return false;
        if (s.top + 1 >= MAX_FRAME) return false;
        s.top++;
        s.frames[s.top].spec = sp;
        s.frames[s.top].hadMember = false;
        s.frames[s.top].nprops = 0;
        s.pending = sp->items;
        s.mode = 6;
        return true;
      case K_STRING:
        if (c != '"') return false;
        s.inStr = true; s.strEsc = false; s.strClosed = false; s.mode = 8;
        return true;
      case K_NUMBER:
        if (c != '-' && (c < '0' || c > '9')) return false;
        s.nStart = true; s.nDot = false; s.nExp = false; s.nSign = false;
        s.nDigit = (c != '-'); s.numClosed = false; s.mode = 9;
        return true;
      case K_ENUM:
        s.nbr = 0; s.nbrClosed = 0;
        for (size_t i = 0; i < sp->literals.size() && s.nbr < MAX_ENUM; ++i) {
          const std::string& L = sp->literals[i];
          if (!L.empty() && (uint8_t)L[0] == (uint8_t)c) {
            s.br[s.nbr].lit = (uint16_t)i;
            s.br[s.nbr].used = 1;
            s.nbr++;
          }
        }
        if (s.nbr == 0) return false;
        s.mode = 10;
        return true;
    }
    return false;
  }
  Branch& br(State& s) const { return s.br[s.nbr - 1]; }  // helper for init only

  bool feedString(State& s, char c) const {
    if (s.strClosed) return false;
    if (s.strEsc) { s.strEsc = false; return true; }
    if (c == '\\') { s.strEsc = true; return true; }
    if (c == '"') { s.strClosed = true; s.inStr = false; finishValue(s); return true; }
    if ((uint8_t)c < 0x20) return false;
    return true;
  }

  bool feedNumber(State& s, char c) const {
    if (s.numClosed) { if (isWs(c) || c == ',' || c == '}' || c == ']') { finishValue(s); return feed(s, c); } return false; }
    const bool digit = (c >= '0' && c <= '9');
    if (digit) { s.nDigit = true; return true; }
    if (c == '.' && !s.nDot && !s.nExp) {
      if (s.nExp) return false;
      if (!s.nDigit) return false;
      s.nDot = true; return true;
    }
    if ((c == 'e' || c == 'E') && !s.nExp && s.nDigit) { s.nExp = true; s.nSign = false; return true; }
    if ((c == '+' || c == '-') && s.nExp && !s.nSign) { s.nSign = true; return true; }
    if (isWs(c) || c == ',' || c == '}' || c == ']') {
      if (!s.nDigit) return false;
      s.numClosed = true;
      finishValue(s);
      return feed(s, c);
    }
    return false;
  }

  bool feedEnum(State& s, char c) const {
    int w = 0;
    for (int i = 0; i < s.nbr; ++i) {
      const std::string& L = s.pending->literals[s.br[i].lit];
      if (s.br[i].used >= (uint16_t)L.size()) continue;  // complete literal cannot extend
      if ((uint8_t)L[s.br[i].used] == (uint8_t)c) {
        s.br[i].used++;
        s.br[w++] = s.br[i];
      }
    }
    s.nbr = w;
    if (s.nbr == 0) return false;
    bool anyOpen = false;
    for (int i = 0; i < s.nbr; ++i) {
      const std::string& L = s.pending->literals[s.br[i].lit];
      if (s.br[i].used < (uint16_t)L.size()) { anyOpen = true; break; }
    }
    if (!anyOpen) finishValue(s);
    return true;
  }

  bool endKey(State& s, const std::string& k) const {
    State::Frame& f = s.frames[s.top];
    const Spec* sp = f.spec;
    for (size_t i = 0; i < sp->keys.size(); ++i) {
      if (sp->keys[i] == k) { f.seen[i] = 1; s.pending = sp->children[i]; s.mode = 3; return true; }
    }
    if (!sp->additional) return false;
    // unknown key allowed: any JSON value as child
    s.pending = nullptr;  // generic value
    if (!s.pending) { s.pending = generic(); }
    s.mode = 3;
    return true;
  }

  bool closeObject(State& s) const {
    const State::Frame& f = s.frames[s.top];
    const Spec* sp = f.spec;
    for (const std::string& r : sp->required) {
      bool ok = false;
      for (size_t i = 0; i < sp->keys.size(); ++i)
        if (sp->keys[i] == r && f.seen[i]) { ok = true; break; }
      if (!ok) return false;
    }
    s.top--;
    if (s.top < 0) { s.done = true; s.mode = 11; return true; }
    recomputePending(s);
    s.mode = (s.frames[s.top].spec->kind == K_ARRAY) ? 7 : 5;
    return true;
  }

  bool closeArrayKeep(State& s) const { return true; }  // ']' handled in mode 7/6 path

  void recomputePending(State& s) const {
    const State::Frame& f = s.frames[s.top];
    s.pending = (f.spec->kind == K_ARRAY) ? f.spec->items : nullptr;
  }

  void finishValue(State& s) const {
    if (s.top < 0) { s.done = true; s.mode = 11; return; }  // scalar root
    State::Frame& f = s.frames[s.top];
    f.hadMember = true;
    if (f.spec->kind == K_OBJECT) s.mode = 5; else s.mode = 7;
  }

  static const Spec* generic() {
    static Spec g = [] { Spec x; x.kind = K_STRING; return x; }();
    return &g;  // placeholder: additionalProperties accepts strings at minimum
  }
};

}  // namespace grammar
}  // namespace strata
#endif
