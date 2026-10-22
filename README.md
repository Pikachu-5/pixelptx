# PixelPTX

A C++20 compiler for a tiny image-filter language, with a local visual compiler explorer. Built to study language front ends, optimization, PTX generation, NVIDIA binary tools, and the boundary between compilation and execution.

```cpp
out = clamp(pixel * 1.0 + (0.1 + 0.15), 0.0, 1.0);
```

The compiler parses this source, records constant folding and multiplicative identity rewrites, lowers an optimized expression into register IR, and emits a complete NVIDIA PTX kernel. No LLVM, predefined GPU filters, or JavaScript compiler is involved.

## Run locally

Requirements: Node.js 20+ (22+ recommended), CMake 3.20+, and a C++20 compiler. No npm packages are required. This workspace was built with MinGW GCC 13.2 and Ninja on Windows. With Visual Studio, use a Developer PowerShell and a supported C++ workload.

```powershell
npm run dev
```

Open **http://127.0.0.1:4173**. Subsequent launches can use `npm start`. To use another port: `$env:PORT=4174; npm start`.

If PowerShell blocks `npm.ps1`, use `npm.cmd run dev` instead. A clean build can be configured explicitly:

```powershell
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build --output-on-failure
node scripts/server.mjs
```

For Visual Studio's CMake generator, omit `-G Ninja` and build with `--config Release`. The server finds either build layout. Changing compilers requires a fresh build directory.

## The visual demo

- Source editor with working brightness, contrast, invert, and constant-folding presets.
- Original and transformed images; open a local PNG, JPEG, or WebP and export the result.
- Original and optimized ASTs. Select nodes to locate source expressions.
- Recorded rewrites, exact float32 constants, and expression instruction counts.
- CPU register IR interpreter with a one-channel probe and step controls.
- Complete original and optimized PTX with source-to-instruction mapping and export.
- Optional NVIDIA PTXAS assembly, CUBIN export, resource logs, and SASS disassembly.
- Presentation layout for exploring the compiler pipeline.

The default scene is a deterministic ray-traced color target generated locally in the browser, labeled synthetic. Images are downsampled for an interactive demo; alpha is preserved. Three independent float channels represent each RGB pixel. Pixel arithmetic operates on encoded channel values; it is not color-managed linear-light processing.

## What works without an NVIDIA GPU?

The compiler, image preview, AST/IR visualization, correctness checks, PTX generation, and offline NVIDIA assembly/disassembly can run without an NVIDIA GPU. The preview executes **register IR on the CPU**, and compares each output against evaluation of the **original AST**.

**The IR interpreter does not interpret PTX.** Agreement between AST and IR does not prove that PTX code generation is correct. PTXAS acceptance validates assembly and target constraints, not GPU execution. Timings in the UI are local process time including IPC, never GPU timings.

The optional [Azure Batch Spot runner](docs/azure-gpu.md) loads the generated PTX with the CUDA Driver API, executes original and optimized kernels on a temporary NVIDIA T4, and compares device output against the original AST. The local preview remains CPU-only. Device linking, CUDA debugger integration, and rigorous performance benchmarking remain future work.

## Run on Azure GPU

Install/sign in with Azure CLI, then configure the subscription locally:

```powershell
npm run azure:configure -- --subscription <subscription-id>
npm start
```

Compile a filter, acknowledge the upload/compute charge in the GPU panel, and click **Run on Azure GPU**. This uploads the displayed RGB image and generated PTX, requests **one Spot T4**, collects the GPU image and correctness report, and deletes the temporary resource group. It uses Azure credit; quota and capacity must be available. The GPU is billed while allocated, including startup, idle time, and deletion. Local editing and **Compile & run** never start cloud compute.

Allocation/build can take minutes. There is a 15-minute attempt deadline, an independent cloud scale-down rule, cancellation, and restart cleanup recovery. Scale-down and deletion are asynchronous, so the deadline is not a hard spending cap. Keep the server running until it confirms deletion; unresolved cleanup is visible and blocks another run. See [configuration, lifecycle, and recovery](docs/azure-gpu.md).

The CUDA runner can also be built separately on a machine with the CUDA Toolkit and an NVIDIA driver, without NVCC:

```powershell
cmake -S . -B build-cuda -DPIXELPTX_ENABLE_CUDA=ON
cmake --build build-cuda --config Release
```

## Optional NVIDIA tools

Use NVIDIA's official CUDA Toolkit, or the optional project-local tool setup script:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-cuda-tools.ps1
```

The script downloads official NVIDIA redistributables into ignored `.tools/`, verifies their SHA-256 hashes using NVIDIA's release manifest, and extracts the command-line compiler tools. It does not install a graphics driver or modify system PATH. NVIDIA's license files are retained. You are responsible for reviewing their terms before distributing NVIDIA tools; they are not part of this project's source.

The server searches `.tools/cuda/bin`, then `CUDA_PATH/bin`, then PATH, on each request. Click **Assemble → Check for tools** after installing.

Generated kernels declare PTX 7.0 and `sm_75` as a conservative initial target. This is an explicit target, not hardware auto-detection. The pinned local tools are CUDA 13.4.1 redistributables; choose an appropriate toolchain and architecture when a real NVIDIA execution environment is added.

Manual inspection:

```powershell
build/pixelptx.exe --ptx examples/brightness.pxp > filter.ptx
ptxas -arch=sm_75 -v filter.ptx -o filter.cubin
nvdisasm filter.cubin
```

On Windows PowerShell 5, `>` may create UTF-16 text. Use the UI's PTX export, PowerShell 7, or `Set-Content -Encoding ascii` for PTX files.

## Language

```ebnf
program = [ "out", "=" ], expression, [ ";" ];
expression = term, { ("+" | "-"), term };
term = unary, { "*", unary };
unary = ("+" | "-"), unary | primary;
primary = number | "pixel" | "(", expression, ")" | call;
call = "abs(", expression, ")"
     | ("min(" | "max("), expression, ",", expression, ")"
     | "clamp(", expression, ",", expression, ",", expression, ")";
```

Decimal literals and exponents are supported; literals round to finite float32. `//` line comments are accepted. Input is one scalar channel in [0,1]. Output can be outside that range; only display/export conversion clips it. `clamp(x,lo,hi)` is precisely `min(max(x,lo),hi)`, even when bounds are reversed. Nonfinite outputs are reported and displayed as black. PTX min/max use their non-NaN-propagating semantics.

Arithmetic uses explicit `.rn.f32` PTX instructions, no multiply-add contraction, no fast-math, and no reassociation. Safe rewrites currently include finite constant folding, multiplication by 1, and double negation. NaN payloads and signaling behavior are not part of the language's observable contract. Signed zero is preserved; unsafe `x + 0`, `x * 0`, and `x - x` rewrites are intentionally absent. See [architecture](docs/architecture.md) for limits and testing boundaries.

Limits: 8192 ASCII source bytes through the UI/API, 256 AST nodes, 48 levels of syntactic nesting, 8 MB request/image size, and 786432 channels per run. The image preview is at most 352×256. The CPU implementation favors readability over throughput.

## Verify

```powershell
npm test
npm run check
node scripts/tokens.mjs --check
```

Tests compare original AST, optimized AST, and IR results bit-for-bit, including signed zero and subnormal cases, plus NaN equivalence. Seeded generated expressions and parser fuzz inputs exercise optimizer and parser behavior. API tests cover source mapping, rendering, trace values, diagnostics, input limits, origin checks, and optional real PTXAS/SASS integration.

## Project map

| Path | Responsibility |
|---|---|
| `include/pixelptx/compiler.hpp` | Compiler data model and public API |
| `src/compiler.cpp` | Lexer, parser, optimizer, IR, CPU evaluation, PTX generation |
| `src/main.cpp` | CLI and renderer protocol |
| `scripts/server.mjs` | Loopback HTTP service and NVIDIA tool integration |
| `web/` | Dependency-free visual workbench |
| `tests/` | C++ differential tests and HTTP integration tests |
| `docs/architecture.md` | Design decisions, ABI, numeric semantics, limitations |

Technical references: [NVIDIA PTX ISA](https://docs.nvidia.com/cuda/parallel-thread-execution/), [CUDA binary utilities](https://docs.nvidia.com/cuda/cuda-binary-utilities/), [CUDA compilation without a local GPU](https://forums.developer.nvidia.com/t/developing-code-in-cuda-in-a-virtual-gpu-or-on-hpc/291099).
