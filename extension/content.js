'use strict';
/* ============================================================
 * 哔哩朝花夕拾 - content script（仅注入 B 站首页）
 * 职责：
 *   1. 作为“取数代理”：接收 background 的 FETCH_URL，在页面上下文
 *      发起 fetch（自动携带 Cookie，方案 B）
 *   2. 渲染首页右下角浮层卡片 + 状态卡片
 *   3. 调试模式：随时改变“模拟今天”（日期输入/前后一天/快捷日期）
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
let wasSyncing = false;       // 上一次视图是否在同步（用于“刚结束”过渡提示）
let doneTimer = null;         // “同步完成”过渡卡的自动隐藏定时器

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
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

/* 收起状态卡：记住类别，后续同类别视图不再自动弹回；类别变化（如进入结果）后恢复 */
function closeState() {
  userClosedCat = lastCat;
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
  const img = el('img', 'dsh-cover');
  if (h.cover) { img.src = h.cover; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; }
  img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  row.appendChild(img);

  const meta = el('div', 'dsh-meta');
  const t1 = el('div', 'dsh-title', h.title);
  meta.appendChild(t1);
  const sub1 = [];
  if (h.upperName) sub1.push(h.upperName);
  sub1.push(`${h.years} 年前的今天`);
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
  row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
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

  if (v.avail && v.avail.length) {
    const row2 = el('div', 'dsh-debug-chips');
    row2.appendChild(el('span', 'dsh-debug-label', '收藏中的日期：'));
    for (const a of v.avail.slice(0, 12)) {
      const c = el('button', 'dsh-chip', `${a.label}·${a.count}条`);
      c.title = '设为模拟日期 ' + a.key;
      c.addEventListener('click', () => safeSend({ type: MSG.SET_DEBUG_DATE, date: a.key }));
      row2.appendChild(c);
    }
    box.appendChild(row2);
  }
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

  const dateKey = v.dateKey;
  const cat = (v.loginState === 'no') ? 'login'
    : ((v.loginState === 'unknown' && v.loginError) ? 'err'
    : (!v.syncedOnce ? 'init' : 'results'));
  if (userClosedCat && userClosedCat !== cat) userClosedCat = '';
  lastCat = cat;
  if (userClosedCat === cat) { hide(); return; }   // 用户已主动收起该状态卡：静默等待

  const suppressed = !v.simulated &&
    (v.shownKey === dateKey || v.dismissedKey === dateKey);

  // 检测“刚结束一次同步”（用于结束时给个可见的完成提示）
  const becameIdle = wasSyncing && !v.syncing;
  wasSyncing = v.syncing;
  const interrupted = !!v.note && /中断|出错|冷却|暂停|风控/.test(v.note);

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
  // 2. 登录探测异常（多为网络/跨域）
  if (v.loginState === 'unknown' && v.loginError) {
    initUserStarted = false;
    show(stateCard('⚠️', '无法连接哔哩哔哩接口', v.loginError + '（若持续出现请打开 bilibili.com 页面重试）', []));
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
    const folds = v.foldersDetailed || [];
    // 冷却中：显示剩余时间；两个按钮——「刷新」重算显示，「立即同步」跳过等待直接开跑
    if (v.cooldownSec > 0) {
      show(cooldownCardView(v));
      return;
    }
    if (mode !== 'manual') {
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
    // 手动模式：弹出“自选同步内容”向导（区分 我创建的 / 追更的）
    show(initWizardCard(v));
    return;
  }

  // 已同步过之后：同步暂停/风控冷却同样显示在浮层（等同首次的等待窗，含 刷新/立即同步）
  if (v.cooldownSec > 0 && !v.syncing) {
    show(cooldownCardView(v));
    return;
  }

  // 4. 命中结果
  const hits = v.hits || [];
  // 同步进行中且当前无命中：显示紧凑进度卡（完成且无命中后自动隐藏）
  if (v.syncing && !hits.length && !v.simulated) {
    const mini = el('div', 'dsh-card dsh-sync-mini');
    const row = el('div', 'dsh-sync-mini-row');
    row.appendChild(el('span', 'dsh-sync-mini-icon', '⏳'));
    row.appendChild(el('span', 'dsh-sync-mini-txt', v.syncLabel || v.note || '正在同步收藏夹…'));
    const stop = btn('终止', sendCancelSync);
    stop.className = 'dsh-btn dsh-btn-stop';
    row.appendChild(stop);
    mini.appendChild(row);
    const close = btn('×', closeState);
    close.className = 'dsh-close dsh-close-state';
    close.title = '收起';
    mini.appendChild(close);
    show(mini);
    return;
  }
  const inSyncNote = v.syncing ? (v.syncLabel || '') : '';
  const card = el('div', 'dsh-card dsh-results');

  const head = el('div', 'dsh-head');
  const ttlWrap = el('div', 'dsh-titles');
  if (hits.length) {
    const years = [...new Set(hits.map(h => h.years))].sort((a, b) => b - a);
    const span = years.length > 1 ? `（最久 ${years[0]} 年前）` : '';
    ttlWrap.appendChild(el('div', 'dsh-title-main', `📅 ${years[0]} 年前的今天${span}`));
    ttlWrap.appendChild(el('div', 'dsh-title-sub',
      `${dateKey} · 收藏夹里 ${v.folders.enabled} 个夹 / ${hits.length} 条命中` +
      (v.simulated ? ' · 模拟日期' : '')));
  } else {
    ttlWrap.appendChild(el('div', 'dsh-title-main', v.simulated ? '📭 今天没有命中' : '📭 今天没有“历史投稿”'));
    ttlWrap.appendChild(el('div', 'dsh-title-sub', v.simulated ? '可点下方日期快速试一条' : `${dateKey} · 收藏夹里暂无 ${fmtMmddCn(dateKey.slice(5))} 发布的投稿`));
  }
  head.appendChild(ttlWrap);
  const closeBtn = btn('×', closeCard);
  closeBtn.className = 'dsh-close';
  head.appendChild(closeBtn);
  card.appendChild(head);

  if (inSyncNote) card.appendChild(el('div', 'dsh-syncnote', inSyncNote));

  if (hits.length) {
    const list = el('div', 'dsh-list');
    for (const h of hits.slice(0, 10)) list.appendChild(hitItem(h));
    card.appendChild(list);
    if (hits.length > 10) {
      card.appendChild(el('div', 'dsh-more',
        `还有 ${hits.length - 10} 条 · 点击扩展图标可查看全部`));
    }
    if (!suppressed) {
      safeSend({ type: MSG.MARK_SHOWN });
      shownMarked = true;
    }
  } else {
    // D4：真实日期无命中 -> 不打扰；但若是“同步刚结束”，短暂显示完成提示再收起
    if (!v.simulated) {
      if (becameIdle && !suppressed && !interrupted && !v.cooldownSec) {
        showDoneTransient();
      } else {
        hide();
      }
      return;
    }
    card.appendChild(el('div', 'dsh-empty', '该模拟日期下没有命中条目，可点下方日期快速换一天'));
  }

  if (v.simulated) card.appendChild(debugPanel(v));

  if (suppressed) { hide(); return; }
  show(card);
}

/* 冷却/暂停等待卡：标题、倒计时 + 「刷新」「立即同步」「终止」 */
function cooldownCardView(v) {
  const sec = v.cooldownSec || 0;
  const txt = sec >= 60 ? Math.ceil(sec / 60) + ' 分钟' : sec + ' 秒';
  const desc = (v.cooldownReason === '412' ? 'B 站接口风控(412)冷却中' : '同步暂停中') +
    '，约 ' + txt + ' 后自动继续';
  return stateCard('⏳', v.syncedOnce ? '同步已暂停' : '收藏夹尚未同步', desc,
    [btn('刷新', requestHome), btn('立即同步', forceSyncNow, true), btn('终止', sendCancelSync)]);
}

/* 请求终止同步（后台会停止当前循环并取消自动续传/清理游标） */
function sendCancelSync() {
  safeSend({ type: MSG.CANCEL_SYNC });
}

/* 手动触发一次同步（全部收藏夹，首次/全量） */
function startSyncNow() {
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

/* 首次同步“自选收藏夹”向导卡：区分 我创建的 / 追更的 */
function initWizardCard(v) {
  const folds = (v.foldersDetailed || []).slice();
  const sel = new Map();   // mediaId -> folder
  for (const f of folds) if (f.enabled) sel.set(f.mediaId, f);

  const card = el('div', 'dsh-card dsh-wizard');
  const head = el('div', 'dsh-head');
  const tt = el('div', 'dsh-titles');
  tt.appendChild(el('div', 'dsh-title-main', '🚀 首次同步 · 选择要同步的收藏夹'));
  head.appendChild(tt);
  const close = btn('×', closeState);
  close.className = 'dsh-close dsh-close-state';
  close.title = '收起';
  head.appendChild(close);
  card.appendChild(head);

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
    for (const f of items) {
      const row = el('label', 'dsh-wrow');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = sel.has(f.mediaId);
      cb.addEventListener('change', () => {
        if (cb.checked) sel.set(f.mediaId, f); else sel.delete(f.mediaId);
        syncCount();
      });
      row.appendChild(cb);
      row.appendChild(el('span', 'dsh-wrow-txt', f.title));
      row.appendChild(el('span', 'dsh-wrow-cnt', f.mediaCount + ' 项'));
      body.appendChild(row);
    }
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

  requestHome();
  // 兜底看门狗（每 9 秒）：
  //  1) “自动同步模式”下首次同步长时间未开始 → 再触发一次首页流程；
  //  2) 提示词含 续传/冷却/暂停（配额或风控暂停中）且长时间无新状态 → 主动催一次后台：
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
