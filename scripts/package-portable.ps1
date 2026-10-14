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
& node (Join-Path $PSScriptRoot 'verify-notices.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Dependency notice integrity verification failed.' }
if ($inventory.target -ne 'x86_64-pc-windows-msvc' -or -not $inventory.completeLicenseTexts) { throw 'Portable packaging requires complete Windows dependency notices.' }
New-Item -ItemType Directory -Path $stageRoot | Out-Null
Copy-Item -LiteralPath $exePath -Destination (Join-Path $stageRoot 'easym.exe')
Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'Docs/dependencies') -Destination (Join-Path $stageRoot 'third-party') -Recurse
$sampleVersion = 'v' + (($config.version -split '\.')[0..1] -join '.')
$sampleSource = Join-Path $repoRoot ('Docs/samples/' + $sampleVersion)
Copy-Item -LiteralPath $sampleSource -Destination (Join-Path $stageRoot 'samples') -Recurse
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
    foreach ($required in @('easym.exe', 'LICENSE', 'third-party/THIRD-PARTY-NOTICES.md', 'third-party/sbom.cdx.json', 'third-party/inventory.json', 'third-party/license-sources.json', 'samples/体验指南.md', 'samples/assets/em.png')) {
        if (-not $names.Contains($required)) { throw "Missing ZIP entry: $required" }
    }
    $stream = $archive.GetEntry('easym.exe').Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $embeddedHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $sha.Dispose() }
    if ($embeddedHash -ne (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash) { throw 'Embedded executable hash mismatch' }
    foreach ($file in Get-ChildItem -LiteralPath $stageRoot -Recurse -File) {
        $relative = [IO.Path]::GetRelativePath($stageRoot, $file.FullName).Replace('\', '/')
        $sampleEntry = $archive.GetEntry($relative)
        if (-not $sampleEntry) { throw "Missing staged file: $relative" }
        $sampleStream = $sampleEntry.Open()
        $sampleSha = [Security.Cryptography.SHA256]::Create()
        try { $sampleHash = [BitConverter]::ToString($sampleSha.ComputeHash($sampleStream)).Replace('-', '') }
        finally { $sampleStream.Dispose(); $sampleSha.Dispose() }
        if ($sampleHash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw "ZIP bytes mismatch: $relative" }
    }
    $report = [ordered]@{
        verifiedAt = [DateTime]::UtcNow.ToString('o')
        version = $config.version
        archive = [IO.Path]::GetRelativePath($repoRoot, $archivePath).Replace('\', '/')
        bytes = (Get-Item -LiteralPath $archivePath).Length
        entries = $archive.Entries.Count
        sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        executableSha256 = $embeddedHash.ToLowerInvariant()
        sampleVersion = $sampleVersion
        allStagedFileHashesVerified = $true
        passed = $true
    }
    $report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repoRoot 'test-results/portable-verification.json') -Encoding utf8
    $report | ConvertTo-Json
} finally { $archive.Dispose() }
