"""One-shot Batch start task. All inputs arrive over authenticated Batch REST."""
import base64
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

result = Path("result.json").resolve()
try:
    keys = sorted(key for key in os.environ if key.startswith("PIXELPTX_BUNDLE_"))
    encoded = "".join(os.environ.pop(key) for key in keys)
    bundle = json.loads(gzip.decompress(base64.b64decode(encoded)))
    allowed = {"include/pixelptx/compiler.hpp", "src/compiler.cpp", "src/gpu_main.cpp",
               "source.pxp", "optimized.ptx", "original.ptx"}
    if set(bundle) != allowed:
        raise RuntimeError("Invalid compiler bundle")
    work = Path(os.environ["AZ_BATCH_NODE_SHARED_DIR"]) / "pixelptx"
    work.mkdir(exist_ok=True)
    os.chdir(work)
    for name, value in bundle.items():
        target = Path(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(value))
    compiler = shutil.which("g++") or shutil.which("c++")
    if not compiler:
        raise RuntimeError("The GPU image has no C++ compiler")
    cuda = next((p for p in [Path("/usr/local/cuda/include"), *Path("/usr/local").glob("cuda-*/include")]
                 if (p / "cuda.h").is_file()), None)
    if not cuda:
        raise RuntimeError("The GPU image has no CUDA driver headers")
    command = [compiler, "-std=c++20", "-O2", "-ffp-contract=off", "-fno-fast-math", "-Iinclude",
               "-I" + str(cuda), "src/compiler.cpp", "src/gpu_main.cpp", "-l:libcuda.so.1", "-o", "pixelptx_gpu"]
    build = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if build.returncode:
        raise RuntimeError("C++ GPU runner build failed: " + build.stderr[-6000:])
    print("C++ CUDA Driver API runner built. Waiting for image tasks.", flush=True)
except Exception as error:
    result.write_text(json.dumps({"ok": False, "error": str(error)}))
    print(result.read_text(), flush=True)
    sys.exit(1)
