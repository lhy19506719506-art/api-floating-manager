/**
 * 异常用户测试（happy-dom）
 *
 * 模拟真实用户的各种离谱操作：
 *  1. 楼层输入 0 到 999999（越界）
 *  2. 空输入直接点隐藏
 *  3. 只选首楼删除
 *  4. 连点两次「立即压缩」
 *  5. 聊天只有 1 条就压缩
 *  6. context 设置被写成字符串 / null
 *  7. 20 次并发渲染
 *  8. 消息里带 <img onerror>（XSS）
 *  9. 全部楼层隐藏后点「全部取消隐藏」
 *
 * 运行：node tests/context-abnormal.test.mjs
 */
import { Window } from 'file:///D:/TauriTavern/src/TauriTavern-main/node_modules/happy-dom/lib/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, '..', 'index.js'), 'utf8');

setTimeout(() => {
  console.error('❌ 异常用户测试超时（40s）');
  process.exit(2);
}, 40000).unref();

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function makeChat(count, extra = '') {
  const chat = [{ name: 'Fuka', is_user: false, is_system: false, mes: `开场白${extra}` }];
  for (let i = 1; i < count; i += 1) {
    chat.push({
      name: i % 2 ? 'User' : 'Fuka',
      is_user: i % 2 === 1,
      is_system: false,
      mes: i % 2 ? `用户第 ${i} 条` : `角色第 ${i} 条`,
    });
  }
  return chat;
}

function createEnv({ chat, context, fetchImpl } = {}) {
  const win = new Window({ url: 'http://localhost:8000/' });
  win.document.body.innerHTML = `
    <select id="main_api"><option value="openai">openai</option></select>
    <select id="chat_completion_source"><option value="custom">custom</option></select>
    <input id="custom_api_url_text" />
    <input id="custom_model_id" />
    <button id="api_button_openai">连接</button>
  `;
  const state = {
    chat: chat ?? makeChat(21),
    chatMetadata: {},
    calls: { hide: [], delete: [], compress: 0 },
  };
  win.fetch = fetchImpl ?? (async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('/api/tokenizers/openai/count?')) return jsonResponse({ token_count: state.chat.length * 40 });
    if (u.startsWith('/api/tokenizers/openai/count-batch?')) {
      const body = JSON.parse(init.body || '[]');
      return jsonResponse({ token_counts: body.map(() => 40) });
    }
    if (u === '/api/secrets/read') return jsonResponse({});
    if (u.includes('/chat/completions')) {
      state.calls.compress += 1;
      await tick(30);
      return jsonResponse({ choices: [{ message: { content: '前情提要：测试摘要' } }] });
    }
    return jsonResponse({}, 404);
  });
  win.localStorage.setItem('tauri-api-manager', JSON.stringify({
    context: context === undefined ? {} : context,
    items: [{ id: 'c1', name: 'X', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', provider: { chatCompletionSource: 'custom' } }],
    activeId: 'c1',
  }));
  win.extension_settings = {};
  win.saveSettingsDebounced = () => {};
  win.confirm = () => true;
  win.SillyTavern = {
    getContext: () => ({
      chat: state.chat,
      chatMetadata: state.chatMetadata,
      chatCompletionSettings: { openai_max_context: 128000, openai_max_tokens: 8000, custom_model: 'm' },
    }),
  };
  win.__TAURITAVERN__ = {
    abiVersion: 1,
    ready: Promise.resolve(),
    api: { llmConnections: { async list() { return { connections: [] }; } } },
  };
  win.eval(code);
  return { win, state };
}

const toastText = (win) => win.document.getElementById('tam-toast')?.textContent ?? '';

async function main() {
  const { win, state } = createEnv({});
  await tick(220);
  const ui = win.__TAM__?.ui;
  assert.ok(ui, '插件未完成 boot');
  ui.setOpen(true);
  ui.setTab('context');
  await tick(260);

  // 1. 越界楼层 0 → 999999 不应该展开成 100 万个选中
  win.document.getElementById('tam-ctx-from').value = '0';
  win.document.getElementById('tam-ctx-to').value = '999999';
  const rangeBtns = [...win.document.querySelectorAll('.tam-ctxrange button')];
  rangeBtns.find((b) => b.textContent === '隐藏')?.click();
  await tick(120);
  const selected = win.__TAM_CTX__.getSelected();
  assert.ok(selected.length <= state.chat.length, `越界选择未裁剪：${selected.length}`);
  assert.ok(state.chat.every((m) => m.is_system), '越界区间应裁剪成整段并全部隐藏');

  // 全部隐藏后先恢复，否则空态里没有输入框
  [...win.document.querySelectorAll('.tam-ctxactions button')]
    .find((b) => b.textContent === '全部取消隐藏')?.click();
  await tick(250);

  // 2. 空输入点隐藏：提示且不选中
  win.document.getElementById('tam-ctx-from').value = '';
  win.document.getElementById('tam-ctx-to').value = '';
  rangeBtns.find((b) => b.textContent === '取消隐藏')?.click();
  await tick(80);
  assert.ok(toastText(win).includes('请先填写'), `空输入提示缺失：${toastText(win)}`);

  // 3. 只选首楼删除：应提示且不删
  win.document.getElementById('tam-ctx-from').value = '0';
  win.document.getElementById('tam-ctx-to').value = '0';
  await tick(40);
  const before = state.chat.length;
  rangeBtns.find((b) => b.textContent === '删除')?.click();
  await tick(120);
  assert.equal(state.chat.length, before, '首楼被删除了');
  assert.ok(toastText(win).includes('首楼不能删除'), `首楼提示缺失：${toastText(win)}`);

  // 4. 连点两次压缩：不应抛错、不应产生未捕获异常
  win.document.getElementById('tam-ctx-from').value = '1';
  win.document.getElementById('tam-ctx-to').value = '4';
  await tick(40);
  const primary = win.document.querySelector('.tam-ctxactions .tam-primary');
  primary?.click();
  primary?.click();
  await tick(400);
  assert.ok(true, '连续压缩没有抛异常');

  // 5. 只有 1 条消息时压缩：提示而不是崩溃
  const solo = createEnv({ chat: [{ name: 'F', is_user: false, is_system: false, mes: '只有一条' }] });
  await tick(220);
  solo.win.__TAM__.ui.setTab('context');
  await tick(200);
  solo.win.document.querySelector('.tam-ctxactions .tam-primary')?.click();
  await tick(150);
  assert.ok(toastText(solo.win).includes('才能压缩'), `单条消息提示异常：${toastText(solo.win)}`);
  assert.equal(solo.state.chat.length, 1);

  // 6. context 设置是字符串 / null：不崩
  const weird = createEnv({ context: 'not-an-object' });
  await tick(220);
  weird.win.__TAM__.ui.setTab('context');
  await tick(200);
  assert.ok(weird.win.document.querySelector('.tam-ctxcard'), '异常设置下没有渲染出上下文卡片');

  // 7. 20 次并发渲染
  const render = weird.win.__TAM__.context.render;
  await Promise.all(Array.from({ length: 20 }, () => render()));
  assert.ok(weird.win.document.querySelector('.tam-ctxcard'), '并发渲染后卡片消失');

  // 8. XSS：消息里带 img onerror，不能被当成 HTML
  const xss = createEnv({ chat: makeChat(3, '<img src=x onerror="window.__pwned=1">') });
  await tick(220);
  xss.win.__TAM__.ui.setTab('context');
  await tick(200);
  assert.equal(xss.win.__pwned, undefined, '发生了 XSS');
  assert.equal(xss.win.document.querySelectorAll('#tam-root img').length, 0, '消息被当成 HTML 渲染');

  // 9. 全部隐藏后点全部取消隐藏
  const hidden = createEnv({ chat: makeChat(5) });
  await tick(220);
  hidden.win.__TAM__.ui.setTab('context');
  await tick(200);
  hidden.state.chat.forEach((m) => { m.is_system = true; });
  await hidden.win.__TAM__.context.render();
  const unhide = [...hidden.win.document.querySelectorAll('.tam-ctxactions button')]
    .find((b) => b.textContent === '全部取消隐藏');
  unhide?.click();
  await tick(160);
  assert.ok(toastText(hidden.win).length > 0, '全部取消隐藏没有反馈');

  // 10. 用户发一条 8 万字超长消息
  let captured = null;
  const longChat = [
    { name: 'F', is_user: false, is_system: false, mes: '开场' },
    { name: 'U', is_user: true, is_system: false, mes: '长'.repeat(80000) },
  ];
  for (let i = 0; i < 20; i += 1) {
    longChat.push({ name: i % 2 ? 'U' : 'F', is_user: i % 2 === 1, is_system: false, mes: `短消息${i}` });
  }
  const longEnv = createEnv({
    chat: longChat,
    fetchImpl: async (url, init = {}) => {
      const u = String(url);
      if (u.startsWith('/api/tokenizers/openai/count?')) return jsonResponse({ token_count: 120000 });
      if (u.startsWith('/api/tokenizers/openai/count-batch?')) {
        const body = JSON.parse(init.body || '[]');
        return jsonResponse({ token_counts: body.map((m) => Math.ceil(m.content.length / 1.5)) });
      }
      if (u.includes('/chat/completions')) {
        captured = JSON.parse(init.body || '{}');
        return jsonResponse({ choices: [{ message: { content: '摘要' } }] });
      }
      return jsonResponse({}, 404);
    },
  });
  await tick(240);
  longEnv.win.__TAM__.ui.setTab('context');
  await tick(300);
  const previews = [...longEnv.win.document.querySelectorAll('#tam-ctx-list .tam-ctxtext')].map((node) => node.textContent);
  assert.ok(previews.length > 0, '列表没有渲染');
  assert.ok(previews.every((text) => text.length <= 161), '存在未截断的行预览');

  await longEnv.win.__TAM__.context.compress({ auto: true });
  await tick(120);
  assert.ok(captured, '压缩请求没有发出');
  const sent = String(captured.messages?.[0]?.content ?? '');
  assert.ok(sent.length < 50000, `摘要请求过大：${sent.length}`);
  assert.ok(sent.includes('[本条已截断]'), '超长消息没有被截断标记');

  // 11. 重前缀：2 万起手 + 小预算，应提示前缀超预算
  const heavyEnv = createEnv({
    chat: [
      { name: 'C', is_user: false, is_system: false, mes: '开场' },
      { name: 'U', is_user: true, is_system: false, mes: '你好' },
    ],
    context: { budgetOverride: 10000, keepTurns: 6 },
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.startsWith('/api/tokenizers/openai/count?')) return jsonResponse({ token_count: 19500 });
      if (u.startsWith('/api/tokenizers/openai/count-batch?')) return jsonResponse({ token_counts: [9000, 9000] });
      return jsonResponse({}, 404);
    },
  });
  await tick(240);
  heavyEnv.win.__TAM__.ui.setTab('context');
  await tick(300);
  const warnings = [...heavyEnv.win.document.querySelectorAll('.tam-hint-warn')].map((node) => node.textContent).join('\n');
  assert.ok(warnings.includes('静态前缀'), `重前缀没有警告：${warnings}`);

  // 12. 压缩预览：先生成、可取消，不直接改聊天
  const previewEnv = createEnv({ chat: makeChat(21) });
  await tick(240);
  previewEnv.win.__TAM__.ui.setTab('context');
  await tick(300);
  previewEnv.win.document.querySelector('.tam-ctxactions .tam-primary')?.click();
  await tick(400);
  const modal = previewEnv.win.document.getElementById('tam-ctx-preview');
  assert.ok(modal, '压缩没有弹出预览');
  const field = previewEnv.win.document.getElementById('tam-ctx-preview-text');
  assert.equal(field.value, '前情提要：测试摘要', '预览没有填入摘要');
  const cancelBtn = [...modal.querySelectorAll('button')].find((b) => b.textContent === '取消');
  cancelBtn?.click();
  await tick(80);
  assert.equal(previewEnv.win.document.getElementById('tam-ctx-preview'), null, '取消后预览没有关闭');
  assert.ok(previewEnv.state.chat.every((m) => !m.is_system), '取消后不应隐藏任何消息');

  // 13. 动态预算推荐
  const rec = await previewEnv.win.__TAM_CTX__.ctxRecommendBudget(
    [
      { index: 1, isUser: false, text: '长'.repeat(2000) },
      { index: 2, isUser: true, text: '短' },
      { index: 3, isUser: false, text: '长'.repeat(2000) },
      { index: 4, isUser: true, text: '短' },
    ],
    26000,
  );
  assert.ok(rec && rec.pick >= 50000, `推荐档位异常：${JSON.stringify(rec)}`);

  // 14. 压缩设置展开后必须渲染控件
  const gear = previewEnv.win.document.querySelector('.tam-ctxsettings-toggle button');
  assert.ok(gear, '没有压缩设置按钮');
  gear.click();
  await tick(400);
  assert.ok(previewEnv.win.document.querySelector('.tam-ctxcontrols'), '展开后没有控件');
  assert.ok(previewEnv.win.document.querySelector('.tam-ctxactions'), '展开后按钮区丢失');

  console.log('✅ 异常用户测试通过：越界楼层 / 空输入 / 首楼保护 / 连点压缩 / 单条聊天 / 异常设置 / 并发渲染 / XSS / 全部取消隐藏');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 异常用户测试失败：', err);
  process.exit(1);
});




