#include "pixelptx/compiler.hpp"
#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <limits>
#include <sstream>
#include <unordered_map>

namespace pixelptx {
namespace {
enum class Kind { Number, Identifier, Plus, Minus, Star, LParen, RParen, Comma, Equal, Semi, End };
struct Token { Kind kind; std::string text; Span span; float value{}; };
bool digit(char c) { return c >= '0' && c <= '9'; }
bool letter(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; }
std::vector<Token> lex(const std::string& source) {
    std::vector<Token> tokens;
    std::size_t i = 0;
    while (i < source.size()) {
        char c = source[i];
        if (c == ' ' || c == '\n' || c == '\r' || c == '\t') { ++i; continue; }
        if (c == '/' && i + 1 < source.size() && source[i + 1] == '/') {
            while (i < source.size() && source[i] != '\n') ++i;
            continue;
        }
        auto start = i;
        if (digit(c) || c == '.') {
            bool seen_digit = false;
            while (i < source.size() && digit(source[i])) { seen_digit = true; ++i; }
            if (i < source.size() && source[i] == '.') {
                ++i;
                while (i < source.size() && digit(source[i])) { seen_digit = true; ++i; }
            }
            if (!seen_digit) throw Diagnostic("Expected digits in a number.", {start, i});
            if (i < source.size() && (source[i] == 'e' || source[i] == 'E')) {
                ++i;
                if (i < source.size() && (source[i] == '+' || source[i] == '-')) ++i;
                auto exponent = i;
                while (i < source.size() && digit(source[i])) ++i;
                if (i == exponent) throw Diagnostic("Expected digits after the exponent.", {start, i});
            }
            auto text = source.substr(start, i - start);
            char* end = nullptr;
            float value = std::strtof(text.c_str(), &end);
            if (!std::isfinite(value)) throw Diagnostic("Number is outside the finite float32 range.", {start, i});
            tokens.push_back({Kind::Number, text, {start, i}, value});
        } else if (letter(c)) {
            while (i < source.size() && (letter(source[i]) || digit(source[i]))) ++i;
            tokens.push_back({Kind::Identifier, source.substr(start, i - start), {start, i}});
        } else {
            Kind kind;
            switch (c) {
                case '+': kind = Kind::Plus; break; case '-': kind = Kind::Minus; break;
                case '*': kind = Kind::Star; break; case '(': kind = Kind::LParen; break;
                case ')': kind = Kind::RParen; break; case ',': kind = Kind::Comma; break;
                case '=': kind = Kind::Equal; break; case ';': kind = Kind::Semi; break;
                default: throw Diagnostic("Unexpected character '" + std::string(1, c) + "'. Use +, -, *, clamp, min, max, or abs.", {i, i + 1});
            }
            ++i;
            tokens.push_back({kind, std::string(1, c), {start, i}});
        }
    }
    tokens.push_back({Kind::End, "", {source.size(), source.size()}});
    return tokens;
}
class Parser {
    std::vector<Token> tokens;
    std::size_t pos = 0, nodes = 0;
    int depth = 0;
    const Token& peek() const { return tokens[pos]; }
    Token take() { return tokens[pos++]; }
    bool accept(Kind kind) { if (peek().kind != kind) return false; ++pos; return true; }
    Token require(Kind kind, const std::string& message) {
        if (peek().kind != kind) throw Diagnostic(message, peek().span);
        return take();
    }
    Expr make(Op op, float value, Span span, std::vector<Expr> children = {}) {
        if (++nodes > 256) throw Diagnostic("Filter is too large; use at most 256 expression nodes.", span);
        return std::make_shared<Node>(Node{op, value, span, std::move(children)});
    }
    Expr primary() {
        if (++depth > 48) throw Diagnostic("Expression nesting exceeds 48 levels.", peek().span);
        auto result = primary_inner();
        --depth;
        return result;
    }
    Expr primary_inner() {
        auto token = take();
        if (token.kind == Kind::Number) return make(Op::Constant, token.value, token.span);
        if (token.kind == Kind::Minus || token.kind == Kind::Plus) {
            auto child = primary();
            if (token.kind == Kind::Plus) return child;
            return make(Op::Neg, 0, {token.span.start, child->span.end}, {child});
        }
        if (token.kind == Kind::LParen) {
            auto child = addition();
            require(Kind::RParen, "Expected ')' to close the expression.");
            return child;
        }
        if (token.kind == Kind::Identifier) {
            if (token.text == "pixel") return make(Op::Pixel, 0, token.span);
            const std::unordered_map<std::string, std::pair<Op, int>> functions = {
                {"clamp", {Op::Clamp, 3}}, {"min", {Op::Min, 2}},
                {"max", {Op::Max, 2}}, {"abs", {Op::Abs, 1}}
            };
            auto fn = functions.find(token.text);
            if (fn == functions.end()) throw Diagnostic("Unknown name '" + token.text + "'. The input variable is pixel.", token.span);
            require(Kind::LParen, "Expected '(' after " + token.text + ".");
            std::vector<Expr> args;
            for (int n = 0; n < fn->second.second; ++n) {
                if (n) require(Kind::Comma, token.text + " expects " + std::to_string(fn->second.second) + " arguments separated by commas.");
                args.push_back(addition());
            }
            auto close = require(Kind::RParen, "Expected ')' after " + std::to_string(fn->second.second) + " arguments to " + token.text + ".");
            return make(fn->second.first, 0, {token.span.start, close.span.end}, std::move(args));
        }
        throw Diagnostic("Expected a number, pixel, a function call, or '('.", token.span);
    }
    Expr multiply() {
        auto left = primary();
        while (accept(Kind::Star)) {
            auto right = primary();
            left = make(Op::Mul, 0, {left->span.start, right->span.end}, {left, right});
        }
        return left;
    }
    Expr addition() {
        auto left = multiply();
        while (peek().kind == Kind::Plus || peek().kind == Kind::Minus) {
            auto op = take().kind == Kind::Plus ? Op::Add : Op::Sub;
            auto right = multiply();
            left = make(op, 0, {left->span.start, right->span.end}, {left, right});
        }
        return left;
    }
public:
    explicit Parser(const std::string& source) : tokens(lex(source)) {}
    Expr parse() {
        if (peek().kind == Kind::Identifier && peek().text == "out") {
            take(); require(Kind::Equal, "Expected '=' after out.");
        }
        auto result = addition();
        accept(Kind::Semi);
        require(Kind::End, "Unexpected input after the filter. Use a single expression or out = expression;.");
        return result;
    }
};
float minimum(float a, float b) {
    if (std::isnan(a)) return b;
    if (std::isnan(b)) return a;
    if (a == 0 && b == 0) return (std::signbit(a) || std::signbit(b)) ? -0.0f : 0.0f;
    return a < b ? a : b;
}
float maximum(float a, float b) {
    if (std::isnan(a)) return b;
    if (std::isnan(b)) return a;
    if (a == 0 && b == 0) return (std::signbit(a) && std::signbit(b)) ? -0.0f : 0.0f;
    return a > b ? a : b;
}
float evaluate_operation(Op op, const std::vector<float>& a) {
    switch (op) {
        case Op::Add: return a[0] + a[1]; case Op::Sub: return a[0] - a[1];
        case Op::Mul: return a[0] * a[1]; case Op::Neg: return -a[0];
        case Op::Min: return minimum(a[0], a[1]); case Op::Max: return maximum(a[0], a[1]);
        case Op::Abs: return std::fabs(a[0]);
        case Op::Clamp: return minimum(maximum(a[0], a[1]), a[2]);
        default: throw std::logic_error("Not an arithmetic operation");
    }
}
Expr optimize(const Expr& node, std::vector<Rewrite>& rewrites) {
    auto result = std::make_shared<Node>(*node);
    for (auto& child : result->children) child = optimize(child, rewrites);
    auto replace = [&](Expr replacement, const std::string& rule) {
        rewrites.push_back({rule, expression(result), expression(replacement), result->span});
        return replacement;
    };
    if (!result->children.empty() && std::all_of(result->children.begin(), result->children.end(),
            [](const Expr& child) { return child->op == Op::Constant; })) {
        auto value = evaluate(result, 0);
        if (std::isfinite(value)) return replace(std::make_shared<Node>(Node{Op::Constant, value, result->span, {}}), "Constant folding");
    }
    if (result->op == Op::Mul) {
        for (int i = 0; i < 2; ++i) {
            auto constant = result->children[i];
            if (constant->op == Op::Constant && constant->value == 1.0f)
                return replace(result->children[1 - i], "Multiplicative identity");
        }
    }
    if (result->op == Op::Neg && result->children[0]->op == Op::Neg)
        return replace(result->children[0]->children[0], "Double negation");
    return result;
}
int lower(const Expr& node, std::vector<Instruction>& ir) {
    std::vector<int> args;
    for (const auto& child : node->children) args.push_back(lower(child, ir));
    int dest = static_cast<int>(ir.size());
    ir.push_back({node->op, dest, std::move(args), node->value, node->span});
    return dest;
}
std::string immediate(float value) {
    std::ostringstream out;
    out << "0f" << std::uppercase << std::hex << std::setfill('0') << std::setw(8) << std::bit_cast<std::uint32_t>(value);
    return out.str();
}
std::vector<std::string> instruction_ptx(const Instruction& inst) {
    auto dest = "%f" + std::to_string(inst.dest);
    auto arg = [&](int n) { return "%f" + std::to_string(inst.args[n]); };
    switch (inst.op) {
        case Op::Constant: return {"mov.f32 " + dest + ", " + immediate(inst.value) + ";"};
        case Op::Pixel: return {"ld.global.f32 " + dest + ", [%rd4];"};
        case Op::Neg: return {"neg.f32 " + dest + ", " + arg(0) + ";"};
        case Op::Abs: return {"abs.f32 " + dest + ", " + arg(0) + ";"};
        case Op::Clamp: return {"max.f32 " + dest + ", " + arg(0) + ", " + arg(1) + ";",
                                "min.f32 " + dest + ", " + dest + ", " + arg(2) + ";"};
        default: {
            auto name = op_name(inst.op);
            auto suffix = (inst.op == Op::Add || inst.op == Op::Sub || inst.op == Op::Mul) ? ".rn.f32 " : ".f32 ";
            return {name + suffix + dest + ", " + arg(0) + ", " + arg(1) + ";"};
        }
    }
}
Ptx emit(const std::vector<Instruction>& ir) {
    std::vector<std::string> lines = {
        "// Generated by PixelPTX. One thread per float channel.", ".version 7.0", ".target sm_75", ".address_size 64", "",
        ".visible .entry pixel_filter(", "    .param .u64 input_ptr,", "    .param .u64 output_ptr,", "    .param .u32 count", ")", "{",
        "    .reg .pred %p;", "    .reg .b32 %r<5>;", "    .reg .b64 %rd<6>;",
        "    .reg .f32 %f<" + std::to_string(ir.size()) + ">;", "",
        "    ld.param.u64 %rd0, [input_ptr];", "    ld.param.u64 %rd1, [output_ptr];", "    ld.param.u32 %r0, [count];",
        "    mov.u32 %r1, %ctaid.x;", "    mov.u32 %r2, %ntid.x;", "    mov.u32 %r3, %tid.x;",
        "    mad.lo.u32 %r4, %r1, %r2, %r3;", "    setp.ge.u32 %p, %r4, %r0;", "    @%p bra DONE;", "",
        "    cvta.to.global.u64 %rd0, %rd0;", "    cvta.to.global.u64 %rd1, %rd1;",
        "    mul.wide.u32 %rd2, %r4, 4;", "    add.u64 %rd4, %rd0, %rd2;", "    add.u64 %rd5, %rd1, %rd2;", ""
    };
    Ptx result;
    for (const auto& inst : ir) {
        result.instruction_lines.push_back(static_cast<int>(lines.size() + 1));
        for (const auto& line : instruction_ptx(inst)) lines.push_back("    " + line);
    }
    lines.push_back("    st.global.f32 [%rd5], %f" + std::to_string(ir.back().dest) + ";");
    lines.insert(lines.end(), {"", "DONE:", "    ret;", "}"});
    for (const auto& line : lines) result.text += line + "\n";
    return result;
}
std::string ast_json(const Expr& node, int& id) {
    int own_id = id++;
    std::string result = "{\"id\":" + std::to_string(own_id) + ",\"op\":" + json_quote(op_name(node->op)) +
        ",\"label\":" + json_quote(node->op == Op::Constant ? float_json(node->value) : op_name(node->op)) +
        ",\"start\":" + std::to_string(node->span.start) + ",\"end\":" + std::to_string(node->span.end) + ",\"children\":[";
    for (std::size_t i = 0; i < node->children.size(); ++i) { if (i) result += ','; result += ast_json(node->children[i], id); }
    return result + "]}";
}
std::string ir_json(const std::vector<Instruction>& ir, const Ptx& ptx) {
    std::string result = "[";
    for (std::size_t i = 0; i < ir.size(); ++i) {
        const auto& inst = ir[i];
        if (i) result += ',';
        result += "{\"dest\":" + std::to_string(inst.dest) + ",\"op\":" + json_quote(op_name(inst.op)) +
            ",\"value\":" + float_json(inst.value) + ",\"start\":" + std::to_string(inst.span.start) +
            ",\"end\":" + std::to_string(inst.span.end) + ",\"line\":" + std::to_string(ptx.instruction_lines[i]) + ",\"args\":[";
        for (std::size_t j = 0; j < inst.args.size(); ++j) { if (j) result += ','; result += std::to_string(inst.args[j]); }
        result += "]}";
    }
    return result + "]";
}
}
std::string op_name(Op op) {
    switch (op) {
        case Op::Constant: return "const"; case Op::Pixel: return "pixel";
        case Op::Add: return "add"; case Op::Sub: return "sub"; case Op::Mul: return "mul";
        case Op::Neg: return "neg"; case Op::Min: return "min"; case Op::Max: return "max";
        case Op::Abs: return "abs"; case Op::Clamp: return "clamp";
    }
    throw std::logic_error("Unknown op");
}
std::string float_json(float value) {
    if (!std::isfinite(value)) return "null";
    if (value == 0) return std::signbit(value) ? "-0.0" : "0.0";
    std::ostringstream out;
    out << std::setprecision(std::numeric_limits<float>::max_digits10) << value;
    return out.str();
}
std::string expression(const Expr& node) {
    if (node->op == Op::Constant) return float_json(node->value);
    if (node->op == Op::Pixel) return "pixel";
    if (node->op == Op::Neg) return "(-" + expression(node->children[0]) + ")";
    if (node->op == Op::Add || node->op == Op::Sub || node->op == Op::Mul) {
        auto symbol = node->op == Op::Add ? " + " : (node->op == Op::Sub ? " - " : " * ");
        return "(" + expression(node->children[0]) + symbol + expression(node->children[1]) + ")";
    }
    std::string result = op_name(node->op) + "(";
    for (std::size_t i = 0; i < node->children.size(); ++i) { if (i) result += ", "; result += expression(node->children[i]); }
    return result + ")";
}
std::string json_quote(const std::string& value) {
    std::ostringstream out;
    out << '"';
    for (unsigned char c : value) {
        switch (c) {
            case '"': out << "\\\""; break; case '\\': out << "\\\\"; break;
            case '\n': out << "\\n"; break; case '\r': out << "\\r"; break; case '\t': out << "\\t"; break;
            default: if (c < 32) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c); else out << c;
        }
    }
    out << '"';
    return out.str();
}
Compilation compile(const std::string& source) {
    if (source.size() > 8192) throw Diagnostic("Filter source exceeds 8192 bytes.", {0, source.size()});
    Compilation result;
    result.source = source;
    result.original = Parser(source).parse();
    result.optimized = optimize(result.original, result.rewrites);
    lower(result.original, result.before_ir);
    lower(result.optimized, result.ir);
    result.before_ptx = emit(result.before_ir);
    result.ptx = emit(result.ir);
    return result;
}
float evaluate(const Expr& node, float pixel) {
    if (node->op == Op::Constant) return node->value;
    if (node->op == Op::Pixel) return pixel;
    std::vector<float> args;
    for (const auto& child : node->children) args.push_back(evaluate(child, pixel));
    return evaluate_operation(node->op, args);
}
std::vector<float> execute_ir(const std::vector<Instruction>& ir, float pixel) {
    std::vector<float> registers(ir.size());
    for (const auto& inst : ir) {
        if (inst.op == Op::Constant) registers[inst.dest] = inst.value;
        else if (inst.op == Op::Pixel) registers[inst.dest] = pixel;
        else {
            std::vector<float> args;
            for (auto index : inst.args) args.push_back(registers[index]);
            registers[inst.dest] = evaluate_operation(inst.op, args);
        }
    }
    return registers;
}
std::string compilation_json(const Compilation& c) {
    int before_id = 0, after_id = 0;
    std::string result = "{\"ok\":true,\"source\":" + json_quote(c.source) + ",\"expression\":" + json_quote(expression(c.original)) +
        ",\"optimized\":" + json_quote(expression(c.optimized)) + ",\"ast\":" + ast_json(c.original, before_id) +
        ",\"optimizedAst\":" + ast_json(c.optimized, after_id) + ",\"ir\":" + ir_json(c.ir, c.ptx) +
        ",\"beforeIr\":" + ir_json(c.before_ir, c.before_ptx) + ",\"ptx\":" + json_quote(c.ptx.text) +
        ",\"beforePtx\":" + json_quote(c.before_ptx.text) + ",\"rewrites\":[";
    for (std::size_t i = 0; i < c.rewrites.size(); ++i) {
        if (i) result += ',';
        const auto& rule = c.rewrites[i];
        result += "{\"rule\":" + json_quote(rule.rule) + ",\"before\":" + json_quote(rule.before) + ",\"after\":" +
            json_quote(rule.after) + ",\"start\":" + std::to_string(rule.span.start) + ",\"end\":" + std::to_string(rule.span.end) + "}";
    }
    auto count_ptx = [](const std::vector<Instruction>& ir) {
        std::size_t count = 0;
        for (const auto& inst : ir) count += instruction_ptx(inst).size();
        return count;
    };
    result += "],\"stats\":{\"beforeNodes\":" + std::to_string(before_id) + ",\"afterNodes\":" + std::to_string(after_id) +
        ",\"beforeInstructions\":" + std::to_string(count_ptx(c.before_ir)) + ",\"afterInstructions\":" +
        std::to_string(count_ptx(c.ir)) + "},\"curve\":[";
    for (int i = 0; i <= 100; ++i) {
        if (i) result += ',';
        result += float_json(evaluate(c.optimized, static_cast<float>(i) / 100.0f));
    }
    return result + "]}";
}
}
