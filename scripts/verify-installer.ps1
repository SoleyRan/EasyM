$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$config = Get-Content (Join-Path $repoRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
# Install only on a disposable runner. A local EasyM installation must never
# have its registry entries or shortcuts replaced by this verification.
if ($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Installer verification requires a disposable Windows CI runner.' }
$existing = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall') | ForEach-Object {
    Get-ChildItem -LiteralPath $_ -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -match '^EasyM$|^Easy Markdown$' }
}
if ($existing) { throw 'An EasyM installation already exists; refusing to replace it.' }
$installRoot = Join-Path $env:RUNNER_TEMP ('easym-install-' + [guid]::NewGuid().ToString('N'))
$installer = Join-Path $repoRoot ("src-tauri/target/release/bundle/nsis/EasyM_{0}_x64-setup.exe" -f $config.version)
$reportPath = Join-Path $repoRoot 'test-results/installer-verification.json'
$report = [ordered]@{ verifiedAt = [DateTime]::UtcNow.ToString('o'); installerSha256 = (Get-FileHash -LiteralPath $installer).Hash.ToLowerInvariant(); installed = $false; launched = $false; uninstalled = $false }
$appProcess = $null
$previousProfile = $env:WEBVIEW2_USER_DATA_FOLDER
try {
    $installProcess = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installRoot") -WindowStyle Hidden -PassThru -Wait
    if ($installProcess.ExitCode -ne 0) { throw "Installer exit code: $($installProcess.ExitCode)" }
    $installedExe = Join-Path $installRoot 'easym.exe'
    if (-not (Test-Path -LiteralPath $installedExe)) { throw 'Installed executable missing.' }
    foreach ($file in @('LICENSE', 'third-party/THIRD-PARTY-NOTICES.md', 'third-party/sbom.cdx.json', 'third-party/inventory.json', 'third-party/license-sources.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installRoot $file))) { throw "Installed resource missing: $file" }
    }
    $inventory = Get-Content (Join-Path $installRoot 'third-party/inventory.json') -Raw | ConvertFrom-Json
    if ($inventory.target -ne 'x86_64-pc-windows-msvc' -or -not $inventory.completeLicenseTexts) { throw 'Installer does not contain complete Windows dependency notices.' }
    if ((Get-FileHash -LiteralPath $installedExe).Hash -ne (Get-FileHash -LiteralPath (Join-Path $repoRoot 'src-tauri/target/release/easym.exe')).Hash) { throw 'Installed executable differs from the Release executable.' }
    $report.installed = $true
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:RUNNER_TEMP ('easym-webview-' + [guid]::NewGuid().ToString('N'))
    $appProcess = Start-Process -FilePath $installedExe -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 250
        $appProcess.Refresh()
    } while (-not $appProcess.HasExited -and $appProcess.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($appProcess.HasExited -or $appProcess.MainWindowHandle -eq 0) { throw 'Installed application did not create a native window.' }
    $report.launched = $true
    Stop-Process -Id $appProcess.Id -Force
    $appProcess.WaitForExit()
    $appProcess = $null
    $uninstaller = Join-Path $installRoot 'uninstall.exe'
    if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Uninstaller missing.' }
    # _?= prevents NSIS spawning a detached temporary copy, so Wait observes
    # the uninstaller itself and the result is not an optimistic launch check.
    $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$installRoot") -WindowStyle Hidden -PassThru -Wait
    if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstaller exit code: $($uninstallProcess.ExitCode)" }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ((Test-Path -LiteralPath $installedExe) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (Test-Path -LiteralPath $installedExe) { throw 'Uninstaller did not remove the executable.' }
    foreach ($file in @('LICENSE', 'third-party/THIRD-PARTY-NOTICES.md', 'third-party/sbom.cdx.json', 'third-party/inventory.json')) {
        if (Test-Path -LiteralPath (Join-Path $installRoot $file)) { throw "Uninstaller left a packaged resource: $file" }
    }
    if (Test-Path -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\EasyM') { throw 'Uninstaller left the per-user installation registry key.' }
    $report.uninstalled = $true
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    if ($appProcess -and -not $appProcess.HasExited) { Stop-Process -Id $appProcess.Id -Force }
    $env:WEBVIEW2_USER_DATA_FOLDER = $previousProfile
    $report | ConvertTo-Json | Set-Content -LiteralPath $reportPath -Encoding UTF8
}
