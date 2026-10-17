#include "pixelptx/compiler.hpp"
#include <bit>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <random>
#include <stdexcept>

namespace {
int checks = 0;
void check(bool condition, const std::string& message) {
    ++checks;
    if (!condition) throw std::runtime_error(message);
}
bool equal(float a, float b) {
    return (std::isnan(a) && std::isnan(b)) || std::bit_cast<std::uint32_t>(a) == std::bit_cast<std::uint32_t>(b);
}
void fails(const std::string& source) {
    try { pixelptx::compile(source); } catch (const pixelptx::Diagnostic& error) {
        check(error.span.start <= source.size(), "Diagnostic location must be in source");
        return;
    }
    throw std::runtime_error("Should reject: " + source);
}
}
int main() {
    using namespace pixelptx;
    try {
        auto brightness = compile("out = clamp(pixel * 1.0 + 0.25, 0.0, 1.0);");
        check(brightness.rewrites.size() == 1, "Identity rewrite is recorded");
        check(brightness.ir.size() < brightness.before_ir.size(), "Identity reduces IR size");
        check(brightness.ptx.text.find("add.rn.f32") != std::string::npos, "PTX uses explicit rounding");
        check(brightness.ptx.text.find("0f3E800000") != std::string::npos, "PTX uses exact float32 immediate");
        check(brightness.ptx.text.find("setp.ge.u32") != std::string::npos, "Kernel checks bounds");
        check(brightness.ptx.text.find(".target sm_75") != std::string::npos, "Explicit target");
        check(brightness.ptx.instruction_lines.size() == brightness.ir.size(), "Each IR node maps to PTX");
        check(evaluate(compile("pixel + 0.2 * 0.5").original, 0.25f) == 0.35f, "Operator precedence");
        check(evaluate(compile("pixel - 0.2 - 0.1").original, 0.5f) == (0.5f - 0.2f) - 0.1f, "Left associativity");
        check(compile("(0.2 + 0.3) * 2").optimized->op == Op::Constant, "Nested constants fold");
        check(compile("pixel + 0").optimized->op == Op::Add, "Do not erase signed-zero-sensitive addition");
        check(compile("pixel * 0").optimized->op == Op::Mul, "Do not erase signed-zero-sensitive multiplication");
        check(compile("3e38 * 3e38").optimized->op == Op::Mul, "Do not serialize overflow as a constant");
        check(compile("// comment\nout = abs(-pixel);").original->op == Op::Abs, "Comments and unary minus");
        auto negative_zero = compile("min(-0.0, 0.0)");
        check(std::signbit(evaluate(negative_zero.optimized, 0)), "Min preserves negative zero");
        check(!std::signbit(evaluate(compile("max(-0.0, 0.0)").optimized, 0)), "Max selects positive zero");
        for (auto source : {"", "out = ;", "pixel / 2", "pixels", "clamp(pixel, 0)", "abs(pixel, 0)",
                            "min(pixel 0)", "out pixel;", "pixel; pixel", "1e999", ".", "1e+", "(pixel", "pixel)", "pixel = 2"}) fails(source);
        fails(std::string(50, '(') + "pixel" + std::string(50, ')'));
        fails(std::string(8193, ' '));
        std::vector<std::string> formulas = {
            "pixel", "0.25", "clamp(pixel * 1 + .25, 0, 1)", "1 - pixel", "pixel * pixel",
            "clamp((pixel - .5) * 1.8 + .5, 0, 1)", "abs(pixel - .5) * 2", "-(-pixel)",
            "min(max(pixel, .25), .75)", "pixel + 0", "pixel * -0.0", "clamp(pixel, 1, 0)",
            "min(3e38 * 3e38 - 3e38 * 3e38, pixel)", "clamp(3e38 * pixel * 3e38, 0, 1)"
        };
        std::mt19937 random(12345);
        auto generate = [&](auto&& self, int depth) -> std::string {
            if (!depth) return random() % 2 ? "pixel" : std::to_string(static_cast<float>(random() % 41) / 10 - 2);
            auto left = self(self, depth - 1), right = self(self, depth - 1);
            switch (random() % 7) {
                case 0: return "(" + left + " + " + right + ")";
                case 1: return "(" + left + " - " + right + ")";
                case 2: return "(" + left + " * " + right + ")";
                case 3: return "min(" + left + ", " + right + ")";
                case 4: return "max(" + left + ", " + right + ")";
                case 5: return "abs(" + left + ")";
                default: return "clamp(" + left + ", 0, 1)";
            }
        };
        for (int i = 0; i < 120; ++i) formulas.push_back(generate(generate, 3));
        std::vector<float> inputs = {0.0f, -0.0f, 1.0f, 0.5f, std::numeric_limits<float>::denorm_min(), std::numeric_limits<float>::min()};
        for (int i = 0; i <= 255; ++i) inputs.push_back(static_cast<float>(i) / 255);
        for (int i = 0; i < 128; ++i) inputs.push_back(static_cast<float>(random() % 100000) / 100000);
        for (const auto& source : formulas) {
            auto c = compile(source);
            for (float pixel : inputs) {
                float reference = evaluate(c.original, pixel);
                check(equal(reference, evaluate(c.optimized, pixel)), "Optimizer changed result: " + source);
                check(equal(reference, execute_ir(c.ir, pixel).back()), "IR changed result: " + source);
            }
            auto lines = c.ptx.text;
            for (std::size_t i = 0; i < c.ir.size(); ++i) {
                check(c.ir[i].span.end <= source.size(), "Source mapping range");
                check(c.ptx.instruction_lines[i] > 0, "PTX line mapping");
            }
        }
        // Arbitrary invalid input must produce diagnostics, never walk beyond tokens.
        const std::string alphabet = "pixelout=;()+-*.,0123 abc\n";
        for (int i = 0; i < 1500; ++i) {
            std::string source;
            for (unsigned n = random() % 80; n; --n) source += alphabet[random() % alphabet.size()];
            try { compile(source); } catch (const Diagnostic&) {}
        }
        std::cout << checks << " checks passed across " << formulas.size() << " filters; 1500 parser fuzz cases.\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
