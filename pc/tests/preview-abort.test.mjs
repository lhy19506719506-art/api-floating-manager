/**
 * 预览取消 / 中止请求（happy-dom）
 *
 * 运行：node tests/preview-abort.test.mjs
 */
import { Window } from 'file:///D:/TauriTavern/src/TauriTavern-main/node_modules/happy-dom/lib/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, '..', 'index.js'), 'utf8');
const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
setTimeout(() => { console.error('❌ 取消测试超时'); process.exit(2); }, 20000).unref();

const win = new Window({ url: 'http://localhost:8000/' });
win.document.body.innerHTML = `<select id="main_api"><option value="openai">openai</option></select><select id="chat_completion_source"><option value="custom">custom</option></select><input id="custom_api_url_text" /><input id="custom_model_id" /><button id="api_button_openai">连接</button>`;
const chat = [{ name: 'Fuka', is_user: false, is_system: false, mes: '开场白' }];
for (let i = 0; i < 20; i += 1) chat.push({ name: i % 2 ? 'User' : 'Fuka', is_user: i % 2 === 1, is_system: false, mes: `第 ${i} 条普通消息` });
const state = { chatMetadata: {} };
let aborted = false;
win.fetch = async (url, init = {}) => {
  const value = String(url);
  if (value.startsWith('/api/tokenizers/')) {
    return new Response(JSON.stringify({ token_count: 100, token_counts: [10] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (value.includes('/chat/completions')) {
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
win.localStorage.setItem('tauri-api-manager', JSON.stringify({
  storeKeys: true,
  items: [{ id: 'c1', name: 'X', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: 'sk-test', provider: 'deepseek' }],
  activeId: 'c1',
  context: { auto: false, keepTurns: 4, summaryChars: 240, summaryStyle: 'rows', confirmSend: false },
}));
win.extension_settings = {}; win.saveSettingsDebounced = () => {}; win.confirm = () => true;
win.SillyTavern = {
  getContext: () => ({
    chat,
    chatId: 'abort-1',
    chatMetadata: state.chatMetadata,
    chatCompletionSettings: { openai_max_context: 128000, openai_max_tokens: 8000, custom_model: 'deepseek-chat' },
    setExtensionPrompt: () => {},
    saveChat: async () => {},
  }),
};
win.__TAURITAVERN__ = { abiVersion: 1, ready: Promise.resolve(), api: { llmConnections: { async list() { return { connections: [] }; } } } };
win.eval(code);
await tick(280);
win.__TAM__.ui.setOpen(true);
win.__TAM__.ui.setTab('context');
await tick(200);

const pending = win.__TAM__.context.compress({ preview: true, auto: false });
await tick(150);
assert.ok(win.document.getElementById('tam-ctx-preview'), '没有打开预览');
const cancel = [...win.document.querySelectorAll('#tam-ctx-preview button')]
  .find((button) => button.textContent === '取消');
assert.ok(cancel, '没有取消按钮');
cancel.click();
const result = await pending;
assert.equal(result, null);
assert.equal(aborted, true, '取消后没有中止请求');
assert.equal(win.document.getElementById('tam-ctx-preview'), null, '取消后预览没有关闭');
console.log('✅ 预览取消测试通过：中止请求 / 关闭界面');

// 旧版本/损坏的 meta 不能把 undefined 传给 hideChatMessageRange
state.chatMetadata.tamCtx = { summary: '旧总结', start: undefined, end: undefined, at: Date.now(), version: 2 };
await win.__TAM__.context.undo();
const toast = win.document.getElementById('tam-toast')?.textContent ?? '';
assert.ok(toast.includes('缺少有效楼层'), `损坏 meta 没有给出提示：${toast}`);
console.log('✅ 损坏 meta 撤销测试通过');
process.exit(0);
