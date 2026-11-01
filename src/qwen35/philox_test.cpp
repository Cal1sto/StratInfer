#include "strata/qwen35/philox.hpp"

#include <array>
#include <cstdio>
#include <vector>

int main() {
    constexpr uint64_t seed = 0x123456789abcdef0ull;
    std::array<float, 64> direct{};
    for (uint64_t position = 0; position < direct.size(); ++position)
        direct[(size_t)position] = strata::qwen35::philox_uniform(seed, position);

    std::array<float, 64> interleaved{};
    for (uint64_t position = 0; position < direct.size(); position += 2)
        interleaved[(size_t)position] = strata::qwen35::philox_uniform(seed, position);
    for (uint64_t position = 1; position < direct.size(); position += 2)
        interleaved[(size_t)position] = strata::qwen35::philox_uniform(seed, position);

    int wrong = 0;
    for (size_t position = 0; position < direct.size(); ++position) {
        wrong += direct[position] != interleaved[position];
        wrong += !(direct[position] >= 0.0f && direct[position] < 1.0f);
    }
    wrong += direct[0] == strata::qwen35::philox_uniform(seed + 1, 0);
    wrong += direct[0] == direct[1];
    std::printf("qwen35_philox_test: %s\n", wrong == 0 ? "OK" : "FAIL");
    return wrong == 0 ? 0 : 1;
}
