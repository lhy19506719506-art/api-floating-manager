/**
 * 上下文暴力测试（happy-dom + 纯函数）
 *
 * 10,000 条消息、5,000 次随机设置、1,000 次点击、200 次渲染、50 次并发压缩。
 *
 * 运行：node tests/context-brutal.test.mjs
 */
import { Window } from 'file:///D:/TauriTavern/src/TauriTavern-main/node_modules/happy-dom/lib/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, '..', 'index.js'), 'utf8');

setTimeout(() => {
  console.error('❌ 暴力测试超时（60s）');
  process.exit(2);
}, 60000).unref();

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function createEnv(chat) {
  const win = new Window({ url: 'http://localhost:8000/' });
  win.document.body.innerHTML = '<select id="main_api"></select><select id="chat_completion_source"></select><input id="custom_model_id" /><button id="api_button_openai"></button>';
  const state = { chat, metadata: {}, compressions: 0 };
  win.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('/api/tokenizers/openai/count?')) return jsonResponse({ token_count: 12345 });
    if (u.startsWith('/api/tokenizers/openai/count-batch?')) {
      const body = JSON.parse(init.body || '[]');
      return jsonResponse({ token_counts: body.map(() => 40) });
    }
    if (u === '/api/secrets/read') return jsonResponse({});
    if (u.includes('/chat/completions')) {
      state.compressions += 1;
      return jsonResponse({ choices: [{ message: { content: '摘要' } }] });
    }
    return jsonResponse({}, 404);
  };
  win.localStorage.setItem('tauri-api-manager', JSON.stringify({
    items: [{ id: 'c1', name: 'X', baseUrl: 'https://api.deepseek.com/v1', model: 'm', provider: { chatCompletionSource: 'custom' } }],
    activeId: 'c1',
  }));
  win.extension_settings = {};
  win.saveSettingsDebounced = () => {};
  win.confirm = () => true;
  win.SillyTavern = { getContext: () => ({ chat: state.chat, chatMetadata: state.metadata, chatCompletionSettings: { openai_max_context: 128000, openai_max_tokens: 8000 } }) };
  win.__TAURITAVERN__ = { abiVersion: 1, ready: Promise.resolve(), api: { llmConnections: { async list() { return { connections: [] }; } } } };
  win.eval(code);
  return { win, state };
}

async function main() {
  const big = [];
  for (let i = 0; i < 10000; i += 1) {
    big.push({ name: i % 2 ? 'U' : 'C', is_user: i % 2 === 1, is_system: false, mes: `m${i}` });
  }

  const env = createEnv(big);
  await tick(240);
  const ctx = env.win.__TAM_CTX__;
  assert.ok(ctx);

  // 1. 10k 条消息的规划 / 区间 / 估算
  let t = performance.now();
  const plan = ctx.ctxPlan(6, big);
  const planMs = performance.now() - t;
  assert.equal(plan.visible.length, 10000);
  assert.ok(planMs < 800, `10k 规划过慢：${planMs.toFixed(0)}ms`);

  const ids = Array.from({ length: 5000 }, () => Math.floor(Math.random() * 10000));
  t = performance.now();
  const ranges = ctx.ctxGroupRanges(ids);
  const groupMs = performance.now() - t;
  assert.ok(groupMs < 200, `5k 区间合并过慢：${groupMs.toFixed(0)}ms`);
  for (let i = 1; i < ranges.length; i += 1) assert.ok(ranges[i][0] > ranges[i - 1][1]);

  const mega = '中'.repeat(1000000);
  t = performance.now();
  const megaTokens = ctx.ctxEstimate(mega);
  const estimateMs = performance.now() - t;
  assert.ok(megaTokens > 500000 && megaTokens < 900000, `百万字估算异常：${megaTokens}`);
  assert.ok(estimateMs < 1200, `百万字估算过慢：${estimateMs.toFixed(0)}ms`);

  // 2. 随机设置 fuzz
  for (let i = 0; i < 5000; i += 1) {
    const decision = ctx.ctxAutoDecision({
      settings: {
        autoEvery: [0, -3, 5, 'abc', null, Infinity][i % 6],
        threshold: [0.8, NaN, -1, 2, '0.5'][i % 5],
      },
      visible: big.slice(0, i % 40).map((m, index) => ({ index, isUser: m.is_user })),
      meta: i % 3 ? { end: i % 20 } : null,
      tokens: (i * 37) % 100000,
      usable: [1000, 0, -5][i % 3],
    });
    assert.equal(typeof decision.trigger, 'boolean');
    assert.ok(!Number.isNaN(decision.roundsSince));
  }

  // 3. 随机隐藏分布：target 永不包含首楼或隐藏楼层
  for (let i = 0; i < 500; i += 1) {
    const chat = big.slice(0, 2 + (i % 30)).map((m, index) => ({
      ...m,
      mes: `x${index}`,
      is_system: Math.random() < 0.3,
    }));
    const p = ctx.ctxPlan(2 + (i % 8), chat);
    assert.ok(p.target.every((m) => m.index > 0));
    assert.ok(p.target.every((m) => !chat[m.index].is_system));
  }

  // 4. 1,000 次点击
  const { win } = env;
  win.__TAM__.ui.setOpen(true);
  win.__TAM__.ui.setTab('context');
  await tick(300);
  const rows = [...win.document.querySelectorAll('#tam-ctx-list .tam-ctxrow')];
  assert.ok(rows.length > 0, '没有渲染出消息行');
  t = performance.now();
  for (let i = 0; i < 1000; i += 1) rows[i % rows.length].click();
  const clickMs = performance.now() - t;
  assert.ok(clickMs < 2500, `1000 次点击过慢：${clickMs.toFixed(0)}ms`);

  // 5. 200 次渲染
  t = performance.now();
  for (let i = 0; i < 200; i += 1) await win.__TAM__.context.render();
  const renderMs = performance.now() - t;
  assert.ok(renderMs < 8000, `200 次渲染过慢：${renderMs.toFixed(0)}ms`);
  assert.ok(win.document.querySelector('.tam-ctxcard'), '渲染后卡片丢失');

  // 6. 50 次并发压缩：串行保护，不应抛未捕获异常
  const results = await Promise.all(
    Array.from({ length: 50 }, () => win.__TAM__.context.compress({ auto: true })),
  );
  assert.ok(results.some((r) => r === null || r), '压缩全部失败');
  assert.ok(env.state.compressions <= 5, `并发压缩次数失控：${env.state.compressions}`);

  // 7. 畸形 chat：mes 为 null / 数字 / 超长文本
  const weirdChat = [
    { name: 'C', is_user: false, is_system: false, mes: null },
    { name: 'U', is_user: true, is_system: false, mes: 12345 },
    { name: 'C', is_user: false, is_system: false, mes: '长'.repeat(200000) },
    { name: 'U', is_user: true, is_system: 'yes', mes: 'ok' },
  ];
  const weirdEnv = createEnv(weirdChat);
  await tick(240);
  weirdEnv.win.__TAM__.ui.setTab('context');
  await tick(300);
  assert.ok(weirdEnv.win.document.querySelector('.tam-ctxcard'), '畸形消息导致渲染失败');

  // 8. 随机 fuzz：不限定输入形态
  for (let i = 0; i < 2000; i += 1) {
    const size = Math.floor(Math.random() * 500);
    const chat = Array.from({ length: size }, (_, index) => ({
      index,
      isUser: Math.random() < 0.5,
      is_system: Math.random() < 0.3,
      mes: '字'.repeat(Math.floor(Math.random() * 50)),
    }));
    const keep = 2 + Math.floor(Math.random() * 18);
    const plan = ctx.ctxPlan(keep, chat);
    assert.ok(plan.target.every((m) => m.index > 0));
    assert.ok(plan.target.every((m) => !chat[m.index].is_system));

    const decision = ctx.ctxAutoDecision({
      settings: { autoEvery: Math.floor(Math.random() * 21), threshold: Math.random() },
      visible: plan.visible.map((m) => ({ index: m.index, isUser: m.isUser })),
      meta: Math.random() < 0.5 ? { end: Math.floor(Math.random() * size) } : null,
      tokens: Math.floor(Math.random() * 200000),
      usable: 1000 + Math.floor(Math.random() * 200000),
    });
    assert.equal(typeof decision.trigger, 'boolean');

    const text = 'x'.repeat(Math.floor(Math.random() * 5000));
    assert.ok(ctx.ctxEstimate(text) >= 0);
  }
  console.log('✓ fuzz 2000 组随机聊天/设置/文本无异常');

  console.log(`✅ 暴力测试通过：10k 规划 ${planMs.toFixed(0)}ms / 5k 区间 ${groupMs.toFixed(0)}ms / 百万字 ${estimateMs.toFixed(0)}ms / 1000 点击 ${clickMs.toFixed(0)}ms / 200 渲染 ${renderMs.toFixed(0)}ms`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 暴力测试失败：', err);
  process.exit(1);
});
