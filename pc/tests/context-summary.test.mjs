/**
 * 压缩总结健壮性测试（happy-dom）
 *
 * 覆盖：
 *  1. DeepSeek 思考模型自动带 thinking.disabled
 *  2. 空正文 + reasoning_content 时自动加大预算重试
 *  3. Anthropic / 网关的 content 数组
 *  4. 代理不认 thinking 字段（400）时自动退回
 *  5. 全部为空时生成本地摘要，不再“压缩失败：摘要为空”
 *  6. 「查看 / 编辑总结」界面：保存后写回 chatMetadata 并重新注入
 *  7. 真实请求大小采集：反推静态前缀，卡片显示「上次请求」
 *
 * 运行：node tests/context-summary.test.mjs
 */
import { Window } from 'file:///D:/TauriTavern/src/TauriTavern-main/node_modules/happy-dom/lib/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, '..', 'index.js'), 'utf8');

setTimeout(() => {
  console.error('❌ 总结测试超时（40s）');
  process.exit(2);
}, 40000).unref();

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function makeChat(count) {
  const chat = [{ name: 'Fuka', is_user: false, is_system: false, mes: '开场白' }];
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

function createEnv({ chat = makeChat(21), context = {}, responses = [] } = {}) {
  const win = new Window({ url: 'http://localhost:8000/' });
  win.document.body.innerHTML = `
    <select id="main_api"><option value="openai">openai</option></select>
    <select id="chat_completion_source"><option value="custom">custom</option></select>
    <input id="custom_api_url_text" />
    <input id="custom_model_id" />
    <button id="api_button_openai">连接</button>
  `;
  const state = {
    chat,
    chatId: 'chat-1',
    chatMetadata: {},
    context,
    calls: [],
    prompt: '',
  };
  const queue = [...responses];
  win.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('/api/tokenizers/openai/count?')) {
      const payload = JSON.parse(init.body || '[]');
      return jsonResponse({ token_count: payload.length * 900 });
    }
    if (u.startsWith('/api/tokenizers/openai/count-batch?')) {
      const payload = JSON.parse(init.body || '[]');
      return jsonResponse({ token_counts: payload.map(() => 10) });
    }
    if (u === '/api/secrets/read') {
      return jsonResponse({ api_key_custom: [{ id: 's1', value: 'sk-ab****yz', active: true }] });
    }
    if (u === '/api/secrets/find') {
      return jsonResponse({ value: 'sk-real' });
    }
    if (u.includes('/chat/completions')) {
      const body = JSON.parse(init.body || '{}');
      state.calls.push(body);
      const next = queue.shift();
      if (typeof next === 'function') return next(body, init);
      return next ?? jsonResponse({ choices: [{ message: { content: '前情提要：测试总结' }, finish_reason: 'stop' }] });
    }
    return jsonResponse({}, 404);
  };
  win.localStorage.setItem('tauri-api-manager', JSON.stringify({
    context,
    items: [{
      id: 'c1',
      name: 'X',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      key: 'sk-test',
      provider: 'deepseek',
    }],
    activeId: 'c1',
  }));
  win.extension_settings = {};
  win.saveSettingsDebounced = () => {};
  win.confirm = () => true;
  win.SillyTavern = {
    getContext: () => ({
      chat: state.chat,
      chatId: state.chatId,
      chatCompletionSettings: { openai_max_context: 128000, openai_max_tokens: 8000, custom_model: 'deepseek-flash' },
      chatMetadata: state.chatMetadata,
      setExtensionPrompt: (_key, text) => { state.prompt = text; },
      saveChat: async () => {},
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

async function openContext(env) {
  await tick(240);
  const ui = env.win.__TAM__?.ui;
  assert.ok(ui, '插件未完成 boot');
  ui.setOpen(true);
  ui.setTab('context');
  await tick(280);
}

async function compress(env) {
  await env.win.__TAM__.context.compress({ preview: true, auto: false });
  await tick(120);
}

async function main() {
  // 1. 思考模型：默认关闭思考，max_tokens 不需要靠猜
  {
    const env = createEnv();
    await openContext(env);
    await compress(env);
    assert.equal(env.state.calls.length, 1, '应该只发一次总结请求');
    assert.equal(env.state.calls[0].thinking?.type, 'disabled', '没有关闭思考');
    assert.equal(env.state.calls[0].max_tokens, 1200);
    const text = env.win.document.getElementById('tam-ctx-preview-text')?.value;
    assert.equal(text, '前情提要：测试总结');
    console.log('✓ 思考模型自动 thinking.disabled');
  }

  // 2. 空正文 + reasoning：自动加大预算重试，第二次拿到正文
  {
    const env = createEnv({
      responses: [
        jsonResponse({ choices: [{ message: { content: '', reasoning_content: '我想了很久'.repeat(200) }, finish_reason: 'length' }] }),
        jsonResponse({ choices: [{ message: { content: '第二次的总结正文' }, finish_reason: 'stop' }] }),
      ],
    });
    await openContext(env);
    await compress(env);
    assert.equal(env.state.calls.length, 2, `应重试一次，实际 ${env.state.calls.length}`);
    assert.equal(env.state.calls[1].max_tokens, 1600);
    assert.ok(String(env.state.calls[1].messages[0].content).includes('直接输出前情提要正文'));
    assert.equal(env.win.document.getElementById('tam-ctx-preview-text')?.value, '第二次的总结正文');
    console.log('✓ 空正文被思考挤爆时自动重试');
  }

  // 3. Anthropic 风格 content 数组
  {
    const env = createEnv({
      responses: [jsonResponse({
        choices: [{ message: { content: [{ type: 'text', text: '前情：' }, { type: 'text', text: '铜钥匙在口袋里' }] }, finish_reason: 'stop' }],
      })],
    });
    await openContext(env);
    await compress(env);
    assert.equal(env.win.document.getElementById('tam-ctx-preview-text')?.value, '前情：铜钥匙在口袋里');
    console.log('✓ content 数组解析');
  }

  // 4. 代理不认 thinking 字段：400 后退回普通请求
  {
    const env = createEnv({
      responses: [
        jsonResponse({ error: 'unknown field thinking' }, 400),
        jsonResponse({ choices: [{ message: { content: '退回后的总结' }, finish_reason: 'stop' }] }),
      ],
    });
    await openContext(env);
    await compress(env);
    assert.equal(env.state.calls.length, 2);
    assert.equal(env.state.calls[1].thinking, undefined, '退回请求不应再带 thinking');
    assert.equal(env.win.document.getElementById('tam-ctx-preview-text')?.value, '退回后的总结');
    console.log('✓ thinking 字段被 400 时自动退回');
  }

  // 5. 全部空：生成本地摘要，不再直接失败
  {
    const empty = () => jsonResponse({ choices: [{ message: { content: '', reasoning_content: '思考'.repeat(100) }, finish_reason: 'length' }] });
    const env = createEnv({ responses: [empty, empty, empty()] });
    await openContext(env);
    await compress(env);
    const text = env.win.document.getElementById('tam-ctx-preview-text')?.value ?? '';
    assert.ok(text.includes('本地摘要'), `没有本地摘要兜底：${text}`);
    const note = env.win.document.getElementById('tam-ctx-preview-est')?.textContent ?? '';
    assert.ok(note.includes('本地摘要'), `预览没有提示是本地摘要：${note}`);
    assert.ok(!env.win.document.getElementById('tam-ctx-preview-text').disabled, '本地摘要应可编辑');
    console.log('✓ 全部为空时本地摘要兜底');
  }

  // 6. 查看 / 编辑总结
  {
    const env = createEnv();
    await openContext(env);
    const ranges = [[1, 12]];
    env.state.chatMetadata.tamCtx = {
      summary: '旧总结：铜钥匙在口袋里。',
      ranges,
      start: 1,
      end: 12,
      at: Date.now(),
      auto: false,
      version: 2,
    };
    await env.win.__TAM__.context.render();
    await tick(300);
    const link = [...env.win.document.querySelectorAll('.tam-ctxsummary-actions button')]
      .find((button) => button.textContent.includes('查看'));
    assert.ok(link, '没有查看总结按钮');
    link.click();
    await tick(60);
    const field = env.win.document.getElementById('tam-ctx-summary-text');
    assert.ok(field, '没有打开总结界面');
    assert.equal(field.value, '旧总结：铜钥匙在口袋里。');
    field.value = '新总结：铜钥匙已经交给守卫。';
    const save = [...env.win.document.querySelectorAll('#tam-ctx-summary-view button')]
      .find((button) => button.textContent === '保存修改');
    assert.ok(save, '没有保存按钮');
    save.click();
    await tick(120);
    assert.equal(env.state.chatMetadata.tamCtx.summary, '新总结：铜钥匙已经交给守卫。');
    assert.ok(env.state.prompt.includes('新总结'), '保存后没有重新注入');
    assert.equal(env.win.document.getElementById('tam-ctx-summary-view'), null, '保存后没有关闭界面');
    console.log('✓ 查看 / 编辑总结并重新注入');
  }

  // 7. 真实请求大小 → 静态前缀（走 fetch hook）
  {
    const env = createEnv({
      responses: [jsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 5000, completion_tokens: 20 },
      })],
    });
    await openContext(env);
    let measuredEvents = 0;
    env.win.addEventListener('tam:request-measured', () => { measuredEvents += 1; });
    await env.win.fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        max_tokens: 4096,
        messages: [
          { role: 'system', content: '预设与角色卡'.repeat(100) },
          { role: 'user', content: env.state.chat[env.state.chat.length - 1].mes },
        ],
      }),
    });
    await tick(400);
    const ctx = env.win.__TAM_CTX__;
    const last = ctx.ctxMeasuredRequest();
    assert.ok(last, 'fetch hook 没有记录 lastRequest');
    assert.equal(last.prompt, 5000);
    assert.ok(last.prefix > 4000, `前缀反推异常：${last.prefix}`);
    assert.equal(measuredEvents, 1, '真实请求写入后没有触发 tam:request-measured');
    await env.win.__TAM__.context.render();
    await tick(320);
    const label = env.win.document.querySelector('.tam-ctxlabel')?.textContent;
    assert.equal(label, '上次请求');
    const meta = [...env.win.document.querySelectorAll('.tam-ctxmeta')].map((node) => node.textContent).join('\n');
    assert.ok(meta.includes('静态前缀'), `没有显示静态前缀：${meta}`);
    // 改动锚点消息后缓存必须作废
    env.state.chat[env.state.chat.length - 1].mes += '（被编辑）';
    assert.equal(ctx.ctxMeasuredRequest(), null, '消息被编辑后 lastRequest 仍被复用');
    console.log(`✓ 真实请求采集：prompt 5000，静态前缀 ${last.prefix}`);
  }

  // 12. 失败会进最近错误队列，诊断页能直接看到
  {
    const env = createEnv({ responses: [jsonResponse({ error: 'boom' }, 500), jsonResponse({ error: 'boom' }, 500), jsonResponse({ error: 'boom' }, 500)] });
    await openContext(env);
    await compress(env);
    const errors = env.win.__TAM__.errors();
    assert.ok(errors.some((item) => item.module === 'ctx.compress'), `没有记录压缩错误：${JSON.stringify(errors)}`);
    env.win.__TAM__.ui.setTab('probe');
    await tick(80);
    const text = env.win.document.getElementById('tam-probe')?.textContent ?? '';
    assert.ok(text.includes('最近错误'), '诊断页没有最近错误区块');
    assert.ok(text.includes('ctx.compress'), '诊断页没有显示错误模块');
    console.log('✓ 错误队列与诊断页');
  }

  // 8. 条目式：Markdown 表格也会被压成管道条目，并写进请求提示词
  {
    const table = [
      '| 序号 | 地点 | 事件 | 结果 |',
      '|---|---|---|---|',
      '| 1 | 图书馆 | 初次交谈 | 她未解释绷带 |',
      '| 2 | 旧书店 | 带来旧书 | 书里夹着地址 |',
    ].join('\n');
    const env = createEnv({
      responses: [jsonResponse({ choices: [{ message: { content: table }, finish_reason: 'stop' }] })],
    });
    await openContext(env);
    await compress(env);
    const text = env.win.document.getElementById('tam-ctx-preview-text')?.value;
    assert.equal(text, '1｜图书馆｜初次交谈｜她未解释绷带\n2｜旧书店｜带来旧书｜书里夹着地址');
    const prompt = String(env.state.calls[0].messages[0].content);
    assert.ok(prompt.includes('序号｜地点｜事件｜结果'), '提示词没有要求条目格式');
    assert.ok(prompt.includes('不要用 Markdown 表格'), '提示词没有禁止表格');
    console.log('✓ 条目式总结：表格压成管道条目');
  }

  // 9. 查看界面：表格 + 原文编辑同步
  {
    const env = createEnv();
    await openContext(env);
    env.state.chatMetadata.tamCtx = {
      summary: '1｜图书馆｜初谈｜未解释绷带\n2｜旧书店｜旧书｜夹着地址',
      ranges: [[1, 12]],
      start: 1,
      end: 12,
      at: Date.now(),
      auto: false,
      version: 2,
    };
    await env.win.__TAM__.context.render();
    await tick(300);
    [...env.win.document.querySelectorAll('.tam-ctxsummary-actions button')]
      .find((button) => button.textContent.includes('查看')).click();
    await tick(80);
    const table = env.win.document.getElementById('tam-ctx-summary-rows');
    assert.ok(table, '没有总结表格');
    const rows = table.querySelectorAll('.tam-summary-row');
    assert.equal(rows.length, 3, `表格应有表头 + 2 行，实际 ${rows.length}`);
    assert.ok(rows[0].textContent.includes('地点') && rows[0].textContent.includes('结果'), '表头不对');
    assert.ok(rows[1].textContent.includes('图书馆'), '第一行内容不对');
    const field = env.win.document.getElementById('tam-ctx-summary-text');
    field.value += '\n3｜约定｜明天还伞｜未兑现';
    field.dispatchEvent(new env.win.Event('input', { bubbles: true }));
    await tick(40);
    assert.equal(table.querySelectorAll('.tam-summary-row').length, 4, '编辑原文后表格没有同步');
    const est = env.win.document.getElementById('tam-ctx-summary-est').textContent;
    assert.ok(est.includes('3 条'), `条目计数不对：${est}`);
    const save = [...env.win.document.querySelectorAll('#tam-ctx-summary-view button')]
      .find((button) => button.textContent === '保存修改');
    save.click();
    await tick(120);
    assert.ok(env.state.prompt.includes('3｜约定｜明天还伞｜未兑现'), `保存后没有写入条目：${env.state.prompt}`);
    console.log('✓ 总结表格与原文同步');
  }

  // 10. 旧段落可以一键整理成条目
  {
    const env = createEnv();
    await openContext(env);
    env.state.chatMetadata.tamCtx = {
      summary: '旧总结：铜钥匙在口袋里。她答应明天归还。',
      ranges: [[1, 4]],
      start: 1,
      end: 4,
      at: Date.now(),
      auto: false,
      version: 2,
    };
    await env.win.__TAM__.context.render();
    await tick(300);
    [...env.win.document.querySelectorAll('.tam-ctxsummary-actions button')]
      .find((button) => button.textContent.includes('查看')).click();
    await tick(80);
    env.win.document.getElementById('tam-ctx-summary-tidy').click();
    await tick(60);
    const text = env.win.document.getElementById('tam-ctx-summary-text').value;
    assert.ok(text.startsWith('1｜旧总结｜铜钥匙在口袋里｜—'), `整理结果不对：${text}`);
    assert.ok(text.includes('\n2｜—｜她答应明天归还｜—'), `第二句没有整理：${text}`);
    console.log('✓ 旧段落整理成条目');
  }

  // 11. 纯函数：三种分隔/缺列都能解析，且最多 12 条
  {
    const env = createEnv();
    await tick(240);
    const ctx = env.win.__TAM_CTX__;
    const rows = ctx.ctxParseSummaryRows('1|甲|乙|事件一|结果一\n2、丙|事件二|结果二\n- 丁：事件三；结果三');
    assert.equal(rows.length, 2, `应解析出 2 条，实际 ${rows.length}`);
    assert.equal(rows[0].place, '甲');
    assert.ok(rows[0].event.includes('事件一'), `旧四列兼容失败：${rows[0].event}`);
    assert.equal(rows[1].place, '丙');
    const long = Array.from({ length: 20 }, (_, i) => `${i + 1}｜地点${i}｜事件${i}｜结果`).join('\n');
    assert.equal(ctx.ctxParseSummaryRows(long).length, 12, '条目没有封顶 12 条');
    console.log('✓ 条目解析容错与封顶');
  }

  // 13. read 返回掩码时必须走 find 取明文
  {
    const env = createEnv();
    await tick(260);
    const key = await env.win.__TAM_CTX__.ctxConnectionKey({
      baseUrl: 'https://api.deepseek.com/v1',
      provider: 'deepseek',
      secretRef: { key: 'api_key_custom', id: 's1' },
    });
    assert.equal(key, 'sk-real', `没有从 /api/secrets/find 取明文：${key}`);
    console.log('✓ secrets/read 掩码时走 secrets/find');
  }

  // 14. 完整 endpoint 也要能正确探测，不会对 /chat/completions 发 GET
  {
    const env = createEnv();
    await tick(240);
    const candidates = env.win.__TAM_CTX__.connCandidates('https://api.deepseek.com/v1/chat/completions');
    assert.equal(Array.from(candidates).join(','), 'https://api.deepseek.com/v1/models');
    const noV1 = env.win.__TAM_CTX__.connCandidates('https://api.deepseek.com/chat/completions');
    assert.equal(Array.from(noV1).join(','), 'https://api.deepseek.com/v1/models,https://api.deepseek.com/models');
    console.log('✓ 完整 endpoint 的候选 URL');
  }

  // 15. 完整 endpoint 传入总结请求时不能拼出双 /chat/completions
  {
    const env = createEnv();
    await tick(240);
    const urls = [];
    const fakeFetch = async (url, init) => {
      urls.push(String(url));
      return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    };
    const result = await env.win.__TAM_CTX__.ctxRequestSummary({
      connection: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1/chat/completions', provider: 'custom' },
      base: 'https://api.deepseek.com/v1/chat/completions',
      key: 'sk-test',
      prompt: 'test',
      rawFetch: fakeFetch,
    });
    assert.equal(result.text, 'ok');
    assert.equal(urls[0], 'https://api.deepseek.com/v1/chat/completions');
    console.log('✓ 完整 endpoint 不会拼成双 /chat/completions');
  }

  // 16. autoEvery=2 真的会触发自动压缩（不是只改 UI 选项）
  {
    const env = createEnv({
      context: { auto: true, autoEvery: 2, keepTurns: 2, summaryChars: 240, summaryStyle: 'rows', confirmSend: false },
    });
    await openContext(env);
    await env.win.__TAM__.context.autoMaybe();
    await tick(500);
    const meta = env.state.chatMetadata.tamCtx;
    assert.ok(meta?.summary, 'autoEvery=2 没有触发自动压缩');
    assert.ok(env.state.chat.some((message) => message.is_system), '自动压缩没有隐藏旧楼层');
    console.log('✓ autoEvery=2 自动触发');
  }

  console.log('✅ 压缩总结测试全部通过：思考关闭 / 空正文重试 / 数组解析 / 400 退回 / 本地兜底 / 查看编辑 / 实测前缀 / 条目式表格');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 压缩总结测试失败：', err);
  process.exit(1);
});
