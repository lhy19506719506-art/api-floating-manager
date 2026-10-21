/**
 * 上下文管家测试（happy-dom）
 *
 * 覆盖：
 *  1. token 估算（中英）
 *  2. 摘要提示词约束
 *  3. 压缩范围：保留最近 N 轮、首楼永不压缩
 *  4. 预算：跟随酒馆 / 手动上限 / 回复预留
 *  5. 精确计数接口优先，失败退化估算
 *
 * 运行：node tests/context.test.mjs
 */
import { Window } from 'file:///D:/TauriTavern/src/TauriTavern-main/node_modules/happy-dom/lib/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, '..', 'index.js'), 'utf8');

setTimeout(() => {
  console.error('❌ 上下文测试超时（30s）');
  process.exit(2);
}, 30000).unref();

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function makeChat(turns = 15) {
  const chat = [{ name: 'Fuka', is_user: false, is_system: false, mes: '开场白' }];
  for (let i = 0; i < turns; i++) {
    chat.push({ name: 'User', is_user: true, is_system: false, mes: `用户第${i + 1}轮` });
    chat.push({ name: 'Fuka', is_user: false, is_system: false, mes: `角色第${i + 1}轮` });
  }
  return chat;
}

function createEnv({ chat, settings, context } = {}) {
  const win = new Window({ url: 'http://localhost:8000/' });
  win.document.body.innerHTML = `
    <select id="main_api"><option value="openai">openai</option></select>
    <select id="chat_completion_source"><option value="custom">custom</option></select>
    <input id="custom_api_url_text" />
    <input id="custom_model_id" />
    <button id="api_button_openai">连接</button>
  `;

  const state = {
    chat: chat ?? makeChat(),
    chatSettings: settings ?? { openai_max_context: 50000, openai_max_tokens: 5000, custom_model: 'm' },
    chatMetadata: {},
    contextSettings: context ?? {},
    countCalls: 0,
  };

  win.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/tokenizers/openai/count?')) {
      state.countCalls += 1;
      return jsonResponse({ token_count: 1234 });
    }
    if (u.startsWith('/api/tokenizers/openai/count-batch?')) {
      return jsonResponse({ token_counts: state.chat.map(() => 10) });
    }
    if (u === '/api/secrets/read') return jsonResponse({});
    return jsonResponse({}, 404);
  };

  win.localStorage.setItem('tauri-api-manager', JSON.stringify({ context: state.contextSettings }));
  win.extension_settings = {};
  win.saveSettingsDebounced = () => {};
  win.SillyTavern = {
    getContext: () => ({
      chat: state.chat,
      chatId: state.chatId,
      chatCompletionSettings: state.chatSettings,
      chatMetadata: state.chatMetadata,
    }),
  };
  win.eval(code);

  return { win, state };
}

async function main() {
  const { win, state } = createEnv({ context: { keepTurns: 6 } });
  await tick(80);

  const ctx = win.__TAM_CTX__;
  assert.ok(ctx, '缺少 __TAM_CTX__ 测试出口');

  // 1. 估算
  const zh = ctx.ctxEstimate('中'.repeat(100));
  const en = ctx.ctxEstimate('a'.repeat(100));
  assert.ok(zh > 60 && zh < 90, `中文估算异常：${zh}`);
  assert.ok(en > 20 && en < 35, `英文估算异常：${en}`);
  assert.equal(ctx.ctxEstimate(''), 0);

  // 2. 摘要提示词
  const prompt = ctx.ctxSummaryPrompt('用户：你好', 240);
  assert.ok(prompt.includes('前情提要'));
  assert.ok(prompt.includes('不要编造'));
  assert.ok(prompt.includes('用户：你好'));
  const merged = ctx.ctxSummaryPrompt('用户：新对话', 240, '旧提要：铜钥匙在口袋里');
  assert.ok(merged.includes('旧提要：铜钥匙在口袋里'));
  assert.ok(merged.includes('合并'));

  // 3. 压缩范围
  const plan = ctx.ctxPlan(6);
  assert.equal(plan.visible.length, 31);
  assert.equal(plan.target.length, 18, `应压缩前 18 条，实际 ${plan.target.length}`);
  assert.equal(plan.target[0].index, 1, '首楼不能进压缩范围');
  assert.ok(plan.target.every((m) => m.index > 0));

  // 再压也不会碰首楼
  const plan2 = ctx.ctxPlan(2);
  assert.ok(plan2.target.every((m) => m.index > 0));

  // 3.5 区间合并
  assert.equal(JSON.stringify(ctx.ctxGroupRanges([5, 6, 7, 9, 12, 13])), '[[5,7],[9,9],[12,13]]');
  assert.equal(JSON.stringify(ctx.ctxGroupRanges([3])), '[[3,3]]');
  assert.equal(JSON.stringify(ctx.ctxGroupRanges([])), '[]');
  assert.equal(JSON.stringify(ctx.ctxGroupRanges([9, 8, 1, 2])), '[[1,2],[8,9]]');

  // 4. 预算
  const budget = ctx.ctxBudget();
  assert.equal(budget.limit, 50000);
  assert.equal(budget.usable, 45000);

  win.localStorage.setItem('tauri-api-manager', JSON.stringify({ context: { budgetOverride: 65536 } }));
  win.__TAM_BOOTED__ = true; // 防止重复 boot 干扰
  const { win: win2 } = createEnv({ context: { budgetOverride: 65536 } });
  await tick(80);
  const budget2 = win2.__TAM_CTX__.ctxBudget();
  assert.equal(budget2.limit, 50000, '手动上限不能超过酒馆设置');
  assert.equal(budget2.override, 65536);

  // 5. 精确计数优先
  const total = await ctx.ctxCountTotal([{ isUser: true, text: '你好' }]);
  assert.equal(total.tokens, 1234);
  assert.equal(total.exact, true);
  assert.ok(state.countCalls >= 1);

  // 接口挂了要退化估算
  win.fetch = async () => jsonResponse({}, 500);
  const fallback = await ctx.ctxCountTotal([
    { isUser: true, text: '中'.repeat(100) },
    { isUser: false, text: 'a'.repeat(100) },
  ]);
  assert.equal(fallback.exact, false);
  assert.ok(fallback.tokens > 60);

  // 6. 自动压缩判定：按轮数 / 按比例 / 截止上次压缩
  const visible = [];
  for (let i = 1; i <= 12; i += 1) {
    visible.push({ index: i, isUser: i % 2 === 1 });
  }
  const baseSettings = { autoEvery: 0, threshold: 0.8 };
  assert.equal(ctx.ctxAutoDecision({ settings: baseSettings, visible, meta: null, tokens: 0, usable: 1000 }).trigger, false);
  assert.equal(ctx.ctxAutoDecision({ settings: { ...baseSettings, autoEvery: 5 }, visible, meta: null, tokens: 0, usable: 1000 }).byCount, true);
  assert.equal(ctx.ctxAutoDecision({ settings: { ...baseSettings, autoEvery: 2 }, visible, meta: null, tokens: 0, usable: 1000 }).byCount, true);
  assert.equal(ctx.ctxAutoDecision({ settings: { ...baseSettings, autoEvery: 20 }, visible, meta: null, tokens: 0, usable: 1000 }).byCount, false);
  assert.equal(ctx.ctxAutoDecision({ settings: baseSettings, visible, meta: null, tokens: 900, usable: 1000 }).byRatio, true);
  assert.equal(ctx.ctxAutoDecision({ settings: baseSettings, visible, meta: null, tokens: 700, usable: 1000 }).byRatio, false);
  const afterMeta = ctx.ctxAutoDecision({ settings: { ...baseSettings, autoEvery: 3 }, visible, meta: { end: 8 }, tokens: 0, usable: 1000 });
  assert.equal(afterMeta.roundsSince, 2, `上次压缩后只应看到 2 轮，实际 ${afterMeta.roundsSince}`);
  assert.equal(afterMeta.byCount, false);

  // 7. 压缩范围：显式传入 chat，跳过隐藏楼层，首楼不动
  const chat2 = [
    { name: 'C', is_user: false, is_system: false, mes: '开场' },
    { name: 'U', is_user: true, is_system: true, mes: '已隐藏' },
    { name: 'C', is_user: false, is_system: false, mes: 'a' },
    { name: 'U', is_user: true, is_system: false, mes: 'b' },
    { name: 'C', is_user: false, is_system: false, mes: 'c' },
    { name: 'U', is_user: true, is_system: false, mes: 'd' },
    { name: 'C', is_user: false, is_system: false, mes: 'e' },
    { name: 'U', is_user: true, is_system: false, mes: 'f' },
  ];
  const plan3 = ctx.ctxPlan(1, chat2);
  assert.equal(plan3.visible.length, 7);
  assert.ok(plan3.target.every((m) => m.index > 0));
  assert.ok(plan3.target.every((m) => m.index !== 1), '隐藏楼层不能进压缩目标');

  // 8. 暴力：5000 条消息 / 随机选择 / 异常设置
  const bigChat = [];
  for (let i = 0; i < 5000; i += 1) {
    bigChat.push({ name: i % 2 ? 'U' : 'C', is_user: i % 2 === 1, is_system: false, mes: `m${i}` });
  }
  const t0 = performance.now();
  const bigPlan = ctx.ctxPlan(6, bigChat);
  const planCost = performance.now() - t0;
  assert.equal(bigPlan.visible.length, 5000);
  assert.equal(bigPlan.target.length, 5000 - 12 - 1);
  assert.ok(planCost < 300, `5000 条消息的压缩计划耗时 ${planCost.toFixed(1)}ms，过慢`);

  const ids = [];
  for (let i = 0; i < 3000; i += 1) ids.push(Math.floor(Math.random() * 5000));
  const t1 = performance.now();
  const ranges = ctx.ctxGroupRanges(ids);
  const groupCost = performance.now() - t1;
  assert.ok(groupCost < 100, `3000 个索引合并耗时 ${groupCost.toFixed(1)}ms，过慢`);
  for (let i = 1; i < ranges.length; i += 1) {
    assert.ok(ranges[i][0] > ranges[i - 1][1], '区间不能重叠');
  }

  const weird = ctx.ctxAutoDecision({
    settings: { autoEvery: 'abc', threshold: NaN },
    visible: bigChat.slice(0, 10).map((m, i) => ({ index: i, isUser: m.is_user })),
    meta: { end: 999 },
    tokens: 0,
    usable: 0,
  });
  assert.equal(weird.trigger, false, '异常设置不应该触发自动压缩');

  const allHidden = bigChat.map((m, i) => ({ ...m, is_system: true, mes: `h${i}` }));
  assert.equal(ctx.ctxPlan(6, allHidden).visible.length, 0, '全部隐藏时不应有可见消息');


  // 8.5 聊天身份守卫
  const chatRef = state.chat;
  state.chatId = 'a';
  assert.equal(ctx.ctxChatUnchanged(chatRef, 'a'), true);
  assert.equal(ctx.ctxChatUnchanged(chatRef, 'b'), false);
  const other = [...state.chat];
  state.chatId = null;
  state.chat = other;
  assert.equal(ctx.ctxChatUnchanged(chatRef, null), false);
  state.chat = chatRef;
  state.chatId = 'a';

  // 9. 长聊天摘要分批：4 万字符上限
  const heavy = Array.from({ length: 200 }, (_, i) => ({ index: i + 1, isUser: i % 2 === 1, text: '长'.repeat(1000) }));
  const batch = ctx.ctxBatchMessages(heavy);
  assert.ok(batch.length >= 4 && batch.length <= 45, '分批大小异常：' + batch.length);
  assert.equal(ctx.ctxBatchMessages(heavy.slice(0, 10)).length, 10);
  assert.equal(ctx.ctxBatchMessages([{ index: 1, text: 'x'.repeat(100000) }]).length, 1);

  console.log('✅ 上下文测试全部通过：估算 / 摘要提示词 / 压缩范围 / 预算 / 精确计数退化');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 上下文测试失败：', err);
  process.exit(1);
});





