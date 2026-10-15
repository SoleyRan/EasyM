$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$exePath = Join-Path $repoRoot 'src-tauri/target/release/easym.exe'
$profileRoot = Join-Path $repoRoot ('test-results/native-extensions-' + [guid]::NewGuid().ToString('N'))
$previousProfile = $env:WEBVIEW2_USER_DATA_FOLDER
$previousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$appProcess = $null
# Use an ephemeral loopback debug port only for this separately launched profile.
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$debugPort = $listener.LocalEndpoint.Port
$listener.Stop()
try {
    $env:WEBVIEW2_USER_DATA_FOLDER = $profileRoot
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$debugPort --remote-debugging-address=127.0.0.1"
    $appProcess = Start-Process -FilePath $exePath -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    & node (Join-Path $PSScriptRoot 'verify-native-extensions.mjs') $debugPort
    if ($LASTEXITCODE -ne 0) { throw 'Native extension verification failed.' }
    $appProcess.Refresh()
    if (-not $appProcess.WaitForExit(10000) -or $appProcess.ExitCode -ne 0) {
        throw 'Native extension test window did not exit normally.'
    }
    $reportPath = Join-Path $repoRoot 'test-results/native-extensions-verification.json'
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    $report | Add-Member -NotePropertyName gracefulClose -NotePropertyValue $true
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
} catch {
    $reportPath = Join-Path $repoRoot 'test-results/native-extensions-verification.json'
    if (Test-Path -LiteralPath $reportPath) {
        $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
        $report.passed = $false
        $report | Add-Member -NotePropertyName wrapperError -NotePropertyValue $_.Exception.Message -Force
        $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
    }
    throw
} finally {
    if ($appProcess -and -not $appProcess.HasExited) { Stop-Process -Id $appProcess.Id -Force }
    $env:WEBVIEW2_USER_DATA_FOLDER = $previousProfile
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
}
