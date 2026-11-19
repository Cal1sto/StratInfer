"""S1: strictly schema-constrained JSON output, via logit_bias (+ turn-level rejection).

Proof of concept for the structured-outputs RFC without touching the engine.
Two modes:

- turn (recommended): generate the full JSON in one call, replay a JSON-schema
  prefix automaton over the output, ban the first invalid token (logit_bias=-100
  on its id), regenerate. Converges in 0-3 regenerations; the engine's prompt
  cache absorbs the common prefix.
- step (reference only): one HTTP call per token. Exhaustive per-step masks cost
  ~39 s/token on a 248k vocabulary (3.7 MB payload) and partial assistant
  prefill is refused by chat templates — measured, see docs/rfc-structured-outputs.md.
  That is exactly why the real fix belongs inside the engine's sampler.

Schema subset: root object; nested properties (object/string/number/boolean,
string enums); `required` enforced; implicit `additionalProperties: false`
(only declared keys pass). Every TOKEN is validated whole (byte-by-byte feed).

Usage:
  python proto/s1_grammar.py --selftest
  python proto/s1_grammar.py --prompt "..." [--max-tokens 160] [--verbose] [--eager]
  python proto/s1_grammar.py --battery

Config: env STRATINFER_BASE (default http://127.0.0.1:11440);
vocab from proto/vocab.json (generate with proto/extract_vocab.py).
"""
import argparse, json, os, sys, time, urllib.error, urllib.request

BASE = os.environ.get("STRATINFER_BASE", "http://127.0.0.1:11440")
VOCAB = os.environ.get("STRATINFER_VOCAB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "vocab.json"))
try:
    with open(VOCAB, encoding="utf-8") as vocab_file:
        TOK = json.load(vocab_file)
    TOKENS = [t.encode("utf-8", "surrogateescape") for t in TOK["tokens"]]
    EOS = TOK["eos"]
except FileNotFoundError:
    # vocab is a generated cache (proto/extract_vocab.py); --selftest needs no vocabulary
    TOKENS, EOS = [], None

WS = frozenset({0x20, 0x09, 0x0A, 0x0D})
DQ, LC, RC, CL, CM, BS = 0x22, 0x7B, 0x7D, 0x3A, 0x2C, 0x5C
ESC_OK = frozenset({DQ, BS, 0x2F, 0x62, 0x66, 0x6E, 0x72, 0x74, 0x75})
def stype(sc):
    if not isinstance(sc, dict): return "string"
    if "enum" in sc: return "enum"
    t = sc.get("type")
    if isinstance(t, str): return t
    if "properties" in sc: return "object"
    return "string"

def initial_state(schema):
    return {"stack": [], "mode": "root", "buf": b"", "esc": False, "unicesc": 0,
            "ikind": None, "cands": None, "vsc": schema, "lit": b"", "numstate": 0}

def clone(s):
    return {"stack": [list(e) for e in s["stack"]], "mode": s["mode"], "buf": s["buf"],
            "esc": s["esc"], "unicesc": s["unicesc"], "ikind": s["ikind"],
            "cands": s["cands"], "vsc": s["vsc"], "lit": s["lit"],
            "numstate": s["numstate"]}

def _close_object(s):
    s["stack"].pop()
    if s["stack"]: s["stack"][-1][4] = True
    s["mode"] = "done" if not s["stack"] else "sep"

def _end_scalar(s, b):
    if s["stack"]: s["stack"][-1][4] = True
    s["mode"] = "sep"
    if b in WS: return s
    return feed_byte(s, b)

def feed_byte(s, b):
    """Advance the state (mutating); return None if the byte makes the prefix impossible."""
    m = s["mode"]
    if m in ("done", "bad"): return None
    if m == "root":
        if b in WS: return s
        if b == LC and stype(s["vsc"]) == "object":
            s["stack"].append([s["vsc"], None, frozenset(s["vsc"].get("required", [])), set(), True])
            s["mode"] = "key"; return s
        return None
    if m == "key":
        if b in WS: return s
        if b == RC:
            if not s["stack"][-1][4]: return None     # comma must be followed by another key
            if s["stack"][-1][2]: return None      # outstanding required keys -> no close
            _close_object(s); return s
        if b == DQ:
            declared = s["stack"][-1][0].get("properties", {})
            s["mode"], s["ikind"], s["buf"], s["esc"], s["unicesc"] = "instr", "key", b"", False, 0
            s["cands"] = [k.encode() for k in declared] if declared else []
            return s
        return None
    if m == "instr":
        if s["unicesc"]:
            if chr(b) in "0123456789abcdefABCDEF":
                s["unicesc"] -= 1; return s
            return None
        if s["esc"]:
            if b not in ESC_OK: return None
            s["esc"] = False
            if b == 0x75: s["unicesc"] = 4
            return s
        if b == BS: s["esc"] = True; return s
        if b == DQ:
            if s["ikind"] == "key":
                key = s["buf"].decode("utf-8", "replace")
                ent = s["stack"][-1]
                props = ent[0].get("properties", {})
                if key not in props: return None          # additionalProperties: false
                if key in ent[3]: return None             # duplicate keys are ambiguous
                ent[3].add(key)
                ent[1] = key; ent[2] = ent[2] - {key}
                s["mode"] = "colon"
            else:
                if s["cands"] is not None and s["buf"] not in s["cands"]: return None
                s["mode"] = "sep"
                if s["stack"]: s["stack"][-1][4] = True
            s["buf"] = b""; s["cands"] = None
            return s
        if b < 0x20: return None
        if s["cands"] is not None:
            nc = s["buf"] + bytes([b])
            if not any(c.startswith(nc) for c in s["cands"]): return None
            s["buf"] = nc; return s
        s["buf"] += bytes([b]); return s
    if m == "colon":
        if b in WS: return s
        if b == CL:
            ent = s["stack"][-1]
            s["vsc"] = ent[0]["properties"][ent[1]]
            s["mode"] = "value"; return s
        return None
    if m == "value":
        if b in WS: return s
        t = stype(s["vsc"])
        if t == "object" and b == LC:
            s["stack"].append([s["vsc"], None, frozenset(s["vsc"].get("required", [])), set(), True])
            s["mode"] = "key"; return s
        if t in ("string", "enum") and b == DQ:
            s["mode"], s["ikind"], s["buf"], s["esc"], s["unicesc"] = "instr", "value", b"", False, 0
            s["cands"] = [e.encode() for e in s["vsc"]["enum"]] if t == "enum" else None
            return s
        if t == "number" and (0x30 <= b <= 0x39 or b == 0x2D):
            s["mode"] = "num"
            s["numstate"] = 1 if b == 0x2D else (2 if b == 0x30 else 3)
            return s
        if t == "boolean" and b in (0x74, 0x66):
            s["mode"], s["lit"] = "lit", (b"true" if b == 0x74 else b"false")[1:]
            return s
        return None
    if m == "num":
        state = s["numstate"]
        digit = 0x30 <= b <= 0x39
        if state == 1:
            if not digit: return None
            s["numstate"] = 2 if b == 0x30 else 3; return s
        if state == 2:
            if b == 0x2E: s["numstate"] = 4; return s
            if b in (0x65, 0x45): s["numstate"] = 6; return s
            if digit: return None
        elif state == 3:
            if digit: return s
            if b == 0x2E: s["numstate"] = 4; return s
            if b in (0x65, 0x45): s["numstate"] = 6; return s
        elif state == 4:
            if not digit: return None
            s["numstate"] = 5; return s
        elif state == 5:
            if digit: return s
            if b in (0x65, 0x45): s["numstate"] = 6; return s
        elif state == 6:
            if b in (0x2B, 0x2D): s["numstate"] = 7; return s
            if digit: s["numstate"] = 8; return s
            return None
        elif state == 7:
            if not digit: return None
            s["numstate"] = 8; return s
        elif state == 8:
            if digit: return s
        if state not in (2, 3, 5, 8): return None
        return _end_scalar(s, b)
    if m == "lit":
        if s["lit"] and b == s["lit"][0]:
            s["lit"] = s["lit"][1:]
            if not s["lit"]:
                s["mode"] = "sep"   # last literal byte consumed; the next sees "sep"
                if s["stack"]: s["stack"][-1][4] = True
            return s
        return None
    if m == "sep":
        if b in WS: return s
        if b == CM:
            s["stack"][-1][4] = False
            s["mode"] = "key"; return s
        if b == RC:
            if s["stack"][-1][2]: return None
            _close_object(s); return s
        return None
    return None

def state_after(schema, partial: bytes):
    s = initial_state(schema)
    for b in partial:
        s = feed_byte(s, b)
        if s is None: return None
    return s

def mask_token_ids(schema, partial: bytes):
    """Token ids banned at the current prefix (full feed of every token)."""
    s = state_after(schema, partial)
    if s is None: return "INVALID_PREFIX"
    if s["mode"] == "done": return "DONE"
    banned = []
    for i, tk in enumerate(TOKENS):
        if i == EOS:
            banned.append(i); continue
        if not tk: continue
        s2 = clone(s); ok = True
        for b in tk:
            s2 = feed_byte(s2, b)
            if s2 is None: ok = False; break
        if not ok: banned.append(i)
    return banned

# --------------------------------------------------------------------- single-token loop
def _render(tk):
    """Server-side rendering of a raw token: Ġ -> space, Ċ -> newline (Qwen BPE marks)."""
    return tk.replace(b"\xc4\xa0", b" ").replace(b"\xc4\x8a", b"\n")

_RIDX = None
def _rev_index():
    global _RIDX
    if _RIDX is None:
        _RIDX = {}
        for i, tk in enumerate(TOKENS):
            _RIDX.setdefault(_render(tk), []).append(i)
    return _RIDX

def _ids_for_text(text, banned):
    """ids whose RENDERED text == text (several possible; ban them all)."""
    tb = text.encode("utf-8", "surrogateescape")
    return [i for i in _rev_index().get(tb, []) if i not in banned]

def _require_vocab():
    if not TOKENS:
        raise RuntimeError(f"vocabulary cache not found: run extract_vocab.py or set STRATINFER_VOCAB ({VOCAB})")

def _post_json(body, timeout=180):
    req = urllib.request.Request(BASE + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace").strip()
        raise RuntimeError(f"Strata returned HTTP {exc.code}: {detail[:1000]}") from exc

def constrained_generate(schema, prompt, max_tokens=160, verbose=False, eager=False):
    """Lazy mode (default): ban only tokens the model actually attempts.
    Each generated token is replayed through the automaton; on a schema violation its
    ids join the ban set and the same step is re-requested. Tiny payloads, ~1-2 s/step,
    instead of ~39 s/step for an exhaustive 248k-ban mask (measured).
    Eager mode: exhaustive mask at every step — strict reference, slow."""
    _require_vocab()
    user = prompt + "\nAnswer with the JSON object matching the schema ONLY, no surrounding text."
    partial = ""
    banned = set()
    t0 = time.time()
    st = initial_state(schema)
    for step in range(max_tokens):
        if eager:
            mb = mask_token_ids(schema, partial.encode("utf-8", "surrogateescape"))
            if mb == "INVALID_PREFIX": return partial, "invalid-prefix"
            if mb == "DONE": return partial, "done"
            banned = set(mb)
        for retry in range(50):
            lb = {str(i): -100 for i in banned}
            body = {"model": "strata",
                    "messages": [{"role": "user", "content": user},
                                 {"role": "assistant", "content": partial}],
                    "max_tokens": 1, "temperature": 0, "logit_bias": lb,
                    "reasoning_effort": "none", "strata_checkpoint": False}
            r = _post_json(body)
            choice = r["choices"][0]
            piece = choice["message"].get("content") or ""
            if piece == "" or choice.get("finish_reason") == "stop" and not piece:
                # attempted EOS: ban it and retry
                if EOS is not None and EOS not in banned:
                    banned.add(EOS); continue
                return partial, "eos-stuck"
            s2 = clone(st); ok = True
            for b in piece.encode("utf-8", "surrogateescape"):
                s2 = feed_byte(s2, b)
                if s2 is None: ok = False; break
            if ok:
                st = s2; partial += piece
                if verbose: print(f"[{step}] +{piece!r} bans={len(banned)} ({round(time.time()-t0,1)}s)", file=sys.stderr)
                break
            # illegal piece: ban every id whose rendering equals it
            ids = _ids_for_text(piece, banned)
            if not ids:
                tb = piece.encode("utf-8", "surrogateescape")
                ids = [i for i, tk in enumerate(TOKENS)
                       if tb and tb in _render(tk) and i not in banned][:20]
            if not ids: return partial, "unstoppable-illegal"
            banned.update(ids)
            if verbose: print(f"[{step}] REJECT {piece!r} -> +{len(ids)} bans", file=sys.stderr)
        else:
            return partial, "retry-exhausted"
        if st is not None and st["mode"] == "done":
            return partial, "done"
    return partial, "max-tokens"

def validate(schema, text):
    try:
        import jsonschema
        jsonschema.validate(json.loads(text), schema)
        return True
    except Exception:
        return False

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

PROMPTS = [
    "Classify for a visual bible: 'A rusty key found in the attic, recurring object of act 2'. Give title, category, confidence (0-1), verified.",
    "Character sheet for 'The Silent Star', category character, confidence 0.9, not verified. Fields: title, category, confidence, verified.",
    "Location: grandmother's kitchen, category location, confidence 1, verified. Fields: title, category, confidence, verified.",
]

# --------------------------------------------------------------------- turn level
def _client_tokenize(text, max_len=48):
    """Greedy longest-prefix segmentation over rendered tokens. Approximates the engine's
    BPE; enough to locate the offending token and ban it (the index covers variants)."""
    ridx = _rev_index()
    tb = text.encode("utf-8", "surrogateescape")
    out, i = [], 0
    while i < len(tb):
        best = None
        for L in range(min(max_len, len(tb) - i), 0, -1):
            ids = ridx.get(tb[i:i+L])
            if ids: best = (L, ids); break
        if best is None: out.append((1, [None])); i += 1
        else: out.append((best[0], best[1])); i += best[0]
    return out

def constrained_generate_turn(schema, prompt, max_tokens=500, max_regens=10, verbose=False):
    """Turn-level constraint: full generation, automaton replay over the text, ban the
    first illegal token (all its render variants), regenerate. Converges in 1-3 tries;
    the engine's prompt cache absorbs the common prefix."""
    _require_vocab()
    user = prompt + "\nAnswer with the JSON object matching the schema ONLY, no surrounding text."
    banned, text = set(), ""
    for regen in range(max_regens):
        body = {"model": "strata", "messages": [{"role": "user", "content": user}],
                "max_tokens": max_tokens, "temperature": 0,
                "logit_bias": [[i, False] for i in sorted(banned)] or None,
                "reasoning_effort": "none",
                "response_format": {"type": "json_schema", "json_schema": {"name": "s1", "schema": schema}}}
        body = {k: v for k, v in body.items() if v is not None}
        r = _post_json(body)
        text = r["choices"][0]["message"].get("content") or ""
        segs = _client_tokenize(text)
        st = initial_state(schema); pos = 0; bad = None
        for L, ids in segs:
            for b in text.encode("utf-8", "surrogateescape")[pos:pos+L]:
                st2 = feed_byte(st, b)
                if st2 is None and bad is None: bad = (pos, ids)
                if st2 is not None: st = st2
            pos += L
            if bad: break
        if bad is None and validate(schema, text):
            if verbose: print(f"regen {regen}: OK bans={len(banned)}", file=sys.stderr)
            return text, "done", regen
        if bad is None:
            # syntactically valid JSON but off-constraint (e.g. surrounding text):
            # banning is pointless without a target token
            if verbose: print(f"regen {regen}: off-schema without a target token", file=sys.stderr)
            return text, "offschema", regen
        _, ids = bad
        new = [i for i in (ids or []) if i not in banned]
        if not new: return text, "unstoppable", regen
        banned.update(new)
        if verbose: print(f"regen {regen}: byte {bad[0]} illegal -> bans+{len(new)}", file=sys.stderr)
    return text, "regen-exhausted", max_regens

def battery(eager=False):
    print("== constrained (turn level: S1 automaton + logit_bias + lazy rejects) ==")
    okc = n = regens = 0
    for p in PROMPTS:
        if eager:
            out, status = constrained_generate(SCHEMA, p, max_tokens=300, verbose=True, eager=True)
            k = 0
        else:
            out, status, k = constrained_generate_turn(SCHEMA, p, max_tokens=300, verbose=True)
        ok = validate(SCHEMA, out); okc += ok; n += 1; regens += k
        print(f"  {'OK  ' if ok else 'FAIL'} [{status}] regens={k} {out[:200]}", flush=True)
    print(f"constrained: {okc}/{n} valid, {regens} regenerations total")
    print("== free (no constraint, same prompts, 2 trials each) ==")
    okt = 0
    for p in PROMPTS:
        for _ in range(2):
            body = {"model": "strata", "messages": [{"role": "user", "content": p + " Answer with the JSON."}],
                    "max_tokens": 400, "temperature": 1.0, "reasoning_effort": "none"}
            r = _post_json(body)
            okt += validate(SCHEMA, r["choices"][0]["message"].get("content") or "")
    print(f"  conforming: {okt}/6")
    print(f"== RESULT: constrained {okc}/{n} vs free {okt}/6 ==")

def selftest():
    """Automaton unit tests — no network needed."""
    sc = SCHEMA
    ok = lambda p: state_after(sc, p if isinstance(p, bytes) else p.encode()) is not None
    bad = lambda p: not ok(p)
    cases = [
        (ok,  '',                                   'empty prefix'),
        (ok,  '{"ti',                               'partial key'),
        (ok,  '{"title":"x"',                       'string value'),
        (ok,  '{"category":"charac',                'enum prefix'),
        (bad, '{"category":"xyz"',                  'enum violation'),
        (bad, '{"nope":1}',                         'undeclared key'),
        (ok,  '{"title":"a","category":"object","confidence":0.5,"verified":tru', 'bool literal prefix'),
        (bad, '{"title":"a","category":"object","confidence":0.5,"verified":maybe', 'bad literal'),
        (ok,  '{"title":"a","category":"object","confidence":-1.2e3, "verified":false}', 'number forms + ws'),
        (bad, '{"category":"object"}',              'missing required'),
        (ok,  '{"title":"a","category":"object"}',  'required satisfied'),
        (bad, '{"title":"a","category":"object"}}', 'extra brace'),
        (ok,  '{"title":"e\\u0041", "category":"lieu"}', 'unicode escape') if False else (ok, '{"title":"e\\u0041","category":"location"}', 'unicode escape'),
        (bad, '{"title":"a","category":"object",}', 'trailing comma'),
        (bad, '{"title":"a","title":"b","category":"object"}', 'duplicate key'),
        (bad, '{"title":"a","category":"object","confidence":01}', 'leading-zero number'),
        (bad, '{"title":"a","category":"object","confidence":1.}', 'missing fraction'),
        (bad, '{"title":"a","category":"object","confidence":1e}', 'missing exponent'),
    ]
    fails = 0
    for check, prefix, name in cases:
        if not check(prefix):
            print(f"  FAIL {name}: {prefix!r}"); fails += 1
    # done detection
    if state_after(sc, b'{"title":"a","category":"object"}')["mode"] != "done":
        print("  FAIL done mode"); fails += 1
    print(f"selftest: {len(cases)+1-fails}/{len(cases)+1} OK")
    return 1 if fails else 0

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt"); ap.add_argument("--max-tokens", type=int, default=160)
    ap.add_argument("--battery", action="store_true"); ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--eager", action="store_true", help="exhaustive mask per step (slow: ~39s/step)")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())
    elif a.battery:
        battery(eager=a.eager)
    else:
        out, status = constrained_generate(SCHEMA, a.prompt or PROMPTS[0], a.max_tokens, a.verbose, eager=a.eager)
        print(json.dumps({"status": status, "valid": validate(SCHEMA, out), "output": out}, ensure_ascii=False))
