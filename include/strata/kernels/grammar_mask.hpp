#pragma once

#include <cstdint>

namespace strata::kernels {

/// Build the effective sampler bias on the device from a packed grammar bitset.
/// `allowed_words` stores one bit per vocabulary id (least-significant bit first).
/// Allowed ids receive `base_bias[id]` (or zero when base_bias is null); every
/// other id receives -infinity. The launch is asynchronous on `stream`.
bool grammar_mask_apply(const float* base_bias, const uint32_t* allowed_words,
                        int n_vocab, float* effective_bias, void* stream);

}  // namespace strata::kernels
