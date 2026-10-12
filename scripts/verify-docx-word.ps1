param([string]$InputDirectory = 'test-results/docx-ui')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $InputDirectory).Path
$reportPath = Join-Path $root 'word-verification.json'
$word = $null
$document = $null
$report = [ordered]@{ verifiedAt = (Get-Date).ToUniversalTime().ToString('o'); passed = $false; application = 'Microsoft Word'; version = $null; checks = @() }
try {
    # A dedicated hidden COM instance; only test artifacts are opened or written.
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    $report.version = $word.Version
    $report.build = $word.Build
    $report.fileVersion = (Get-Item -LiteralPath (Join-Path $word.Path 'WINWORD.EXE')).VersionInfo.FileVersion
    foreach ($name in @('letter-compact', 'placeholders', 'display-image', 'office', 'multipage')) {
        $inputPath = Join-Path $root ($name + '.docx')
        $document = $word.Documents.Open($inputPath, $false, $true, $false)
        $document.Repaginate()
        $text = $document.Content.Text
        $pages = $document.ComputeStatistics(2)
        $tables = $document.Tables.Count
        $images = $document.InlineShapes.Count
        if ($name -eq 'letter-compact' -and (-not $text.Contains('未保存的中文') -or $tables -ne 1)) { throw 'Word lost office text/table' }
        if ($name -eq 'placeholders' -and (-not $text.Contains('缺失') -or -not $text.Contains('远程') -or $images -ne 0)) { throw 'Word lost placeholders' }
        if ($name -eq 'display-image' -and $images -ne 1) { throw 'Word lost the embedded display image' }
        if ($name -eq 'office' -and ($images -ne 2 -or $tables -ne 1 -or -not $text.Contains('EasyM 办公导出验收') -or -not $text.Contains('结束段落'))) { throw 'Word lost frozen office sample content' }
        if ($name -eq 'multipage' -and ($images -ne 12 -or $pages -lt 2 -or $tables -ne 2 -or -not $text.Contains('长代码行需要保留缩进'))) { throw 'Word lost multipage sample content/images' }
        $pdf = Join-Path $root ($name + '-word.pdf')
        $document.ExportAsFixedFormat($pdf, 17)
        if ((Get-Item -LiteralPath $pdf).Length -eq 0) { throw 'Word PDF is empty' }
        # Confirm editable content can be saved in a separate DOCX and reopened.
        $document.Content.InsertAfter("`rEasyM Word edit verification")
        $copy = Join-Path $root ($name + '-word-edited.docx')
        $document.SaveAs2($copy, 16)
        $document.Close(0)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
        $document = $word.Documents.Open($copy, $false, $true, $false)
        if (-not $document.Content.Text.Contains('EasyM Word edit verification')) { throw 'Word edit/reopen failed' }
        $report.checks += [ordered]@{ sample = $name; pages = $pages; tables = $tables; inlineImages = $images; opened = $true; editedAndReopened = $true; pdfBytes = (Get-Item -LiteralPath $pdf).Length }
        $document.Close(0)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
        $document = $null
    }
    $report.passed = $true
} catch { $report.error = $_.Exception.Message; throw }
finally {
    if ($document) { $document.Close(0); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
    if ($word) { $word.Quit(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) }
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
}
