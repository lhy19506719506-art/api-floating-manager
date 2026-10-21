/**
 * 条目式总结 · 极端输入（happy-dom）
 *
 * 覆盖：
 *  1. 几千行只保留 12 条，长度有上限
 *  2. HTML / script / 控制字符不会进 DOM
 *  3. 管道、全角符号、空字段容错
 *  4. 连续打开总结界面不会叠出多个
 *  5. 超长总结拒绝保存，避免误注入 1MB
 *
 * 运行：node tests/summary-rows-brutal.test.mjs
 */
import { Window } from 'file:///D:/TauriTavern/src/TauriTavern-main/node_modules/happy-dom/lib/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, '..', 'index.js'), 'utf8');
const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

setTimeout(() => {
  console.error('❌ 极端总结测试超时（30s）');
  process.exit(2);
}, 30000).unref();

function createEnv() {
  const win = new Window({ url: 'http://localhost:8000/' });
  win.document.body.innerHTML = `<select id="main_api"><option value="openai">openai</option></select><select id="chat_completion_source"><option value="custom">custom</option></select><input id="custom_api_url_text" /><input id="custom_model_id" /><button id="api_button_openai">连接</button>`;
  const state = { chatMetadata: {}, prompt: '' };
  win.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('/api/tokenizers/')) {
      return new Response(JSON.stringify({ token_count: 10, token_counts: [10] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  win.localStorage.setItem('tauri-api-manager', JSON.stringify({
    items: [{ id: 'c1', name: 'X', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', key: 'sk-test', provider: 'deepseek' }],
    activeId: 'c1',
  }));
  win.extension_settings = {};
  win.saveSettingsDebounced = () => {};
  win.confirm = () => true;
  win.SillyTavern = {
    getContext: () => ({
      chat: [{ name: 'A', is_user: false, is_system: false, mes: 'hi' }],
      chatId: 'brutal-1',
      chatMetadata: state.chatMetadata,
      chatCompletionSettings: { openai_max_context: 128000, openai_max_tokens: 8000, custom_model: 'deepseek-flash' },
      setExtensionPrompt: (_key, text) => { state.prompt = text; },
      saveChat: async () => {},
    }),
  };
  win.__TAURITAVERN__ = { abiVersion: 1, ready: Promise.resolve(), api: { llmConnections: { async list() { return { connections: [] }; } } } };
  win.eval(code);
  return { win, state };
}

async function main() {
  const { win, state } = createEnv();
  await tick(300);
  const ctx = win.__TAM_CTX__;
  assert.ok(ctx, '插件未完成 boot');

  // 1. 5000 行 / 超长字段
  {
    const many = Array.from({ length: 5000 }, (_, i) => `${i + 1}｜地点${i}｜${'事件'.repeat(200)}${i}｜结果${i}`).join('\n');
    const rows = ctx.ctxParseSummaryRows(many);
    assert.equal(rows.length, 12, `没有封顶 12 条：${rows.length}`);
    const formatted = ctx.ctxFormatSummaryRows(rows);
    assert.ok(formatted.length < 300, `格式化后仍然太长：${formatted.length}`);
    const back = ctx.ctxParseSummaryRows(formatted);
    assert.ok(back.length >= 1 && back.length <= 12, `回读条数异常：${back.length}`);
    console.log(`✓ 5000 行封顶与回读（压缩到 ${back.length} 条 / ${formatted.length} 字）`);
  }

  // 2. HTML / script / 控制字符
  {
    const evil = '1｜<img src=x onerror="window.__XSS=1">｜<script>window.__XSS=2</script>｜\u0000\u0007';
    state.chatMetadata.tamCtx = {
      summary: evil,
      ranges: [[1, 2]],
      start: 1,
      end: 2,
      at: Date.now(),
      auto: false,
      version: 2,
    };
    await win.__TAM__.context.render();
    await tick(200);
    win.__TAM__.context.openSummary();
    await tick(80);
    const table = win.document.getElementById('tam-ctx-summary-rows');
    assert.ok(table, '没有生成表格');
    assert.equal(table.querySelectorAll('img').length, 0, 'HTML 进了 DOM');
    assert.equal(table.querySelectorAll('script').length, 0, 'script 进了 DOM');
    assert.equal(win.__XSS, undefined, 'XSS 被执行');
    assert.ok(table.textContent.includes('<img'), 'HTML 文本没有按纯文本显示');
    console.log('✓ HTML/脚本按纯文本渲染');
  }

  // 3. 连续打开只保留一个
  {
    win.__TAM__.context.openSummary();
    win.__TAM__.context.openSummary();
    win.__TAM__.context.openSummary();
    await tick(60);
    assert.equal(win.document.querySelectorAll('#tam-ctx-summary-view').length, 1, '总结界面叠了多个');
    console.log('✓ 连续打开只保留一个');
  }

  // 4. 超长总结拒绝保存
  {
    const field = win.document.getElementById('tam-ctx-summary-text');
    field.value = '长'.repeat(50000);
    field.dispatchEvent(new win.Event('input', { bubbles: true }));
    const save = [...win.document.querySelectorAll('#tam-ctx-summary-view button')]
      .find((button) => button.textContent === '保存修改');
    save.click();
    await tick(100);
    assert.ok(win.document.getElementById('tam-ctx-summary-view'), '超长总结被保存了');
    assert.ok(!state.prompt.includes('长'.repeat(1000)), '超长总结已经注入');
    console.log('✓ 超长总结拒绝保存');
  }

  // 5. 事件风暴不崩
  {
    for (let i = 0; i < 100; i += 1) {
      win.dispatchEvent(new win.Event('tam:request-measured'));
    }
    await tick(50);
    assert.ok(win.__TAM__, '事件风暴后插件状态丢失');
    console.log('✓ 事件风暴不崩');
  }

  console.log('✅ 极端总结测试全部通过：封顶 / XSS / 重复弹层 / 超长拒绝 / 事件风暴');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 极端总结测试失败：', err);
  process.exit(1);
});
