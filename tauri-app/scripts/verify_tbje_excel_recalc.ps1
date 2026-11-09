param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath $OutputDirectory).Path
$checkDirectory = Join-Path $taskRoot 'excel-recalc'
New-Item -ItemType Directory -Path $checkDirectory -Force | Out-Null
$excel = $null
$owned = $false
$checks = @()
try {
    $excel = New-Object -ComObject Excel.Application
    $owned = $excel.Workbooks.Count -eq 0
    if (-not $owned) { throw '新建的 Excel 实例已含工作簿，停止验收以保护现有文件。' }
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.AutomationSecurity = 3
    foreach ($source in Get-ChildItem -LiteralPath (Join-Path $taskRoot 'normal') -Filter '*.xlsx') {
        $target = Join-Path $checkDirectory $source.Name
        Copy-Item -LiteralPath $source.FullName -Destination $target -Force
        $book = $excel.Workbooks.Open($target, 0, $false)
        try {
            $excel.CalculateFullRebuild()
            foreach ($sheet in $book.Worksheets) {
                $errors = $null
                try { $errors = $sheet.UsedRange.SpecialCells(-4123, 16) } catch { }
                if ($null -ne $errors) { throw "重算后存在公式错误：$($sheet.Name) $($errors.Address())" }
            }
            $rolling = $book.Worksheets.Item('TB发生额与余额勾稽')
            $entity = $rolling.Cells.Item(6, 1).Value2 -eq '主体'
            $closingColumn = if ($entity) { 10 } else { 9 }
            $verdictColumn = if ($entity) { 12 } else { 11 }
            $before = $rolling.Cells.Item(7, $verdictColumn).Value2
            if ($before -ne '通过') { throw "首行重算结论异常：$before" }
            $original = [double]$rolling.Cells.Item(7, $closingColumn).Value2
            $rolling.Cells.Item(7, $closingColumn).Value2 = $original + 10.0
            $excel.CalculateFullRebuild()
            $after = $rolling.Cells.Item(7, $verdictColumn).Value2
            if ($after -ne '差异') { throw "修改期末后结论未联动：$after" }
            $checks += [pscustomobject]@{file=$source.Name; initialVerdict=$before; changedVerdict=$after; formulaErrors=0}
        } finally {
            $book.Close($false)
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($book)
        }
    }
    if ($checks.Count -ne 2) { throw "预期验收两份工作簿，实际$($checks.Count)份。" }
    $checks | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRoot 'Excel重算验收.json') -Encoding utf8
    $checks | Format-Table -AutoSize
} finally {
    if ($null -ne $excel) {
        if ($owned) { $excel.Quit() }
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel)
        [GC]::Collect()
        [GC]::WaitForPendingFinalizers()
    }
}
