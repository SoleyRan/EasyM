$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$releaseRoot = Join-Path $repoRoot 'src-tauri/target/release'
$exePath = Join-Path $releaseRoot 'easym.exe'
$config = Get-Content (Join-Path $repoRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$bundleRoot = Join-Path $releaseRoot 'bundle/portable'
New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
$archivePath = Join-Path $bundleRoot ("EasyM-{0}-windows-x64-dev.zip" -f $config.version)
$stageRoot = Join-Path $repoRoot ('test-results/portable-' + [guid]::NewGuid().ToString('N'))
$inventory = Get-Content (Join-Path $repoRoot 'Docs/dependencies/inventory.json') -Raw | ConvertFrom-Json
if ($inventory.target -ne 'x86_64-pc-windows-msvc' -or -not $inventory.completeLicenseTexts) { throw 'Portable packaging requires complete Windows dependency notices.' }
New-Item -ItemType Directory -Path $stageRoot | Out-Null
Copy-Item -LiteralPath $exePath -Destination (Join-Path $stageRoot 'easym.exe')
Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'Docs/dependencies') -Destination (Join-Path $stageRoot 'third-party') -Recurse
Compress-Archive -Path (Join-Path $stageRoot '*') -DestinationPath $archivePath -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName -match '(^[/\\]|(^|[/\\])\.\.([/\\]|$)|:)' -or -not $names.Add($entry.FullName)) {
            throw "Invalid or duplicate ZIP entry: $($entry.FullName)"
        }
    }
    foreach ($required in @('easym.exe', 'LICENSE', 'third-party/THIRD-PARTY-NOTICES.md', 'third-party/sbom.cdx.json', 'third-party/inventory.json', 'third-party/license-sources.json')) {
        if (-not $names.Contains($required)) { throw "Missing ZIP entry: $required" }
    }
    $stream = $archive.GetEntry('easym.exe').Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $embeddedHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $sha.Dispose() }
    if ($embeddedHash -ne (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash) { throw 'Embedded executable hash mismatch' }
    [pscustomobject]@{ archive = $archivePath; entries = $archive.Entries.Count; sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() }
} finally { $archive.Dispose() }
