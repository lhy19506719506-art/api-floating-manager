#Requires -Version 5.1
<#
.SYNOPSIS
    把 API 悬浮管家打包成「酒馆助手（JS-Slash-Runner）」可导入的全局脚本 JSON。

.DESCRIPTION
    产物是一个 Script 对象（type=script），content 里做两件事：
      1. 把样式注入到酒馆页面；
      2. 把扩展代码作为 <script> 注入到父窗口，让它在酒馆页面上下文里运行
         （这样 window.__TAURITAVERN__ / extension_settings / localStorage 都能用）。

    用法：酒馆助手 → 脚本库 → 全局 → 导入 → 选择本 JSON → 手动启用。

.EXAMPLE
    pwsh -File .\build-script-json.ps1
#>
param(
    [string]$Source = '..\pc',
    [string]$OutFile
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here $Source
if (-not (Test-Path -LiteralPath (Join-Path $src 'index.js'))) {
    throw "找不到扩展源码: $src"
}

if (-not $OutFile) {
    $OutFile = Join-Path (Split-Path -Parent $here) 'API悬浮管家.script.json'
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null

# 桌面版逻辑 + 移动端补丁（visualViewport 在桌面无副作用）
$code = (Get-Content -LiteralPath (Join-Path $src 'index.js') -Raw) + "`n" +
        (Get-Content -LiteralPath (Join-Path $here 'mobile.js') -Raw)
$style = Get-Content -LiteralPath (Join-Path $src 'style.css') -Raw

$wrapper = @'
/* API 悬浮管家 · 酒馆助手全局脚本包装
 * 在酒馆助手（JS-Slash-Runner）的 iframe 中运行，把真正的扩展代码注入父窗口。
 */
(async () => {
  try {
    const isTop = window.parent === window;
    const doc = isTop ? document : window.parent.document;
    const win = doc.defaultView || window;

    if (doc.getElementById('tam-root')) return;

    const CODE = __CODE__;
    const STYLE = __STYLE__;

    if (!doc.getElementById('tam-style')) {
      const style = doc.createElement('style');
      style.id = 'tam-style';
      style.textContent = STYLE;
      (doc.head || doc.documentElement).appendChild(style);
    } else {
      // 重新导入/启用后必须替换旧样式，否则页面会话里会一直沿用上一版 CSS
      const fresh = doc.createElement('style');
      fresh.id = 'tam-style';
      fresh.textContent = STYLE;
      doc.getElementById('tam-style').replaceWith(fresh);
    }

    const boot = doc.createElement('script');
    boot.id = 'tam-boot';
    boot.textContent = CODE;
    (doc.body || doc.documentElement).appendChild(boot);
  } catch (err) {
    console.error('[API 管家] 注入失败：酒馆助手若开启“使用 blob iframe”会跨域，请关闭该选项后重试', err);
  }
})();
'@

$wrapper = $wrapper.Replace('__CODE__', ($code | ConvertTo-Json -Compress))
$wrapper = $wrapper.Replace('__STYLE__', ($style | ConvertTo-Json -Compress))

$script_ = [ordered]@{
    type        = 'script'
    enabled     = $true
    name        = 'API 悬浮管家'
    id          = 'tauri-api-manager'
    content     = $wrapper
    info        = '悬浮窗管理多套 API 并一键切换酒馆当前 API；由扩展源码自动生成为酒馆助手全局脚本。'
    button      = [ordered]@{ enabled = $false; buttons = @() }
    data        = @{}
    export_with = [ordered]@{ data = $true; button = $true }
}

$json = $script_ | ConvertTo-Json -Depth 8
Set-Content -LiteralPath $OutFile -Value $json -Encoding utf8

# 自检：能被解析回来，且 content 里确实包含扩展代码
$check = Get-Content -LiteralPath $OutFile -Raw | ConvertFrom-Json
if ($check.type -ne 'script' -or $check.content -notmatch 'tam-boot') {
    throw '生成的 JSON 自检失败'
}

$size = [math]::Round((Get-Item $OutFile).Length / 1kb, 1)
Write-Host "已生成: $OutFile ($size KB)" -ForegroundColor Green
Write-Host "用法: 酒馆助手 → 脚本库 → 全局 → 导入 → 选择该 JSON → 把脚本开关打开" -ForegroundColor Cyan

