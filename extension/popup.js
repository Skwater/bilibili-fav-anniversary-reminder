'use strict';
/* 哔哩朝花夕拾 - popup */
const $ = id => document.getElementById(id);

// 仅当单行省略号实际生效时，才启用浏览器原生悬停提示。
function enableOverflowTitle(element) {
  element.addEventListener('mouseenter', () => {
    if (element.scrollWidth > element.clientWidth) element.title = element.textContent || '';
    else element.removeAttribute('title');
  });
}

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
let reviewLoaded = false;
let reviewRequestSeq = 0;
let reviewDirty = false;
let setupStage = 'entry';
let setupSelected = null;
let setupFolderSignature = '';
let setupError = '';
let setupAccountMid = 0;
const SETUP_UI_KEY = 'dshPopupSetup';

function saveSetupUi() {
  chrome.storage.session.set({ [SETUP_UI_KEY]: {
    stage: setupStage,
    selectedIds: [...(setupSelected || [])],
    folderSignature: setupFolderSignature,
    accountMid: setupAccountMid
  } });
}

function pillLogin(v) {
  const p = $('loginPill');
  if (v.loginState === 'ok') { p.textContent = v.accountMid ? ('UID ' + maskUid(v.accountMid)) : '已登录'; p.className = 'pill ok'; }
  else if (v.loginState === 'no') { p.textContent = '未登录'; p.className = 'pill warn'; }
  else { p.textContent = '登录未知'; p.className = 'pill'; }
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
  button.classList.toggle('done', !!inWatchLater);
  button.dataset.inWatchLater = inWatchLater ? '1' : '0';
  button.disabled = false;
  const label = inWatchLater ? '移出稍后再看' : '添加至稍后再看';
  button.title = label;
  button.setAttribute('aria-label', label);
}

function watchLaterButton(h) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'watch-later';
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
    button.classList.add('pending');
    button.title = wasInWatchLater ? '正在移出…' : '正在添加…';
    chrome.runtime.sendMessage({ type: wasInWatchLater ? MSG.REMOVE_WATCH_LATER : MSG.ADD_WATCH_LATER, aid: h.aid }, resp => {
      button.classList.remove('pending');
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
  const t = document.createElement('div'); t.className = 't'; t.textContent = h.title;
  enableOverflowTitle(t);
  m.appendChild(t);
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

function renderSetupFolders(folders) {
  const readable = folders.filter(f => f.readable !== false);
  const signature = readable.map(f => f.mediaId).join(',');
  if (setupFolderSignature !== signature || !setupSelected) {
    setupFolderSignature = signature;
    setupSelected = new Set(readable.filter(f => f.enabled !== false).map(f => f.mediaId));
  }
  const list = $('setupFolders');
  list.innerHTML = '';
  const updateCount = () => {
    $('setupCount').textContent = `已选 ${setupSelected.size} 个`;
    $('setupStart').disabled = setupSelected.size === 0;
  };
  for (const [source, title] of [['created', '我创建的'], ['collected', '追更的（收藏的）']]) {
    const items = readable.filter(f => (f.source || 'created') === source);
    if (!items.length) continue;
    const head = document.createElement('div');
    head.className = 'setup-group-head';
    const label = document.createElement('span');
    label.textContent = `${title}（${items.length}）`;
    const all = document.createElement('button');
    all.type = 'button'; all.textContent = '全选';
    const none = document.createElement('button');
    none.type = 'button'; none.textContent = '全不选';
    const checkboxes = [];
    const setGroup = checked => {
      for (let i = 0; i < items.length; i++) {
        checkboxes[i].checked = checked;
        if (checked) setupSelected.add(items[i].mediaId);
        else setupSelected.delete(items[i].mediaId);
      }
      updateCount();
      saveSetupUi();
    };
    all.addEventListener('click', () => setGroup(true));
    none.addEventListener('click', () => setGroup(false));
    head.append(label, all, none);
    list.appendChild(head);
    for (const f of items) {
      const row = document.createElement('label');
      row.className = 'setup-folder';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = setupSelected.has(f.mediaId);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) setupSelected.add(f.mediaId);
        else setupSelected.delete(f.mediaId);
        updateCount();
        saveSetupUi();
      });
      checkboxes.push(checkbox);
      const name = document.createElement('span');
      name.className = 'setup-folder-name'; name.textContent = f.title;
      name.title = f.title;
      const count = document.createElement('span');
      count.className = 'setup-folder-count'; count.textContent = `${f.mediaCount || 0} 项`;
      row.append(checkbox, name, count);
      list.appendChild(row);
    }
  }
  updateCount();
}

function openBiliTab() {
  chrome.tabs.query({ url: ['https://*.bilibili.com/*'] }, tabs => {
    if (tabs && tabs.length) chrome.tabs.update(tabs[0].id, { active: true });
    else chrome.tabs.create({ url: 'https://www.bilibili.com/', active: true });
  });
}

function render(v) {
  view = v;

  // 首次同步完成前显示引导或当前同步状态。
  const firstUse = !v.syncedOnce;
  if (firstUse && v.accountMid && setupAccountMid && v.accountMid !== setupAccountMid) {
    setupStage = 'entry';
    setupSelected = null;
    setupFolderSignature = '';
  }
  if (v.accountMid) setupAccountMid = v.accountMid;
  if (!firstUse) chrome.storage.session.remove(SETUP_UI_KEY);
  const progress = firstUse && !v.loadingFolders && (v.syncing || v.cooldownSec > 0 || v.firstSyncPending);
  const selecting = firstUse && setupStage === 'select' && v.biliTabOpen && v.loginState === 'ok' &&
    !progress;
  $('welcomeBox').style.display = firstUse && !selecting && !progress ? 'flex' : 'none';
  $('setupSelectBox').style.display = selecting ? 'flex' : 'none';
  $('setupProgressBox').style.display = progress ? 'flex' : 'none';
  $('mainBox').style.display = firstUse ? 'none' : 'flex';
  if (firstUse) {
    if (progress) {
      const title = $('setupProgressTitle');
      const message = $('setupProgressText');
      const resume = $('btnResumeFirst');
      resume.style.display = 'none';
      if (v.cooldownSec > 0) {
        const wait = v.cooldownSec >= 60 ? `${Math.ceil(v.cooldownSec / 60)} 分钟` : `${v.cooldownSec} 秒`;
        title.textContent = '首次同步暂停中';
        message.textContent = `触发 B 站接口风控（412），约 ${wait} 后自动续传。请不要关闭哔哩哔哩页面。`;
      } else if (v.syncing) {
        title.textContent = '首次同步进行中';
        message.textContent = `${v.syncLabel || '正在同步所选收藏夹，请稍候。'} 请不要关闭哔哩哔哩页面。`;
      } else {
        title.textContent = '首次同步待继续';
        message.textContent = v.note || '同步已中断，进度已保存。';
        resume.style.display = 'block';
        resume.textContent = v.biliTabOpen ? '继续首次同步' : '打开哔哩哔哩并继续';
      }
      return;
    }
    const hasSelectableFolders = v.foldersDetailed.some(f => f.readable !== false);
    if (selecting) {
      $('setupFolders').style.display = hasSelectableFolders ? 'block' : 'none';
      $('setupFoot').style.display = hasSelectableFolders ? 'block' : 'none';
      $('btnRetryFolders').style.display = !hasSelectableFolders && !v.loadingFolders ? 'block' : 'none';
      $('setupSelectNote').textContent = setupError || (hasSelectableFolders
        ? '勾选收藏夹后开始首次同步。'
        : (v.loadingFolders ? '正在读取收藏夹列表…'
          : (v.note && /失败|中断|出错/.test(v.note)
            ? v.note : '尚未读到可选择的收藏夹，请重新读取。')));
      if (hasSelectableFolders) renderSetupFolders(v.foldersDetailed);
      return;
    }
    $('btnGoStart').style.display = 'block';
    $('setupQuickActions').style.display = v.biliTabOpen ? 'flex' : 'none';
    $('btnEnterSetup').disabled = v.loginState !== 'ok';
    $('btnEnterSetup').textContent = '首次同步';
    $('btnGoStart').textContent = '进入哔哩哔哩';
    const status = $('welcomeStatus');
    status.style.display = 'none';
    if (!v.biliTabOpen) {
      setupStage = 'entry';
      $('welcomeText').textContent = '先进入哔哩哔哩。打开后重新点开插件，即可读取登录状态并开始首次同步。';
    } else if (v.loginState === 'no') {
      status.style.display = 'block';
      status.textContent = '请先登录哔哩哔哩';
      $('welcomeText').textContent = '登录后点击下方“读取登录状态”，再进行首次同步。';
    } else if (v.loginState === 'unknown' && v.loginError) {
      status.style.display = 'block';
      status.textContent = '暂时无法读取账号';
      $('welcomeText').textContent = v.loginError;
    } else if (v.loginState !== 'ok') {
      status.style.display = 'block';
      status.textContent = '正在确认登录状态';
      $('welcomeText').textContent = '点击下方“读取登录状态”进行检查。';
    } else {
      status.style.display = 'block';
      status.textContent = v.accountMid ? `已登录 · UID ${maskUid(v.accountMid)}` : '已登录哔哩哔哩';
      $('welcomeText').textContent = v.firstSetupReason === 'accountChanged'
        ? '检测到 B 站账号已切换。旧账号数据已清理，请重新选择要同步的收藏夹。'
        : '哔哩哔哩已打开。接下来选择收藏夹，完成首次同步后即可查看每日提醒。';
    }
    return;
  }

  pillLogin(v);
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
  activeView = next === 'calendar' || next === 'review' ? next : 'today';
  const views = [
    { name: 'today', tab: $('tabToday'), panel: $('todayPanel') },
    { name: 'review', tab: $('tabReview'), panel: $('reviewPanel') },
    { name: 'calendar', tab: $('tabCalendar'), panel: $('calendarPanel') }
  ];
  for (const item of views) {
    const active = item.name === activeView;
    item.panel.hidden = !active;
    item.tab.classList.toggle('active', active);
    item.tab.setAttribute('aria-selected', String(active));
  }
  if (activeView === 'review' && (!reviewLoaded || reviewDirty)) loadSevenDayReview();
  if (activeView === 'calendar' && !calendarSummary) loadCalendarYear(calendarYear, true);
}

function reviewDateParts(dateKey) {
  const parts = String(dateKey || '').split('-').map(Number);
  return { month: parts[1] || 0, day: parts[2] || 0 };
}

function renderSevenDayReview(review) {
  const timeline = $('reviewTimeline');
  timeline.innerHTML = '';
  const days = Array.isArray(review.days) ? review.days : [];
  days.forEach((entry, index) => {
    const parts = reviewDateParts(entry.dateKey);
    const hits = Array.isArray(entry.hits) ? entry.hits : [];
    const section = document.createElement('section');
    section.className = 'review-day';

    const marker = document.createElement('div');
    marker.className = 'review-date';
    marker.setAttribute('aria-label', `${parts.month} 月 ${parts.day} 日`);
    const day = document.createElement('span');
    day.className = 'review-date-day';
    day.textContent = parts.day;
    const month = document.createElement('span');
    month.className = 'review-date-month';
    month.textContent = parts.month + ' 月';
    marker.append(day, month);

    const content = document.createElement('div');
    content.className = 'review-day-content';
    const head = document.createElement('div');
    head.className = 'review-day-head';
    const label = document.createElement('span');
    label.className = 'review-day-label';
    label.textContent = index === 0 ? '今天' : (index === 1 ? '昨天' : `${index} 天前`);
    const count = document.createElement('span');
    count.className = 'review-day-count';
    count.textContent = `${hits.length} 条`;
    head.append(label, count);
    content.appendChild(head);
    if (hits.length) {
      for (const hit of hits) appendHit(content, hit);
    } else {
      const empty = document.createElement('div');
      empty.className = 'review-day-empty';
      empty.textContent = '这一天没有纪念投稿';
      content.appendChild(empty);
    }
    section.append(marker, content);
    timeline.appendChild(section);
  });

  const start = reviewDateParts(review.startKey);
  const end = reviewDateParts(review.endKey);
  const note = document.createElement('div');
  note.className = 'review-range-note';
  note.textContent = `${start.month} 月 ${start.day} 日—${end.month} 月 ${end.day} 日 · 共 ${review.total || 0} 条纪念投稿`;
  timeline.appendChild(note);
}

function loadSevenDayReview() {
  const seq = ++reviewRequestSeq;
  reviewDirty = false;
  $('reviewTimeline').innerHTML = '<div class="review-loading">正在读取…</div>';
  chrome.runtime.sendMessage({ type: MSG.GET_SEVEN_DAY_REVIEW }, review => {
    if (seq !== reviewRequestSeq || !review || !Array.isArray(review.days)) return;
    reviewLoaded = true;
    renderSevenDayReview(review);
  });
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
  $('btnGoStart').addEventListener('click', openBiliTab);
  $('btnCheckLogin').addEventListener('click', () => {
    $('btnCheckLogin').disabled = true;
    chrome.runtime.sendMessage({ type: MSG.CHECK_LOGIN }, r => {
      $('btnCheckLogin').disabled = false;
      apply(r);
    });
  });
  $('btnEnterSetup').addEventListener('click', () => {
    if (!view || !view.biliTabOpen || view.loginState !== 'ok') return;
    if (view.firstSyncPending) {
      chrome.runtime.sendMessage({ type: MSG.SYNC_NOW, full: true }, () => askView());
      return;
    }
    setupStage = 'select';
    setupError = '';
    saveSetupUi();
    render(view);
    if (!view.foldersDetailed.some(f => f.readable !== false)) {
      chrome.runtime.sendMessage({ type: MSG.REFRESH_FOLDERS }, () => askView());
    }
  });
  $('btnSetupBack').addEventListener('click', () => {
    setupStage = 'entry';
    setupError = '';
    saveSetupUi();
    render(view);
  });
  $('btnRetryFolders').addEventListener('click', () => {
    $('btnRetryFolders').disabled = true;
    chrome.runtime.sendMessage({ type: MSG.REFRESH_FOLDERS }, () => {
      $('btnRetryFolders').disabled = false;
      askView();
    });
  });
  $('btnResumeFirst').addEventListener('click', () => {
    if (!view || !view.biliTabOpen) { openBiliTab(); return; }
    chrome.runtime.sendMessage({ type: MSG.SYNC_NOW, full: true }, () => askView());
  });
  $('setupAll').addEventListener('click', () => {
    setupSelected = new Set((view.foldersDetailed || []).filter(f => f.readable !== false).map(f => f.mediaId));
    saveSetupUi();
    render(view);
  });
  $('setupNone').addEventListener('click', () => {
    setupSelected = new Set();
    saveSetupUi();
    render(view);
  });
  $('setupStart').addEventListener('click', () => {
    const ids = [...(setupSelected || [])];
    if (!ids.length || !view) return;
    const total = fullSyncItemTotal(view.foldersDetailed, 'all', ids);
    if (total > CFG.FULL_SYNC_CONFIRM_THRESHOLD &&
        !confirm(`本次全量同步将处理约 ${total} 条收藏，可能需要较长时间，是否继续？`)) return;
    $('setupStart').disabled = true;
    chrome.runtime.sendMessage({ type: MSG.SYNC_NOW, full: true, folderIds: ids }, r => {
      if (r && (r.started || r.openingHome || r.busy)) { setupError = ''; askView(); return; }
      setupError = r && r.cooldown ? cooldownText(r.seconds) :
        (r && r.accountChanged ? '检测到账号切换，请重新选择收藏夹。' : '同步未能启动，请重试。');
      askView();
    });
  });
  $('setupStop').addEventListener('click', () => chrome.runtime.sendMessage({ type: MSG.CANCEL_SYNC }, () => askView()));
  $('loginPill').addEventListener('click', () => {
    openBiliTab();
  });
  $('tabToday').addEventListener('click', () => setActiveView('today'));
  $('tabReview').addEventListener('click', () => setActiveView('review'));
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
  chrome.storage.session.get(SETUP_UI_KEY, saved => {
    const state = saved && saved[SETUP_UI_KEY];
    if (state && state.stage === 'select') {
      setupStage = 'select';
      setupSelected = new Set(state.selectedIds || []);
      setupFolderSignature = state.folderSignature || '';
      setupAccountMid = state.accountMid || 0;
    }
    askView();
  });
});

function syncNow(full) {
  // 全量耗时提醒：启用夹官方条目数之和超过阈值时，先确认再开始
  if (full && view) {
    const total = fullSyncItemTotal(view.foldersDetailed, syncScope);
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
      // 冷却中：给可见提示，不轮询
      const note = $('syncNote');
      note.style.display = 'block';
      note.textContent = cooldownText(r.seconds);
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

/* 只有实际命中 412 才会进入冷却。 */
function cooldownText(seconds) {
  const s = Math.max(1, seconds || 0);
  const t = s >= 60 ? Math.ceil(s / 60) + ' 分钟' : s + ' 秒';
  return 'B 站接口风控(412)冷却中，约 ' + t + ' 后自动续传，请勿关闭本页面。';
}

/* 后台数据变化时自动刷新（如同步进度、设置改动）——防抖 */
let askTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[CFG.KEY_ITEMS] || changes[CFG.KEY_FOLDERS] || changes[CFG.KEY_SETTINGS]) {
    calendarDirty = true;
    reviewDirty = true;
  }
  clearTimeout(askTimer);
  askTimer = setTimeout(() => {
    askView();
    if (calendarDirty) {
      calendarDirty = false;
      calendarSummary = null;
      if (activeView === 'calendar') loadCalendarYear(calendarYear, true);
    }
    if (reviewDirty && activeView === 'review') loadSevenDayReview();
  }, 400);
});
