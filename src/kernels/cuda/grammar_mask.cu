#include "strata/kernels/grammar_mask.hpp"

#include <cuda_runtime.h>

namespace strata::kernels {
namespace {

__global__ void grammar_mask_kernel(const float* __restrict__ base_bias,
                                    const uint32_t* __restrict__ allowed_words,
                                    int n_vocab,
                                    float* __restrict__ effective_bias) {
    const int id = (int)(blockIdx.x * blockDim.x + threadIdx.x);
    if (id >= n_vocab) return;
    const bool allowed = ((allowed_words[id >> 5] >> (id & 31)) & 1u) != 0;
    effective_bias[id] = allowed ? (base_bias ? base_bias[id] : 0.0f) : __int_as_float(0xff800000);
}

}  // namespace

bool grammar_mask_apply(const float* base_bias, const uint32_t* allowed_words,
                        int n_vocab, float* effective_bias, void* stream) {
    if (allowed_words == nullptr || effective_bias == nullptr || n_vocab <= 0) return false;
    constexpr int threads = 256;
    const int blocks = (n_vocab + threads - 1) / threads;
    grammar_mask_kernel<<<blocks, threads, 0, static_cast<cudaStream_t>(stream)>>>(
        base_bias, allowed_words, n_vocab, effective_bias);
    return cudaGetLastError() == cudaSuccess;
}

}  // namespace strata::kernels
