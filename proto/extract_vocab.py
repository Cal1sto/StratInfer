"""Extract the real vocabulary from a GGUF (metadata only, tensors are not read) and cache
it as proto/vocab.json for the constrained-decoding prototype. Regenerate after a model
swap. Usage: python proto/extract_vocab.py [model.gguf]
"""
import json, os, struct, sys

DEFAULT = r"E:\Data\JarvisMarc\strata-data\models\IQ3_S\Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf"
SC = {0: '<B', 1: '<b', 2: '<H', 3: '<h', 4: '<I', 5: '<i', 6: '<f', 7: '<B', 10: '<Q', 11: '<q', 12: '<d'}

def rd(f, t):
    if t == 8:
        n = struct.unpack('<Q', f.read(8))[0]
        if n > 10_000_000: raise ValueError('corrupt string len %d' % n)
        return f.read(n)
    fmt = SC[t]
    return struct.unpack(fmt, f.read(struct.calcsize(fmt)))[0]

def main(path):
    with open(path, 'rb') as f:
        assert f.read(4) == b'GGUF', 'not GGUF'
        ver = struct.unpack('<I', f.read(4))[0]
        n_tensors = struct.unpack('<Q', f.read(8))[0]
        n_kv = struct.unpack('<Q', f.read(8))[0]
        meta = {}
        for _ in range(n_kv):
            key = rd(f, 8).decode('utf-8')
            t = struct.unpack('<I', f.read(4))[0]
            if t == 9:
                et = struct.unpack('<I', f.read(4))[0]
                n = struct.unpack('<Q', f.read(8))[0]
                if n > 10_000_000: raise ValueError('corrupt array len %d' % n)
                meta[key] = [rd(f, et) for _ in range(n)]
            else:
                meta[key] = rd(f, t)
    tok = meta['tokenizer.ggml.tokens']
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vocab.json')
    toks = [t.decode('utf-8', 'surrogateescape') if isinstance(t, bytes) else t for t in tok]
    json.dump({'tokens': toks, 'eos': meta.get('tokenizer.ggml.eos_token_id'),
               'add_bos': meta.get('tokenizer.ggml.add_bos_token')}, open(out, 'w', encoding='utf-8'))
    print('gguf v%d, %d tenseurs, vocab %d -> %s' % (ver, n_tensors, len(toks), out))

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT)
