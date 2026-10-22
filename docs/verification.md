# Verification — initial local release

Verified on Windows with GCC 13.2, CMake 3.29.2, Ninja, Node.js, NVIDIA PTXAS 13.4.59 and nvdisasm 13.4.49. NVIDIA tools were fetched from the official CUDA 13.4.1 redistributable manifest and SHA-256 verified. No NVIDIA GPU or graphics driver was installed for this project.

## Automated checks

- `npm test`: C++ correctness suite plus 20 HTTP/Azure lifecycle integration tests passed (8 local HTTP tests and 12 Azure transport/lifecycle tests).
- C++ suite: **106,925 checks**, **134 filters** (including seeded generated expressions), **1,500 parser fuzz inputs**.
- Original AST, optimized AST and register IR were compared bit-for-bit, treating all NaNs as equivalent; selected expected outputs and signed-zero/subnormal cases were checked.
- NVIDIA PTXAS accepted original and optimized kernels for nine supported-operation examples; the HTTP assembly test additionally checked a real ELF CUBIN and SASS.
- `npm run check`: browser and server JavaScript syntax passed.
- `node scripts/tokens.mjs --check`: generated CSS matches DESIGN.md.
- Official `designmd lint DESIGN.md`: zero errors; schema orphan-token warnings reflect CSS token consumption outside the component map.
- Frontend premium strict static audit: zero findings. This does not constitute a full accessibility certification.

## Browser checks

The local browser successfully ran the compiler and compared **232,320 channels** in the synthetic scene with zero AST/IR mismatches. Verified:

- Original and optimized AST switching and node-to-source selection.
- Constant-folding preset and recorded rewrites.
- IR register stepping and displayed values.
- Generated PTX instruction-to-source selection.
- Invalid source diagnostic, keyboard compilation, correction, and recovery.
- Disabled exports after source changes.
- Actual PTXAS assembly, CUBIN availability, resource log, and SASS.
- Presentation mode toggle.
- Tab from source reaches Compile; Shift+Tab returns to source. A focus trap found in review was fixed.
- Local PNG upload using a 2×2 RGBA fixture; **12 channels** processed with zero mismatches.
- PTX and output PNG exports completed successfully through the browser download flow.
- Desktop and 390px-wide mobile screenshots; no document-wide horizontal overflow on mobile. Stage navigation and large code/tree surfaces intentionally scroll internally.
- Browser console returned no errors or warnings during the checked flows.

Screenshots are in `.impeccable/review/desktop.png` and `mobile.png`. A fresh reviewer inspected source and screenshot evidence and cleared the keyboard fix within the local-demo scope.

## NVIDIA hardware execution — October 21, 2026

The browser's explicit GPU action completed a real Azure Batch Spot execution on a Tesla T4 (compute capability 7.5, CUDA Driver API version 13000). The 352 × 220 synthetic brightness image was executed using both original and optimized PTX, **232,320 channels each**, with zero mismatches against the original AST and zero output-guard errors.

The same C++ runner executed **15 expressions × 5 channel counts × 2 PTX variants = 150 additional launches**, checking **53,820 outputs** with zero mismatches and zero guard errors. Counts were 1, 255, 256, 257, and 1025; inputs included signed zero and a subnormal value. Overall: **518,460 GPU/CPU comparisons**, zero mismatches. This is evidence for these cases, not a proof for all expressions or IEEE exception behavior.

Both image kernels used 10 physical registers per thread. Single CUDA-event intervals were 0.039808 ms (original) and 0.019264 ms (optimized). This uncontrolled single-launch observation is **not** a speedup claim; original/optimized launch order, driver state, JIT, and caching differ. Module-load/JIT wall time was measured separately. Startup, image transfer, and cloud provisioning are excluded from kernel intervals.

Run ID: `336e8715-7125-43cc-9903-d6e2f91760c6`. Optimized PTX SHA-256: `518aebf1f1a24be26ffd50018a422e2230c83af67a01f950c366ea55c04d51b3`. The local run manifest retains hardware diagnostics and confirmed cleanup under ignored `.artifacts/azure-runs/`; it does not retain image channels. All integration-test resource groups were deleted. Final inventory evidence is in `.artifacts/azure-final-cleanup.json`; the browser proof is `.artifacts/gpu-execution.png`.

The integration also exercised real preflight failures, automatic cleanup, visible cleanup failure handling, and restart recovery of a zero-node pool. Azure returned title-case task creation status values; the client now normalizes enum casing. Full images are transferred in small task collections to respect service size/latency limits. Job/task schemas are validated before requesting paid nodes.

Browser checks confirmed that editing/presets keep local CPU execution independent, label the captured GPU image as a previous run, and restore its current label when the original filter returns. The GPU result is displayed separately with its own PNG export and diagnostic evidence. Browser console checks returned no errors/warnings. The checked 738px viewport had no document-wide horizontal overflow.

## Not verified

Device linking, source-level CUDA debugging, architectures other than the T4/sm_75, controlled hardware performance comparisons, a complete IEEE exception/NaN-payload model, and exhaustive GPU differential testing. PTXAS acceptance and local AST/IR agreement alone do not establish hardware correctness.
