#include <cuda_runtime.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {
bool check(cudaError_t result, const char* operation) {
    if (result == cudaSuccess) return true;
    std::fprintf(stderr, "%s: %s\n", operation, cudaGetErrorString(result));
    return false;
}

double copy_gib_per_second(void* destination, int destination_device, const void* source, int source_device,
                           size_t bytes, int rounds, double& milliseconds) {
    if (!check(cudaSetDevice(destination_device), "cudaSetDevice")) return 0;
    cudaStream_t stream = nullptr;
    if (!check(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking), "cudaStreamCreateWithFlags")) return 0;
    if (!check(cudaMemcpyPeerAsync(destination, destination_device, source, source_device, bytes, stream), "warmup copy") ||
        !check(cudaStreamSynchronize(stream), "warmup synchronize")) {
        cudaStreamDestroy(stream);
        return 0;
    }
    const auto started = std::chrono::steady_clock::now();
    for (int round = 0; round < rounds; ++round)
        if (!check(cudaMemcpyPeerAsync(destination, destination_device, source, source_device, bytes, stream), "measured copy")) {
            cudaStreamDestroy(stream);
            return 0;
        }
    if (!check(cudaStreamSynchronize(stream), "measured synchronize")) {
        cudaStreamDestroy(stream);
        return 0;
    }
    milliseconds = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    cudaStreamDestroy(stream);
    return (double(bytes) * rounds / double(size_t(1) << 30)) / (milliseconds / 1000.0);
}
}

int main(int argc, char** argv) {
    const int source_device = argc > 1 ? std::atoi(argv[1]) : 0;
    const int cache_device = argc > 2 ? std::atoi(argv[2]) : 1;
    const size_t mib = size_t(argc > 3 ? std::max(1, std::atoi(argv[3])) : 512);
    const int rounds = argc > 4 ? std::max(1, std::atoi(argv[4])) : 5;
    int devices = 0;
    if (!check(cudaGetDeviceCount(&devices), "cudaGetDeviceCount")) return 2;
    if (source_device < 0 || cache_device < 0 || source_device >= devices || cache_device >= devices || source_device == cache_device) {
        std::fprintf(stderr, "peer_cache_bench needs two distinct CUDA devices\n");
        return 77;
    }
    cudaDeviceProp source_properties{}, cache_properties{};
    if (!check(cudaGetDeviceProperties(&source_properties, source_device), "source properties") ||
        !check(cudaGetDeviceProperties(&cache_properties, cache_device), "cache properties")) return 3;
    const size_t bytes = mib << 20;
    void* source = nullptr;
    void* cache = nullptr;
    if (!check(cudaSetDevice(source_device), "source device") ||
        !check(cudaMalloc(&source, bytes), "source allocation") ||
        !check(cudaMemset(source, 0x5a, bytes), "source fill") ||
        !check(cudaSetDevice(cache_device), "cache device") ||
        !check(cudaMalloc(&cache, bytes), "cache allocation")) return 4;
    int source_to_cache_access = 0, cache_to_source_access = 0;
    cudaDeviceCanAccessPeer(&source_to_cache_access, cache_device, source_device);
    cudaDeviceCanAccessPeer(&cache_to_source_access, source_device, cache_device);
    std::vector<unsigned char> sample(4096);
    double forward_ms = 0, reverse_ms = 0;
    const double forward = copy_gib_per_second(cache, cache_device, source, source_device, bytes, rounds, forward_ms);
    const bool forward_valid = check(cudaSetDevice(cache_device), "forward validation device") &&
                               check(cudaMemcpy(sample.data(), cache, sample.size(), cudaMemcpyDeviceToHost),
                                     "forward validation copy") &&
                               std::all_of(sample.begin(), sample.end(), [](unsigned char value) { return value == 0x5a; });
    const bool reset = check(cudaSetDevice(source_device), "reverse reset device") &&
                       check(cudaMemset(source, 0xa5, bytes), "reverse reset");
    const double reverse = copy_gib_per_second(source, source_device, cache, cache_device, bytes, rounds, reverse_ms);
    const bool reverse_valid = reset && check(cudaSetDevice(source_device), "reverse validation device") &&
                               check(cudaMemcpy(sample.data(), source, sample.size(), cudaMemcpyDeviceToHost),
                                     "reverse validation copy") &&
                               std::all_of(sample.begin(), sample.end(), [](unsigned char value) { return value == 0x5a; });
    cudaFree(source);
    cudaSetDevice(cache_device);
    cudaFree(cache);
    std::printf("{\n"
                "  \"source_device\": %d,\n"
                "  \"source_name\": \"%s\",\n"
                "  \"cache_device\": %d,\n"
                "  \"cache_name\": \"%s\",\n"
                "  \"bytes\": %zu,\n"
                "  \"rounds\": %d,\n"
                "  \"peer_access_source_to_cache\": %d,\n"
                "  \"peer_access_cache_to_source\": %d,\n"
                "  \"source_to_cache_ms\": %.3f,\n"
                "  \"source_to_cache_gib_s\": %.3f,\n"
                "  \"cache_to_source_ms\": %.3f,\n"
                "  \"cache_to_source_gib_s\": %.3f,\n"
                "  \"source_to_cache_validated\": %s,\n"
                "  \"cache_to_source_validated\": %s,\n"
                "  \"validated\": %s\n"
                "}\n",
                source_device, source_properties.name, cache_device, cache_properties.name, bytes, rounds,
                source_to_cache_access, cache_to_source_access, forward_ms, forward, reverse_ms, reverse,
                forward_valid ? "true" : "false", reverse_valid ? "true" : "false",
                forward_valid && reverse_valid ? "true" : "false");
    return forward > 0 && reverse > 0 && forward_valid && reverse_valid ? 0 : 5;
}
