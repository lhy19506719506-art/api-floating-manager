/**
 * 多 API 场景回归测试（happy-dom）
 *
 * 覆盖：
 *  1. 6 条连接（含长名字）能否完整列出，不重复、不丢
 *  2. 逐条切换：settings 的 source / custom_url / model 是否按连接生效
 *  3. 切换时是否正确 rotate 到该连接引用的已保存密钥
 *  4. 表单打开时，「已保存的密钥」下拉是否列出该来源下的全部密钥
 *  5. 保存时选中密钥 → secretRef 是否指向选中的 id
 *
 * 运行：node tests/multi-api.test.mjs
 */
import { Window } from 'file:///D:/TauriTavern/src/TauriTavern-main/node_modules/happy-dom/lib/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, '..', 'index.js'), 'utf8');

setTimeout(() => {
  console.error('❌ 测试超时（15s）');
  process.exit(2);
}, 15000).unref();

const window = new Window({ url: 'http://localhost:8000/' });
const { document } = window;

// ---- ST 页面骨架 ----
document.body.innerHTML = `
  <select id="main_api"><option value="openai">openai</option></select>
  <select id="chat_completion_source">
    <option value="openai">openai</option>
    <option value="custom">custom</option>
    <option value="deepseek">deepseek</option>
  </select>
  <input id="custom_api_url_text" />
  <input id="custom_model_id" />
  <button id="api_button">连接</button>
  <button id="api_button_openai">连接（聊天补全）</button>
`;
let connectClicks = 0;
document.getElementById('api_button_openai').addEventListener('click', () => { connectClicks += 1; });

const chatSettings = {
  chat_completion_source: 'openai',
  custom_url: '',
  custom_model: '',
  openai_model: 'gpt-4o',
  deepseek_model: 'deepseek-chat',
};

const secretState = {
  api_key_custom: [
    { id: 'sec-a', label: 'DeepSeek 官方', value: '*******e57', active: true },
    { id: 'sec-b', label: '中转站 A', value: '*******ab0', active: false },
    { id: 'sec-c', label: '中转站 B', value: '*******af6', active: false },
  ],
  api_key_openai: [{ id: 'sec-oai', label: 'OpenAI', value: '*******123', active: true }],
};

const rotateCalls = [];
const writeCalls = [];

window.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : {};
  if (url === '/api/secrets/read') {
    return { ok: true, status: 200, json: async () => secretState };
  }
  if (url === '/api/secrets/rotate') {
    rotateCalls.push(body);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (url === '/api/secrets/write') {
    writeCalls.push(body);
    return { ok: true, status: 200, json: async () => ({ id: 'new-secret' }) };
  }
  if (url === '/api/backends/chat-completions/status') {
    // 宿主用保存的密钥测试：只认 sec-a / sec-b / sec-c（返回成功）
    if (['sec-a', 'sec-b', 'sec-c'].includes(body.secret_id)) {
      return { ok: true, status: 200, json: async () => ({ data: ['deepseek-chat', 'deepseek-reasoner'] }) };
    }
    return { ok: true, status: 200, json: async () => ({ error: true, message: 'authentication failed' }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// ---- 宿主 ABI mock ----
const connections = Array.from({ length: 6 }, (_, index) => ({
  id: `conn-${index + 1}`,
  displayName: `中转站 ${index + 1} · 一个特别长的名字用来测试省略号`,
  provider: { chatCompletionSource: 'custom' },
  endpoint: { baseUrl: `https://api${index + 1}.example.com/v1` },
  auth: { secretRef: { key: 'api_key_custom', id: `sec-${['a', 'b', 'c', 'a', 'b', 'c'][index]}` } },
  adapterHints: {},
}));

const llmConnections = {
  async list() {
    // 宿主 list 只返回摘要：不带 endpoint
    return {
      connections: connections.map(({ id, displayName, provider }) => ({ id, displayName, provider })),
    };
  },
  async load(arg) {
    const id = arg?.connectionId ?? arg;
    return { connection: connections.find((item) => item.id === id) };
  },
  async save() {
    return { ok: true };
  },
  async delete() {
    return { ok: true };
  },
};

const storage = new Map();
window.localStorage.getItem = (key) => storage.get(key) ?? null;
window.localStorage.setItem = (key, value) => storage.set(key, String(value));
window.localStorage.removeItem = (key) => storage.delete(key);

window.extension_settings = {};
window.saveSettingsDebounced = () => {};
window.SillyTavern = { getContext: () => ({ chatCompletionSettings: chatSettings }) };
window.__TAURITAVERN__ = {
  abiVersion: 1,
  ready: Promise.resolve(),
  api: { llmConnections },
};

window.confirm = () => true;
window.eval(code);

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
await tick(120);

const tam = window.__TAM__;
assert.ok(tam, '扩展未启动（__TAM__ 缺失）');

// 1) 列表：6 条，且长名字不丢
const rows = await tam.store.listConnections();
assert.equal(rows.length, 6, `期望 6 条连接，实际 ${rows.length}`);
assert.ok(rows.every((row) => row.baseUrl && row.baseUrl.endsWith('/v1')), 'list() 摘要应被 load() 补全');
assert.ok(rows[2].name.includes('中转站 3'));

// 2) 渲染 6 行，检查 DOM 结构
const rendered = await tam.render();
const rowNodes = document.querySelectorAll('#tam-connections .tam-row');
assert.equal(rowNodes.length, 6, `DOM 行数应为 6，实际 ${rowNodes.length}`);
for (const node of rowNodes) {
  assert.equal(node.querySelectorAll('.tam-iconbtn').length, 3, '每行应有 3 个图标操作');
  assert.ok(node.querySelector('.tam-avatar')?.textContent, '应有首字母头像');
}

// 3) 逐条切换，验证 source/url/model 与 rotate
for (let index = 0; index < rows.length; index += 1) {
  rotateCalls.length = 0;
  const connection = { ...rows[index], key: '', model: `model-${index + 1}` };
  await tam.store.activate(connection);
  assert.equal(chatSettings.chat_completion_source, 'custom', `第 ${index + 1} 条 source 未切换`);
  assert.equal(chatSettings.custom_url, `https://api${index + 1}.example.com/v1`, `第 ${index + 1} 条 URL 未生效`);
  assert.equal(chatSettings.custom_model, `model-${index + 1}`, `第 ${index + 1} 条模型未生效`);
  assert.equal(rotateCalls.length, 1, `第 ${index + 1} 条应 rotate 一次`);
  assert.equal(rotateCalls[0].key, 'api_key_custom');
  assert.equal(rotateCalls[0].id, connection.secretRef.id, `第 ${index + 1} 条 rotate 到了错误的密钥`);
}

// 3.5) 切到没有模型的连接：应清空上一条的 custom_model，避免沿用
rotateCalls.length = 0;
await tam.store.activate({ ...rows[0], key: '', model: '' });
assert.equal(chatSettings.custom_model, '', '没有模型的连接应清空 custom_model');

// 4) 打开表单：已保存密钥下拉应列出 3 条
const sample = rows[0];
tam.ui.openForm(sample);
await tick(80);
const secretSelect = document.getElementById('tam-f-secret');
assert.ok(secretSelect, '表单缺少密钥下拉');
assert.equal(secretSelect.options.length, 4, '下拉应为 1 个手动项 + 3 个已保存密钥');
assert.equal(secretSelect.value, 'sec-a', '应默认选中当前生效（sec-a）');
assert.equal(document.getElementById('tam-f-key').disabled, true, '默认选中当前生效密钥时应禁用 Key 输入框');

// 切回「手动输入」→ Key 输入框恢复可用
secretSelect.value = '';
secretSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
assert.equal(document.getElementById('tam-f-key').disabled, false, '手动输入时 Key 输入框应可用');

// 选择第二条已保存密钥 → Key 输入框禁用
secretSelect.value = 'sec-b';
secretSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
assert.equal(document.getElementById('tam-f-key').disabled, true, '选中已保存密钥后 Key 输入框应禁用');

// 4.5) 测试连接应走宿主状态接口（用保存的密钥），而不是无 Key 直连报 401
await tam.ui.runTest();
const testText = document.getElementById('tam-f-testresult').textContent;
assert.match(testText, /✓ 可用/, `测试应成功，实际：${testText}`);
assert.match(testText, /宿主/, '应走宿主通道');

// 5) 保存：secretRef 应指向选中的 id，并且保存后自动切换，但不自动点连接
writeCalls.length = 0;
connectClicks = 0;
document.getElementById('tam-f-name').value = '测试连接';
document.getElementById('tam-f-url').value = 'https://api9.example.com/v1';
document.getElementById('tam-f-model').value = 'model-9';
await tam.ui.submitForm();
await tick(1200);
assert.equal(writeCalls.length, 0, '选择已保存密钥时不应再写新 Key');
const savedLocal = tam.settings().items.find((item) => item.name === '测试连接');
assert.ok(savedLocal, '保存后本地应有一条记录');
assert.equal(savedLocal.secretRef?.id, 'sec-b', 'secretRef 应指向下拉选中的 sec-b');
assert.equal(chatSettings.custom_url, 'https://api9.example.com/v1', '保存后应自动应用地址');
assert.equal(connectClicks, 0, '不应自动点击酒馆的连接按钮（避免触发红色报错 Toastr）');
assert.equal(tam.settings().activeId, savedLocal.id, '保存成功后应标记为当前');

tam.ui.closeForm();

// 6) 「读取酒馆配置」遇到同地址同模型时应进入编辑而不是新建
chatSettings.chat_completion_source = 'custom';
chatSettings.custom_url = 'https://api2.example.com/v1';
chatSettings.custom_model = '';
await tam.ui.importCurrentConfig();
await tick(80);
assert.equal(document.getElementById('tam-modal-title').textContent, '编辑 API', '重复配置应进入编辑');
assert.ok(document.getElementById('tam-f-name').value.includes('中转站 2'), '应带入已有配置的名字');
tam.ui.closeForm();

// 7) 没有重复时，应作为「新增 API」打开
chatSettings.custom_url = 'https://api-new.example.com/v1';
await tam.ui.importCurrentConfig();
await tick(80);
assert.equal(document.getElementById('tam-modal-title').textContent, '新增 API', '无重复时应是新增');
tam.ui.closeForm();

// 8) 悬浮球常驻：打开面板时不隐藏，点击悬浮球可以关闭
const fab = document.getElementById('tam-fab');
tam.ui.setOpen(true);
assert.equal(fab.classList.contains('tam-hidden'), false, '打开面板时悬浮球不应隐藏');
assert.equal(fab.classList.contains('is-open'), true, '打开时应有 is-open 状态');
assert.match(fab.getAttribute('aria-label'), /关闭/, '打开时 aria-label 应变为关闭');
fab.click();
assert.equal(tam.settings().panel.open, false, '点击悬浮球应关闭面板');
assert.equal(fab.classList.contains('is-open'), false);

// 9) Key 掩码：来自 secret_state 的掩码值应展示在列表里
assert.equal(rows[0].keyDisplay, '*******e57', '列表应带出宿主掩码后的 Key');
assert.equal(document.querySelectorAll('.tam-footer-btn').length, 3, '底部应有读取/导出/导入三个按钮');

// 10) 导入配置：应写入 items 并以「本地」出现在列表
const importFile = {
  text: async () =>
    JSON.stringify({
      items: [
        {
          id: 'imp-1',
          name: '导入的 API',
          baseUrl: 'https://import.example.com/v1',
          provider: 'custom',
          model: 'import-model',
          key: 'sk-1234567890abcdef',
        },
      ],
    }),
};
await tam.ui.importConfig({ target: { files: [importFile], value: '' } });
await tick(80);
const imported = tam.settings().items.find((entry) => entry.id === 'imp-1');
assert.ok(imported, '导入后 items 应有记录');
assert.equal(imported.key, '', '导入后本地不应保留明文 Key');
assert.ok(imported.secretRef?.id, '导入后应有 secretRef');
const rowsAfterImport = await tam.store.listConnections();
assert.ok(
  rowsAfterImport.some((row) => row.id === 'imp-1' && row.source === 'local'),
  '导入的配置应出现在列表',
);

// 11) 自动故障转移：401 时切到下一条
tam.settings().activeId = 'conn-1';
await tam.failover(401);
await tick(900);
assert.equal(tam.settings().activeId, 'conn-2', '401 应自动切换到下一条 API');

console.log('✅ 多 API 回归测试全部通过：连接 / 切换 / 密钥 / 导入导出 / 悬浮球 / 故障转移');
process.exit(0);

