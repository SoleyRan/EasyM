$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$exePath = Join-Path $repoRoot 'src-tauri/target/release/easym.exe'
$config = Get-Content (Join-Path $repoRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$reportRoot = Join-Path $repoRoot 'test-results'
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
$profileRoot = Join-Path $reportRoot ('native-startup-' + [guid]::NewGuid().ToString('N'))
$previousProfile = $env:WEBVIEW2_USER_DATA_FOLDER
$appProcess = $null
$report = [ordered]@{
    verifiedAt = [DateTime]::UtcNow.ToString('o')
    version = $config.version
    executableSha256 = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()
    isolatedProfile = $true
    launched = $false
    gracefulClose = $false
    passed = $false
    scope = 'Native window startup and close only; no editor, IME, file dialogs or printing acceptance.'
}
try {
    $env:WEBVIEW2_USER_DATA_FOLDER = $profileRoot
    $appProcess = Start-Process -FilePath $exePath -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 250
        $appProcess.Refresh()
    } while (-not $appProcess.HasExited -and $appProcess.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($appProcess.HasExited -or $appProcess.MainWindowHandle -eq 0) { throw 'Application did not create a native window.' }
    $report.launched = $true
    if (-not $appProcess.CloseMainWindow()) { throw 'Native window refused the close request.' }
    if (-not $appProcess.WaitForExit(10000)) { throw 'Native window did not close within 10 seconds.' }
    $report.gracefulClose = $true
    if ($appProcess.ExitCode -ne 0) { throw "Application exit code: $($appProcess.ExitCode)" }
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    # Only the process started by this check may be stopped; keep its profile
    # as diagnostics without touching the user's running apps or drafts.
    if ($appProcess -and -not $appProcess.HasExited) { Stop-Process -Id $appProcess.Id -Force }
    $env:WEBVIEW2_USER_DATA_FOLDER = $previousProfile
    $report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $reportRoot 'native-startup-verification.json') -Encoding UTF8
}
$report | ConvertTo-Json
