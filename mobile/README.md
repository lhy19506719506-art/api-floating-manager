# Context & API Manager · 移动端源码

移动端不单独维护一份 `index.js` / `style.css`，而是复用 `../pc/` 的桌面源码：

- `mobile.js`：移动端运行时补丁（`visualViewport` 软键盘避让）；
- `build-mobile.ps1`：把 `../pc/index.js` + `mobile.js` 合并，复制 `../pc/style.css`，生成
  `dist/tauri-api-manager-mobile/`（标准扩展目录，可直接装）；
- `build-script-json.ps1`：把同样的代码和样式包装成酒馆助手脚本，输出到仓库根目录
  `../Context & API Manager.json`。

## 构建

```powershell
cd mobile
pwsh -File .\build-mobile.ps1
pwsh -File .\build-script-json.ps1
```

## 说明

- 手机端样式适配已经合并进 `pc/style.css` 的移动媒体查询，不再有单独的 `mobile.css`。
- 修改桌面逻辑时只改 `pc/index.js`；修改移动端专属行为时改 `mobile.js`。
- `dist/tauri-api-manager-mobile/` 是构建产物，可以直接提交，方便手机端用 Git URL 安装扩展。
