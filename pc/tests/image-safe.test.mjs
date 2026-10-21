/**
 * 图片消息保护（happy-dom）
 *
 * 生图扩展依赖正文里的 <local_img>…</local_img>；酒馆隐藏整楼后图片会消失。
 * 这里验证：含图片/图片 Markdown 的楼层永远不进入压缩目标，也不进入总结请求。
 *
 * 运行：node tests/image-safe.test.mjs
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
  console.error('❌ 图片保护测试超时（30s）');
  process.exit(2);
}, 30000).unref();

function createEnv() {
  const win = new Window({ url: 'http://localhost:8000/' });
  win.document.body.innerHTML = `<select id="main_api"><option value="openai">openai</option></select><select id="chat_completion_source"><option value="custom">custom</option></select><input id="custom_api_url_text" /><input id="custom_model_id" /><button id="api_button_openai">连接</button>`;
  const chat = [{ name: 'Fuka', is_user: false, is_system: false, mes: '开场白' }];
  const texts = [
    '第一段普通剧情，用户走进图书馆。',
    '第二段普通剧情，她抬头看了一眼。',
    '第三段普通剧情，用户问起绷带。',
  ];
  chat.push({ name: 'User', is_user: true, is_system: false, mes: '普通对话一' });
  chat.push({ name: 'Fuka', is_user: false, is_system: false, mes: '<local_img>masterpiece, 1girl, library, soft light</local_img>普通回复里带生图标签' });
  chat.push({ name: 'User', is_user: true, is_system: false, mes: '普通对话二' });
  chat.push({ name: 'Fuka', is_user: false, is_system: false, mes: '<loacl_img>typo tag image</local_img>拼写错误的标签也要保护' });
  chat.push({ name: 'User', is_user: true, is_system: false, mes: '普通对话三' });
  chat.push({ name: 'Fuka', is_user: false, is_system: false, mes: '看图：![scene](https://example.com/a.png) 这是 Markdown 图片' });
  for (const text of texts) chat.push({ name: 'Fuka', is_user: false, is_system: false, mes: text });
  for (let i = 0; i < 6; i++) chat.push({ name: 'User', is_user: true, is_system: false, mes: `补充对话 ${i}` });
  const state = { chat, chatId: 'img-1', chatMetadata: {}, calls: [] };
  win.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.startsWith('/api/tokenizers/openai/count-batch')) {
      const body = JSON.parse(init.body || '[]');
      return new Response(JSON.stringify({ token_counts: body.map(() => 10) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (value.startsWith('/api/tokenizers/openai/count')) {
      return new Response(JSON.stringify({ token_count: 100 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (value.includes('/chat/completions')) {
      state.calls.push(JSON.parse(init.body || '{}'));
      return new Response(JSON.stringify({ choices: [{ message: { content: '1｜图书馆｜用户与角色交谈｜绷带未解释' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  win.localStorage.setItem('tauri-api-manager', JSON.stringify({
    storeKeys: true,
    items: [{ id: 'c1', name: 'X', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', key: 'sk-test', provider: 'deepseek' }],
    activeId: 'c1',
    context: { auto: false, keepTurns: 2, summaryChars: 240, summaryStyle: 'rows', confirmSend: false },
  }));
  win.extension_settings = {}; win.saveSettingsDebounced = () => {}; win.confirm = () => true;
  win.SillyTavern = {
    getContext: () => ({
      chat,
      chatId: state.chatId,
      chatMetadata: state.chatMetadata,
      chatCompletionSettings: { openai_max_context: 128000, openai_max_tokens: 8000, custom_model: 'deepseek-flash' },
      setExtensionPrompt: () => {},
      saveChat: async () => {},
    }),
  };
  win.__TAURITAVERN__ = { abiVersion: 1, ready: Promise.resolve(), api: { llmConnections: { async list() { return { connections: [] }; } } } };
  win.eval(code);
  return { win, state };
}

async function main() {
  const { win, state } = createEnv();
  await tick(260);
  const ctx = win.__TAM_CTX__;
  assert.ok(ctx, '插件未完成 boot');

  // 1. 三种图片写法都能识别
  assert.equal(ctx.ctxHasImageContent('<local_img>a</local_img>'), true);
  assert.equal(ctx.ctxHasImageContent('<loacl_img>a</local_img>'), true);
  assert.equal(ctx.ctxHasImageContent('<LOCAL_IMG>a</LOCAL_IMG>'), true);
  assert.equal(ctx.ctxHasImageContent('<local_img>\n英文提示词\n</local_img>'), true);
  assert.equal(ctx.ctxHasImageContent('![x](https://a/b.png)'), true);
  assert.equal(ctx.ctxHasImageContent('![x](https://a/b.png "title")'), true);
  assert.equal(ctx.ctxHasImageContent('<img src="data:image/png;base64,AAAA">'), true);
  assert.equal(ctx.ctxHasImageContent('普通文字'), false);

  // 2. 压缩目标排除图片楼层
  const plan = ctx.ctxPlan(2, state.chat);
  assert.ok(plan.imageSkipped.length >= 3, `没有识别出图片楼层：${plan.imageSkipped.length}`);
  assert.ok(plan.target.every((message) => !ctx.ctxHasImageContent(message.text)), '图片楼层混进了压缩目标');
  assert.ok(plan.target.every((message) => message.index !== 2 && message.index !== 4 && message.index !== 6), '图片楼层索引没有被排除');
  console.log(`✓ 压缩目标排除 ${plan.imageSkipped.length} 条图片楼层`);

  // 3. 总结请求里不能出现图片标签
  await win.__TAM__.ui.setOpen(true);
  await win.__TAM__.ui.setTab('context');
  await tick(200);
  await win.__TAM__.context.compress({ preview: true, auto: false });
  await tick(120);
  const prompt = String(state.calls[0]?.messages?.[0]?.content ?? '');
  assert.ok(prompt, '没有发出总结请求');
  assert.ok(!prompt.includes('masterpiece'), '图片提示词被写进了总结请求');
  assert.ok(!prompt.includes('拼写错误'), '图片提示词被写进了总结请求');
  assert.ok(!prompt.includes('example.com/a.png'), 'Markdown 图片被写进了总结请求');
  console.log('✓ 总结请求不含图片标签/提示词');

  // 4. 图片楼层仍可见（没有被隐藏）
  for (const index of [2, 4, 6]) {
    assert.equal(state.chat[index].is_system, false, `图片楼层 #${index} 被隐藏了`);
  }
  console.log('✓ 图片楼层保持可见');

  // 5. 真正执行「只隐藏」也不能动图片楼层
  await win.__TAM__.context.compress({ strategy: 'hide', preview: false, auto: false });
  await tick(120);
  for (const index of [2, 4, 6]) {
    assert.equal(state.chat[index].is_system, false, `只隐藏时图片楼层 #${index} 被隐藏了`);
  }
  assert.ok(state.chat.slice(7).some((message) => message.is_system), '普通旧楼层没有被隐藏');
  console.log('✓ 只隐藏模式跳过图片楼层');

  // 6. 压图模式：保留图片标签、压掉正文；撤销恢复原文
  {
    const env2 = createEnv();
    await tick(260);
    env2.win.__TAM__.settings().context.imagePolicy = 'trim';
    await env2.win.__TAM__.context.compress({ preview: false, auto: false });
    await tick(150);
    const meta = env2.state.chatMetadata.tamCtx;
    assert.equal(meta?.imageTrims?.length, 3, `压图记录不对：${JSON.stringify(meta?.imageTrims)}`);
    const markers = { 2: '普通回复', 4: '拼写错误', 6: 'Markdown 图片' };
    for (const index of [2, 4, 6]) {
      assert.equal(env2.state.chat[index].is_system, false, `压图后图片楼层 #${index} 被隐藏`);
      assert.ok(/local_img|loacl_img|!\[/.test(env2.state.chat[index].mes), `图片标签丢了 #${index}`);
      assert.ok(!env2.state.chat[index].mes.includes(markers[index]), `正文没有压掉 #${index}`);
    }
    await env2.win.__TAM__.context.undo();
    await tick(100);
    assert.ok(env2.state.chat[2].mes.includes('普通回复'), '撤销没有恢复图片楼层原文');
    console.log('✓ 压图模式保留标签、压正文、撤销恢复');
  }
  console.log('✅ 图片保护测试通过：local_img / loacl_img / Markdown 图片都不会被压缩吞掉');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ 图片保护测试失败：', err);
  process.exit(1);
});
