# 测试套件

这 13 个 `.test.mjs` 是 `pc/index.js` 的回归测试，运行方式：

```powershell
cd pc
node tests\context.test.mjs
node tests\context-summary.test.mjs
# 或逐个跑：
Get-ChildItem tests -Filter *.test.mjs | ForEach-Object { node $_.FullName }
```

依赖：

- Node.js 20+
- 本机 happy-dom（测试文件里用绝对路径引用开发环境的
  `D:/TauriTavern/src/TauriTavern-main/node_modules/happy-dom`）
- 真实 API 用例需要环境变量 `DEEPSEEK_API_KEY`（没有会自动跳过/用 mock）

覆盖：上下文预算、压缩、总结重试、条目表格、图片保护、诊断脱敏、
预览取消、异常 meta、XSS、并发、导入导出、用量、压力测试。

注意：`pc/index.js` 是真实源码；测试从 `../index.js` 读取它，不会修改发布包。
