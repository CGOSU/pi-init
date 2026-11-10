$ErrorActionPreference = "Stop"

$piCommand = Get-Command pi.cmd -ErrorAction SilentlyContinue
if (-not $piCommand) {
    $piCommand = Get-Command pi -ErrorAction SilentlyContinue
}
if (-not $piCommand -or -not $piCommand.Source) {
    throw "找不到 pi 或 pi.cmd。请先安装 Pi，并确保其目录已加入 PATH。"
}

$targetDir = Split-Path -Parent $piCommand.Source
& node (Join-Path $PSScriptRoot "install-launchers.js") --target-dir $targetDir
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
