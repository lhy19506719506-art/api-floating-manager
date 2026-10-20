# API 悬浮管家

TauriTavern / SillyTavern 的常驻悬浮面板：多 API 一键切换、用量统计、上下文压缩。

> 当前版本：**0.7.13** · 适用于 TauriTavern 2.3.0（SillyTavern 1.18 前端）
> Windows 客户端 / Android 客户端 / 普通 SillyTavern 网页版（本地模式）

![上下文面板](screenshots/context.png)

---

## 一、这个项目做了什么

把「API 档案管理」和「上下文预算管理」从酒馆设置面板搬进一个常驻悬浮窗，并且**不改角色卡、不改预设、不改世界书**。

四个 tab：

| tab | 能力 |
|---|---|
| 连接 | 新增 / 切换 / 编辑 / 删除 API，导入导出，故障切换 |
| 用量 | 本机请求数、输入 / 输出 tokens，按天归档 |
| 诊断 | 宿主 ABI、酒馆设置、DOM、端点格式探测 |
| 上下文 | token 占用、压缩预览、隐藏 / 删除、自动压缩 |

---

## 二、目录结构

```
api-floating-manager/
├─ API悬浮管家.script.json     手机端：酒馆助手导入
├─ README.md                   本文件（开发总结）
├─ 使用说明.md                 用户手册
├─ LICENSE .md
├─ 感谢兄弟们.png
├─ pc/                         电脑端扩展源码
│  ├─ index.js  style.css  manifest.json
│  └─ install.ps1
├─ mobile/                     手机端补丁与构建
│  ├─ mobile.js
│  ├─ build-mobile.ps1
│  ├─ build-script-json.ps1
│  ├─ README.md
│  └─ dist/tauri-api-manager-mobile/
└─ screenshots/
```

`pc/` 是唯一源码目录；`mobile/` 只维护 `mobile.js` 补丁和两个构建脚本，构建时复用 `pc/`。

---

## 三、架构与关键技术点

### 3.1 宿主访问层

所有 TauriTavern ABI 调用集中在 `host` 对象里：

- `host.api()` / `host.llmConnections()` / `host.tt()`
- 有 ABI 时走宿主连接管理；没有时退化为本地直连（普通酒馆）
- `waitReady()` + `watchHostLate()` 处理 ABI 晚注入，避免悬浮球永远不出现

### 3.2 连接切换

1. 写入并激活新 Key（`/api/secrets/write` + `/rotate`）
2. 调用 `readSecretState()` 刷新酒馆内存里的 secret 缓存
3. 在 `withConnectionValidationSuspended()` 作用域内写 URL / 来源 / 模型
4. 扩展自己测试一次
5. 测试成功才触发一次酒馆状态检查 → 插头变绿、发送按钮恢复

切换期间用 capture 监听拦掉酒馆自动触发的「连接」点击，避免红色报错。

### 3.3 Key 存储

- 宿主 `extension_settings` 里永远脱敏（`key: ''`）。
- `localStorage` 镜像默认也**不写明文**：有宿主 secrets 时只保留 `secretRef`。
- 导入带 Key 的配置会先写进宿主 secrets，再存 `secretRef`。
- 需要离线兜底时，在「用量」页打开「本地镜像保存 Key」。
- 导出「含 Key」时从 secrets 按 `secretRef` 补回。

### 3.4 上下文管家

**计数**

- 整段请求：`/api/tokenizers/openai/count`
- 逐条：`/count-batch`
- 不可用时退化为 `ctxEstimate`（中文 ~0.72 token/字，英文 ~3.8 字符/token）
- 建议档位的前缀用 `/count-batch` 精确统计后反推，不用估算

**预算**

```
可用 = min(酒馆上下文, 有效预算) - min(回复预留, 35%)
```

预设写 `2,000,000` 时自动压缩不会触发，面板会提示设「有效预算」。

**压缩**

1. 取「保留最近 N 轮」之前的消息，单次最多 4 万字符
2. 单条消息最多 8,000 字符，超出标记截断
3. 调当前激活连接生成 180–260 字前情提要
4. 先隐藏旧消息，再注入 extension prompt；注入失败自动回滚隐藏
5. 摘要写入 `chatMetadata`，重进聊天自动恢复
6. 再次压缩时把「旧提要 + 新对话」合并，不会覆盖丢失更早剧情

**预览与确认**

- 手动压缩先弹预览：可编辑摘要、看预计 token 变化、取消 / 重新生成 / 应用
- 「发送前确认」默认开启：确认前不会把消息发给 API
- 自动压缩不确认（否则无法自动），面板明示发送目标

**隐藏 / 删除**

- 隐藏 = `is_system = true`，不进 prompt，但酒馆楼层保留（这是酒馆 `/hide` 语义）
- 删除 = 真正移除楼层并重排，删前存快照，可恢复
- 两类操作后都会 `printMessages()` 刷新酒馆 UI

**自动压缩**

- 触发条件：`每 N 轮` 或 `用量 ≥ 阈值`
- 生成结束后触发，15 秒内不重复
- 生成中禁止手动改动

---

## 四、测试矩阵

8 套测试（`tauri-api-manager/tests/`）：

| 套件 | 覆盖 |
|---|---|
| context | 估算、摘要模板、压缩范围、预算、精确计数退化 |
| context-abnormal | 越界楼层、空输入、首楼保护、连点压缩、单条聊天、异常设置、并发渲染、XSS、全部取消隐藏、预览取消 |
| context-brutal | 10k 消息、5k 区间、1MB 文本、1000 点击、200 渲染、2000 组 fuzz |
| context-superbrutal | 100k 消息、50k 区间、1MB 估算、5000 条恶意文本、100 并发压缩、故障注入、500 条导入并发、UI 混乱、配额异常 |
| context-risks | 明文 Key、摘要发送时机、发送前确认、secretRef、用量 hook、重新生成、前缀精度 |
| multi-api | 连接 / 切换 / 密钥 / 导入导出 / 悬浮球 / 故障转移 |
| usage | JSON/SSE usage 提取、错误不计数、31 天裁剪、清空 |
| stress | 批量、恶意导入、存储异常、宿主异常、并发切换 |

实测性能：

```
100k 消息规划     23 ms
50k 区间合并      17 ms
1MB 文本估算      31 ms
1000 次点击       ~200 ms
200 次渲染        ~1.0 s
```

---

## 五、已知限制与取舍

1. **隐藏不会移除楼层**：酒馆 `/hide` 本来就是这样；要移除请用删除。
2. **自动压缩在生成之后**：某一轮仍可能先冲高，酒馆自身会截断兜底。
3. **静态前缀压不掉**：前缀超过预算时压缩历史没有意义，面板会直接提示。
4. **Key 默认不落本地**：酒馆 secrets 被清空后需要重新填 Key。
5. **摘要会发往当前激活 API**：已用「发送前确认」和面板提示明示。
6. **纯网页酒馆没有 secrets**：此时才保留本地明文 Key，否则无法持久化。

---

## 六、版本历史

- **0.7.13**：10 项 P0/健壮性修复（secretRef、原始 fetch、注入回滚、UI 刷新、并发导入等）
- **0.7.12**：默认不写明文 Key；导入先落 secrets；发送前确认
- **0.7.11**：建议档位精确计数；发送前确认开关
- **0.7.10**：修复展开压缩设置空白
- **0.7.9**：压缩预览、动态预算建议
- **0.7.8**：增量摘要合并、切聊天保护、每轮增长显示
- **0.7.7**：重前缀警告、100/200 万档位
- **0.7.6**：提示换行、最小化空白、误报修正
- **0.7.5**：超长消息截断、保留轮数容量警告
- **0.7.4**：预算档位 1 万–20 万
- **0.7.3**：长聊天摘要分批
- **0.7.2**：并发压缩串行化、首楼保护
- **0.7.1**：修复抖动与「没有聊天记录」误报、楼层区间、按轮数自动压缩
- **0.7.0**：上下文管家

---

## 七、构建与发布

```powershell
# 电脑端
cd pc
pwsh -File .\install.ps1

# 手机端扩展目录 + 酒馆助手 JSON
cd ..\mobile
pwsh -File .\build-mobile.ps1
pwsh -File .\build-script-json.ps1
```

`build-script-json.ps1` 会把 JSON 输出到仓库根目录，脚本 id 固定为 `tauri-api-manager`，重复导入会覆盖旧样式与脚本。

## 八、许可与支持

- 许可：[LICENSE .md](LICENSE%20.md)
- 支持作者：`感谢兄弟们.png`

完整用户手册见 [使用说明.md](使用说明.md)。
