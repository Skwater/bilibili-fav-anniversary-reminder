'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const common = fs.readFileSync(path.join(root, 'extension', 'common.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');

let fetchHandler = async () => ({ ok: false, error: 'UNMOCKED' });
let executeCount = 0;
let tabQueryResult = [{ id: 1, url: 'https://www.bilibili.com/' }];
const writes = [];
const store = {};

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return clone(store);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) if (key in store) out[key] = clone(store[key]);
        return out;
      },
      async set(obj) {
        writes.push(clone(obj));
        for (const [key, value] of Object.entries(obj)) store[key] = clone(value);
      },
      async remove(keys) {
        for (const key of keys) delete store[key];
      }
    },
    onChanged: { addListener() {} }
  },
  scripting: {
    async executeScript({ args }) {
      executeCount++;
      return [{ result: await fetchHandler(args[0]) }];
    }
  },
  tabs: {
    async query() { return clone(tabQueryResult); },
    async sendMessage() { return {}; },
    async create() { return { id: 2 }; },
    onRemoved: { addListener() {} }
  },
  alarms: {
    async create() {}, async clear() { return true; },
    onAlarm: { addListener() {} }
  },
  runtime: { onMessage: { addListener() {} } }
};

const context = vm.createContext({
  chrome, console, setTimeout, clearTimeout, Math, Date, Promise,
  importScripts() {}
});
const expose = `
globalThis.__bgtest = {
  CFG, mem, loginInfo,
  refreshLogin, ensureFolderList, syncOneFolder, runSyncPass, runRefresh, handle,
  fingerprintIds, folderAidSet, resetForAccountSwitch, hitsForDateKey, computeCalendarYear,
  setBurstLimit(value) { burstLimit = value; },
  clearRate() { rateUntil = 0; pauseReason = ''; delete mem.meta.resumeAt; delete mem.meta.resumeReason; },
  reset() {
    loaded = true;
    mem.meta = {};
    mem.folders = [];
    mem.items = {};
    mem.settings = Object.assign({}, CFG.DEFAULT_SETTINGS, { burstPages: 10000 });
    mem.syncCursor = null;
    mem.syncSession = null;
    mem.pendingFull = false;
    mem.pendingDailyRun = false;
    mem.pendingScope = 'all';
    mem.pendingManual = false;
    mem.pendingFolderIds = null;
    mem.pendingFoldersOnly = false;
    loginInfo.mid = 0;
    loginInfo.ok = false;
    loginInfo.error = '';
    loginInfo.checkedAt = 0;
    loginInfo.checking = false;
    loginInfo.failedAt = 0;
    loginCheckPromise = null;
    pendingAccountSwitch = null;
    latestHomeTabId = 1;
    homeTabs.clear();
    homeTabs.set(1, Date.now());
    pageBudgetUsed = 0;
    burstLimit = 10000;
    cancelSync = false;
    rateUntil = 0;
    pauseReason = '';
    clearAfterSync = false;
    forceSkipCooldown = false;
  }
};`;
vm.runInContext(common + '\n' + background + '\n' + expose, context, { filename: 'background-test-bundle.js' });
const api = context.__bgtest;

let failed = 0;
async function test(name, fn) {
  try {
    api.reset();
    writes.length = 0;
    executeCount = 0;
    tabQueryResult = [{ id: 1, url: 'https://www.bilibili.com/' }];
    for (const key of Object.keys(store)) delete store[key];
    await fn();
    console.log('ok  ', name);
  } catch (err) {
    failed++;
    console.log('FAIL', name, '=>', err && err.stack || err);
  }
}
function assert(value, message) {
  if (!value) throw new Error(message || 'assertion failed');
}
function media(id, title) {
  return { id, bvid: 'BV' + id, type: 2, title: title || ('v' + id), pubtime: 1600000000, attr: 0 };
}

(async () => {
  await test('登录检查 single-flight：并发调用只请求一次', async () => {
    fetchHandler = async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { ok: true, status: 200, json: { code: 0, data: { isLogin: true, mid: 42 } } };
    };
    await Promise.all([api.refreshLogin(true), api.refreshLogin(true)]);
    assert(executeCount === 1, '实际请求次数=' + executeCount);
    assert(api.loginInfo.ok && api.loginInfo.mid === 42, '登录结果未共享');
  });

  await test('登录接口异常保持 unknown，不清历史 mid', async () => {
    api.mem.meta.mid = 42;
    api.loginInfo.checkedAt = Date.now() - 100000;
    fetchHandler = async () => ({ ok: true, status: 200, json: { code: -412, message: 'risk' } });
    await api.refreshLogin(true);
    assert(api.loginInfo.ok === false && api.loginInfo.checkedAt === 0, '异常被当成明确未登录');
    assert(api.mem.meta.mid === 42, '历史 mid 被清除');
    assert(api.loginInfo.error.includes('-412'), '未保留业务错误');
  });

  await test('明确退出登录保留缓存归属和账号资源', async () => {
    api.mem.meta = { mid: 11, syncedOnce: true };
    api.mem.folders = [{ mediaId: 1, enabled: true }];
    api.mem.items = { BV1: { aid: 1, folderIds: [1] } };
    fetchHandler = async () => ({ ok: true, json: { code: 0, data: { isLogin: false } } });
    const result = await api.refreshLogin(true);
    assert(result && result.state === 'no', '未返回明确退出状态');
    assert(api.mem.meta.mid === 11, '退出登录错误清除了缓存所属 mid');
    assert(api.mem.folders.length === 1 && api.mem.items.BV1, '退出登录错误清除了账号资源');
  });

  await test('明确换号清理账号资源但完整保留设置', async () => {
    api.mem.meta = { mid: 11, syncedOnce: true, lastSyncAt: 1, shownKey: '2026-09-16' };
    api.mem.folders = [{ mediaId: 1, enabled: true }];
    api.mem.items = { BV1: { aid: 1, folderIds: [1] } };
    api.mem.syncSession = { full: true, updatedAt: Date.now() };
    api.mem.syncCursor = { mediaId: 1, pn: 2, full: true };
    api.mem.settings = Object.assign({}, api.mem.settings, { syncMode: 'daily', debugDate: '2030-02-03' });
    const settingsBefore = JSON.stringify(api.mem.settings);
    store.settings = clone(api.mem.settings);
    fetchHandler = async () => ({ ok: true, json: { code: 0, data: { isLogin: true, mid: 22 } } });
    const result = await api.refreshLogin(true);
    assert(result && result.accountChanged && !result.deferred, '未识别空闲期换号');
    assert(api.mem.meta.mid === 22 && api.mem.meta.firstSetupReason === 'accountChanged', '新账号首次状态错误');
    assert(api.mem.folders.length === 0 && Object.keys(api.mem.items).length === 0, '旧账号收藏资源未清空');
    assert(!api.mem.syncSession && !api.mem.syncCursor, '旧账号同步状态未清空');
    assert(JSON.stringify(api.mem.settings) === settingsBefore, '内存设置被换号清理修改');
    assert(JSON.stringify(store.settings) === settingsBefore, '持久化设置被换号清理修改');
  });

  await test('同一账号复核不清理现有数据', async () => {
    api.mem.meta = { mid: 11, syncedOnce: true };
    api.mem.folders = [{ mediaId: 1, enabled: true }];
    api.mem.items = { BV1: { aid: 1, folderIds: [1] } };
    fetchHandler = async () => ({ ok: true, json: { code: 0, data: { isLogin: true, mid: 11 } } });
    const result = await api.refreshLogin(true);
    assert(result && !result.accountChanged, '同账号被误判为换号');
    assert(api.mem.meta.syncedOnce && api.mem.folders.length === 1 && api.mem.items.BV1, '同账号数据被误清理');
  });

  await test('历史日历与今日提醒复用相同筛选口径', async () => {
    api.mem.folders = [
      { mediaId: 1, title: '启用夹', enabled: true },
      { mediaId: 2, title: '关闭夹', enabled: false }
    ];
    api.mem.items = {
      BV1: { aid: 1, bvid: 'BV1', type: 2, title: '正常', pubtime: new Date(2020, 8, 17, 12).getTime() / 1000, attr: 0, folderIds: [1] },
      BV2: { aid: 2, bvid: 'BV2', type: 2, title: '失效', pubtime: new Date(2019, 8, 17, 12).getTime() / 1000, attr: 1, folderIds: [1] },
      BV3: { aid: 3, bvid: 'BV3', type: 2, title: '关闭夹', pubtime: new Date(2018, 8, 17, 12).getTime() / 1000, attr: 0, folderIds: [2] },
      BV4: { aid: 4, bvid: 'BV4', type: 2, title: '同年', pubtime: new Date(2026, 8, 17, 12).getTime() / 1000, attr: 0, folderIds: [1] }
    };
    api.mem.settings.hideInvalid = true;
    const calendar = api.computeCalendarYear(2026);
    const hits = api.hitsForDateKey('2026-09-17');
    assert(calendar.days['2026-09-17'] === 1, '日历数量未按启用夹/失效/年份口径过滤');
    assert(hits.length === 1 && hits[0].title === '正常', '日期详情与日历数量不一致');
    assert(api.computeCalendarYear(1999).year === 2021, '早于可浏览范围的年份未自动校正');
  });

  await test('历史日历按设置归并平年二月二十九日', async () => {
    api.mem.folders = [{ mediaId: 1, title: '夹', enabled: true }];
    api.mem.items = {
      BV1: { aid: 1, bvid: 'BV1', type: 2, title: '闰日', pubtime: new Date(2020, 1, 29, 12).getTime() / 1000, attr: 0, folderIds: [1] },
      BV2: { aid: 2, bvid: 'BV2', type: 2, title: '二八', pubtime: new Date(2021, 1, 28, 12).getTime() / 1000, attr: 0, folderIds: [1] }
    };
    api.mem.settings.feb29 = '0228';
    const flat = api.computeCalendarYear(2026);
    assert(flat.days['2026-02-28'] === 2 && !flat.days['2026-02-29'], '平年归并数量错误');
    assert(api.hitsForDateKey('2026-02-28').length === 2, '平年日期详情未包含闰日投稿');
    const leap = api.computeCalendarYear(2024);
    assert(leap.days['2024-02-28'] === 1 && leap.days['2024-02-29'] === 1, '闰年没有拆分 2/28 与 2/29');
  });

  await test('追更列表第 2 页失败时拒绝提交残缺列表', async () => {
    api.loginInfo.mid = 42;
    api.mem.folders = [{ mediaId: 99, title: '旧列表', enabled: true }];
    fetchHandler = async url => {
      if (url.includes('/created/')) return { ok: true, json: { code: 0, data: { list: [] } } };
      if (url.includes('pn=1')) return { ok: true, json: { code: 0, data: {
        list: [{ id: 1, title: '第一页', media_count: 1 }], count: 2, has_more: true
      } } };
      return { ok: false, status: 500, error: 'HTTP 500' };
    };
    const ok = await api.ensureFolderList(true);
    assert(ok === false, '部分分页被报告为成功');
    assert(api.mem.folders.length === 1 && api.mem.folders[0].mediaId === 99, '旧列表被残缺结果覆盖');
  });

  await test('全量检查点同时提交 items 与 cursor', async () => {
    api.mem.syncSession = { full: true, updatedAt: Date.now() };
    const folder = { mediaId: 1, title: '夹', mediaCount: 1, enabled: true };
    fetchHandler = async url => ({ ok: true, json: { code: 0, data: { medias: [media(1)], has_more: false } } });
    await api.syncOneFolder(folder, { full: true, startPn: 1 });
    const checkpointWrites = writes.filter(w => w.sync && w.sync.cursor);
    assert(checkpointWrites.length > 0, '没有写检查点');
    assert(checkpointWrites.every(w => w.items && w.items.BV1), '存在游标领先于 items 的写入');
  });

  await test('最后一页恰好用完配额时正常完成', async () => {
    api.mem.syncSession = { full: true, updatedAt: Date.now() };
    api.setBurstLimit(1);
    const folder = { mediaId: 1, title: '夹', mediaCount: 1, enabled: true };
    fetchHandler = async () => ({ ok: true, json: { code: 0, data: { medias: [media(1)], has_more: false } } });
    const result = await api.syncOneFolder(folder, { full: true, startPn: 1 });
    assert(result && result.complete, '最后一页被误判为配额暂停');
  });

  await test('恢复手动全量时保持全量并继续后续收藏夹', async () => {
    api.mem.syncSession = {
      full: true, folderIds: [1, 2], completedFolderIds: [], updatedAt: Date.now()
    };
    api.mem.syncCursor = {
      mediaId: 1, pn: 2, full: true, accumSeen: ['BV1'], updatedAt: Date.now()
    };
    api.mem.items.BV1 = Object.assign(media(1), { aid: 1, folderIds: [1] });
    const folders = [
      { mediaId: 1, title: '一', mediaCount: 2, enabled: true },
      { mediaId: 2, title: '二', mediaCount: 1, enabled: true }
    ];
    const urls = [];
    fetchHandler = async url => {
      urls.push(url);
      if (url.includes('media_id=1')) return { ok: true, json: { code: 0, data: { medias: [media(2)], has_more: false } } };
      return { ok: true, json: { code: 0, data: { medias: [media(3)], has_more: false } } };
    };
    await api.runSyncPass(folders, false);
    assert(urls.some(u => u.includes('media_id=1') && u.includes('pn=2')), '未从断点页恢复');
    assert(urls.some(u => u.includes('media_id=2') && u.includes('pn=1')), '没有继续全量扫描后续夹');
    assert(!urls.some(u => u.includes('/ids?')), '错误退化为差异会话');
  });

  await test('差异会话中的全量清理断点直接续扫', async () => {
    api.mem.syncSession = {
      full: false, folderIds: [1], completedFolderIds: [], updatedAt: Date.now()
    };
    api.mem.syncCursor = {
      mediaId: 1, pn: 2, full: true, accumSeen: ['BV1'], updatedAt: Date.now()
    };
    api.mem.items.BV1 = Object.assign(media(1), { aid: 1, folderIds: [1] });
    const urls = [];
    fetchHandler = async url => {
      urls.push(url);
      return { ok: true, json: { code: 0, data: { medias: [media(2)], has_more: false } } };
    };
    await api.runSyncPass([{ mediaId: 1, title: '夹', mediaCount: 2, enabled: true }], false);
    assert(urls.length === 1 && urls[0].includes('pn=2'), '恢复前错误执行了 ids 快判');
  });

  await test('不可读收藏夹会重新探测并恢复', async () => {
    api.mem.syncSession = { full: false, folderIds: [1], completedFolderIds: [], updatedAt: Date.now() };
    const folder = { mediaId: 1, title: '夹', mediaCount: 1, enabled: true, readable: false };
    fetchHandler = async url => {
      if (url.includes('/ids?')) return { ok: true, json: { code: 0, data: [{ id: 1, type: 2 }] } };
      return { ok: true, json: { code: 0, data: { medias: [media(1)], has_more: false } } };
    };
    await api.runSyncPass([folder], false);
    assert(folder.readable === true && folder.error === '', '不可读状态未恢复');
    assert(api.mem.items.BV1, '恢复后未同步条目');
  });

  await test('等量替换通过 ID 集合差异触发全量', async () => {
    api.mem.syncSession = { full: false, folderIds: [1], completedFolderIds: [], updatedAt: Date.now() };
    api.mem.items.BV1 = Object.assign(media(1), { aid: 1, folderIds: [1] });
    const folder = { mediaId: 1, title: '夹', mediaCount: 1, enabled: true, diffCheckedAt: 0 };
    const urls = [];
    fetchHandler = async url => {
      urls.push(url);
      if (url.includes('/ids?')) return { ok: true, json: { code: 0, data: [{ id: 2, type: 2 }] } };
      return { ok: true, json: { code: 0, data: { medias: [media(2)], has_more: false } } };
    };
    await api.runSyncPass([folder], false);
    assert(api.mem.items.BV2 && !api.mem.items.BV1, '等量替换后本地成员未收敛');
    assert(urls.some(u => u.includes('/ids?')) && urls.some(u => u.includes('/list?')), '未执行指纹核对+全量');
  });

  await test('终止会清理持久化会话和待打开首页请求', async () => {
    api.mem.syncSession = { full: true, updatedAt: Date.now() };
    api.mem.syncCursor = { mediaId: 1, pn: 2, full: true, updatedAt: Date.now() };
    api.mem.pendingManual = true;
    api.mem.pendingFolderIds = [1];
    api.mem.meta.pendingFoldersOnly = true;
    api.mem.meta.resumeAt = Date.now() + 60000;
    const result = await api.handle({ type: 'CANCEL_SYNC' }, {});
    assert(result && result.ok, '终止请求失败');
    assert(!api.mem.syncSession && !api.mem.syncCursor, '会话或游标残留');
    assert(!api.mem.pendingManual && !api.mem.meta.pendingFoldersOnly, '待接续请求残留');
  });

  await test('收藏夹开关由后台串行修改', async () => {
    api.mem.folders = [{ mediaId: 1, enabled: true }, { mediaId: 2, enabled: true }];
    const result = await api.handle({ type: 'SET_FOLDER_ENABLED', ids: [2], enabled: false }, {});
    assert(result && result.ok && result.changed, '后台未受理开关修改');
    assert(api.mem.folders[0].enabled === true && api.mem.folders[1].enabled === false, '修改范围错误');
  });

  await test('完整全量会话成功后清状态并更新时间', async () => {
    api.loginInfo.ok = true;
    api.loginInfo.mid = 42;
    api.loginInfo.checkedAt = Date.now();
    api.mem.meta.mid = 42;
    api.mem.meta.lastFullSyncAt = 1;
    api.mem.syncSession = {
      full: true, scope: 'all', folderIds: null, coversAll: false,
      daily: false, completedFolderIds: [], skippedFolderIds: [], updatedAt: Date.now()
    };
    fetchHandler = async url => {
      if (url.includes('/nav')) return { ok: true, json: { code: 0, data: { isLogin: true, mid: 42 } } };
      if (url.includes('/created/')) return { ok: true, json: { code: 0, data: {
        list: [{ id: 1, title: '夹', media_count: 1 }]
      } } };
      if (url.includes('/collected/')) return { ok: true, json: { code: 0, data: {
        list: [], count: 0, has_more: false
      } } };
      if (url.includes('/resource/list')) return { ok: true, json: { code: 0, data: {
        medias: [media(1)], has_more: false
      } } };
      throw new Error('unexpected url ' + url);
    };
    await api.runRefresh();
    assert(!api.mem.syncSession && !api.mem.syncCursor, '成功后同步状态未清理');
    assert(api.mem.meta.lastFullSyncAt > 1 && api.mem.meta.syncedOnce, '成功时间未更新');
    assert(api.mem.items.BV1, '全量条目未保存');
  });

  await test('同步启动时换号会停稳清理并预取新账号收藏夹', async () => {
    api.mem.meta = { mid: 11, syncedOnce: true, lastFullSyncAt: 1 };
    api.mem.folders = [{ mediaId: 1, title: '旧夹', mediaCount: 1, enabled: true }];
    api.mem.items = { BV1: { aid: 1, folderIds: [1] } };
    api.mem.syncSession = {
      full: false, scope: 'all', folderIds: [1], completedFolderIds: [], updatedAt: Date.now()
    };
    api.mem.settings = Object.assign({}, api.mem.settings, { syncMode: 'daily', debugDate: '2030-02-03' });
    const settingsBefore = JSON.stringify(api.mem.settings);
    fetchHandler = async url => {
      if (url.includes('/nav')) return { ok: true, json: { code: 0, data: { isLogin: true, mid: 22 } } };
      if (url.includes('/created/')) return { ok: true, json: { code: 0, data: { list: [] } } };
      if (url.includes('/collected/')) return { ok: true, json: { code: 0, data: { list: [], count: 0, has_more: false } } };
      throw new Error('账号切换后不应请求旧夹内容: ' + url);
    };
    await api.runRefresh();
    assert(api.mem.meta.mid === 22 && api.mem.meta.firstSetupReason === 'accountChanged', '未进入新账号首次状态');
    assert(!api.mem.meta.syncedOnce && api.mem.folders.length === 0, '旧账号收藏夹状态未清理');
    assert(Object.keys(api.mem.items).length === 0 && !api.mem.syncSession && !api.mem.syncCursor,
      '旧账号条目或断点残留');
    assert(JSON.stringify(api.mem.settings) === settingsBefore, '换号停稳后设置发生变化');
  });

  await test('换号后保留自动模式但仍停在首次选择状态', async () => {
    api.mem.meta = { mid: 11, syncedOnce: true, lastFullSyncAt: 1 };
    api.mem.folders = [{ mediaId: 1, title: '旧夹', mediaCount: 1, enabled: true }];
    api.mem.items = { BV1: { aid: 1, folderIds: [1] } };
    api.mem.settings = Object.assign({}, api.mem.settings, { syncMode: 'onHome' });
    fetchHandler = async url => {
      if (url.includes('/nav')) return { ok: true, json: { code: 0, data: { isLogin: true, mid: 22 } } };
      if (url.includes('/created/')) return { ok: true, json: { code: 0, data: {
        list: [{ id: 2, title: '新账号夹', media_count: 3 }]
      } } };
      if (url.includes('/collected/')) return { ok: true, json: { code: 0, data: { list: [], count: 0, has_more: false } } };
      throw new Error('换号首次选择前不应开始内容同步: ' + url);
    };
    const view = await api.handle({ type: 'HOME_OPEN' }, { tab: { id: 1, url: 'https://www.bilibili.com/' } });
    assert(view && view.firstSetupReason === 'accountChanged' && !view.syncedOnce, '未返回换号首次视图');
    assert(api.mem.settings.syncMode === 'onHome', '自动同步设置未保留');
    assert(api.mem.folders.length === 1 && api.mem.folders[0].mediaId === 2, '未预取新账号收藏夹');
    assert(!api.mem.syncSession && Object.keys(api.mem.items).length === 0, '自动模式绕过向导启动了内容同步');
  });

  await test('旧账号冷却不会阻挡新账号进入首次选择', async () => {
    api.mem.meta = { mid: 11, syncedOnce: true, resumeAt: Date.now() + 60000, resumeReason: '412' };
    api.mem.folders = [{ mediaId: 1, title: '旧夹', mediaCount: 1, enabled: true }];
    api.mem.items = { BV1: { aid: 1, folderIds: [1] } };
    fetchHandler = async url => {
      if (url.includes('/nav')) return { ok: true, json: { code: 0, data: { isLogin: true, mid: 22 } } };
      if (url.includes('/created/')) return { ok: true, json: { code: 0, data: { list: [] } } };
      if (url.includes('/collected/')) return { ok: true, json: { code: 0, data: { list: [], count: 0, has_more: false } } };
      throw new Error('换号首次选择前不应请求内容: ' + url);
    };
    const result = await api.handle({ type: 'SYNC_NOW', full: true, scope: 'all' }, {});
    assert(result && result.accountChanged && !result.cooldown, '旧账号冷却仍拦截了换号初始化');
    assert(api.mem.meta.mid === 22 && !api.mem.meta.resumeAt, '换号后未清理旧账号冷却状态');
    assert(api.mem.meta.firstSetupReason === 'accountChanged' && !api.mem.syncSession,
      '换号后错误沿用了原同步请求');
  });

  await test('普通同步不会被旧的仅刷新标记降级', async () => {
    tabQueryResult = [];
    api.mem.meta.pendingFoldersOnly = true;
    const result = await api.handle({ type: 'SYNC_NOW', full: true, scope: 'all' }, {});
    assert(result && result.openingHome, '无 B 站页面时没有进入待接续状态');
    assert(api.mem.syncSession && api.mem.syncSession.full, '同步请求意图未持久化');
    assert(!api.mem.meta.pendingFoldersOnly, '普通同步仍残留仅刷新标记');
  });

  await test('仅刷新收藏夹在打开首页前持久化操作类型', async () => {
    tabQueryResult = [];
    const result = await api.handle({ type: 'REFRESH_FOLDERS' }, {});
    assert(result && result.openingHome, '无 B 站页面时没有打开首页');
    assert(api.mem.pendingFoldersOnly && api.mem.meta.pendingFoldersOnly,
      '仅刷新操作类型未同时保存在内存和 meta');
    assert(!api.mem.syncSession, '仅刷新请求错误创建了内容同步会话');
  });

  await test('仅刷新收藏夹遇到 412 后仍保持原操作类型', async () => {
    api.loginInfo.ok = true;
    api.loginInfo.mid = 42;
    api.loginInfo.checkedAt = Date.now();
    api.mem.meta.mid = 42;
    api.mem.meta.pendingFoldersOnly = true;
    fetchHandler = async url => {
      if (url.includes('/nav')) return { ok: true, json: { code: 0, data: { isLogin: true, mid: 42 } } };
      if (url.includes('/created/')) return { ok: false, status: 412, json: null };
      throw new Error('unexpected url ' + url);
    };
    await api.runRefresh();
    assert(api.mem.meta.pendingFoldersOnly === true && api.mem.meta.resumeAt, '412 后刷新类型或冷却丢失');
    api.clearRate();
    fetchHandler = async url => {
      if (url.includes('/nav')) return { ok: true, json: { code: 0, data: { isLogin: true, mid: 42 } } };
      if (url.includes('/created/')) return { ok: true, json: { code: 0, data: { list: [] } } };
      if (url.includes('/collected/')) return { ok: true, json: { code: 0, data: { list: [], count: 0, has_more: false } } };
      throw new Error('不应进入内容同步: ' + url);
    };
    await api.runRefresh();
    assert(!api.mem.meta.pendingFoldersOnly, '成功后刷新类型未清理');
    assert(!api.mem.syncSession, '仅刷新错误创建了内容同步会话');
  });

  console.log(failed === 0 ? '\n后台同步自检全部通过 ✓' : ('\n后台同步自检失败 ' + failed + ' 项 ✗'));
  process.exitCode = failed ? 1 : 0;
})();
