#include "strata/grammar/gguf_tokens.hpp"

#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

namespace {

template <class T>
void put(std::ofstream& file, T value) { file.write(reinterpret_cast<const char*>(&value), sizeof value); }

void putString(std::ofstream& file, const std::string& value) {
    put<uint64_t>(file, value.size());
    file.write(value.data(), (std::streamsize)value.size());
}

void fixture(const std::string& path, bool malformed) {
    std::ofstream file(path, std::ios::binary);
    file.write("GGUF", 4);
    put<uint32_t>(file, 3);
    put<uint64_t>(file, 0);
    put<uint64_t>(file, malformed ? 1 : 3);
    putString(file, "tokenizer.ggml.tokens");
    put<uint32_t>(file, malformed ? 99u : (uint32_t)strata::grammar::gguf_detail::ARRAY);
    if (!malformed) {
        put<uint32_t>(file, (uint32_t)strata::grammar::gguf_detail::STRING);
        put<uint64_t>(file, 3);
        putString(file, "a"); putString(file, "{x"); putString(file, "");
        putString(file, "tokenizer.ggml.token_type");
        put<uint32_t>(file, (uint32_t)strata::grammar::gguf_detail::ARRAY);
        put<uint32_t>(file, (uint32_t)strata::grammar::gguf_detail::I32);
        put<uint64_t>(file, 3);
        put<int32_t>(file, 1); put<int32_t>(file, 3); put<int32_t>(file, 1);
        putString(file, "tokenizer.ggml.eos_token_id");
        put<uint32_t>(file, (uint32_t)strata::grammar::gguf_detail::U32);
        put<uint32_t>(file, 1);
    }
}

}  // namespace

int main(int argc, char** argv) {
    if (argc == 2) {
        std::vector<std::string> tokens;
        std::vector<uint8_t> control, terminal;
        if (!strata::grammar::loadTokenMetadata(argv[1], tokens, control, &terminal)) {
            std::fprintf(stderr, "cannot load token metadata from %s\n", argv[1]);
            return 2;
        }
        size_t controls = 0, terminals = 0;
        for (uint8_t value : control) controls += value != 0;
        for (uint8_t value : terminal) terminals += value != 0;
        std::printf("vocab=%zu controls=%zu terminals=%zu\n", tokens.size(), controls, terminals);
        for (const char* needle : {"\"", "e", "e\"", "confiance", "confiance\""}) {
            bool found = false;
            for (size_t token = 0; token < tokens.size(); ++token) {
                if (tokens[token] != needle) continue;
                std::printf("exact '%s': id=%zu control=%d terminal=%d\n", needle, token,
                            control[token] ? 1 : 0, terminal[token] ? 1 : 0);
                found = true;
            }
            if (!found) std::printf("exact '%s': absent\n", needle);
        }
        return 0;
    }
    const std::string good = "gguf_tokens_test-good.gguf";
    const std::string bad = "gguf_tokens_test-bad.gguf";
    fixture(good, false); fixture(bad, true);
    std::vector<std::string> tokens;
    std::vector<uint8_t> control, terminal;
    int wrong = 0;
    wrong += !strata::grammar::loadTokenMetadata(good, tokens, control, &terminal);
    wrong += tokens != std::vector<std::string>({"a", "{x", ""});
    wrong += control != std::vector<uint8_t>({0, 1, 0});
    wrong += terminal != std::vector<uint8_t>({0, 1, 0});
    wrong += strata::grammar::loadTokenMetadata(bad, tokens, control, &terminal);
    wrong += !tokens.empty();
    wrong += !control.empty();
    wrong += !terminal.empty();
    std::remove(good.c_str()); std::remove(bad.c_str());
    std::printf("gguf_tokens_test: %s\n", wrong == 0 ? "OK" : "FAIL");
    return wrong == 0 ? 0 : 1;
}
