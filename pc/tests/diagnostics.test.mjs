/**
 * 诊断 / 安全回归（happy-dom）
 *
 * 覆盖：
 *  1. collectProbe 的 URL 只保留 origin
 *  2. storeKeys 旧数据迁移：有宿主时默认关闭本地明文镜像
 *  3. 开发者模式二次确认 + 清理临时连接
 *  4. 最近错误队列出现在诊断页
 *
 * 运行：node tests/diagnostics.test.mjs
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
  console.error('❌ 诊断测试超时（30s）');
  process.exit(2);
}, 30000).unref();

function createEnv({ cleanupFails = false, host = true } = {}) {
  const win = new Window({ url: 'http://localhost:8000/' });
  win.document.body.innerHTML = `
    <select id="main_api"><option value="openai">openai</option></select>
    <select id="chat_completion_source"><option value="custom">custom</option></select>
    <input id="custom_api_url_text" />
    <input id="custom_model_id" />
    <button id="api_button_openai">连接</button>
  `;
  const deleted = [];
  win.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('/api/tokenizers/')) {
      return new Response(JSON.stringify({ token_count: 10, token_counts: [10] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  win.localStorage.setItem('tauri-api-manager', JSON.stringify({
    storeKeys: null,
    items: [{
      id: 'c1',
      name: 'X',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      key: 'sk-1234567890abcdef',
      provider: 'deepseek',
    }],
    activeId: 'c1',
  }));
  win.extension_settings = {};
  win.saveSettingsDebounced = () => {};
  win.confirm = () => true;
  win.SillyTavern = {
    getContext: () => ({
      chat: [{ name: 'A', is_user: false, is_system: false, mes: 'hi' }],
      chatId: 'chat-1',
      chatMetadata: {},
      chatCompletionSettings: {
        openai_max_context: 128000,
        openai_max_tokens: 8000,
        custom_model: 'deepseek-flash',
        custom_url: 'https://api.deepseek.com/v1/private/path?key=abc',
      },
      setExtensionPrompt: () => {},
      saveChat: async () => {},
    }),
  };
  win.__TAURITAVERN__ = host ? {
    abiVersion: 1,
    ready: Promise.resolve(),
    api: {
      llmConnections: {
        async list() {
          return { connections: [{ id: 'fmtprobe-openai', displayName: '__fmt_probe__' }] };
        },
        async delete(args) {
          deleted.push(args?.connectionId ?? args);
          if (cleanupFails) throw new Error('denied');
        },
      },
    },
  } : undefined;
  win.eval(code);
  return { win, deleted };
}

async function main() {
  // 1 + 2. 脱敏与 storeKeys 迁移
  {
    const { win } = createEnv();
    await tick(260);
    assert.ok(win.__TAM__, '插件未完成 boot');
    const probe = win.__TAM__.collectProbe();
    assert.equal(probe.st.currentSettings.custom_url, 'https://api.deepseek.com/****');
    assert.ok(!JSON.stringify(probe).includes('private/path'), '诊断里仍然泄露了 URL 路径');
    assert.ok(!JSON.stringify(probe).includes('sk-1234567890'), '诊断里仍然泄露了 Key');
    const settings = win.__TAM__.settings();
    assert.equal(settings.storeKeys, false, '有宿主时 storeKeys 没有迁移为 false');
    assert.equal(settings.storeKeysMigrated, true, '迁移标记没有写入');
    await tick(260);
    const mirror = JSON.parse(win.localStorage.getItem('tauri-api-manager'));
    assert.equal(mirror.items[0].key, '', 'localStorage 镜像里仍然保存明文 Key');
    console.log('✓ 诊断脱敏 + storeKeys 迁移');
  }

  // 3. 开发者模式 + 一键清理
  {
    const { win, deleted } = createEnv();
    await tick(260);
    win.__TAM__.ui.setTab('probe');
    await tick(120);
    const dev = [...win.document.querySelectorAll('#tam-probe button')]
      .find((button) => button.textContent === '开发者模式');
    assert.ok(dev, '没有开发者模式按钮');
    dev.click();
    await tick(60);
    assert.ok(!win.document.getElementById('tam-dev-box').classList.contains('tam-hidden'), '开发者模式没有展开');
    const cleanup = [...win.document.querySelectorAll('#tam-dev-box button')]
      .find((button) => button.textContent.includes('一键清理'));
    assert.ok(cleanup, '没有一键清理按钮');
    cleanup.click();
    await tick(120);
    assert.deepEqual(deleted, ['fmtprobe-openai'], `没有删除临时连接：${deleted}`);
    const toast = win.document.getElementById('tam-toast')?.textContent ?? '';
    assert.ok(toast.includes('已清理 1 条'), `清理提示不对：${toast}`);
    console.log('✓ 开发者模式与一键清理');
  }

  // 4. 最近错误区块
  {
    const { win } = createEnv();
    await tick(260);
    win.__TAM__.errors; // 导出存在
    // 直接制造一条错误，再渲染诊断页
    const ctx = win.__TAM_CTX__;
    assert.equal(typeof ctx.ctxTextHash('abc'), 'string');
    // 没有错误时显示“没有记录到错误”
    win.__TAM__.ui.setTab('probe');
    await tick(100);
    const text = win.document.getElementById('tam-probe')?.textContent ?? '';
    assert.ok(text.includes('最近错误'), '诊断页没有最近错误区块');
    assert.ok(text.includes('settings'), '迁移日志没有进入最近错误');
    assert.ok(text.includes('检测到旧版本地 Key'), '迁移日志内容不对');
    console.log('✓ 最近错误区块');
  }

  // 5. 纯网页版没有密钥库：旧版本地 Key 必须保留，不能升级后丢 Key
  {
    const { win } = createEnv({ host: false });
    await tick(700);
    assert.ok(win.__TAM__, '无宿主时插件未完成 boot');
    const settings = win.__TAM__.settings();
    assert.equal(settings.storeKeys, true, '无宿主时旧版 Key 没有保留');
    await tick(260);
    const mirror = JSON.parse(win.localStorage.getItem('tauri-api-manager'));
    assert.equal(mirror.items[0].key, 'sk-1234567890abcdef', '无宿主时本地 Key 被清掉了');
    console.log('✓ 纯网页版保留旧版本地 Key');
  }

  console.log('✅ 诊断/安全测试全部通过：URL 脱敏 / Key 迁移 / 开发者模式 / 临时连接清理');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 诊断测试失败：', err);
  process.exit(1);
});
