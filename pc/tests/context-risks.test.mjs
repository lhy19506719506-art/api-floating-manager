/**
 * 风险验证（happy-dom）
 *
 * 1. localStorage 是否明文保存 Key
 * 2. 摘要是否在用户确认预览之前就发给了 API
 * 3. 「建议档位」的前缀反推误差
 *
 * 运行：node tests/context-risks.test.mjs
 */
import { Window } from 'file:///D:/TauriTavern/src/TauriTavern-main/node_modules/happy-dom/lib/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, '..', 'index.js'), 'utf8');
setTimeout(() => { console.error('❌ 风险测试超时'); process.exit(2); }, 40000).unref();
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const jsonResponse = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });

function makeChat(n = 21) {
  const chat = [{ name: 'F', is_user: false, is_system: false, mes: '开场' }];
  for (let i = 1; i < n; i += 1) chat.push({ name: i % 2 ? 'U' : 'F', is_user: i % 2 === 1, is_system: false, mes: `消息${i}` });
  return chat;
}

function createEnv({ chat = makeChat(), fetchImpl, confirm = () => true, items } = {}) {
  const win = new Window({ url: 'http://localhost:8000/' });
  win.document.body.innerHTML = '<select id="main_api"></select><select id="chat_completion_source"></select><input id="custom_model_id" /><button id="api_button_openai"></button>';
  const state = { chat, metadata: {}, compressCalls: 0 };
  win.fetch = fetchImpl ?? (async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('/api/tokenizers/openai/count?')) return jsonResponse({ token_count: 1000 });
    if (u.startsWith('/api/tokenizers/openai/count-batch?')) {
      const body = JSON.parse(init.body || '[]');
      return jsonResponse({ token_counts: body.map((m) => Math.ceil(m.content.length / 1.55) + 4) });
    }
    if (u.includes('/chat/completions')) {
      state.compressCalls += 1;
      return jsonResponse({ choices: [{ message: { content: '摘要' } }] });
    }
    return jsonResponse({}, 404);
  });
  win.localStorage.setItem('tauri-api-manager', JSON.stringify({
    items: items ?? [{ id: 'c1', name: 'X', key: 'sk-test-123456', baseUrl: 'https://api.deepseek.com/v1', model: 'm', provider: { chatCompletionSource: 'custom' } }],
    activeId: 'c1',
  }));
  win.extension_settings = {};
  win.saveSettingsDebounced = () => {};
  win.confirm = confirm;
  win.SillyTavern = { getContext: () => ({ chat: state.chat, chatMetadata: state.metadata, chatCompletionSettings: { openai_max_context: 128000, openai_max_tokens: 8000, custom_model: 'm' } }) };
  win.__TAURITAVERN__ = { abiVersion: 1, ready: Promise.resolve(), api: { llmConnections: { async list() { return { connections: [] }; } } } };
  win.eval(code);
  return { win, state };
}

async function main() {
  // 1. localStorage 明文 Key：默认有宿主 secrets 时不写入
  const a = createEnv();
  await tick(240);
  a.win.__TAM__.ui.setAutoFailover(true); // 触发 saveSettings
  await tick(400);
  const raw = a.win.localStorage.getItem('tauri-api-manager') || '';
  assert.ok(!raw.includes('sk-test-123456'), '默认不应该把明文 Key 写进 localStorage');
  const host = a.win.extension_settings['tauri-api-manager'];
  assert.equal(host.items[0].key, '', '宿主设置里的 Key 应被脱敏');
  console.log('✓ 默认不写明文 Key（宿主副本同样脱敏）');

  // 显式打开后才写入
  const settings = a.win.__TAM__.settings();
  settings.storeKeys = true;
  a.win.__TAM__.ui.setAutoFailover(false);
  await tick(400);
  const raw2 = a.win.localStorage.getItem('tauri-api-manager') || '';
  assert.ok(raw2.includes('sk-test-123456'), '打开开关后应写入 Key');
  console.log('✓ 显式打开「本地镜像保存 Key」后才写入');


  // 2. 摘要先发送、后预览
  const b = createEnv();
  await tick(240);
  b.win.__TAM__.ui.setTab('context');
  await tick(300);
  b.win.document.querySelector('.tam-ctxactions .tam-primary')?.click();
  await tick(400);
  assert.ok(b.win.document.getElementById('tam-ctx-preview'), '没有弹出预览');
  assert.equal(b.state.compressCalls, 1, '预览前应该已经发送了摘要请求');
  const cancel = [...b.win.document.querySelectorAll('#tam-ctx-preview button')].find((x) => x.textContent === '取消');
  cancel?.click();
  await tick(80);
  assert.ok(b.state.chat.every((m) => !m.is_system), '取消后聊天被改动');
  console.log('✓ 摘要请求在点击「立即压缩」时已发出，取消只阻止隐藏，不撤回已发送的数据');

  // 3. 发送前确认 = 关闭时，取消确认不应发送
  const c = createEnv({ confirm: () => false });
  await tick(240);
  c.win.__TAM__.ui.setTab('context');
  await tick(300);
  c.win.document.querySelector('.tam-ctxactions .tam-primary')?.click();
  await tick(300);
  assert.equal(c.state.compressCalls, 0, '取消确认后仍然发送了摘要');
  assert.equal(c.win.document.getElementById('tam-ctx-preview'), null);
  console.log('✓ 取消「发送前确认」后不会发起摘要请求');


  // 5. P0-1：有 secretRef 时按 secretRef 取 Key，而不是队列里 active 的那条
  let authHeader = '';
  let usageBefore = 0;
  let usageAfter = 0;
  const keyEnv = createEnv({
    items: [{ id: 'c1', name: 'X', key: '', secretRef: { key: 'api_key_custom', id: 'sec-2' }, baseUrl: 'https://api.deepseek.com/v1', model: 'm', provider: { chatCompletionSource: 'custom' } }],
    fetchImpl: async (url, init = {}) => {
      const u = String(url);
      if (u === '/api/secrets/read') {
        return jsonResponse({ api_key_custom: [
          { id: 'sec-1', value: 'AAA', active: true },
          { id: 'sec-2', value: 'BBB', active: false },
        ] });
      }
      if (u.startsWith('/api/tokenizers/openai/count?')) return jsonResponse({ token_count: 1000 });
      if (u.startsWith('/api/tokenizers/openai/count-batch?')) {
        const body = JSON.parse(init.body || '[]');
        return jsonResponse({ token_counts: body.map(() => 40) });
      }
      if (u.includes('/chat/completions')) {
        authHeader = init.headers?.Authorization ?? '';
        return jsonResponse({ choices: [{ message: { content: '摘要' } }] });
      }
      return jsonResponse({}, 404);
    },
  });
  await tick(240);
  keyEnv.win.__TAM__.ui.setTab('context');
  await tick(300);
  usageBefore = keyEnv.win.__TAM__.usage.today().requests;
  keyEnv.win.document.querySelector('.tam-ctxactions .tam-primary')?.click();
  await tick(500);
  usageAfter = keyEnv.win.__TAM__.usage.today().requests;
  assert.equal(authHeader, 'Bearer BBB', `secretRef 没有生效：${authHeader}`);
  console.log('✓ secretRef 取 Key 正确（Bearer BBB，不是 active 的 AAA）');
  assert.equal(usageAfter, usageBefore, '摘要请求被计入了用量');
  console.log('✓ 摘要请求不再被自己的 fetch hook 计入用量');

  // 6. New-2：重新生成第一次点击就应生效
  const regenEnv = createEnv();
  await tick(240);
  regenEnv.win.__TAM__.ui.setTab('context');
  await tick(300);
  regenEnv.win.document.querySelector('.tam-ctxactions .tam-primary')?.click();
  await tick(400);
  const regen = [...regenEnv.win.document.querySelectorAll('#tam-ctx-preview button')].find((b) => b.textContent === '重新生成');
  assert.ok(regen, '没有重新生成按钮');
  regen.click();
  await tick(500);
  assert.ok(regenEnv.state.compressCalls >= 2, `重新生成没有发第二次请求：${regenEnv.state.compressCalls}`);
  assert.ok(regenEnv.win.document.getElementById('tam-ctx-preview'), '重新生成后预览消失了');
  console.log('✓ 重新生成第一次点击就发起了新请求');

  // 4. 建议档位：前缀反推误差（精确批量计数）
  const d = createEnv();
  await tick(240);
  const visible = Array.from({ length: 100 }, (_, i) => ({ index: i + 1, isUser: i % 2 === 0, text: '长'.repeat(1000) }));
  const exactEach = Math.ceil(1000 / 1.55) + 4;
  const total = 19445 + exactEach * 100 + 3;
  const rec = await d.win.__TAM_CTX__.ctxRecommendBudget(visible, total);
  const err = Math.abs(rec.prefix - 19445);
  assert.ok(err < 10, `前缀反推误差过大：${rec.prefix} vs 19445`);
  const oldEstimate = visible.reduce((sum, m) => sum + d.win.__TAM_CTX__.ctxEstimate(m.text) + 4, 0);
  const oldPrefix = total - oldEstimate;
  console.log(`✓ 精确批量计数后前缀误差 ${err} tokens；旧估算误差 ${Math.abs(oldPrefix - 19445)} tokens (${(Math.abs(oldPrefix - 19445) / 19445 * 100).toFixed(1)}%)`);

  console.log('✅ 风险验证完成');
  process.exit(0);
}

main().catch((e) => { console.error('❌ 风险测试失败：', e); process.exit(1); });
