'use strict';
/* 哔哩朝花夕拾 - popup */
const $ = id => document.getElementById(id);

const MODE_LABEL = { manual: '手动', onHome: '首页每次', daily: '每天一次' };

let view = null;

function pillLogin(v) {
  const p = $('loginPill');
  if (v.loginState === 'ok') { p.textContent = '已登录'; p.className = 'pill ok'; }
  else if (v.loginState === 'no') { p.textContent = '未登录'; p.className = 'pill warn'; }
  else { p.textContent = '登录未知'; p.className = 'pill'; }
}

function render(v) {
  view = v;

  // 首次使用（从未同步过）：只显示欢迎面板 + 进入哔哩哔哩按钮
  const firstUse = !v.syncedOnce;
  $('welcomeBox').style.display = firstUse ? 'block' : 'none';
  $('mainBox').style.display = firstUse ? 'none' : 'block';
  if (firstUse) return;

  pillLogin(v);
  $('effDate').textContent = v.dateKey + (v.simulated ? '（模拟）' : '');

  // 调试提示
  const hint = $('debugHint');
  if (v.simulated) {
    hint.style.display = 'block';
    hint.textContent = `模拟日期生效中（真实今天 ${todayKey()}），首页浮层将按模拟日期计算。`;
  } else hint.style.display = 'none';

  // 命中列表
  const wrap = $('items');
  wrap.innerHTML = '';
  const hits = v.hits || [];
  if (v.loginState === 'no') {
    const e = document.createElement('div'); e.className = 'empty';
    e.textContent = '未登录哔哩哔哩，无法读取收藏夹。';
    wrap.appendChild(e);
  } else if (!hits.length) {
    const e = document.createElement('div'); e.className = 'empty';
    e.textContent = v.simulated ? '该模拟日期下没有命中' : '今天没有“历史上的今天”投稿';
    wrap.appendChild(e);
  } else {
    for (const h of hits) {
      const it = document.createElement('div'); it.className = 'item';
      const img = document.createElement('img');
      if (h.cover) { img.src = h.cover; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; }
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      it.appendChild(img);
      const m = document.createElement('div'); m.className = 'm';
      const t = document.createElement('div'); t.className = 't'; t.textContent = h.title; m.appendChild(t);
      const s = document.createElement('div'); s.className = 's';
      s.textContent = (h.upperName ? h.upperName + ' · ' : '') + h.years + ' 年前的今天（' + h.pubYear + ' 年发布）';
      m.appendChild(s);
      const s2 = document.createElement('div'); s2.className = 's2';
      s2.textContent = '来源：' + (h.folderName || '未命名');
      m.appendChild(s2);
      it.appendChild(m);
      it.addEventListener('click', () => chrome.tabs.create({ url: 'https://www.bilibili.com/video/' + encodeURIComponent(h.bvid) }));
      wrap.appendChild(it);
    }
  }

  // 概览
  $('folderInfo').textContent = `${v.folders.enabled}/${v.folders.total} 夹 · ${v.folders.items} 条` +
    ` · 同步模式：${MODE_LABEL[v.syncMode] || '手动'}`;
  $('syncInfo').textContent = v.syncing ? '同步中' : (v.lastSyncAt ? fmtDateTime(v.lastSyncAt) : '从未');
  $('btnCancelSync').style.display = v.syncing ? 'inline-block' : 'none';
  const note = $('syncNote');
  if (v.syncing && v.syncLabel) { note.style.display = 'block'; note.textContent = v.syncLabel; }
  else note.style.display = 'none';

  // 调试栏（模拟日期时显示，可随时改时间）
  const box = $('debugBox');
  const row = $('debugRow');
  row.innerHTML = '';
  if (v.simulated) {
    box.style.display = 'block';
    const lbl = document.createElement('span'); lbl.textContent = '模拟今天：';
    const input = document.createElement('input');
    input.type = 'date'; input.value = v.dateKey;
    input.addEventListener('change', () => {
      if (input.value) sendDebugDate(input.value);
    });
    const bPrev = mkBtn('前一天', () => shiftDate(-1));
    const bNext = mkBtn('后一天', () => shiftDate(1));
    const bReal = mkBtn('恢复真实', () => sendDebugDate(''));
    const bForce = mkBtn('重弹一次', () => chrome.runtime.sendMessage({ type: MSG.DEBUG_FORCE }, r => { if (r) apply(r); }));
    row.append(lbl, input, bPrev, bNext, bReal, bForce);
    if (v.avail && v.avail.length) {
      const sep = document.createElement('div'); sep.style.width = '100%'; row.appendChild(sep);
      for (const a of v.avail.slice(0, 8)) {
        const c = mkBtn(`${a.label}·${a.count}`, () => sendDebugDate(a.key));
        row.appendChild(c);
      }
    }
  } else box.style.display = 'none';
}

function mkBtn(label, fn) {
  const b = document.createElement('button');
  b.textContent = label; b.addEventListener('click', fn);
  return b;
}

function apply(r) { if (r && r.v) render(r); }

function sendDebugDate(date) {
  chrome.runtime.sendMessage({ type: MSG.SET_DEBUG_DATE, date }, r => apply(r));
}
function shiftDate(delta) {
  if (!view) return;
  const d = keyToDate(view.dateKey);
  d.setDate(d.getDate() + delta);
  sendDebugDate(dateKeyFromDate(d));
}

function askView() {
  chrome.runtime.sendMessage({ type: MSG.GET_VIEW }, r => apply(r));
}

let syncScope = 'all';   // 本次同步范围：全部 / 仅自建 / 仅追更

document.addEventListener('DOMContentLoaded', () => {
  $('btnGoStart').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.bilibili.com/', active: true });
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
      }
    });
  });
  $('btnCancelSync').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: MSG.CANCEL_SYNC });
  });
  askView();
});

function syncNow(full) {
  chrome.runtime.sendMessage({ type: MSG.SYNC_NOW, full, scope: syncScope }, r => {
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
    ? 'B 站接口风控(412)冷却中，约 ' + t + ' 后自动续传。'
    : '同步暂停（单段配额已用完），约 ' + t + ' 后自动继续。';
}

/* 后台数据变化时自动刷新（如同步进度、设置改动）——防抖 */
let askTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  clearTimeout(askTimer);
  askTimer = setTimeout(askView, 400);
});
