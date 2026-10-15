$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$exePath = Join-Path $repoRoot 'src-tauri/target/release/easym.exe'
$profileRoot = Join-Path $repoRoot ('test-results/native-extensions-' + [guid]::NewGuid().ToString('N'))
$previousProfile = $env:WEBVIEW2_USER_DATA_FOLDER
$previousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$appProcess = $null
$reportPath = Join-Path $repoRoot 'test-results/native-extensions-verification.json'
$diagnosticRoot = Join-Path $repoRoot 'test-results/native-extensions'
New-Item -ItemType Directory -Path $diagnosticRoot -Force | Out-Null
$webviewLog = Join-Path $diagnosticRoot ('webview-' + [guid]::NewGuid().ToString('N') + '.log')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$policyChanges = @()
$browserArguments = "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --enable-logging --log-file=`"$webviewLog`""
# Start a new report even if process launch fails; never reuse an earlier pass.
@{ verifiedAt = [DateTime]::UtcNow.ToString('o'); passed = $false; isolatedProfile = $true; elevated = $elevated } |
    ConvertTo-Json | Set-Content -LiteralPath $reportPath -Encoding utf8
try {
    $env:WEBVIEW2_USER_DATA_FOLDER = $profileRoot
    # Let WebView2 allocate and retain its own port, then discover the actual
    # endpoint in this profile's DevToolsActivePort (no reserve/release race).
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $browserArguments
    if ($elevated) {
        # Hosted Windows runners are elevated. WebView2 ignores environment and
        # HKCU argument overrides at high integrity, but honors HKLM policies.
        # Scope both overrides to this executable and restore them in finally;
        # never enable debugging in the shipped application configuration.
        foreach ($override in @(
            @{ name = 'AdditionalBrowserArguments'; value = $browserArguments },
            @{ name = 'UserDataFolder'; value = $profileRoot }
        )) {
            $keyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\' + $override.name
            $keyExisted = Test-Path -LiteralPath $keyPath
            $key = if ($keyExisted) { Get-Item -LiteralPath $keyPath } else { New-Item -Path $keyPath -Force }
            $valueName = [IO.Path]::GetFileName($exePath)
            $hadValue = $key.GetValueNames() -contains $valueName
            $policyChanges += @{
                path = $keyPath; keyExisted = $keyExisted; name = $valueName; hadValue = $hadValue
                value = $(if ($hadValue) { $key.GetValue($valueName) } else { $null })
                kind = $(if ($hadValue) { $key.GetValueKind($valueName) } else { $null })
            }
            New-ItemProperty -LiteralPath $keyPath -Name $valueName -Value $override.value -PropertyType String -Force | Out-Null
        }
    }
    $appProcess = Start-Process -FilePath $exePath -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    # Invoke the executable directly so package-manager PowerShell shims cannot
    # change the synchronous process/exit-code handling of this wrapper.
    $nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    & $nodePath (Join-Path $PSScriptRoot 'verify-native-extensions.mjs') $profileRoot $appProcess.Id
    if ($LASTEXITCODE -ne 0) { throw 'Native extension verification failed.' }
    $appProcess.Refresh()
    if (-not $appProcess.WaitForExit(10000) -or $appProcess.ExitCode -ne 0) {
        throw 'Native extension test window did not exit normally.'
    }
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    $report | Add-Member -NotePropertyName gracefulClose -NotePropertyValue $true
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
} catch {
    if (Test-Path -LiteralPath $reportPath) {
        $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
        $report.passed = $false
        $report | Add-Member -NotePropertyName wrapperError -NotePropertyValue $_.Exception.Message -Force
        $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
    }
    throw
} finally {
    try {
        # Persist only diagnostics for the app/profile owned by this verification.
        $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
        $report | Add-Member -NotePropertyName elevated -NotePropertyValue $elevated -Force
        $report | Add-Member -NotePropertyName browserArgumentSource -NotePropertyValue $(if ($elevated) { 'temporary executable-scoped HKLM policy' } else { 'process environment' }) -Force
        if ($appProcess) {
            $appProcess.Refresh()
            $report | Add-Member -NotePropertyName appProcess -NotePropertyValue @{
                id = $appProcess.Id; exited = $appProcess.HasExited
                exitCode = $(if ($appProcess.HasExited) { $appProcess.ExitCode } else { $null })
            } -Force
        }
        try {
            $webviews = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
                Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileRoot) } |
                Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine)
            $report | Add-Member -NotePropertyName webviewProcesses -NotePropertyValue $webviews -Force
        } catch { $report | Add-Member -NotePropertyName diagnosticError -NotePropertyValue $_.Exception.Message -Force }
        $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
    } finally {
        try {
            if ($appProcess -and -not $appProcess.HasExited) { Stop-Process -Id $appProcess.Id -Force }
        } finally {
            try {
                $restoreErrors = @()
                foreach ($change in $policyChanges) {
                    try {
                        if ($change.hadValue) {
                            New-ItemProperty -LiteralPath $change.path -Name $change.name -Value $change.value -PropertyType $change.kind -Force | Out-Null
                        } else {
                            Remove-ItemProperty -LiteralPath $change.path -Name $change.name -ErrorAction Stop
                        }
                        $key = Get-Item -LiteralPath $change.path
                        if (-not $change.keyExisted -and $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0) { Remove-Item -LiteralPath $change.path }
                    } catch {
                        $restoreErrors += $_.Exception.Message
                    }
                }
                if ($restoreErrors.Count -gt 0) {
                    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
                    $report.passed = $false
                    $report | Add-Member -NotePropertyName policyRestoreErrors -NotePropertyValue $restoreErrors -Force
                    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
                    throw ('Could not restore WebView2 test policies: ' + ($restoreErrors -join '; '))
                }
            } finally {
                $env:WEBVIEW2_USER_DATA_FOLDER = $previousProfile
                $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
            }
        }
    }
}
