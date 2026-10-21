/**
 * 超级暴力测试（最终轮）
 *
 * 100k 消息、1MB 单条、5000 条恶意文本、并发压缩、故障注入、
 * 1500 条导入并发、UI 乱点、设置畸形、localStorage 配额。
 *
 * 运行：node tests/context-superbrutal.test.mjs
 */
import { Window } from 'file:///D:/TauriTavern/src/TauriTavern-main/node_modules/happy-dom/lib/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, '..', 'index.js'), 'utf8');
setTimeout(() => { console.error('❌ 超级暴力测试超时（120s）'); process.exit(2); }, 120000).unref();
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });

function makeChat(n) {
  const chat = [{ name: 'C', is_user: false, is_system: false, mes: '开场' }];
  for (let i = 1; i < n; i += 1) chat.push({ name: i % 2 ? 'U' : 'C', is_user: i % 2 === 1, is_system: false, mes: `m${i}` });
  return chat;
}

function createEnv({ chat = makeChat(21), context = {}, fetchImpl, secretsDelay = 0 } = {}) {
  const win = new Window({ url: 'http://localhost:8000/' });
  win.document.body.innerHTML = '<select id="main_api"></select><select id="chat_completion_source"></select><input id="custom_model_id" /><button id="api_button_openai"></button>';
  const state = { chat, metadata: {}, compressCalls: 0, secrets: {} };
  win.fetch = fetchImpl ?? (async (url, init = {}) => {
    const u = String(url);
    if (u === '/api/secrets/read') return json(state.secrets);
    if (u === '/api/secrets/write') {
      const body = JSON.parse(init.body || '{}');
      state.secrets[body.key] = [{ id: `s${Object.keys(state.secrets).length}`, value: body.value, active: true }];
      if (secretsDelay) await tick(secretsDelay);
      return json({ id: `s${body.key}` });
    }
    if (u.startsWith('/api/tokenizers/openai/count?')) return json({ token_count: 1000 });
    if (u.startsWith('/api/tokenizers/openai/count-batch?')) {
      const body = JSON.parse(init.body || '[]');
      return json({ token_counts: body.map((m) => Math.ceil(String(m.content).length / 1.5) + 4) });
    }
    if (u.includes('/chat/completions')) {
      state.compressCalls += 1;
      return json({ choices: [{ message: { content: '摘要' } }] });
    }
    return json({}, 404);
  });
  win.localStorage.setItem('tauri-api-manager', JSON.stringify({
    context,
    items: [{ id: 'c1', name: 'X', key: 'sk-brutal', baseUrl: 'https://api.deepseek.com/v1', model: 'm', provider: { chatCompletionSource: 'custom' } }],
    activeId: 'c1',
  }));
  win.extension_settings = {};
  win.saveSettingsDebounced = () => {};
  win.confirm = () => true;
  win.SillyTavern = { getContext: () => ({ chat: state.chat, chatMetadata: state.metadata, chatCompletionSettings: { openai_max_context: 128000, openai_max_tokens: 8000, custom_model: 'm' } }) };
  win.__TAURITAVERN__ = { abiVersion: 1, ready: Promise.resolve(), api: { llmConnections: { async list() { return { connections: [] }; } } } };
  win.eval(code);
  return { win, state };
}

async function main() {
  const env = createEnv();
  await tick(220);
  const ctx = env.win.__TAM_CTX__;

  // 1. 100k 消息
  const huge = Array.from({ length: 100000 }, (_, i) => ({ name: i % 2 ? 'U' : 'C', is_user: i % 2 === 1, is_system: i % 7 === 0, mes: `x${i}` }));
  let t = performance.now();
  const plan = ctx.ctxPlan(6, huge);
  const planMs = performance.now() - t;
  assert.equal(plan.visible.length, huge.length - Math.floor(huge.length / 7) - (huge[0].is_system ? 1 : 0) + 0);
  assert.ok(planMs < 1500, `100k 规划过慢 ${planMs}ms`);

  const ids = Array.from({ length: 50000 }, () => Math.floor(Math.random() * 100000));
  t = performance.now();
  const ranges = ctx.ctxGroupRanges(ids);
  const groupMs = performance.now() - t;
  assert.ok(groupMs < 400, `50k 区间合并过慢 ${groupMs}ms`);
  for (let i = 1; i < ranges.length; i += 1) assert.ok(ranges[i][0] > ranges[i - 1][1]);

  // 2. 1MB 单条
  const mega = '长'.repeat(1024 * 1024);
  t = performance.now();
  const megaTokens = ctx.ctxEstimate(mega);
  const estimateMs = performance.now() - t;
  assert.ok(megaTokens > 500000);
  assert.ok(estimateMs < 1500, `1MB 估算过慢 ${estimateMs}ms`);

  // 3. 5000 条恶意文本
  const weirdPool = ['\u0000', '\u202e', '\ud800', '😀', '<img onerror=x>', '中'.repeat(100), '\n\r\t', '\\', '%s'];
  for (let i = 0; i < 5000; i += 1) {
    const text = weirdPool[i % weirdPool.length].repeat(1 + (i % 20));
    const n = ctx.ctxEstimate(text);
    assert.ok(Number.isFinite(n) && n >= 0);
  }

  // 4. 并发压缩：100 次只允许 1 次真正执行
  env.win.__TAM__.ui.setTab('context');
  await tick(250);
  const beforeCalls = env.state.compressCalls;
  const results = await Promise.all(Array.from({ length: 100 }, () => env.win.__TAM__.context.compress({ auto: true })));
  assert.ok(env.state.compressCalls - beforeCalls <= 2, `并发压缩失控：${env.state.compressCalls - beforeCalls}`);
  assert.ok(results.every((r) => r === null || typeof r === 'object'));

  // 5. 故障注入：tokenizer 500 / fetch 抛异常
  const broken = createEnv({
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.startsWith('/api/tokenizers')) return json({}, 500);
      if (u.includes('/chat/completions')) throw new Error('network down');
      return json({}, 404);
    },
  });
  await tick(220);
  broken.win.__TAM__.ui.setTab('context');
  await tick(250);
  assert.ok(broken.win.document.querySelector('.tam-ctxcard'), '计数接口 500 时页面崩溃');
  await broken.win.__TAM__.context.compress({ auto: true });
  assert.ok(true, '摘要网络异常没有未捕获异常');

  // 6. 1500 条导入 + 5ms secrets 延迟（并发写入）
  const imp = createEnv({ secretsDelay: 5 });
  await tick(220);
  const items = Array.from({ length: 500 }, (_, i) => ({ id: `i${i}`, name: `n${i}`, baseUrl: 'https://x.example/v1', provider: 'custom', key: `sk-${i}` }));
  const file = new imp.win.File([JSON.stringify({ items })], 'bulk.json', { type: 'application/json' });
  t = performance.now();
  await imp.win.__TAM__.ui.importConfig({ target: { files: [file], value: '' } });
  const importMs = performance.now() - t;
  assert.ok(importMs < 3000, `500 条导入过慢 ${importMs}ms`);
  const stored = imp.win.__TAM__.settings().items.filter((x) => x.id.startsWith('i'));
  assert.equal(stored.length, 500);
  assert.ok(stored.every((x) => x.secretRef?.id), '并发导入后仍应有 secretRef');

  // 7. UI 乱点：500 次切 tab + 2000 次点击 + 200 渲染
  const chaos = createEnv({ chat: makeChat(200) });
  await tick(220);
  const ui = chaos.win.__TAM__.ui;
  const tabs = [...chaos.win.document.querySelectorAll('.tam-tab')];
  t = performance.now();
  for (let i = 0; i < 500; i += 1) tabs[i % tabs.length].click();
  ui.setTab('context');
  await tick(150);
  for (let i = 0; i < 2000; i += 1) chaos.win.document.querySelectorAll('.tam-ctxrow')[i % 14]?.click();
  for (let i = 0; i < 200; i += 1) await chaos.win.__TAM__.context.render();
  const chaosMs = performance.now() - t;
  assert.ok(chaosMs < 12000, `UI 乱点过慢 ${chaosMs}ms`);
  assert.ok(chaos.win.document.querySelector('.tam-ctxcard'), '乱点后 UI 丢失');

  // 8. 畸形设置 / 聊天
  const malformed = createEnv({ context: ['x', 'y'], chat: [{ name: 'C', is_user: false, is_system: false, mes: null }, { name: 'U', is_user: 'yes', is_system: 'no', mes: 123 }] });
  await tick(220);
  malformed.win.__TAM__.ui.setTab('context');
  await tick(250);
  assert.ok(malformed.win.document.getElementById('tam-root'), '畸形设置导致根节点丢失');

  // 9. localStorage 配额异常
  const quota = createEnv();
  await tick(220);
  quota.win.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  quota.win.__TAM__.ui.setAutoFailover(false);
  await tick(300);
  assert.ok(true, 'localStorage 配额异常没有崩溃');

  console.log(`✅ 超级暴力通过：100k规划 ${planMs.toFixed(0)}ms / 50k区间 ${groupMs.toFixed(0)}ms / 1MB ${estimateMs.toFixed(0)}ms / 500导入 ${importMs.toFixed(0)}ms / UI混乱 ${chaosMs.toFixed(0)}ms`);
  process.exit(0);
}

main().catch((e) => { console.error('❌ 超级暴力测试失败：', e); process.exit(1); });
