# PixelPTX interaction contract

Source of product facts: PRODUCT.md, derived from the user's PixelPTX brief and explicit local-first request.

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Form | web/app.js compile flow | PRODUCT.md | compile, presets | API and browser checks |
| Scrollbar | web/styles.css global rules | DESIGN.md | code geometry | browser checks |
| Toast | status() in web/app.js | this contract | info, error | browser checks |
| Stage navigation | renderStage() in web/app.js | this contract | AST, optimizer, IR, PTX, binary | browser checks |
| GPU execution | web/gpu.js + scripts/azure.mjs | user's on-demand Azure decision | start, cancel, check status, retry cleanup | Azure lifecycle tests + hardware check |

Compile is explicit (button or Ctrl/Cmd+Enter). Editing marks outputs stale, disables export, and preserves the last output with a visible stale label. Each successful compilation uses the C++ compiler. Rendering runs optimized IR on the CPU and compares against the original AST per float channel; it does not validate PTX hardware execution. Presets update source and compile. Background responses carry revision guards; older compile, render, trace, or assembly results cannot overwrite newer source.

Errors preserve source and show location text, aria-invalid, and a source selection. App-owned requests have bounded deadlines and recoverable messages. Local status and GPU run status each have one scoped live region. Busy controls keep their footprint. Images are decoded in the browser and local preview channel data is posted to the loopback C++ service. Source is saved locally in browser storage when available.

GPU execution is a separate explicit mutation. Its native checkbox acknowledges image/filter upload and Azure charges before Run on Azure GPU becomes enabled. Editing, presets, compilation, image changes, page load, refresh, and status polling never create compute. The server compiles source itself and sends its exact original/optimized PTX, selected compiler sources, and RGB bytes over authenticated Azure Batch REST. No public image URL, storage account, shared key, or SAS token is created. Azure CLI supplies short-lived Entra tokens to the server; credentials never reach the browser. Cloud input exists in the temporary Batch task settings and node files until deletion.

Each run requests at most one Spot T4 and zero dedicated nodes. The server owns the job independently of the tab, enforces a 15-minute attempt deadline, and deletes the exact tagged resource group after success, failure, or cancellation. Cloud autoscaling independently requests zero nodes after expiry, on a five-minute evaluation interval; deletion/scale-down delays mean this is not a hard spending cap. A durable local manifest supports recovery cleanup after server restart. A filesystem owner lock and request IDs prevent duplicate cloud runs. Unconfirmed cleanup blocks new compute and provides Retry cleanup. Never show GPU off until deletion is confirmed. A failed status request preserves the run and offers reconnection rather than another start.

GPU results have a separate canvas and PNG export. Changes to source/image mark a captured result as a previous run and never replace the current CPU image. A page reconnect can recover an active run; an input not matched after reload is labeled. RGB output is float32 before display clipping; alpha is preserved from the captured input while available and is opaque when no captured alpha exists. GPU image data remains in server/browser memory; only run metadata, source, PTX hash, and diagnostics are retained under .artifacts/azure-runs. Closing the tab does not stop cleanup. Server shutdown attempts cleanup; restart resumes interrupted cleanup.

PTX and CUBIN exports correspond to the current compiled revision. CUBIN is available only after successful assembly. Binary view reports unavailable tooling without blocking the compiler. CPU preview display clips to [0,1], preserves alpha, and reports nonfinite values. RGB channels are independent, in encoded image space; this is not color-managed linear-light processing.

Language is English; numbers use English decimal syntax. Run evidence timestamps use explicitly labeled UTC ISO strings. Canvas output has accessible descriptions. Diagram nodes and code rows have keyboard actions and source-range labels. GPU stages use a semantic ordered list with the current step marked. No equivalent sibling flow existed at project creation; all stages share the existing button, panel, status, and token conventions.
