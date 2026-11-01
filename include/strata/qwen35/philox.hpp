#pragma once

#include <cstdint>

namespace strata::qwen35 {

/// Philox 4x32-10 draw shared with Strata's main sampler. The stream is a pure
/// function of (sequence seed, generated-token index), so request interleaving
/// and batch composition cannot consume another sequence's random numbers.
inline float philox_uniform(uint64_t seed, uint64_t counter) {
    uint32_t c0 = (uint32_t)counter, c1 = (uint32_t)(counter >> 32);
    uint32_t c2 = (uint32_t)seed, c3 = (uint32_t)(seed >> 32);
    for (uint32_t round = 0; round < 10; ++round) {
        const uint32_t hi0 = (uint32_t)(((uint64_t)0x9E3779B9u * c0) >> 32);
        const uint32_t hi1 = (uint32_t)(((uint64_t)0xBB67AE85u * c2) >> 32);
        const uint32_t lo0 = 0x9E3779B9u * c0;
        const uint32_t lo1 = 0xBB67AE85u * c2;
        const uint32_t n0 = hi1 ^ c1 ^ round;
        const uint32_t n1 = lo1;
        const uint32_t n2 = hi0 ^ c3;
        const uint32_t n3 = lo0;
        c0 = n0; c1 = n1; c2 = n2; c3 = n3;
    }
    return (float)(c0 >> 8) * (1.0f / 16777216.0f);
}

}  // namespace strata::qwen35
