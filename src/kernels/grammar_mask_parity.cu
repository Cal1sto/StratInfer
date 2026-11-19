#include "strata/kernels/grammar_mask.hpp"

#include <cuda_runtime.h>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

bool check(cudaError_t status, const char* what) {
    if (status == cudaSuccess) return true;
    std::fprintf(stderr, "%s: %s\n", what, cudaGetErrorString(status));
    return false;
}

}  // namespace

int main(int argc, char** argv) {
    const bool bench = argc > 1 && std::string(argv[1]) == "--bench";
    const int n_vocab = bench ? 248320 : 257;
    const size_t words = ((size_t)n_vocab + 31) / 32;
    std::vector<float> base((size_t)n_vocab);
    std::vector<uint32_t> mask(words, 0);
    for (int id = 0; id < n_vocab; ++id) {
        base[(size_t)id] = (float)id * 0.001f - 3.0f;
        if ((id % 7) == 1 || (id % 11) == 0) mask[(size_t)id >> 5] |= 1u << (id & 31);
    }

    float *d_base = nullptr, *d_out = nullptr;
    uint32_t* d_mask = nullptr;
    if (!check(cudaMalloc(&d_base, base.size() * sizeof(float)), "base allocation") ||
        !check(cudaMalloc(&d_out, base.size() * sizeof(float)), "output allocation") ||
        !check(cudaMalloc(&d_mask, mask.size() * sizeof(uint32_t)), "mask allocation") ||
        !check(cudaMemcpy(d_base, base.data(), base.size() * sizeof(float), cudaMemcpyHostToDevice), "base upload") ||
        !check(cudaMemcpy(d_mask, mask.data(), mask.size() * sizeof(uint32_t), cudaMemcpyHostToDevice), "mask upload")) return 2;

    if (!strata::kernels::grammar_mask_apply(d_base, d_mask, n_vocab, d_out, nullptr) ||
        !check(cudaDeviceSynchronize(), "mask launch")) return 3;
    std::vector<float> got((size_t)n_vocab);
    if (!check(cudaMemcpy(got.data(), d_out, got.size() * sizeof(float), cudaMemcpyDeviceToHost), "result copy")) return 4;
    int wrong = 0;
    for (int id = 0; id < n_vocab; ++id) {
        const bool allowed = ((mask[(size_t)id >> 5] >> (id & 31)) & 1u) != 0;
        wrong += allowed ? got[(size_t)id] != base[(size_t)id] : !std::isinf(got[(size_t)id]) || got[(size_t)id] > 0;
    }

    if (bench) {
        cudaEvent_t start = nullptr, stop = nullptr;
        cudaEventCreate(&start); cudaEventCreate(&stop);
        for (int i = 0; i < 20; ++i) strata::kernels::grammar_mask_apply(d_base, d_mask, n_vocab, d_out, nullptr);
        cudaEventRecord(start);
        for (int i = 0; i < 1000; ++i) strata::kernels::grammar_mask_apply(d_base, d_mask, n_vocab, d_out, nullptr);
        cudaEventRecord(stop); cudaEventSynchronize(stop);
        float elapsed = 0;
        cudaEventElapsedTime(&elapsed, start, stop);
        std::printf("grammar mask: %.3f us/launch, vocab %d, bitset %.1f KiB\n",
                    elapsed * 1000.0f / 1000.0f, n_vocab, mask.size() * sizeof(uint32_t) / 1024.0);

        uint32_t* pinned = nullptr;
        if (!check(cudaMallocHost(&pinned, mask.size() * sizeof(uint32_t)), "pinned mask allocation")) return 5;
        std::memcpy(pinned, mask.data(), mask.size() * sizeof(uint32_t));
        for (int i = 0; i < 20; ++i) {
            cudaMemcpyAsync(d_mask, pinned, mask.size() * sizeof(uint32_t), cudaMemcpyHostToDevice);
            strata::kernels::grammar_mask_apply(d_base, d_mask, n_vocab, d_out, nullptr);
        }
        cudaEventRecord(start);
        for (int i = 0; i < 1000; ++i) {
            cudaMemcpyAsync(d_mask, pinned, mask.size() * sizeof(uint32_t), cudaMemcpyHostToDevice);
            strata::kernels::grammar_mask_apply(d_base, d_mask, n_vocab, d_out, nullptr);
        }
        cudaEventRecord(stop); cudaEventSynchronize(stop);
        cudaEventElapsedTime(&elapsed, start, stop);
        std::printf("grammar mask: %.3f us/upload+launch from pinned host\n", elapsed * 1000.0f / 1000.0f);
        cudaFreeHost(pinned);
        cudaEventDestroy(start); cudaEventDestroy(stop);
    }

    cudaFree(d_mask); cudaFree(d_out); cudaFree(d_base);
    std::printf("grammar_mask_parity: %s\n", wrong == 0 ? "OK" : "FAIL");
    return wrong == 0 ? 0 : 1;
}
