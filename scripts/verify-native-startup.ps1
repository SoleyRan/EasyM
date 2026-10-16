$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$exePath = Join-Path $repoRoot 'src-tauri/target/release/easym.exe'
$config = Get-Content (Join-Path $repoRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$reportRoot = Join-Path $repoRoot 'test-results'
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
$profileRoot = Join-Path $reportRoot ('native-startup-' + [guid]::NewGuid().ToString('N'))
$previousProfile = $env:WEBVIEW2_USER_DATA_FOLDER
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$profilePolicy = $null
$appProcess = $null
$report = [ordered]@{
    verifiedAt = [DateTime]::UtcNow.ToString('o')
    version = $config.version
    executableSha256 = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()
    isolatedProfile = $true
    isolatedNativeRegistry = $false
    elevated = $elevated
    profileSource = $(if ($elevated) { 'temporary executable-scoped HKLM policy' } else { 'process environment' })
    launched = $false
    gracefulClose = $false
    passed = $false
    scope = 'Native window startup and close only; no editor, IME, file dialogs or printing acceptance.'
}
try {
    $env:WEBVIEW2_USER_DATA_FOLDER = $profileRoot
    if ($elevated) {
        # High-integrity WebView2 hosts ignore the environment override. Match
        # the isolated native registry with an executable-scoped browser policy.
        $keyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\UserDataFolder'
        $keyExisted = Test-Path -LiteralPath $keyPath
        $key = if ($keyExisted) { Get-Item -LiteralPath $keyPath } else { New-Item -Path $keyPath -Force }
        $valueName = [IO.Path]::GetFileName($exePath)
        $hadValue = $key.GetValueNames() -contains $valueName
        $profilePolicy = @{
            path = $keyPath; keyExisted = $keyExisted; name = $valueName; hadValue = $hadValue
            value = $(if ($hadValue) { $key.GetValue($valueName) } else { $null })
            kind = $(if ($hadValue) { $key.GetValueKind($valueName) } else { $null })
        }
        New-ItemProperty -LiteralPath $keyPath -Name $valueName -Value $profileRoot -PropertyType String -Force | Out-Null
    }
    $appProcess = Start-Process -FilePath $exePath -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 250
        $appProcess.Refresh()
    } while (-not $appProcess.HasExited -and $appProcess.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($appProcess.HasExited -or $appProcess.MainWindowHandle -eq 0) { throw 'Application did not create a native window.' }
    $report.launched = $true
    $registryPath = Join-Path $profileRoot '.easym/recent-v1.json'
    $registryDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not (Test-Path -LiteralPath $registryPath) -and -not $appProcess.HasExited -and [DateTime]::UtcNow -lt $registryDeadline) {
        Start-Sleep -Milliseconds 250
        $appProcess.Refresh()
    }
    if (-not (Test-Path -LiteralPath $registryPath)) { throw 'Isolated native session registry was not created.' }
    $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
    if ($registry.version -ne 1 -or @($registry.records).Count -ne 0 -or $registry.session.workspaceId -or @($registry.session.tabs | Where-Object { $_.recentId }).Count -ne 0) {
        throw 'Fresh isolated profile unexpectedly contains native recent records.'
    }
    $report.isolatedNativeRegistry = $true
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
    try {
        if ($appProcess) {
            $appProcess.Refresh()
            $report.appProcess = @{ id = $appProcess.Id; exited = $appProcess.HasExited; exitCode = $(if ($appProcess.HasExited) { $appProcess.ExitCode } else { $null }) }
            try {
                $report.webviewProcesses = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
                    Where-Object { $_.ParentProcessId -eq $appProcess.Id -or ($_.CommandLine -and $_.CommandLine.Contains($profileRoot)) } |
                    Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine)
            } catch { $report.diagnosticError = $_.Exception.Message }
            if (-not $appProcess.HasExited) { Stop-Process -Id $appProcess.Id -Force }
        }
    } finally {
        try {
            if ($profilePolicy) {
                if ($profilePolicy.hadValue) {
                    New-ItemProperty -LiteralPath $profilePolicy.path -Name $profilePolicy.name -Value $profilePolicy.value -PropertyType $profilePolicy.kind -Force | Out-Null
                } else {
                    Remove-ItemProperty -LiteralPath $profilePolicy.path -Name $profilePolicy.name -ErrorAction Stop
                }
                $key = Get-Item -LiteralPath $profilePolicy.path
                if (-not $profilePolicy.keyExisted -and $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0) { Remove-Item -LiteralPath $profilePolicy.path }
            }
        } catch {
            $report.passed = $false; $report.policyRestoreError = $_.Exception.Message
            throw
        } finally {
            $env:WEBVIEW2_USER_DATA_FOLDER = $previousProfile
            $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $reportRoot 'native-startup-verification.json') -Encoding UTF8
        }
    }
}
$report | ConvertTo-Json
