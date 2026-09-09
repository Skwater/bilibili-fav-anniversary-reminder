'use strict';
/* 哔哩朝花夕拾 - options（设置页） */
const $ = id => document.getElementById(id);

let settings = null;
let view = null;
let syncScope = 'all';   // 本次同步范围：全部 / 仅自建 / 仅追更
const collapsedGroups = new Set();   // 记录被折叠的分组（'created' / 'collected'），重绘时保持折叠

function getView() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: MSG.GET_VIEW }, r => resolve(r || null));
  });
}

async function loadAll() {
  settings = await loadSettings();
  return settings;
}

function renderView(v) {
  view = v;
  const login = $('loginStatus');
  if (v.loginState === 'ok') login.textContent = '✅ 已登录哔哩哔哩';
  else if (v.loginState === 'no') login.textContent = '⚠️ 未登录哔哩哔哩，请先登录';
  else login.textContent = '登录状态未知' + (v.loginError ? '：' + v.loginError : '');

  const sync = $('syncStatus');
  const parts = [`收藏夹：${v.folders.enabled}/${v.folders.total} 个启用`, `条目：${v.folders.items} 条`];
  parts.push(v.syncing ? '同步中…' : (v.lastSyncAt ? '最近同步：' + fmtDateTime(v.lastSyncAt) : '尚未同步'));
  sync.textContent = parts.join('　');
  if (v.syncing && v.syncLabel) sync.textContent += '\n' + v.syncLabel;

  const eff = $('effNow');
  eff.textContent = v.dateKey + (v.simulated ? '（模拟日期）' : '（真实今天）');
  if (document.activeElement !== $('debugDate')) $('debugDate').value = v.dateKey;

  // 可用日期 chips（有收藏内容的 MM-DD）
  const box = $('availChips');
  box.innerHTML = '';
  if (v.avail && v.avail.length) {
    const t = document.createElement('span'); t.className = 'muted';
    t.textContent = '收藏中出现过的日期（点击设为模拟日期）：';
    box.appendChild(t);
    for (const a of v.avail.slice(0, 14)) {
      const c = document.createElement('button');
      c.className = 'chip'; c.textContent = `${a.label}·${a.count}条`;
      c.addEventListener('click', () => setDebugDate(a.key));
      box.appendChild(c);
    }
  }
}

async function renderFolders() {
  const o = await storageGet(CFG.KEY_FOLDERS);
  const folders = Array.isArray(o[CFG.KEY_FOLDERS]) ? o[CFG.KEY_FOLDERS] : [];
  const selFolders = folders.filter(f => f.enabled !== false && f.readable !== false).length;
  const totalFolders = folders.length;
  const selItems = folders.reduce((s, f) => s + ((f.enabled !== false && f.readable !== false) ? (f.mediaCount || 0) : 0), 0);
  const totalItems = folders.reduce((s, f) => s + (f.mediaCount || 0), 0);
  $('folderCount').textContent = `选中 ${selFolders}/${totalFolders} 个 · 共计 ${selItems}/${totalItems} 条`;
  const list = $('folderList');
  list.innerHTML = '';
  if (!folders.length) {
    const d = document.createElement('div'); d.className = 'muted';
    d.textContent = '尚未拉到收藏夹列表——请先打开哔哩哔哩首页触发同步。';
    list.appendChild(d);
    return;
  }
  // 按来源分组：我创建的 / 追更的（收藏的）——组头可点击折叠，默认展开；重绘保持折叠状态
  const addGroup = (title, key, items) => {
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = 'fgroup-title fgroup-toggle';
    const caret = document.createElement('span');
    caret.className = 'fgroup-caret';
    caret.textContent = collapsedGroups.has(key) ? '▸' : '▾';
    const t = document.createElement('span');
    t.className = 'fgroup-t';
    t.textContent = title;
    const c = document.createElement('span');
    c.className = 'cnt';
    c.textContent = `${items.length} 个`;
    const bAll = document.createElement('button');
    bAll.type = 'button';
    bAll.className = 'mini-btn';
    bAll.textContent = '全选';
    bAll.addEventListener('click', (e) => {
      e.stopPropagation();
      setManyFolderEnabled(items.map(x => x.mediaId), true);
    });
    const bNone = document.createElement('button');
    bNone.type = 'button';
    bNone.className = 'mini-btn';
    bNone.textContent = '全不选';
    bNone.addEventListener('click', (e) => {
      e.stopPropagation();
      setManyFolderEnabled(items.map(x => x.mediaId), false);
    });
    h.append(caret, t, c, bAll, bNone);
    const body = document.createElement('div');
    body.className = 'fgroup-body';
    if (collapsedGroups.has(key)) body.style.display = 'none';
    for (const f of items) {
      const row = document.createElement('div'); row.className = 'folder';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = f.enabled !== false; cb.disabled = f.readable === false;
      cb.addEventListener('change', () => setFolderEnabled(f.mediaId, cb.checked));
      row.appendChild(cb);
      const info = document.createElement('div'); info.className = 'info';
      const t = document.createElement('div'); t.className = 't';
      t.textContent = f.title;
      info.appendChild(t);
      const s = document.createElement('div'); s.className = 's';
      s.textContent = `共 ${f.mediaCount} 项`;
      if (f.readable === false) s.textContent += ' · ' + (f.error || '暂不可读');
      info.appendChild(s);
      row.appendChild(info);
      body.appendChild(row);
    }
    h.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      caret.textContent = open ? '▸' : '▾';
      h.classList.toggle('closed', open);
      if (open) collapsedGroups.add(key); else collapsedGroups.delete(key);
    });
    list.appendChild(h);
    list.appendChild(body);
  };
  addGroup('我创建的', 'created', folders.filter(f => f.source !== 'collected'));
  addGroup('追更的（收藏的）', 'collected', folders.filter(f => f.source === 'collected'));
}

function timeToMs(hId, mId, sId) {
  const n = id => { const v = parseInt($(id).value || '0', 10); return (Number.isFinite(v) && v > 0) ? v : 0; };
  return (n(hId) * 3600 + n(mId) * 60 + n(sId)) * 1000;
}
function fillTime(hId, mId, sId, ms) {
  let t = Math.max(0, Math.round((ms || 0) / 1000));
  $(hId).value = Math.floor(t / 3600);
  $(mId).value = Math.floor((t % 3600) / 60);
  $(sId).value = t % 60;
}
function timeFocused(prefix) {
  return ['H', 'M', 'S'].some(s => document.activeElement && document.activeElement.id === prefix + s);
}

async function refreshAll() {
  await loadAll();
  // 表单回填（不在输入焦点时）
  const hi = $('optHideInvalid');
  if (document.activeElement !== hi) hi.checked = settings.hideInvalid;
  const rb = document.querySelector(`input[name=feb29][value="${settings.feb29}"]`);
  if (rb) rb.checked = true;
  const sm = document.querySelector(`input[name=syncMode][value="${settings.syncMode || 'manual'}"]`);
  if (sm) sm.checked = true;
  const ss = document.querySelector(`input[name=syncScope][value="${syncScope}"]`);
  if (ss) ss.checked = true;
  if (!timeFocused('riskWait')) fillTime('riskWaitH', 'riskWaitM', 'riskWaitS', settings.rateWaitMs);
  if (!timeFocused('burstPause')) fillTime('burstPauseH', 'burstPauseM', 'burstPauseS', settings.burstPauseMs);
  if (document.activeElement !== $('burstPages')) $('burstPages').value = String(settings.burstPages || 120);
  $('maxShowText').textContent = String(settings.maxShow);
  getView().then(v => { if (v) renderView(v); }).catch(() => {});
  renderFolders();
}

async function saveSettingsPatch(patch) {
  settings = Object.assign({}, settings, patch);
  await saveSettings(settings);
  // 让 background 尽快感知（onChanged 会推送新视图）
}

function setFolderEnabled(mediaId, enabled) {
  storageGet(CFG.KEY_FOLDERS).then(o => {
    const folders = Array.isArray(o[CFG.KEY_FOLDERS]) ? o[CFG.KEY_FOLDERS] : [];
    const f = folders.find(x => x.mediaId === mediaId);
    if (f) {
      f.enabled = enabled;
      storageSet({ [CFG.KEY_FOLDERS]: folders }).then(() => renderFolders());
    }
  });
}

/* 组级批量启用/关闭（供各组“全选 / 全不选”使用） */
function setManyFolderEnabled(ids, enabled) {
  const set = new Set(ids);
  storageGet(CFG.KEY_FOLDERS).then(o => {
    const folders = Array.isArray(o[CFG.KEY_FOLDERS]) ? o[CFG.KEY_FOLDERS] : [];
    let changed = false;
    for (const f of folders) {
      if (!set.has(f.mediaId) || f.readable === false) continue;
      if ((f.enabled !== false) !== enabled) { f.enabled = enabled; changed = true; }
    }
    if (changed) storageSet({ [CFG.KEY_FOLDERS]: folders }).then(() => renderFolders());
  });
}

function setDebugDate(date) {
  chrome.runtime.sendMessage({ type: MSG.SET_DEBUG_DATE, date }, r => {
    if (r && r.v) renderView(r);
  });
}

function msg(opts) {
  return new Promise(resolve => chrome.runtime.sendMessage(opts, r => resolve(r || null)));
}

document.addEventListener('DOMContentLoaded', async () => {
  await refreshAll();

  $('btnSync').addEventListener('click', () => { msg({ type: MSG.SYNC_NOW, full: false, scope: syncScope }); });
  $('btnFull').addEventListener('click', () => { msg({ type: MSG.SYNC_NOW, full: true, scope: syncScope }); });
  $('btnRefreshFolders').addEventListener('click', async () => {
    const r = await msg({ type: MSG.REFRESH_FOLDERS });
    if (r && r.cooldown) $('syncStatus').textContent = '冷却中，稍后再刷新收藏夹列表。';
    else $('syncStatus').textContent = '已请求刷新收藏夹列表…';
  });

  $('optHideInvalid').addEventListener('change', e => saveSettingsPatch({ hideInvalid: e.target.checked }));
  document.querySelectorAll('input[name=feb29]').forEach(rb => {
    rb.addEventListener('change', () => { if (rb.checked) saveSettingsPatch({ feb29: rb.value }); });
  });
  document.querySelectorAll('input[name=syncMode]').forEach(rb => {
    rb.addEventListener('change', () => { if (rb.checked) saveSettingsPatch({ syncMode: rb.value }); });
  });
  document.querySelectorAll('input[name=syncScope]').forEach(rb => {
    rb.addEventListener('change', () => { if (rb.checked) syncScope = rb.value; });
  });
  // 风控与频率：时/分/秒 任一输入变化即计算并保存（总时长不足 1 秒则忽略）
  const bindTime = (prefix, key) => {
    for (const s of ['H', 'M', 'S']) {
      $(prefix + s).addEventListener('input', () => {
        const ms = timeToMs(prefix + 'H', prefix + 'M', prefix + 'S');
        if (ms >= 1000) saveSettingsPatch({ [key]: ms });
      });
    }
  };
  bindTime('riskWait', 'rateWaitMs');
  bindTime('burstPause', 'burstPauseMs');
  $('burstPages').addEventListener('input', () => {
    const v = parseInt($('burstPages').value || '0', 10);
    if (Number.isFinite(v) && v >= 1 && v <= 100000) saveSettingsPatch({ burstPages: v });
  });

  $('btnSetDebug').addEventListener('click', () => {
    const val = $('debugDate').value;
    if (val && isValidDateKey(val)) setDebugDate(val);
  });
  $('btnReal').addEventListener('click', () => setDebugDate(''));
  $('btnForce').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: MSG.DEBUG_FORCE }, r => { if (r && r.v) renderView(r); });
  });

  $('btnClear').addEventListener('click', async () => {
    if (!confirm('确定清空本地数据？将删除收藏夹列表、条目缓存、同步状态与设置。')) return;
    await chrome.storage.local.remove([CFG.KEY_META, CFG.KEY_FOLDERS, CFG.KEY_ITEMS, CFG.KEY_SYNC, CFG.KEY_SETTINGS]);
    await refreshAll();
  });
});

/* 后台写入频繁时防抖刷新 */
let timer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  clearTimeout(timer);
  timer = setTimeout(refreshAll, 500);
});
