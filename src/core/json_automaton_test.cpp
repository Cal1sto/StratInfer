// src/core/json_automaton_test.cpp - unit tests for the S2 grammar automaton.
// Standalone: cl /EHsc json_automaton_test.cpp (no engine headers needed).
#include "strata/grammar/json_automaton.hpp"
#include "strata/grammar/draft_chain.hpp"
#include "strata/grammar/schema_loader.hpp"

#include <cstdio>
#include <string>

using namespace strata::grammar;

static int failures = 0;
static void check(bool cond, const char* what) {
  if (!cond) { std::printf("FAIL %s\n", what); failures++; }
}

int main() {
  Spec cat;  cat.kind = K_ENUM;
  cat.literals = {"\"character\"", "\"object\"", "\"location\""};
  Spec ti;   ti.kind = K_STRING;
  Spec co;   co.kind = K_NUMBER;
  Spec ve;   ve.kind = K_ENUM; ve.literals = {"true", "false"};
  Spec obj;  obj.kind = K_OBJECT; obj.additional = false;
  obj.keys = {"title", "category", "confidence", "verified"};
  obj.children = {&ti, &cat, &co, &ve};
  obj.required = {"title", "category"};

  Automaton A(obj);

  auto run = [&](const char* doc) { return A.accept(doc, std::strlen(doc)); };

  check(run("{\"title\":\"The Silent Star\",\"category\":\"character\",\"confidence\":0.95,\"verified\":true}"),
        "full valid tour");
  check(run("{\"category\":\"object\",\"title\":\"x\"}"), "required order free");
  check(run("{\"confidence\":-12.5e3,\"category\":\"location\",\"title\":\"\"}"), "number form");
  check(!run("{\"category\":\"city\",\"title\":\"x\"}"), "enum rejected at 'y'");
  check(!run("{\"category\":\"object\"}"), "missing required title");
  check(!run("{\"nope\":1,\"category\":\"object\",\"title\":\"x\"}"), "additionalProperties=false");
  check(!run("{\"title\":\"a"), "unterminated string");
  check(!run("{\"title\":\"The Silent Star\",\"category\":\"character\",\"confidence\":0.95,\"verified\":true}x"),
        "trailing garbage");
  check(run("{\"title\":\"The Silent Star\",\"category\":\"character\",\"confidence\":0.95,\"verified\":true} "),
        "trailing space ok after done");
  check(!run("{\"category\":\"object\",\"title\":\"x\"}x"), "garbage after close");
  check(!run("{\"category\":\"characterx\""), "closed enum literal cannot extend");

  // candidate mask (the engine-side operation: kSelMax <= 64 byte candidates)
  {
    State s = A.initial();
    for (const char* p = "{\"category\":\""; *p; ++p) {
      if (!A.feed(s, (uint8_t)*p)) { check(false, "prefix {\"category\":\" must be feasible"); break; }
    }
    uint8_t cands[] = {'c', 'o', 'l', 'x', '"', '}', ','};
    uint8_t out[16];
    int kept = A.mask(s, cands, 7, out);
    std::string k((char*)out, kept);
    check(k == "col", "mask keeps only c,o,l at enum head");
  }
  // mask mid-enum: after "char" only 'a' survives
  {
    State s = A.initial();
    for (const char* p = "{\"category\":\"char"; *p; ++p) A.feed(s, (uint8_t)*p);
    uint8_t cands[] = {'a', 'x', 't', '"'};
    uint8_t out[16];
    int kept = A.mask(s, cands, 4, out);
    check(kept == 1 && out[0] == 'a', "mask after 'char' keeps only 'a'");
  }
  // draft-chain rule: first invalid draft kills its row and later rows
  {
    State s = A.initial();
    for (const char* p = "{\"category\":\""; *p; ++p) A.feed(s, (uint8_t)*p);
    const char* draft = "xtact";  // 'x' invalid at position 0 of the window
    State t = s;
    int accepted = 0;
    for (const char* p = draft; *p; ++p) {
      if (!A.feed(t, (uint8_t)*p)) break;
      accepted++;
    }
    check(accepted == 0, "draft chain: invalid head kills window from row 0");
  }
  // required-key accounting on nested close
  {
    State s = A.initial();
    bool ok = true;
    for (const char* p = "{\"title\":\"x\",\"category\":\"obj"; *p; ++p) ok = ok && A.feed(s, (uint8_t)*p);
    check(ok, "partial enum 'obj' feasible");
    ok = ok && A.feed(s, (uint8_t)'}');
    check(!ok, "'}' mid-enum invalid");
  }

  // DraftChain: window truncation at first invalid draft + masked redraw
  {
    DraftChain D(obj);
    std::vector<const char*> win = {"{\"", "title", "\":", "\"Hi", "\"", ",", "\"category", "\":", "\"c"};
    int keep = D.commitWindow(win);
    check(keep == 9, "draftchain commits valid prefix");
    std::vector<const char*> repl = {"ity", "haracter", "at", "location"};  // after "c" only "character" is alive
    std::vector<int> allowed = D.mask(repl);
    check(allowed.size() == 1 && std::string(repl[allowed[0]]) == "haracter", "draftchain mask keeps only legal continuation");
    int pick = D.redraw(42, allowed, 7);
    check(pick >= 0 && (std::string(repl[pick]) == "haracter" || std::string(repl[pick]) == "location"),
          "draftchain redraw picks a legal continuation");
    std::vector<int> none;
    check(D.redraw(43, none, 7) == -1, "draftchain redraw signals unsatisfiable on empty set");
  }

  // schema_loader: compile the battery schema from JSON, same behavior as hand-built Spec
  {
    const char* js = "{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"},"
                     "\"category\":{\"enum\":[\"character\",\"object\",\"location\"]},"
                     "\"confidence\":{\"type\":\"number\"},\"verified\":{\"type\":\"boolean\"}},"
                     "\"required\":[\"title\",\"category\"],\"additionalProperties\":false}";
    std::vector<Spec> store;
    Spec* root = nullptr;
    std::string err;
    check(loadSchema(js, store, root, err), "schema loads");
    if (root) {
      Automaton B(*root);
      const char* doc = "{\"title\":\"The Silent Star\",\"category\":\"object\",\"verified\":false,\"confidence\":1}";
      bool acc = B.accept(doc, std::strlen(doc));
      if (!acc) {  // debug: locate the first rejected byte
        State s = B.initial();
        for (size_t k = 0; k < std::strlen(doc); ++k)
          if (!B.feed(s, (uint8_t)doc[k])) { std::printf("  loader first fail at byte %zu '%c' (mode %d keyLen %d nbr %d)\n", k, doc[k], (int)s.mode, s.keyLen, s.nbr); break; }
      }
      check(acc, "loaded schema accepts");
      check(!B.accept("{\"title\":\"x\"}", 12), "loaded schema enforces required");
      DraftChain D2(*root);
      check(!D2.feasible(" nope"), "feasible() filters structural bytes at root");
    }
  }

  // DraftChain confirm(): provisional advance reconciled to a shorter real commit.
  // Bytes of the 5-token window: {"title":"x","category
  {
    DraftChain D2(obj);
    const char* w5[5] = {"{\"", "title", "\":", "\"x", "\""};      // -> {"title":"x"
    const char* w6[6] = {w5[0], w5[1], w5[2], w5[3], w5[4], ",\"category"};  // -> ...,"category
    // (a) full 6-token advance: the key 'category' is OPEN at the end
    DraftChain Da(obj);
    int keep = Da.commitWindow(std::vector<const char*>(w6, w6 + 6));
    check(keep == 6, "commitWindow commits all-valid window");
    const char* more[3] = {"\"", ":", "\""};                       // closes key, colon, opens enum value
    DraftChain Db = Da;
    for (const char* m : more) Db.commitWindow(std::vector<const char*>{m});
    check(!Db.feasible("y"), "full advance: 'y' is an unknown key (additionalProperties=false)");
    // (b) same window, real commit only 5 rows: 'category' was NEVER fed
    Da.confirm(5);
    check(!Da.feasible("\":"), "confirm(5): state before the key 'category'");
    DraftChain Dc = Da;
    check(Dc.commitWindow(std::vector<const char*>{w6[5]}) == 1 && Dc.feasible("\":"),
          "confirm(5): 'category' is again a valid key position");
  }

  std::printf(failures ? "FAILED %d\n" : "ALL OK\n", failures);
  return failures ? 1 : 0;
}
