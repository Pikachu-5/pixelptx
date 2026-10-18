# Architecture and engineering notes

## Compilation

The lexer produces source-spanned tokens, followed by a recursive descent parser: multiplication binds tighter than addition/subtraction; unary operators bind tighter than multiplication. Binary operators associate left. Function arity and variable names are checked in the parser because the language has a single float32 value type. Nodes retain half-open source spans [start,end).

The optimizer clones the tree, rewrites children first, and records each successful rewrite. It never mutates the original AST. Constant folding computes float32 operations under the same rounding environment as the CPU reference. Overflowing/nonfinite constant expressions remain in the tree. Multiplication by exactly 1 and double negation are removed. NaN bit patterns and exception flags are outside the language contract; signed-zero result bits are within it.

Lowering performs a postorder traversal. Every node produces one virtual float register. IR is a straight-line program, not SSA across a control-flow graph: there are no user branches, loops, variables, phi nodes, or register allocation. A clamp IR instruction expands to two PTX instructions. Constants are explicit mov instructions, deliberately keeping the educational lowering visible; NVIDIA's backend may remove moves or fold immediates.

The CPU interpreter executes IR into a register vector. The independent execution order of the original AST supplies a reference. Both share primitive operation semantics, so the comparison is useful for transformation/IR-order defects but cannot detect a bug shared by those primitives. Additional expected-output and signed-zero tests check selected primitives.

## PTX kernel ABI

`pixel_filter(input_ptr: u64, output_ptr: u64, count: u32)` uses device buffers of scalar float32 channels. Launch one 1D grid with, for example, 256 threads per block and ceil(count/256) blocks. Each thread computes `blockIdx.x * blockDim.x + threadIdx.x`, returns when index >= count, converts generic pointers to global pointers, computes a byte offset with `mul.wide.u32`, loads input, evaluates the expression, and stores output.

The interface deliberately says one thread per **channel**, rather than one thread per RGB pixel. Pointer parameters are generic CUDA kernel pointers and converted with `cvta.to.global`. The caller will allocate count*sizeof(float) bytes and enforce launch/count bounds. The initial UI limits are well below any 32-bit indexing overflow; a future runtime must validate its full launch geometry.

`.version 7.0`, `.target sm_75`, and `.address_size 64` are emitted explicitly. Float literals use exact hexadecimal IEEE-754 encodings through `std::bit_cast`. Arithmetic emits add.rn.f32/sub.rn.f32/mul.rn.f32, with no explicit FMA. There are no `.ftz` flags. The target is intentionally fixed in this first version rather than claiming untested target portability.

`Ptx.instruction_lines` maps IR destinations to the first emitted PTX line; clamp maps to two adjacent lines in the UI. This is an application source map, not DWARF or CUDA debugger metadata. Actual `.file`/`.loc` metadata is a future extension.

## Local integration

The Node standard-library service spawns the built C++ CLI without a shell. Compilation reads source on stdin and returns JSON. Running uses a length-prefixed source followed by a count and normalized channel values. The C++ process compiles once per request; it interprets optimized IR and compares against the original AST for each channel. This makes ownership of compilation/evaluation explicit, at the cost of per-request process and parsing overhead.

The service binds only to 127.0.0.1, rejects non-loopback Host values and mismatched browser Origins, limits source/body/channel sizes and concurrent processes, and sets subprocess timeouts. It serves an explicit static-file allowlist. This is a local development tool, not a production multi-user server. Preview images remain local; only an explicitly acknowledged cloud run sends image data to Azure.

The binary endpoint generates PTX itself from source; it does not accept arbitrary commands or paths. It writes a temporary PTX, invokes an explicitly found ptxas with fixed arguments, reads the ELF CUBIN, and optionally invokes nvdisasm. Temporary artifacts are removed. Binary bytes are returned for download. No CUDA Driver context is created.

## Optional NVIDIA runtime

`src/gpu_main.cpp` is a C++ CUDA Driver API client. It retains the device primary context, loads exact generated PTX with `cuModuleLoadDataEx` and JIT log buffers, resolves `pixel_filter`, allocates device buffers, copies input, records CUDA events around a 256-thread launch, synchronizes, and reads back output. RAII releases modules, allocations, events, and context. Original and optimized PTX both run against the original AST reference; NaNs compare as equivalent, all other results compare bit-for-bit, including signed zero. Sixteen guard values detect output writes past the requested count.

The runner also exercises 15 expressions across counts 1, 255, 256, 257, and 1025, with both compilation variants. Inputs include signed zero and subnormal values. CUDA event intervals measure individual launches; they are not a speedup benchmark. Physical register counts come from `cuFuncGetAttribute`, rather than PTX virtual register counts.

`scripts/azure.mjs` owns the optional on-demand lifecycle. Azure CLI provides short-lived Entra tokens; Node calls the authenticated management and Batch APIs. A small startup bundle builds the C++ runner on the Ubuntu HPC image. Bounded native Batch tasks transfer image chunks through their task definitions; a dependent execution task reconstructs RGB input and invokes the runner. This avoids a storage account, public upload endpoint, shared keys, or SAS credentials. The full generated PTX is checked against a recompilation before loading it.

Only one local server can own cloud work, using a filesystem lock. Run request IDs deduplicate submissions; tagged, per-run resource groups constrain cleanup. An attempt deadline and a separate Batch autoscale rule request zero Spot nodes after expiry. The server always attempts group deletion and waits for a confirmed absence. Cancellation, normal shutdown, and startup recovery use that same cleanup. Unconfirmed cleanup blocks another run. Image values remain in memory; only metadata, source, PTX hashes, and diagnostics are retained locally. See [Azure lifecycle details](azure-gpu.md).

## Scope and next steps

Implemented: front end, conservative optimization, linear IR, PTX emission, source mapping, CPU preview/validation, optional offline NVIDIA compilation/disassembly, and optional on-demand CUDA Driver API execution with differential checks.

Follow-up work: device helper linkage through nvJitLink; `.file`/`.loc` metadata; multi-target compilation; and controlled benchmark methodology.

GPU tests must compare original AST reference with actual device output before claiming PTX correctness. Backend acceptance alone is insufficient. CPU trace values never establish warp behavior, register allocation performance, occupancy, memory coalescing, or speedup.
