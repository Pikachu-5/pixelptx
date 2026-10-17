#pragma once
#include <cstddef>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace pixelptx {
struct Span { std::size_t start{}, end{}; };
struct Diagnostic : std::runtime_error {
    Span span;
    Diagnostic(std::string message, Span location) : std::runtime_error(std::move(message)), span(location) {}
};
enum class Op { Constant, Pixel, Add, Sub, Mul, Neg, Min, Max, Abs, Clamp };
struct Node {
    Op op;
    float value{};
    Span span;
    std::vector<std::shared_ptr<Node>> children;
};
using Expr = std::shared_ptr<Node>;
struct Rewrite { std::string rule, before, after; Span span; };
struct Instruction { Op op; int dest; std::vector<int> args; float value; Span span; };
struct Ptx { std::string text; std::vector<int> instruction_lines; };
struct Compilation {
    std::string source;
    Expr original, optimized;
    std::vector<Rewrite> rewrites;
    std::vector<Instruction> before_ir, ir;
    Ptx before_ptx, ptx;
};
std::string op_name(Op op);
std::string expression(const Expr& node);
std::string json_quote(const std::string& value);
Compilation compile(const std::string& source);
float evaluate(const Expr& node, float pixel);
std::vector<float> execute_ir(const std::vector<Instruction>& ir, float pixel);
std::string compilation_json(const Compilation& compilation);
std::string float_json(float value);
}
