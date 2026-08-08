$ErrorActionPreference = "Stop"

$piCommand = Get-Command pi.cmd -ErrorAction SilentlyContinue
if (-not $piCommand) {
    $piCommand = Get-Command pi -ErrorAction SilentlyContinue
}
if (-not $piCommand -or -not $piCommand.Source) {
    throw "找不到 pi 或 pi.cmd。请先安装 Pi，并确保其目录已加入 PATH。"
}

$sourceDir = Split-Path -Parent $PSScriptRoot
$targetDir = Split-Path -Parent $piCommand.Source
Copy-Item (Join-Path $sourceDir "scripts\pi-fast.cmd") (Join-Path $targetDir "pi-fast.cmd") -Force
Copy-Item (Join-Path $sourceDir "scripts\pi-update.cmd") (Join-Path $targetDir "pi-update.cmd") -Force

Write-Host "已安装到：$targetDir"
Write-Host "日常启动：pi-fast"
Write-Host "更新扩展：pi-update"
