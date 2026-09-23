'use strict';
/* 哔哩朝花夕拾 - popup */
const $ = id => document.getElementById(id);

function syncModeLabel(v) {
  if (v.syncMode === 'onHome') return '每次首页同步';
  if (v.syncMode === 'daily') return '每天同步';
  if (v.syncMode === 'custom') return `每 ${v.customSyncDays || 3} 天同步`;
  return '手动同步';
}

let view = null;
let activeView = 'today';
const realToday = new Date();
let calendarYear = realToday.getFullYear();
let calendarMonth = realToday.getMonth();
let calendarSelected = todayKey();
let calendarSummary = null;
let calendarRequestSeq = 0;
let calendarDirty = false;
let calendarCollapsed = false;

function pillLogin(v) {
  const p = $('loginPill');
  if (v.loginState === 'ok') { p.textContent = v.accountMid ? ('UID ' + v.accountMid) : '已登录'; p.className = 'pill ok'; }
  else if (v.loginState === 'no') { p.textContent = '未登录'; p.className = 'pill warn'; }
  else { p.textContent = '登录未知'; p.className = 'pill'; }
}

const WATCH_LATER_PATHS = [
  'M10 3.1248A6.875 6.875 0 1 0 14.8606 14.862a.625.625 0 1 1 .8837.884A8.125 8.125 0 1 1 18.0755 10.902a.625.625 0 0 1-1.2425-.1374A6.875 6.875 0 0 0 10 3.1248Z',
  'M15.3914 9.1412a.625.625 0 0 1 .8839 0L17.5 10.3659l1.2248-1.2247a.625.625 0 0 1 .8838.8839l-1.5194 1.5193a.8333.8333 0 0 1-1.1785 0l-1.5193-1.5193a.625.625 0 0 1 0-.8839Z',
  'M12.4993 9.2784a.8333.8333 0 0 1 0 1.4429l-3.1254 1.8045a.8333.8333 0 0 1-1.2496-.7215V8.1954a.8333.8333 0 0 1 1.2496-.7215l3.1254 1.8045Z'
];

function watchLaterButton(h) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'watch-later';
  button.title = '添加至稍后再看';
  button.setAttribute('aria-label', '添加至稍后再看');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  for (const data of WATCH_LATER_PATHS) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', data);
    svg.appendChild(path);
  }
  button.appendChild(svg);
  button.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('pending');
    button.title = '正在添加…';
    chrome.runtime.sendMessage({ type: MSG.ADD_WATCH_LATER, aid: h.aid }, resp => {
      button.classList.remove('pending');
      if (resp && resp.ok) {
        button.classList.add('done');
        button.title = '已加入稍后再看';
        button.setAttribute('aria-label', '已加入稍后再看');
      } else {
        button.disabled = false;
        button.title = (resp && resp.message) || '添加失败，请重试';
        button.setAttribute('aria-label', button.title);
      }
    });
  });
  return button;
}

function appendHit(wrap, h) {
  const it = document.createElement('div'); it.className = 'item';
  const cover = document.createElement('div'); cover.className = 'cover';
  const img = document.createElement('img');
  if (h.cover) { img.src = h.cover; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; }
  img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  cover.appendChild(img);
  if (h.attr === 0 && h.aid) cover.appendChild(watchLaterButton(h));
  it.appendChild(cover);
  const m = document.createElement('div'); m.className = 'm';
  const t = document.createElement('div'); t.className = 't'; t.textContent = h.title; m.appendChild(t);
  const s = document.createElement('div'); s.className = 's';
  s.textContent = (h.upperName ? h.upperName + ' · ' : '') + '投稿发布于 ' + h.years + ' 年前的今天';
  m.appendChild(s);
  const s2 = document.createElement('div'); s2.className = 's2';
  s2.textContent = '来源：' + (h.folderName || '未命名');
  m.appendChild(s2);
  it.appendChild(m);
  it.addEventListener('click', () => chrome.tabs.create({ url: 'https://www.bilibili.com/video/' + encodeURIComponent(h.bvid) }));
  wrap.appendChild(it);
}

function renderHitList(wrap, hits, emptyText) {
  wrap.innerHTML = '';
  if (!hits.length) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = emptyText;
    wrap.appendChild(e);
    return;
  }
  for (const h of hits) appendHit(wrap, h);
}

function render(v) {
  view = v;

  // 首次使用（从未同步过）：只显示欢迎面板 + 进入哔哩哔哩按钮
  const firstUse = !v.syncedOnce;
  $('welcomeBox').style.display = firstUse ? 'block' : 'none';
  $('mainBox').style.display = firstUse ? 'none' : 'block';
  if (firstUse) {
    $('welcomeText').innerHTML = v.firstSetupReason === 'accountChanged'
      ? '检测到 B 站账号已切换。<br />旧账号收藏数据已清理，扩展设置已保留。<br />请进入哔哩哔哩重新选择收藏夹。'
      : '欢迎使用！<br />同步收藏夹后，每次打开哔哩哔哩首页，<br />就能看到「投稿发布于 X 年前的今天」提醒。';
    return;
  }

  pillLogin(v);
  $('effDate').textContent = v.dateKey + (v.simulated ? '（模拟）' : '');

  // 调试提示
  const hint = $('debugHint');
  hint.innerHTML = '';
  if (v.simulated) {
    hint.style.display = 'flex';
    const text = document.createElement('span');
    text.textContent = `模拟首页日期 ${v.dateKey} 生效中（真实今天 ${todayKey()}）`;
    const restore = document.createElement('button');
    restore.type = 'button'; restore.textContent = '恢复真实今天';
    restore.addEventListener('click', () => sendDebugDate(''));
    hint.append(text, restore);
  } else hint.style.display = 'none';

  // 命中列表
  const wrap = $('items');
  const hits = v.hits || [];
  if (v.loginState === 'no') {
    renderHitList(wrap, [], '未登录哔哩哔哩，无法读取收藏夹。');
  } else {
    renderHitList(wrap, hits, v.simulated ? '该模拟日期下没有命中' : '今天没有符合条件的历史投稿');
  }

  // 概览
  $('folderInfo').textContent = `${v.folders.enabled} 夹 · ${v.folders.items} 条 · ${syncModeLabel(v)}`;
  $('syncLabel').textContent = v.syncing ? '同步：' : '最近同步：';
  $('syncInfo').textContent = v.syncing ? '同步中' : (v.lastSyncAt ? fmtDateTime(v.lastSyncAt) : '从未');
  $('btnCancelSync').style.display = v.syncing ? 'inline-block' : 'none';
  $('syncActions').style.display = v.syncing ? 'block' : 'none';
  const note = $('syncNote');
  if (v.syncing && v.syncLabel) { note.style.display = 'block'; note.textContent = v.syncLabel; }
  else note.style.display = 'none';

}

function apply(r) { if (r && r.v) render(r); }

function sendDebugDate(date) {
  chrome.runtime.sendMessage({ type: MSG.SET_DEBUG_DATE, date }, r => apply(r));
}

function askView() {
  chrome.runtime.sendMessage({ type: MSG.GET_VIEW }, r => apply(r));
}

function localDateKey(year, month, day) {
  return year + '-' + pad2(month + 1) + '-' + pad2(day);
}

function setActiveView(next) {
  activeView = next === 'calendar' ? 'calendar' : 'today';
  const isCalendar = activeView === 'calendar';
  $('todayPanel').hidden = isCalendar;
  $('calendarPanel').hidden = !isCalendar;
  $('tabToday').classList.toggle('active', !isCalendar);
  $('tabCalendar').classList.toggle('active', isCalendar);
  $('tabToday').setAttribute('aria-selected', String(!isCalendar));
  $('tabCalendar').setAttribute('aria-selected', String(isCalendar));
  if (isCalendar && !calendarSummary) loadCalendarYear(calendarYear, true);
}

function loadCalendarYear(year, keepSelection) {
  const seq = ++calendarRequestSeq;
  chrome.runtime.sendMessage({ type: MSG.GET_CALENDAR_YEAR, year }, summary => {
    if (seq !== calendarRequestSeq || !summary || !summary.days) return;
    calendarSummary = summary;
    calendarYear = summary.year;
    if (!keepSelection || !calendarSelected.startsWith(calendarYear + '-')) {
      calendarSelected = localDateKey(calendarYear, calendarMonth, 1);
    }
    renderCalendar();
    loadCalendarDate(calendarSelected);
  });
}

function loadCalendarDate(dateKey) {
  calendarSelected = dateKey;
  renderCalendar();
  const wrap = $('calendarItems');
  wrap.innerHTML = '<div class="calendar-loading">正在读取…</div>';
  chrome.runtime.sendMessage({ type: MSG.GET_DATE_HITS, date: dateKey }, result => {
    if (!result || result.dateKey !== calendarSelected) return;
    const p = result.dateKey.split('-').map(Number);
    const hits = result.hits || [];
    $('calendarSelectedTitle').textContent = `${p[1]} 月 ${p[2]} 日 · 历史上的今天`;
    $('calendarSelectedCount').textContent = `${hits.length} 条`;
    renderHitList(wrap, hits, '这一天暂时没有历史投稿');
  });
}

function renderCalendar() {
  if (!calendarSummary) return;
  const panel = $('calendarPanel');
  panel.classList.toggle('calendar-collapsed', calendarCollapsed);
  const collapseButton = $('calendarCollapse');
  collapseButton.textContent = calendarCollapsed ? '展开日历 ↓' : '收起日历 ↑';
  collapseButton.setAttribute('aria-expanded', String(!calendarCollapsed));
  $('calendarTitle').textContent = `${calendarYear} 年 ${calendarMonth + 1} 月`;
  const days = $('calendarDays');
  days.innerHTML = '';
  const first = new Date(calendarYear, calendarMonth, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(calendarYear, calendarMonth, 1 - offset);
  const realKey = todayKey();
  let firstCell = 0;
  let lastCell = 42;
  if (calendarCollapsed) {
    const selectedParts = calendarSelected.split('-').map(Number);
    const selectedDate = new Date(selectedParts[0], selectedParts[1] - 1, selectedParts[2]);
    const selectedOffset = Math.round((selectedDate - start) / 86400000);
    firstCell = Math.max(0, Math.min(35, Math.floor(selectedOffset / 7) * 7));
    lastCell = firstCell + 7;
  }
  for (let i = firstCell; i < lastCell; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = localDateKey(d.getFullYear(), d.getMonth(), d.getDate());
    const count = calendarSummary.days[key] || 0;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'calendar-day' +
      (d.getMonth() !== calendarMonth ? ' outside' : '') +
      (key === realKey ? ' today' : '') +
      (key === calendarSelected ? ' selected' : '');
    b.setAttribute('role', 'gridcell');
    b.setAttribute('aria-label', `${d.getMonth() + 1} 月 ${d.getDate()} 日，${count} 条历史投稿`);
    const number = document.createElement('span'); number.textContent = d.getDate();
    b.appendChild(number);
    if (count) {
      const n = document.createElement('span'); n.className = 'calendar-count'; n.textContent = count + ' 条';
      b.appendChild(n);
    }
    b.addEventListener('click', () => {
      const targetYear = d.getFullYear();
      calendarMonth = d.getMonth();
      calendarSelected = key;
      if (targetYear !== calendarYear) loadCalendarYear(targetYear, true);
      else loadCalendarDate(key);
    });
    days.appendChild(b);
  }
  const minYear = calendarSummary.minYear || calendarYear;
  const maxYear = calendarSummary.maxYear || calendarYear;
  $('calendarPrevYear').disabled = calendarYear <= minYear;
  $('calendarNextYear').disabled = calendarYear >= maxYear;
  $('calendarPrevMonth').disabled = calendarYear <= minYear && calendarMonth === 0;
  $('calendarNextMonth').disabled = calendarYear >= maxYear && calendarMonth === 11;
}

function moveCalendarMonth(delta) {
  const d = new Date(calendarYear, calendarMonth + delta, 1);
  if (!calendarSummary) return;
  if (d.getFullYear() < calendarSummary.minYear || d.getFullYear() > calendarSummary.maxYear) return;
  calendarMonth = d.getMonth();
  calendarSelected = localDateKey(d.getFullYear(), d.getMonth(), 1);
  if (d.getFullYear() !== calendarYear) loadCalendarYear(d.getFullYear(), true);
  else loadCalendarDate(calendarSelected);
}

function moveCalendarYear(delta) {
  if (!calendarSummary) return;
  const target = calendarYear + delta;
  if (target < calendarSummary.minYear || target > calendarSummary.maxYear) return;
  calendarSelected = localDateKey(target, calendarMonth, 1);
  loadCalendarYear(target, true);
}

let syncScope = 'all';   // 本次同步范围：全部 / 仅自建 / 仅追更

document.addEventListener('DOMContentLoaded', () => {
  $('btnGoStart').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.bilibili.com/', active: true });
  });
  $('tabToday').addEventListener('click', () => setActiveView('today'));
  $('tabCalendar').addEventListener('click', () => setActiveView('calendar'));
  $('calendarPrevMonth').addEventListener('click', () => moveCalendarMonth(-1));
  $('calendarNextMonth').addEventListener('click', () => moveCalendarMonth(1));
  $('calendarPrevYear').addEventListener('click', () => moveCalendarYear(-1));
  $('calendarNextYear').addEventListener('click', () => moveCalendarYear(1));
  $('calendarCollapse').addEventListener('click', () => {
    calendarCollapsed = !calendarCollapsed;
    renderCalendar();
  });
  $('calendarToday').addEventListener('click', () => {
    const now = new Date();
    calendarMonth = now.getMonth();
    calendarSelected = todayKey();
    if (calendarYear !== now.getFullYear()) loadCalendarYear(now.getFullYear(), true);
    else loadCalendarDate(calendarSelected);
  });
  document.querySelectorAll('.scope-btn').forEach(b => {
    b.addEventListener('click', () => {
      syncScope = b.dataset.scope;
      document.querySelectorAll('.scope-btn').forEach(x => x.classList.toggle('active', x === b));
    });
  });
  $('btnSync').addEventListener('click', () => syncNow(false));
  $('btnFull').addEventListener('click', () => syncNow(true));
  $('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('btnCancelSync').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: MSG.CANCEL_SYNC });
  });
  askView();
});

function syncNow(full) {
  // 全量耗时提醒：启用夹官方条目数之和超过阈值时，先确认再开始
  if (full && view) {
    const total = (view.foldersDetailed || [])
      .filter(f => f.enabled && (syncScope === 'all' || f.source === syncScope))
      .reduce((s, f) => s + (f.mediaCount || 0), 0);
    if (total > CFG.FULL_SYNC_CONFIRM_THRESHOLD &&
        !confirm(`本次全量同步将处理约 ${total} 条收藏，可能需要较长时间，是否继续？`)) return;
  }
  chrome.runtime.sendMessage({ type: MSG.SYNC_NOW, full, scope: syncScope }, r => {
    if (r && r.busy) {
      const note = $('syncNote');
      note.style.display = 'block';
      note.textContent = '已有同步正在进行中。';
      return;
    }
    if (r && r.cooldown) {
      // 冷却中：给可见提示，不轮询（区分 412 风控 / 配额暂停）
      const note = $('syncNote');
      note.style.display = 'block';
      note.textContent = cooldownText(r.seconds, r.reason);
      return;
    }
    if (r && r.openingHome) {
      // 后台已自动打开 B 站首页（前台可见），页面加载完成后会自动接续本次同步
      return;
    }
    if (r && r.needHome) {
      // 兜底：无可用 B 站标签
      chrome.tabs.create({ url: 'https://www.bilibili.com/', active: true });
      return;
    }
    // 开启轮询进度
    let n = 0;
    const iv = setInterval(() => {
      askView();
      if (++n >= 40 || !(view && view.syncing)) clearInterval(iv);
    }, 1200);
  });
}

/* 冷却文案：412=风控，其余=单段配额暂停 */
function cooldownText(seconds, reason) {
  const s = Math.max(1, seconds || 0);
  const t = s >= 60 ? Math.ceil(s / 60) + ' 分钟' : s + ' 秒';
  return reason === '412'
    ? 'B 站接口风控(412)冷却中，约 ' + t + ' 后自动续传，请勿关闭本页面。'
    : '同步暂停（单段配额已用完），约 ' + t + ' 后自动继续，请勿关闭本页面。';
}

/* 后台数据变化时自动刷新（如同步进度、设置改动）——防抖 */
let askTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[CFG.KEY_ITEMS] || changes[CFG.KEY_FOLDERS] || changes[CFG.KEY_SETTINGS]) calendarDirty = true;
  clearTimeout(askTimer);
  askTimer = setTimeout(() => {
    askView();
    if (calendarDirty) {
      calendarDirty = false;
      calendarSummary = null;
      if (activeView === 'calendar') loadCalendarYear(calendarYear, true);
    }
  }, 400);
});
