#include "pixelptx/compiler.hpp"
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <cmath>
#include <bit>
#include <cstdint>

int main(int argc, char** argv) {
    using namespace pixelptx;
    std::string mode = argc > 1 ? argv[1] : "--json";
    if (mode == "--help") {
        std::cout << "PixelPTX: a C++20 image filter compiler\n"
            "pixelptx [--json|--ptx|--ptx-before] [source-file]\n"
            "Source is read from stdin when no file is supplied.\n"
            "--run: stdin = source-byte-length LF source LF count LF float-values\n";
        return 0;
    }
    try {
        std::string source;
        if (mode == "--run" || mode == "--trace") {
            std::size_t length = 0;
            if (!(std::cin >> length) || length > 8192 || std::cin.get() != '\n') throw std::runtime_error("Invalid run protocol source length.");
            source.resize(length);
            std::cin.read(source.data(), static_cast<std::streamsize>(length));
            if (static_cast<std::size_t>(std::cin.gcount()) != length) throw std::runtime_error("Truncated source.");
        } else {
            if (mode != "--json" && mode != "--ptx" && mode != "--ptx-before") throw std::runtime_error("Unknown option. Use --help.");
            if (argc > 2) {
                std::ifstream file(argv[2], std::ios::binary);
                if (!file) throw std::runtime_error("Cannot open source file.");
                source.assign(std::istreambuf_iterator<char>(file), {});
            } else source.assign(std::istreambuf_iterator<char>(std::cin), {});
        }
        auto c = compile(source);
        if (mode == "--ptx") std::cout << c.ptx.text;
        else if (mode == "--ptx-before") std::cout << c.before_ptx.text;
        else if (mode == "--run" || mode == "--trace") {
            std::size_t count;
            if (!(std::cin >> count) || count > 786432 || (mode == "--trace" && count != 1)) throw std::runtime_error("Invalid channel count; maximum is 786432; trace requires one channel.");
            std::ostringstream output;
            output << "{\"ok\":true,\"backend\":\"cpu-ir\",\"values\":[";
            std::size_t mismatches = 0, non_finite = 0;
            std::vector<float> trace;
            for (std::size_t i = 0; i < count; ++i) {
                float input;
                if (!(std::cin >> input) || !std::isfinite(input) || input < 0 || input > 1)
                    throw std::runtime_error("Input channels must be finite float32 values in [0, 1].");
                auto registers = execute_ir(c.ir, input);
                auto actual = registers.back();
                if (mode == "--trace") trace = std::move(registers);
                auto reference = evaluate(c.original, input);
                bool same = (std::isnan(actual) && std::isnan(reference)) ||
                    std::bit_cast<std::uint32_t>(actual) == std::bit_cast<std::uint32_t>(reference);
                if (!same) ++mismatches;
                if (!std::isfinite(actual)) ++non_finite;
                if (i) output << ',';
                output << float_json(actual);
            }
            output << "],\"mismatches\":" << mismatches << ",\"nonFinite\":" << non_finite << ",\"checked\":" << count << ",\"trace\":[";
            for (std::size_t i = 0; i < trace.size(); ++i) { if (i) output << ','; output << float_json(trace[i]); }
            output << "]}";
            std::cout << output.str();
        } else std::cout << compilation_json(c);
        return 0;
    } catch (const Diagnostic& error) {
        std::cout << "{\"ok\":false,\"error\":" << json_quote(error.what()) << ",\"start\":" << error.span.start << ",\"end\":" << error.span.end << "}";
        return 1;
    } catch (const std::exception& error) {
        std::cout << "{\"ok\":false,\"error\":" << json_quote(error.what()) << "}";
        return 1;
    }
}
