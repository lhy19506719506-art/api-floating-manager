/**
 * 暴力/恶意输入压力测试（happy-dom）
 *
 * 正常路径：30 条连接、批量切换、保存、导出、悬浮球连点。
 * 异常路径：损坏的设置、localStorage 抛错、宿主接口抛错、超大/畸形导入、
 *          XSS 名称、javascript: 地址、NaN 坐标、SSE 错误体故障转移等。
 *
 * 运行：node tests/stress.test.mjs
 */
import { Window } from 'file:///D:/TauriTavern/src/TauriTavern-main/node_modules/happy-dom/lib/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, '..', 'index.js'), 'utf8');

setTimeout(() => {
  console.error('❌ 压力测试超时（40s）');
  process.exit(2);
}, 40000).unref();

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const fileOf = (value) => ({
  target: {
    value: '',
    files: [{
      text: async () => (typeof value === 'string' ? value : JSON.stringify(value)),
    }],
  },
});

function makeConnections(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `conn-${index + 1}`,
    displayName: `API ${index + 1}`,
    provider: { chatCompletionSource: 'custom' },
    endpoint: { baseUrl: `https://api${index + 1}.example.com/v1` },
    auth: { secretRef: { key: 'api_key_custom', id: `sec-${index + 1}` } },
    adapterHints: {},
  }));
}

function createEnv(options = {}) {
  const {
    connections = makeConnections(3),
    withHost = true,
    storage = new Map(),
    extensionSettings = {},
    fetchImpl = null,
    hostOverrides = {},
    confirmAnswer = true,
    tauriRunning = false,
  } = options;

  const win = new Window({ url: 'http://localhost:8000/' });
  const doc = win.document;

  doc.body.innerHTML = `
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
    <button id="send_but">发送</button>
  `;
  let connectClicks = 0;
  doc.getElementById('api_button_openai').addEventListener('click', () => { connectClicks += 1; });

  const chatSettings = {
    chat_completion_source: 'openai',
    custom_url: '',
    custom_model: '',
    openai_model: 'gpt-4o',
    deepseek_model: 'deepseek-chat',
  };

  const secretState = {
    api_key_custom: [
      { id: 'sec-1', label: '密钥 1', value: '*******e57', active: true },
      { id: 'sec-2', label: '密钥 2', value: '*******ab0', active: false },
    ],
  };
  const calls = { written: [], rotated: [], prompts: [], saved: 0 };
  let chatResponder = null;

  const defaultFetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (url === '/api/secrets/read') {
      return { ok: true, status: 200, json: async () => secretState };
    }
    if (url === '/api/secrets/write') {
      calls.written.push(body);
      const id = `sec-w${calls.written.length}`;
      (secretState[body.key] ??= []).push({ id, label: body.label, value: body.value, active: false });
      return { ok: true, status: 200, json: async () => ({ id }) };
    }
    if (url === '/api/secrets/rotate') {
      calls.rotated.push(body);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url === '/api/backends/chat-completions/status') {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }] }) };
    }
    if (/chat-completions\/generate|\/chat\/completions/.test(url)) {
      if (chatResponder) return chatResponder(url, init);
      return { ok: false, status: 401, json: async () => ({ error: { message: 'unauthorized' } }) };
    }
    if (/\/models$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const llmConnections = {
    async list() {
      return {
        connections: connections.map(({ id, displayName, provider }) => ({ id, displayName, provider })),
      };
    },
    async load(arg) {
      const id = arg?.connectionId ?? arg;
      return { connection: connections.find((item) => item.id === id) };
    },
    async save() {
      calls.saved += 1;
      return { ok: true };
    },
    async delete() {
      return { ok: true };
    },
    ...hostOverrides,
  };

  for (const [key, value] of storage) win.localStorage.setItem(key, value);

  win.extension_settings = extensionSettings;
  win.saveSettingsDebounced = () => {};
  win.SillyTavern = { getContext: () => ({ chatCompletionSettings: chatSettings }) };
  win.confirm = (message) => {
    calls.prompts.push(String(message));
    return confirmAnswer;
  };
  win.fetch = fetchImpl ?? defaultFetch;

  if (tauriRunning) win.__TAURI_RUNNING__ = true;

  if (withHost) {
    win.__TAURITAVERN__ = {
      abiVersion: 1,
      ready: Promise.resolve(),
      api: { llmConnections },
    };
  }

  win.eval(code);

  return {
    win,
    doc,
    chatSettings,
    storage,
    calls,
    llmConnections,
    connectClicks: () => connectClicks,
    setChatResponder: (fn) => { chatResponder = fn; },
  };
}

async function bootEnv(options) {
  const env = createEnv(options);
  await tick(120);
  assert.ok(env.win.__TAM__, '扩展未启动（__TAM__ 缺失）');
  return { ...env, tam: env.win.__TAM__ };
}

function section(name) {
  console.log(`• ${name}`);
}

/* ------------------------------------------------------------------ *
 * 1. 正常用户压力
 * ------------------------------------------------------------------ */
{
  section('正常路径：30 条连接 / 连续切换 / 保存 / 导出');
  const env = await bootEnv({ connections: makeConnections(30) });
  const { tam, doc, chatSettings } = env;

  const rows = await tam.store.listConnections();
  assert.equal(rows.length, 30);
  await tam.render();
  assert.equal(doc.querySelectorAll('#tam-connections .tam-row').length, 30);

  await tam.store.activate({ ...rows[0], key: '', model: 'm-1' });
  await tam.store.activate({ ...rows[29], key: '', model: 'm-30' });
  assert.equal(chatSettings.custom_url, 'https://api30.example.com/v1');
  assert.equal(chatSettings.custom_model, 'm-30');
  assert.equal(tam.settings().activeId, 'conn-30');

  const saved = await tam.store.saveConnection({
    name: '新保存的 API',
    baseUrl: 'https://saved.example.com/v1',
    provider: 'custom',
    model: 'saved-model',
    key: 'sk-saved-1234567890',
  });
  assert.equal(saved.ok, true);
  await tick(350);

  const local = tam.settings().items.find((item) => item.name === '新保存的 API');
  assert.ok(local, '保存后本地应有记录');
  assert.equal(local.key, '', 'Key 进入宿主机密后不应再存本地明文');
  assert.equal(local.secretRef?.id, 'sec-w1');
  assert.equal(env.calls.rotated.at(-1)?.id, 'sec-w1', '新 Key 写入后必须显式激活');
  assert.equal(env.calls.rotated.at(-1)?.key, 'api_key_custom');

  const hostCopy = env.win.extension_settings['tauri-api-manager'];
  assert.ok(hostCopy?.items?.length, '宿主设置里应有脱敏副本');
  assert.ok(hostCopy.items.every((item) => item.key === ''), '宿主设置里不能出现明文 Key');
  assert.doesNotMatch(JSON.stringify(hostCopy), /sk-saved-1234567890/);

  const mirror = JSON.parse(env.win.localStorage.getItem('tauri-api-manager'));
  assert.ok(mirror.items.every((item) => item.key === ''), 'localStorage 里也不应残留新 Key');
}

/* ------------------------------------------------------------------ *
 * 2. 导出：默认脱敏 / 显式带 Key
 * ------------------------------------------------------------------ */
{
  section('导出：默认不含 Key，显式选择才带 Key');
  const env = await bootEnv({ connections: [] });
  const { tam, win } = env;

  let captured = null;
  win.URL.createObjectURL = (blob) => { captured = blob; return 'blob:test'; };
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = () => {};

  await tam.ui.importConfig(fileOf({
    items: [{ id: 'exp-1', name: '导出项', baseUrl: 'https://exp.example.com/v1', provider: 'custom', key: 'sk-export-abcdef' }],
  }));
  await tick(120);
  assert.ok(tam.settings().items.find((item) => item.id === 'exp-1'));

  await tam.ui.exportConfig({ withKeys: false });
  let payload = JSON.parse(await captured.text());
  assert.equal(payload.keysIncluded, false);
  assert.equal(payload.items[0].key, '');
  assert.match(env.doc.getElementById('tam-toast').textContent, /不含 Key/);

  await tam.ui.exportConfig({ withKeys: true });
  payload = JSON.parse(await captured.text());
  assert.equal(payload.keysIncluded, true);
  assert.equal(payload.items[0].key, 'sk-export-abcdef');
}

/* ------------------------------------------------------------------ *
 * 3. 导入：超大 / 畸形 / XSS / 非法协议 / 原型污染
 * ------------------------------------------------------------------ */
{
  section('导入：600 条、XSS、javascript:、null、原型污染');
  const env = await bootEnv({ connections: [] });
  const { tam, doc } = env;

  const huge = Array.from({ length: 600 }, (_, index) => ({
    id: `bulk-${index}`,
    name: `<img src=x onerror="window.__pwned=1"> 批量 ${index}`,
    baseUrl: index % 2 === 0 ? `https://bulk${index}.example.com/v1` : `javascript:alert(${index})`,
    provider: 'custom',
    key: 'sk-bulk-123456',
  }));

  await tam.ui.importConfig(fileOf({ items: huge }));
  await tick(200);

  const items = tam.settings().items;
  assert.ok(items.length <= 500, `导入上限应生效，实际 ${items.length}`);
  assert.equal(items.filter((item) => item.baseUrl.startsWith('javascript:')).length, 0, '非法协议应被丢弃');
  assert.equal(doc.querySelectorAll('#tam-connections img').length, 0, '名称里的 HTML 不能变成节点');
  assert.equal(env.win.__pwned, undefined, 'XSS 不应执行');
  assert.match(doc.getElementById('tam-toast').textContent, /跳过/);
  assert.match(doc.getElementById('tam-toast').textContent, /500/);

  // 畸形输入
  await tam.ui.importConfig(fileOf('{ not json'));
  assert.match(doc.getElementById('tam-toast').textContent, /导入失败/);
  await tam.ui.importConfig(fileOf({ items: [null, 1, [], 'x', { id: 42, name: null, baseUrl: 5 }] }));
  await tick(100);
  assert.match(doc.getElementById('tam-toast').textContent, /已导入/);

  // 原型污染
  await tam.ui.importConfig(fileOf({
    items: [{ id: '__proto__', name: 'pollute', baseUrl: 'https://p.example.com/v1', key: 'sk-p' }],
  }));
  await tick(100);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.polluted, undefined);

  // 超长字符串
  await tam.ui.importConfig(fileOf({
    items: [{ id: 'long-1', name: 'n'.repeat(100000), baseUrl: 'https://long.example.com/v1', model: 'm'.repeat(100000), key: 'k'.repeat(100000) }],
  }));
  await tick(100);
  const longItem = tam.settings().items.find((item) => item.id === 'long-1');
  assert.equal(longItem.name.length, 120);
  assert.equal(longItem.model.length, 120);
  assert.equal(longItem.key, '', '导入后本地不应留明文 Key');
  assert.ok(longItem.secretRef?.id, '导入后应有 secretRef');

  // 2MB 上限
  await tam.ui.importConfig(fileOf(`{"items":[{"name":"${'x'.repeat(2 * 1024 * 1024 + 10)}"}]}`));
  assert.match(doc.getElementById('tam-toast').textContent, /文件过大/);

  // 导入条目伪造宿主连接 id：不能把 Key 塞进宿主连接的本地缓存
  const collide = await bootEnv({ connections: makeConnections(2) });
  await collide.tam.ui.importConfig(fileOf({
    items: [{ id: 'conn-1', name: '伪造', baseUrl: 'https://evil.example/v1', provider: 'custom', key: 'sk-evil-123456' }],
  }));
  const collided = (await collide.tam.store.listConnections()).find((row) => row.id === 'conn-1');
  assert.equal(collided.source, 'host');
  assert.equal(collided.key, '', '导入条目不能覆盖宿主连接的缓存 Key');
}

/* ------------------------------------------------------------------ *
 * 4. 本地存储 / 设置损坏
 * ------------------------------------------------------------------ */
{
  section('存储：损坏 JSON、getItem/setItem 抛错、脱敏回填');
  const storage = new Map([['tauri-api-manager', '{ broken json']]);
  const env = await bootEnv({ connections: [], storage });
  assert.equal(env.tam.settings().items.length, 0);
  env.tam.ui.setOpen(true);
  assert.equal(env.tam.settings().panel.open, true);

  // 宿主设置里 Key 被抹掉，但 localStorage 镜像里还有：应能补回来
  const storage2 = new Map([
    ['tauri-api-manager', JSON.stringify({ items: [{ id: 'a', key: 'sk-mirror-123456', baseUrl: 'https://a.example/v1' }] })],
  ]);
  const env2 = await bootEnv({
    connections: [],
    storage: storage2,
    extensionSettings: {
      'tauri-api-manager': { items: [{ id: 'a', name: 'A', key: '', baseUrl: 'https://a.example/v1' }] },
    },
  });
  const merged = env2.tam.settings().items.find((item) => item.id === 'a');
  assert.equal(merged?.key, 'sk-mirror-123456', '宿主脱敏后应从 localStorage 补回 Key');

  // storage 被拒绝：不应炸掉后续操作
  const env3 = await bootEnv({ connections: [] });
  Object.defineProperty(env3.win, 'localStorage', {
    configurable: true,
    value: {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
      removeItem() {},
    },
  });
  env3.tam.ui.setOpen(true);
  await tick(300);
  assert.equal(env3.tam.settings().panel.open, true);
  assert.ok(env3.doc.getElementById('tam-panel'));
}

/* ------------------------------------------------------------------ *
 * 5. 宿主异常 / 无宿主
 * ------------------------------------------------------------------ */
{
  section('宿主：无 ABI、list 抛错、secrets 抛错、save 失败');
  const noHost = createEnv({ withHost: false });
  await tick(120);
  const tamNoHost = noHost.win.__TAM__;
  assert.ok(tamNoHost, '没有宿主时扩展也应启动');
  assert.equal((await tamNoHost.store.listConnections()).length, 0);
  noHost.doc.getElementById('tam-panel').classList.remove('tam-hidden');
  const activated = await tamNoHost.store.activate({
    id: 'x', name: 'x', baseUrl: 'https://x.example/v1', source: 'local', key: 'sk-x',
  });
  assert.equal(activated.applied, true, '普通酒馆没有 Tauri ABI 时不应被宿主就绪状态拦住');
  assert.equal(noHost.chatSettings.custom_url, 'https://x.example/v1');
  await tick(500);
  assert.equal(noHost.doc.getElementById('tam-host-badge').textContent, '本地模式');
  assert.equal(noHost.doc.getElementById('tam-host-badge').dataset.state, 'warn');

  // 普通酒馆里 /api/secrets/write 失败也不能阻断切换
  const plainNoSecrets = await bootEnv({
    withHost: false,
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  const fallbackSwitch = await plainNoSecrets.tam.store.activate({
    id: 'p0', name: 'P0', baseUrl: 'https://p0.example/v1', source: 'local', key: 'sk-p0',
  });
  assert.equal(fallbackSwitch.applied, true, 'secrets.write 失败时仍应继续切换酒馆设置');
  assert.equal(plainNoSecrets.chatSettings.custom_url, 'https://p0.example/v1');
  assert.match(plainNoSecrets.doc.getElementById('tam-toast').textContent, /仍在尝试切换/);

  // 桌面客户端 ABI 晚注入：不能因为 300ms 没出现就被当成普通酒馆
  const slowTauri = await bootEnv({ withHost: false, tauriRunning: true });
  assert.notEqual(slowTauri.doc.getElementById('tam-host-badge').textContent, '本地模式');
  slowTauri.win.__TAURITAVERN__ = {
    abiVersion: 1,
    ready: Promise.resolve(),
    api: { llmConnections: slowTauri.llmConnections },
  };
  await tick(900);
  assert.equal(slowTauri.doc.getElementById('tam-host-badge').textContent, '宿主已连接');
  assert.equal((await slowTauri.tam.store.listConnections()).length, 3);

  const brokenList = await bootEnv({ hostOverrides: { list: async () => { throw new Error('host down'); } } });
  const fallback = await brokenList.tam.store.listConnections();
  assert.equal(Array.isArray(fallback), true, 'list 失败时应降级为本地列表');

  const brokenSecrets = await bootEnv({
    fetchImpl: async (url, init = {}) => {
      if (url === '/api/secrets/read') throw new Error('network');
      if (url === '/api/secrets/write') throw new Error('network');
      if (url === '/api/secrets/rotate') throw new Error('network');
      const body = init.body ? JSON.parse(init.body) : {};
      if (url === '/api/backends/chat-completions/status') {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  const rows = await brokenSecrets.tam.store.listConnections();
  assert.equal(rows.length, 3, 'secrets 读取失败不应影响列表');

  const saveFails = await bootEnv({ hostOverrides: { save: async () => { throw new Error('invalid connection'); } } });
  const failed = await saveFails.tam.store.saveConnection({
    name: 'x', baseUrl: 'https://x.example/v1', provider: 'custom', key: 'sk-x',
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /invalid connection/);
}

/* ------------------------------------------------------------------ *
 * 6. 悬浮球 / 拖拽坐标
 * ------------------------------------------------------------------ */
{
  section('悬浮球：NaN/Infinity 坐标、连续点击、持久化非法值');
  const env = await bootEnv({ connections: [] });
  const { tam, doc, win } = env;
  const fab = doc.getElementById('tam-fab');

  tam.ui.setFabPosition(NaN, Infinity);
  assert.equal(Number.isNaN(parseFloat(fab.style.left)), false, 'NaN 不能写进 left');
  assert.equal(Number.isNaN(parseFloat(fab.style.top)), false, 'Infinity 不能写进 top');
  assert.ok(parseFloat(fab.style.left) >= 8);

  tam.ui.setPosition(NaN, 'not-a-number');
  const panel = tam.ui.panel;
  assert.equal(Number.isNaN(parseFloat(panel.style.left)), false);

  tam.settings().fab = { x: NaN, y: Infinity };
  tam.ui.restoreFab();
  await tick(50);
  assert.equal(fab.style.left.includes('NaN'), false);

  tam.ui.setOpen(false);
  for (let index = 0; index < 9; index += 1) fab.click();
  assert.equal(tam.settings().panel.open, true, '奇数次点击应打开');
  assert.equal(fab.classList.contains('is-open'), true);

  // 尺寸约定：圆形、44/46px
  const css = readFileSync(path.join(here, '..', 'style.css'), 'utf8');
  assert.match(css, /#tam-fab\s*\{[^}]*width:\s*44px/s);
  assert.match(css, /#tam-fab\s*\{[^}]*border-radius:\s*50%/s);
}

/* ------------------------------------------------------------------ *
 * 7. 协议校验 / 本地条目确认
 * ------------------------------------------------------------------ */
{
  section('安全闸门：javascript: 地址、本地条目确认框');
  const env = await bootEnv({ connections: [] });
  const { tam, chatSettings, calls } = env;

  const blocked = await tam.store.activate({
    id: 'bad', name: 'bad', baseUrl: 'javascript:alert(1)', source: 'local', key: 'sk-bad',
  });
  assert.equal(blocked.applied, false);
  assert.match(blocked.reason, /http/);
  assert.equal(chatSettings.custom_url, '');

  await tam.ui.importConfig(fileOf({
    items: [{ id: 'local-1', name: '本地', baseUrl: 'https://local.example.com/v1', provider: 'custom', key: 'sk-local-abcdef' }],
  }));
  await tick(100);
  tam.settings().activeId = null;
  const activated = await tam.store.activate(tam.settings().items.find((item) => item.id === 'local-1'));
  assert.equal(activated.applied, true);
  assert.ok(calls.prompts.some((message) => message.includes('local.example.com')), '本地条目应弹出确认框');
  assert.equal(tam.settings().items.find((item) => item.id === 'local-1').key, '', '切换后本地明文应清掉');
}

/* ------------------------------------------------------------------ *
 * 8. 故障转移：错误体识别 / 冷却 / 本地条目不参与
 * ------------------------------------------------------------------ */
{
  section('故障转移：SSE 错误体、status 路由排除、本地条目不参与');
  const sseError = `data: ${JSON.stringify({
    id: 'err-1',
    choices: [{ index: 0, delta: { content: '[API Error]\nIncorrect API key provided: 401 unauthorized' } }],
  })}\n\ndata: [DONE]\n\n`;

  const env = createEnv({
    connections: makeConnections(3),
    fetchImpl: async (url) => {
      if (/chat-completions\/generate/.test(url)) {
        return new Response(sseError, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url === '/api/secrets/read') return { ok: true, status: 200, json: async () => ({}) };
      if (url === '/api/secrets/rotate') return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  await tick(120);
  const tam = env.win.__TAM__;
  tam.settings().activeId = 'conn-1';
  const response = await env.win.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
  assert.equal(response.status, 200, '包装器必须原样返回响应');
  await tick(1200);
  assert.equal(tam.settings().activeId, 'conn-2', 'SSE 错误体应触发自动切换');

  // 冷却：紧接着再来一次不应再切
  const before = tam.settings().activeId;
  await tam.failover(401);
  await tick(200);
  assert.equal(tam.settings().activeId, before, '15 秒冷却内不应重复切换');

  // status 路由的 401 不应触发
  const env2 = createEnv({
    connections: makeConnections(3),
    fetchImpl: async (url) => {
      if (url === '/api/backends/chat-completions/status') {
        return { ok: false, status: 401, json: async () => ({ error: true }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await tick(120);
  const tam2 = env2.win.__TAM__;
  tam2.settings().activeId = 'conn-1';
  await env2.win.fetch('/api/backends/chat-completions/status', { method: 'POST' });
  await tick(400);
  assert.equal(tam2.settings().activeId, 'conn-1', 'status 路由的 401 不能触发切换');

  // 全部是本地条目时不应该自动轮换
  const env3 = createEnv({ connections: [] });
  await tick(120);
  const tam3 = env3.win.__TAM__;
  await tam3.ui.importConfig(fileOf({
    items: [
      { id: 'l1', name: 'L1', baseUrl: 'https://l1.example.com/v1', provider: 'custom', key: 'sk-l1' },
      { id: 'l2', name: 'L2', baseUrl: 'https://l2.example.com/v1', provider: 'custom', key: 'sk-l2' },
    ],
  }));
  await tick(100);
  tam3.settings().activeId = 'l1';
  await tam3.failover(401);
  await tick(300);
  assert.equal(tam3.settings().activeId, 'l1', '本地/导入条目不参与自动故障转移');

  // 500 不触发
  const env4 = createEnv({ connections: makeConnections(3) });
  await tick(120);
  const tam4 = env4.win.__TAM__;
  tam4.settings().activeId = 'conn-1';
  await tam4.failover(500);
  await tick(200);
  assert.equal(tam4.settings().activeId, 'conn-1', '500 不应触发切换');
}

/* ------------------------------------------------------------------ *
 * 9. 重复启动 / DOM 注入
 * ------------------------------------------------------------------ */
{
  section('重复启动 / 注入：不应出现重复根节点');
  const env = await bootEnv({ connections: [] });
  env.win.eval(code);
  await tick(60);
  assert.equal(env.doc.querySelectorAll('#tam-root').length, 1);
  assert.equal(env.doc.querySelectorAll('#tam-fab').length, 1);
  assert.equal(env.doc.querySelectorAll('#tam-panel').length, 1);
}

/* ------------------------------------------------------------------ *
 * 10. 表单 change 监听 / 删除清理
 * ------------------------------------------------------------------ */
{
  section('表单：URL/提供商 change 监听、删除时清理本地缓存');
  const env = await bootEnv({ connections: makeConnections(2) });
  const { tam, doc, win } = env;

  tam.ui.openForm(null);
  await tick(40);
  const urlInput = doc.getElementById('tam-f-url');
  urlInput.value = 'https://changed.example/v1';
  doc.getElementById('tam-f-provider').value = 'custom';
  urlInput.dispatchEvent(new win.Event('change', { bubbles: true }));
  await tick(120);
  assert.match(doc.getElementById('tam-secret-hint').textContent, /api_key_custom/, 'change 应触发密钥列表刷新');
  tam.ui.closeForm();

  const saved = await tam.store.saveConnection({
    name: '待删除',
    baseUrl: 'https://delete.example/v1',
    provider: 'custom',
    key: 'sk-delete-123456',
  });
  assert.ok(tam.settings().items.some((item) => item.id === saved.id));
  const localRecord = tam.settings().items.find((item) => item.id === saved.id);
  assert.equal('customApiFormat' in localRecord, false, 'persistLocal 不应再存死字段 customApiFormat');
  const deleted = await tam.store.deleteConnection({ id: saved.id, source: 'host' });
  assert.equal(deleted.ok, true);
  assert.equal(tam.settings().items.some((item) => item.id === saved.id), false, '宿主删除后本地缓存也应清掉');
  assert.equal(tam.settings().activeId === saved.id, false);
}

/* ------------------------------------------------------------------ *
 * 11. 导入 → 刷新 → 再导入（mergeItemKeys 回归）
 * ------------------------------------------------------------------ */
{
  section('导入持久化：Key 落到宿主 secrets，镜像不再存明文');
  const env1 = await bootEnv({ connections: [] });
  await env1.tam.ui.importConfig(fileOf({
    items: [{ id: 'persist-1', name: '持久化', baseUrl: 'https://persist.example/v1', provider: 'custom', key: 'sk-persist-123456' }],
  }));
  await tick(350);
  const mirror = env1.win.localStorage.getItem('tauri-api-manager');
  const hostCopy = JSON.parse(JSON.stringify(env1.win.extension_settings['tauri-api-manager']));
  assert.ok(hostCopy.items.every((item) => item.key === ''), '宿主副本应脱敏');

  const env2 = await bootEnv({
    connections: [],
    storage: new Map([['tauri-api-manager', mirror]]),
    extensionSettings: { 'tauri-api-manager': hostCopy },
  });
  const restored = env2.tam.settings().items.find((item) => item.id === 'persist-1');
  assert.ok(restored, '刷新后导入项应保留');
  assert.equal(restored.key, '', '刷新后本地不应再保留明文 Key');
  assert.ok(restored.secretRef?.id, '刷新后应保留 secretRef');

  await env2.tam.ui.importConfig(fileOf({
    items: [{ id: 'persist-2', name: '第二次导入', baseUrl: 'https://persist2.example/v1', provider: 'custom', key: 'sk-persist-2' }],
  }));
  await tick(100);
  assert.ok(env2.tam.settings().items.some((item) => item.id === 'persist-1'), '旧导入项不能被覆盖丢失');
  assert.ok(env2.tam.settings().items.some((item) => item.id === 'persist-2'), '新导入项应写入');
}

/* ------------------------------------------------------------------ *
 * 12. 故障转移不自动重发
 * ------------------------------------------------------------------ */
{
  section('故障转移：只切换、不点发送');
  const env = await bootEnv({ connections: makeConnections(2) });
  const { tam, doc } = env;
  tam.settings().activeId = 'conn-1';
  let clicks = 0;
  doc.getElementById('send_but').addEventListener('click', () => { clicks += 1; });
  await tam.failover(401);
  await tick(900);
  assert.equal(tam.settings().activeId, 'conn-2', '仍应切换到下一条');
  assert.equal(clicks, 0, '不应自动点击发送，避免重复消息');
}

/* ------------------------------------------------------------------ *
 * 13. 诊断临时连接清理
 * ------------------------------------------------------------------ */
{
  section('诊断：临时连接清理失败要上报，下次探测先扫残留');
  const failing = await bootEnv({
    connections: [],
    hostOverrides: {
      list: async () => ({ connections: [{ id: 'fmtprobe-old', displayName: '__fmt_probe__' }] }),
      save: async () => ({ ok: true }),
      delete: async () => { throw new Error('delete denied'); },
    },
  });
  const failed = await failing.tam.probe();
  assert.ok(failed.cleanupFailed.includes('fmtprobe-old'), '残留临时连接应被记录');
  assert.ok(failed.cleanupFailed.length > 1, '新建后删除失败也应记录');

  const deleted = [];
  const healthy = await bootEnv({
    connections: [],
    hostOverrides: {
      list: async () => ({ connections: [{ id: 'fmtprobe-old', displayName: '__fmt_probe__' }] }),
      save: async () => ({ ok: true }),
      delete: async (arg) => { deleted.push(arg?.connectionId ?? arg); return { ok: true }; },
    },
  });
  const ok = await healthy.tam.probe();
  assert.equal(ok.cleanupFailed.length, 0);
  assert.ok(deleted.includes('fmtprobe-old'), '探测开始时应先清理残留');
}

/* ------------------------------------------------------------------ *
 * 14. UI：圆角 / 圆形悬浮球 / 余额模块已移除
 * ------------------------------------------------------------------ */
{
  section('UI：圆角、圆形按钮、余额模块移除');
  const env = await bootEnv({ connections: [] });
  env.tam.ui.setTab('usage');
  assert.equal(env.tam.ui.queryBalance, undefined, '余额查询函数应已移除');
  assert.equal(env.doc.getElementById('tam-usage').textContent.includes('查询余额'), false);
  assert.equal(env.doc.querySelector('#tam-usage .tam-balance'), null);
  assert.ok(env.doc.getElementById('tam-clear-usage'));

  const toggle = env.doc.getElementById('tam-auto-failover');
  assert.ok(toggle, '应提供自动故障切换开关');
  assert.equal(toggle.checked, true, '默认应开启');
  toggle.checked = false;
  toggle.dispatchEvent(new env.win.Event('change', { bubbles: true }));
  assert.equal(env.tam.settings().autoFailover, false, '关闭开关应持久化');
  env.tam.ui.setTab('usage');
  assert.equal(env.doc.getElementById('tam-auto-failover').checked, false);

  // 原地更新当前行，不应整表重建
  const uiEnv = await bootEnv({ connections: makeConnections(2) });
  await uiEnv.tam.render();
  uiEnv.tam.ui.setActiveRow('conn-2');
  const row2 = uiEnv.doc.querySelector('.tam-row[data-id="conn-2"]');
  assert.ok(row2.classList.contains('is-active'));
  assert.equal(row2.querySelector('.tam-chip.is-accent')?.textContent, '当前');
  assert.equal(uiEnv.doc.querySelectorAll('.tam-row.is-active').length, 1);

  const css = readFileSync(path.join(here, '..', 'style.css'), 'utf8');
  assert.match(css, /--tam-radius-lg:\s*24px/);
  assert.match(css, /#tam-fab\s*\{[^}]*border-radius:\s*50%/s);
  assert.match(css, /#tam-fab\s*\{[^}]*aspect-ratio:\s*1 \/ 1/s);
}

/* ------------------------------------------------------------------ *
 * 15. 切换稳定性：ST source change 会重置模型 / 自动点连接
 * ------------------------------------------------------------------ */
{
  section('切换：source change 重置模型、自动连接被拦截、切换后测试');
  const env = await bootEnv({ connections: makeConnections(2) });
  const { tam, doc, chatSettings } = env;
  const rows = await tam.store.listConnections();

  const sourceSelect = doc.getElementById('chat_completion_source');
  const modelInput = doc.getElementById('custom_model_id');
  chatSettings.custom_model = 'old-model';
  modelInput.value = 'old-model';

  // 模拟 ST 的 #chat_completion_source change：写回来源、把模型重置成旧值、点连接
  sourceSelect.addEventListener('change', () => {
    chatSettings.chat_completion_source = sourceSelect.value;
    modelInput.value = chatSettings.custom_model;
    doc.getElementById('api_button_openai').click();
  });

  const result = await tam.store.activate({ ...rows[0], key: '', model: 'new-model' }, { test: true });
  await tick(300);
  assert.equal(result.applied, true);
  assert.equal(chatSettings.custom_model, 'new-model', 'source change 后必须重新写回模型');
  assert.equal(chatSettings.chat_completion_source, 'custom');
  assert.equal(env.connectClicks(), 1, '只应主动触发一次状态检查，不重复自动连接');
  assert.ok(result.test, '点击切换应带回连接测试结果');
  assert.equal(result.test.ok, true, `切换后测试应成功：${result.test.message}`);
}

/* ------------------------------------------------------------------ *
 * 16. 超级暴力：200 连接 / 100 并发 / 100 次 UI 切换 / 反复诊断
 * ------------------------------------------------------------------ */
{
  section('超级暴力：200 连接、100 并发用量、100 次 UI 切换、反复诊断');
  const env = await bootEnv({ connections: makeConnections(200) });
  const { tam, doc, win } = env;

  const rows = await tam.store.listConnections();
  assert.equal(rows.length, 200);
  await tam.render();
  assert.equal(doc.querySelectorAll('#tam-connections .tam-row').length, 200);

  env.setChatResponder(() =>
    new Response(
      JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
  await Promise.all(Array.from({ length: 100 }, () =>
    win.fetch('/api/backends/chat-completions/generate', { method: 'POST' })));
  await tick(900);
  const day = tam.usage.today();
  assert.equal(day.requests, 100, '100 个并发请求不应丢计数');
  assert.equal(day.prompt, 200);
  assert.equal(day.completion, 300);

  for (let index = 0; index < 100; index += 1) {
    tam.ui.setOpen(index % 2 === 0);
    tam.ui.setTab(['connections', 'usage', 'probe'][index % 3]);
  }
  assert.equal(doc.querySelectorAll('#tam-root').length, 1);
  assert.equal(doc.querySelectorAll('#tam-fab').length, 1);
  assert.equal(doc.querySelectorAll('#tam-panel').length, 1);
}

{
  section('超级暴力：100 条连接故障转移 + 反复诊断无残留');
  const env = await bootEnv({ connections: makeConnections(100) });
  const { tam } = env;
  tam.settings().activeId = 'conn-1';
  await tam.failover(401);
  await tick(900);
  assert.equal(tam.settings().activeId, 'conn-2');
  for (let index = 0; index < 10; index += 1) await tam.failover(429);
  await tick(300);
  assert.equal(tam.settings().activeId, 'conn-2', '冷却内不应反复切换');

  const activeTemp = new Set();
  const healthy = await bootEnv({
    connections: [],
    hostOverrides: {
      list: async () => ({ connections: [...activeTemp].map((id) => ({ id, displayName: '__fmt_probe__' })) }),
      save: async (arg) => { activeTemp.add(arg.connection.id); return { ok: true }; },
      delete: async (arg) => { activeTemp.delete(arg?.connectionId ?? arg); return { ok: true }; },
    },
  });
  for (let index = 0; index < 3; index += 1) {
    const result = await healthy.tam.probe();
    assert.equal(result.cleanupFailed.length, 0);
    assert.equal(activeTemp.size, 0, '反复诊断后不应残留临时连接');
  }
}

/* ------------------------------------------------------------------ *
 * 16. 核心暴力：并发切换 / 随机模型 / 设置读取失败
 * ------------------------------------------------------------------ */
{
  section('核心暴力：5 个并发切换应串行执行');
  const env = await bootEnv({ connections: makeConnections(3) });
  const { tam, chatSettings } = env;
  const rows = await tam.store.listConnections();
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    tam.store.activate({ ...rows[index % rows.length], key: '', model: `burst-${index}` })));
  assert.ok(results.every((result) => result.applied), '并发调用应排队并全部成功');
  assert.equal(tam.settings().activeId, 'conn-2');
  assert.equal(chatSettings.custom_model, 'burst-4');
  assert.equal(chatSettings.chat_completion_source, 'custom');
}

{
  section('核心暴力：随机模型名 / 酒馆设置对象丢失');
  const env = await bootEnv({ connections: makeConnections(3) });
  const { tam, chatSettings } = env;
  const rows = await tam.store.listConnections();
  const models = [
    'model-普通',
    'm" onload="alert(1)',
    `<img src=x onerror="window.__pwned=1">`,
    'x'.repeat(500),
    '',
  ];
  for (let index = 0; index < models.length; index += 1) {
    const result = await tam.store.activate({ ...rows[index % rows.length], key: '', model: models[index] });
    assert.equal(result.applied, true, `第 ${index} 次切换失败：${result.reason}`);
    assert.equal(chatSettings.custom_model, models[index], '模型应完整写入');
  }
  assert.equal(env.win.__pwned, undefined);

  const lost = await bootEnv({ connections: [] });
  lost.win.SillyTavern = {};
  const failed = await lost.tam.store.activate({
    id: 'lost', name: 'lost', baseUrl: 'https://lost.example/v1', source: 'local',
  });
  assert.equal(failed.applied, false);
  assert.match(failed.reason, /未生效|未找到/);
}

{
  section('核心暴力：secrets.activate 失败仍应完成切换');
  const env = await bootEnv({
    connections: [],
    fetchImpl: async (url) => {
      if (url === '/api/secrets/write') {
        return { ok: true, status: 200, json: async () => ({ id: 'sec-raw' }) };
      }
      if (url === '/api/secrets/rotate') {
        return { ok: false, status: 500, json: async () => ({ error: 'rotate failed' }) };
      }
      if (url === '/api/secrets/read') {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  const result = await env.tam.store.activate({
    id: 'rot', name: 'rot', baseUrl: 'https://rot.example/v1', source: 'local', key: 'sk-rot',
  });
  assert.equal(result.applied, true, '激活失败不应阻断酒馆设置切换');
  assert.equal(env.chatSettings.custom_url, 'https://rot.example/v1');
  assert.match(env.doc.getElementById('tam-toast').textContent, /未能设为当前/);
}

console.log('✅ 压力测试全部通过：正常批量 / 恶意导入 / 存储异常 / 宿主异常 / 悬浮球 / 故障转移 / 安全闸门');
process.exit(0);







