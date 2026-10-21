/**
 * 用量页测试（happy-dom）
 *
 * 覆盖：
 *  1. JSON 响应里的 usage 累加
 *  2. SSE 尾部 usage 提取
 *  3. 错误响应不计数
 *  4. 31 天裁剪
 *  5. 大数字格式化 / UI 不溢出
 *  6. 异常 usage 值 / 并发请求
 *  7. 清空统计
 *
 * 运行：node tests/usage.test.mjs
 */
import { Window } from 'file:///D:/TauriTavern/src/TauriTavern-main/node_modules/happy-dom/lib/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, '..', 'index.js'), 'utf8');

setTimeout(() => {
  console.error('❌ 用量测试超时（30s）');
  process.exit(2);
}, 30000).unref();

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const localDayKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const sseResponse = (frames) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
};

const chatOk = (usage) =>
  jsonResponse({
    id: 'x',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
    ...(usage ? { usage } : {}),
  });

function makeConnections() {
  return [
    {
      id: 'ds-host',
      displayName: 'DeepSeek Host',
      provider: { chatCompletionSource: 'deepseek' },
      endpoint: { baseUrl: 'https://api.deepseek.com' },
      auth: { secretRef: { key: 'api_key_deepseek', id: 'sec-ds' } },
      adapterHints: {},
    },
    {
      id: 'other-host',
      displayName: 'OpenAI Host',
      provider: { chatCompletionSource: 'custom' },
      endpoint: { baseUrl: 'https://api.openai.example/v1' },
      auth: { secretRef: { key: 'api_key_custom', id: 'sec-oa' } },
      adapterHints: {},
    },
  ];
}

function createEnv() {
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

  const chatSettings = {
    chat_completion_source: 'deepseek',
    custom_url: '',
    custom_model: '',
    deepseek_model: 'deepseek-chat',
  };
  const secretState = {
    api_key_deepseek: [{ id: 'sec-ds', label: 'DeepSeek', value: '*******e57', active: true }],
    api_key_custom: [{ id: 'sec-oa', label: 'OpenAI', value: '*******123', active: true }],
  };
  const calls = {};
  let chatResponder = () => chatOk();

  win.fetch = async (url, init = {}) => {
    if (url === '/api/secrets/read') return jsonResponse(secretState);
    if (url === '/api/secrets/write') return jsonResponse({ id: 'sec-new' });
    if (url === '/api/secrets/rotate') return jsonResponse({ ok: true });
    if (url === '/api/backends/chat-completions/status') return jsonResponse({ data: [] });
    if (/chat-completions\/generate|\/chat\/completions/.test(String(url))) {
      return chatResponder(String(url), init);
    }
    return jsonResponse({}, 404);
  };

  const connections = makeConnections();
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
      return { ok: true };
    },
    async delete() {
      return { ok: true };
    },
  };

  win.extension_settings = {};
  win.saveSettingsDebounced = () => {};
  win.SillyTavern = { getContext: () => ({ chatCompletionSettings: chatSettings }) };
  win.confirm = () => true;
  win.__TAURITAVERN__ = { abiVersion: 1, ready: Promise.resolve(), api: { llmConnections } };
  win.eval(code);

  return {
    win,
    doc,
    calls,
    chatSettings,
    setChatResponder: (fn) => { chatResponder = fn; },
  };
}

async function boot() {
  const env = createEnv();
  await tick(140);
  assert.ok(env.win.__TAM__, '扩展未启动');
  return { ...env, tam: env.win.__TAM__ };
}

/* 1. JSON usage 累加 + 无 usage 也计数 */
{
  const env = await boot();
  const { tam, win, doc } = env;

  env.setChatResponder(() => chatOk({ prompt_tokens: 10, completion_tokens: 5 }));
  await win.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
  await tick(120);
  let day = tam.usage.today();
  assert.deepEqual({ ...day }, { requests: 1, prompt: 10, completion: 5, updatedAt: day.updatedAt });
  assert.ok(day.updatedAt > 0);

  await win.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
  await tick(120);
  day = tam.usage.today();
  assert.equal(day.requests, 2);
  assert.equal(day.prompt, 20);
  assert.equal(day.completion, 10);

  // 没有 usage 字段：只记请求次数
  env.setChatResponder(() => chatOk());
  await win.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
  await tick(120);
  day = tam.usage.today();
  assert.equal(day.requests, 3);
  assert.equal(day.prompt, 20);

  tam.ui.setTab('usage');
  const values = [...doc.querySelectorAll('#tam-usage .tam-stat b')].map((node) => node.textContent);
  assert.deepEqual(values.slice(0, 3), ['3', '20', '10']);
  assert.ok(doc.getElementById('tam-clear-usage'), '应有清空统计按钮');
  assert.match(doc.getElementById('tam-usage').textContent, /今日/);
}

/* 2. SSE 尾部 usage + 错误流不计数 */
{
  const env = await boot();
  const { tam, win } = env;

  env.setChatResponder(() =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":45}}\n\n',
      'data: [DONE]\n\n',
    ]));
  await win.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
  await tick(220);
  let day = tam.usage.today();
  assert.equal(day.requests, 1);
  assert.equal(day.prompt, 120);
  assert.equal(day.completion, 45);

  env.setChatResponder(() =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"[API Error] 401 unauthorized"}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
  await win.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
  await tick(220);
  day = tam.usage.today();
  assert.equal(day.requests, 1, '错误流不应计数');
  assert.equal(day.prompt, 120);
}

/* 3. 31 天裁剪 */
{
  const env = await boot();
  const { tam, win } = env;
  const days = {};
  for (let index = 0; index < 40; index += 1) {
    const date = new Date();
    date.setDate(date.getDate() - index);
    days[localDayKey(date)] = { requests: 1, prompt: 1, completion: 1, updatedAt: Date.now() };
  }
  tam.settings().usage = { days };

  env.setChatResponder(() => chatOk({ prompt_tokens: 2, completion_tokens: 3 }));
  await win.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
  await tick(150);

  const stored = tam.settings().usage.days;
  assert.ok(Object.keys(stored).length <= 31, `最多保留 31 天，实际 ${Object.keys(stored).length}`);
  assert.equal(stored[localDayKey()].requests, 2);
}

/* 4. 大数字格式化 / 溢出防护 */
{
  const env = await boot();
  const { tam, win, doc } = env;

  env.setChatResponder(() =>
    chatOk({ prompt_tokens: 987654321098, completion_tokens: 1234567890123 }));
  await win.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
  await tick(160);
  tam.ui.setTab('usage');

  const nodes = [...doc.querySelectorAll('#tam-usage .tam-stat b')];
  assert.equal(nodes[0].textContent, '1');
  assert.match(nodes[1].textContent, /亿$/);
  assert.match(nodes[2].textContent, /万亿$/);
  for (const node of nodes) {
    assert.ok(node.textContent.length <= 8, `数字文案过长：${node.textContent}`);
    assert.doesNotMatch(node.textContent, /\d{9,}/, '不应直接显示超长数字');
  }
  assert.ok(nodes[1].title.includes(','));
  assert.ok(nodes[2].title.includes(','));

  assert.ok(tam.usage.format(9999999999999999).length <= 8);
  assert.ok(tam.usage.format(12345).length <= 6);
  const css = readFileSync(path.join(here, '..', 'style.css'), 'utf8');
  assert.match(css, /\.tam-stat b\s*\{[^}]*text-overflow:\s*ellipsis/s);
}

/* 5. 清空统计 */
{
  const env = await boot();
  const { tam, win, doc } = env;
  env.setChatResponder(() => chatOk({ prompt_tokens: 9, completion_tokens: 4 }));
  await win.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
  await tick(120);
  tam.ui.setTab('usage');
  assert.equal(tam.usage.today().requests, 1);

  tam.ui.clearUsage();
  await tick(80);
  const day = tam.usage.today();
  assert.equal(day.requests, 0);
  assert.equal(day.prompt, 0);
  assert.equal(day.completion, 0);
  const values = [...doc.querySelectorAll('#tam-usage .tam-stat b')].map((node) => node.textContent);
  assert.deepEqual(values.slice(0, 3), ['0', '0', '0']);
}

/* 6. 异常 usage 值 / 并发请求 */
{
  const env = await boot();
  const { tam, win } = env;
  const before = tam.usage.today();

  env.setChatResponder(() => chatOk({ prompt_tokens: 'abc', completion_tokens: -5 }));
  await win.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
  await tick(120);
  let day = tam.usage.today();
  assert.equal(day.requests, before.requests + 1);
  assert.equal(day.prompt, before.prompt);
  assert.equal(day.completion, before.completion);

  env.setChatResponder(() => chatOk({ prompt_tokens: 1e300, completion_tokens: 1e300 }));
  await win.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
  await tick(120);
  day = tam.usage.today();
  assert.equal(day.prompt, 1e15, '异常大值应被截断');
  assert.ok(tam.usage.format(day.prompt).length <= 8);

  env.setChatResponder(() => chatOk({ prompt_tokens: 1, completion_tokens: 1 }));
  await Promise.all(Array.from({ length: 5 }, () =>
    win.fetch('/api/backends/chat-completions/generate', { method: 'POST' })));
  await tick(220);
  day = tam.usage.today();
  assert.equal(day.requests, before.requests + 7, '并发请求不应丢计数');
}

console.log('✅ 用量测试全部通过：JSON/SSE 提取、错误不计数、31 天裁剪、大数字不溢出、清空统计');
process.exit(0);
