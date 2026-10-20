$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.tools/cuda'))
if (-not $toolsRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Tool destination must be inside this project.'
}
New-Item -ItemType Directory -Force -Path $toolsRoot, (Join-Path $toolsRoot 'bin') | Out-Null
$baseUrl = 'https://developer.download.nvidia.com/compute/cuda/redist/'
$releaseUrl = $baseUrl + 'redistrib_13.4.1.json'
$manifestPath = Join-Path $toolsRoot 'redistrib_13.4.1.json'
Write-Host 'Downloading the official NVIDIA CUDA 13.4.1 redistributable manifest...'
Invoke-WebRequest -Uri $releaseUrl -OutFile $manifestPath -TimeoutSec 60
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
foreach ($component in @('cuda_nvcc', 'cuda_nvdisasm')) {
    $package = $manifest.$component.'windows-x86_64'
    if (-not $package -or $package.relative_path -notmatch '^[a-z_]+/windows-x86_64/[a-zA-Z0-9_.-]+\.zip$') {
        throw "Invalid or unavailable Windows package for $component."
    }
    $archive = Join-Path $toolsRoot ([IO.Path]::GetFileName($package.relative_path))
    if (-not (Test-Path -LiteralPath $archive)) {
        Write-Host "Downloading $component ($([Math]::Round([double]$package.size / 1MB, 1)) MB)..."
        Invoke-WebRequest -Uri ($baseUrl + $package.relative_path) -OutFile $archive -TimeoutSec 180
    }
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($actualHash -ne $package.sha256) { throw "SHA-256 verification failed for $archive. Remove this archive and retry." }
    $extract = Join-Path $toolsRoot $component
    Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
    # Preserve the full vendor archive, including license files and companion binaries.
    $tool = if ($component -eq 'cuda_nvcc') { 'ptxas.exe' } else { 'nvdisasm.exe' }
    $vendorExe = Get-ChildItem -LiteralPath $extract -Recurse -File -Filter $tool | Select-Object -First 1
    if (-not $vendorExe) { throw "$tool was not found in the verified archive." }
    Get-ChildItem -LiteralPath $vendorExe.DirectoryName -File | Copy-Item -Destination (Join-Path $toolsRoot 'bin') -Force
    Write-Host "Ready: $tool (SHA-256 verified)"
}
Write-Host 'NVIDIA offline tools are ready in .tools/cuda/bin. No driver or system PATH changes were made.'
Write-Host 'Vendor license files remain in the extracted archives. PixelPTX does not redistribute these tools.'
