// Included by src/program/generate.cpp after artifact/gguf_reader.hpp.
#include "strata/grammar/draft_chain.hpp"
#include "strata/grammar/gguf_tokens.hpp"
#include "strata/grammar/schema_loader.hpp"

#include <cstdlib>
#include <fstream>
#include <iterator>
#include <mutex>

namespace stratinfer_grammar_wiring {

struct Assets {
    std::vector<strata::grammar::Spec> specs;
    std::vector<std::string> tokens;
    std::vector<uint8_t> terminal;
    std::vector<const char*> table;
    strata::grammar::Spec* root = nullptr;
    std::string error;
};

inline Assets& load(const char* schemaPath, const std::string& nativeGguf) {
    static Assets assets;
    static std::once_flag once;
    std::call_once(once, [&] {
        if (nativeGguf.empty()) { assets.error = "no --native GGUF"; return; }
        std::ifstream schemaFile(schemaPath);
        if (!schemaFile) { assets.error = std::string("schema unreadable: ") + schemaPath; return; }
        const std::string schema((std::istreambuf_iterator<char>(schemaFile)), std::istreambuf_iterator<char>());
        if (!strata::grammar::loadSchema(schema.c_str(), assets.specs, assets.root, assets.error)) return;
        std::vector<uint8_t> control;
        if (!strata::grammar::loadTokenMetadata(nativeGguf, assets.tokens, control, &assets.terminal)) {
            assets.error = std::string("tokenizer.ggml metadata unreadable in ") + nativeGguf;
            assets.root = nullptr;
            return;
        }
        assets.table.resize(assets.tokens.size());
        for (size_t token = 0; token < assets.tokens.size(); ++token) {
            if (assets.terminal[token]) {
                assets.tokens[token].clear();
                assets.table[token] = assets.tokens[token].c_str();
            } else if (control[token] || assets.tokens[token].empty()) {
                assets.table[token] = nullptr;
            } else {
                assets.table[token] = assets.tokens[token].c_str();
            }
        }
    });
    return assets;
}

inline void attach(strata::core::Verifier& verifier, const std::string& nativeGguf) {
    const char* schemaPath = std::getenv("STRATA_GRAMMAR_SCHEMA");
    if (schemaPath == nullptr || *schemaPath == '\0') return;
    Assets& assets = load(schemaPath, nativeGguf);
    if (!assets.root) {
        std::fprintf(stderr, "strata: grammar disabled: %s\n", assets.error.c_str());
        return;
    }
    verifier.set_grammar(std::make_unique<strata::grammar::DraftChain>(*assets.root), assets.table.data());
    std::fprintf(stderr, "strata: grammar attached (schema %s, vocab %zu tokens)\n", schemaPath, assets.tokens.size());
}

}  // namespace stratinfer_grammar_wiring
