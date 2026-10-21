#Requires -Version 5.1
<#
.SYNOPSIS
    从桌面版扩展构建移动端分发目录：dist\tauri-api-manager-mobile

.DESCRIPTION
    桌面版源码只有一份（..\pc）。本脚本：
      1. 复制 index.js / manifest.json
      2. 复制 style.css（移动适配已并入主样式，不再追加 mobile.css）
      3. 把 mobile.js 追加到 index.js
      4. 改写 manifest 显示名

.EXAMPLE
    pwsh -File .\build-mobile.ps1
#>
param()

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path (Split-Path -Parent $here) 'pc'
$out = Join-Path $here 'dist\tauri-api-manager-mobile'

if (-not (Test-Path -LiteralPath (Join-Path $src 'index.js'))) {
    throw "找不到桌面版源码：$src"
}

if (Test-Path -LiteralPath $out) {
    Remove-Item -LiteralPath $out -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $out | Out-Null

# 移动适配已并入 style.css，避免与追加的 mobile.css 重复
Copy-Item -LiteralPath (Join-Path $src 'style.css') -Destination (Join-Path $out 'style.css') -Force

# JS = 桌面逻辑 + 移动补丁
$js = (Get-Content -LiteralPath (Join-Path $src 'index.js') -Raw) +
      "`n`n/* ===== mobile patch ===== */`n" +
      (Get-Content -LiteralPath (Join-Path $here 'mobile.js') -Raw)
Set-Content -LiteralPath (Join-Path $out 'index.js') -Value $js -Encoding utf8

# manifest
$manifest = Get-Content -LiteralPath (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json
$manifest.display_name = 'Context & API Manager（移动版）'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $out 'manifest.json') -Encoding utf8

$size = [math]::Round((Get-ChildItem -LiteralPath $out -File | Measure-Object -Property Length -Sum).Sum / 1kb, 1)
Write-Host "已生成: $out ($size KB)" -ForegroundColor Green
Write-Host "下一步: 推到 Git 仓库，在 TauriTavern 移动端「安装扩展」里填仓库 URL；或先用 install.ps1 在 PC 上验证。" -ForegroundColor Cyan
