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

  BACKUP_FORMAT: 'bilibili-fav-anniversary-reminder-backup',
  BACKUP_VERSION: 1,

  DEFAULT_SETTINGS: {
    hideInvalid: true,   // 默认不提醒/不展示失效视频
    feb29: '0228',       // 2/29 平年归并：'0228' 或 '0301'
    syncMode: 'manual',  // 自动同步：'manual'手动 / 'onHome'首页每次 / 'daily'每天一次 / 'custom'自定义天数
    customSyncDays: 3,   // 自定义自动同步间隔（1~365 天）
    rateWaitMs: 15 * 60 * 1000,   // 412 风控冷却（默认 15 分钟，设置页可改）
    burstPauseMs: 5 * 60 * 1000,  // 单段配额暂停（默认 5 分钟，设置页可改）
    burstPages: 120,              // 每段连续请求页数配额（默认 120，设置页可改）
    fullSyncRemind: true,         // 超过 30 天未全量同步时提醒（默认开，设置页可关）
    debugDate: ''        // 调试用“模拟今天”：''=真实今天；否则 'YYYY-MM-DD'
  },

  API: {
    NAV: 'https://api.bilibili.com/x/web-interface/nav',
    FOLDER_CREATED: 'https://api.bilibili.com/x/v3/fav/folder/created/list-all',
    FOLDER_COLLECTED: 'https://api.bilibili.com/x/v3/fav/folder/collected/list',
    MEDIA_LIST: 'https://api.bilibili.com/x/v3/fav/resource/list'
  },

  FOLDER_LIST_REFRESH_MS: 6 * 3600 * 1000, // 收藏夹列表刷新间隔
  NAV_REFRESH_MS: 10 * 60 * 1000,   // 登录检查成功后的缓存时长
  NAV_FAIL_RETRY_MS: 30 * 1000,     // 登录检查失败/未确认后的重试间隔（短缓存，避免抖动被钉死）
  PAGE_SIZE: 20,                    // resource/list 每页数量（上限 20）
  PAGE_GAP_MS: 450,                 // 页间基础间隔（+随机抖动 0~150ms）
  MAX_RETRY: 3,                     // 单页最大重试次数
  RATE_412_WAIT_MS: 15 * 60 * 1000,  // 命中 412 后的默认冷却：15 分钟（设置页可改）
  BURST_PAGES: 120,                 // 每段默认页数配额（设置页可改）
  BURST_PAUSE_MS: 5 * 60 * 1000,    // 配额跑满后的默认暂停：5 分钟（设置页可改）
  PROXY_TIMEOUT_MS: 20000,          // 单次代发请求超时
  CURSOR_TTL_MS: 6 * 3600 * 1000,   // 断点游标有效期
  SESSION_TTL_MS: 7 * 24 * 3600 * 1000, // 未完成同步会话保留 7 天
  DIFF_ID_PROBE_MS: 24 * 3600 * 1000,   // 数量相等时最多每天做一次 ID 指纹核对
  CHECKPOINT_PAGES: 8,              // 全量扫描每 N 页提交一次 items + cursor 原子检查点
  BOOT_DELAY_MS: 3500,             // 打开首页后延迟首次显示浮层（避开“未登录”闪变）
  FULL_SYNC_CONFIRM_THRESHOLD: 5000, // 全量同步条目数超过此阈值时，先确认提醒耗时
  FULL_SYNC_STALE_MS: 30 * 24 * 3600 * 1000,   // 距上次全量超过此值视为“长期未全量”
  FULL_SYNC_REMIND_GAP_MS: 7 * 24 * 3600 * 1000 // 全量提醒最小间隔（7 天）
};

const MSG = {
  /* content -> background */
  HOME_OPEN: 'HOME_OPEN',           // 首页打开
  DISMISS_TODAY: 'DISMISS_TODAY',   // 用户点了“今日不再提醒”
  MARK_SHOWN: 'MARK_SHOWN',         // 卡片已展示
  OPEN_VIDEO: 'OPEN_VIDEO',         // 打开视频页
  GET_VIEW: 'GET_VIEW',             // popup/options 拉取视图
  GET_CALENDAR_YEAR: 'GET_CALENDAR_YEAR', // popup 日历：读取某年每天的本地命中数量
  GET_DATE_HITS: 'GET_DATE_HITS',   // popup 日历：读取指定日期的本地命中列表
  SYNC_NOW: 'SYNC_NOW',             // 手动同步 {full:boolean}
  CANCEL_SYNC: 'CANCEL_SYNC',       // 终止当前同步（含取消自动续传）
  REFRESH_FOLDERS: 'REFRESH_FOLDERS', // 仅刷新收藏夹列表（不扫内容）
  SET_DEBUG_DATE: 'SET_DEBUG_DATE', // 设置模拟日期 {date:''|'YYYY-MM-DD'}
  CHECK_LOGIN: 'CHECK_LOGIN',       // 手动重试登录检查（跳过 TTL，立即复查）
  DEBUG_FORCE: 'DEBUG_FORCE',       // 调试：清除当日去重标记并重弹
  MARK_FULLSYNC_REMINDED: 'MARK_FULLSYNC_REMINDED', // 记录“长期未全量”提醒已展示
  SET_FOLDER_ENABLED: 'SET_FOLDER_ENABLED', // 设置收藏夹开关 {ids, enabled}
  EXPORT_DATA: 'EXPORT_DATA',       // 导出本地备份 {includeAccount:boolean}
  EXPORT_DIAGNOSTICS: 'EXPORT_DIAGNOSTICS', // 导出脱敏诊断信息
  IMPORT_DATA: 'IMPORT_DATA',       // 导入本地备份 {backup, forceAccount:boolean}
  ADD_WATCH_LATER: 'ADD_WATCH_LATER', // 使用 B 站官方接口加入稍后再看 {aid:number}
  CLEAR_DATA: 'CLEAR_DATA',         // 终止同步并清空全部本地数据
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

function customSyncDaysFor(settings) {
  const raw = Number(settings && settings.customSyncDays);
  if (!Number.isFinite(raw)) return CFG.DEFAULT_SETTINGS.customSyncDays;
  return Math.min(365, Math.max(1, Math.round(raw)));
}

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
