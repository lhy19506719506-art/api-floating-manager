#Requires -Version 5.1
<#
.SYNOPSIS
    把本地开发目录同步到 TauriTavern 的第三方扩展目录。

.EXAMPLE
    pwsh -File .\install.ps1

.EXAMPLE
    pwsh -File .\install.ps1 -DataDir 'C:\Users\me\AppData\Roaming\com.tauritavern.client\data'
#>
param(
    [string]$DataDir
)

$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'tauri-api-manager'

if (-not $DataDir) {
    $DataDir = Join-Path $env:APPDATA 'com.tauritavern.client\data'
}

$target = Join-Path $DataDir "extensions\third-party\$name"

# 安全检查：只允许删除/覆盖名字匹配本扩展的目录
if ((Split-Path -Leaf $target) -ne $name -or $target -notmatch 'third-party') {
    throw "拒绝执行：目标路径看起来不对 -> $target"
}

if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $target | Out-Null
# 只装运行时需要的文件：tests/ 里的截图与浏览器缓存不进扩展目录
$runtimeFiles = @('manifest.json', 'index.js', 'style.css', 'README.md')
foreach ($file in $runtimeFiles) {
    $sourceFile = Join-Path $src $file
    if (Test-Path -LiteralPath $sourceFile) {
        Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $target $file) -Force
    }
}

Write-Host "已安装: $target" -ForegroundColor Green
Write-Host "下一步: 在 TauriTavern 中刷新页面（或重启应用），右下角应出现 API 悬浮球。" -ForegroundColor Cyan
Write-Host ""
Write-Host "如果悬浮球没有出现，再执行一次并指定备用目录：" -ForegroundColor Yellow
Write-Host "  pwsh -File .\install.ps1 -DataDir `"$DataDir`"" -ForegroundColor DarkGray
Write-Host "  然后把 $target 整个复制到 $DataDir\default-user\extensions\$name" -ForegroundColor DarkGray

