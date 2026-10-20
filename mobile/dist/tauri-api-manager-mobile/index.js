/**
 * API 悬浮管家 — TauriTavern 全局扩展 (MVP 0.1.0)
 *
 * 设计依据：设计.txt
 *   - 不侵入底层，只用 window.__TAURITAVERN__ 公共 ABI + 纯前端 UI
 *   - 悬浮窗常驻、可拖拽、移动端可触屏拖动
 *   - API 档案（Base URL / Key / 提供商）的增删改查与切换
 *   - 用量统计（优先读宿主 LLM API 日志，读不到时降级为占位）
 *
 * 架构分层：
 *   settings  — 持久化（优先 SillyTavern extension_settings，退化为 localStorage）
 *   host      — 所有对宿主能力的访问都收敛在这里，便于后续替换实现
 *   probe     — 运行时 ABI 探测，解决官方 ABI 文档不全的问题
 *   ui        — 纯 DOM，无框架依赖
 *
 * 注意：本文件不使用静态 import，全部通过 globalThis / 动态 import 访问宿主，
 *      避免宿主模块路径变化导致扩展整体加载失败。
 */

const MODULE_ID = 'tauri-api-manager';
const VERSION = '0.7.5';

/* ------------------------------------------------------------------ *
 * 1. 工具
 * ------------------------------------------------------------------ */

const $id = (id) => document.getElementById(id);

function clone(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return String(url).replace(/^https?:\/\//, '').split('/')[0];
  }
}

/** 把 Key 处理成 `sk-12****89` 形式；宿主已掩码的值原样返回。 */
function maskKey(key) {
  const value = String(key ?? '').trim();
  if (!value) return '';
  if (value.includes('*')) return value;
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/* ------------------------------------------------------------------ *
 * 2. 设置持久化
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  version: 1,
  items: [],           // 本地缓冲 / 宿主不可用时的降级存储
  activeId: null,
  panel: { x: null, y: null, collapsed: false, open: false },
  fab: { x: null, y: null },
  autoFailover: true,
  // 本机用量：{ days: { 'YYYY-MM-DD': { requests, prompt, completion, updatedAt } } }
  usage: { days: {} },
  // 上下文管家：只动聊天历史，不碰角色卡 / 预设 / 世界书
  context: {
    auto: false,
    threshold: 0.8,
    keepTurns: 6,
    strategy: 'summary',
    autoEvery: 0,
    budgetOverride: 0,
    summaryChars: 240,
  },
};

let isHostReady = false;
let hostWaitPending = false;

/** 与 TauriTavern 自身一致的 Tauri 环境探测（__TAURI_RUNNING__ 注入得最早）。 */
function detectTauriRuntime() {
  return (
    globalThis.__TAURI_RUNNING__ === true ||
    globalThis.__TAURI_INTERNALS__ !== undefined ||
    typeof globalThis.__TAURI__?.core?.invoke === 'function'
  );
}

/**
 * 只有「TauriTavern ABI 已注入、waitReady 仍在等待」时才需要拦一下。
 * 纯 SillyTavern 网页版没有 __TAURITAVERN__；ABI 晚到也不应永久锁死操作。
 */
function hostGateActive() {
  const tt = globalThis.__TAURITAVERN__;
  return !!(tt && tt.api) && !isHostReady && hostWaitPending;
}

let settingsCache = null;  // 单例：保证「取出来 → 改 → 存」这一串能落到同一份数据

/** 宿主设置里永远不保存明文 Key：写入前统一抹掉。 */
function redactSettings(data) {
  const copy = clone(data);
  if (Array.isArray(copy.items)) {
    copy.items = copy.items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const { key, ...rest } = item;
      return { ...rest, key: '' };
    });
  }
  return copy;
}

/** 用 localStorage 镜像里的 Key 补全宿主设置（宿主那份是脱敏的）。 */
function mergeItemKeys(hostItems, localItems) {
  const list = Array.isArray(hostItems) ? hostItems : [];
  if (!Array.isArray(localItems) || !localItems.length) return list;

  const byId = new Map(localItems.filter((item) => item?.id).map((item) => [item.id, item]));
  const seen = new Set();
  const merged = list.map((item) => {
    if (!item?.id) return item;
    seen.add(item.id);
    const local = byId.get(item.id);
    if (!local) return item;
    return {
      ...item,
      key: local.key || item.key || '',
      secretRef: item.secretRef ?? local.secretRef ?? null,
    };
  });

  // 宿主里没有、本地镜像里有的（例如导入后还没保存到宿主的条目）
  for (const item of localItems) {
    if (item?.id && !seen.has(item.id)) merged.push(item);
  }
  return merged;
}

function dropLegacySnapshots(settings) {
  try {
    if (settings?.context && Object.hasOwn(settings.context, 'snapshots')) {
      delete settings.context.snapshots;
    }
  } catch {
    /* ignore */
  }
  return settings;
}

function readSettings() {
  let hostStored = null;
  // 1) 宿主的 extension_settings（如果存在）
  try {
    const stored = globalThis.extension_settings?.[MODULE_ID];
    if (stored && typeof stored === 'object') hostStored = clone(stored);
  } catch {
    /* ignore */
  }

  // 2) localStorage 镜像（Key 只在这里，作为本地兜底）
  let mirror = null;
  try {
    const raw = localStorage.getItem(MODULE_ID);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') mirror = parsed;
    }
  } catch (err) {
    console.warn('[API 管家] 读取 localStorage 失败', err);
  }

  if (hostStored) {
    const merged = { ...clone(DEFAULT_SETTINGS), ...hostStored };
    merged.items = mergeItemKeys(merged.items, mirror?.items);
    return dropLegacySnapshots(merged);
  }
  if (mirror) return dropLegacySnapshots({ ...clone(DEFAULT_SETTINGS), ...mirror });
  return clone(DEFAULT_SETTINGS);
}

function loadSettings() {
  if (!settingsCache) settingsCache = readSettings();
  return settingsCache;
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = loadSettings();
    try {
      // 双写：localStorage 保证扩展自己的状态一定留得住，
      // extension_settings 让宿主的设置面板也能看到（但绝不写入明文 Key）。
      localStorage.setItem(MODULE_ID, JSON.stringify(data));
    } catch (err) {
      console.warn('[API 管家] 写入 localStorage 失败', err);
    }
    try {
      if (globalThis.extension_settings) {
        globalThis.extension_settings[MODULE_ID] = redactSettings(data);
      }
      globalThis.saveSettingsDebounced?.();
      globalThis.saveSettings?.();
    } catch (err) {
      console.warn('[API 管家] 同步宿主设置失败', err);
    }
  }, 200);
}

/* ------------------------------------------------------------------ *
 * 3. 宿主访问层（所有 ABI 调用只出现在这里）
 * ------------------------------------------------------------------ */

const host = {
  /** 等待 __TAURITAVERN__ 就绪；超时也返回当前值，便于探测。 */
  async waitReady(timeoutMs = 10000) {
    hostWaitPending = true;
    try {
      // 只有确认不是 Tauri 才快速返回；桌面/手机客户端即使 ABI 注入慢也继续等
      if (!globalThis.__TAURITAVERN__) {
        if (!detectTauriRuntime()) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (!globalThis.__TAURITAVERN__) return null;
        }
      }

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const t = globalThis.__TAURITAVERN__;
        if (t?.api) {
          try {
            await Promise.race([
              t.ready ?? globalThis.__TAURITAVERN_MAIN_READY__ ?? Promise.resolve(),
              new Promise((resolve) => setTimeout(resolve, 3000)),
            ]);
          } catch (err) {
            console.warn('[API 管家] 宿主 ready 失败', err);
          }
          isHostReady = true;
          return t;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return globalThis.__TAURITAVERN__ ?? null;
    } finally {
      hostWaitPending = false;
    }
  },

  tt() {
    return globalThis.__TAURITAVERN__ ?? null;
  },

  api() {
    return globalThis.__TAURITAVERN__?.api ?? null;
  },

  /** TauriTavern 的 LLM 连接（Agent Profile 引用它）。 */
  llmConnections() {
    return this.api()?.llmConnections ?? null;
  },

  agentProfiles() {
    const agent = this.api()?.agent;
    if (!agent) return null;
    return agent.profiles ?? agent.profile ?? null;
  },
};

/* ------------------------------------------------------------------ *
 * 4. ABI 探测
 * ------------------------------------------------------------------ */

function describeMethods(obj) {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return {};
  const out = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === 'function') out[key] = `fn/${value.length}`;
    else if (value && typeof value === 'object') out[key] = `obj(${Object.keys(value).length})`;
    else out[key] = `${typeof value}:${String(value).slice(0, 40)}`;
  }
  return out;
}

function collectProbe() {
  const tt = host.tt();
  const api = host.api();
  const result = {
    generatedAt: new Date().toISOString(),
    version: VERSION,
    userAgent: navigator.userAgent,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    tauri: {
      present: !!tt,
      abiVersion: tt?.abiVersion ?? null,
      traceHeader: tt?.traceHeader ?? null,
      ready: tt?.ready ? 'promise' : null,
      topLevelKeys: tt ? Object.keys(tt) : [],
    },
    apiNamespaces: {},
    devNamespaces: {},
    st: {
      extension_settings: !!globalThis.extension_settings,
      saveSettingsDebounced: typeof globalThis.saveSettingsDebounced,
      getContext: typeof globalThis.getContext,
      sillyTavern: typeof globalThis.SillyTavern,
      sillyTavernGetContext: typeof globalThis.SillyTavern?.getContext,
      oai_settings: typeof globalThis.oai_settings,
      chatCompletionSettings: (() => {
        const ctx = getSTContext();
        return ctx ? Object.keys(ctx).filter((k) => /chat|completion|setting/i.test(k)) : null;
      })(),
      dom: {
        main_api: !!document.querySelector('#main_api'),
        chat_completion_source: !!document.querySelector('#chat_completion_source'),
        custom_api_url_text: !!document.querySelector('#custom_api_url_text'),
        custom_model_id: !!document.querySelector('#custom_model_id'),
        model_custom_select: !!document.querySelector('#model_custom_select'),
        api_button: !!document.querySelector('#api_button'),
        connect_button_any: !!findConnectButton(),
      },
      currentSettings: (() => {
        const s = getChatSettings();
        return s
          ? {
              chat_completion_source: s.chat_completion_source ?? null,
              custom_url: s.custom_url ?? null,
              custom_model: s.custom_model ?? null,
            }
          : null;
      })(),
      connectionManagerProfiles: globalThis.extension_settings?.connectionManager?.profiles?.length ?? null,
    },
  };

  if (api) {
    for (const ns of Object.keys(api)) {
      const value = api[ns];
      result.apiNamespaces[ns] = value && typeof value === 'object'
        ? describeMethods(value)
        : `${typeof value}`;
    }
  }
  const dev = api?.dev;
  if (dev) {
    for (const ns of Object.keys(dev)) {
      const value = dev[ns];
      result.devNamespaces[ns] = value && typeof value === 'object'
        ? describeMethods(value)
        : `${typeof value}`;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * 5. 连接档案：适配宿主 llmConnections（带降级）
 * ------------------------------------------------------------------ */

const KIND = 'tauritavern.llmConnection';

function normalizeBaseUrl(url) {
  return String(url ?? '').trim().slice(0, 2048).replace(/\/+$/, '');
}

/** 只接受 http/https，避免 javascript:/file:/data: 之类被写进酒馆请求。 */
function isHttpUrl(url) {
  const value = normalizeBaseUrl(url);
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 从 Base URL / 模型列表猜测提供商，用于表单自动填充。 */
function inferProvider(baseUrl, models = []) {
  const hostname = hostOf(baseUrl).toLowerCase();
  if (/deepseek/.test(hostname)) return 'deepseek';
  if (/anthropic|claude/.test(hostname)) return 'claude';
  if (/generativelanguage|googleapis/.test(hostname)) return 'google';
  if (/openrouter/.test(hostname)) return 'openrouter';
  if (/moonshot/.test(hostname)) return 'moonshot';

  const first = String(models[0] ?? '');
  if (/^claude/i.test(first)) return 'claude';
  if (/gemini/i.test(first)) return 'google';
  if (/deepseek/i.test(first)) return 'deepseek';
  return models.length ? 'openai' : '';
}

/** 连接实际使用的 chatCompletionSource（有自定义 Base URL 时一律是 custom）。 */
function sourceOf(item) {
  const baseUrl = normalizeBaseUrl(item.baseUrl);
  if (baseUrl) return 'custom';
  return item.provider || 'openai';
}

/**
 * 生成 LLM Connection 定义。
 *
 * 宿主校验规则（逐个踩出来的）：
 * 1. `endpoint.baseUrl` 只允许 `chatCompletionSource === 'custom'`；
 * 2. `provider.customApiFormat` 有一个我们还没摸清的白名单，连 'openai' 都被拒，
 *    所以先省略该字段，交给宿主按 OpenAI 兼容处理；
 * 3. `adapterHints` 是带 deny_unknown_fields 的固定结构，不能塞 model；
 * 4. 模型属于 Profile（`model.mode = 'connectionRef'` + `modelId`），不属于连接；
 * 5. `auth.secretRef.key` 必须严格等于 `api_key_<source>`（例如 custom 源就是
 *    `api_key_custom`），否则报 `secret_key_mismatch`。
 */
function toDefinition(item) {
  const definition = {
    schemaVersion: 1,
    kind: KIND,
    id: item.hostId || item.id || makeId(),
    displayName: item.name || '未命名连接',
    provider: { chatCompletionSource: sourceOf(item) },
  };

  const baseUrl = normalizeBaseUrl(item.baseUrl);
  if (baseUrl) definition.endpoint = { baseUrl };
  if (item.secretRef) definition.auth = { secretRef: item.secretRef };
  else definition.auth = {};
  return definition;
}

function fromConnection(connection) {
  if (!connection || typeof connection !== 'object') return null;
  const source = connection.provider?.chatCompletionSource ?? '';
  return {
    hostId: connection.id ?? null,
    name: connection.displayName ?? connection.name ?? connection.id ?? '未命名连接',
    baseUrl: connection.endpoint?.baseUrl ?? '',
    provider: source,
    model: connection.adapterHints?.model ?? '',
    secretRef: connection.auth?.secretRef ?? null,
    raw: connection,
  };
}

/* ---- 宿主机密存储（SillyTavern /api/secrets/*） ---- */

let stSecretsModulePromise = null;

/**
 * 我们直接调用 /api/secrets/rotate 后，ST 自己内存里的 secret_state 仍是旧快照，
 * 导致它的状态检查继续拿旧 secret_id。这里尝试调用 ST 自己的 readSecretState()
 * 刷新缓存；普通酒馆/取不到模块时静默跳过。
 */
async function refreshSTSecretState() {
  try {
    if (!stSecretsModulePromise) {
      stSecretsModulePromise = import('/scripts/secrets.js');
    }
    const mod = await stSecretsModulePromise;
    if (typeof mod?.readSecretState === 'function') {
      await Promise.race([
        Promise.resolve(mod.readSecretState()).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
      return true;
    }
  } catch {
    stSecretsModulePromise = null;
  }
  return false;
}

const secrets = {
  /**
   * 把明文密钥写进宿主机密存储，返回 secretRef。
   * 宿主不支持时返回 null，由调用方决定如何提示。
   */
  async write(key, value, label) {
    if (!key || !value) return null;
    try {
      const res = await fetch('/api/secrets/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value, label: label || key }),
      });
      if (!res.ok) {
        console.warn('[API 管家] /api/secrets/write 返回', res.status);
        return null;
      }
      await refreshSTSecretState();
      const data = await res.json().catch(() => ({}));
      let id = data?.id ?? data?.secret?.id ?? data?.data?.id ?? null;

      if (!id) {
        const readRes = await fetch('/api/secrets/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        if (readRes.ok) {
          const readData = await readRes.json().catch(() => ({}));
          id = readData?.id ?? readData?.secret?.id ?? null;
        }
      }
      // 只给 key + id，避免多带字段触发宿主 DTO 的 deny_unknown_fields
      return id ? { key, id: String(id) } : null;
    } catch (err) {
      console.warn('[API 管家] 写入宿主机密失败', err);
      return null;
    }
  },

  /**
   * 列出酒馆里某个密钥槽下保存的所有密钥。
   * `/api/secrets/read` 不带 body，返回整个 secret_state：
   *   { api_key_custom: [{ id, label, value, active }], ... }
   */
  async list(key) {
    try {
      const res = await fetch('/api/secrets/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) return [];
      const state = await res.json().catch(() => ({}));
      const list = state?.[key];
      return Array.isArray(list) ? list : [];
    } catch (err) {
      console.warn('[API 管家] 读取密钥列表失败', err);
      return [];
    }
  },

  /** 把某个已保存的密钥设为该槽位的当前生效项。 */
  async activate(key, id) {
    if (!key || !id) return false;
    try {
      const res = await fetch('/api/secrets/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, id }),
      });
      if (res.ok) await refreshSTSecretState();
      return res.ok;
    } catch (err) {
      console.warn('[API 管家] 切换密钥失败', err);
      return false;
    }
  },

  /** 整个 secret_state（形如 { api_key_custom: [{ id, label, value, active }] }）。 */
  async state() {
    try {
      const res = await fetch('/api/secrets/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) return {};
      return (await res.json().catch(() => ({}))) ?? {};
    } catch (err) {
      console.warn('[API 管家] 读取密钥状态失败', err);
      return {};
    }
  },
};

/* ---- 本地缓存 ---- */

function persistLocal(item, key) {
  const settings = loadSettings();
  const local = settings.items ?? [];
  const id = item.id || makeId();
  const index = local.findIndex((x) => x.id === id);
  const record = {
    id,
    name: item.name || '未命名连接',
    baseUrl: normalizeBaseUrl(item.baseUrl),
    provider: item.provider || '',
    model: item.model || '',
    key: key ?? (index >= 0 ? local[index].key : ''),
    secretRef: item.secretRef ?? (index >= 0 ? local[index].secretRef : null),
    updatedAt: Date.now(),
  };
  if (index >= 0) local[index] = { ...local[index], ...record };
  else local.push(record);
  settings.items = local;
  saveSettings();
  return record;
}

function localRecord(id) {
  return (loadSettings().items ?? []).find((x) => x.id === id) ?? null;
}

/** 密钥写进宿主后，清掉本地缓存里的明文，只留 secretRef。 */
function rememberSecretRef(id, secretRef) {
  const local = localRecord(id);
  if (!local || !secretRef?.id) return;
  local.key = '';
  local.secretRef = secretRef;
  saveSettings();
}

/** 删除连接时同步清掉本地缓存，避免宿主删了、本地还留着一份 Key。 */
function forgetLocalConnection(id) {
  if (!id) return;
  const settings = loadSettings();
  settings.items = (settings.items ?? []).filter(
    (item) => item.id !== id && item.hostId !== id,
  );
  if (settings.activeId === id) settings.activeId = null;
  saveSettings();
}

/* ---- 连通性测试 ---- */

const connTest = {
  candidates(base) {
    const clean = normalizeBaseUrl(base);
    if (!clean) return [];
    if (/\/chat\/completions$/i.test(clean)) return [clean];
    const urls = [];
    if (/\/v\d+$/i.test(clean)) urls.push(`${clean}/models`);
    else urls.push(`${clean}/v1/models`, `${clean}/models`);
    return [...new Set(urls)];
  },

  /**
   * 优先用宿主自己的测试能力（走 Rust，天然没有 CORS 问题）；
   * 宿主没暴露时退化为直连 GET /models。
   */
  /**
   * 通过宿主自己的状态接口测试（会使用酒馆里保存的密钥，不需要明文 Key）。
   * 返回 null 表示宿主没有这个路由，交给直连兜底。
   */
  async hostStatus(item, source, secretId) {
    const settings = getChatSettings();
    const url = source === 'custom' ? tavernBaseUrl(item.baseUrl) : '';
    if (source === 'custom' && !url) {
      return { ok: false, channel: '宿主', message: '缺少 Base URL' };
    }
    if (url && !isHttpUrl(url)) {
      return { ok: false, channel: '宿主', message: 'Base URL 只支持 http/https' };
    }

    try {
      const res = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_completion_source: source,
          custom_api_format: settings?.custom_api_format || '',
          custom_url: url,
          secret_id: secretId,
          reverse_proxy: '',
          proxy_password: '',
        }),
      });
      if (res.status === 404) return null;
      if (!res.ok) return { ok: false, channel: '宿主', message: `HTTP ${res.status}` };

      const data = await res.json().catch(() => ({}));
      if (data?.error) {
        return { ok: false, channel: '宿主', message: String(data.message || '连接失败') };
      }
      const models = Array.isArray(data?.data)
        ? data.data.map((model) => String(model?.id ?? model?.name ?? model)).filter(Boolean)
        : [];
      return {
        ok: true,
        channel: '宿主',
        message: `连接成功${models.length ? ` · ${models.length} 个模型` : ''}`,
        models,
      };
    } catch (err) {
      return { ok: false, channel: '宿主', message: `宿主测试失败：${String(err?.message ?? err)}` };
    }
  },

  async run(item) {
    const lc = host.llmConnections();
    for (const name of ['test', 'testConnection', 'verify']) {
      if (typeof lc?.[name] === 'function') {
        try {
          const result = await lc[name]({ connection: toDefinition(item) });
          const ok = result?.ok ?? result?.valid ?? result?.success ?? true;
          return {
            ok: !!ok,
            channel: '宿主',
            message: result?.message ?? result?.error ?? (ok ? '连接可用' : '连接不可用'),
          };
        } catch (err) {
          return { ok: false, channel: '宿主', message: String(err?.message ?? err) };
        }
      }
    }

    // 没填新 Key（用的是酒馆已保存的密钥）：走宿主状态接口，宿主会用保存的 Key 去请求
    const source = sourceOf(item);
    if (!item.key) {
      const secretKey = `api_key_${source}`;
      const list = await secrets.list(secretKey);
      const secretId = item.secretId || list.find((secret) => secret.active)?.id || list[0]?.id;
      if (!secretId) {
        return { ok: false, channel: '宿主', message: `酒馆里没有 ${secretKey} 的密钥` };
      }
      const viaHost = await this.hostStatus(item, source, secretId);
      if (viaHost) return viaHost;
    }

    const base = normalizeBaseUrl(item.baseUrl);
    if (!base) return { ok: false, channel: '本地', message: '缺少 Base URL' };

    const headers = {};
    if (item.key) headers.Authorization = `Bearer ${item.key}`;
    let last = null;

    for (const url of this.candidates(base)) {
      const started = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        clearTimeout(timer);
        const ms = Math.round(performance.now() - started);

        if (res.ok) {
          let models = [];
          try {
            const data = await res.json();
            if (Array.isArray(data?.data)) {
              models = data.data
                .map((m) => String(m?.id ?? m?.name ?? ''))
                .filter(Boolean);
            }
          } catch {
            /* 返回不是 JSON 也没关系，2xx 即说明地址与鉴权可用 */
          }
          return {
            ok: true,
            channel: '直连',
            message: `${res.status} · ${ms}ms${models.length ? ` · ${models.length} 个模型` : ''}`,
            models,
            url,
          };
        }
        if (res.status === 401 || res.status === 403) {
          return { ok: false, channel: '直连', message: `鉴权失败 (${res.status})，Key 可能无效`, url };
        }
        last = { ok: false, channel: '直连', message: `HTTP ${res.status}`, url };
      } catch (err) {
        clearTimeout(timer);
        last = {
          ok: false,
          channel: '直连',
          message:
            err?.name === 'AbortError' ? '超时（8s）' : `网络/跨域失败：${err?.message ?? err}`,
          url,
        };
      }
    }
    return last ?? { ok: false, channel: '直连', message: '无法测试' };
  },
};

// 串行化切换：连点 / 并发调用时排队执行，避免 URL 与模型互相覆盖
let activateQueue = Promise.resolve();

const store = {
  /** 返回 [{ id, name, baseUrl, provider, model, source }] */
  async listConnections() {
    const lc = host.llmConnections();
    if (lc?.list) {
      try {
        const res = await lc.list();
        const connections = res?.connections ?? res ?? [];
        if (Array.isArray(connections)) {
          const cache = new Map((loadSettings().items ?? []).map((item) => [item.id, item]));
          const rows = connections
            .map((c) => {
              const normalized = fromConnection(c?.connection ?? c);
              if (!normalized) return null;
              // 宿主连接不带模型（模型属于 Profile），从本地缓存补回来
              const cached = cache.get(normalized.hostId);
              return {
                ...normalized,
                id: normalized.hostId,
                source: 'host',
                model: normalized.model || cached?.model || '',
                // 导入的条目不能给宿主连接“借”Key，否则伪造 id 就能覆盖宿主连接
                key: cached && !cached.imported ? cached.key || '' : '',
              };
            })
            .filter(Boolean);

          // list() 通常只返回摘要，endpoint 可能缺失；并行 load() 补全
          const lcLoad = lc.load;
          if (typeof lcLoad === 'function') {
            await Promise.all(
              rows.map(async (row) => {
                if (!row.id || (row.baseUrl && row.provider)) return;
                try {
                  let detail;
                  try {
                    detail = await lcLoad({ connectionId: row.id });
                  } catch {
                    detail = await lcLoad(row.id);
                  }
                  const full = fromConnection(detail?.connection ?? detail);
                  if (full) {
                    row.baseUrl = full.baseUrl || row.baseUrl;
                    row.provider = full.provider || row.provider;
                    row.secretRef = full.secretRef ?? row.secretRef;
                    row.name = full.name || row.name;
                  }
                } catch (err) {
                  console.warn('[API 管家] load() 失败', row.id, err);
                }
              }),
            );
          }

          // 用 secret_state 里的掩码值补全「哪把 Key」，再拼上本地缓存
          const secretState = await secrets.state();
          for (const row of rows) {
            const keyName = row.secretRef?.key;
            const list = keyName ? secretState?.[keyName] : null;
            const entry = Array.isArray(list)
              ? list.find((secret) => String(secret.id) === String(row.secretRef.id))
              : null;
            row.secretLabel = entry?.label || '';
            // 不要用宿主返回的值覆盖 row.key：某些配置下 /api/secrets/read 会返回明文，
            // 写回 row.key 会在下次「使用」时被当成新 Key 再写一遍。
            row.keyDisplay = row.key ? maskKey(row.key) : maskKey(entry?.value || '');
          }

          // 本地里还有、宿主里没有的（例如导入的配置）也一起列出来
          const seen = new Set(rows.map((row) => row.id));
          const local = loadSettings().items ?? [];
          for (const item of local) {
            if (!item?.id || seen.has(item.id)) continue;
            rows.push({ ...item, source: 'local', keyDisplay: maskKey(item.key) });
          }

          return rows;
        }
      } catch (err) {
        console.warn('[API 管家] llmConnections.list() 失败，退化为本地', err);
      }
    }

    const local = loadSettings().items ?? [];
    return local.map((item) => ({ ...item, id: item.id, source: 'local' }));
  },

  async saveConnection(item) {
    const lc = host.llmConnections();
    const warnings = [];
    // 先固定 id：宿主定义和本地缓存必须用同一个 id，否则删除/切换会各找各的
    item = { ...item, id: item.hostId || item.id || makeId() };
    const source = sourceOf(item);
    const expectedKey = `api_key_${source}`;

    // 1) 密钥：填了就写入宿主；没填就复用酒馆里已保存的那把。
    let secretRef = item.secretRef ?? null;
    let keyForLocal = item.key || '';
    if (item.key) {
      const written = await secrets.write(expectedKey, item.key, item.name);
      if (written) {
        secretRef = written;
        // 写入后显式激活，避免酒馆继续使用上一个 API 的旧 Key
        const activated = await secrets.activate(written.key, written.id);
        if (!activated) warnings.push('Key 已写入，但未能设为当前生效项');
        // 已进入宿主机密存储，本地不再保留明文
        keyForLocal = '';
      } else {
        warnings.push('密钥未能写入宿主机密存储，已仅保存在本地');
      }
    } else {
      if (!secretRef || secretRef.key !== expectedKey) {
        const list = await secrets.list(expectedKey);
        const active = list.find((item2) => item2?.active) ?? list[0];
        secretRef = active?.id ? { key: expectedKey, id: String(active.id) } : null;
      }
      if (!secretRef) {
        warnings.push(`酒馆里没有已保存的密钥（${expectedKey}），这条连接可能连不上`);
      }
    }

    // 没填新 Key 时，把选中的已保存密钥设为当前生效项
    if (!item.key && secretRef?.id) {
      await secrets.activate(secretRef.key, secretRef.id);
    }

    const definition = toDefinition({ ...item, secretRef });

    if (lc?.save) {
      try {
        // 官方签名 save({ connection })，部分版本接受裸对象，两者都尝试一次。
        try {
          await lc.save({ connection: definition });
        } catch (firstError) {
          await lc.save(definition);
        }
        // 本地也留一份（模型、密钥引用），用于悬浮窗展示与下次编辑回填
        persistLocal({ ...item, secretRef }, keyForLocal);
        return { ok: true, source: 'host', id: definition.id, secretRef, warnings };
      } catch (err) {
        console.warn('[API 管家] llmConnections.save() 失败', err);
        return { ok: false, error: String(err?.message ?? err), warnings };
      }
    }

    // 降级：本地存储
    const record = persistLocal(item, item.key);
    return { ok: true, source: 'local', id: record.id, secretRef, warnings };
  },

  async deleteConnection(connection) {
    const lc = host.llmConnections();
    if (lc?.delete && connection.source === 'host') {
      try {
        try {
          await lc.delete({ connectionId: connection.id });
        } catch (firstError) {
          await lc.delete(connection.id);
        }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
      }
      // 宿主删除成功后再清本地；失败时保留，方便用户重试
      forgetLocalConnection(connection.id);
      return { ok: true };
    }

    forgetLocalConnection(connection.id);
    return { ok: true };
  },

  /**
   * “切换当前 API”。
   *
   * 分三层：
   * 1. 把 Key 写进宿主的 api_key_<source> 槽位；
   * 2. 直接改酒馆自己的 API 设置（#main_api / #chat_completion_source / 自定义地址 / 模型），
   *    并点一下「连接」按钮——这一步才真正让酒馆的对话用上新 API；
   * 3. 顺带把 Agent Profile 的 connectionRef 指过去（TauriTavern 的 Agent 用）。
   */
  async activate(connection, options = {}) {
    const run = () => this._activate(connection, options);
    const task = activateQueue.then(run, run);
    activateQueue = task.then(() => undefined, () => undefined);
    return task;
  },

  async _activate(connection, options = {}) {
    if (hostGateActive()) {
      toast('宿主连接中，请稍后…');
      return { ok: true, applied: false, reason: '宿主连接中，请稍后…' };
    }

    const settings = loadSettings();

    const baseUrl = normalizeBaseUrl(connection.baseUrl);
    if (baseUrl && !isHttpUrl(baseUrl)) {
      const reason = 'Base URL 必须以 http:// 或 https:// 开头';
      toast(reason);
      return { ok: false, applied: false, reason };
    }

    // 本地/导入的条目没有经过宿主校验：把密钥交给一个陌生地址前问一次。
    const isLocalItem = connection.source === 'local' || (!connection.source && !!localRecord(connection.id));
    if (isLocalItem && baseUrl && (connection.key || connection.secretRef?.id)) {
      const confirmed =
        globalThis.confirm?.(`即将把密钥用于：${hostOf(baseUrl)}\n\n只有你信任这个地址时才继续。`) ?? true;
      if (!confirmed) {
        toast('已取消切换');
        return { ok: false, applied: false, reason: '已取消' };
      }
    }

    const source = sourceOf(connection);
    if (connection.key) {
      const written = await secrets.write(`api_key_${source}`, connection.key, connection.name);
      if (written) {
        // 某些酒馆版本 write 后不会自动把新密钥设为当前项，必须显式 rotate
        const activated = await secrets.activate(written.key, written.id);
        if (!activated) {
          toast('Key 已写入，但未能设为当前生效项；如仍报鉴权失败，请在酒馆密钥列表里手动选一次');
        }
        // 已安全落到宿主机密存储，清掉本地明文
        rememberSecretRef(connection.id, written);
      } else {
        // 普通酒馆可能没有该路由：不要因此阻断酒馆设置切换
        toast('密钥未能写入宿主机密存储，仍在尝试切换酒馆设置…');
      }
    } else if (connection.secretRef?.id) {
      // 用的是酒馆里保存的某条密钥：把它设为当前生效项
      await secrets.activate(connection.secretRef.key || `api_key_${source}`, connection.secretRef.id);
    }

    const tavern = await applyToTavern(connection);
    const agent = await applyAgentProfile(connection);

    if (tavern.applied) {
      // 只有真正切换成功才标记为「当前」
      settings.activeId = connection.id;
      saveSettings();
      const suffix = '（设置已写入；如未生效，请在酒馆 API 面板手动点一次「连接」）';

      // 点击「使用」时顺带做一次真实连通性测试，结果显示在 toast 里
      let test = null;
      if (options.test) {
        toast('已切换，正在测试连接…');
        test = await connTest.run(connection);
        if (test?.ok) {
          // 扩展自己的测试通过后，再让酒馆做一次正常状态检查：
          // 这样插头会变绿、发送按钮恢复，省掉用户手动点「连接」。
          triggerTavernStatusCheck();
        }
      }

      return {
        ok: true,
        applied: true,
        reason: (agent.applied ? '已切换酒馆 API 并更新 Agent Profile' : '已切换酒馆 API') + suffix,
        test,
      };
    }
    return {
      ok: true,
      applied: false,
      reason: tavern.reason ?? agent.reason ?? '切换未生效',
    };
  },
};

/* ---- 把连接应用到酒馆自身的 API 设置 ---- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fire(node, type) {
  node.dispatchEvent(new Event(type, { bubbles: true }));
}

function setSelectValue(select, value) {
  if (!select) return false;
  if (![...select.options].some((option) => option.value === value)) {
    select.append(optionElement(value, value));
  }
  select.value = value;
  fire(select, 'change');
  return true;
}

/**
 * 酒馆的 custom_url 是「Base URL」，它会自己拼 `/chat/completions` 和 `/models`。
 * 所以这里必须给 base，不能给完整 endpoint（否则会变成 .../chat/completions/chat/completions）。
 */
function tavernBaseUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  return base.replace(/\/chat\/completions$/i, '');
}

/** 取 SillyTavern 的 context / 聊天补全设置。 */
function getSTContext() {
  try {
    return globalThis.SillyTavern?.getContext?.() ?? globalThis.getContext?.() ?? null;
  } catch {
    return null;
  }
}

function getChatSettings() {
  const ctx = getSTContext();
  if (ctx?.chatCompletionSettings) return ctx.chatCompletionSettings;
  if (globalThis.oai_settings) return globalThis.oai_settings;
  return null;
}

/** 切换来源时酒馆会自动触发一次「连接」测试；这里临时拦掉，改由扩展自己测试。 */
let connectClickMuteUntil = 0;

function muteConnectClicks(ms = 1500) {
  connectClickMuteUntil = Date.now() + ms;
}

function installConnectClickGuard() {
  if (installConnectClickGuard.done) return;
  installConnectClickGuard.done = true;
  document.addEventListener('click', (event) => {
    if (Date.now() > connectClickMuteUntil) return;
    const target = event.target;
    if (!target?.closest) return;
    if (target.closest('#api_button_openai, #api_button')) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}

/** 同时更新 input 和 select 两种模型控件，避免 ST 的 source change 把模型重置成旧值。 */
function modelControlsFor(source) {
  const selectors = source === 'custom'
    ? ['#model_custom_select', '#custom_model_id']
    : [`#model_${source}_select`, `#model_${source}`, '#custom_model_id'];
  return [...new Set(selectors.map((selector) => document.querySelector(selector)).filter(Boolean))];
}

function setModelControl(control, value) {
  if (!control || !value) return;
  if (control.tagName === 'SELECT') {
    if (![...control.options].some((option) => option.value === value)) {
      control.append(optionElement(value, value));
    }
    control.value = value;
  } else {
    control.value = value;
  }
  fire(control, 'input');
  fire(control, 'change');
}

/** 在酒馆自己的「暂停连接校验」作用域里改设置，避免自动状态检查弹红色错误。 */
let stMainModulePromise = null;
async function withSTValidationSuspended(reason, callback) {
  try {
    if (!stMainModulePromise) stMainModulePromise = import('/script.js');
    const mod = await stMainModulePromise;
    if (typeof mod?.withConnectionValidationSuspended === 'function') {
      return await mod.withConnectionValidationSuspended(reason, callback);
    }
  } catch {
    stMainModulePromise = null;
  }
  return callback();
}

/** 切换/测试成功后主动触发一次酒馆自己的状态检查，让插头变绿、发送按钮恢复。 */
function triggerTavernStatusCheck() {
  connectClickMuteUntil = 0;
  const button = findConnectButton();
  if (!button) return false;
  button.click();
  return true;
}

function applyToTavern(connection) {
  const source = sourceOf(connection);
  const targetSource = source === 'custom' ? 'custom' : source;
  const url = source === 'custom' && connection.baseUrl ? tavernBaseUrl(connection.baseUrl) : '';
  if (url && !isHttpUrl(url)) {
    return { applied: false, reason: 'Base URL 只支持 http/https，已拒绝写入酒馆设置' };
  }
  const targets = [];

  if (document.querySelector('#main_api')) targets.push('#main_api');
  if (document.querySelector('#chat_completion_source')) targets.push('#chat_completion_source');
  if (document.querySelector('#custom_api_url_text')) targets.push('#custom_api_url_text');
  if (getChatSettings()) targets.push('settings');

  if (!targets.length) {
    return { applied: false, reason: '未找到酒馆 API 设置（#main_api / #chat_completion_source / oai_settings 都不可用）' };
  }

  const run = async () => {
    try {
      const saveTavernSettings = () => {
        const ctx = getSTContext();
        (ctx?.saveSettingsDebounced ?? globalThis.saveSettingsDebounced)?.();
      };

    // ST 的 source change 会把模型控件重置成旧值，所以每次都要在切完来源后重新写一遍
    const applyControls = () => {
      const urlNode = document.querySelector('#custom_api_url_text');
      if (url && urlNode) {
        urlNode.value = url;
        fire(urlNode, 'input');
        fire(urlNode, 'change');
      }
      if (connection.model) {
        for (const control of modelControlsFor(targetSource)) {
          setModelControl(control, connection.model);
        }
      }
    };

    const commitSettings = () => {
      const settings = getChatSettings();
      if (!settings) return null;
      settings.chat_completion_source = targetSource;
      if (url) settings.custom_url = url;
      if (connection.model) {
        if (targetSource === 'custom') settings.custom_model = connection.model;
        else settings[`${targetSource}_model`] = connection.model;
      } else if (targetSource === 'custom') {
        // 切换到一个没有模型的 custom 连接时清空旧模型，避免沿用上一条的
        settings.custom_model = '';
      }
      return settings;
    };

    const verifyApplied = () => {
      const settings = getChatSettings();
      if (!settings) return { ok: false, source: null, url: null, model: null };
      const actualSource = settings.chat_completion_source;
      const actualUrl = settings.custom_url;
      const actualModel = targetSource === 'custom'
        ? settings.custom_model
        : settings[`${targetSource}_model`];
      return {
        ok:
          actualSource === targetSource &&
          (!url || normalizeBaseUrl(actualUrl) === normalizeBaseUrl(url)) &&
          (!connection.model || actualModel === connection.model),
        source: actualSource,
        url: actualUrl,
        model: actualModel,
      };
    };

    // 1) 先把地址填进控件，再切来源——否则切换处理器可能读到空地址而回退
    const urlInput = document.querySelector('#custom_api_url_text');
    if (url && urlInput) urlInput.value = url;

    // 2) 主 API 切到「聊天补全」，等宿主的 change 处理器跑完
    muteConnectClicks(2000);
    const apiSelect = document.querySelector('#main_api');
    if (apiSelect) {
      setSelectValue(apiSelect, 'openai');
      await sleep(150);
    }

    // 3) 来源切到 custom（或对应提供商）
    let sourceSelect = document.querySelector('#chat_completion_source');
    if (sourceSelect) {
      setSelectValue(sourceSelect, targetSource);
      await sleep(200);
    }

    // 4) 最多重试 3 次：ST 的 change 处理器可能异步把 URL/模型/来源改回旧值
    let verify = verifyApplied();
    for (let attempt = 0; attempt < 3 && !verify.ok; attempt += 1) {
      // 只有来源本身没写进去时才再次触发 source change；仅 URL/模型被重置时
      // 直接重写控件和设置，避免反复 toggle 表单造成界面闪动。
      if (attempt > 0 && verify.source !== targetSource) {
        muteConnectClicks(1500);
        sourceSelect = document.querySelector('#chat_completion_source');
        if (sourceSelect) {
          setSelectValue(sourceSelect, targetSource);
          await sleep(150);
        }
      }
      applyControls();
      commitSettings();
      saveTavernSettings();
      await sleep(220);
      verify = verifyApplied();
    }

    if (!verify.ok) {
      return {
        applied: false,
        reason: `设置未生效（来源 ${verify.source ?? '未知'}，地址 ${verify.url ?? '空'}，模型 ${verify.model ?? '空'}）`,
      };
    }

    return { applied: true };
    } catch (err) {
      return { applied: false, reason: `写入酒馆设置失败：${String(err?.message ?? err)}` };
    }
  };

  return withSTValidationSuspended('API 管家切换', run);
}

/** 找酒馆的「连接」按钮：优先聊天补全的 #api_button_openai，其次旧 id，最后按文本兜底。 */
function findConnectButton() {
  const chatCompletion = document.querySelector('#api_button_openai');
  if (chatCompletion) return chatCompletion;

  const byId = document.querySelector('#api_button');
  if (byId) return byId;

  const exact = ['连接', 'Connect'];
  const nodes = [...document.querySelectorAll('button, .menu_button, div.menu_button, a.menu_button')];
  return (
    nodes.find((node) => {
      if (node.offsetParent === null) return false;
      const text = (node.textContent ?? '').trim();
      return exact.includes(text);
    }) ?? null
  );
}

/* ---- Agent Profile（TauriTavern Agent 用，尽力而为） ---- */

async function applyAgentProfile(connection) {
  const profilesApi = host.agentProfiles();
  if (!profilesApi) {
    return { applied: false, reason: '未检测到 Agent Profile API' };
  }
  const update = profilesApi.update ?? profilesApi.save;
  if (typeof update !== 'function') {
    return { applied: false, reason: 'Agent Profile API 无 update/save 方法' };
  }
  try {
    const list = await (profilesApi.list?.() ?? Promise.resolve(null));
    const profiles = list?.profiles ?? list ?? [];
    const active = Array.isArray(profiles) ? profiles.find((p) => p?.isActive || p?.active) : null;
    if (!active) {
      return { applied: false, reason: '未找到激活中的 Profile' };
    }
    const next = {
      ...active,
      model: {
        mode: 'connectionRef',
        connectionRef: connection.id,
        modelId: connection.model || active?.model?.modelId,
      },
    };
    try {
      await update({ profile: next });
    } catch {
      await update(next);
    }
    return { applied: true };
  } catch (err) {
    return { applied: false, reason: `Profile 更新失败：${String(err?.message ?? err)}` };
  }
}

/* ------------------------------------------------------------------ *
 * 5.5 自动故障转移
 * ------------------------------------------------------------------ */

let failoverSwitching = false;
let lastFailoverAt = 0;

/** 只认真正的对话请求，避开 /chat-completions/status 之类的辅助接口。 */
function isChatCompletionUrl(url) {
  const value = String(url || '');
  if (/\/chat-completions\/status\b/i.test(value)) return false;
  return (
    /\/chat\/completions(?:[?#]|$)/i.test(value) ||
    /\/chat-completions\/generate(?:[?#]|$)/i.test(value)
  );
}

const FAILOVER_401 = /\b401\b|unauthorized|invalid[_\s-]?api[_\s-]?key|incorrect api key|authentication|密钥无效|认证失败|鉴权失败/i;
const FAILOVER_429 = /\b429\b|rate[_\s-]?limit|too many requests|insufficient[_\s-]?quota|quota exceeded|限流|频率限制|请求过多|额度/i;

function classifyChatError(text) {
  const value = String(text || '').slice(0, 4000);
  // 只认宿主包装过的错误体（"[API Error]" 前缀或 JSON 里的 error 字段），
  // 避免模型正常回复里提到 401/429 时被误判成故障。
  const isErrorBody = /\[API\s*(?:Error|错误|錯誤|エラー)\]|"error"\s*:/i.test(value);
  if (!isErrorBody) return 0;
  if (FAILOVER_429.test(value)) return 429;
  if (FAILOVER_401.test(value)) return 401;
  return 0;
}

function extractUsage(data) {
  const u =
    data?.usage ??
    data?.data?.usage ??
    data?.response?.usage ??
    data?.result?.usage;
  if (!u || typeof u !== 'object') return null;
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? u.promptTokens ?? 0);
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? u.completionTokens ?? 0);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  return { prompt: toCount(prompt), completion: toCount(completion) };
}

const MAX_INSPECT_BYTES = 8 * 1024 * 1024;

/**
 * 克隆响应做一次「旁路读取」：
 *  - 识别宿主包装成 200 的 `[API Error]`（故障转移用）；
 *  - 提取 JSON / SSE 末尾的 usage（本地用量用）。
 * 全程不消费原响应、不 await 到主流程里，生成速度不受影响。
 */
async function inspectChatResponse(response) {
  const clone = response?.clone?.();
  if (!clone) return { errorStatus: 0, usage: null, ok: true };
  const type = String(clone.headers?.get?.('content-type') || '');

  try {
    if (type.includes('application/json')) {
      const data = await clone.json();
      return {
        errorStatus: classifyChatError(JSON.stringify(data)),
        usage: extractUsage(data),
        ok: true,
      };
    }

    if (type.includes('text/event-stream') && clone.body) {
      const reader = clone.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let errorStatus = 0;
      let foundUsage = null;
      let bytes = 0;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value?.byteLength ?? 0;
          if (bytes > MAX_INSPECT_BYTES) {
            void reader.cancel().catch(() => {});
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');

            const trimmed = line.trim();
            const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
            if (!payload || payload === '[DONE]') continue;

            let frame = null;
            try {
              frame = JSON.parse(payload);
            } catch {
              continue;
            }
            if (!errorStatus) errorStatus = classifyChatError(payload);
            if (errorStatus) {
              void reader.cancel().catch(() => {});
              return { errorStatus, usage: null, ok: false };
            }
            const frameUsage = extractUsage(frame);
            if (frameUsage) foundUsage = frameUsage;
          }
        }
        // 处理最后一行没有换行符的情况
        const tail = `${buffer}${decoder.decode()}`.trim();
        if (tail) {
          const payload = tail.startsWith('data:') ? tail.slice(5).trim() : tail;
          if (payload && payload !== '[DONE]') {
            try {
              const frame = JSON.parse(payload);
              if (!errorStatus) errorStatus = classifyChatError(payload);
              const frameUsage = extractUsage(frame);
              if (frameUsage) foundUsage = frameUsage;
            } catch {
              /* ignore */
            }
          }
        }
        return { errorStatus, usage: foundUsage, ok: !errorStatus };
      } catch {
        // 用户中途停止生成 / 流被中断：不计数
        return { errorStatus: 0, usage: foundUsage, ok: false };
      }
    }
  } catch {
    /* 探测失败不影响正常请求 */
  }
  return { errorStatus: 0, usage: null, ok: true };
}

/** Hook window.fetch：对话请求 401/429 时自动切到下一条，并记录本地用量。 */
function installFetchFailover() {
  const original = globalThis.fetch;
  if (typeof original !== 'function' || original.__tamFailover) return;

  const wrapped = async function (...args) {
    const response = await original.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      if (isChatCompletionUrl(url)) {
        const status = response?.status;
        if (status === 401 || status === 429) {
          void maybeFailover(status);
        } else if (response?.ok) {
          // 不 await：读不到 usage 就算 0，绝不拖慢生成
          void inspectChatResponse(response).then((result) => {
            if (result.errorStatus) {
              void maybeFailover(result.errorStatus);
              return;
            }
            if (result.ok) {
              usage.record({
                requests: 1,
                prompt: result.usage?.prompt ?? 0,
                completion: result.usage?.completion ?? 0,
              });
            }
          });
        }
      }
    } catch (err) {
      console.warn('[API 管家] 故障转移/用量检查失败', err);
    }
    return response;
  };

  wrapped.__tamFailover = true;
  globalThis.fetch = wrapped;
}

async function maybeFailover(status) {
  if (failoverSwitching) return;
  // 只处理鉴权失效/限流，避免被 404/500 或手动调用误触发
  if (status !== 401 && status !== 429) return;

  const settings = loadSettings();
  if (settings.autoFailover === false) return;

  const now = Date.now();
  if (now - lastFailoverAt < 15000) return;
  lastFailoverAt = now;

  failoverSwitching = true;
  try {
    // 只轮换宿主托管的连接：本地/导入条目未经校验，自动把对话发过去风险太大
    const connections = (await store.listConnections()).filter((item) => item.source !== 'local');
    if (connections.length < 2) return;

    const index = connections.findIndex((item) => item.id === settings.activeId);
    if (index < 0) return;

    const next = connections[(index + 1) % connections.length];
    if (!next || next.id === settings.activeId) return;

    const result = await store.activate(next);
    if (!result.applied) return;

    toast(`检测到${status === 429 ? '限流' : '密钥失效'}，已自动切换至：${next.name || '下一条 API'}。为避免重复发送，请手动重发上一条消息。`);
    ui.setActiveRow(next.id);
  } catch (err) {
    console.warn('[API 管家] 自动切换失败', err);
  } finally {
    failoverSwitching = false;
  }
}

/* ------------------------------------------------------------------ *
 * 6. 用量
 * ------------------------------------------------------------------ */

const USAGE_KEEP_DAYS = 31;          // 只留最近 31 天，避免设置无限膨胀
const USAGE_MAX_VALUE = 1e15;        // 单日计数上限，防止异常数据把 UI 撑爆

/** 本地日期（不是 UTC），跨天按用户设备时区算。 */
function localDayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return localDayKey(new Date());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), USAGE_MAX_VALUE);
}

/** 把大数字压成「1.2万 / 1.2亿 / 1万亿」，避免三卡片被撑破。 */
function formatUsageNumber(value) {
  const n = Math.max(0, Math.min(Math.floor(Number(value) || 0), USAGE_MAX_VALUE));
  if (n < 10000) return String(n);
  const trim = (text) => String(text).replace(/\.0$/, '');
  if (n >= 1e12) return `${trim((n / 1e12).toFixed(n >= 1e13 ? 0 : 1))}万亿`;
  if (n >= 1e8) return `${trim((n / 1e8).toFixed(n >= 1e9 ? 0 : 1))}亿`;
  return `${trim((n / 1e4).toFixed(n >= 1e5 ? 0 : 1))}万`;
}

function usageDays() {
  const raw = loadSettings().usage;
  if (raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object') return raw.days;
  return {};
}

function usageEntry(dayKey = localDayKey()) {
  const raw = usageDays()[dayKey];
  if (!raw || typeof raw !== 'object') {
    return { requests: 0, prompt: 0, completion: 0, updatedAt: 0 };
  }
  return {
    requests: toCount(raw.requests),
    prompt: toCount(raw.prompt),
    completion: toCount(raw.completion),
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

const usage = {
  today(dayKey = localDayKey()) {
    return usageEntry(dayKey);
  },

  /** 累加一次成功请求；prompt/completion 缺失时按 0 记。 */
  record({ prompt = 0, completion = 0, requests = 1 } = {}, dayKey = localDayKey()) {
    const settings = loadSettings();
    const days = { ...usageDays() };
    const current = usageEntry(dayKey);
    days[dayKey] = {
      requests: toCount(current.requests + toCount(requests)),
      prompt: toCount(current.prompt + toCount(prompt)),
      completion: toCount(current.completion + toCount(completion)),
      updatedAt: Date.now(),
    };

    // 只保留最近 31 天
    const keys = Object.keys(days).filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key)).sort();
    while (keys.length > USAGE_KEEP_DAYS) delete days[keys.shift()];

    settings.usage = { days };
    saveSettings();
    scheduleUsageRender();
    return days[dayKey];
  },

  clear() {
    const settings = loadSettings();
    settings.usage = { days: {} };
    saveSettings();
    scheduleUsageRender();
  },

  format: formatUsageNumber,
};

let usageRenderTimer = null;
/** 用量页打开时，新请求只触发节流刷新，不打断面板操作。 */
function scheduleUsageRender() {
  if (ui.currentTab !== 'usage' || !ui.usageEl || usageRenderTimer) return;
  usageRenderTimer = setTimeout(() => {
    usageRenderTimer = null;
    if (ui.currentTab === 'usage') renderUsage();
  }, 500);
}

/* ------------------------------------------------------------------ *
 * 7. UI
 * ------------------------------------------------------------------ */

const ui = {
  root: null,
  panel: null,
  listEl: null,
  tabs: [],
  currentTab: 'connections',
};

/**
 * 布局视口尺寸。
 * 手机上软键盘弹起时 window.innerHeight 会缩小，但 documentElement.clientHeight
 * 仍然是稳定的布局视口，用它做拖拽边界就不会把面板/悬浮球弹回顶部。
 */
function viewportSize() {
  const root = document.documentElement;
  return {
    width: root?.clientWidth || innerWidth,
    height: root?.clientHeight || innerHeight,
  };
}

/** 坐标防御：NaN / Infinity / 字符串一律退回 8，避免写出非法 left/top。 */
function clampCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 8;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') node.innerHTML = value;
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const ICONS = {
  spark: '<path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  export: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
  import: '<path d="M12 3v12"/><path d="m7 15 5 5 5-5"/><path d="M5 21h14"/>',
  plug: '<path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z"/><path d="M12 17v5"/>',
};

function icon(name, size = 16) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

function iconSpan(name, size = 16) {
  return el('span', { class: 'tam-ic', html: icon(name, size) });
}

function providerTone(source) {
  const value = String(source || '').toLowerCase();
  if (value === 'custom') return 'indigo';
  if (value.includes('openai')) return 'green';
  if (value.includes('deepseek')) return 'blue';
  if (value.includes('claude') || value.includes('anthropic')) return 'orange';
  if (value.includes('google') || value.includes('gemini')) return 'yellow';
  return 'slate';
}

function optionElement(label, value) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function buildUi() {
  if ($id('tam-root')) return;

  const root = el('div', { id: 'tam-root' });

  const fab = el('button', {
    id: 'tam-fab',
    type: 'button',
    title: 'API 悬浮管家',
    'aria-label': '打开 API 悬浮管家',
    'aria-pressed': 'false',
  }, el('span', { class: 'tam-fab-ic', html: icon('spark', 18) }));

  const header = el('header', { id: 'tam-header' },
    el('div', { class: 'tam-grip', 'aria-hidden': 'true' }),
    el('div', { class: 'tam-headrow' },
      el('span', { class: 'tam-logo', html: icon('spark', 15) }),
      el('div', { class: 'tam-headtext' },
        el('span', { class: 'tam-title' }, 'API 管家'),
        el('span', { id: 'tam-host-badge', class: 'tam-badge' }, '探测中'),
      ),
      el('div', { class: 'tam-headactions' },
        el('button', { class: 'tam-iconbtn', title: '收起', 'aria-label': '收起', html: icon('minus', 16), onclick: () => ui.toggleCollapse() }),
        el('button', { class: 'tam-iconbtn', title: '关闭', 'aria-label': '关闭', html: icon('x', 16), onclick: () => ui.setOpen(false) }),
      ),
    ),
  );

  const tabs = el('nav', { class: 'tam-tabs' },
    ...['connections', 'usage', 'probe', 'context'].map((key) =>
      el('button', {
        class: 'tam-tab',
        dataset: { tab: key },
        onclick: () => ui.setTab(key),
      }, { connections: '连接', usage: '用量', probe: '诊断', context: '上下文' }[key]),
    ),
  );

  const list = el('div', { class: 'tam-body', id: 'tam-connections' });
  const usageBody = el('div', { class: 'tam-body tam-hidden', id: 'tam-usage' });
  const probeBody = el('div', { class: 'tam-body tam-hidden', id: 'tam-probe' });
  const contextBody = el('div', { class: 'tam-body tam-hidden', id: 'tam-context' });

  const footer = el('footer', { class: 'tam-footer' },
    el('button', { class: 'tam-primary', onclick: () => ui.openForm(null) }, iconSpan('plus', 15), '新增 API'),
    el('button', {
      class: 'tam-iconbtn tam-footer-btn',
      type: 'button',
      title: '读取酒馆配置',
      'aria-label': '读取酒馆配置',
      html: icon('plug', 16),
      onclick: () => ui.importCurrentConfig(),
    }),
    el('button', {
      class: 'tam-iconbtn tam-footer-btn',
      type: 'button',
      title: '导出配置',
      'aria-label': '导出配置',
      html: icon('export', 16),
      onclick: () => ui.exportConfig(),
    }),
    el('button', {
      class: 'tam-iconbtn tam-footer-btn',
      type: 'button',
      title: '导入配置',
      'aria-label': '导入配置',
      html: icon('import', 16),
      onclick: () => $id('tam-import-file')?.click(),
    }),
  );

  const panel = el('section', { id: 'tam-panel' }, header, tabs, list, usageBody, probeBody, contextBody, footer);

  root.append(fab, panel);

  const importInput = el('input', {
    id: 'tam-import-file',
    type: 'file',
    accept: '.json,application/json',
    class: 'tam-hidden',
    onchange: (event) => void ui.importConfig(event),
  });
  root.append(importInput);

  const modal = el('div', { id: 'tam-modal', class: 'tam-hidden' },
    el('div', { class: 'tam-modal-card' },
      el('div', { class: 'tam-modal-head' },
        el('h3', { id: 'tam-modal-title' }, '新增 API'),
        el('button', { class: 'tam-iconbtn', title: '关闭', 'aria-label': '关闭', html: icon('x', 16), onclick: () => ui.closeForm() }),
      ),
      el('label', {}, '名称', el('input', { id: 'tam-f-name', placeholder: '例如：DeepSeek 官方', autocomplete: 'off' })),
      el('label', {}, 'Base URL',
        el('input', {
          id: 'tam-f-url',
          type: 'url',
          inputmode: 'url',
          autocomplete: 'off',
          spellcheck: 'false',
          placeholder: 'https://api.deepseek.com/v1',
        }),
        el('span', { class: 'tam-field-hint' }, '填到 /v1 为止，不要带 /chat/completions；测试连接会自动校正'),
      ),
      el('label', {}, 'API Key',
        el('input', {
          id: 'tam-f-key',
          type: 'password',
          autocomplete: 'off',
          placeholder: '留空 = 复用酒馆已保存的密钥',
        }),
        el('span', { class: 'tam-field-hint' }, '酒馆里已保存过该来源的密钥时，这里可以留空'),
      ),
      el('label', {}, '已保存的密钥（下拉选择）',
        el('select', { id: 'tam-f-secret', onchange: () => ui.onSecretModeChange() },
          el('option', { value: '' }, '手动输入 / 不指定'),
        ),
        el('span', { class: 'tam-field-hint', id: 'tam-secret-hint' }, '读取酒馆密钥列表…'),
      ),
      el('label', {}, '提供商 (chatCompletionSource)',
        el('select', { id: 'tam-f-provider' },
          ...['openai', 'deepseek', 'claude', 'google', 'openrouter', 'moonshot', 'custom']
            .map((p) => el('option', { value: p }, p)),
        ),
        el('span', { class: 'tam-field-hint', id: 'tam-provider-hint' }, '测试连接后会自动识别并填上'),
      ),
      el('label', {}, '模型', el('input', { id: 'tam-f-model', list: 'tam-models', placeholder: '测试连接后自动填充' }),
        el('datalist', { id: 'tam-models' }),
      ),
      el('div', { class: 'tam-testrow' },
        el('button', { class: 'tam-ghost', id: 'tam-f-test', onclick: () => ui.runTest() }, '测试连接'),
        el('span', { id: 'tam-f-testresult', class: 'tam-testresult' }, ''),
      ),
      el('div', { class: 'tam-modal-actions' },
        el('button', { class: 'tam-ghost', onclick: () => ui.closeForm() }, '取消'),
        el('button', { class: 'tam-primary', id: 'tam-f-save', onclick: () => ui.submitForm() }, '保存'),
      ),
    ),
  );

  root.append(modal);
  document.body.append(root);

  // 必须等 modal 挂到 document 之后再用 getElementById 绑，否则 $id 返回 null
  for (const id of ['tam-f-url', 'tam-f-provider']) {
    $id(id)?.addEventListener('change', () => {
      if (!$id('tam-modal').classList.contains('tam-hidden')) void ui.loadSecrets();
    });
  }

  ui.root = root;
  ui.panel = panel;
  ui.listEl = list;
  ui.usageEl = usageBody;
  ui.probeEl = probeBody;
  ui.contextEl = contextBody;
  ui.footerEl = footer;
  ui.tabs = [...tabs.querySelectorAll('.tam-tab')];

  enableDrag(header, panel);
  enableFabDrag(fab);
  installConnectClickGuard();
  ui.restoreFab();
  ui.restorePanel();
  window.addEventListener('resize', () => {
    ui.clampPosition();
    ui.clampFab();
  });
}

ui.restorePanel = () => {
  const panel = loadSettings().panel ?? {};
  ui.setOpen(!!panel.open);
  ui.panel.classList.toggle('tam-collapsed', !!panel.collapsed);
  if (Number.isFinite(panel.x) && Number.isFinite(panel.y)) {
    // 等一帧，保证 offsetWidth 已经可读
    requestAnimationFrame(() => ui.setPosition(panel.x, panel.y));
  }
};

ui.setPosition = (x, y) => {
  const panel = ui.panel;
  if (!panel) return;
  const { width, height } = viewportSize();
  const maxX = Math.max(8, width - panel.offsetWidth - 8);
  const maxY = Math.max(8, height - panel.offsetHeight - 8);
  const nx = Math.min(Math.max(8, clampCoord(x)), maxX);
  const ny = Math.min(Math.max(8, clampCoord(y)), maxY);
  panel.style.left = `${nx}px`;
  panel.style.top = `${ny}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
};

ui.clampPosition = () => {
  const panel = ui.panel;
  if (!panel || panel.style.left === '') return;
  ui.setPosition(parseFloat(panel.style.left), parseFloat(panel.style.top));
};

ui.setOpen = (open) => {
  const settings = loadSettings();
  settings.panel = { ...settings.panel, open };
  saveSettings();
  ui.panel.classList.toggle('tam-hidden', !open);

  // 悬浮球常驻：打开时变成关闭按钮，不再隐藏
  const fab = $id('tam-fab');
  if (fab) {
    fab.classList.toggle('is-open', open);
    fab.setAttribute('aria-pressed', String(open));
    fab.setAttribute('aria-label', open ? '关闭 API 悬浮管家' : '打开 API 悬浮管家');
    fab.title = open ? '关闭 API 悬浮管家' : 'API 悬浮管家';
    const iconNode = fab.querySelector('.tam-fab-ic');
    if (iconNode) iconNode.innerHTML = icon(open ? 'x' : 'spark', 18);
  }

  if (open) ui.refreshHostBadge();
};

/* ---- 悬浮球拖拽 ---- */

function enableFabDrag(fab) {
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;
  let dragging = false;
  let moved = false;

  fab.addEventListener('pointerdown', (event) => {
    const rect = fab.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    originX = rect.left;
    originY = rect.top;
    dragging = true;
    moved = false;
    fab.setPointerCapture?.(event.pointerId);
  });

  fab.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 6) return;
    moved = true;
    event.preventDefault();
    ui.setFabPosition(originX + dx, originY + dy);
  });

  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    fab.releasePointerCapture?.(event.pointerId);
    if (moved) {
      const rect = fab.getBoundingClientRect();
      const settings = loadSettings();
      settings.fab = { x: rect.left, y: rect.top };
      saveSettings();
    }
  };

  fab.addEventListener('pointerup', stop);
  fab.addEventListener('pointercancel', stop);
  fab.addEventListener('click', (event) => {
    if (moved) {
      moved = false;
      event.preventDefault();
      return;
    }
    ui.setOpen(!loadSettings().panel.open);
  });
}

ui.setFabPosition = (x, y) => {
  const fab = $id('tam-fab');
  if (!fab) return;
  const { width, height } = viewportSize();
  const maxX = Math.max(8, width - fab.offsetWidth - 8);
  const maxY = Math.max(8, height - fab.offsetHeight - 8);
  const nx = Math.min(Math.max(8, clampCoord(x)), maxX);
  const ny = Math.min(Math.max(8, clampCoord(y)), maxY);
  fab.style.left = `${nx}px`;
  fab.style.top = `${ny}px`;
  fab.style.right = 'auto';
  fab.style.bottom = 'auto';
};

ui.restoreFab = () => {
  const { x, y } = loadSettings().fab ?? {};
  if (Number.isFinite(x) && Number.isFinite(y)) {
    requestAnimationFrame(() => ui.setFabPosition(x, y));
  }
};

ui.clampFab = () => {
  const fab = $id('tam-fab');
  if (!fab || fab.style.left === '') return;
  ui.setFabPosition(parseFloat(fab.style.left), parseFloat(fab.style.top));
};

ui.toggleCollapse = (force) => {
  const collapsed = force ?? !ui.panel.classList.contains('tam-collapsed');
  ui.panel.classList.toggle('tam-collapsed', collapsed);
  const settings = loadSettings();
  settings.panel = { ...settings.panel, collapsed };
  saveSettings();
  ui.clampPosition();
};

ui.setTab = (tab) => {
  ui.currentTab = tab;
  for (const button of ui.tabs) button.classList.toggle('tam-active', button.dataset.tab === tab);
  $id('tam-connections').classList.toggle('tam-hidden', tab !== 'connections');
  ui.usageEl.classList.toggle('tam-hidden', tab !== 'usage');
  ui.probeEl.classList.toggle('tam-hidden', tab !== 'probe');
  ui.contextEl?.classList.toggle('tam-hidden', tab !== 'context');
  ui.footerEl?.classList.toggle('tam-hidden', tab === 'context');
  ui.panel?.classList.toggle('tam-ctx-tall', tab === 'context');
  if (tab === 'usage') renderUsage();
  if (tab === 'probe') renderProbe();
  if (tab === 'context') void renderContext();
};

ui.refreshHostBadge = () => {
  const badge = $id('tam-host-badge');
  if (!badge) return;
  const api = host.api();
  const hasLlm = !!host.llmConnections();
  badge.textContent = api ? (hasLlm ? '宿主已连接' : '简化模式') : '本地模式';
  badge.dataset.state = api ? (hasLlm ? 'ok' : 'warn') : 'warn';
};

/* ---- 拖拽：Pointer Events，鼠标与触屏通用 ---- */
function enableDrag(handle, panel) {
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;
  let dragging = false;

  handle.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    originX = rect.left;
    originY = rect.top;
    dragging = true;
    handle.setPointerCapture?.(event.pointerId);
    panel.classList.add('tam-dragging');
  });

  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    ui.setPosition(originX + (event.clientX - startX), originY + (event.clientY - startY));
  });

  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('tam-dragging');
    handle.releasePointerCapture?.(event.pointerId);
    const settings = loadSettings();
    settings.panel = {
      ...settings.panel,
      x: parseFloat(panel.style.left) || 0,
      y: parseFloat(panel.style.top) || 0,
    };
    saveSettings();
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}

/* ---- 列表渲染 ---- */
async function renderConnections() {
  const list = ui.listEl;
  if (!list) return;
  list.textContent = '';

  list.append(el('div', { class: 'tam-loading' }, '读取连接…'));
  let connections = [];
  try {
    connections = await store.listConnections();
  } catch (err) {
    list.textContent = '';
    list.append(el('div', { class: 'tam-empty' }, `读取失败：${err?.message ?? err}`));
    return;
  }

  list.textContent = '';
  if (!connections.length) {
    list.append(
      el('div', { class: 'tam-empty' },
        el('span', { class: 'tam-empty-icon', html: icon('plug', 22) }),
        el('strong', {}, '还没有 API 档案'),
        el('p', {}, '点「读取酒馆配置」自动填入当前配置；或「新增 API」手动添加。Key 可留空，直接选酒馆已保存的密钥。'),
      ),
    );
    return;
  }

  const activeId = loadSettings().activeId;
  for (const connection of connections) {
    const active = connection.id === activeId;
    const initial = (connection.name || '?').trim().slice(0, 1).toUpperCase();
    const maskedKey = connection.keyDisplay || maskKey(connection.key);
    const subParts = [hostOf(connection.baseUrl) || '未填 Base URL'];
    if (connection.model) subParts.push(connection.model);
    if (maskedKey) subParts.push(maskedKey);
    const row = el('div', {
      class: `tam-row${active ? ' is-active' : ''}`,
      dataset: { id: connection.id ?? '' },
    },
      el('div', { class: 'tam-avatar', dataset: { tone: providerTone(connection.provider) } }, initial),
      el('div', { class: 'tam-row-main' },
        el('div', { class: 'tam-row-title' },
          el('span', { class: 'tam-name' }, connection.name || '未命名'),
          active ? el('span', { class: 'tam-chip is-accent' }, '当前') : null,
          connection.source === 'local' ? el('span', { class: 'tam-chip' }, '本地') : null,
        ),
        el('div', { class: 'tam-row-sub' }, subParts.join(' · ')),
      ),
      el('div', { class: 'tam-row-actions' },
        el('button', { class: 'tam-iconbtn is-accent', title: '切换为当前', 'aria-label': '切换为当前', html: icon('check', 16), onclick: () => onActivate(connection) }),
        el('button', { class: 'tam-iconbtn', title: '编辑', 'aria-label': '编辑', html: icon('pencil', 16), onclick: () => ui.openForm(connection) }),
        el('button', { class: 'tam-iconbtn is-danger', title: '删除', 'aria-label': '删除', html: icon('trash', 16), onclick: () => onDelete(connection) }),
      ),
    );
    list.append(row);
  }
}

/* ---- 用量渲染 ---- */

/** 切换成功后原地更新「当前」标记，避免整表重渲染造成闪动。 */
ui.setActiveRow = (id) => {
  const list = ui.listEl;
  if (!list) return;
  const target = String(id ?? '');
  for (const row of list.querySelectorAll('.tam-row')) {
    const active = row.dataset.id === target;
    row.classList.toggle('is-active', active);
    const title = row.querySelector('.tam-row-title');
    if (!title) continue;
    const chip = title.querySelector('.tam-chip.is-accent');
    if (active && !chip) {
      const name = title.querySelector('.tam-name');
      const node = el('span', { class: 'tam-chip is-accent' }, '当前');
      if (name?.nextSibling) title.insertBefore(node, name.nextSibling);
      else title.append(node);
    } else if (!active && chip) {
      chip.remove();
    }
  }
};
function usageStat(label, value) {
  const full = Math.max(0, Math.floor(Number(value) || 0));
  return el('div', { class: 'tam-stat' },
    el('b', { title: full.toLocaleString('zh-CN') }, formatUsageNumber(full)),
    el('span', {}, label),
  );
}

function usageAutoFailoverToggle() {
  const input = el('input', { id: 'tam-auto-failover', type: 'checkbox' });
  input.checked = loadSettings().autoFailover !== false;
  input.addEventListener('change', () => ui.setAutoFailover(input.checked));

  return el('label', { class: 'tam-toggle', for: 'tam-auto-failover' },
    input,
    el('span', { class: 'tam-toggle-track', 'aria-hidden': 'true' }),
    el('span', { class: 'tam-toggle-text' }, 'API 故障自动切换'),
  );
}

function renderUsage() {
  const body = ui.usageEl;
  if (!body) return;
  const day = usage.today();

  body.textContent = '';
  body.append(
    el('div', { class: 'tam-usage-date' }, `今日 · ${localDayKey()}`),
    el('div', { class: 'tam-stats' },
      usageStat('今日请求数', day.requests),
      usageStat('输入 Tokens', day.prompt),
      usageStat('输出 Tokens', day.completion),
    ),
    usageAutoFailoverToggle(),
    el('div', { class: 'tam-usage-actions' },
      el('button', {
        id: 'tam-clear-usage',
        class: 'tam-ghost',
        type: 'button',
        onclick: () => ui.clearUsage(),
      }, iconSpan('trash', 14), '清空统计'),
    ),
  );

  body.append(
    el('p', { class: 'tam-hint' }, '只统计本机发起的成功对话请求；流式响应在结束时补记 usage。若服务商不返回 usage，则只计请求数。'),
  );
}

ui.setAutoFailover = (enabled) => {
  const settings = loadSettings();
  settings.autoFailover = !!enabled;
  saveSettings();
  toast(enabled ? '已开启自动故障切换' : '已关闭自动故障切换');
};

ui.clearUsage = () => {
  const confirmed = typeof globalThis.confirm === 'function'
    ? globalThis.confirm('清空本地用量统计（所有日期）？')
    : true;
  if (!confirmed) return;
  usage.clear();
  if (ui.currentTab === 'usage') renderUsage();
  toast('已清空本地用量统计');
};

/* ---- 诊断渲染 ---- */
function renderProbe() {
  const body = ui.probeEl;
  const probe = collectProbe();
  globalThis.__TAM_PROBE__ = probe;
  body.textContent = '';
  body.append(
    el('pre', { class: 'tam-pre' }, JSON.stringify(probe, null, 2)),
    el('div', { class: 'tam-modal-actions' },
      el('button', {
        class: 'tam-ghost',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(JSON.stringify(probe, null, 2));
            toast('诊断信息已复制');
          } catch {
            toast('复制失败，请手动选中');
          }
        },
      }, '复制诊断信息'),
      el('button', { class: 'tam-ghost', onclick: () => renderProbe() }, '重新探测'),
      el('button', {
        class: 'tam-ghost',
        onclick: async (event) => {
          const output = $id('tam-format-probe');
          const button = event.currentTarget;
          button.disabled = true;
          output.textContent = '探测中（会创建并删除临时连接）…';
          try {
            const result = await probeCustomApiFormats();
            output.textContent = JSON.stringify(result, null, 2);
            output.classList.remove('tam-hidden');
            globalThis.__TAM_FORMAT_PROBE__ = result;
            if (result.cleanupFailed?.length) {
              toast(`有 ${result.cleanupFailed.length} 条临时连接清理失败，请手动删除 __fmt_probe__`);
            }
          } catch (err) {
            output.textContent = `探测失败：${String(err?.message ?? err)}`;
            output.classList.remove('tam-hidden');
            toast('customApiFormat 探测失败');
          } finally {
            button.disabled = false;
          }
        },
      }, '探测 customApiFormat'),
    ),
    el('pre', { class: 'tam-pre tam-hidden', id: 'tam-format-probe' }),
  );
}

/* ------------------------------------------------------------------ *
 * 7.5 上下文管家：压缩 / 隐藏 / 撤销
 * 只操作聊天消息；角色卡、预设、世界书一律只读。
 * ------------------------------------------------------------------ */

const CTX_PROMPT_KEY = 'tam_ctx_summary';
const CTX_META_KEY = 'tamCtx';
const CTX_ROWS = 14;
const CTX_BUDGET_CHOICES = [
  [0, '跟随酒馆'],
  [10000, '1 万'],
  [30000, '3 万'],
  [50000, '5 万'],
  [70000, '7 万'],
  [90000, '9 万'],
  [110000, '11 万'],
  [130000, '13 万'],
  [150000, '15 万'],
  [200000, '20 万'],
  [300000, '30 万'],
  [500000, '50 万'],
];

let ctxBusy = false;
let ctxGenerating = false;
let ctxSettingsOpen = false;
let ctxLastAutoAt = 0;
const ctxSelected = new Set();
const ctxTokenMap = new Map();
const ctxTextMap = new Map();
let ctxChatsModulePromise = null;

function ctxSettings() {
  const stored = loadSettings().context;
  return { ...DEFAULT_SETTINGS.context, ...(stored && typeof stored === 'object' ? stored : {}) };
}

function saveCtxSettings(patch) {
  const settings = loadSettings();
  const stored = settings.context;
  settings.context = {
    ...DEFAULT_SETTINGS.context,
    ...(stored && typeof stored === 'object' ? stored : {}),
    ...patch,
  };
  saveSettings();
  return settings.context;
}

async function ctxST() {
  try {
    if (!stMainModulePromise) stMainModulePromise = import('/script.js');
    return await stMainModulePromise;
  } catch (err) {
    console.warn('[API 管家] 加载 script.js 失败', err);
    return null;
  }
}

function ctxChatMetadata() {
  try {
    return getSTContext()?.chatMetadata ?? globalThis.chat_metadata ?? null;
  } catch {
    return null;
  }
}

/** 当前聊天的消息快照；文本为空的消息（楼层占位）跳过。 */
function ctxMessages(chatInput) {
  const ctx = getSTContext();
  const chat = Array.isArray(chatInput)
    ? chatInput
    : Array.isArray(ctx?.chat)
      ? ctx.chat
      : Array.isArray(globalThis.chat)
        ? globalThis.chat
        : [];
  return chat
    .map((message, index) => ({
      index,
      name: String(message?.name ?? (message?.is_user ? 'User' : 'Character')),
      isUser: !!message?.is_user,
      hidden: !!message?.is_system,
      text: String(message?.mes ?? ''),
    }))
    .filter((message) => message.text.length > 0);
}

/**
 * 取当前聊天数组。TauriTavern / 手机端有时 getContext().chat 是空快照，
 * 这时退回 script.js 的 live binding，再退回全局 chat。
 */
async function ctxResolveChat() {
  const ctx = getSTContext();
  if (Array.isArray(ctx?.chat) && ctx.chat.length) return { chat: ctx.chat, source: 'context' };
  if (Array.isArray(globalThis.chat) && globalThis.chat.length) return { chat: globalThis.chat, source: 'global' };
  const st = await ctxST();
  if (Array.isArray(st?.chat) && st.chat.length) return { chat: st.chat, source: 'module' };
  return { chat: Array.isArray(ctx?.chat) ? ctx.chat : [], source: 'empty' };
}

function ctxBudget() {
  const settings = getChatSettings() ?? {};
  const rawLimit = Number(settings.openai_max_context) || 0;
  const rawReserve = Number(settings.openai_max_tokens) || 0;
  const override = Number(ctxSettings().budgetOverride) || 0;
  const limit = override > 0
    ? (rawLimit > 0 ? Math.min(override, rawLimit) : override)
    : (rawLimit || 8192);
  const reserve = Math.min(rawReserve, Math.floor(limit * 0.35));
  return { limit, reserve, usable: Math.max(512, limit - reserve), rawLimit, rawReserve, override };
}

/** 中文按 ~1.4 字/token，英文按 ~3.8 字符/token；只在拿不到宿主分词器时用。 */
function ctxEstimate(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text ?? '')) {
    if (/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.72 + other / 3.8);
}

function ctxModel() {
  const settings = getChatSettings() ?? {};
  return String(settings.custom_model || settings.model || 'gpt-4').trim() || 'gpt-4';
}

function ctxPayload(messages) {
  return messages.map((message) => ({
    role: message.isUser ? 'user' : 'assistant',
    content: message.text,
  }));
}

/** 整段请求的精确 token 数（和酒馆 Prompt Manager 同一套接口）。 */
async function ctxCountTotal(messages) {
  const payload = ctxPayload(messages);
  try {
    const res = await fetch(`/api/tokenizers/openai/count?model=${encodeURIComponent(ctxModel())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (Number.isFinite(data?.token_count)) return { tokens: data.token_count, exact: true };
    }
  } catch {
    /* 旧宿主没有这个路由，走估算 */
  }
  return { tokens: payload.reduce((sum, item) => sum + ctxEstimate(item.content) + 4, 3), exact: false };
}

/** 逐条 token 数（列表展示用）。 */
async function ctxCountEach(messages) {
  const payload = ctxPayload(messages);
  try {
    const res = await fetch(`/api/tokenizers/openai/count-batch?model=${encodeURIComponent(ctxModel())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (Array.isArray(data?.token_counts) && data.token_counts.length === payload.length) {
        return { counts: data.token_counts, exact: true };
      }
    }
  } catch {
    /* 同上 */
  }
  return { counts: payload.map((item) => ctxEstimate(item.content) + 4), exact: false };
}

function ctxActiveConnection() {
  const settings = loadSettings();
  const items = Array.isArray(settings.items) ? settings.items : [];
  const id = settings.activeId;
  return items.find((item) => item.id === id || item.hostId === id)
    ?? items.find((item) => item.active)
    ?? items[0]
    ?? null;
}

async function ctxConnectionKey(connection) {
  if (connection?.key) return connection.key;
  try {
    const list = await secrets.list(`api_key_${sourceOf(connection)}`);
    const hit = list.find((secret) => secret.id === connection?.secretId)
      ?? list.find((secret) => secret.active)
      ?? list[0];
    return hit?.value ?? '';
  } catch {
    return '';
  }
}

function ctxSummaryPrompt(transcript, chars) {
  const max = Math.max(120, Number(chars) || 240);
  return [
    '你是剧情压缩器。把下面这段角色扮演对话压成一条「前情提要」。',
    '',
    '保留：',
    '- 人物关系与称呼的变化',
    '- 已发生的关键事件、因果与时间顺序',
    '- 未兑现的承诺、约定、物品、地点、伤势',
    '- 角色当前的情绪、位置、对彼此的态度',
    '',
    '不要编造，不要评价，不要用第一人称。',
    `输出 ${Math.max(120, max - 60)}–${max} 字的中文段落，不要分点，不要标题。`,
    '',
    '对话：',
    transcript,
  ].join('\n');
}

/** 优先走 getContext，拿不到再退回 import('/script.js')（兼容非官方版/手机端）。 */
async function ctxSetPrompt(text) {
  const ctx = getSTContext();
  if (typeof ctx?.setExtensionPrompt === 'function') {
    try {
      ctx.setExtensionPrompt(CTX_PROMPT_KEY, text, 1, 4, false, 0);
      return true;
    } catch {
      /* fallthrough */
    }
  }
  const st = await ctxST();
  try {
    st?.setExtensionPrompt?.(CTX_PROMPT_KEY, text, 1, 4, false, 0);
    return true;
  } catch {
    return false;
  }
}

async function ctxSaveChat() {
  const ctx = getSTContext();
  if (typeof ctx?.saveChat === 'function') {
    try {
      await ctx.saveChat();
      return true;
    } catch {
      /* fallthrough */
    }
  }
  const st = await ctxST();
  try {
    await st?.saveChatConditional?.();
    return true;
  } catch {
    return false;
  }
}

/** 一次摘要最多处理 4 万字符：80 轮长聊天不会撑爆请求或超时。 */
const CTX_SUMMARY_CHAR_LIMIT = 40000;
const CTX_MSG_CHAR_CAP = 8000;
function ctxBatchMessages(target, limit = CTX_SUMMARY_CHAR_LIMIT) {
  const batch = [];
  let chars = 0;
  for (const message of target) {
    const size = Math.min(message.text.length, CTX_MSG_CHAR_CAP);
    if (chars + size > limit && batch.length >= 4) break;
    batch.push(message);
    chars += size;
  }
  return batch.length ? batch : target.slice(0, 4);
}

/** 保留最近 keepTurns 轮，其余作为压缩目标。首楼永远不压。 */
function ctxPlan(keepTurns, chatInput) {
  const visible = ctxMessages(chatInput).filter((message) => !message.hidden);
  const keep = Math.max(2, Number(keepTurns) || 6) * 2;
  const target = visible
    .slice(0, Math.max(0, visible.length - keep))
    .filter((message) => message.index > 0);
  return { visible, target, keep };
}

async function ctxApplySummary(summary, ranges, auto) {
  await ctxSetPrompt(`【前情提要】\n${summary}`);
  const chats = await ctxChats();
  for (const [from, to] of ranges) {
    try {
      if (chats?.hideChatMessageRange) await chats.hideChatMessageRange(from, to, false);
    } catch (err) {
      console.warn('[API 管家] 隐藏旧消息失败', err);
    }
  }
  const meta = ctxChatMetadata();
  if (meta) {
    meta[CTX_META_KEY] = { summary, ranges, start: ranges[0]?.[0] ?? 0, end: ranges.at(-1)?.[1] ?? 0, at: Date.now(), auto: !!auto, version: 2 };
  }
  await ctxSaveChat();
}

async function ctxApplyHideOnly(ranges) {
  const chats = await ctxChats();
  for (const [from, to] of ranges) {
    try {
      if (chats?.hideChatMessageRange) await chats.hideChatMessageRange(from, to, false);
    } catch (err) {
      console.warn('[API 管家] 隐藏消息失败', err);
    }
  }
  const meta = ctxChatMetadata();
  if (meta) {
    meta[CTX_META_KEY] = { mode: 'hide', ranges, start: ranges[0]?.[0] ?? 0, end: ranges.at(-1)?.[1] ?? 0, at: Date.now(), version: 2 };
  }
  await ctxSaveChat();
}

async function ctxCompress({ auto = false, strategy = null } = {}) {
  if (ctxBusy) return null;
  if (!auto && ctxGenerating) {
    toast('正在生成回复，稍后再试');
    return null;
  }
  ctxBusy = true;
  let timer = null;
  try {
    const settings = ctxSettings();
    const mode = strategy ?? settings.strategy ?? 'summary';
    const { chat } = await ctxResolveChat();
    const { visible, target } = ctxPlan(settings.keepTurns, chat);
    if (target.length < 2) {
      if (!auto) {
        toast(visible.length
          ? `只有 ${visible.length} 条可见消息，保留最近 ${settings.keepTurns} 轮后没有可压缩内容`
          : '还没有聊天记录');
      }
      return null;
    }
    const batch = ctxBatchMessages(target);
    const ranges = ctxGroupRanges(batch.map((message) => message.index));

    if (mode === 'hide') {
      await ctxApplyHideOnly(ranges);
      toast(`已隐藏 ${batch.length} 条旧消息`);
      if (ui.currentTab === 'context') void renderContext();
      return { ranges, count: target.length };
    }

    const connection = ctxActiveConnection();
    if (!connection) {
      if (!auto) toast('没有激活的 API 连接');
      return null;
    }
    const base = normalizeBaseUrl(connection.baseUrl);
    if (!base) {
      if (!auto) toast('当前连接缺少 Base URL');
      return null;
    }

    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 30000);
    const key = await ctxConnectionKey(connection);
    const transcript = batch
      .map((message) => {
        const text = message.text.length > CTX_MSG_CHAR_CAP
          ? `${message.text.slice(0, CTX_MSG_CHAR_CAP)}…[本条已截断]`
          : message.text;
        return `${message.isUser ? '用户' : message.name}：${text}`;
      })
      .join('\n');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: connection.model || ctxModel(),
        messages: [{ role: 'user', content: ctxSummaryPrompt(transcript, settings.summaryChars) }],
        temperature: 0.3,
        max_tokens: 800,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const reason = res.status === 401
        ? '密钥无效或未授权'
        : res.status === 429
          ? '已限流，请稍后再试'
          : `HTTP ${res.status}`;
      throw new Error(reason);
    }
    const data = await res.json().catch(() => ({}));
    const summary = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (!summary) throw new Error('摘要为空');

    await ctxApplySummary(summary, ranges, auto);
    const extra = batch.length < target.length ? `（本次处理最早的 ${batch.length} 条）` : '';
    toast(auto
      ? `已自动压缩 ${batch.length} 条旧消息${extra}`
      : `已压缩 ${batch.length} 条 · 摘要 ${summary.length} 字${extra}`);
    if (ui.currentTab === 'context') void renderContext();
    return { summary, ranges, count: batch.length };
  } catch (err) {
    const message = err?.name === 'AbortError' ? '压缩请求超时（30 秒）' : String(err?.message ?? err);
    if (!auto) toast(`压缩失败：${message}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    ctxBusy = false;
  }
}

async function ctxUndo() {
  const meta = ctxChatMetadata()?.[CTX_META_KEY];
  if (!meta) {
    toast('没有可撤销的压缩');
    return;
  }
  const ranges = Array.isArray(meta.ranges) && meta.ranges.length ? meta.ranges : [[meta.start, meta.end]];
  const chats = await ctxChats();
  if (!chats?.hideChatMessageRange) {
    toast('宿主不支持取消隐藏');
    return;
  }
  try {
    for (const [from, to] of ranges) {
      await chats.hideChatMessageRange(from, to, true);
    }
    await ctxSetPrompt('');
    delete ctxChatMetadata()[CTX_META_KEY];
    await ctxSaveChat();
    const count = ranges.reduce((sum, [from, to]) => sum + (to - from + 1), 0);
    toast(`已恢复 ${count} 条消息`);
    if (ui.currentTab === 'context') void renderContext();
  } catch (err) {
    toast(`撤销失败：${String(err?.message ?? err)}`);
  }
}

/** 一键取消所有隐藏，并清掉注入的摘要。 */
async function ctxUnhideAll() {
  const { chat } = await ctxResolveChat();
  if (!chat.length) {
    toast('还没有聊天记录');
    return;
  }
  const chats = await ctxChats();
  try {
    await chats?.hideChatMessageRange?.(0, chat.length - 1, true);
  } catch (err) {
    toast(`取消隐藏失败：${String(err?.message ?? err)}`);
    return;
  }
  await ctxSetPrompt('');
  const meta = ctxChatMetadata();
  if (meta) delete meta[CTX_META_KEY];
  await ctxSaveChat();
  ctxSelected.clear();
  toast('已取消全部隐藏');
  if (ui.currentTab === 'context') void renderContext();
}

/** 切换聊天后把摘要重新注入（extension prompt 不随聊天保存）。 */
async function ctxReapply() {
  const meta = ctxChatMetadata()?.[CTX_META_KEY];
  if (!meta?.summary) return;
  await ctxSetPrompt(`【前情提要】\n${meta.summary}`);
}

function ctxAutoDecision({ settings, visible, meta, tokens, usable }) {
  const lastEnd = Number(meta?.end ?? -1);
  const roundsSince = visible.filter((message) => message.index > lastEnd && !message.isUser).length;
  const every = Number(settings?.autoEvery) || 0;
  const byCount = every > 0 && roundsSince >= every;
  const byRatio = Number(usable) > 0 && Number(tokens) / Number(usable) >= Number(settings?.threshold || 0.8);
  return { byCount, byRatio, trigger: byCount || byRatio, roundsSince };
}

async function ctxAutoMaybe() {
  const settings = ctxSettings();
  if (!settings.auto || ctxBusy) return;
  if (Date.now() - ctxLastAutoAt < 15000) return;
  const { chat } = await ctxResolveChat();
  const { visible, target } = ctxPlan(settings.keepTurns, chat);
  if (target.length < 2) return;

  const meta = ctxChatMetadata()?.[CTX_META_KEY];
  let tokens = 0;
  const decision = ctxAutoDecision({ settings, visible, meta, tokens, usable: ctxBudget().usable });
  if (!decision.byCount) {
    const budget = ctxBudget();
    const total = await ctxCountTotal(visible);
    tokens = total.tokens;
    Object.assign(decision, ctxAutoDecision({ settings, visible, meta, tokens, usable: budget.usable }));
  }
  if (!decision.trigger) return;

  ctxLastAutoAt = Date.now();
  await ctxCompress({ auto: true });
}

async function ctxInstallHooks() {
  try {
    const st = await ctxST();
    const events = st?.event_types ?? {};
    st?.eventSource?.on?.(events.GENERATION_STARTED, () => {
      ctxGenerating = true;
    });
    st?.eventSource?.on?.(events.GENERATION_STOPPED, () => {
      ctxGenerating = false;
    });
    st?.eventSource?.on?.(events.GENERATION_ENDED, () => {
      ctxGenerating = false;
      setTimeout(() => { void ctxAutoMaybe(); }, 800);
    });
    st?.eventSource?.on?.(events.MESSAGE_RECEIVED, () => {
      if (ui.currentTab === 'context') setTimeout(() => { void renderContext(); }, 400);
    });
    st?.eventSource?.on?.(events.CHAT_CHANGED, () => {
      ctxSelected.clear();
      ctxTokenMap.clear();
      ctxGenerating = false;
      setTimeout(() => {
        void ctxReapply();
        if (ui.currentTab === 'context') void renderContext();
      }, 500);
    });
  } catch (err) {
    console.warn('[API 管家] 上下文事件订阅失败', err);
  }
}

/** 把零散的消息 id 合并成连续区间，减少 host 调用次数。 */
function ctxGroupRanges(input) {
  const ids = [...new Set(input)].sort((a, b) => a - b);
  if (!ids.length) return [];
  const ranges = [];
  let start = ids[0];
  let prev = ids[0];
  for (const id of ids.slice(1)) {
    if (id === prev + 1) {
      prev = id;
    } else {
      ranges.push([start, prev]);
      start = id;
      prev = id;
    }
  }
  ranges.push([start, prev]);
  return ranges;
}

async function ctxChats() {
  try {
    if (!ctxChatsModulePromise) ctxChatsModulePromise = import('/scripts/chats.js');
    return await ctxChatsModulePromise;
  } catch (err) {
    console.warn('[API 管家] 加载 chats.js 失败', err);
    return null;
  }
}

/** 把选中的消息按连续区间隐藏 / 取消隐藏。 */
async function ctxHideSelected(hide) {
  if (ctxBusy || ctxGenerating) {
    toast('正在生成或压缩，稍后再试');
    return;
  }
  const { chat } = await ctxResolveChat();
  const ids = [...ctxSelected].filter((index) => index >= 0 && index < chat.length).sort((a, b) => a - b);
  if (!ids.length) return;
  const chats = await ctxChats();
  if (!chats?.hideChatMessageRange) {
    toast('宿主不支持隐藏消息');
    return;
  }
  const ranges = ctxGroupRanges(ids);
  for (const [from, to] of ranges) {
    await chats.hideChatMessageRange(from, to, !hide);
  }
  ctxSelected.clear();
  toast(`${hide ? '已隐藏' : '已取消隐藏'} ${ids.length} 条`);
  if (ui.currentTab === 'context') void renderContext();
}

/** 删除选中的消息；删除前存一份快照，可从“恢复最近删除”找回。 */
async function ctxDeleteSelected() {
  if (ctxBusy || ctxGenerating) {
    toast('正在生成或压缩，稍后再试');
    return;
  }
  const { chat } = await ctxResolveChat();
  const ids = [...ctxSelected]
    .filter((index) => index > 0 && index < chat.length)
    .sort((a, b) => b - a);
  if (ctxSelected.has(0)) toast('首楼不能删除，只能隐藏');
  if (!ids.length) return;
  const confirmed = typeof globalThis.confirm === 'function'
    ? globalThis.confirm(`删除 ${ids.length} 条消息？删除后可在「恢复最近删除」里找回。`)
    : true;
  if (!confirmed) return;
  const st = await ctxST();
  if (!st?.deleteMessage || !chat.length) {
    toast('宿主不支持删除消息');
    return;
  }
  const snapshot = ids
    .map((index) => {
      const message = chat[index];
      if (!message) return null;
      return {
        index,
        is_user: !!message.is_user,
        is_system: !!message.is_system,
        name: message.name,
        send_date: message.send_date,
        mes: String(message.mes ?? '').slice(0, 20000),
      };
    })
    .filter(Boolean)
    .slice(0, 200);
  for (const index of ids) {
    await st.deleteMessage(index);
  }
  const meta = ctxChatMetadata();
  if (meta) {
    const list = Array.isArray(meta.tamCtxDeleted) ? meta.tamCtxDeleted : [];
    meta.tamCtxDeleted = [{ at: Date.now(), messages: snapshot }, ...list].slice(0, 3);
  }
  try {
    await st.saveChatConditional?.();
  } catch {
    /* ignore */
  }
  ctxSelected.clear();
  toast(ids.length > 200
    ? `已删除 ${ids.length} 条（仅最近 200 条可恢复）`
    : `已删除 ${ids.length} 条`);
  if (ui.currentTab === 'context') void renderContext();
}

/** 把最近一次删除按原楼层插回去（id 位移后尽量靠近原位）。 */
async function ctxRestoreDelete() {
  const meta = ctxChatMetadata();
  const list = Array.isArray(meta?.tamCtxDeleted) ? meta.tamCtxDeleted : [];
  const snapshot = list[0];
  if (!snapshot?.messages?.length) {
    toast('没有可恢复的删除');
    return;
  }
  const { chat } = await ctxResolveChat();
  const st = await ctxST();
  if (!chat.length || !st?.saveChatConditional) {
    toast('宿主不支持恢复');
    return;
  }
  for (const item of [...snapshot.messages].sort((a, b) => a.index - b.index)) {
    chat.splice(Math.min(item.index, chat.length), 0, {
      is_user: !!item.is_user,
      is_system: !!item.is_system,
      name: item.name,
      mes: item.mes,
      send_date: item.send_date,
    });
  }
  await st.saveChatConditional();
  if (meta) meta.tamCtxDeleted = list.slice(1);
  toast(`已恢复 ${snapshot.messages.length} 条`);
  if (ui.currentTab === 'context') void renderContext();
}

/* ---- 上下文 tab ---- */

function ctxRow(message, tokens) {
  const selected = ctxSelected.has(message.index);
  return el('div', {
    class: `tam-ctxrow${message.hidden ? ' tam-ctxrow-hidden' : ''}${selected ? ' is-sel' : ''}`,
    dataset: { idx: String(message.index) },
    onclick: () => {
      if (ctxSelected.has(message.index)) ctxSelected.delete(message.index);
      else ctxSelected.add(message.index);
      ctxSyncSelection();
    },
  },
    el('span', { class: `tam-ctxcb${selected ? ' is-on' : ''}` }),
    el('span', { class: 'tam-ctxidx' }, `#${message.index}`),
    el('span', { class: `tam-ctxwho${message.isUser ? ' is-user' : ''}` }, message.isUser ? '你' : message.name),
    el('span', { class: 'tam-ctxtext' }, message.text.length > 160 ? `${message.text.slice(0, 160)}…` : message.text),
    el('span', { class: 'tam-ctxtok' }, `${tokens}`),
  );
}

/** 选中消息的 token 估算：列表内用精确值，列表外用估算补齐。 */
function ctxSelectionTokens(ids) {
  return ids.reduce((sum, id) => {
    const known = ctxTokenMap.get(id);
    return sum + (Number.isFinite(known) ? known : ctxEstimate(ctxTextMap.get(id) ?? ''));
  }, 0);
}

/** 只改选中样式，不重新计数，避免点一下整页抖一下。 */
function ctxSyncSelection() {
  const rows = document.querySelectorAll('#tam-ctx-list .tam-ctxrow');
  for (const row of rows) {
    const index = Number(row.dataset.idx);
    const on = ctxSelected.has(index);
    row.classList.toggle('is-sel', on);
    row.querySelector('.tam-ctxcb')?.classList.toggle('is-on', on);
  }
  const bar = $id('tam-ctx-selbar');
  if (!bar) return;
  const ids = [...ctxSelected];
  const tokens = ctxSelectionTokens(ids);
  bar.classList.toggle('tam-hidden', ids.length === 0);
  const info = $id('tam-ctx-selinfo');
  if (info) info.textContent = `已选 ${ids.length} 条 · ${tokens.toLocaleString()} tokens`;
}

/** 按楼层区间选中（从 #a 到 #b）。 */
async function ctxRangeSelect() {
  const fromRaw = $id('tam-ctx-from')?.value ?? '';
  const toRaw = $id('tam-ctx-to')?.value ?? '';
  if (String(fromRaw).trim() === '' || String(toRaw).trim() === '') {
    toast('请先填写起止楼层');
    return null;
  }
  const from = Number(fromRaw);
  const to = Number(toRaw);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    toast('楼层必须是数字');
    return null;
  }
  const { chat } = await ctxResolveChat();
  const max = Math.max(0, chat.length - 1);
  const start = Math.max(0, Math.min(Math.min(from, to), max));
  const end = Math.max(0, Math.min(Math.max(from, to), max));
  ctxSelected.clear();
  for (let index = start; index <= end; index += 1) ctxSelected.add(index);
  ctxSyncSelection();
  return { start, end };
}

function ctxSelect(id, options, value, onChange) {
  const select = el('select', { id, class: 'tam-ctxselect', onchange: onChange },
    ...options.map(([optionValue, label]) => el('option', { value: String(optionValue) }, label)),
  );
  select.value = String(value);
  return select;
}

let ctxRenderSeq = 0;

async function renderContext() {
  const body = ui.contextEl;
  if (!body) return;
  const seq = ++ctxRenderSeq;
  const settings = ctxSettings();
  const budget = ctxBudget();
  const { chat, source } = await ctxResolveChat();
  if (seq !== ctxRenderSeq) return;
  const all = ctxMessages(chat);

  if (!all.length) {
    body.textContent = '';
    body.append(el('p', { class: 'tam-hint' },
      source === 'empty'
        ? '没有读到聊天记录。先打开一个聊天窗口，再点这个 tab。'
        : '当前没有聊天记录。先和角色说句话，再回来压缩。'));
    return;
  }

  const visible = all.filter((message) => !message.hidden);
  const hiddenCount = all.length - visible.length;
  if (!visible.length) {
    body.textContent = '';
    body.append(
      el('p', { class: 'tam-hint' }, '所有消息都被隐藏了。'),
      el('div', { class: 'tam-ctxactions' },
        el('button', {
          class: 'tam-primary',
          type: 'button',
          onclick: () => { void ctxUnhideAll(); },
        }, '全部取消隐藏'),
      ),
    );
    return;
  }

  const total = await ctxCountTotal(visible);
  if (seq !== ctxRenderSeq) return;

  const ratio = budget.usable ? total.tokens / budget.usable : 0;
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const state = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok';
  const rows = visible.slice(-CTX_ROWS);
  const each = await ctxCountEach(rows);
  if (seq !== ctxRenderSeq) return;

  ctxTokenMap.clear();
  ctxTextMap.clear();
  all.forEach((message) => ctxTextMap.set(message.index, message.text));
  rows.forEach((message, index) => ctxTokenMap.set(message.index, each.counts[index] ?? 0));
  body.textContent = '';

  const meta = ctxChatMetadata()?.[CTX_META_KEY] ?? null;
  const deleted = ctxChatMetadata()?.tamCtxDeleted ?? [];
  const prefix = total.exact ? '' : '≈';
  const selected = [...ctxSelected];

  body.append(
    el('div', { class: 'tam-ctxcard' },
      el('div', { class: 'tam-ctxhead' },
        el('div', {},
          el('span', { class: 'tam-ctxlabel' }, '本次请求'),
          el('div', { class: 'tam-ctxnum' }, `${prefix}${total.tokens.toLocaleString()}`,
            el('small', {}, ` / ${budget.usable.toLocaleString()}`)),
        ),
        el('span', { class: 'tam-ctxpct', dataset: { state } }, `${pct}%`),
      ),
      el('div', { class: 'tam-ctxbar' },
        el('i', { class: `is-${state}`, style: `width:${pct}%` }),
      ),
      el('div', { class: 'tam-ctxmeta' },
        el('span', {}, `${all.length} 条 · ${hiddenCount} 条已隐藏 · ${source}`),
        el('span', {}, budget.override > 0 ? `预算 ${budget.limit.toLocaleString()}（手动）` : `预算 ${budget.limit.toLocaleString()}`),
      ),
    ),
  );

  const avgTokens = total.tokens / Math.max(1, visible.length);
  const keepNeed = (Number(settings.keepTurns) * 2 + 2) * avgTokens;
  if (budget.usable < keepNeed) {
    body.append(el('p', { class: 'tam-hint tam-hint-warn' },
      `当前预算装不下「保留最近 ${settings.keepTurns} 轮」，建议把保留轮数调小，或把有效预算调大。`));
  }

  if (budget.rawLimit > budget.usable * 4) {
    body.append(el('p', { class: 'tam-hint tam-hint-warn' },
      `酒馆上下文设为 ${budget.rawLimit.toLocaleString()}，自动压缩几乎不会触发。建议把“有效预算”设成模型真实上限。`));
  }

  body.append(el('div', { class: 'tam-ctxsettings-toggle' },
    el('button', {
      class: 'tam-ctxlink',
      type: 'button',
      onclick: () => {
        ctxSettingsOpen = !ctxSettingsOpen;
        void renderContext();
      },
    }, ctxSettingsOpen ? '收起压缩设置' : '压缩设置（自动 / 保留轮数 / 预算）'),
  ));

  if (ctxSettingsOpen) body.append(
    el('div', { class: 'tam-ctxcontrols' },
      el('label', { class: 'tam-toggle tam-ctx-auto', for: 'tam-ctx-auto' },
        (() => {
          const input = el('input', { id: 'tam-ctx-auto', type: 'checkbox' });
          input.checked = !!settings.auto;
          input.addEventListener('change', () => {
            saveCtxSettings({ auto: input.checked });
            toast(input.checked ? '已开启自动压缩' : '已关闭自动压缩');
          });
          return input;
        })(),
        el('span', { class: 'tam-toggle-track', 'aria-hidden': 'true' }),
        el('span', { class: 'tam-toggle-text' }, '自动压缩'),
      ),
      el('div', { class: 'tam-ctxfield' },
        el('span', {}, '每聊'),
        ctxSelect('tam-ctx-every', [[0, '不按轮数'], [5, '5 轮'], [10, '10 轮'], [15, '15 轮'], [20, '20 轮']], settings.autoEvery, (event) => {
          saveCtxSettings({ autoEvery: Number(event.target.value) || 0 });
        }),
        el('span', {}, '自动压一次'),
      ),
      el('p', { class: 'tam-hint' },
        `摘要会发送到当前激活连接：${ctxActiveConnection()?.name ?? '未选择'}；自动压缩同样会发送。`),
      el('div', { class: 'tam-ctxseg' },
        ...[['summary', '摘要压缩'], ['hide', '只隐藏']].map(([value, label]) =>
          el('button', {
            class: `tam-seg${settings.strategy === value ? ' is-on' : ''}`,
            type: 'button',
            onclick: () => {
              saveCtxSettings({ strategy: value });
              void renderContext();
            },
          }, label)),
      ),
      el('div', { class: 'tam-ctxfield' },
        el('span', {}, '保留最近'),
        ctxSelect('tam-ctx-keep', [[4, '4 轮'], [6, '6 轮'], [8, '8 轮'], [12, '12 轮']], settings.keepTurns, (event) => {
          saveCtxSettings({ keepTurns: Number(event.target.value) || 6 });
          void renderContext();
        }),
      ),
      el('div', { class: 'tam-ctxfield' },
        el('span', {}, '有效预算'),
        ctxSelect('tam-ctx-budget', CTX_BUDGET_CHOICES, settings.budgetOverride, (event) => {
          saveCtxSettings({ budgetOverride: Number(event.target.value) || 0 });
          void renderContext();
        }),
      ),
      el('p', { class: 'tam-hint' },
        '参考：500 字 → 3 万；1000 字 → 5 万；2000 字 → 5–9 万；5000 字 → 11 万；1 万字 → 13–17 万；2 万字 → 30 万+（需模型支持）。'),
    ),
  );

  body.append(
    el('div', { class: 'tam-ctxactions' },
      el('button', {
        class: 'tam-primary',
        type: 'button',
        ...(ctxBusy || (settings.strategy !== 'hide' && !ctxActiveConnection()) ? { disabled: 'disabled' } : {}),
        onclick: () => { void ctxCompress({ auto: false }); },
      }, settings.strategy === 'hide' ? '隐藏旧消息' : '立即压缩'),
      el('button', {
        class: 'tam-ghost',
        type: 'button',
        ...(!meta ? { disabled: 'disabled' } : {}),
        onclick: () => { void ctxUndo(); },
      }, '撤销'),
      el('button', {
        class: 'tam-ghost',
        type: 'button',
        onclick: () => { void ctxUnhideAll(); },
      }, '全部取消隐藏'),
    ),
  );

  body.append(
    el('div', { class: 'tam-ctxrange' },
      el('span', { class: 'tam-ctxfield' }, '楼层'),
      el('input', { id: 'tam-ctx-from', class: 'tam-ctxnum-input', type: 'number', min: '0', placeholder: '从' }),
      el('span', { class: 'tam-ctxfield' }, '到'),
      el('input', { id: 'tam-ctx-to', class: 'tam-ctxnum-input', type: 'number', min: '0', placeholder: '到' }),
      el('button', {
        class: 'tam-ghost',
        type: 'button',
        onclick: async () => { if (await ctxRangeSelect()) void ctxHideSelected(true); },
      }, '隐藏'),
      el('button', {
        class: 'tam-ghost',
        type: 'button',
        onclick: async () => { if (await ctxRangeSelect()) void ctxHideSelected(false); },
      }, '取消隐藏'),
      el('button', {
        class: 'tam-ghost is-danger',
        type: 'button',
        onclick: async () => { if (await ctxRangeSelect()) void ctxDeleteSelected(); },
      }, '删除'),
    ),
  );

  if (deleted.length) {
    body.append(el('p', { class: 'tam-hint' },
      el('button', {
        class: 'tam-ctxlink',
        type: 'button',
        onclick: () => { void ctxRestoreDelete(); },
      }, `恢复最近删除（${deleted[0].messages?.length ?? 0} 条）`)));
  }

  if (meta?.summary) {
    body.append(
      el('div', { class: 'tam-ctxsummary' },
        el('div', { class: 'tam-ctxsummary-head' }, `已压缩 #${meta.start}–#${meta.end}`),
        el('p', {}, meta.summary),
      ),
    );
  }

  body.append(el('div', {
    class: `tam-ctxselbar${selected.length ? '' : ' tam-hidden'}`,
    id: 'tam-ctx-selbar',
  },
    el('span', { class: 'tam-ctxselinfo', id: 'tam-ctx-selinfo' }, `已选 ${selected.length} 条 · ${ctxSelectionTokens(selected).toLocaleString()} tokens`),
    el('button', { class: 'tam-ghost', type: 'button', onclick: () => { ctxSelected.clear(); ctxSyncSelection(); } }, '清除'),
    el('button', { class: 'tam-ghost', type: 'button', onclick: () => { void ctxHideSelected(true); } }, '隐藏'),
    el('button', { class: 'tam-ghost', type: 'button', onclick: () => { void ctxHideSelected(false); } }, '取消隐藏'),
    el('button', { class: 'tam-ghost is-danger', type: 'button', onclick: () => { void ctxDeleteSelected(); } }, '删除'),
  ));

  body.append(el('div', { class: 'tam-ctxlisthead' }, el('span', {}, `最近 ${rows.length} 条`), el('span', {}, total.exact ? '精确' : '估算')));
  body.append(el('div', { class: 'tam-ctxlist', id: 'tam-ctx-list' },
    ...rows.map((message, index) => ctxRow(message, each.counts[index] ?? 0)),
  ));
  body.append(el('p', { class: 'tam-hint' },
    '只改动聊天消息；角色卡、预设、世界书都不会被修改。勾选或输入楼层区间后可直接隐藏 / 删除。'));
}

/** 给测试用的纯函数出口。 */
if (typeof globalThis === 'object') {
  globalThis.__TAM_CTX__ = { ctxEstimate, ctxSummaryPrompt, ctxPlan, ctxBudget, ctxCountTotal, ctxGroupRanges, ctxAutoDecision, ctxBatchMessages, getSelected: () => [...ctxSelected] };
}

const FORMAT_CANDIDATES = [
  'openai', 'openai_chat', 'openai_chat_completions', 'openai_responses',
  'chat_completions', 'chat-completions', 'completions', 'responses', 'generic',
  'claude', 'anthropic', 'anthropic_messages', 'google', 'gemini', 'generate_content',
  'mistral', 'cohere', 'perplexity', 'groq', 'openrouter', 'deepseek', 'ollama', 'custom',
];

/**
 * 运行时探测宿主接受的 customApiFormat。
 * 用一个空鉴权的临时连接逐个试：格式错会返回 custom_api_format 错误；
 * 其它错误（比如缺密钥）说明格式已通过校验。
 */
async function deleteTemporaryConnection(lc, id) {
  if (!lc?.delete || !id) return false;
  try {
    await lc.delete({ connectionId: id });
    return true;
  } catch {
    try {
      await lc.delete(id);
      return true;
    } catch {
      return false;
    }
  }
}

async function probeCustomApiFormats() {
  const lc = host.llmConnections();
  if (!lc?.save) return { error: '宿主未暴露 llmConnections.save' };

  const accepted = [];
  const rejected = [];
  const unknown = [];
  const cleanupFailed = [];

  // 先清理上次探测可能残留的临时连接，避免反复诊断越堆越多
  if (typeof lc.list === 'function') {
    try {
      const listed = await lc.list();
      const existing = Array.isArray(listed) ? listed : (listed?.connections ?? []);
      for (const item of existing) {
        if (!item?.id) continue;
        if (item.displayName === '__fmt_probe__' || /^fmtprobe-/.test(String(item.id))) {
          const cleaned = await deleteTemporaryConnection(lc, item.id);
          if (!cleaned) cleanupFailed.push(String(item.id));
        }
      }
    } catch {
      /* 列不出来就跳过预清理，后面仍会尝试删 */
    }
  }

  for (const format of FORMAT_CANDIDATES) {
    const id = `fmtprobe-${format.replace(/[^a-z0-9]/g, '')}`.slice(0, 50);
    try {
      await lc.save({
        connection: {
          schemaVersion: 1,
          kind: KIND,
          id,
          displayName: '__fmt_probe__',
          provider: { chatCompletionSource: 'custom', customApiFormat: format },
          endpoint: { baseUrl: 'https://example.invalid/v1' },
          auth: {},
        },
      });
      accepted.push(format);
      const cleaned = await deleteTemporaryConnection(lc, id);
      if (!cleaned) cleanupFailed.push(id);
    } catch (err) {
      const message = String(err?.message ?? err);
      if (/custom_api_format/i.test(message)) rejected.push(format);
      else unknown.push({ format, message: message.slice(0, 120) });
    }
  }

  return {
    accepted,
    rejected,
    unknown,
    tried: FORMAT_CANDIDATES.length,
    cleanupFailed: [...new Set(cleanupFailed)],
  };
}

/* ---- 表单 ---- */
let editing = null;

/** 读取酒馆当前生效的 API 配置（用于“直接使用”已有配置）。 */
function readCurrentTavernConfig() {
  const settings = getChatSettings();
  if (!settings) return null;

  const source = settings.chat_completion_source || 'openai';
  const url = source === 'custom' ? (settings.custom_url || '') : '';
  const model =
    settings.custom_model ||
    settings[`${source}_model`] ||
    '';

  return { source, url, model };
}

/** 从表单读出当前输入（不落库），供保存与测试复用。 */
function readForm() {
  const id = editing?.id ?? makeId();
  const storedKey = editing ? localRecord(editing.id)?.key : '';
  const secretId = $id('tam-f-secret')?.value || '';
  return {
    id,
    hostId: editing?.hostId ?? undefined,
    name: $id('tam-f-name').value.trim(),
    baseUrl: $id('tam-f-url').value.trim(),
    // 选了已保存密钥就不再使用本地缓存/手输的 Key，避免重复写入
    key: secretId ? '' : ($id('tam-f-key').value || storedKey || ''),
    provider: $id('tam-f-provider').value.trim() || 'openai',
    model: $id('tam-f-model').value.trim(),
    secretId,
    secretRef: editing?.secretRef ?? null,
  };
}

ui.openForm = (connection) => {
  editing = connection ?? null;
  const isEditing = !!(connection?.id || connection?.hostId);
  $id('tam-modal-title').textContent = isEditing ? '编辑 API' : '新增 API';
  $id('tam-f-name').value = connection?.name ?? '';
  $id('tam-f-url').value = connection?.baseUrl ?? '';
  $id('tam-f-key').value = '';
  $id('tam-f-key').placeholder = '留空 = 复用酒馆已保存的密钥';

  // 连接可能带有下拉框里没有的提供商，动态补一个选项
  const providerSelect = $id('tam-f-provider');
  const provider = connection?.provider || 'openai';
  if (![...providerSelect.options].some((option) => option.value === provider)) {
    providerSelect.append(el('option', { value: provider }, provider));
  }
  providerSelect.value = provider;

  $id('tam-f-model').value = connection?.model ?? '';
  $id('tam-models').textContent = '';
  $id('tam-provider-hint').textContent = '测试连接后会自动识别并填上';

  const result = $id('tam-f-testresult');
  result.textContent = '';
  result.dataset.state = '';
  $id('tam-modal').classList.remove('tam-hidden');
  $id('tam-f-name').focus();
  void ui.loadSecrets();
};

/** 读取并填充该来源下已保存的密钥下拉框。 */
let secretsLoadToken = 0;
ui.loadSecrets = async () => {
  const select = $id('tam-f-secret');
  if (!select) return;

  const token = ++secretsLoadToken;
  const key = `api_key_${sourceOf(readForm())}`;
  const list = await secrets.list(key);

  // URL/提供商连续变化时，只认最后一次请求，避免旧结果覆盖新下拉
  if (token !== secretsLoadToken) return;

  select.textContent = '';
  select.append(optionElement('手动输入 / 不指定', ''));
  for (const secret of list) {
    const masked = maskKey(secret.value);
    const label = `${secret.label || '(无标签)'} ${masked}${secret.active ? '  ✓ 当前' : ''}`.trim();
    select.append(optionElement(label, String(secret.id)));
  }

  // 编辑已有连接时优先选中它引用的那条；否则选当前生效的那条
  const preferred = editing?.secretRef?.id;
  const active = list.find((secret) => secret.active);
  if (preferred && list.some((secret) => String(secret.id) === String(preferred))) {
    select.value = String(preferred);
  } else if (active?.id) {
    select.value = String(active.id);
  }

  $id('tam-secret-hint').textContent = list.length
    ? `槽位 ${key}：找到 ${list.length} 个已保存密钥`
    : `槽位 ${key} 里还没有保存的密钥`;
  ui.onSecretModeChange();
};

/** 选了已保存密钥就禁用 Key 输入框。 */
ui.onSecretModeChange = () => {
  const selected = $id('tam-f-secret')?.value || '';
  const keyInput = $id('tam-f-key');
  if (!keyInput) return;
  keyInput.disabled = !!selected;
  keyInput.placeholder = selected ? '已选择已保存的密钥' : '留空 = 复用酒馆已保存的密钥';
  if (selected) keyInput.value = '';
};

ui.closeForm = () => {
  $id('tam-modal').classList.add('tam-hidden');
  editing = null;
};

/** 读取酒馆当前生效的 API 配置，填进表单（Key 留空即复用已保存的）。 */
ui.importCurrentConfig = async () => {
  const config = readCurrentTavernConfig();
  if (!config) {
    toast('读不到酒馆的 API 设置');
    return;
  }
  if (config.source === 'custom' && !config.url) {
    toast('酒馆当前是 Custom 源，但没填自定义地址');
    return;
  }

  // 已经存过「同地址 + 同模型」的档案时，直接进入编辑，避免列表里出现重复项
  if (config.url) {
    try {
      const existing = await store.listConnections();
      const match = existing.find(
        (item) =>
          normalizeBaseUrl(item.baseUrl) === normalizeBaseUrl(config.url) &&
          (item.model || '') === (config.model || ''),
      );
      if (match) {
        ui.openForm(match);
        toast('已存在相同地址与模型的配置，正在编辑');
        return;
      }
    } catch (err) {
      console.warn('[API 管家] 检查重复配置失败', err);
    }
  }

  const name =
    config.source === 'custom'
      ? `酒馆配置 · ${hostOf(config.url) || 'custom'}`
      : `酒馆配置 · ${config.source}`;

  ui.openForm({
    name,
    baseUrl: config.url,
    provider: config.source,
    model: config.model,
    secretRef: null,
  });
  toast('已读取酒馆当前配置，确认后保存');
};

/** 构造导出数据；withKeys=false 时抹掉明文 Key。 */
function buildExportPayload(withKeys) {
  const items = (loadSettings().items ?? []).map((item) => ({
    ...item,
    key: withKeys ? (item.key || '') : '',
  }));
  return {
    app: 'tauri-api-manager',
    version: VERSION,
    exportedAt: new Date().toISOString(),
    keysIncluded: !!withKeys,
    items,
  };
}

/** 导出本地配置为 JSON 文件（默认询问是否带明文 Key）。 */
ui.exportConfig = (options) => {
  const items = loadSettings().items ?? [];
  if (!items.length) {
    toast('没有可导出的配置');
    return;
  }

  let withKeys = options?.withKeys;
  if (withKeys === undefined) {
    // 两个选项都会导出：确定=带 Key，取消=脱敏（避免误点后什么都没发生）
    withKeys = typeof globalThis.confirm === 'function'
      ? globalThis.confirm('导出配置\n\n「确定」= 包含明文 Key，可完整迁移（请妥善保管）\n「取消」= 不含 Key，更安全')
      : false;
  }

  try {
    const payload = buildExportPayload(withKeys);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `API管家配置-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast(
      withKeys
        ? `已导出 ${items.length} 条配置（含明文 Key，请妥善保管）`
        : `已导出 ${items.length} 条配置（不含 Key）`,
    );
  } catch (err) {
    toast(`导出失败：${err?.message ?? err}`);
  }
};

const IMPORT_LIMIT = 500;
const textOf = (value, max) => String(value ?? '').trim().slice(0, max);

/** 选择 JSON 文件并恢复到 items。 */
ui.importConfig = async (event) => {
  const input = event?.target;
  const file = input?.files?.[0];
  if (input) input.value = '';
  if (!file) return;

  try {
    const rawText = await file.text();
    if (rawText.length > 2 * 1024 * 1024) throw new Error('文件过大（超过 2 MB）');
    const data = JSON.parse(rawText);
    const incoming = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : null;
    if (!incoming) throw new Error('文件里没有 items 数组');

    const settings = loadSettings();
    const map = new Map((settings.items ?? []).map((item) => [item.id, item]));
    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const raw of incoming.slice(0, IMPORT_LIMIT)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        skipped += 1;
        continue;
      }
      const baseUrl = normalizeBaseUrl(raw.baseUrl);
      if (baseUrl && !isHttpUrl(baseUrl)) {
        // 地址协议不是 http(s) 的条目直接丢弃，避免把 Key 交给奇怪的东西
        skipped += 1;
        continue;
      }
      const id = textOf(raw.id, 64) || makeId();
      const existing = map.get(id);
      const record = {
        id,
        name: textOf(raw.name, 120) || '未命名',
        baseUrl,
        provider: textOf(raw.provider, 60),
        model: textOf(raw.model, 120),
        // 脱敏导出里 key 为空：不要覆盖本地已有的 Key
        key: textOf(raw.key, 512) || existing?.key || '',
        secretRef:
          raw.secretRef && typeof raw.secretRef === 'object' && raw.secretRef.id
            ? { key: textOf(raw.secretRef.key, 80), id: textOf(raw.secretRef.id, 80) }
            : null,
        imported: true,
        updatedAt: Number(raw.updatedAt) || Date.now(),
      };
      if (map.has(id)) updated += 1;
      else added += 1;
      map.set(id, record);
    }

    const truncated = incoming.length > IMPORT_LIMIT;
    settings.items = [...map.values()];
    saveSettings();
    await renderConnections();
    const notes = [`已导入 ${added} 条、更新 ${updated} 条`];
    if (skipped) notes.push(`跳过 ${skipped} 条无效条目`);
    if (truncated) notes.push(`超出 ${IMPORT_LIMIT} 条上限，只处理前 ${IMPORT_LIMIT} 条`);
    toast(notes.join('；'));
  } catch (err) {
    toast(`导入失败：${err?.message ?? err}`);
  }
};

/** 测试成功后：填模型候选、猜提供商。 */
function applyDetected(item, result) {
  const models = result.models ?? [];
  if (!models.length) return;

  const datalist = $id('tam-models');
  datalist.textContent = '';
  for (const model of models) datalist.append(el('option', { value: model }));

  const modelInput = $id('tam-f-model');
  if (!modelInput.value.trim()) modelInput.value = models[0];

  // 测试成功的那条 URL（.../v1/models 或 .../models）反推可用的 Base URL，
  // 顺手把表单里的地址校正成它——这样酒馆拼 /chat/completions 时也不会错。
  if (result.url) {
    const working = result.url.replace(/\/models$/i, '');
    const urlInput = $id('tam-f-url');
    if (working && working !== normalizeBaseUrl(urlInput.value)) {
      urlInput.value = working;
    }
  }

  const guessed = inferProvider(item.baseUrl, models);
  if (guessed) {
    const providerSelect = $id('tam-f-provider');
    if (![...providerSelect.options].some((option) => option.value === guessed)) {
      providerSelect.append(el('option', { value: guessed }, guessed));
    }
    providerSelect.value = guessed;
    $id('tam-provider-hint').textContent = `已识别：${guessed}（${models.length} 个模型）`;
  }

  if (!$id('tam-f-name').value.trim()) {
    $id('tam-f-name').value = hostOf(item.baseUrl) || '新 API';
  }
}

ui.runTest = async () => {
  const button = $id('tam-f-test');
  const output = $id('tam-f-testresult');
  const item = readForm();

  if (!item.baseUrl) {
    output.textContent = '先填 Base URL';
    output.dataset.state = 'err';
    return;
  }
  if (!isHttpUrl(item.baseUrl)) {
    output.textContent = 'Base URL 必须以 http:// 或 https:// 开头';
    output.dataset.state = 'err';
    return;
  }

  // 编辑本地/导入条目时，测试连接同样会把 Key 发到该地址，先问一句
  if (editing && (editing.source === 'local' || editing.imported) && item.key) {
    const confirmed =
      globalThis.confirm?.(`测试连接会把 Key 发送到：${hostOf(item.baseUrl)}\n\n只有你信任这个地址时才继续。`) ?? true;
    if (!confirmed) {
      output.textContent = '已取消测试';
      output.dataset.state = '';
      return;
    }
  }

  button.disabled = true;
  output.textContent = '测试中…';
  output.dataset.state = 'pending';

  const result = await connTest.run(item);
  output.textContent = `${result.ok ? '✓ 可用' : '✗ 不可用'} · ${result.channel}：${result.message}`;
  output.dataset.state = result.ok ? 'ok' : 'err';
  if (result.ok) applyDetected(item, result);
  button.disabled = false;
};

ui.submitForm = async () => {
  if (hostGateActive()) {
    toast('宿主连接中，请稍后…');
    return;
  }

  const item = readForm();
  if (!item.name) {
    toast('名称不能为空');
    return;
  }
  if (!item.baseUrl && item.provider === 'custom') {
    toast('custom 源必须填 Base URL');
    return;
  }
  if (item.baseUrl && !isHttpUrl(item.baseUrl)) {
    toast('Base URL 必须以 http:// 或 https:// 开头');
    return;
  }

  const willConvert = !!item.baseUrl && item.provider !== 'custom';

  // 下拉里选了已保存的密钥：直接引用它，并把 Key 输入框内容清掉
  if (item.secretId) {
    item.secretRef = { key: `api_key_${sourceOf(item)}`, id: item.secretId };
    item.key = '';
  }

  const saveButton = $id('tam-f-save');
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = '保存中…';
  }

  let result;
  try {
    result = await store.saveConnection(item);
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = '保存';
    }
  }

  if (!result.ok) {
    toast(`保存失败：${result.error}`);
    return;
  }

  ui.closeForm();
  const notes = [];
  if (willConvert) notes.push('已按 custom 源保存');
  if (result.warnings?.length) notes.push(...result.warnings);
  if (result.source !== 'host') notes.push('写入本地（宿主 API 不可用）');

  // 保存后立即切换并发起连接，省掉再去酒馆设置里点「连接」
  const applied = await store.activate({
    id: result.id,
    name: item.name,
    baseUrl: item.baseUrl,
    provider: item.provider,
    model: item.model,
    secretRef: result.secretRef ?? item.secretRef ?? null,
    key: '',
    source: result.source,
  });

  if (applied.applied) {
    notes.push('已保存并切换');
  } else {
    notes.push(`已保存，但切换未完成：${applied.reason ?? '未知原因'}`);
  }
  toast(notes.join('；'));
  await renderConnections();
};

async function onActivate(connection) {
  const result = await store.activate(connection, { test: true });
  if (!result.applied) {
    toast(result.reason ?? '已记录为当前选择');
  } else if (result.test) {
    toast(
      result.test.ok
        ? `已切换并测试通过：${result.test.message}`
        : `已切换，但连接测试失败：${result.test.message}`,
    );
  } else {
    toast('已切换当前 API');
  }
  if (result.applied) ui.setActiveRow(connection.id);
}

async function onDelete(connection) {
  if (!confirm(`删除「${connection.name}」？`)) return;
  const result = await store.deleteConnection(connection);
  toast(result.ok ? '已删除' : `删除失败：${result.error}`);
  await renderConnections();
}

/* ---- toast ---- */
let toastTimer = null;
function toast(message) {
  if (!ui.root) {
    console.info('[API 管家]', message);
    return;
  }
  let node = $id('tam-toast');
  if (!node) {
    node = el('div', { id: 'tam-toast' });
    ui.root.append(node);
  }
  node.textContent = message;
  node.classList.add('tam-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('tam-show'), 2200);
}

/* ------------------------------------------------------------------ *
 * 8. 启动
 * ------------------------------------------------------------------ */

let hostWatchTimer = null;
/** waitReady 超时后的兜底：ABI 更晚注入时自动补上，不用刷新页面。 */
function watchHostLate() {
  if (hostWatchTimer || isHostReady) return;
  let tries = 0;
  hostWatchTimer = setInterval(() => {
    if (isHostReady) {
      clearInterval(hostWatchTimer);
      hostWatchTimer = null;
      return;
    }
    const tt = globalThis.__TAURITAVERN__;
    if (tt?.api) {
      clearInterval(hostWatchTimer);
      hostWatchTimer = null;
      isHostReady = true;
      ui.refreshHostBadge();
      void renderConnections();
      if (ui.currentTab === 'probe') renderProbe();
      toast('宿主已连接');
      return;
    }
    if (++tries >= 60) {
      clearInterval(hostWatchTimer);
      hostWatchTimer = null;
    }
  }, 500);
}

async function boot() {
  if (globalThis.__TAM_BOOTED__) return;
  globalThis.__TAM_BOOTED__ = true;

  buildUi();
  installFetchFailover();
  ui.setTab('connections');
  await renderConnections();
  void ctxInstallHooks();

  host.waitReady().then((tt) => {
    if (tt?.api) isHostReady = true;
    ui.refreshHostBadge();
    if (ui.currentTab === 'probe') renderProbe();
    console.info('[API 管家] 宿主探测完成', collectProbe());
    if (!isHostReady && (detectTauriRuntime() || globalThis.__TAURITAVERN__)) {
      watchHostLate();
    }
  });

  // 供调试与后续迭代使用
  globalThis.__TAM__ = {
    VERSION,
    collectProbe,
    store,
    settings: loadSettings,
    usage,
    ui,
    render: renderConnections,
    failover: maybeFailover,
    probe: probeCustomApiFormats,
    context: { render: renderContext, compress: ctxCompress, undo: ctxUndo, measure: ctxCountTotal },
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
} else {
  void boot();
}






















/* ===== mobile patch ===== */
/* 移动端运行时补丁 —— 由 build-mobile.ps1 追加到 index.js 末尾
 * 作用：把软键盘（visualViewport）遮挡的高度写进 --tam-keyboard，
 * 让悬浮窗和弹层自动抬到键盘上方。
 */
(function () {
  'use strict';

  const vv = window.visualViewport;
  if (!vv) return;

  let frame = 0;

  function apply() {
    frame = 0;
    const root = document.getElementById('tam-root');
    if (!root) return;
    const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    root.style.setProperty('--tam-keyboard', inset + 'px');
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(apply);
  }

  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', () => setTimeout(schedule, 200));
  window.addEventListener('focusin', schedule);
  window.addEventListener('focusout', schedule);
  schedule();
})();

