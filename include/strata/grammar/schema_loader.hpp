// include/strata/grammar/schema_loader.hpp
// Strict JSON reader and compiler for StratInfer's documented schema subset.
#ifndef STRATA_GRAMMAR_SCHEMA_LOADER_HPP
#define STRATA_GRAMMAR_SCHEMA_LOADER_HPP

#include "json_automaton.hpp"

#include <cstring>
#include <string>
#include <utility>
#include <vector>

namespace strata {
namespace grammar {

class JsonReader {
 public:
  struct Node {
    int kind = -1;  // 0 object, 1 array, 2 string, 3 number/bool/null literal
    std::string s;
    std::vector<std::pair<std::string, Node>> obj;
    std::vector<Node> arr;
    const Node* find(const char* key) const {
      for (const auto& item : obj) if (item.first == key) return &item.second;
      return nullptr;
    }
  };

  JsonReader(const char* input, std::string& err) : p_(input), err_(err) {}

  bool parse(Node& out) {
    skip();
    if (!value(out)) return false;
    skip();
    if (*p_ != '\0') { err_ = "trailing characters after JSON value"; return false; }
    return true;
  }

 private:
  const char* p_;
  std::string& err_;

  static bool isWs(char c) { return c == ' ' || c == '\n' || c == '\t' || c == '\r'; }
  static bool isDelimiter(char c) {
    return c == '\0' || isWs(c) || c == ',' || c == ']' || c == '}';
  }
  static int hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  }
  static void appendUtf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) out += (char)cp;
    else if (cp < 0x800) {
      out += (char)(0xC0 | (cp >> 6));
      out += (char)(0x80 | (cp & 63));
    } else if (cp < 0x10000) {
      out += (char)(0xE0 | (cp >> 12));
      out += (char)(0x80 | ((cp >> 6) & 63));
      out += (char)(0x80 | (cp & 63));
    } else {
      out += (char)(0xF0 | (cp >> 18));
      out += (char)(0x80 | ((cp >> 12) & 63));
      out += (char)(0x80 | ((cp >> 6) & 63));
      out += (char)(0x80 | (cp & 63));
    }
  }

  void skip() { while (isWs(*p_)) ++p_; }

  bool hex4(const char* at, uint16_t& valueOut) {
    uint16_t value = 0;
    for (int i = 0; i < 4; ++i) {
      const int h = hex(at[i]);
      if (h < 0) { err_ = "invalid unicode escape"; return false; }
      value = (uint16_t)((value << 4) | h);
    }
    valueOut = value;
    return true;
  }

  bool str(std::string& out) {
    if (*p_ != '"') { err_ = "expected string"; return false; }
    ++p_;
    while (*p_ && *p_ != '"') {
      const unsigned char c = (unsigned char)*p_++;
      if (c < 0x20) { err_ = "unescaped control character in string"; return false; }
      if (c != '\\') { out += (char)c; continue; }
      const char esc = *p_++;
      switch (esc) {
        case '"': out += '"'; break; case '\\': out += '\\'; break; case '/': out += '/'; break;
        case 'b': out += '\b'; break; case 'f': out += '\f'; break; case 'n': out += '\n'; break;
        case 'r': out += '\r'; break; case 't': out += '\t'; break;
        case 'u': {
          uint16_t first = 0;
          if (!hex4(p_, first)) return false;
          p_ += 4;
          uint32_t cp = first;
          if (first >= 0xD800 && first <= 0xDBFF) {
            if (p_[0] != '\\' || p_[1] != 'u') { err_ = "missing low unicode surrogate"; return false; }
            uint16_t second = 0;
            if (!hex4(p_ + 2, second) || second < 0xDC00 || second > 0xDFFF) {
              err_ = "invalid low unicode surrogate"; return false;
            }
            p_ += 6;
            cp = 0x10000u + (((uint32_t)first - 0xD800u) << 10) + ((uint32_t)second - 0xDC00u);
          } else if (first >= 0xDC00 && first <= 0xDFFF) {
            err_ = "unexpected low unicode surrogate"; return false;
          }
          appendUtf8(out, cp);
          break;
        }
        default: err_ = "invalid string escape"; return false;
      }
    }
    if (*p_ != '"') { err_ = "unterminated string"; return false; }
    ++p_;
    return true;
  }

  bool literal(Node& node, const char* expected) {
    const size_t n = std::strlen(expected);
    if (std::strncmp(p_, expected, n) != 0 || !isDelimiter(p_[n])) {
      err_ = "invalid JSON literal"; return false;
    }
    node.kind = 3;
    node.s.assign(expected, n);
    p_ += n;
    return true;
  }

  bool number(Node& node) {
    const char* start = p_;
    if (*p_ == '-') ++p_;
    if (*p_ == '0') ++p_;
    else if (*p_ >= '1' && *p_ <= '9') while (*p_ >= '0' && *p_ <= '9') ++p_;
    else { err_ = "invalid JSON number"; return false; }
    if (*p_ == '.') {
      ++p_;
      if (*p_ < '0' || *p_ > '9') { err_ = "invalid JSON fraction"; return false; }
      while (*p_ >= '0' && *p_ <= '9') ++p_;
    }
    if (*p_ == 'e' || *p_ == 'E') {
      ++p_;
      if (*p_ == '+' || *p_ == '-') ++p_;
      if (*p_ < '0' || *p_ > '9') { err_ = "invalid JSON exponent"; return false; }
      while (*p_ >= '0' && *p_ <= '9') ++p_;
    }
    node.kind = 3;
    node.s.assign(start, (size_t)(p_ - start));
    return true;
  }

  bool value(Node& node) {
    skip();
    if (*p_ == '{') {
      node.kind = 0; ++p_; skip();
      if (*p_ == '}') { ++p_; return true; }
      for (;;) {
        skip();
        std::string key;
        if (!str(key)) return false;
        for (const auto& item : node.obj)
          if (item.first == key) { err_ = "duplicate object key: " + key; return false; }
        skip();
        if (*p_ != ':') { err_ = "expected ':'"; return false; }
        ++p_;
        Node child;
        if (!value(child)) return false;
        node.obj.emplace_back(std::move(key), std::move(child));
        skip();
        if (*p_ == ',') { ++p_; continue; }
        if (*p_ == '}') { ++p_; return true; }
        err_ = "expected ',' or '}'"; return false;
      }
    }
    if (*p_ == '[') {
      node.kind = 1; ++p_; skip();
      if (*p_ == ']') { ++p_; return true; }
      for (;;) {
        Node child;
        if (!value(child)) return false;
        node.arr.push_back(std::move(child));
        skip();
        if (*p_ == ',') { ++p_; continue; }
        if (*p_ == ']') { ++p_; return true; }
        err_ = "expected ',' or ']'"; return false;
      }
    }
    if (*p_ == '"') { node.kind = 2; return str(node.s); }
    if (*p_ == 't') return literal(node, "true");
    if (*p_ == 'f') return literal(node, "false");
    if (*p_ == 'n') return literal(node, "null");
    if (*p_ == '-' || (*p_ >= '0' && *p_ <= '9')) return number(node);
    err_ = "unexpected character in JSON";
    return false;
  }
};

inline std::string renderLiteral(const JsonReader::Node& value) {
  if (value.kind != 2) return value.s;
  static const char* hexChars = "0123456789abcdef";
  std::string out = "\"";
  for (unsigned char c : value.s) {
    switch (c) {
      case '"': out += "\\\""; break; case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break; case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break; case '\r': out += "\\r"; break; case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          out += "\\u00"; out += hexChars[c >> 4]; out += hexChars[c & 15];
        } else out += (char)c;
    }
  }
  return out + "\"";
}

inline size_t compiledSpecCount(const JsonReader::Node& node) {
  size_t count = 1;
  if (const JsonReader::Node* props = node.find("properties"))
    for (const auto& item : props->obj) count += compiledSpecCount(item.second);
  if (const JsonReader::Node* items = node.find("items")) count += compiledSpecCount(*items);
  return count;
}

inline bool compileNode(const JsonReader::Node& node, std::vector<Spec>& store, Spec*& self,
                        std::string& err, int depth = 0) {
  if (node.kind != 0) { err = "schema node must be an object"; return false; }
  if (depth >= MAX_FRAME) { err = "schema nesting exceeds engine limit"; return false; }

  const JsonReader::Node* type = node.find("type");
  const JsonReader::Node* values = node.find("enum");
  if (values) {
    if (values->kind != 1 || values->arr.empty() || values->arr.size() > MAX_ENUM) {
      err = "enum must be a non-empty array with at most 64 values"; return false;
    }
    Spec* spec = &store.emplace_back();
    spec->kind = K_ENUM;
    for (const JsonReader::Node& value : values->arr) {
      if (value.kind != 2 && value.kind != 3) { err = "enum supports scalar JSON values only"; return false; }
      const std::string literal = renderLiteral(value);
      if (literal.empty() || literal.size() > UINT16_MAX) { err = "enum literal is too long"; return false; }
      for (const std::string& existing : spec->literals)
        if (existing == literal) { err = "duplicate enum literal"; return false; }
      spec->literals.push_back(literal);
    }
    self = spec;
    return true;
  }

  std::string typeName;
  if (type) {
    if (type->kind != 2) { err = "schema type must be a string"; return false; }
    typeName = type->s;
  } else if (node.find("properties")) typeName = "object";
  else { err = "schema node needs type or enum"; return false; }

  Spec* spec = &store.emplace_back();
  if (typeName == "object") {
    spec->kind = K_OBJECT;
    if (const JsonReader::Node* additional = node.find("additionalProperties")) {
      if (additional->kind != 3 || (additional->s != "true" && additional->s != "false")) {
        err = "additionalProperties must be boolean"; return false;
      }
      if (additional->s == "true") {
        err = "additionalProperties:true is not supported by the fixed-state automaton"; return false;
      }
    }
    const JsonReader::Node* props = node.find("properties");
    if (props && props->kind != 0) { err = "properties must be an object"; return false; }
    if (props && props->obj.size() > MAX_PROPS) { err = "object has more than 32 properties"; return false; }
    if (props) {
      for (const auto& item : props->obj) {
        if (item.first.size() > MAX_LIT) { err = "property name exceeds 96 UTF-8 bytes"; return false; }
        spec->keys.push_back(item.first);
        Spec* child = nullptr;
        if (!compileNode(item.second, store, child, err, depth + 1)) return false;
        spec->children.push_back(child);
      }
    }
    if (const JsonReader::Node* required = node.find("required")) {
      if (required->kind != 1) { err = "required must be an array"; return false; }
      for (const JsonReader::Node& value : required->arr) {
        if (value.kind != 2) { err = "required entries must be strings"; return false; }
        bool declared = false;
        for (const std::string& key : spec->keys) if (key == value.s) { declared = true; break; }
        if (!declared) { err = "required property is not declared: " + value.s; return false; }
        for (const std::string& existing : spec->required)
          if (existing == value.s) { err = "duplicate required property: " + value.s; return false; }
        spec->required.push_back(value.s);
      }
    }
    self = spec;
    return true;
  }
  if (typeName == "array") {
    spec->kind = K_ARRAY;
    const JsonReader::Node* items = node.find("items");
    if (!items) { err = "array schema requires items"; return false; }
    Spec* child = nullptr;
    if (!compileNode(*items, store, child, err, depth + 1)) return false;
    spec->items = child;
    self = spec;
    return true;
  }
  if (typeName == "string") { spec->kind = K_STRING; self = spec; return true; }
  if (typeName == "number") { spec->kind = K_NUMBER; self = spec; return true; }
  if (typeName == "boolean" || typeName == "null") {
    spec->kind = K_ENUM;
    spec->literals = typeName == "boolean" ? std::vector<std::string>{"true", "false"}
                                             : std::vector<std::string>{"null"};
    self = spec;
    return true;
  }
  err = "unsupported schema type: " + typeName;
  return false;
}

inline bool loadSchema(const char* json, std::vector<Spec>& store, Spec*& root, std::string& err) {
  err.clear();
  root = nullptr;
  JsonReader reader(json, err);
  JsonReader::Node dom;
  if (!reader.parse(dom)) return false;
  store.clear();
  store.reserve(compiledSpecCount(dom));
  if (!compileNode(dom, store, root, err)) { store.clear(); root = nullptr; return false; }
  return true;
}

}  // namespace grammar
}  // namespace strata
#endif
