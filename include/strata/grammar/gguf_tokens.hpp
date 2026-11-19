#pragma once

#include <cstdint>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

namespace strata::grammar {
namespace gguf_detail {

inline constexpr uint64_t kMaxStringBytes = 1ull << 24;
inline constexpr uint64_t kMaxArrayElements = 1ull << 24;
inline constexpr uint64_t kMaxMetadataEntries = 1ull << 20;

enum Type : uint32_t {
    U8 = 0, I8 = 1, U16 = 2, I16 = 3, U32 = 4, I32 = 5, F32 = 6,
    BOOL = 7, STRING = 8, ARRAY = 9, U64 = 10, I64 = 11, F64 = 12,
};

class Reader {
public:
    explicit Reader(std::ifstream& file) : file_(file) {}
    bool ok() const { return !failed_ && file_.good(); }
    void fail() { failed_ = true; }

    uint8_t u8() { uint8_t value = 0; read(&value, sizeof value); return value; }
    uint16_t u16() { uint16_t value = 0; read(&value, sizeof value); return value; }
    uint32_t u32() { uint32_t value = 0; read(&value, sizeof value); return value; }
    uint64_t u64() { uint64_t value = 0; read(&value, sizeof value); return value; }
    void read(void* destination, size_t bytes) {
        if (failed_ || bytes > (1ull << 34)) { failed_ = true; return; }
        file_.read(static_cast<char*>(destination), static_cast<std::streamsize>(bytes));
        if (!file_) failed_ = true;
    }
    void skip(uint64_t bytes) {
        if (failed_ || bytes > (1ull << 34)) { failed_ = true; return; }
        file_.seekg(static_cast<std::streamoff>(bytes), std::ios::cur);
        if (!file_) failed_ = true;
    }
    std::string string() {
        const uint64_t bytes = u64();
        if (bytes > kMaxStringBytes) { fail(); return {}; }
        std::string value((size_t)bytes, '\0');
        if (bytes) read(value.data(), (size_t)bytes);
        return value;
    }

private:
    std::ifstream& file_;
    bool failed_ = false;
};

inline bool skipValue(Reader& reader, uint32_t type, std::vector<std::string>* strings = nullptr) {
    switch (type) {
        case U8: case I8: case BOOL: reader.skip(1); break;
        case U16: case I16: reader.skip(2); break;
        case U32: case I32: case F32: reader.skip(4); break;
        case U64: case I64: case F64: reader.skip(8); break;
        case STRING: {
            std::string value = reader.string();
            if (strings && reader.ok()) strings->push_back(std::move(value));
            break;
        }
        case ARRAY: {
            const uint32_t elementType = reader.u32();
            const uint64_t count = reader.u64();
            if (count > kMaxArrayElements || (strings && elementType != STRING)) { reader.fail(); break; }
            if (strings) strings->reserve((size_t)count);
            for (uint64_t index = 0; index < count && reader.ok(); ++index)
                if (!skipValue(reader, elementType, strings)) return false;
            break;
        }
        default: reader.fail();
    }
    return reader.ok();
}

inline bool readStringArray(Reader& reader, uint32_t type, std::vector<std::string>& output) {
    if (type != ARRAY || reader.u32() != STRING) return false;
    const uint64_t count = reader.u64();
    if (!reader.ok() || count > kMaxArrayElements) return false;
    output.clear(); output.reserve((size_t)count);
    for (uint64_t index = 0; index < count && reader.ok(); ++index) output.push_back(reader.string());
    return reader.ok();
}

inline bool readI32Array(Reader& reader, uint32_t type, std::vector<int32_t>& output) {
    if (type != ARRAY || reader.u32() != I32) return false;
    const uint64_t count = reader.u64();
    if (!reader.ok() || count > kMaxArrayElements) return false;
    output.resize((size_t)count);
    if (count) reader.read(output.data(), (size_t)count * sizeof(int32_t));
    return reader.ok();
}

inline bool readTokenId(Reader& reader, uint32_t type, uint64_t& output) {
    switch (type) {
        case U8: output = reader.u8(); break;
        case U16: output = reader.u16(); break;
        case U32: output = reader.u32(); break;
        case U64: output = reader.u64(); break;
        case I8: {
            const int8_t value = (int8_t)reader.u8();
            if (value < 0) return false;
            output = (uint64_t)value;
            break;
        }
        case I16: {
            const int16_t value = (int16_t)reader.u16();
            if (value < 0) return false;
            output = (uint64_t)value;
            break;
        }
        case I32: {
            const int32_t value = (int32_t)reader.u32();
            if (value < 0) return false;
            output = (uint64_t)value;
            break;
        }
        case I64: {
            const int64_t value = (int64_t)reader.u64();
            if (value < 0) return false;
            output = (uint64_t)value;
            break;
        }
        default: return false;
    }
    return reader.ok();
}

}  // namespace gguf_detail

/// Reads tokenizer strings and control-token flags directly from GGUF metadata.
/// Control tokens are reported separately so EOS/EOT can be allowed only after
/// the grammar reaches a complete root value instead of parsing their display text.
inline bool loadTokenMetadata(const std::string& path, std::vector<std::string>& output,
                              std::vector<uint8_t>& control, std::vector<uint8_t>* terminal = nullptr) {
    output.clear(); control.clear();
    if (terminal) terminal->clear();
    std::ifstream file(path, std::ios::binary);
    if (!file) return false;
    gguf_detail::Reader reader(file);
    char magic[4]{};
    reader.read(magic, sizeof magic);
    const uint32_t version = reader.u32();
    if (!reader.ok() || std::string(magic, 4) != "GGUF" || version < 2 || version > 3) return false;
    (void)reader.u64();
    const uint64_t metadataCount = reader.u64();
    if (!reader.ok() || metadataCount > gguf_detail::kMaxMetadataEntries) return false;
    std::vector<uint64_t> terminalIds;
    for (uint64_t index = 0; index < metadataCount && reader.ok(); ++index) {
        const std::string key = reader.string();
        const uint32_t type = reader.u32();
        if (!reader.ok()) return false;
        if (key == "tokenizer.ggml.tokens") {
            if (!gguf_detail::readStringArray(reader, type, output)) return false;
        } else if (key == "tokenizer.ggml.token_type") {
            std::vector<int32_t> types;
            if (!gguf_detail::readI32Array(reader, type, types)) return false;
            control.assign(types.size(), 0);
            for (size_t token = 0; token < types.size(); ++token) control[token] = types[token] == 3;
        } else if (key == "tokenizer.ggml.eos_token_id" || key == "tokenizer.ggml.eot_token_id") {
            uint64_t token = 0;
            if (!gguf_detail::readTokenId(reader, type, token)) return false;
            terminalIds.push_back(token);
        } else if (!gguf_detail::skipValue(reader, type)) return false;
    }
    if (output.empty()) { control.clear(); return false; }
    if (control.size() < output.size()) control.resize(output.size(), 0);
    else if (control.size() > output.size()) control.resize(output.size());
    if (terminal) {
        terminal->assign(output.size(), 0);
        for (uint64_t token : terminalIds)
            if (token < terminal->size()) (*terminal)[(size_t)token] = 1;
    }
    return true;
}

inline bool loadTokenStrings(const std::string& path, std::vector<std::string>& output) {
    std::vector<uint8_t> control;
    return loadTokenMetadata(path, output, control);
}

}  // namespace strata::grammar
