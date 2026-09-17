'use strict';
/* ============================================================
 * 哔哩朝花夕拾 - background (MV3 Service Worker)
 * 职责：数据与计算的唯一权威
 *   - 持有本地缓存（storage.local）
 *   - 通过注入页面主世界的 fetch 读取 B 站数据（凭据由浏览器自动携带）
 *   - 同步引擎（增量优先 + 全量兜底 + 断点续传）
 *   - “历史上的今天”匹配（支持调试用模拟日期）
 *   - 向 content 推送视图、响应 popup/options
 * ============================================================ */

importScripts('common.js');

/* ---------------- 内存态 ---------------- */
let loaded = false;
const mem = {
  meta: {}, folders: [], items: {}, settings: null,
  syncCursor: null,       // 断点游标（持久化于 KEY_SYNC）
  syncSession: null,      // 未完成会话：模式/范围/目标夹，跨 SW 重启保持
  pendingFull: false,     // 本次 refresh 强制全量
  pendingDailyRun: false, // 本次 refresh 来自“每天一次”自动触发（成功后记当日标记）
  pendingScope: 'all',    // 本次 refresh 的范围：'all' 全部 / 'created' 仅自建 / 'collected' 仅追更
  pendingManual: false,   // 用户在无 B 站标签时点了同步：待新开首页接续执行
  pendingFolderIds: null, // 上述待接续请求的自选收藏夹（若有）
  pendingFoldersOnly: false // 本次只刷新收藏夹列表（不扫内容）
};
const loginInfo = {
  mid: 0,
  ok: false,
  error: '',
  checkedAt: 0,    // 仅在拿到明确结论（已登录 / 明确未登录）时写入
  checking: false, // 登录检查飞行中：此时不得判定为“未登录”
  failedAt: 0      // 连接失败时间（非未登录），用于短 TTL 重试
};
const homeTabs = new Map();   // tabId -> lastSeen
let latestHomeTabId = null;
let refreshBusy = false;
let proxySeq = 0;
let flowCtx = null;           // 当前同步会话现场（进度展示用）
let flowNote = '';            // 人类可读的同步阶段（展示在浮层/弹窗，方便定位卡点）
let refreshAttempts = 0;      // 连续失败次数（用于自动重试上限）
let rateUntil = 0;            // 暂停/冷却截止时间（epoch ms），期间不发起新请求
let pauseReason = '';         // 本次暂停原因：'412' 风控 或 'quota' 单段配额
let pageBudgetUsed = 0;       // 本段已消耗的页数（配额控制）
let burstLimit = CFG.BURST_PAGES;   // 每段页数配额（设置页可调）
let forceSkipCooldown = false;      // 用户点击“立即同步”：跳过冷却直接开跑（接受再次被 412 的风险）
let cancelSync = false;             // 用户请求终止当前同步
let clearAfterSync = false;         // 同步停稳后清空全部数据
let loginCheckPromise = null;       // 登录检查 single-flight
let pendingAccountSwitch = null;    // 同步运行中发现换号：停稳后再原子清理旧账号资源
const RESUME_ALARM = 'dsh-sync-resume';
let viewPushTimer = null;

function schedulePushView() {
  clearTimeout(viewPushTimer);
  viewPushTimer = setTimeout(() => { viewPushTimer = null; pushView(); }, 120);
}

function setFlow(note) { flowNote = note; }

/* 设置页可配置的时长（毫秒）：读取 settings，异常/过小回退默认值 */
function settingMs(key, fallback) {
  const v = Number(mem.settings && mem.settings[key]);
  return (Number.isFinite(v) && v >= 1000) ? v : fallback;
}
/* 设置页可配置的整数（如每段页数配额） */
function settingNum(key, fallback) {
  const v = parseInt(mem.settings && mem.settings[key], 10);
  return (Number.isFinite(v) && v >= 1) ? v : fallback;
}

/* 冷却/暂停统一门面：内存镜像 + 持久化标记（meta.resumeAt 跨 SW 重启/关页存活） */
function coolingMs() {
  return Math.max(0, Math.max(rateUntil, mem.meta.resumeAt || 0) - Date.now());
}
async function holdUntil(ms, reason) {
  rateUntil = Date.now() + ms;
  mem.meta.resumeAt = rateUntil;
  mem.meta.resumeReason = reason;
  pauseReason = reason;
  await persistMeta();
  try { await chrome.alarms.create(RESUME_ALARM, { when: rateUntil + 1000 }); } catch (e) {}
}
async function clearHold() {
  rateUntil = 0;
  delete mem.meta.resumeAt;
  delete mem.meta.resumeReason;
  pauseReason = '';
  await persistMeta();
  try { await chrome.alarms.clear(RESUME_ALARM); } catch (e) {}
}

/* 仅当“发送者就是 B 站页面”（content 向导 / popup 恰好点在 B 站标签上）才复用；
   popup/options 的 sender.tab 可能指向无关页面，不能拿来注入取数 */
function pickSenderBiliTab(sender) {
  if (sender && sender.tab && /^https:\/\/[^/]*\.?bilibili\.com\//i.test(sender.tab.url || '')) {
    return { id: sender.tab.id };
  }
  return null;
}

/* 首次自选：仅保留勾选的收藏夹为启用，其余关闭 */
async function applyFolderSelection(ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  const sel = new Set(ids);
  let changed = false;
  for (const f of mem.folders) {
    const on = f.readable !== false && sel.has(f.mediaId);
    if ((f.enabled !== false) !== on) { f.enabled = on; changed = true; }
  }
  if (changed) await persistFolders();
  log('按自选启用收藏夹:', sel.size, '个');
}

/* ---------------- 基础 ---------------- */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(...a) {
  try { console.log('[哔哩朝花夕拾]', ...a); } catch (e) {}
}

async function ensureLoaded() {
  if (loaded) return;
  const o = await storageGet([CFG.KEY_META, CFG.KEY_FOLDERS, CFG.KEY_ITEMS, CFG.KEY_SETTINGS, CFG.KEY_SYNC]);
  mem.meta = (o[CFG.KEY_META] && typeof o[CFG.KEY_META] === 'object') ? o[CFG.KEY_META] : {};
  mem.folders = Array.isArray(o[CFG.KEY_FOLDERS]) ? o[CFG.KEY_FOLDERS] : [];
  mem.items = (o[CFG.KEY_ITEMS] && typeof o[CFG.KEY_ITEMS] === 'object') ? o[CFG.KEY_ITEMS] : {};
  mem.settings = Object.assign({}, CFG.DEFAULT_SETTINGS, o[CFG.KEY_SETTINGS] || {});
  const sy = o[CFG.KEY_SYNC] || {};
  mem.syncCursor = (sy.cursor && typeof sy.cursor === 'object') ? sy.cursor : null;
  mem.syncSession = (sy.session && typeof sy.session === 'object') ? sy.session : null;
  loaded = true;
  if ((mem.meta.resumeAt || 0) > Date.now()) {
    try { await chrome.alarms.create(RESUME_ALARM, { when: mem.meta.resumeAt + 1000 }); } catch (e) {}
  }
}

/* background 是 meta/folders/items/sync 的唯一写入者，不能在自己的 storage
   回调里用结构化克隆替换正在同步的对象引用。设置页仍直接保存独立的 settings，
   因此这里只接收 settings 的跨上下文变更。 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (CFG.KEY_SETTINGS in changes) {
    mem.settings = Object.assign({}, CFG.DEFAULT_SETTINGS, changes[CFG.KEY_SETTINGS].newValue || {});
    schedulePushView();
  }
});

function persistMeta() { return storageSet({ [CFG.KEY_META]: mem.meta }); }
function persistFolders() { return storageSet({ [CFG.KEY_FOLDERS]: mem.folders }); }
function persistItems() { return storageSet({ [CFG.KEY_ITEMS]: mem.items }); }
function syncStateValue() { return { cursor: mem.syncCursor || null, session: mem.syncSession || null }; }
function persistCursor(cursor) {
  mem.syncCursor = cursor || null;
  return storageSet({ [CFG.KEY_SYNC]: syncStateValue() });
}
function persistSession(session) {
  mem.syncSession = session || null;
  return storageSet({ [CFG.KEY_SYNC]: syncStateValue() });
}
/* items 与 cursor 同批提交：游标绝不能越过尚未落盘的数据页。 */
function persistCheckpoint(cursor) {
  mem.syncCursor = cursor || null;
  if (mem.syncSession) mem.syncSession.updatedAt = Date.now();
  return storageSet({
    [CFG.KEY_ITEMS]: mem.items,
    [CFG.KEY_SYNC]: syncStateValue()
  });
}
function clearSyncState() {
  mem.syncCursor = null;
  mem.syncSession = null;
  return storageSet({ [CFG.KEY_SYNC]: syncStateValue() });
}

function clearPendingRequests() {
  mem.pendingFull = false;
  mem.pendingDailyRun = false;
  mem.pendingScope = 'all';
  mem.pendingManual = false;
  mem.pendingFolderIds = null;
  mem.pendingFoldersOnly = false;
  delete mem.meta.pendingFoldersOnly;
  forceSkipCooldown = false;
}

async function resetAllData() {
  try { await chrome.alarms.clear(RESUME_ALARM); } catch (e) {}
  await chrome.storage.local.remove([
    CFG.KEY_META, CFG.KEY_FOLDERS, CFG.KEY_ITEMS, CFG.KEY_SYNC, CFG.KEY_SETTINGS
  ]);
  mem.meta = {};
  mem.folders = [];
  mem.items = {};
  mem.settings = Object.assign({}, CFG.DEFAULT_SETTINGS);
  mem.syncCursor = null;
  mem.syncSession = null;
  clearPendingRequests();
  pendingAccountSwitch = null;
  loginInfo.mid = 0;
  loginInfo.ok = false;
  loginInfo.error = '';
  loginInfo.checkedAt = 0;
  loginInfo.failedAt = 0;
  rateUntil = 0;
  pauseReason = '';
  flowCtx = null;
  setFlow('本地数据已清空');
}

/* 换号只清“账号资源”，完整保留用户设置。meta.mid 表示当前缓存归属，
   因此明确退出登录时也不能把它清零，否则下次登录无法判断是否换号。 */
async function resetForAccountSwitch(newMid) {
  const mid = Number(newMid) || 0;
  if (!mid) return false;
  try { await chrome.alarms.clear(RESUME_ALARM); } catch (e) {}

  const nextMeta = {
    mid,
    accountChangedAt: Date.now(),
    firstSetupReason: 'accountChanged'
  };
  // 同批替换四类账号数据：不能先 remove 再逐项写，避免中途留下半清状态。
  await storageSet({
    [CFG.KEY_META]: nextMeta,
    [CFG.KEY_FOLDERS]: [],
    [CFG.KEY_ITEMS]: {},
    [CFG.KEY_SYNC]: { cursor: null, session: null }
  });

  mem.meta = nextMeta;
  mem.folders = [];
  mem.items = {};
  mem.syncCursor = null;
  mem.syncSession = null;
  clearPendingRequests();
  cancelSync = false;
  rateUntil = 0;
  pauseReason = '';
  pageBudgetUsed = 0;
  refreshAttempts = 0;
  flowCtx = null;
  setFlow('检测到 B 站账号切换，旧账号收藏数据已清理，请重新选择收藏夹');
  log('检测到账号切换：已清理旧账号资源并保留设置，新 mid =', mid);
  return true;
}

async function acceptAuthenticatedMid(newMid) {
  const mid = Number(newMid) || 0;
  const oldMid = Number(mem.meta.mid) || 0;
  if (!mid) return { accountChanged: false };
  if (!oldMid) {
    mem.meta.mid = mid;
    await persistMeta();
    return { accountChanged: false, firstAccount: true };
  }
  if (oldMid === mid) return { accountChanged: false };

  if (refreshBusy) {
    pendingAccountSwitch = { mid, oldMid, detectedAt: Date.now() };
    cancelSync = true;
    setFlow('检测到 B 站账号切换，正在停止旧账号同步…');
    return { accountChanged: true, deferred: true };
  }
  await resetForAccountSwitch(mid);
  return { accountChanged: true, deferred: false };
}

async function finishPendingAccountSwitch() {
  if (!pendingAccountSwitch) return false;
  const pending = pendingAccountSwitch;
  pendingAccountSwitch = null;
  await resetForAccountSwitch(pending.mid);
  // runRefresh 内发现换号时，原 HOME_OPEN 已经结束；主动预取新账号夹列表，
  // 让首页能直接重新展示首次选择向导。
  if (latestHomeTabId && loginInfo.ok) {
    try {
      await ensureFolderList(true);
    } catch (err) {
      if (err && err.kind === 'RATE') {
        const wait = settingMs('rateWaitMs', CFG.RATE_412_WAIT_MS);
        await holdUntil(wait, '412');
        setFlow('新账号收藏夹触发风控，冷却后可重新打开首页继续');
      } else {
        log('换号后预取收藏夹失败:', err);
      }
    }
  }
  return true;
}

/* 参与同步/匹配的收藏夹：仅看用户开关；不可读的夹仍每轮重试（成功即恢复） */
function enabledFolders() { return mem.folders.filter(f => f.enabled !== false); }

function customSyncDue(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const lastSyncMs = (Number(mem.meta.lastSyncAt) || 0) * 1000;
  return !lastSyncMs || (now - lastSyncMs) >= customSyncDaysFor(mem.settings) * 24 * 60 * 60 * 1000;
}

/* ---------------- 请求代理（在页面主世界执行 fetch） ----------------
 * 注意：不能直接在 content script 隔离世界里 fetch —— Chrome 对隔离世界的
 * 跨源凭据请求与页面主世界行为不同（主世界 = 你在控制台手动验证 CORS 的环境）。
 * 因此通过 chrome.scripting 注入到页面 MAIN world 执行，与 B 站自身请求一致。
 * 扩展自身不读取、不存储任何 Cookie，凭据由浏览器自动携带。
 */
/* 该函数会被序列化注入 MAIN world 执行，必须自包含 */
function mainFetch(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 20000);
  return fetch(url, { credentials: 'include', signal: controller.signal })
    .then(async r => {
      let json = null;
      try { json = await r.json(); } catch (e) { json = null; }
      return { ok: r.ok, status: r.status, json };
    })
    .catch(err => ({
      ok: false,
      error: err && err.name === 'AbortError' ? 'TIMEOUT' : String((err && err.message) || err)
    }))
    .finally(() => clearTimeout(timer));
}

function contentProxyFetch(url) {
  return new Promise(resolve => {
    const tabId = latestHomeTabId;
    if (!tabId) { resolve({ ok: false, error: 'NO_HOME_TAB' }); return; }
    const reqId = ++proxySeq;
    let done = false;
    const finish = res => { if (!done) { done = true; clearTimeout(timer); resolve(res); } };
    const timer = setTimeout(() => finish({ ok: false, error: 'TIMEOUT' }), CFG.PROXY_TIMEOUT_MS);
    chrome.tabs.sendMessage(tabId, { type: MSG.FETCH_URL, reqId, url })
      .then(res => finish(res || { ok: false, error: 'EMPTY_RESP' }))
      .catch(e => finish({ ok: false, error: String((e && e.message) || e) }));
  });
}

async function proxyFetch(url) {
  // 自动“标签自愈”：代发目标失效（标签被关/导航/权限异常）时，自动改绑到当前可用的 B 站标签再试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    let tabId = latestHomeTabId;
    if (!tabId) {
      const t = await findHomeTab();
      if (!t) return { ok: false, error: 'NO_HOME_TAB' };
      latestHomeTabId = t.id;
      homeTabs.set(t.id, Date.now());
      tabId = t.id;
    }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: mainFetch,
        args: [url, CFG.PROXY_TIMEOUT_MS]
      });
      const r = results && results[0] && results[0].result;
      if (r) return r;   // { ok, status, json } 或 { ok:false, error }
      return { ok: false, error: 'EMPTY_INJECT' };
    } catch (e) {
      const msg = String((e && e.message) || e);
      const stale = /Receiving end|Could not establish|Cannot access|No tab|not found|document not|cannot be accessed/i.test(msg);
      if (stale && attempt === 0) {
        const t = await findHomeTab();
        if (t && t.id !== tabId) {
          latestHomeTabId = t.id;
          homeTabs.set(t.id, Date.now());
          log('同步标签失效，已改绑到可用标签', t.id);
          continue;
        }
      }
      // 注入失败（受限页面/权限异常等）→ 回退 content script 代发
      return contentProxyFetch(url);
    }
  }
  return { ok: false, error: 'PROXY_REBIND_FAILED' };
}

/* ---------------- 登录态 ----------------
   规则（修复“把连不上当成未登录”与“检查飞行中被判未登录”）：
   - 只有拿到明确结论才写 checkedAt：已登录 或 明确未登录；
   - 连接失败只记 error + failedAt，保持“未知”，绝不当成未登录，也不清 meta.mid；
   - checking 期间 buildView 不判定为未登录（有 mid 时按已登录兜底）；
   - 成功后缓存 10 分钟；未确认/未登录只短缓存 30 秒，便于自动恢复。 */
async function refreshLogin(force) {
  const now = Date.now();
  if (loginCheckPromise) return loginCheckPromise; // 所有调用者等待同一次检查，不能读取旧结论
  if (!force) {
    const last = Math.max(loginInfo.checkedAt || 0, loginInfo.failedAt || 0);
    const ttl = loginInfo.ok ? CFG.NAV_REFRESH_MS : CFG.NAV_FAIL_RETRY_MS;
    if (last && (now - last) < ttl) return;
  }
  const task = (async () => {
    loginInfo.checking = true;
    setFlow('正在检查登录状态…');
    let res = null;
    try {
      res = await proxyFetch(CFG.API.NAV);
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }

    if (!res || !res.ok) {
      // 连接失败（注入失败/超时/找不到标签）：不是未登录 —— 不写 checkedAt、不清 mid
      loginInfo.ok = false;
      loginInfo.checkedAt = 0;
      loginInfo.error = (res && res.error === 'NO_HOME_TAB')
        ? '未找到可用的哔哩哔哩页面标签'
        : ('请求失败: ' + ((res && (res.error || res.status)) || '未知错误'));
      loginInfo.failedAt = Date.now();
      setFlow('无法连接 B 站接口：' + loginInfo.error);
      log('登录检查失败（按“未知”处理，不算未登录）：', loginInfo.error);
      return;
    }
    const j = res.json || {};
    if (j.code === 0 && j.data && j.data.isLogin === true) {
      loginInfo.ok = true; loginInfo.mid = j.data.mid || 0; loginInfo.error = '';
      loginInfo.checkedAt = Date.now(); loginInfo.failedAt = 0;
      const identity = await acceptAuthenticatedMid(loginInfo.mid);
      if (!identity.accountChanged) setFlow('已登录，准备读取收藏夹…');
      return Object.assign({ state: 'ok', mid: loginInfo.mid }, identity);
    } else if (j.code === -101 || (j.code === 0 && j.data && j.data.isLogin === false)) {
      // 明确退出只改变运行时登录态；meta.mid 是本地缓存归属，必须保留，
      // 才能在之后登录另一个账号时可靠识别换号。
      loginInfo.ok = false; loginInfo.mid = 0; loginInfo.error = '';
      loginInfo.checkedAt = Date.now(); loginInfo.failedAt = 0;
      setFlow('未登录哔哩哔哩');
      return { state: 'no' };
    } else {
      loginInfo.ok = false;
      loginInfo.checkedAt = 0;
      loginInfo.error = '登录接口返回异常: code=' + (j.code == null ? '未知' : j.code) +
        (j.message ? ' ' + j.message : '');
      loginInfo.failedAt = Date.now();
      setFlow('无法确认登录状态：' + loginInfo.error);
      log('登录检查返回非明确结论（按“未知”处理）：', loginInfo.error);
      return { state: 'unknown' };
    }
  })();
  loginCheckPromise = task;
  try {
    return await task;
  } finally {
    loginInfo.checking = false;
    if (loginCheckPromise === task) loginCheckPromise = null;
  }
}

/* ---------------- 收藏夹列表 ---------------- */
async function ensureFolderList(force) {
  const need =
    force ||
    mem.folders.length === 0 ||
    !mem.meta.foldersSyncedAt ||
    (Date.now() - mem.meta.foldersSyncedAt * 1000) > CFG.FOLDER_LIST_REFRESH_MS;
  if (!need) return true;

  setFlow('正在读取收藏夹列表…');
  const mid = loginInfo.mid || mem.meta.mid || 0;
  if (!mid) { setFlow('缺少用户 mid，无法读取收藏夹'); log('ensureFolderList: mid 缺失'); return false; }

  const api = 'https://api.bilibili.com/x/v3/fav/folder';
  const byId = new Map(mem.folders.map(f => [f.mediaId, f]));
  const next = [];
  const results = [];
  let failCount = 0;

  const pushRow = (raw, source) => {
    const mediaId = raw.id != null ? raw.id : raw.fid;
    if (mediaId == null) return;
    const old = byId.get(mediaId);
    next.push({
      mediaId,
      fid: raw.fid != null ? raw.fid : mediaId,
      mid: raw.mid,
      title: raw.title || '(未命名收藏夹)',
      cover: raw.cover || '',
      source,
      mediaCount: raw.media_count != null ? raw.media_count : 0,
      attr: raw.attr != null ? raw.attr : 0,
      enabled: old ? (old.enabled !== false) : true,
      readable: old ? (old.readable !== false) : true,
      lastSyncAt: old ? (old.lastSyncAt || 0) : 0,
      // 差异检测基线随重建一并保留（否则每轮刷新列表都会清零导致无限重复补齐）
      diffIds: old ? old.diffIds : undefined,
      diffLocal: old ? old.diffLocal : undefined,
      diffMedia: old ? old.diffMedia : undefined,
      diffFingerprint: old ? old.diffFingerprint : undefined,
      diffCheckedAt: old ? old.diffCheckedAt : undefined,
      // 稳定快通道标记（随重建保留）：diffGhost=官方数多出的部分是占位（本地已齐）；
      // diffCapped=ids 触顶、决策只看官方总数/本地。二者为 true 且三值基线未变时，
      // 连 ids 探测都可跳过（真正近零请求），无需每轮打探测。
      diffGhost: old ? old.diffGhost : undefined,
      diffCapped: old ? old.diffCapped : undefined
    });
  };

  // 1) 我创建的收藏夹（实测：必须带 up_mid=<自己的mid>，否则 -400）
  {
    const url = api + '/created/list-all?up_mid=' + mid;
    const res = await proxyFetch(url);
    const j = res.json || {};
    if (res.status === 412 || j.code === -412) {
      log('收藏夹[created] HTTP412（风控），进入冷却');
      throw Object.assign(new Error('rate 412'), { kind: 'RATE' });
    }
    if (res.ok && j.code === 0 && j.data && Array.isArray(j.data.list)) {
      for (const raw of j.data.list) pushRow(raw, 'created');
      results.push('created');
    } else {
      failCount++;
      log('收藏夹[created] 失败:', url, '=>',
        res.ok ? ('code=' + j.code + ' ' + (j.message || '')) : (res.error || ('HTTP ' + res.status)));
    }
  }

  // 2) 我收藏的收藏夹（实测：新路径 collected/list，需分页 up_mid+pn+ps+platform=web）
  {
    let pn = 1;
    const ps = 20;
    let total = null;
    let fetched = 0;
    let collectedComplete = false;
    while (pn <= 200) {
      const url = api + '/collected/list?up_mid=' + mid + '&pn=' + pn + '&ps=' + ps + '&platform=web';
      const res = await proxyFetch(url);
      const j = res.json || {};
      if (res.status === 412 || j.code === -412) {
        // 风控：中止本轮并进入冷却，避免硬刷分页把 412 拖得更久
        log('收藏夹[collected] HTTP412（风控），进入冷却（已拉', fetched, '条）');
        throw Object.assign(new Error('rate 412'), { kind: 'RATE' });
      }
      if (!(res.ok && j.code === 0 && j.data && Array.isArray(j.data.list))) {
        log('收藏夹[collected] 第 ' + pn + ' 页失败:', url, '=>',
          res.ok ? ('code=' + j.code + ' ' + (j.message || '')) : (res.error || ('HTTP ' + res.status)));
        break;
      }
      if (total == null) total = (j.data.count != null) ? j.data.count : 0;
      const list = j.data.list;
      for (const raw of list) pushRow(raw, 'collected');
      fetched += list.length;
      results.push('collected@pn' + pn);
      const hasMore = !!j.data.has_more;
      pn++;
      if (!hasMore || list.length === 0 || (total != null && fetched >= total)) {
        collectedComplete = true;
        break;
      }
      await sleep(CFG.PAGE_GAP_MS);
    }
    if (!collectedComplete) {
      failCount++;
      if (pn > 200) log('收藏夹[collected] 分页触顶 pn=200（已拉', fetched, '条），拒绝提交残缺列表');
    }
  }

  if (failCount === 0) {
    mem.folders = next;
    mem.meta.foldersSyncedAt = Date.now() / 1000;
    await persistFolders(); await persistMeta();
    setFlow('共 ' + mem.folders.length + ' 个收藏夹');
    log('收藏夹列表拉取成功:', mem.folders.length, '个 | 来源:', results.join(', '));
    return true;
  } else if (mem.folders.length === 0) {
    setFlow('收藏夹列表拉取失败，将自动重试');
    log('收藏夹列表拉取失败（无本地缓存）');
  } else {
    setFlow('收藏夹列表刷新失败，沿用本地缓存');
    log('收藏夹列表刷新失败，沿用旧列表');
  }
  return false;
}

/* ---------------- 同步引擎 ---------------- */
function needFullCycle() {
  if (mem.pendingFull) return true;          // 手动全量 / 首次向导全量
  if (!mem.meta.lastFullSyncAt) return true; // 初次（从未全量过）
  return false;                               // 不再按固定周期自动全量
}

function idKeyOf(m) {
  if (!m) return '';
  if (m.bvid) return String(m.bvid);
  return m.id != null ? ('a' + m.id) : '';
}

function mergeMedia(folderId, m) {
  if (!m || (m.type !== undefined && m.type !== 2)) return null; // 只存视频稿件
  const key = idKeyOf(m);
  if (!key) return null;
  const aidKey = m.id != null ? ('a' + m.id) : '';
  const old = mem.items[key] || (aidKey && mem.items[aidKey]);
  if (aidKey && aidKey !== key && mem.items[aidKey]) delete mem.items[aidKey];
  const item = {
    aid: m.id,
    bvid: m.bvid || '',
    type: 2,
    title: (m.title && String(m.title).trim()) || '(无标题)',
    cover: m.cover || '',
    upperName: (m.upper && m.upper.name) || '',
    upperMid: (m.upper && m.upper.mid) || 0,
    pubtime: m.pubtime || m.pubdate || m.ctime || 0,
    favTime: m.fav_time || 0,
    attr: (m.attr != null ? m.attr : 0),
    folderIds: old && Array.isArray(old.folderIds) ? old.folderIds.slice() : []
  };
  if (!item.folderIds.includes(folderId)) item.folderIds.push(folderId);
  mem.items[key] = item;
  return key;
}

async function syncOneFolder(folder, opts) {
  const full = !!opts.full;
  const startPn = opts.startPn || 1;   // 本次调用起始页（断点续传时>1），供清理安全判断用
  let pn = startPn;
  const mediaId = folder.mediaId;

  // 增量停止用：本夹在本次同步前已知的键集合
  const preKnown = new Set();
  if (!full) {
    for (const k of Object.keys(mem.items)) {
      const it = mem.items[k];
      if (it.folderIds && it.folderIds.includes(mediaId)) preKnown.add(k);
    }
  }
  const seen = new Set();
  // 断点/中断恢复（PAUSE/412/重试/SW 被杀后游标仍在）：把此前各段累积的
  // accumSeen 并回 seen —— 保证“多段全量收敛”在完成段做清理时，不会把前几段
  // 已确认过的条目误判为“已不在夹中”而删除（曾导致大夹收敛后本地被截断）。
  // resumeAccSeen 同时作为“本段 seen 是否覆盖了夹的开头部分”的依据：
  // 续传段若无前段累积（旧版本游标），宁可跳过清理也不误删。
  let resumeAccSeen = null;
  if (full && mem.syncCursor && mem.syncCursor.mediaId === mediaId &&
      Array.isArray(mem.syncCursor.accumSeen) &&
      (Date.now() - (mem.syncCursor.updatedAt || 0)) < CFG.CURSOR_TTL_MS) {
    resumeAccSeen = mem.syncCursor.accumSeen;
    for (const k of resumeAccSeen) seen.add(k);
  }
  let pages = 0;
  let apiFailed = false;
  let currentCursor = (full && mem.syncCursor && mem.syncCursor.mediaId === mediaId)
    ? mem.syncCursor : null;

  try {
    while (true) {
      if (cancelSync) throw Object.assign(new Error('cancel'), { kind: 'STOP' });
      if (pageBudgetUsed >= burstLimit) {
        log('单段配额用完（', pageBudgetUsed, ' 页），暂停本轮');
        throw Object.assign(new Error('burst quota'), { kind: 'PAUSE' });
      }
      // 实测(2026-09)：resource/list 不能带 platform=web（会返回 HTTP 412），故不带
      const url = CFG.API.MEDIA_LIST + '?media_id=' + encodeURIComponent(mediaId) +
        '&pn=' + pn + '&ps=' + CFG.PAGE_SIZE;
      let j = null;
      let apiFail = false;
      for (let attempt = 0; attempt <= CFG.MAX_RETRY; attempt++) {
        if (attempt > 0) await sleep(1500 + attempt * 1500);
        const res = await proxyFetch(url);
        if (!res.ok) {
          if (res.status === 412) {
            log('夹页 HTTP 412（风控），进入冷却', url);
            throw Object.assign(new Error('rate 412'), { kind: 'RATE' });
          }
          log('夹页请求失败 (attempt ' + attempt + ')', url, '=>', res.error || ('HTTP ' + res.status));
          continue;
        }
        const jj = res.json || {};
        if (jj.code === -101) throw Object.assign(new Error('login'), { kind: 'LOGIN' });
        if (jj.code === -412) {
          log('夹页 code=-412（风控），进入冷却', url);
          throw Object.assign(new Error('rate -412'), { kind: 'RATE' });
        }
        if (jj.code === -403 || jj.code === -404 || jj.code === -400) { apiFail = true; break; }
        if (jj.code !== 0 || !jj.data) {
          log('夹页返回异常 (attempt ' + attempt + ')', url, '=> code=' + jj.code, (jj.message || ''));
          continue;
        }
        j = jj;
        break;
      }
      if (apiFail) { apiFailed = true; break; }
      if (!j) {
        log('夹页连续失败，挂起本轮（游标已存）', url);
        throw Object.assign(new Error('resource/list 多次失败: ' + url), { kind: 'RETRY_LATER' });
      }
      const medias = j.data.medias || [];
      for (const m of medias) {
        const k = mergeMedia(mediaId, m);
        if (k) seen.add(k);
      }
      pages++;
      pageBudgetUsed++;
      pn++;
      // 跨段累积已确认 keys（仅全量；增量到已知边界即停，无需跨段记忆）：
      // 断点/中断/被杀后，完成段的清理基于各段全集，不会误删前段条目。
      // 注意：只有全量扫描才写游标——增量模式（full=false）几页内到已知边界即停，
      // 不需要断点；若在跑别的夹的中断续传时让增量覆盖/清空游标，会丢掉续传点。
      if (full) {
        const cur = {
          updatedAt: Date.now(), mediaId, pn, full,
          sessionFull: !!(mem.syncSession && mem.syncSession.full)
        };
        cur.accumSeen = Array.from(seen);
        currentCursor = cur;
        mem.syncCursor = cur;
        // 周期检查点把条目和游标放在同一个 storage.set 中；若 SW 在检查点之间
        // 被回收，恢复时只会重拉少量页，不会越过尚未落盘的数据。
        if (pages % CFG.CHECKPOINT_PAGES === 0 || !j.data.has_more) {
          await persistCheckpoint(cur);
        }
      }
      // 长收藏夹：每 8 页推一次进度，避免看起来卡住
      if (pages % 8 === 0) {
        setFlow('同步中 ' + (flowCtx && flowCtx.folderIndex != null ? flowCtx.folderIndex : '?') + '/' +
          (flowCtx && flowCtx.folderTotal != null ? flowCtx.folderTotal : '?') +
          '：「' + folder.title + '」第 ' + pn + ' 页');
        pushView();
      }
      const hasMore = !!j.data.has_more;
      if (!hasMore) break;
      if (!full && medias.some(m => preKnown.has(idKeyOf(m)))) break; // 已到已知边界
      await sleep(CFG.PAGE_GAP_MS + Math.floor(Math.random() * 150)); // 随机抖动，避免节奏太规整
      if (pages % 25 === 0) await sleep(1500);                        // 每 25 页缓一口气，降低风控概率
    }
  } finally {
    flowCtx = null;
    // 正常结束、配额暂停和可捕获异常都提交最后一批；强杀 SW 时则回退到上个原子检查点。
    if (full && currentCursor) await persistCheckpoint(currentCursor);
    else await persistItems();
  }

  if (apiFailed) {
    folder.readable = false;
    folder.error = '该收藏夹暂不可读（可能为私密夹）';
    folder.lastSyncAt = Date.now() / 1000;
    await persistFolders();
    return { complete: false, unreadable: true };
  }

  // 全量完成后清理：把已不在该夹的条目摘除该夹
  // 安全前提：本段 seen 覆盖了夹的开头（从 pn=1 起扫，或续传且带前段 accumSeen）；
  // 否则跳过清理（残留交由未来某轮从头开始的全量/差异处理），避免误删前段条目。
  if (full && (startPn <= 1 || resumeAccSeen != null)) {
    const toDelete = [];
    for (const k of Object.keys(mem.items)) {
      const it = mem.items[k];
      if (!it.folderIds) continue;
      if (it.folderIds.includes(mediaId) && !seen.has(k)) {
        it.folderIds = it.folderIds.filter(id => id !== mediaId);
        if (it.folderIds.length === 0) toDelete.push(k);
      }
    }
    for (const k of toDelete) delete mem.items[k];
    await persistItems();
  }

  folder.readable = true;
  folder.error = '';
  folder.lastSyncAt = Date.now() / 1000;
  await persistFolders();
  log('夹同步完成:', folder.title, '| 页数:', pages, '|', full ? '全量' : '增量');
  return { complete: true };
}

/* 增量模式：差异检测 + 针对性补齐（不做全量普查）
   快判：本地数 == 官方 media_count 且 24 小时内核对过 ID → 零请求跳过；
   否则 ids 精核（滤非视频）。仅当满足下面两点才针对性全量：
     a) 本地 != 官方视频数；
     b) 相对上次“稳定基线”（ids 视频数 / 本地数 / 官方总数 三者快照）有变化。
   官方存在 resource/list 拉不到的占位条目（幽灵）时，差值恒定会被基线吸收，
   不再每轮重复全量；任一数值变化（真实新增/删除）才触发补齐。 */
function countFolderLocal(mediaId) {
  let n = 0;
  for (const k of Object.keys(mem.items)) {
    const it = mem.items[k];
    if (it.folderIds && it.folderIds.includes(mediaId)) n++;
  }
  return n;
}

function folderAidSet(mediaId) {
  const out = new Set();
  for (const k of Object.keys(mem.items)) {
    const it = mem.items[k];
    if (it.folderIds && it.folderIds.includes(mediaId) && it.aid != null) out.add(String(it.aid));
  }
  return out;
}

/* 稳定、轻量的 32 位 FNV-1a 指纹；只用于变化检测，不承担安全用途。 */
function fingerprintIds(ids) {
  const sorted = ids.map(String).sort();
  let h = 0x811c9dc5;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 124;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + ':' + sorted.length;
}

async function markSessionFolderComplete(mediaId) {
  if (!mem.syncSession) return;
  const done = new Set(Array.isArray(mem.syncSession.completedFolderIds)
    ? mem.syncSession.completedFolderIds : []);
  done.add(mediaId);
  mem.syncSession.completedFolderIds = Array.from(done);
  mem.syncSession.updatedAt = Date.now();
  await persistSession(mem.syncSession);
}

async function markSessionFolderSkipped(mediaId) {
  if (!mem.syncSession) return;
  const skipped = new Set(Array.isArray(mem.syncSession.skippedFolderIds)
    ? mem.syncSession.skippedFolderIds : []);
  skipped.add(mediaId);
  mem.syncSession.skippedFolderIds = Array.from(skipped);
  mem.syncSession.updatedAt = Date.now();
  await persistSession(mem.syncSession);
}

/* 若游标属于该夹则清空（该夹已被确认完成/无需再续传）。用于“无动作”路径：
   避免游标残留导致后续每次会话都跳跃到同一夹、且它前面的夹被跳过。 */
function clearOwnCursorIf(folder) {
  if (mem.syncCursor && mem.syncCursor.mediaId === folder.mediaId) return persistCursor(null);
  return null;
}

/* 统一同步会话：逐夹保证本地与官方一致。
   forceFull=true  → “全量周期”（首次同步 / 手动全量重同步）：
                     每个启用夹都全量扫描一遍；断点续传会延续全量直到会话结束。
   forceFull=false → “差异会话”（日常增量同步）：一致的夹零请求跳过；不一致的夹
                     增量补新 / 全量清理；若上次中断留下某夹的 full 游标（如触顶
                     大夹首次收敛被打断），先跳跃到该夹续扫，再继续处理其后各夹。
   两种模式共用同一套：断点定位、游标管理（只清本夹）、进度/基线落盘。 */
async function runSyncPass(folders, forceFull) {
  const total = folders.length;
  if (!total) return;

  // 本地各夹条目计数（items 仅存 type=2 视频，membership 唯一）
  const localCount = new Map();
  for (const k of Object.keys(mem.items)) {
    const it = mem.items[k];
    if (!it.folderIds) continue;
    for (const id of it.folderIds) localCount.set(id, (localCount.get(id) || 0) + 1);
  }

  // 断点定位：上次中断（PAUSE/412/重试）残留的游标指向某夹的扫描进度。
  // 只认 full 游标（增量不写游标）；目标夹仍在本次列表才续起，否则丢弃。
  let resume = null;
  if (mem.syncCursor && mem.syncCursor.mediaId && mem.syncCursor.full === true) {
    const age = Date.now() - (mem.syncCursor.updatedAt || 0);
    if (age < CFG.CURSOR_TTL_MS) {
      const pos = folders.findIndex(f => f.mediaId === mem.syncCursor.mediaId);
      if (pos >= 0) resume = mem.syncCursor;
    }
  }
  if (!resume && mem.syncCursor) await persistCursor(null);   // 游标失效/不在列表：丢弃
  const sessionFull = mem.syncSession ? !!mem.syncSession.full : forceFull;
  if (resume) {
    const rf = folders.find(f => f.mediaId === resume.mediaId);
    log('同步会话将续传中断夹：', (rf && rf.title) || resume.mediaId, '（pn=' + (resume.pn || 1) + '）');
  }

  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    if (cancelSync) throw Object.assign(new Error('cancel'), { kind: 'STOP' });
    const idx = i + 1;
    const isResumeFolder = !!(resume && resume.mediaId === folder.mediaId);
    if (!isResumeFolder && sessionFull && mem.syncSession &&
        Array.isArray(mem.syncSession.completedFolderIds) &&
        mem.syncSession.completedFolderIds.includes(folder.mediaId)) continue;

    // —— 全量周期：每夹直接全量扫（中断夹从游标 pn 续扫）——
    if (sessionFull) {
      const startPn = isResumeFolder && resume && resume.pn ? resume.pn : 1;
      log('开始同步夹:', idx + '/' + total, folder.title, '(' + folder.mediaId + ') 全量');
      flowCtx = { folderTitle: folder.title, folderIndex: idx, folderTotal: total, phase: '全量' };
      setFlow(`同步中 ${idx}/${total}：「${folder.title}」`);
      const outcome = await syncOneFolder(folder, { full: true, sessionFull, startPn });
      // 只清“属于本夹”的游标：本夹已完成；别的夹（若有）的断点保留。
      await clearOwnCursorIf(folder);
      if (outcome && outcome.unreadable) {
        await markSessionFolderSkipped(folder.mediaId);
        await markSessionFolderComplete(folder.mediaId);
        resume = null;
        continue;
      }
      // 全量扫描完成即记录基线，防止下一轮差异检测把刚收敛的幽灵/触顶大夹
      // （local<mediaCount）误判为“首次收敛”再白跑一轮全量。
      folder.diffLocal = countFolderLocal(folder.mediaId);
      folder.diffMedia = folder.mediaCount || 0;
      folder.diffCheckedAt = Date.now();
      await persistFolders();
      await markSessionFolderComplete(folder.mediaId);
      pushView();
      resume = null;
      if (!latestHomeTabId) {
        throw Object.assign(new Error('B 站页面已关闭'), { kind: 'RETRY_LATER' });
      }
      continue;
    }

    // 差异会话里若某夹的“针对性全量”曾被打断，必须先从游标继续完成该夹，
    // 不能重新走计数快判后把断点清掉。
    if (isResumeFolder && resume && resume.full) {
      const startPn = resume.pn || 1;
      flowCtx = { folderTitle: folder.title, folderIndex: idx, folderTotal: total, phase: '续传全量清理' };
      setFlow(`续传差异补全 ${idx}/${total}：「${folder.title}」`);
      const outcome = await syncOneFolder(folder, { full: true, startPn });
      await clearOwnCursorIf(folder);
      if (outcome && outcome.unreadable) {
        await markSessionFolderSkipped(folder.mediaId);
        resume = null;
        continue;
      }
      folder.diffLocal = countFolderLocal(folder.mediaId);
      folder.diffMedia = folder.mediaCount || 0;
      folder.diffCheckedAt = Date.now();
      await persistFolders();
      await markSessionFolderComplete(folder.mediaId);
      resume = null;
      pushView();
      continue;
    }

    // —— 差异会话：先零请求快判，必要时 ids 精核 ——
    const local = localCount.get(folder.mediaId) || 0;
    flowCtx = { folderTitle: folder.title, folderIndex: idx, folderTotal: total, phase: '差异检测' };
    setFlow(`差异检测 ${idx}/${total}：「${folder.title}」`);

    const equalCountProbeDue = !folder.diffCheckedAt ||
      (Date.now() - folder.diffCheckedAt) >= CFG.DIFF_ID_PROBE_MS;
    if (folder.readable !== false && local === (folder.mediaCount || 0) && !equalCountProbeDue) {
      await clearOwnCursorIf(folder);
      folder.lastSyncAt = Date.now() / 1000;   // 无差异：不打任何接口
      continue;
    }

    // 快通道：上次核对已确认差异本质（幽灵占位=diffGhost / ids 触顶=diffCapped），
    // 且官方总数、本地数均未变 → 无需再打 ids 探测（真正近零请求）。
    // 即便数量稳定也会按 DIFF_ID_PROBE_MS 低频复核，避免“删一加一”永久漏同步。
    const mNow = folder.mediaCount || 0;
    if (!equalCountProbeDue && folder.readable !== false &&
        (folder.diffGhost === true || folder.diffCapped === true) &&
        folder.diffLocal === local && folder.diffMedia === mNow) {
      await clearOwnCursorIf(folder);
      folder.lastSyncAt = Date.now() / 1000;
      continue;
    }

    // 计数不符：ids 精核对（只看视频稿件）
    const url = 'https://api.bilibili.com/x/v3/fav/resource/ids?media_id=' + encodeURIComponent(folder.mediaId);
    const res = await proxyFetch(url);
    const j = res.json || {};
    if (res.ok && j.code === 0 && j.data && Array.isArray(j.data)) {
      const idsArr = j.data;
      const videoRows = idsArr.filter(m => m.type === undefined || m.type === 2);
      const remoteIds = Array.from(new Set(videoRows.filter(m => m.id != null).map(m => String(m.id))));
      const videos = remoteIds.length;
      const remoteFingerprint = fingerprintIds(remoteIds);
      const localIds = folderAidSet(folder.mediaId);
      // ids 疑似触顶（返回数 ≥1000 且远小于官方总数）→ 不能拿它当全集做相等判断
      const capped = idsArr.length >= 1000 && (folder.mediaCount || 0) > idsArr.length;
      const membershipSame = !capped && remoteIds.length === localIds.size &&
        remoteIds.every(id => localIds.has(id));
      folder.readable = true;
      folder.error = '';
      folder.diffCheckedAt = Date.now();
      // 每次探测即刷新“差异本质”标记：capped 夹决策只看官方总数/本地数，
      // 非 capped 且可枚举视频与本地一致 → 幽灵夹。二者都用于下一轮快通道免探测。
      folder.diffCapped = capped ? true : undefined;
      if (!capped && membershipSame) folder.diffGhost = true;
      else folder.diffGhost = undefined;
      // 基线稳定（幽灵占位等恒定差值）：官方/本地/总数三者未变 → 吸收并跳过
      const baseSame = folder.diffIds != null &&
        folder.diffIds === videos &&
        folder.diffLocal === local &&
        folder.diffMedia === mNow &&
        (capped || (membershipSame && folder.diffFingerprint === remoteFingerprint));
      if (baseSame) {
        // 差异本质已由上面探测结果刷新（capped→diffCapped / 非 capped 稳定差→diffGhost），
        // 但 baseSame 场景（如 ids 含本地拉不到的失效条目，videos>local 恒定）此前不会设
        // diffGhost → 每轮仍打 ids。这里补设，让下一轮走快通道免探测。
        if (!capped && membershipSame) folder.diffGhost = true;
        folder.diffFingerprint = remoteFingerprint;
        await clearOwnCursorIf(folder);
        folder.lastSyncAt = Date.now() / 1000;
        await persistFolders();
        continue;
      }
      if (!capped && membershipSame) {
        // 幽灵差异（官方总数>本地，多出的部分是 resource/list 拉不到的占位）：
        // 本地视频已与官方可枚举视频一致 → 写基线 + diffGhost 标记，此后快通道免探测。
        folder.diffIds = videos;
        folder.diffLocal = local;
        folder.diffMedia = mNow;
        folder.diffFingerprint = remoteFingerprint;
        folder.diffGhost = true;
        await clearOwnCursorIf(folder);
        folder.lastSyncAt = Date.now() / 1000;
        await persistFolders();
        continue;
      }

      // 决定动作：
      //  - 触顶大夹（ids 截断，无法精判视频数）→ 用官方总数变化方向判断：
      //      首次（无基线）全量收敛一次；总数变多→增量补新；总数变少→全量清理；未变→跳过
      //  - 普通夹：官方 > 本地 → 增量补新；官方 < 本地 → 全量清理
      let full;
      let act;
      if (capped) {
        const m = folder.mediaCount || 0;
        if (folder.diffMedia == null) {
          full = true;
          act = '全量（首次收敛，ids 达上限）';
          log('触顶大夹 → 首次全量收敛:', folder.title, '| 本地', local, '| 官方总数', m);
        } else if (m > folder.diffMedia) {
          // 真正执行增量补新（从 pn=1 拉到已知边界），而不是只记 lastSyncAt 跳过——
          // 否则新增收藏永不入库，且基线不更新导致每轮重复打 ids 探测。
          full = false;
          act = '增量补新';
          log('触顶大夹 → 总数增加，增量补新:', folder.title, '| 本地', local, '| 官方总数', m);
        } else if (m < folder.diffMedia) {
          full = true;
          act = '全量清理';
          log('触顶大夹 → 总数减少，全量清理:', folder.title, '| 本地', local, '| 官方总数', m);
        } else if (folder.diffLocal !== local) {
          full = true;   // 总数未变但本地漂移：保险走全量
          act = '全量（内部漂移）';
          log('触顶大夹 → 内部漂移，全量:', folder.title, '| 本地', local, '| 官方总数', m);
        } else {
          await clearOwnCursorIf(folder);
          folder.lastSyncAt = Date.now() / 1000;
          continue;   // 基线已代表当前状态，无动作
        }
      } else {
        // 数量相同但 ID 集合不同同样必须全量：增量只能补新，不能摘掉已删除成员。
        full = videos <= local;
        act = videos === local ? '全量（等量替换）' : (full ? '全量清理' : '增量补新');
        log('差异夹 → ' + act + ':', folder.title, '| 本地', local, '| 官方视频', videos);
      }

      // 针对性补齐（删除/触顶场景保留中断游标续传）
      // 仅当残留游标本身是“全量”扫描时才续传 pn：增量游标（full=false）只到已知
      // 边界即停，若被 full 清理误用会从半途续扫、把前段条目当“已删除”清掉。
      let startPn = 1;
      if (full && mem.syncCursor && mem.syncCursor.mediaId === folder.mediaId &&
          mem.syncCursor.full &&   // 游标必须是全量扫描残留
          (Date.now() - (mem.syncCursor.updatedAt || 0)) < CFG.CURSOR_TTL_MS) {
        startPn = mem.syncCursor.pn || 1;
      }
      setFlow(`补全差异 ${idx}/${total}：「${folder.title}」${full ? '（全量）' : '（增量补新）'}`);
      const outcome = await syncOneFolder(folder, { full, startPn });
      // 只清“属于本夹”的游标：若 syncOneFolder 前 mem.syncCursor 指向的是别的夹
      // （大夹中断续传点），清掉会丢掉断点 → 下轮又从头全量。本夹正常完成后，
      // 若游标属于本夹（full 扫描残留）则清空表示该夹已完成。
      await clearOwnCursorIf(folder);
      if (outcome && outcome.unreadable) {
        await markSessionFolderSkipped(folder.mediaId);
        continue;
      }
      // 记录稳定基线（官方视频数 / 补齐后的本地真实数 / 官方总数）
      folder.diffIds = videos;
      folder.diffLocal = countFolderLocal(folder.mediaId);
      folder.diffMedia = folder.mediaCount || 0;
      folder.diffFingerprint = remoteFingerprint;
      folder.diffCheckedAt = Date.now();
      await persistFolders();   // 立即落盘：配额中断/页面关闭也不丢已核对夹的基线
      pushView();
      await sleep(CFG.PAGE_GAP_MS);
    } else if (j.code === -101) {
      throw Object.assign(new Error('login'), { kind: 'LOGIN' });
    } else if ((!res.ok && res.status === 412) || j.code === -412) {
      throw Object.assign(new Error('rate'), { kind: 'RATE' });
    } else if (j.code === -400 || j.code === -403 || j.code === -404) {
      folder.readable = false;
      folder.error = '该收藏夹暂不可读（可能为私密夹）';
      await clearOwnCursorIf(folder);   // 不可读夹无续传意义
      await persistFolders();
      await markSessionFolderSkipped(folder.mediaId);
      continue;
    } else {
      log('差异检测中断（ids 请求异常）:', folder.title, res.ok ? ('code=' + j.code) : (res.error || ''));
      throw Object.assign(new Error('resource/ids 请求异常: ' + folder.title), { kind: 'RETRY_LATER' });
    }
  }
  flowCtx = null;
  await persistFolders();
}

async function runRefresh(verifiedMid) {
  // “仅刷新收藏夹列表”标记：先取出并复位，避免被冷却期吞掉后残留影响后续触发
  const foldersOnly = mem.pendingFoldersOnly || !!mem.meta.pendingFoldersOnly;
  mem.pendingFoldersOnly = false;

  // “立即同步”（跳过冷却）：取出并复位；若仍处冷却，清掉冷却标记直接开跑
  const force = forceSkipCooldown;
  forceSkipCooldown = false;

  const wait = coolingMs();
  if (wait > 0) {
    if (force) {
      if (mem.meta.resumeAt) await clearHold();
      log('用户选择跳过冷却，立即同步');
    } else {
      // 暂停/冷却中：任何点击/自动触发都不静默，给出可见倒计时提示
      const s = Math.max(1, Math.ceil(wait / 1000));
      setFlow(pauseReason === '412'
        ? 'B 站接口风控(412)冷却中，约 ' + s + ' 秒后自动续传，请勿关闭本页面'
        : '同步暂停（单段配额已用完），约 ' + s + ' 秒后自动继续，请勿关闭本页面');
      pushView();
      return;
    }
  }
  // 冷却到点且本地留有持久化标记（可能跨 SW 重启/跨页面）：清理后立即续跑
  if (mem.meta.resumeAt) await clearHold();
  if (refreshBusy) return;
  refreshBusy = true;
  // 新会话复位终止标志：空闲期点过“终止”只清了冷却/游标，不该让下一次手动同步
  // 一开始就被残留的 cancelSync 立刻 STOP（曾导致终止后需点两次才开始）。
  cancelSync = false;
  pageBudgetUsed = 0;
  burstLimit = settingNum('burstPages', CFG.BURST_PAGES);
  pauseReason = '';
  try {
    await ensureLoaded();
    if (!latestHomeTabId) { log('刷新中止：无首页标签页'); return; }
    setFlow('开始同步…');
    log('刷新开始');
    // await：确保“同步中”视图在登录检查之前生成完毕，避免与检查态交错
    await pushView();

    // 每轮内容操作都必须确认 mid，不能用 10 分钟登录缓存判断账号归属。
    // 手动操作若刚在同一消息内完成强制确认，则复用这次结果，避免连续请求 nav。
    const identityJustVerified = verifiedMid && loginInfo.ok && loginInfo.mid === verifiedMid &&
      (Date.now() - loginInfo.checkedAt) < 5000;
    const loginResult = identityJustVerified
      ? { state: 'ok', mid: loginInfo.mid, accountChanged: false }
      : await refreshLogin(true);
    if (loginResult && loginResult.accountChanged) return;
    if (cancelSync) throw Object.assign(new Error('cancel'), { kind: 'STOP' });
    if (!loginInfo.ok) {
      log('刷新中止：', loginInfo.error ? ('无法连接接口（' + loginInfo.error + '）') : '未登录');
      pushView(); return;
    }
    log('登录检查通过，mid =', loginInfo.mid);

    // 仅“刷新收藏夹”：拉最新夹列表即返回，不扫内容
    if (foldersOnly) {
      const foldersOk = await ensureFolderList(true);
      if (cancelSync) throw Object.assign(new Error('cancel'), { kind: 'STOP' });
      if (!foldersOk) throw Object.assign(new Error('收藏夹列表刷新失败'), { kind: 'RETRY_LATER' });
      delete mem.meta.pendingFoldersOnly;
      await persistMeta();
      refreshAttempts = 0;
      setFlow('已刷新收藏夹列表：共 ' + mem.folders.length + ' 个');
      log('仅刷新收藏夹列表完成:', mem.folders.length, '个');
      pushView();
      return;
    }

    // 在刷新收藏夹列表之前就持久化“请求意图”：即使 412/重启发生在列表阶段，
    // 续传仍知道原会话是全量还是增量、属于哪个范围。
    let session = mem.syncSession;
    if (session && (Date.now() - (session.updatedAt || session.startedAt || 0)) >= CFG.SESSION_TTL_MS) {
      log('未完成同步会话已过期，丢弃旧状态');
      await clearSyncState();
      session = null;
    }
    if (!session) {
      refreshAttempts = 0;
      const requestedScope = mem.pendingScope || 'all';
      session = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        full: needFullCycle(),
        scope: requestedScope,
        folderIds: null,
        coversAll: false,
        daily: !!mem.pendingDailyRun,
        completedFolderIds: [],
        skippedFolderIds: [],
        startedAt: Date.now(),
        updatedAt: Date.now()
      };
      mem.pendingFull = false;
      mem.pendingScope = 'all';
      mem.pendingDailyRun = false;
      await persistSession(session);
    }
    // 每次同步都强制刷新收藏夹列表：差异检测依赖官方计数最新（代价≈数个请求，远小于普查）
    const foldersOk = await ensureFolderList(true);
    if (cancelSync) throw Object.assign(new Error('cancel'), { kind: 'STOP' });
    if (!foldersOk) throw Object.assign(new Error('收藏夹列表刷新失败'), { kind: 'RETRY_LATER' });
    if (session.applySelection && Array.isArray(session.folderIds)) {
      await applyFolderSelection(session.folderIds);
      session.applySelection = false;
      session.updatedAt = Date.now();
      await persistSession(session);
    }
    log('收藏夹就绪，启用数 =', enabledFolders().length);

    const list0 = enabledFolders();
    // 小收藏夹先同步：尽快积累可用数据，也把巨型夹的长时间扫描往后放
    list0.sort((a, b) => (a.mediaCount || 0) - (b.mediaCount || 0));
    // 新会话首次拿到完整列表后固定目标 ID；恢复时严格沿用，范围不会退回 all。
    let list;
    if (Array.isArray(session.folderIds)) {
      const wanted = new Set(session.folderIds);
      list = list0.filter(f => wanted.has(f.mediaId));
      session.coversAll = list.length === list0.length;
      session.updatedAt = Date.now();
      await persistSession(session);
    } else {
      list = session.scope === 'created' || session.scope === 'collected'
        ? list0.filter(f => f.source === session.scope)
        : list0.slice();
      session.folderIds = list.map(f => f.mediaId);
      session.coversAll = list.length === list0.length;
      session.updatedAt = Date.now();
      await persistSession(session);
    }

    // 空列表：可能确实没有启用夹（刚拉成功则结束首次同步），也可能是列表还没拿到。
    // 区分处理，避免把“拉不到列表”误标成已完成。
    if (list.length === 0) {
      const listJustOk = mem.meta.foldersSyncedAt && (Date.now() - mem.meta.foldersSyncedAt * 1000) < 5 * 60 * 1000;
      if (listJustOk) {
        mem.meta.lastSyncAt = Date.now() / 1000;
        mem.meta.syncedOnce = true;
        delete mem.meta.firstSetupReason;
        delete mem.meta.accountChangedAt;
        await persistMeta();
        await clearSyncState();
      } else {
        refreshAttempts++;
        if (refreshAttempts >= 8) setFlow('多次获取收藏夹失败，请查看扩展 Service Worker 日志');
        else setFlow('尚未获取到收藏夹，稍后自动重试…');
      }
      pushView();
      return;
    }

    // 统一同步会话：全量周期（fullCycle=true）或差异会话都走 runSyncPass，
    // 断点续传/游标管理/基线落盘在此函数内统一处理，避免两套循环行为分叉。
    await runSyncPass(list, session.full);

    refreshAttempts = 0;
    const completedSession = mem.syncSession || session;
    const skippedCount = Array.isArray(completedSession.skippedFolderIds) ? completedSession.skippedFolderIds.length : 0;
    setFlow(skippedCount ? ('同步完成，但有 ' + skippedCount + ' 个收藏夹暂不可读') : '同步完成 ✓');

    if (completedSession.full && completedSession.coversAll && skippedCount === 0) mem.meta.lastFullSyncAt = Date.now() / 1000;
    mem.meta.lastSyncAt = Date.now() / 1000;
    mem.meta.syncedOnce = true;
    delete mem.meta.firstSetupReason;
    delete mem.meta.accountChangedAt;
    if (completedSession.daily) mem.meta.autoSyncKey = todayKey();
    await persistMeta();
    await clearSyncState();
    pushView();
  } catch (err) {
    if (err && err.kind === 'LOGIN') {
      // 接口明确返回未登录/登录失效：这是“明确未登录”的结论
      loginInfo.ok = false; loginInfo.mid = 0; loginInfo.error = '';
      loginInfo.checkedAt = Date.now(); loginInfo.failedAt = 0;
      // 不清 meta.mid：它表示现有缓存属于谁，退出登录不等于换号。
      setFlow('登录已失效，请重新登录哔哩哔哩');
    } else if (err && err.kind === 'STOP') {
      // 用户终止：取消自动续传/重试，清理标记与游标
      cancelSync = false;
      clearPendingRequests();
      await clearHold();
      await clearSyncState();
      refreshAttempts = 99;
      setFlow('同步已终止');
      log('同步已由用户终止');
    } else if (err && err.kind === 'RETRY_LATER') {
      // 中断也留“短续传点”（60s 后自动再试），保证链路不断；
      // 连续 10 次仍失败则停下，交回用户手动点“同步”。
      if (refreshAttempts < 10) {
        await holdUntil(60000, 'retry');
        setFlow('同步中断，约 1 分钟后自动续传');
      } else {
        setFlow('同步多次中断，请稍后手动点“同步”继续');
      }
      log('同步中断（页面关闭/超时/标签失效），游标已保存，将自动续传');
    } else if (err && err.kind === 'RATE') {
      const wait = settingMs('rateWaitMs', CFG.RATE_412_WAIT_MS);   // 412 冷却（设置页可调，默认 15 分钟）
      await holdUntil(wait, '412');
      setFlow('B 站接口风控(412)：暂停 ' + Math.round(wait / 1000) + ' 秒后自动续传，请勿关闭本页面');
      log('412 风控，冷却至', new Date(rateUntil).toLocaleTimeString(), '后自动续传');
    } else if (err && err.kind === 'PAUSE') {
      const wait = settingMs('burstPauseMs', CFG.BURST_PAUSE_MS);   // 单段配额暂停（设置页可调，默认 5 分钟）
      await holdUntil(wait, 'quota');
      setFlow('本段配额已用完，暂停 ' + Math.round(wait / 1000) + ' 秒后自动继续，请勿关闭本页面');
      log('单段配额用完，暂停至', new Date(rateUntil).toLocaleTimeString());
    } else {
      setFlow('同步出错：' + ((err && err.message) || err));
      log('同步出错:', err);
    }
    refreshAttempts++;
    pushView();
  } finally {
    refreshBusy = false;
    flowCtx = null;
    if (clearAfterSync) {
      clearAfterSync = false;
      await resetAllData();
      pushView();
      return;
    }
    if (pendingAccountSwitch) {
      await finishPendingAccountSwitch();
      pushView();
      return;
    }
    // 首次同步未完成且仍有首页标签时自动续跑（上限 8 次，避免死循环）
    if (mem.syncSession && !mem.meta.syncedOnce && latestHomeTabId &&
        refreshAttempts < 8 && rateUntil <= Date.now()) {
      setTimeout(() => {
        if (mem.syncSession && !refreshBusy && !mem.meta.syncedOnce && latestHomeTabId) {
          log('自动重试刷新（第', refreshAttempts, '次）');
          runRefresh();
        }
      }, 6000);
    }
  }
}

/* ---------------- 匹配（历史上的今天 / 历史日历） ---------------- */
function buildMatchData() {
  const s = mem.settings;
  const enabledIds = new Set(enabledFolders().map(f => f.mediaId));
  const folderTitle = new Map(mem.folders.map(f => [f.mediaId, f.title]));

  // 统一筛选可参与条目：首页提醒、Popup 今日与历史日历必须使用同一口径。
  const pool = [];                       // {it, mm, pubYear}
  const datePool = new Map();            // mm -> {minY, maxY, count}
  for (const k of Object.keys(mem.items)) {
    const it = mem.items[k];
    if (!it.folderIds || !it.folderIds.some(id => enabledIds.has(id))) continue;
    if (it.type !== 2) continue;
    if (s.hideInvalid && it.attr !== 0) continue;
    const pub = it.pubtime;
    if (!pub || pub <= 0) continue;
    const pubYear = yearFromTs(pub);
    const m = mmddFromTs(pub);
    pool.push({ it, m, pubYear });
    const rec = datePool.get(m) || { minY: pubYear, maxY: pubYear, count: 0 };
    rec.minY = Math.min(rec.minY, pubYear);
    rec.maxY = Math.max(rec.maxY, pubYear);
    rec.count++;
    datePool.set(m, rec);
  }
  return { pool, datePool, enabledIds, folderTitle };
}

function hitsForDateKey(dateKey, matchData) {
  if (!isValidDateKey(dateKey)) return [];
  const data = matchData || buildMatchData();
  const effDate = keyToDate(dateKey);
  const effYear = effDate.getFullYear();
  const effMM = pad2(effDate.getMonth() + 1) + '-' + pad2(effDate.getDate());
  const fb = feb29FallbackKey(mem.settings);

  const hits = [];
  for (const p of data.pool) {
    const { it, m, pubYear } = p;
    if (pubYear >= effYear) continue;             // 同年同日不算“历史”
    if (m === '02-29' && !isLeapYear(effYear)) {
      if (effMM !== fb) continue;                 // 2/29 平年归并到设置日
    } else if (m !== effMM) {
      continue;
    }
    const fid = it.folderIds.filter(id => data.enabledIds.has(id));
    hits.push({
      bvid: it.bvid || ('av' + it.aid),
      aid: it.aid, title: it.title, cover: it.cover,
      upperName: it.upperName, pubtime: it.pubtime,
      pubYear, years: effYear - pubYear,
      favTime: it.favTime, attr: it.attr,
      folderName: fid.length ? (data.folderTitle.get(fid[0]) || '') : ''
    });
  }
  hits.sort((a, b) => a.pubtime - b.pubtime);
  return hits;
}

function computeCalendarYear(year) {
  const currentYear = new Date().getFullYear();
  const data = buildMatchData();
  const days = {};
  const fb = feb29FallbackKey(mem.settings);
  const earliestPublishYear = data.pool.reduce((min, p) => Math.min(min, p.pubYear), currentYear);
  const minYear = Math.min(currentYear, earliestPublishYear + 1);
  const wantedYear = Math.max(minYear, Math.min(currentYear, parseInt(year, 10) || currentYear));
  for (const p of data.pool) {
    if (p.pubYear >= wantedYear) continue;
    const mm = (p.m === '02-29' && !isLeapYear(wantedYear)) ? fb : p.m;
    const key = wantedYear + '-' + mm;
    days[key] = (days[key] || 0) + 1;
  }
  return {
    year: wantedYear,
    minYear,
    maxYear: currentYear,
    days
  };
}

function computeHits() {
  const s = mem.settings;
  const effDate = effectiveDateFor(s);
  const effKey = dateKeyFromDate(effDate);
  const effYear = effDate.getFullYear();
  const data = buildMatchData();
  const hits = hitsForDateKey(effKey, data);

  // 调试用“建议日期”：真实今天的年份若早于该组最晚发布年，则取 最晚年+1，保证能命中
  const realYear = new Date().getFullYear();
  const avail = [];
  for (const [mm, rec] of data.datePool.entries()) {
    let y = Math.max(realYear, rec.maxY + 1);
    if (mm === '02-29' && !isLeapYear(y)) { while (!isLeapYear(y)) y++; }
    avail.push({ key: y + '-' + mm, count: rec.count, label: fmtMmddCn(mm) });
  }
  avail.sort((a, b) => a.key.localeCompare(b.key));

  return { effKey, simulated: !!s.debugDate, hits, avail, effYear };
}

/* ---------------- 视图 ---------------- */
async function buildView() {
  await ensureLoaded();
  const nowSec = Date.now() / 1000;
  const res = computeHits();
  const enabled = enabledFolders();
  const enabledIds = new Set(enabled.map(f => f.mediaId));
  const enabledItems = Object.values(mem.items).reduce((count, it) =>
    count + (Array.isArray(it.folderIds) && it.folderIds.some(id => enabledIds.has(id)) ? 1 : 0), 0);
  const syncing = refreshBusy || (flowCtx != null);

  // 登录态判定：只有“明确未登录”才是 'no'；检查飞行中与连接失败都不判未登录
  let loginState = 'unknown';
  if (loginInfo.checking) {
    // 检查中：有 mid（此前确认过登录）或内存 ok 即按已登录，避免闪现“未登录”
    loginState = (loginInfo.ok || mem.meta.mid) ? 'ok' : 'unknown';
  } else if (loginInfo.checkedAt) {
    loginState = loginInfo.ok ? 'ok' : 'no';
  } else if (loginInfo.failedAt) {
    loginState = 'unknown';   // 连接失败：交给 loginError 显示“无法连接”，不是未登录
  } else if (mem.meta.mid) {
    loginState = 'ok';        // 尚未检查过，但存在历史登录痕迹
  }

  // 长期未全量提醒：距上次全量 > 30 天、距上次提醒 > 7 天、且设置开启
  const lastFullAgo = mem.meta.lastFullSyncAt ? (Date.now() - mem.meta.lastFullSyncAt * 1000) : null;
  const lastRemindAgo = Date.now() - (mem.meta.fullSyncRemindAt || 0);
  const fullSyncRemind = !!(lastFullAgo && lastFullAgo > CFG.FULL_SYNC_STALE_MS &&
    mem.settings.fullSyncRemind !== false && lastRemindAgo > CFG.FULL_SYNC_REMIND_GAP_MS);

  return {
    v: 1,
    loginState,
    loginError: loginInfo.error || '',
    dateKey: res.effKey,
    simulated: res.simulated,
    effYear: res.effYear,
    hits: res.hits,
    hitTotal: res.hits.length,
    avail: res.avail,
    folders: {
      total: mem.folders.length,
      enabled: enabled.length,
      enabledItems,
      items: Object.keys(mem.items).length
    },
    // 完整收藏夹明细（首次同步向导 / 设置页分组用）
    foldersDetailed: mem.folders.map(f => ({
      mediaId: f.mediaId,
      title: f.title,
      mediaCount: f.mediaCount || 0,
      source: f.source || 'created',
      enabled: f.enabled !== false,
      readable: f.readable !== false,
      error: f.error || ''
    })),
    lastSyncAt: mem.meta.lastSyncAt || 0,
    syncedOnce: !!mem.meta.syncedOnce,
    syncing,
    fullSyncRemind,
    syncLabel: flowCtx
      ? `同步中：${flowCtx.folderTitle}（${flowCtx.folderIndex}/${flowCtx.folderTotal}，${flowCtx.phase}）`
      : (refreshBusy ? '同步中…' : ''),
    note: flowNote || '',
    syncMode: mem.settings.syncMode || 'manual',
    customSyncDays: customSyncDaysFor(mem.settings),
    accountMid: mem.meta.mid || 0,
    firstSetupReason: mem.meta.firstSetupReason || '',
    cooldownSec: Math.ceil(coolingMs() / 1000) || 0,
    cooldownReason: (mem.meta.resumeReason || pauseReason || ''),
    shownKey: mem.meta.shownKey || null,
    dismissedKey: mem.meta.dismissedKey || null,
    nowSec
  };
}

/* 推送视图给所有 B 站首页标签。
   homeTabs 为空时（如 SW 重启后内存 Map 丢失）主动找回首页标签，否则 popup/设置页
   发起的同步在首页右下角会没有任何提示（content 仅注入首页，故按首页 URL 过滤）。 */
async function pushView() {
  try {
    if (homeTabs.size === 0) {
      const tabs = await chrome.tabs.query({ url: ['https://www.bilibili.com/*'] });
      for (const t of (tabs || [])) {
        if (/^https:\/\/(www\.)?bilibili\.com\/?(\?.*)?$/i.test(t.url || '')) homeTabs.set(t.id, Date.now());
      }
    }
    if (homeTabs.size === 0) return;
    const view = await buildView();
    for (const tabId of homeTabs.keys()) {
      chrome.tabs.sendMessage(tabId, { type: MSG.VIEW_UPDATE, view }).catch(() => homeTabs.delete(tabId));
    }
  } catch (e) { /* 忽略 */ }
}

/* 找一个可注入取数的 B 站标签（任意 B 站页面均可主世界注入 fetch）：
   ① 优先复用当前活动标签；② 其次任意已打开的 B 站标签；③ 都没有才需新开 */
async function findHomeTab() {
  const isBili = u => /^https:\/\/[^/]*\.?bilibili\.com\//i.test(u || '');
  try {
    const act = await chrome.tabs.query({ active: true, currentWindow: true });
    if (act && act.length && isBili(act[0].url)) return act[0];
  } catch (e) {}
  try {
    const tabs = await chrome.tabs.query({ url: ['https://*.bilibili.com/*'] });
    if (tabs && tabs.length) return tabs[0];
  } catch (e) {}
  return null;
}

/* 手动操作先绑定一个真实 B 站标签并确认账号，再判断旧冷却状态。
   这样旧账号的 412/配额暂停不会阻挡新账号进入首次选择。 */
async function prepareAccountForAction(tab) {
  if (!tab) return null;
  homeTabs.set(tab.id, Date.now());
  latestHomeTabId = tab.id;
  let loginResult = null;
  try {
    loginResult = await refreshLogin(true);
  } catch (e) {
    log('操作前账号确认失败:', e);
    return null;
  }
  if (!loginResult || !loginResult.accountChanged || loginResult.deferred) return loginResult;

  // 空闲期换号已完成清理；预取新账号夹列表后停在向导，不执行原账号发起的操作。
  try {
    await ensureFolderList(false);
  } catch (e) {
    log('换号后预取收藏夹列表失败:', e);
  }
  pushView();
  return loginResult;
}

/* ---------------- 消息 ---------------- */
async function handle(msg, sender) {
  await ensureLoaded();
  switch (msg.type) {

    case MSG.HOME_OPEN: {
      if (sender.tab && sender.tab.id != null) {
        homeTabs.set(sender.tab.id, Date.now());
        latestHomeTabId = sender.tab.id;
      }
      // 首页是账号切换的主检测点：必须绕过登录缓存拿到当前 mid。
      let loginResult = null;
      try { loginResult = await refreshLogin(true); } catch (e) { log('首页登录复核失败:', e); }
      if (loginResult && loginResult.accountChanged && loginResult.deferred) return buildView();

      // 首次或换号后先拉收藏夹列表，供“自选收藏夹”向导使用。
      if (loginInfo.ok && !mem.meta.syncedOnce && mem.folders.length === 0) {
        try { await ensureFolderList(false); } catch (e) { log('首次预取收藏夹列表失败:', e); }
      }
      // 换号后无论保留的自动同步模式是什么，都先让用户确认新账号收藏夹范围。
      if (mem.meta.firstSetupReason === 'accountChanged') {
        return buildView();
      }
      // 接续：用户曾在“无 B 站标签”时点了同步 → 本页就是刚自动打开的首页，执行它
      if (mem.meta.pendingFoldersOnly) {
        mem.pendingManual = false;
        mem.pendingFolderIds = null;
        mem.pendingFoldersOnly = true;
        runRefresh();
        return buildView();
      }
      if (mem.pendingManual) {
        const ids = mem.pendingFolderIds;
        mem.pendingFolderIds = null;
        mem.pendingManual = false;
        if (Array.isArray(ids) && ids.length) await applyFolderSelection(ids);
        runRefresh();
        return buildView();
      }
      // 自动续传/自动同步判定：冷却时间戳已持久化（meta.resumeAt），跨重启仍生效
      const mode = mem.settings.syncMode || 'manual';
      const resumeAt = mem.meta.resumeAt || 0;
      let shouldRun = false;
      if (resumeAt > 0) {
        // 曾触发 412/配额冷却：到点且此刻在 B 站 → 自动继续；未到点 → 不进行操作
        if (resumeAt <= Date.now()) shouldRun = true;
      } else if (mem.syncSession) {
        // 未完成会话优先于新的自动同步判定，避免 daily 已记当天后吞掉续传。
        shouldRun = true;
      } else if (mode === 'onHome') {
        shouldRun = true;
      } else if (mode === 'daily') {
        if (!mem.meta.autoSyncKey || mem.meta.autoSyncKey !== todayKey()) {
          mem.pendingDailyRun = true;
          shouldRun = true;
        }
      } else if (mode === 'custom' && customSyncDue()) {
        mem.pendingDailyRun = true;
        shouldRun = true;
      } else if (!mem.meta.syncedOnce && mem.syncCursor) {
        // 首次全量进行中被打断（含非 412）：回首页自动续传（修复“停中途需手点”的链路断点）
        shouldRun = true;
      }
      // manual + 从未开始过（无游标）：仍给向导，不自动同步
      if (shouldRun) runRefresh();
      return buildView();
    }

    case MSG.GET_VIEW:
      return buildView();

    case MSG.GET_CALENDAR_YEAR:
      return computeCalendarYear(msg.year);

    case MSG.GET_DATE_HITS: {
      const date = isValidDateKey(msg.date) ? msg.date : todayKey();
      return { dateKey: date, hits: hitsForDateKey(date) };
    }

    case MSG.CHECK_LOGIN: {
      // 手动重试登录检查：跳过 TTL 立即复查（“无法连接”卡上的“重试”按钮）
      await refreshLogin(true);
      const lv = await buildView();
      pushView();
      return lv;
    }

    case MSG.SYNC_NOW: {
      log('收到同步请求:', { folderIds: (msg.folderIds || []).length, full: !!msg.full, scope: msg.scope || 'all', force: !!msg.force, fromContent: !!(sender && sender.tab) });
      const force = !!msg.force;
      if (refreshBusy) return { started: false, busy: true };
      // 有可用页面时先识别账号；若已换号，旧账号冷却和待同步意图都必须作废。
      const tab = pickSenderBiliTab(sender) || await findHomeTab();
      const identity = await prepareAccountForAction(tab);
      if (identity && identity.accountChanged) {
        return { started: false, accountChanged: true, deferred: !!identity.deferred };
      }
      const wait = coolingMs();
      if (wait > 0 && !force) {
        const s = Math.max(1, Math.ceil(wait / 1000));
        const reason = pauseReason === '412' ? '412' : (mem.meta.resumeReason === '412' ? '412' : 'quota');
        log('同步请求被冷却拦截，剩余', s, '秒');
        setFlow(reason === '412'
          ? 'B 站接口风控(412)冷却中，约 ' + s + ' 秒后自动续传，请勿关闭本页面'
          : '同步暂停（单段配额已用完），约 ' + s + ' 秒后自动继续，请勿关闭本页面');
        pushView();
        return { started: false, cooldown: true, seconds: s, reason };
      }
      if (force) forceSkipCooldown = true;   // 交由 runRefresh 清除冷却并开跑
      // 空闲时立即把请求意图落盘，避免“自动打开首页”途中 SW 重启后丢失 full/scope。
      if (!refreshBusy && !mem.syncSession) {
        refreshAttempts = 0;
        const selectedIds = Array.isArray(msg.folderIds) ? msg.folderIds.slice() : null;
        await persistSession({
          id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          full: !!msg.full || !mem.meta.lastFullSyncAt,
          scope: selectedIds ? 'all' : (msg.scope || 'all'),
          folderIds: selectedIds,
          applySelection: !!selectedIds,
          coversAll: false,
          daily: false,
          completedFolderIds: [],
          skippedFolderIds: [],
          startedAt: Date.now(),
          updatedAt: Date.now()
        });
        mem.pendingFull = false;
        mem.pendingScope = 'all';
      }
      // 复用真实 B 站页面（content 向导 / popup 正好点在 B 站上）；否则查已打开的 B 站标签
      // 普通同步必须清掉可能由旧的“仅刷新列表”请求留下的标记，否则 HOME_OPEN
      // 会把这次内容同步误判成只刷新收藏夹并提前结束。
      if (mem.meta.pendingFoldersOnly) {
        delete mem.meta.pendingFoldersOnly;
        await persistMeta();
      }
      if (!tab) {
        // 没有任何 B 站标签：记录本次请求 → 前台打开首页 → 页面加载后由 HOME_OPEN 接续执行
        mem.pendingFolderIds = Array.isArray(msg.folderIds) ? msg.folderIds.slice() : null;
        mem.pendingManual = true;
        chrome.tabs.create({ url: 'https://www.bilibili.com/', active: true });
        log('无 B 站标签，自动打开首页（同步待接续）');
        return { openingHome: true };
      }
      if (Array.isArray(msg.folderIds)) {
        await applyFolderSelection(msg.folderIds);
      }
      runRefresh(loginInfo.mid);
      log('同步请求已受理');
      return { started: true };
    }

    case MSG.REFRESH_FOLDERS: {
      if (refreshBusy) return { started: false, busy: true };
      const tab = pickSenderBiliTab(sender) || await findHomeTab();
      const identity = await prepareAccountForAction(tab);
      if (identity && identity.accountChanged) {
        return { started: false, accountChanged: true, deferred: !!identity.deferred };
      }
      // 冷却中先拦截：给出剩余秒数，避免“已受理”但实际被 runRefresh 内部吞掉
      const wait2 = coolingMs();
      if (wait2 > 0) {
        const s = Math.max(1, Math.ceil(wait2 / 1000));
        const reason = pauseReason === '412' ? '412' : (mem.meta.resumeReason === '412' ? '412' : 'quota');
        setFlow(reason === '412'
          ? 'B 站接口风控(412)冷却中，约 ' + s + ' 秒后自动续传，请勿关闭本页面'
          : '同步暂停（单段配额已用完），约 ' + s + ' 秒后自动继续，请勿关闭本页面');
        pushView();
        return { cooldown: true, seconds: s, reason };
      }
      // 在查找/自动打开页面之前持久化操作类型，避免这段窗口内 SW 重启后
      // 把“仅刷新列表”恢复成内容同步。
      mem.pendingFoldersOnly = true;
      mem.meta.pendingFoldersOnly = true;
      await persistMeta();
      if (!tab) {
        mem.pendingManual = true;
        chrome.tabs.create({ url: 'https://www.bilibili.com/', active: true });
        log('无 B 站标签，打开首页（刷新收藏夹待接续）');
        return { openingHome: true };
      }
      runRefresh(loginInfo.mid);
      log('收藏夹列表刷新请求已受理');
      return { started: true };
    }

    case MSG.CANCEL_SYNC: {
      log('收到终止同步请求');
      cancelSync = true;
      clearPendingRequests();
      if (!refreshBusy) {
        await clearHold();
        await clearSyncState();
        refreshAttempts = 99;
        setFlow('同步已终止');
        pushView();
      }
      // 正在运行时：循环在下一页检测到 cancelSync 后自行停止（见 STOP 分支清理）
      return { ok: true };
    }

    case MSG.SET_FOLDER_ENABLED: {
      // folders 是后台同步状态的一部分，禁止设置页在同步中整对象覆盖。
      if (refreshBusy) return { ok: false, busy: true };
      const ids = Array.isArray(msg.ids) ? msg.ids : [];
      const wanted = new Set(ids);
      const enabled = !!msg.enabled;
      let changed = false;
      for (const f of mem.folders) {
        if (!wanted.has(f.mediaId)) continue;
        if ((f.enabled !== false) !== enabled) { f.enabled = enabled; changed = true; }
      }
      if (changed) await persistFolders();
      pushView();
      return { ok: true, changed };
    }

    case MSG.CLEAR_DATA: {
      // 正在请求页面时不能让设置页先删、后台随后又写回；先发停止信号，
      // 待 runRefresh 的 finally 收口清空。空闲时立即清理。
      if (refreshBusy) {
        clearAfterSync = true;
        cancelSync = true;
        setFlow('正在终止同步并清空数据…');
        pushView();
        return { ok: true, queued: true };
      }
      await resetAllData();
      pushView();
      return { ok: true, queued: false };
    }

    case MSG.SET_DEBUG_DATE: {
      const date = (msg.date && isValidDateKey(msg.date)) ? msg.date : '';
      mem.settings.debugDate = date;
      await saveSettings(mem.settings);
      const view = await buildView();
      pushView();
      return view;
    }

    case MSG.DEBUG_FORCE: {
      const s = mem.settings;
      const effKey = effectiveKeyFor(s);
      if (mem.meta.shownKey === effKey) delete mem.meta.shownKey;
      if (mem.meta.dismissedKey === effKey) delete mem.meta.dismissedKey;
      await persistMeta();
      const view = await buildView();
      pushView();
      return view;
    }

    case MSG.DISMISS_TODAY: {
      const effKey = effectiveKeyFor(mem.settings);
      mem.meta.shownKey = effKey;
      mem.meta.dismissedKey = effKey;
      await persistMeta();
      return { ok: true };
    }

    case MSG.MARK_FULLSYNC_REMINDED: {
      // “长期未全量”提醒已展示（无论用户选立即全量还是稍后）：记录时间，7 天后再弹
      mem.meta.fullSyncRemindAt = Date.now();
      await persistMeta();
      return { ok: true };
    }

    case MSG.MARK_SHOWN: {
      const effKey = effectiveKeyFor(mem.settings);
      if (mem.meta.shownKey !== effKey) {
        mem.meta.shownKey = effKey;
        await persistMeta();
      }
      return { ok: true };
    }

    case MSG.OPEN_VIDEO: {
      if (msg.bvid) {
        chrome.tabs.create({ url: 'https://www.bilibili.com/video/' + encodeURIComponent(msg.bvid) });
      }
      return { ok: true };
    }

    case MSG.LOG:
      log('[content]', msg.level || 'info', msg.text || '');
      return { ok: true };

    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  handle(msg, sender)
    .then(out => { if (out !== undefined) sendResponse(out); })
    .catch(err => {
      log('handle error', msg.type, err);
      try { sendResponse({ error: String((err && err.message) || err) }); } catch (e) {}
    });
  return true; // 异步响应
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (!alarm || alarm.name !== RESUME_ALARM) return;
  await ensureLoaded();
  if ((mem.meta.resumeAt || 0) > Date.now()) {
    try { await chrome.alarms.create(RESUME_ALARM, { when: mem.meta.resumeAt + 1000 }); } catch (e) {}
    return;
  }
  await clearHold();
  const tab = await findHomeTab();
  if (!tab) {
    log('续传闹钟到点，但没有可用 B 站标签；保留会话，待下次打开 B 站继续');
    return;
  }
  latestHomeTabId = tab.id;
  homeTabs.set(tab.id, Date.now());
  log('续传闹钟到点，恢复同步');
  runRefresh();
});

chrome.tabs.onRemoved.addListener(tabId => {
  homeTabs.delete(tabId);
  if (latestHomeTabId === tabId) latestHomeTabId = null;
});

/* SW 启动：预热缓存，避免首条消息延迟 */
ensureLoaded().catch(() => {});
log('background 已加载');
