// include/strata/grammar/schema_loader.hpp
// Minimal strict-JSON reader for the schema subset (type/properties/required/
// additionalProperties/items/enum). Owns nothing at runtime: Specs live in a
// caller-provided vector<Spec> (pointers stable via reserve() contract).
#ifndef STRATA_GRAMMAR_SCHEMA_LOADER_HPP
#define STRATA_GRAMMAR_SCHEMA_LOADER_HPP

#include "json_automaton.hpp"

#include <string>
#include <vector>

namespace strata {
namespace grammar {

class JsonReader {  // strict subset: object/array/string/number/true/false/null
 public:
  struct Node {
    int kind;  // 0 obj, 1 arr, 2 str, 3 num/bool/null raw
    std::string s;                                   // str value or raw literal
    std::vector<std::pair<std::string, Node>> obj;
    std::vector<Node> arr;
    const Node* find(const char* k) const {
      for (auto& kv : obj) if (kv.first == k) return &kv.second;
      return nullptr;
    }
  };
  JsonReader(const char* p, std::string& err) : p_(p), err_(err) {}
  bool parse(Node& out) { skip(); return value(out); }

 private:
  const char* p_;
  std::string& err_;
  void skip() { while (*p_ == ' ' || *p_ == '\n' || *p_ == '\t' || *p_ == '\r') ++p_; }
  bool str(std::string& s) {
    if (*p_ != '"') { err_ = "expected string"; return false; }
    ++p_;
    while (*p_ && *p_ != '"') {
      if (*p_ == '\\') {
        ++p_;
        switch (*p_) {
          case 'n': s += '\n'; break; case 't': s += '\t'; break;
          case 'r': s += '\r'; break; case '"': s += '"'; break;
          case '\\': s += '\\'; break; case '/': s += '/'; break;
          case 'u': {  // \uXXXX -> basic BMP only (4 hex)
            if (p_[1] && p_[2] && p_[3] && p_[4]) {
              auto hx = [](char c) { return (c <= '9') ? c - '0' : (c | 32) - 'a' + 10; };
              unsigned v = (hx(p_[1]) << 12) | (hx(p_[2]) << 8) | (hx(p_[3]) << 4) | hx(p_[4]);
              if (v < 0x80) s += (char)v;
              else if (v < 0x800) { s += (char)(0xC0 | (v >> 6)); s += (char)(0x80 | (v & 63)); }
              else { s += (char)(0xE0 | (v >> 12)); s += (char)(0x80 | ((v >> 6) & 63)); s += (char)(0x80 | (v & 63)); }
              p_ += 5; break;
            }
            [[fallthrough]];
          }
          default: s += *p_;
        }
        ++p_;
      } else s += *p_;
      ++p_;
    }
    if (*p_ != '"') { err_ = "unterminated string"; return false; }
    ++p_;
    return true;
  }
  bool value(Node& n) {
    skip();
    if (*p_ == '{') {
      n.kind = 0; ++p_;
      skip();
      if (*p_ == '}') { ++p_; return true; }
      for (;;) {
        skip();
        std::string k; if (!str(k)) return false;
        skip();
        if (*p_ != ':') { err_ = "expected ':'"; return false; }
        ++p_;
        Node v; if (!value(v)) return false;
        n.obj.emplace_back(k, std::move(v));
        skip();
        if (*p_ == ',') { ++p_; continue; }
        if (*p_ == '}') { ++p_; return true; }
        err_ = "expected ',' or '}'"; return false;
      }
    }
    if (*p_ == '[') {
      n.kind = 1; ++p_;
      skip();
      if (*p_ == ']') { ++p_; return true; }
      for (;;) {
        Node v; if (!value(v)) return false;
        n.arr.push_back(std::move(v));
        skip();
        if (*p_ == ',') { ++p_; continue; }
        if (*p_ == ']') { ++p_; return true; }
        err_ = "expected ',' or ']'"; return false;
      }
    }
    if (*p_ == '"') { n.kind = 2; return str(n.s); }
    if (*p_ == 't' || *p_ == 'f' || *p_ == 'n') {
      n.kind = 3;
      while (*p_ && *p_ != ',' && *p_ != ']' && *p_ != '}' && *p_ != ' ' && *p_ != '\n') n.s += *p_++;
      return true;
    }
    if (*p_ == '-' || (*p_ >= '0' && *p_ <= '9')) {
      n.kind = 3;
      while (*p_ && (*p_ == '-' || *p_ == '+' || *p_ == '.' || (*p_ >= '0' && *p_ <= '9') ||
                     *p_ == 'e' || *p_ == 'E')) n.s += *p_++;
      return true;
    }
    err_ = "unexpected character in JSON";
    return false;
  }
};

inline std::string renderLiteral(const JsonReader::Node& v) {
  if (v.kind == 2) {  // string: quote it and re-escape minimally
    std::string r = "\"";
    for (char c : v.s) { if (c == '"') r += "\\\""; else if (c == '\\') r += "\\\\"; else if ((unsigned char)c < 0x20) r += ' '; else r += c; }
    return r + "\"";
  }
  return v.s;  // number / true / false / null: raw
}

// Compile the schema node into Specs; `store` must be reserved() big enough
// (caller owns lifetimes; one Spec per schema node).
inline bool compileNode(const JsonReader::Node& n, std::vector<Spec>& store, Spec*& self, std::string& err) {
  Spec* sp = nullptr;
  const JsonReader::Node* t = n.find("type");
  const JsonReader::Node* e = n.find("enum");
  if (e && e->kind == 1) {
    sp = &store.emplace_back(); sp->kind = K_ENUM;
    for (auto& v : e->arr) sp->literals.push_back(renderLiteral(v));
    self = sp; return true;
  }
  if (!t || t->kind != 2) { sp = &store.emplace_back(); sp->kind = K_STRING; self = sp; return true; }
  if (t->s == "object") {
    sp = &store.emplace_back(); sp->kind = K_OBJECT;
    const JsonReader::Node* ap = n.find("additionalProperties");
    sp->additional = ap && ap->kind == 3 && ap->s == "true";
    if (const JsonReader::Node* pr = n.find("properties"))
      for (auto& kv : pr->obj) {
        sp->keys.push_back(kv.first);
        Spec* child = nullptr;
        if (!compileNode(kv.second, store, child, err)) return false;
        sp->children.push_back(child);
      }
    if (const JsonReader::Node* rq = n.find("required"))
      for (auto& v : rq->arr) if (v.kind == 2) sp->required.push_back(v.s);
    self = sp; return true;
  }
  if (t->s == "array") {
    sp = &store.emplace_back(); sp->kind = K_ARRAY;
    if (const JsonReader::Node* it = n.find("items")) {
      Spec* child = nullptr;
      if (!compileNode(*it, store, child, err)) return false;
      sp->items = child;
    }
    self = sp; return true;
  }
  if (t->s == "string") { sp = &store.emplace_back(); sp->kind = K_STRING; self = sp; return true; }
  if (t->s == "number" || t->s == "integer") { sp = &store.emplace_back(); sp->kind = K_NUMBER; self = sp; return true; }
  if (t->s == "boolean" || t->s == "null") {  // rendered as a literal enum
    sp = &store.emplace_back(); sp->kind = K_ENUM;
    if (t->s == "boolean") sp->literals = {"true", "false"};
    else sp->literals = {"null"};
    self = sp; return true;
  }
  err = "unsupported schema type: " + t->s;
  return false;
}

inline bool loadSchema(const char* json, std::vector<Spec>& store, Spec*& root, std::string& err) {
  JsonReader r(json, err);
  JsonReader::Node dom;
  if (!r.parse(dom)) return false;
  store.reserve(256);  // pointer stability contract
  return compileNode(dom, store, root, err);
}

}  // namespace grammar
}  // namespace strata
#endif
