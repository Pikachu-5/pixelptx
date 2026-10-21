#include "pixelptx/compiler.hpp"
#include <cuda.h>
#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <sstream>

using namespace pixelptx;
namespace {
void check(CUresult result, const char* operation) {
    if (result == CUDA_SUCCESS) return;
    const char* name = nullptr; const char* description = nullptr;
    cuGetErrorName(result, &name); cuGetErrorString(result, &description);
    throw std::runtime_error(std::string(operation) + ": " + (name ? name : "CUDA error") + " — " + (description ? description : "Unknown driver error"));
}
struct Driver {
    CUdevice device{}; CUcontext context{};
    Driver() {
        check(cuInit(0), "Initialize CUDA driver");
        check(cuDeviceGet(&device, 0), "Select device");
        check(cuDevicePrimaryCtxRetain(&context, device), "Retain CUDA context");
        const auto result = cuCtxSetCurrent(context);
        if (result != CUDA_SUCCESS) { cuDevicePrimaryCtxRelease(device); check(result, "Set CUDA context"); }
    }
    ~Driver() { cuDevicePrimaryCtxRelease(device); }
};
struct Buffer {
    CUdeviceptr ptr{};
    explicit Buffer(std::size_t bytes) { check(cuMemAlloc(&ptr, bytes), "Allocate GPU memory"); }
    ~Buffer() { if (ptr) cuMemFree(ptr); }
    Buffer(const Buffer&) = delete;
};
struct Module {
    CUmodule handle{}; std::array<char, 8192> info{}, error{};
    explicit Module(const std::string& ptx) {
        CUjit_option options[] = {CU_JIT_INFO_LOG_BUFFER, CU_JIT_INFO_LOG_BUFFER_SIZE_BYTES,
            CU_JIT_ERROR_LOG_BUFFER, CU_JIT_ERROR_LOG_BUFFER_SIZE_BYTES};
        void* values[] = {info.data(), reinterpret_cast<void*>(info.size()), error.data(), reinterpret_cast<void*>(error.size())};
        auto result = cuModuleLoadDataEx(&handle, ptx.c_str(), 4, options, values);
        if (result != CUDA_SUCCESS) {
            const char* name = nullptr; cuGetErrorName(result, &name);
            throw std::runtime_error(std::string("JIT PTX: ") + (name ? name : "CUDA error") + " " + error.data());
        }
    }
    ~Module() { if (handle) cuModuleUnload(handle); }
};
struct Event {
    CUevent handle{};
    Event() { check(cuEventCreate(&handle, CU_EVENT_DEFAULT), "Create CUDA event"); }
    ~Event() { if (handle) cuEventDestroy(handle); }
};
bool same(float a, float b) {
    return (std::isnan(a) && std::isnan(b)) || std::bit_cast<std::uint32_t>(a) == std::bit_cast<std::uint32_t>(b);
}
struct Result {
    std::vector<float> values;
    std::size_t mismatches{}, nonfinite{}, guardErrors{};
    int registers{}; float kernelMs{}; double jitMs{};
    std::string log;
};
Result execute(const std::string& ptx, const Expr& reference, const std::vector<float>& input) {
    const auto begin = std::chrono::steady_clock::now();
    Module module(ptx);
    Result result;
    result.jitMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - begin).count();
    result.log = module.info.data();
    CUfunction function{};
    check(cuModuleGetFunction(&function, module.handle, "pixel_filter"), "Find kernel");
    check(cuFuncGetAttribute(&result.registers, CU_FUNC_ATTRIBUTE_NUM_REGS, function), "Inspect physical register count");
    Buffer in(input.size() * sizeof(float)), out((input.size() + 16) * sizeof(float));
    check(cuMemcpyHtoD(in.ptr, input.data(), input.size() * sizeof(float)), "Copy input to GPU");
    std::vector<float> output(input.size() + 16, -12345.5f);
    check(cuMemcpyHtoD(out.ptr, output.data(), output.size() * sizeof(float)), "Initialize output guards");
    const auto count = static_cast<unsigned int>(input.size());
    void* parameters[] = {&in.ptr, &out.ptr, const_cast<unsigned int*>(&count)};
    Event start, stop;
    check(cuEventRecord(start.handle, nullptr), "Record kernel start");
    check(cuLaunchKernel(function, (count + 255) / 256, 1, 1, 256, 1, 1, 0, nullptr, parameters, nullptr), "Launch generated PTX");
    check(cuEventRecord(stop.handle, nullptr), "Record kernel stop");
    check(cuEventSynchronize(stop.handle), "Wait for GPU execution");
    check(cuEventElapsedTime(&result.kernelMs, start.handle, stop.handle), "Measure kernel events");
    check(cuMemcpyDtoH(output.data(), out.ptr, output.size() * sizeof(float)), "Copy output from GPU");
    for (std::size_t i = 0; i < input.size(); ++i) {
        if (!same(output[i], evaluate(reference, input[i]))) ++result.mismatches;
        if (!std::isfinite(output[i])) ++result.nonfinite;
    }
    for (std::size_t i = input.size(); i < output.size(); ++i) if (output[i] != -12345.5f) ++result.guardErrors;
    output.resize(input.size()); result.values = std::move(output);
    return result;
}
std::string read(const std::string& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw std::runtime_error("Cannot read " + path);
    return {std::istreambuf_iterator<char>(stream), {}};
}
std::string stats(const Result& r, std::size_t count) {
    return "{\"checked\":" + std::to_string(count) + ",\"mismatches\":" + std::to_string(r.mismatches) +
        ",\"nonFinite\":" + std::to_string(r.nonfinite) + ",\"guardErrors\":" + std::to_string(r.guardErrors) +
        ",\"registers\":" + std::to_string(r.registers) + ",\"kernelMs\":" + std::to_string(r.kernelMs) +
        ",\"jitMs\":" + std::to_string(r.jitMs) + ",\"jitLog\":" + json_quote(r.log) + "}";
}
}
int main(int argc, char** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Usage: pixelptx_gpu <bundle-directory>");
        const std::string dir = argv[1];
        const auto source = read(dir + "/source.pxp");
        const auto bytes = read(dir + "/input.u8");
        if (source.size() > 8192 || bytes.empty() || bytes.size() > 270336) throw std::runtime_error("Invalid GPU input dimensions or source size.");
        auto compilation = compile(source);
        // Execute precisely the PTX exported by the laptop's compiler.
        const auto ptx = read(dir + "/optimized.ptx"), before = read(dir + "/original.ptx");
        if (ptx != compilation.ptx.text || before != compilation.before_ptx.text) throw std::runtime_error("Uploaded PTX differs from compiler output.");
        std::vector<float> input; input.reserve(bytes.size());
        for (const unsigned char byte : bytes) input.push_back(static_cast<float>(byte) / 255.0f);
        Driver driver;
        char name[256]{}; int version = 0, major = 0, minor = 0;
        check(cuDeviceGetName(name, sizeof(name), driver.device), "Read GPU name");
        check(cuDriverGetVersion(&version), "Read CUDA driver version");
        check(cuDeviceGetAttribute(&major, CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR, driver.device), "Read architecture");
        check(cuDeviceGetAttribute(&minor, CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MINOR, driver.device), "Read architecture");
        std::size_t totalMemory{}; check(cuDeviceTotalMem(&totalMemory, driver.device), "Read GPU memory");
        auto original = execute(before, compilation.original, input);
        auto optimized = execute(ptx, compilation.original, input);
        std::size_t suiteChecks = 0, suiteFailures = 0, suiteGuards = 0;
        const std::vector<std::string> cases = {
            "pixel", ".25", "abs(-pixel)", "min(pixel, .75)", "max(pixel, .25)",
            "clamp(pixel * 1 + .25, 0, 1)", "clamp((pixel - .5) * 1.8 + .5, 0, 1)",
            "pixel * (0.5 + 0.5) + (0.1 + 0.15)", "min(-0.0, pixel)", "max(-0.0, -pixel)",
            "pixel * -0.0", "pixel * 0.00000001", "1.0 - pixel", "pixel * 1e-38", "(pixel * 3.4e38) * 2"};
        for (const auto& text : cases) {
            const auto c = compile(text);
            for (const std::size_t count : {1, 255, 256, 257, 1025}) {
                std::vector<float> sample(count);
                for (std::size_t i = 0; i < count; ++i) sample[i] = static_cast<float>((i * 73) % 1025) / 1024.0f;
                sample[0] = -0.0f;
                if (count > 1) sample[1] = std::numeric_limits<float>::denorm_min();
                for (const auto* code : {&c.before_ptx.text, &c.ptx.text}) {
                    const auto r = execute(*code, c.original, sample);
                    suiteChecks += count; suiteFailures += r.mismatches; suiteGuards += r.guardErrors;
                }
            }
        }
        const bool correct = original.mismatches == 0 && optimized.mismatches == 0 &&
            original.guardErrors == 0 && optimized.guardErrors == 0 && suiteFailures == 0 && suiteGuards == 0;
        std::cout << "{\"ok\":true,\"backend\":\"cuda-driver-ptx\",\"correct\":" << (correct ? "true" : "false")
            << ",\"device\":" << json_quote(name) << ",\"cudaDriverApiVersion\":" << version
            << ",\"computeCapability\":" << json_quote(std::to_string(major) + "." + std::to_string(minor))
            << ",\"memoryBytes\":" << totalMemory << ",\"blockSize\":256,\"original\":" << stats(original, input.size())
            << ",\"optimized\":" << stats(optimized, input.size()) << ",\"selfTest\":{\"expressions\":" << cases.size()
            << ",\"launches\":" << cases.size() * 10 << ",\"checked\":" << suiteChecks << ",\"mismatches\":" << suiteFailures
            << ",\"guardErrors\":" << suiteGuards << "},\"values\":[";
        for (std::size_t i = 0; i < optimized.values.size(); ++i) { if (i) std::cout << ','; std::cout << float_json(optimized.values[i]); }
        std::cout << "]}";
        return 0;
    } catch (const std::exception& error) {
        std::cout << "{\"ok\":false,\"error\":" << json_quote(error.what()) << "}";
        return 1;
    }
}
