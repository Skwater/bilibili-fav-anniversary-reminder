'use strict';
/* 哔哩朝花夕拾 - popup */
const $ = id => document.getElementById(id);

const MODE_LABEL = { manual: '手动', onHome: '首页每次', daily: '每天一次' };

let view = null;
let activeView = 'today';
const realToday = new Date();
let calendarYear = realToday.getFullYear();
let calendarMonth = realToday.getMonth();
let calendarSelected = todayKey();
let calendarSummary = null;
let calendarRequestSeq = 0;
let calendarDirty = false;

function pillLogin(v) {
  const p = $('loginPill');
  if (v.loginState === 'ok') { p.textContent = v.accountMid ? ('UID ' + v.accountMid) : '已登录'; p.className = 'pill ok'; }
  else if (v.loginState === 'no') { p.textContent = '未登录'; p.className = 'pill warn'; }
  else { p.textContent = '登录未知'; p.className = 'pill'; }
}

function appendHit(wrap, h) {
  const it = document.createElement('div'); it.className = 'item';
  const img = document.createElement('img');
  if (h.cover) { img.src = h.cover; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; }
  img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  it.appendChild(img);
  const m = document.createElement('div'); m.className = 'm';
  const t = document.createElement('div'); t.className = 't'; t.textContent = h.title; m.appendChild(t);
  const s = document.createElement('div'); s.className = 's';
  s.textContent = (h.upperName ? h.upperName + ' · ' : '') + h.years + ' 年前（' + h.pubYear + ' 年发布）';
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
      : '欢迎使用！<br />同步收藏夹后，每次打开哔哩哔哩首页，<br />就能看到「历史上的今天」收藏提醒。';
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
    renderHitList(wrap, hits, v.simulated ? '该模拟日期下没有命中' : '今天没有“历史上的今天”投稿');
  }

  // 概览
  $('folderInfo').textContent = `${v.folders.enabled}/${v.folders.total} 夹 · ${v.folders.items} 条` +
    ` · 同步模式：${MODE_LABEL[v.syncMode] || '手动'}`;
  $('syncInfo').textContent = v.syncing ? '同步中' : (v.lastSyncAt ? fmtDateTime(v.lastSyncAt) : '从未');
  $('btnCancelSync').style.display = v.syncing ? 'inline-block' : 'none';
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
  $('calendarTitle').textContent = `${calendarYear} 年 ${calendarMonth + 1} 月`;
  const days = $('calendarDays');
  days.innerHTML = '';
  const first = new Date(calendarYear, calendarMonth, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(calendarYear, calendarMonth, 1 - offset);
  const realKey = todayKey();
  for (let i = 0; i < 42; i++) {
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
  $('btnRefreshFolders').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: MSG.REFRESH_FOLDERS }, r => {
      if (r && r.cooldown) {
        const n = $('syncNote');
        n.style.display = 'block';
        n.textContent = cooldownText(r.seconds, r.reason);
      } else if (r && r.busy) {
        const n = $('syncNote');
        n.style.display = 'block';
        n.textContent = '已有同步正在进行中。';
      }
    });
  });
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
