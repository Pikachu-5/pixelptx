# Azure GPU access

On October 21, 2026, a temporary Azure Batch pool successfully allocated one NVIDIA GPU node in Central India. Its startup command returned:

```text
Tesla T4, 580.178.04, 16384 MiB
```

The command was `nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader`, with exit code 0. That initial probe confirmed access to NVIDIA hardware and its driver. The project now includes the on-demand execution path described below; see [verification](verification.md) for actual execution evidence.

## Configuration that worked

| Setting | Value |
| --- | --- |
| Service | Azure Batch |
| Pool allocation mode | BatchService |
| Region | Central India |
| VM size | Standard_NC4as_T4_v3 |
| Target Spot nodes | 1 |
| Target dedicated nodes | 0 |
| Image | microsoft-dsvm:ubuntu-hpc:2404:latest |
| Node agent | batch.node.ubuntu 24.04 |
| Container configuration | DockerCompatible |
| OS disk tier | Standard_LRS |
| Authentication | Microsoft Entra ID (AAD) |

This VM size uses four cores and includes one T4. Batch service mode applies an aggregate core quota to Spot nodes, while dedicated nodes also have per-family quotas. See [Batch quota documentation](https://learn.microsoft.com/en-us/azure/batch/batch-quota-limit).

This result applies to the tested subscription, region, and date. Quotas, offer eligibility, supported images, and available capacity can change. Spot nodes can be evicted; another allocation is not guaranteed. See [Batch Spot behavior](https://learn.microsoft.com/en-us/azure/batch/batch-spot-vms).

## Cost and lifecycle

The live Azure Retail Prices API listed Linux Spot compute at USD 0.164204/hour for this size and region when checked. This is an estimate, not a bill: pricing can change, and OS disks and other resources are additional.

The approved probe requested one Spot node, no dedicated fallback, and a 15-minute attempt window. It finished as soon as the GPU check succeeded and deleted the pool and its temporary resource group. The earlier empty Container Apps and Batch quota probes were also deleted. Both temporary resource groups were confirmed absent at 16:58:56 UTC. No test resources remain. The final cleanup checks and raw evidence are retained locally under ignored `.artifacts/`.

## On-demand execution

Sign in with Azure CLI and configure the subscription:

```powershell
az login
npm run azure:configure -- --subscription <subscription-id>
npm start
```

`azure.local.json` is ignored by Git and stores the subscription ID and fixed Central India/T4 selection, never credentials. The Windows service uses the Python runtime bundled with Azure CLI. For a nonstandard installation set `PIXELPTX_AZURE_PYTHON` to that installation's `python.exe`. Other platforms use `az` from PATH.

Compile locally, acknowledge the upload/compute charge in the GPU panel, and click **Run on Azure GPU**. The GPU stays off during local editing, previews, assembly, and status polling. A run creates its own tagged `pixelptx-run-*` resource group and BatchService account, requests at most one Spot T4 with zero dedicated nodes, builds the C++ runner, uploads bounded RGB chunks as native Batch tasks, and executes the exact generated PTX. The pool uses Ubuntu HPC 24.04; native tasks do not require a container configuration. Four task slots parallelize image transfer on the same four-core VM.

The C++ CUDA Driver API runner JIT-loads original and optimized PTX, launches kernels, checks output against the original AST, checks output guards, and returns GPU event times, physical register counts, JIT logs, a differential test-suite report, and image channels. RGB image dimensions are limited to the same 352 × 256 maximum as the local explorer. The GPU panel has a separate image and PNG export; local CPU preview stays independent.

No Blob Storage account, public image URL, shared key, SAS token, SSH account, or permission grant is needed. Short-lived Entra tokens stay in the local Node process. Compiler sources, filter/PTX, and RGB chunks are present in temporary Batch task definitions and node files until cleanup. Exported evidence identifies the run, source, and SHA-256 of the optimized PTX.

## GPU lifetime and recovery

Spot uses Azure's surplus capacity and can be reclaimed. A kernel finishing does not itself stop billing: the allocated node also incurs cost while starting, building, transferring, waiting, or deleting. See [Spot behavior](https://learn.microsoft.com/en-us/azure/batch/batch-spot-vms).

PixelPTX requests pool deletion followed by deletion of the exact tagged resource group after success, failure, or cancellation, and waits until Azure confirms the group's absence. The UI keeps the deletion state visible until then. There is no automatic dedicated fallback or persistent warm GPU session. Starting another run means another allocation/build cycle, which may take minutes.

The local attempt deadline is 15 minutes from submission. Independently, a cloud autoscale formula requests one Spot node only before that absolute expiry and zero afterward, evaluated every five minutes. The expiry rule does not depend on the laptop staying online. Azure evaluation and scale-down/deletion are asynchronous, so this is not a hard cost cap. An interrupted allocation cannot request new nodes indefinitely after expiry.

Closing the tab does not stop the local server's cleanup. Normal server shutdown attempts cleanup; a server restart recovers unfinished runs from `.artifacts/azure-runs/`. If cleanup is unconfirmed, the UI blocks a new run and offers **Retry cleanup**. To recover without the browser, first stop other PixelPTX server instances, restore the original subscription configuration, and run:

```powershell
npm run azure:cleanup
```

The recovery command only removes owned recorded run resources; it creates no compute. If Azure sign-in has expired, run `az login` first. If credentials or Azure availability prevent cleanup, inspect the named resource group in the Azure portal and delete that temporary group. PixelPTX never upgrades the subscription or removes account-level spending limits.

Run manifests retain source, PTX hash, resource identifiers, stages, and diagnostics. Input RGB bytes and output image channels are not written into local history; output is held in server/browser memory until restart. Page refresh reconnects to the most recent run. After server restart, image channels are unavailable but diagnostics remain in the manifest. Uploaded alpha is not sent to Azure: the browser preserves it for the captured input, or displays opaque alpha when recovering a run without that captured image.

Use a toolchain compatible with the allocated GPU and driver. The current compiler's `sm_75` target matches the T4 architecture, but local offline PTXAS acceptance alone does not establish runtime compatibility or correctness. CPU preview, assembly, and actual GPU execution remain explicitly labeled in the explorer.
