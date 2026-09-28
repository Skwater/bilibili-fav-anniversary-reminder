'use strict';
/* ============================================================
 * 哔哩朝花夕拾 - content script（仅注入 B 站首页）
 * 职责：
 *   1. 作为“取数代理”：接收 background 的 FETCH_URL，在页面上下文
 *      发起 fetch（自动携带 Cookie）
 *   2. 仅在有每日命中时渲染首页右下角提醒
 * ============================================================ */

/* ---------------- 取数代理 ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === MSG.FETCH_URL) {
    (async () => {
      try {
        const resp = await fetch(msg.url, { credentials: 'include' });
        if (!resp.ok) {
          sendResponse({ ok: false, status: resp.status, error: 'HTTP ' + resp.status });
          return;
        }
        let json = null;
        try { json = await resp.json(); } catch (e) { json = null; }
        sendResponse({ ok: true, status: resp.status, json });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true; // 异步
  }
});

/* ---------------- 浮层 UI ---------------- */
let view = null;
let shownMarked = false;
const host = document.createElement('div');
host.className = 'dsh-host';
host.style.display = 'none';
(document.body || document.documentElement).appendChild(host);

/* 记录最近一次收到视图的时间（用于“卡在初始化”时的兜底重询） */
let lastViewAt = Date.now();
let userClosedCat = '';   // 用户主动收起的状态卡类别：同类别不自动弹回，类别变化时复位
let lastCat = '';         // 当前渲染的卡片类别（login / err / init / results）
let initUserStarted = false; // 用户已在首次向导点了“开始”：不再把向导弹回来
let wizardSelIds = [];        // 向导当前勾选的 mediaId 集合（供捕获委托直接读取）
let doneTimer = null;         // “同步完成”过渡卡的自动隐藏定时器

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// 仅当单行省略号实际生效时，才启用浏览器原生悬停提示。
function enableOverflowTitle(element) {
  element.addEventListener('mouseenter', () => {
    if (element.scrollWidth > element.clientWidth) element.title = element.textContent || '';
    else element.removeAttribute('title');
  });
}

/* 扩展上下文可能已失效（重载/更新后旧页面）：统一安全发送，避免抛异常刷屏 */
let contextDead = false;
function safeSend(msg, cb) {
  if (contextDead) return;
  try { chrome.runtime.sendMessage(msg, cb || (() => {})); }
  catch (e) { contextDead = true; }
}

function openVideo(bvid) {
  safeSend({ type: MSG.OPEN_VIDEO, bvid });
}

const WATCH_LATER_PATHS = [
  'M10 3.1248A6.875 6.875 0 1 0 14.8606 14.862a.625.625 0 1 1 .8837.884A8.125 8.125 0 1 1 18.0755 10.902a.625.625 0 0 1-1.2425-.1374A6.875 6.875 0 0 0 10 3.1248Z',
  'M15.3914 9.1412a.625.625 0 0 1 .8839 0L17.5 10.3659l1.2248-1.2247a.625.625 0 0 1 .8838.8839l-1.5194 1.5193a.8333.8333 0 0 1-1.1785 0l-1.5193-1.5193a.625.625 0 0 1 0-.8839Z',
  'M12.4993 9.2784a.8333.8333 0 0 1 0 1.4429l-3.1254 1.8045a.8333.8333 0 0 1-1.2496-.7215V8.1954a.8333.8333 0 0 1 1.2496-.7215l3.1254 1.8045Z'
];
const WATCH_LATER_DONE_PATHS = [
  'M2.4836 10.2748a.625.625 0 0 1 .8839 0l3.3882 3.3882a.8333.8333 0 0 0 1.1785 0l8.6915-8.6915a.625.625 0 1 1 .8839.8839L8.8181 14.5469a2.0833 2.0833 0 0 1-2.9463 0l-3.3882-3.3882a.625.625 0 0 1 0-.8839Z'
];

function setWatchLaterButtonState(button, inWatchLater) {
  const svg = button.querySelector('svg');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  for (const data of (inWatchLater ? WATCH_LATER_DONE_PATHS : WATCH_LATER_PATHS)) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', data);
    svg.appendChild(path);
  }
  button.classList.toggle('dsh-watch-later-done', !!inWatchLater);
  button.dataset.inWatchLater = inWatchLater ? '1' : '0';
  button.disabled = false;
  const label = inWatchLater ? '移出稍后再看' : '添加至稍后再看';
  button.title = label;
  button.setAttribute('aria-label', label);
}

function watchLaterButton(h) {
  const button = el('button', 'dsh-watch-later');
  button.type = 'button';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  button.appendChild(svg);
  setWatchLaterButtonState(button, !!h.inWatchLater);
  button.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (button.disabled) return;
    const wasInWatchLater = button.dataset.inWatchLater === '1';
    button.disabled = true;
    button.classList.add('dsh-watch-later-pending');
    button.title = wasInWatchLater ? '正在移出…' : '正在添加…';
    safeSend({ type: wasInWatchLater ? MSG.REMOVE_WATCH_LATER : MSG.ADD_WATCH_LATER, aid: h.aid }, resp => {
      button.classList.remove('dsh-watch-later-pending');
      if (resp && resp.ok) {
        setWatchLaterButtonState(button, !wasInWatchLater);
      } else {
        setWatchLaterButtonState(button, wasInWatchLater);
        button.title = (resp && resp.message) || (wasInWatchLater ? '移出失败，请重试' : '添加失败，请重试');
        button.setAttribute('aria-label', button.title);
      }
    });
  });
  return button;
}

function dateAddDays(key, delta) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + delta);
  return dateKeyFromDate(d);
}

/* 状态卡片（登录 / 同步 / 错误）；右上角提供“×”仅收起悬浮窗，不打扰后台 */
function stateCard(icon, title, desc, actions) {
  const card = el('div', 'dsh-card dsh-state');
  const close = btn('×', closeState);
  close.className = 'dsh-close dsh-close-state';
  close.title = '收起';
  card.appendChild(close);
  const head = el('div', 'dsh-state-head');
  head.appendChild(el('span', 'dsh-state-icon', icon));
  head.appendChild(el('div', 'dsh-state-titles', ''));
  head.lastChild.appendChild(el('div', 'dsh-state-title', title));
  if (desc) head.lastChild.appendChild(el('div', 'dsh-state-desc', desc));
  card.appendChild(head);
  if (actions && actions.length) {
    const bar = el('div', 'dsh-actions');
    for (const a of actions) bar.appendChild(a);
    card.appendChild(bar);
  }
  return card;
}

/* 同步中的紧凑进度气泡（复用既有 dsh-sync-mini 样式） */
function syncMiniCard(v) {
  const mini = el('div', 'dsh-card dsh-sync-mini');
  const row = el('div', 'dsh-sync-mini-row');
  row.appendChild(el('span', 'dsh-sync-mini-icon', '⏳'));
  row.appendChild(el('span', 'dsh-sync-mini-txt', v.syncLabel || v.note || '正在同步收藏夹…'));
  const stop = btn('终止', sendCancelSync);
  stop.className = 'dsh-btn dsh-btn-stop';
  row.appendChild(stop);
  mini.appendChild(row);
  const close = btn('×', closeState);
  // 注意：不能带 dsh-close-state（那是绝对定位到右上角，会与“终止”按钮重叠）
  close.className = 'dsh-close';
  close.title = '收起';
  mini.appendChild(close);
  return mini;
}

/* 收起状态卡：记住类别，后续同类别视图不再自动弹回；类别变化（如进入结果）后恢复 */
function closeState() {
  // 同步气泡的收起只对本次生效（不跨次记忆），否则下次同步会因“曾收起”而看不到进度
  if (lastCat !== 'syncing') userClosedCat = lastCat;
  hide();
}

/* “同步完成，今天暂无命中”的过渡提示卡：显示几秒后自动收起 */
function showDoneTransient() {
  clearTimeout(doneTimer);
  const c = el('div', 'dsh-card dsh-done');
  c.appendChild(el('div', 'dsh-done-title', '✅ 同步完成'));
  c.appendChild(el('div', 'dsh-done-sub', '今天暂无命中'));
  const close = btn('×', closeState);
  close.className = 'dsh-close dsh-close-state';
  close.title = '收起';
  c.appendChild(close);
  show(c);
  doneTimer = setTimeout(() => { hide(); }, 6000);
}

function btn(label, onClick, primary) {
  const b = el('button', 'dsh-btn' + (primary ? ' dsh-btn-primary' : ''), label);
  b.addEventListener('click', () => onClick());
  return b;
}

/* 命中列表条目 */
function hitItem(h) {
  const row = el('div', 'dsh-item' + (h.attr !== 0 ? ' dsh-item-invalid' : ''));
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  const cover = el('div', 'dsh-cover-wrap');
  const img = el('img', 'dsh-cover');
  if (h.cover) { img.src = h.cover; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; }
  img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  cover.appendChild(img);
  if (h.attr === 0 && h.aid) cover.appendChild(watchLaterButton(h));
  row.appendChild(cover);

  const meta = el('div', 'dsh-meta');
  const t1 = el('div', 'dsh-title', h.title);
  enableOverflowTitle(t1);
  meta.appendChild(t1);
  const sub1 = [];
  if (h.upperName) sub1.push(h.upperName);
  sub1.push(`投稿发布于 ${h.years} 年前的今天`);
  meta.appendChild(el('div', 'dsh-sub', sub1.join(' · ')));
  const sub2 = [];
  sub2.push(`发布于 ${h.pubYear} 年`);
  if (h.favTime) sub2.push(`收藏于 ${fmtDateCN(h.favTime).replace(' 年 ', '/').replace(' 月 ', '/').replace(' 日', '')}`);
  if (h.attr !== 0) sub2.push('已失效');
  meta.appendChild(el('div', 'dsh-sub2', sub2.join(' · ')));
  row.appendChild(meta);

  const activate = () => {
    if (h.attr !== 0) return; // 失效不可跳转
    openVideo(h.bvid);
  };
  row.addEventListener('click', activate);
  row.addEventListener('keydown', e => {
    if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      activate();
    }
  });
  return row;
}

function debugPanel(v) {
  const box = el('div', 'dsh-debug');

  const row1 = el('div', 'dsh-debug-row');
  row1.appendChild(el('span', 'dsh-debug-label', '模拟今天：'));
  const input = el('input', 'dsh-debug-date');
  input.type = 'date';
  input.value = v.dateKey;
  input.addEventListener('change', () => {
    if (input.value) safeSend({ type: MSG.SET_DEBUG_DATE, date: input.value });
  });
  row1.appendChild(input);
  row1.appendChild(btn('‹', () => changeDate(-1)));
  row1.appendChild(btn('›', () => changeDate(1)));
  row1.appendChild(btn('真实日期', () => safeSend({ type: MSG.SET_DEBUG_DATE, date: '' })));
  row1.appendChild(btn('重弹', () => safeSend({ type: MSG.DEBUG_FORCE })));
  box.appendChild(row1);

  return box;
}

function changeDate(delta) {
  if (!view) return;
  const next = dateAddDays(view.dateKey, delta);
  safeSend({ type: MSG.SET_DEBUG_DATE, date: next });
}

function closeCard() {
  safeSend({ type: MSG.DISMISS_TODAY });
  hide();
}

function show(el) {
  const wasHidden = host.style.display === 'none' || !host.firstChild;
  host.innerHTML = '';
  host.appendChild(el);
  // 只在“隐藏→出现”时播放一次弹出动画；同步期间的文字更新静默替换，避免不断“弹窗”
  if (wasHidden) {
    el.classList.add('dsh-pop');
    setTimeout(() => el.classList.remove('dsh-pop'), 400);
  }
  host.style.display = 'block';
}
function hide() { host.style.display = 'none'; host.innerHTML = ''; }

/* ---------------- 渲染入口 ---------------- */
function render(v) {
  view = v;
  shownMarked = false;
  lastViewAt = Date.now();

  // 页面浮窗只承担每日命中提醒，其余状态和操作统一放在插件弹窗。
  if (!v.syncedOnce || v.loginState !== 'ok') {
    hide();
    return;
  }

  const dateKey = v.dateKey;
  const cat = 'results';
  if (userClosedCat && userClosedCat !== cat) userClosedCat = '';
  lastCat = cat;
  if (userClosedCat === cat) { hide(); return; }   // 用户已主动收起该状态卡：静默等待

  const suppressed = !v.simulated &&
    (v.shownKey === dateKey || v.dismissedKey === dateKey);

  // 1. 未登录 / 接口连不上
  if (v.loginState === 'no') {
    initUserStarted = false;
    if (v.loginError) {
      show(stateCard('⚠️', '连接哔哩哔哩接口失败', v.loginError + '（点“重试”再试一次）',
        [btn('重试', requestHome)]));
    } else {
      show(stateCard('🔒', '未登录哔哩哔哩',
        '请在哔哩哔哩登录后使用“历史上的今天”提醒。',
        [btn('去登录', () => window.open('https://passport.bilibili.com/login', '_blank'))]));
    }
    return;
  }
  // 2. 登录探测异常（多为网络/跨域）——注意：这不是“未登录”
  if (v.loginState === 'unknown' && v.loginError) {
    initUserStarted = false;
    show(stateCard('⚠️', '无法连接哔哩哔哩接口',
      v.loginError + '（不是登录问题；可点“重试”，或稍后自动恢复）',
      [btn('重试', retryLoginCheck)]));
    return;
  }

  // 3. 从未同步完成
  const needInit = !v.syncedOnce;
  if (needInit) {
    if (v.syncing) {
      show(stateCard('⏳', '首次同步中', v.note || v.syncLabel || '正在同步收藏夹…', [btn('终止', sendCancelSync)]));
      return;
    }
    const mode = v.syncMode || 'manual';
    const accountChanged = v.firstSetupReason === 'accountChanged';
    const folds = v.foldersDetailed || [];
    // 冷却中：显示剩余时间；两个按钮——「刷新」重算显示，「立即同步」跳过等待直接开跑
    if (v.cooldownSec > 0) {
      show(cooldownCardView(v));
      return;
    }
    if (mode !== 'manual' && !accountChanged) {
      // 自动模式：交给后台按“自动同步”开关处理
      show(stateCard('⏳', '首次同步收藏夹中', v.note || '将自动同步你的收藏夹…', []));
      return;
    }
    if (!folds.length) {
      show(stateCard('⏳', '准备首次同步…', v.note || '正在读取收藏夹列表…', [btn('重试', requestHome)]));
      return;
    }
    if (initUserStarted) {
      // 已点“开始”：停留在启动/进行中状态，不再把向导弹回来
      show(stateCard('⏳', '开始同步…',
        v.note || '正在启动同步…',
        [btn('刷新状态', requestHome),
         btn('重新选择收藏夹', () => { initUserStarted = false; requestHome(); })]));
      return;
    }
    // 手动模式或账号刚切换：弹出“自选同步内容”向导。
    show(initWizardCard(v));
    return;
  }

  // 4. 每日命中结果
  const hits = v.hits || [];
  if (!hits.length) { hide(); return; }
  const card = el('div', 'dsh-card dsh-results');

  const head = el('div', 'dsh-head');
  const ttlWrap = el('div', 'dsh-titles');
  if (hits.length) {
    const years = [...new Set(hits.map(h => h.years))].sort((a, b) => b - a);
    ttlWrap.appendChild(el('div', 'dsh-title-main', `📅 历史上的今天（最早投稿发布于${years[0]}年前）`));
    ttlWrap.appendChild(el('div', 'dsh-title-sub', `${dateKey} · ${hits.length} 条`));
  } else {
    ttlWrap.appendChild(el('div', 'dsh-title-main', v.simulated ? '📭 今天没有命中' : '📭 今天没有“历史投稿”'));
    ttlWrap.appendChild(el('div', 'dsh-title-sub', v.simulated ? '可点下方日期快速试一条' : `${dateKey} · 收藏夹里暂无 ${fmtMmddCn(dateKey.slice(5))} 发布的投稿`));
  }
  head.appendChild(ttlWrap);
  const closeBtn = btn('×', closeCard);
  closeBtn.className = 'dsh-close';
  head.appendChild(closeBtn);
  card.appendChild(head);

  if (hits.length) {
    const list = el('div', 'dsh-list');
    for (const h of hits) list.appendChild(hitItem(h));
    card.appendChild(list);
    if (!suppressed) {
      safeSend({ type: MSG.MARK_SHOWN });
      shownMarked = true;
    }
  } else {
    // 真实日期无命中时不打扰。
    if (!v.simulated) {
      hide();
      return;
    }
    card.appendChild(el('div', 'dsh-empty', '该模拟日期下没有命中条目，可点下方日期快速换一天'));
  }

  if (suppressed) { hide(); return; }
  show(card);
}

/* 412 冷却等待卡：标题、倒计时 + 「刷新」「立即同步」「终止」 */
function cooldownCardView(v) {
  const sec = v.cooldownSec || 0;
  const txt = sec >= 60 ? Math.ceil(sec / 60) + ' 分钟' : sec + ' 秒';
  const desc = 'B 站接口风控(412)冷却中，约 ' + txt + ' 后自动继续，请勿关闭本页面';
  return stateCard('⏳', v.syncedOnce ? '同步已暂停' : '收藏夹尚未同步', desc,
    [btn('刷新', requestHome), btn('立即同步', forceSyncNow, true), btn('终止', sendCancelSync)]);
}

/* 请求终止同步（后台会停止当前循环并取消自动续传/清理游标） */
function sendCancelSync() {
  safeSend({ type: MSG.CANCEL_SYNC });
}

function confirmLargeFullSync(folderIds) {
  const total = fullSyncItemTotal((view && view.foldersDetailed) || [], 'all', folderIds);
  return total <= CFG.FULL_SYNC_CONFIRM_THRESHOLD ||
    confirm(`本次全量同步将处理约 ${total} 条收藏，可能需要较长时间，是否继续？`);
}

/* 手动触发一次同步（全部收藏夹，首次/全量） */
function startSyncNow(skipConfirm) {
  if (!skipConfirm && !confirmLargeFullSync()) return;
  initUserStarted = true;
  show(stateCard('⏳', '开始同步…', '正在启动同步…', []));
  try {
    chrome.runtime.sendMessage({ type: MSG.SYNC_NOW, full: true }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.needHome) { initUserStarted = false; return; }
      setTimeout(requestHome, 700);
    });
  } catch (e) { /* 忽略 */ }
}

/* 跳过冷却、立即同步（可能再次触发 412，属于用户主动选择） */
function forceSyncNow() {
  if (!confirmLargeFullSync()) return;
  initUserStarted = true;
  show(stateCard('⏳', '开始同步…', '正在立即同步（已跳过等待）…', []));
  try {
    chrome.runtime.sendMessage({ type: MSG.SYNC_NOW, full: true, force: true }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.needHome) { initUserStarted = false; return; }
      setTimeout(requestHome, 700);
    });
  } catch (e) { /* 忽略 */ }
}

/* 长期未全量提醒：立即全量 / 稍后（两者都记录本次提醒时间，7 天后再弹） */
function remindFullSyncNow() {
  if (!confirmLargeFullSync()) return;
  safeSend({ type: MSG.MARK_FULLSYNC_REMINDED });
  startSyncNow(true);
}
function remindFullSyncLater() {
  safeSend({ type: MSG.MARK_FULLSYNC_REMINDED });
  hide();
}

/* 首次同步“自选收藏夹”向导卡：区分 我创建的 / 追更的 */
function initWizardCard(v) {
  const folds = (v.foldersDetailed || []).slice();
  const sel = new Map();   // mediaId -> folder
  for (const f of folds) if (f.enabled) sel.set(f.mediaId, f);

  const card = el('div', 'dsh-card dsh-wizard');
  const head = el('div', 'dsh-head');
  const tt = el('div', 'dsh-titles');
  const accountChanged = v.firstSetupReason === 'accountChanged';
  tt.appendChild(el('div', 'dsh-title-main', accountChanged
    ? '🔄 已切换账号 · 重新选择收藏夹'
    : '🚀 首次同步 · 选择要同步的收藏夹'));
  head.appendChild(tt);
  const close = btn('×', closeState);
  close.className = 'dsh-close dsh-close-state';
  close.title = '收起';
  head.appendChild(close);
  card.appendChild(head);

  if (accountChanged) {
    card.appendChild(el('div', 'dsh-wizard-note',
      '为避免不同账号的数据混用，旧账号的收藏数据和同步进度已清理；扩展设置已保留。'));
  }

  const listWrap = el('div', 'dsh-wizard-list');
  const countBar = el('div', 'dsh-wizard-count', '');

  const syncCount = () => {
    countBar.textContent = '已选 ' + sel.size + ' 个';
    wizardSelIds = [...sel.keys()];
    if (typeof bStart !== 'undefined' && bStart) bStart.disabled = sel.size === 0;
  };

  const mkGroup = (title, source) => {
    const items = folds.filter(f => f.source === source && f.readable);
    if (!items.length) return;
    const g = el('div', 'dsh-wgroup');
    const head = el('div', 'dsh-wgroup-title dsh-wgroup-toggle');
    const caret = el('span', 'dsh-wgroup-caret', '▾');
    head.appendChild(caret);
    head.appendChild(el('span', '', title + '（' + items.length + '）'));
    const body = el('div', 'dsh-wgroup-body');
    const checkboxes = [];
    for (const f of items) {
      const row = el('label', 'dsh-wrow');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = sel.has(f.mediaId);
      cb.addEventListener('change', () => {
        if (cb.checked) sel.set(f.mediaId, f); else sel.delete(f.mediaId);
        syncCount();
      });
      checkboxes.push(cb);
      row.appendChild(cb);
      row.appendChild(el('span', 'dsh-wrow-txt', f.title));
      row.appendChild(el('span', 'dsh-wrow-cnt', f.mediaCount + ' 项'));
      body.appendChild(row);
    }
    const actions = el('div', 'dsh-wgroup-actions');
    const setGroup = checked => {
      for (let i = 0; i < items.length; i++) {
        checkboxes[i].checked = checked;
        if (checked) sel.set(items[i].mediaId, items[i]);
        else sel.delete(items[i].mediaId);
      }
      syncCount();
    };
    const groupAll = btn('全选', () => setGroup(true));
    const groupNone = btn('全不选', () => setGroup(false));
    for (const button of [groupAll, groupNone]) {
      button.classList.add('dsh-wgroup-action');
      button.addEventListener('click', event => event.stopPropagation());
    }
    actions.append(groupAll, groupNone);
    head.appendChild(actions);
    head.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      caret.textContent = open ? '▸' : '▾';
    });
    g.appendChild(head);
    g.appendChild(body);
    listWrap.appendChild(g);
  };
  mkGroup('我创建的', 'created');
  mkGroup('追更的（收藏的）', 'collected');

  const unreadable = folds.filter(f => !f.readable);
  if (unreadable.length) {
    const g = el('div', 'dsh-wgroup');
    g.appendChild(el('div', 'dsh-wgroup-title dsh-wgroup-muted', '暂不可读（私密等）' + (unreadable.length ? '（' + unreadable.length + '）' : '')));
    g.appendChild(el('div', 'dsh-wizard-note', '这些收藏夹当前无法读取，将在设置页标注，可稍后重试。'));
    listWrap.appendChild(g);
  }
  card.appendChild(listWrap);

  const foot = el('div', 'dsh-wizard-foot');
  foot.appendChild(countBar);
  const bAll = btn('全选', () => {
    for (const f of folds) if (f.readable) sel.set(f.mediaId, f);
    syncCount();
    const list = listWrap.querySelectorAll('input[type=checkbox]');
    for (const cb of list) cb.checked = true;
    bStart.disabled = false;
  });
  const bNone = btn('清空', () => {
    sel.clear();
    syncCount();
    const list = listWrap.querySelectorAll('input[type=checkbox]');
    for (const cb of list) cb.checked = false;
    bStart.disabled = true;
  });
  // “开始”按钮自身不带监听：统一走宿主捕获委托（data-action），防止被其他插件的冒泡处理拦截
  const bStart = btn('开始同步所选', () => {}, true);
  bStart.dataset.action = 'startFirst';
  bStart.disabled = sel.size === 0;
  foot.append(bAll, bNone, bStart);
  card.appendChild(foot);
  syncCount();
  return card;
}

/* 开始同步“所选收藏夹”（首次，全量） */
function startSyncSelected(ids) {
  if (!ids || !ids.length) return;
  if (!confirmLargeFullSync(ids)) return;
  initUserStarted = true;
  show(stateCard('⏳', '开始同步…', '正在同步所选收藏夹…', []));
  try {
    chrome.runtime.sendMessage({ type: MSG.SYNC_NOW, full: true, folderIds: ids }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.needHome) { initUserStarted = false; return; }
      setTimeout(requestHome, 700);   // 拉回“同步中”状态视图
    });
  } catch (e) { /* 忽略 */ }
}

/* 向后台请求一次“首页打开”视图（也用于重试/兜底） */
function requestHome() {
  try {
    chrome.runtime.sendMessage({ type: MSG.HOME_OPEN }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.v) return;
      render(resp);
    });
  } catch (e) { /* 忽略 */ }
}

/* 手动重试登录检查（跳过后台 TTL，立即复查） */
function retryLoginCheck() {
  safeSend({ type: MSG.CHECK_LOGIN }, (resp) => {
    if (resp && resp.v) render(resp);
  });
}

/* ---------------- 消息：后台推送视图 ---------------- */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === MSG.VIEW_UPDATE && msg.view) render(msg.view);
});

/* ---------------- 启动 ---------------- */
(function boot() {
  // 诊断 + 捕获委托：记录落在我们浮层上的点击；关键操作走 data-action 直达处理，
  // 不依赖按钮自身监听（避免被其他插件/页面在冒泡阶段拦截）
  window.addEventListener('click', (ev) => {
    if (!host.contains(ev.target)) return;
    const el = ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (el) {
      if (el.dataset.action === 'startFirst' && !el.disabled && wizardSelIds.length) {
        startSyncSelected(wizardSelIds);
      }
      return;
    }
  }, true);

  // 打开页面后延迟 BOOT_DELAY_MS 再首次请求视图：给登录态探测与页面稳定留时间，
  // 避免加载初期出现“未登录→已登录”的闪变（此期间 .dsh-host 保持隐藏）。
  setTimeout(requestHome, CFG.BOOT_DELAY_MS);
  // 兜底看门狗（每 9 秒）：
  //  1) “自动同步模式”下首次同步长时间未开始 → 再触发一次首页流程；
  //  2) 提示词含 续传/冷却/暂停（412 风控冷却中）且长时间无新状态 → 主动催一次后台：
  //     后台若仍在暂停会回推新倒计时（文字保持更新）；若暂停已过则正好拉起续传（防 SW 定时器在长暂停期丢失）。
  setInterval(() => {
    if (!view) return;
    const now = Date.now();
    if (view.syncMode !== 'manual' && !view.syncedOnce && !view.syncing && (now - lastViewAt) > 9000) {
      requestHome();
      return;
    }
    const pendingPause = !view.syncing && !!view.note && /续传|冷却|暂停/.test(view.note) &&
      (now - lastViewAt) > 15000;
    if (pendingPause && !contextDead) {
      lastViewAt = now;
      safeSend({ type: MSG.SYNC_NOW, full: false }, () => {});
    }
  }, 9000);
})();
