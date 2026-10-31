// include/strata/grammar/json_automaton.hpp
// S2 / RFC-01 Part 1: byte-wise strict JSON-Schema prefix automaton.
//
// Header-only, no dependencies, allocation-free on the hot path (the State is
// fixed-size: max 32 nested frames, 64 enum branches, 32 object properties,
// and 96 decoded bytes per object key).
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
constexpr int MAX_LIT = 96;

enum Kind : uint8_t { K_OBJECT = 0, K_ARRAY, K_STRING, K_NUMBER, K_ENUM };

struct Spec {
  Kind kind = K_STRING;
  std::vector<std::string> keys;
  std::vector<const Spec*> children;
  std::vector<std::string> required;
  bool additional = false;
  const Spec* items = nullptr;
  std::vector<std::string> literals;
};

struct Branch { uint16_t lit; uint16_t used; };

struct State {
  // 0 root, 1 object key, 2 key string, 3 colon, 4 value,
  // 5 object separator, 6 array value, 7 array separator,
  // 8 string, 9 number, 10 enum, 11 done.
  uint8_t mode = 0;
  int top = -1;
  struct Frame {
    const Spec* spec = nullptr;
    bool hadMember = false;
    uint8_t seen[MAX_PROPS] = {};
    uint8_t nprops = 0;
  } frames[MAX_FRAME];

  bool inStr = false;
  bool strEsc = false;
  bool strClosed = false;
  uint8_t unicodeRemain = 0;
  uint16_t unicodeValue = 0;
  bool inKey = false;
  char key[MAX_LIT] = {};
  int keyLen = 0;

  // 0 none, 1 sign, 2 zero, 3 integer, 4 dot, 5 fraction,
  // 6 exponent marker, 7 exponent sign, 8 exponent digits.
  uint8_t numState = 0;

  Branch br[MAX_ENUM] = {};
  int nbr = 0;
  const Spec* pending = nullptr;
  bool done = false;
};

class Automaton {
 public:
  explicit Automaton(const Spec& root) : root_(&root) {}

  State initial() const {
    State s;
    s.pending = root_;
    return s;
  }

  bool feed(State& s, uint8_t b) const {
    const char c = (char)b;
    if (s.done) return isWs(c);
    switch (s.mode) {
      case 0:
        if (isWs(c)) return true;
        return s.pending && beginValue(s, c);
      case 1:
        if (isWs(c)) return true;
        if (c == '}' && !s.frames[s.top].hadMember) return closeObject(s);
        if (c == '"') {
          if (!hasUnseenKey(s)) return false;
          s.mode = 2; s.inKey = true; s.keyLen = 0;
          s.strEsc = false; s.unicodeRemain = 0; s.unicodeValue = 0;
          return true;
        }
        return false;
      case 2:
        return feedKey(s, c);
      case 3:
        if (isWs(c)) return true;
        if (c == ':') { s.mode = 4; return true; }
        return false;
      case 4:
        if (isWs(c)) return true;
        return s.pending && beginValue(s, c);
      case 5:
        if (isWs(c)) return true;
        if (c == ',' && hasUnseenKey(s)) { s.mode = 1; return true; }
        if (c == '}') return closeObject(s);
        return false;
      case 6:
        if (isWs(c)) return true;
        if (c == ']' && !s.frames[s.top].hadMember) return closeArray(s);
        return s.pending && beginValue(s, c);
      case 7:
        if (isWs(c)) return true;
        if (c == ',') { s.mode = 6; return true; }
        if (c == ']') return closeArray(s);
        return false;
      case 8:
        return feedString(s, c);
      case 9:
        return feedNumber(s, c);
      case 10:
        return feedEnum(s, c);
      default:
        return false;
    }
  }

  int mask(const State& s, const uint8_t* cands, int n, uint8_t* out) const {
    int kept = 0;
    for (int i = 0; i < n; ++i) {
      State probe = s;
      if (feed(probe, cands[i])) out[kept++] = cands[i];
    }
    return kept;
  }

  bool accept(const char* data, size_t len) const {
    State s = initial();
    for (size_t i = 0; i < len; ++i)
      if (!feed(s, (uint8_t)data[i])) return false;
    if (s.mode == 9 && numberComplete(s)) finishValue(s);
    if (s.mode == 10 && enumComplete(s)) finishValue(s);
    return s.done;
  }

 private:
  const Spec* root_;

  static bool isWs(char c) { return c == ' ' || c == '\n' || c == '\t' || c == '\r'; }
  static bool isDelimiter(char c) { return isWs(c) || c == ',' || c == '}' || c == ']'; }

  static int hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  }

  static int escaped(char c) {
    switch (c) {
      case '"': return '"'; case '\\': return '\\'; case '/': return '/';
      case 'b': return '\b'; case 'f': return '\f'; case 'n': return '\n';
      case 'r': return '\r'; case 't': return '\t'; default: return -1;
    }
  }

  static bool pushKey(State& s, char c) {
    if (s.keyLen >= MAX_LIT) return false;
    s.key[s.keyLen++] = c;
    return true;
  }

  static bool pushUtf8Key(State& s, uint16_t cp) {
    if (cp < 0x80) return pushKey(s, (char)cp);
    if (cp < 0x800)
      return pushKey(s, (char)(0xC0 | (cp >> 6))) && pushKey(s, (char)(0x80 | (cp & 63)));
    return pushKey(s, (char)(0xE0 | (cp >> 12))) &&
           pushKey(s, (char)(0x80 | ((cp >> 6) & 63))) && pushKey(s, (char)(0x80 | (cp & 63)));
  }

  bool keyPrefixAllowed(const State& s) const {
    const State::Frame& frame = s.frames[s.top];
    const Spec* sp = frame.spec;
    for (size_t index = 0; index < sp->keys.size(); ++index) {
      const std::string& key = sp->keys[index];
      if (!frame.seen[index] && key.size() >= (size_t)s.keyLen &&
          std::memcmp(key.data(), s.key, (size_t)s.keyLen) == 0) return true;
    }
    return false;
  }

  static bool hasUnseenKey(const State& s) {
    const State::Frame& frame = s.frames[s.top];
    for (int index = 0; index < frame.nprops; ++index)
      if (!frame.seen[index]) return true;
    return false;
  }

  bool keyCanExtend(const State& s) const {
    const State::Frame& frame = s.frames[s.top];
    const Spec* sp = frame.spec;
    for (size_t index = 0; index < sp->keys.size(); ++index) {
      const std::string& key = sp->keys[index];
      if (!frame.seen[index] && key.size() > (size_t)s.keyLen &&
          std::memcmp(key.data(), s.key, (size_t)s.keyLen) == 0) return true;
    }
    return false;
  }

  static bool nextKeyCodepoint(const std::string& key, size_t offset, uint16_t& codepoint) {
    if (offset >= key.size()) return false;
    const uint8_t first = (uint8_t)key[offset];
    if (first < 0x80) { codepoint = first; return true; }
    if ((first & 0xE0) == 0xC0 && offset + 1 < key.size()) {
      const uint8_t second = (uint8_t)key[offset + 1];
      if ((second & 0xC0) != 0x80) return false;
      codepoint = (uint16_t)(((first & 0x1F) << 6) | (second & 0x3F));
      return true;
    }
    if ((first & 0xF0) == 0xE0 && offset + 2 < key.size()) {
      const uint8_t second = (uint8_t)key[offset + 1];
      const uint8_t third = (uint8_t)key[offset + 2];
      if ((second & 0xC0) != 0x80 || (third & 0xC0) != 0x80) return false;
      codepoint = (uint16_t)(((first & 0x0F) << 12) | ((second & 0x3F) << 6) | (third & 0x3F));
      return true;
    }
    return false;
  }

  bool unicodePrefixAllowed(const State& s) const {
    const State::Frame& frame = s.frames[s.top];
    const Spec* sp = frame.spec;
    for (size_t index = 0; index < sp->keys.size(); ++index) {
      const std::string& key = sp->keys[index];
      if (frame.seen[index] || key.size() <= (size_t)s.keyLen ||
          std::memcmp(key.data(), s.key, (size_t)s.keyLen) != 0) continue;
      uint16_t codepoint = 0;
      if (nextKeyCodepoint(key, (size_t)s.keyLen, codepoint) &&
          (codepoint >> (s.unicodeRemain * 4)) == s.unicodeValue) return true;
    }
    return false;
  }

  bool feedKey(State& s, char c) const {
    if (s.unicodeRemain) {
      const int h = hex(c);
      if (h < 0) return false;
      s.unicodeValue = (uint16_t)((s.unicodeValue << 4) | h);
      --s.unicodeRemain;
      if (s.unicodeRemain != 0) return unicodePrefixAllowed(s);
      return pushUtf8Key(s, s.unicodeValue) && keyPrefixAllowed(s);
    }
    if (s.strEsc) {
      s.strEsc = false;
      if (c == 'u') { s.unicodeRemain = 4; s.unicodeValue = 0; return true; }
      const int decoded = escaped(c);
      return decoded >= 0 && pushKey(s, (char)decoded) && keyPrefixAllowed(s);
    }
    if (c == '\\') {
      if (!keyCanExtend(s)) return false;
      s.strEsc = true;
      return true;
    }
    if (c == '"') {
      s.inKey = false;
      return endKey(s, std::string(s.key, s.keyLen));
    }
    if ((uint8_t)c < 0x20) return false;
    return pushKey(s, c) && keyPrefixAllowed(s);
  }

  bool beginValue(State& s, char c) const {
    const Spec* sp = s.pending;
    switch (sp->kind) {
      case K_OBJECT:
        if (c != '{' || s.top + 1 >= MAX_FRAME || sp->keys.size() > MAX_PROPS ||
            sp->children.size() != sp->keys.size()) return false;
        ++s.top;
        s.frames[s.top].spec = sp;
        s.frames[s.top].hadMember = false;
        s.frames[s.top].nprops = (uint8_t)sp->keys.size();
        std::memset(s.frames[s.top].seen, 0, sizeof s.frames[s.top].seen);
        s.mode = 1;
        return true;
      case K_ARRAY:
        if (c != '[' || s.top + 1 >= MAX_FRAME || sp->items == nullptr) return false;
        ++s.top;
        s.frames[s.top].spec = sp;
        s.frames[s.top].hadMember = false;
        s.frames[s.top].nprops = 0;
        s.pending = sp->items;
        s.mode = 6;
        return true;
      case K_STRING:
        if (c != '"') return false;
        s.inStr = true; s.strEsc = false; s.strClosed = false;
        s.unicodeRemain = 0; s.unicodeValue = 0; s.mode = 8;
        return true;
      case K_NUMBER:
        if (c != '-' && (c < '0' || c > '9')) return false;
        s.numState = c == '-' ? 1 : (c == '0' ? 2 : 3);
        s.mode = 9;
        return true;
      case K_ENUM:
        if (sp->literals.empty() || sp->literals.size() > MAX_ENUM) return false;
        s.nbr = 0;
        for (size_t i = 0; i < sp->literals.size(); ++i) {
          const std::string& literal = sp->literals[i];
          if (literal.empty() || literal.size() > UINT16_MAX) return false;
          if ((uint8_t)literal[0] == (uint8_t)c)
            s.br[s.nbr++] = {(uint16_t)i, 1};
        }
        if (s.nbr == 0) return false;
        s.mode = 10;
        if (!enumOpen(s)) finishValue(s);
        return true;
    }
    return false;
  }

  bool feedString(State& s, char c) const {
    if (s.strClosed) return false;
    if (s.unicodeRemain) {
      const int h = hex(c);
      if (h < 0) return false;
      s.unicodeValue = (uint16_t)((s.unicodeValue << 4) | h);
      --s.unicodeRemain;
      return true;
    }
    if (s.strEsc) {
      s.strEsc = false;
      if (c == 'u') { s.unicodeRemain = 4; s.unicodeValue = 0; return true; }
      return escaped(c) >= 0;
    }
    if (c == '\\') { s.strEsc = true; return true; }
    if (c == '"') { s.strClosed = true; s.inStr = false; finishValue(s); return true; }
    return (uint8_t)c >= 0x20;
  }

  bool feedNumber(State& s, char c) const {
    const bool digit = c >= '0' && c <= '9';
    switch (s.numState) {
      case 1: if (digit) { s.numState = c == '0' ? 2 : 3; return true; } return false;
      case 2:
        if (c == '.') { s.numState = 4; return true; }
        if (c == 'e' || c == 'E') { s.numState = 6; return true; }
        break;
      case 3:
        if (digit) return true;
        if (c == '.') { s.numState = 4; return true; }
        if (c == 'e' || c == 'E') { s.numState = 6; return true; }
        break;
      case 4: if (digit) { s.numState = 5; return true; } return false;
      case 5:
        if (digit) return true;
        if (c == 'e' || c == 'E') { s.numState = 6; return true; }
        break;
      case 6:
        if (c == '+' || c == '-') { s.numState = 7; return true; }
        if (digit) { s.numState = 8; return true; }
        return false;
      case 7: if (digit) { s.numState = 8; return true; } return false;
      case 8: if (digit) return true; break;
      default: return false;
    }
    if (!isDelimiter(c) || !numberComplete(s)) return false;
    finishValue(s);
    return feed(s, (uint8_t)c);
  }

  bool feedEnum(State& s, char c) const {
    if (isDelimiter(c) && enumComplete(s)) {
      finishValue(s);
      return feed(s, (uint8_t)c);
    }
    int kept = 0;
    for (int i = 0; i < s.nbr; ++i) {
      const std::string& literal = s.pending->literals[s.br[i].lit];
      if (s.br[i].used < literal.size() && (uint8_t)literal[s.br[i].used] == (uint8_t)c) {
        ++s.br[i].used;
        s.br[kept++] = s.br[i];
      }
    }
    s.nbr = kept;
    if (s.nbr == 0) return false;
    if (!enumOpen(s)) finishValue(s);
    return true;
  }

  bool enumOpen(const State& s) const {
    for (int i = 0; i < s.nbr; ++i)
      if (s.br[i].used < s.pending->literals[s.br[i].lit].size()) return true;
    return false;
  }

  bool enumComplete(const State& s) const {
    for (int i = 0; i < s.nbr; ++i)
      if (s.br[i].used == s.pending->literals[s.br[i].lit].size()) return true;
    return false;
  }

  static bool numberComplete(const State& s) {
    return s.numState == 2 || s.numState == 3 || s.numState == 5 || s.numState == 8;
  }

  bool endKey(State& s, const std::string& key) const {
    State::Frame& frame = s.frames[s.top];
    const Spec* sp = frame.spec;
    for (size_t i = 0; i < sp->keys.size(); ++i) {
      if (sp->keys[i] != key) continue;
      if (frame.seen[i]) return false;
      frame.seen[i] = 1;
      s.pending = sp->children[i];
      s.mode = 3;
      return true;
    }
    return false;
  }

  bool closeObject(State& s) const {
    const State::Frame& frame = s.frames[s.top];
    const Spec* sp = frame.spec;
    for (const std::string& required : sp->required) {
      bool seen = false;
      for (size_t i = 0; i < sp->keys.size(); ++i)
        if (sp->keys[i] == required && frame.seen[i]) { seen = true; break; }
      if (!seen) return false;
    }
    return closeContainer(s);
  }

  bool closeArray(State& s) const { return closeContainer(s); }

  bool closeContainer(State& s) const {
    --s.top;
    if (s.top < 0) { s.done = true; s.mode = 11; return true; }
    s.frames[s.top].hadMember = true;
    recomputePending(s);
    s.mode = s.frames[s.top].spec->kind == K_ARRAY ? 7 : 5;
    return true;
  }

  void recomputePending(State& s) const {
    const State::Frame& frame = s.frames[s.top];
    s.pending = frame.spec->kind == K_ARRAY ? frame.spec->items : nullptr;
  }

  void finishValue(State& s) const {
    if (s.top < 0) { s.done = true; s.mode = 11; return; }
    State::Frame& frame = s.frames[s.top];
    frame.hadMember = true;
    s.mode = frame.spec->kind == K_OBJECT ? 5 : 7;
  }
};

}  // namespace grammar
}  // namespace strata
#endif
