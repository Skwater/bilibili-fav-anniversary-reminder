'use strict';
/* ============================================================
 * 哔哩朝花夕拾 - 公共常量与工具
 * 使用场景（经典脚本共享全局）：
 *   - background.js: 顶部 importScripts('common.js')
 *   - content_scripts: ["common.js", "content.js"]
 *   - popup/options 页: <script src="common.js"></script>
 * ============================================================ */

/* ---------------- 常量 ---------------- */
const CFG = {
  KEY_META: 'meta',
  KEY_FOLDERS: 'folders',
  KEY_ITEMS: 'items',
  KEY_SETTINGS: 'settings',
  KEY_SYNC: 'sync',

  DEFAULT_SETTINGS: {
    hideInvalid: true,   // 默认不提醒/不展示失效视频
    feb29: '0228',       // 2/29 平年归并：'0228' 或 '0301'
    syncMode: 'manual',  // 自动同步：'manual'手动 / 'onHome'首页每次 / 'daily'每天一次
    rateWaitMs: 15 * 60 * 1000,   // 412 风控冷却（默认 15 分钟，设置页可改）
    burstPauseMs: 5 * 60 * 1000,  // 单段配额暂停（默认 5 分钟，设置页可改）
    burstPages: 120,              // 每段连续请求页数配额（默认 120，设置页可改）
    debugDate: ''        // 调试用“模拟今天”：''=真实今天；否则 'YYYY-MM-DD'
  },

  API: {
    NAV: 'https://api.bilibili.com/x/web-interface/nav',
    FOLDER_CREATED: 'https://api.bilibili.com/x/v3/fav/folder/created/list-all',
    FOLDER_COLLECTED: 'https://api.bilibili.com/x/v3/fav/folder/collected/list-all',
    MEDIA_LIST: 'https://api.bilibili.com/x/v3/fav/resource/list'
  },

  FULL_SYNC_MS: 24 * 3600 * 1000,   // 距上次全量超过 24h 触发全量重扫
  FOLDER_LIST_REFRESH_MS: 6 * 3600 * 1000, // 收藏夹列表刷新间隔
  NAV_REFRESH_MS: 10 * 60 * 1000,   // 登录态检查缓存
  PAGE_SIZE: 20,                    // resource/list 每页数量（上限 20）
  PAGE_GAP_MS: 450,                 // 页间基础间隔（+随机抖动 0~150ms）
  MAX_RETRY: 3,                     // 单页最大重试次数
  RATE_412_WAIT_MS: 15 * 60 * 1000,  // 命中 412 后的默认冷却：15 分钟（设置页可改）
  BURST_PAGES: 120,                 // 每段默认页数配额（设置页可改）
  BURST_PAUSE_MS: 5 * 60 * 1000,    // 配额跑满后的默认暂停：5 分钟（设置页可改）
  PROXY_TIMEOUT_MS: 20000,          // 单次代发请求超时
  CURSOR_TTL_MS: 6 * 3600 * 1000    // 断点游标有效期
};

const MSG = {
  /* content -> background */
  HOME_OPEN: 'HOME_OPEN',           // 首页打开
  DISMISS_TODAY: 'DISMISS_TODAY',   // 用户点了“今日不再提醒”
  MARK_SHOWN: 'MARK_SHOWN',         // 卡片已展示
  OPEN_VIDEO: 'OPEN_VIDEO',         // 打开视频页
  GET_VIEW: 'GET_VIEW',             // popup/options 拉取视图
  SYNC_NOW: 'SYNC_NOW',             // 手动同步 {full:boolean}
  CANCEL_SYNC: 'CANCEL_SYNC',       // 终止当前同步（含取消自动续传）
  REFRESH_FOLDERS: 'REFRESH_FOLDERS', // 仅刷新收藏夹列表（不扫内容）
  SET_DEBUG_DATE: 'SET_DEBUG_DATE', // 设置模拟日期 {date:''|'YYYY-MM-DD'}
  DEBUG_FORCE: 'DEBUG_FORCE',       // 调试：清除当日去重标记并重弹
  LOG: 'LOG',
  /* background -> content */
  FETCH_URL: 'FETCH_URL',           // 让 content 代发 B 站请求
  VIEW_UPDATE: 'VIEW_UPDATE'        // 推送最新视图
};

/* ---------------- 日期工具（全部本地时区） ---------------- */
function pad2(n) { return (n < 10 ? '0' : '') + n; }

function dateKeyFromDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function todayKey() { return dateKeyFromDate(new Date()); }

function keyToDate(key) {
  const p = String(key).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

function isValidDateKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key))) return false;
  const d = keyToDate(key);
  return !isNaN(d.getTime()) &&
    dateKeyFromDate(d) === String(key);
}

/* ts 为 Unix 秒 -> 'MM-DD' */
function mmddFromTs(ts) {
  const d = new Date(ts * 1000);
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function yearFromTs(ts) { return new Date(ts * 1000).getFullYear(); }

function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

/* 2/29 在平年应并入的日期键（由设置决定） */
function feb29FallbackKey(settings) {
  return (settings && settings.feb29 === '0301') ? '03-01' : '02-28';
}

/* 当前“生效日期”：设置了模拟日期则用它，否则真实今天 */
function effectiveDateFor(settings) {
  const s = settings || CFG.DEFAULT_SETTINGS;
  return (s.debugDate && isValidDateKey(s.debugDate)) ? keyToDate(s.debugDate) : new Date();
}
function effectiveKeyFor(settings) { return dateKeyFromDate(effectiveDateFor(settings)); }

/* ---------------- 文案 ---------------- */
function fmtDateCN(dateOrTs) {
  const d = (dateOrTs instanceof Date) ? dateOrTs : new Date(dateOrTs * 1000);
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}
function fmtDateTime(ts) {
  if (!ts) return '从未';
  const d = new Date(ts * 1000);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function fmtMmddCn(key) { // '02-09'（或 'YYYY-MM-DD'）-> '2 月 9 日'
  const p = String(key).split('-');
  const mm = p[p.length - 2], dd = p[p.length - 1];
  return (+mm) + ' 月 ' + (+dd) + ' 日';
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------------- 存储封装 ---------------- */
function storageGet(key) { return chrome.storage.local.get(key); }
function storageSet(obj) { return chrome.storage.local.set(obj); }

async function loadSettings() {
  const o = await storageGet(CFG.KEY_SETTINGS);
  return Object.assign({}, CFG.DEFAULT_SETTINGS, o[CFG.KEY_SETTINGS] || {});
}
async function saveSettings(s) { await storageSet({ [CFG.KEY_SETTINGS]: s }); }
