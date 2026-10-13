import { LOVE_TYPES, TYPE_IDS, typeOf, classify } from './love-types.js';
import * as store from './store.js';

const SLOTS = 2;
const WEEKDAYS = '日一二三四五六';
const DOW_MON_FIRST = ['一', '二', '三', '四', '五', '六', '日'];
const EXAMPLES = [
  '他下雨天来接我下班',
  '她夸我做的饭很好吃',
  '一起在小区里散了很久的步',
  '妈妈偷偷塞给我一盒水果',
  '朋友听我吐槽了一整晚',
  '对自己说：你已经很棒了',
  '收到一条“到家说一声”的消息',
  '同事帮我带了一杯热咖啡',
];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const fmt = (d) => keyOf(d.getFullYear(), d.getMonth(), d.getDate());
const todayKey = () => fmt(new Date());
// You may write one day ahead (tomorrow); anything later stays locked.
const tomorrowKey = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return fmt(d);
};
const parse = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return { y, m: m - 1, d };
};
const example = (date, slot) => '比如：' + EXAMPLES[(parse(date).d + slot * 3) % EXAMPLES.length];

const ls = {
  get: (k) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  entries: new Map(), // id (`${date}_${slot}`) -> entry
  view: { y: 0, m: 0 },
  selected: todayKey(),
  health: undefined, // undefined = checking, null = unreachable
  budget: null, // { spentUsd, warnAtUsd, overBudget, ... } as last reported by the backend
};
const popKeys = new Set(); // entries whose icon just arrived (play the pop animation once)
const inflight = new Map(); // id -> token of the newest generation request

const entriesOn = (date) => Array.from({ length: SLOTS }, (_, i) => state.entries.get(`${date}_${i}`));

// ---------- toast ----------

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
let notified = false;
function toastOnce(msg) {
  if (notified) return;
  notified = true;
  toast(msg);
}

// ---------- rendering ----------

function icon(e, cls = '') {
  const t = typeOf(e.type);
  const classes = ['icon', cls, e.status === 'pending' && 'loading', popKeys.has(e.id) && 'pop'].filter(Boolean).join(' ');
  const inner = e.icon ? `<img src="${e.icon}" alt="" draggable="false">` : `<span class="glyph">${t.emoji}</span>`;
  return `<span class="${classes}" style="--from:${t.from};--to:${t.to}">${inner}</span>`;
}

function renderCalendar() {
  const { y, m } = state.view;
  $('monthLabel').textContent = `${y}年${m + 1}月`;
  const offset = (new Date(y, m, 1).getDay() + 6) % 7; // Monday-first
  const count = new Date(y, m + 1, 0).getDate();
  const today = todayKey();
  const limit = tomorrowKey();
  let html = '<span class="day-cell empty"></span>'.repeat(offset);
  for (let d = 1; d <= count; d++) {
    const key = keyOf(y, m, d);
    const es = entriesOn(key).filter(Boolean);
    const cls = ['day-cell', key === today && 'today', key === state.selected && 'sel', key > limit && 'future'].filter(Boolean).join(' ');
    html +=
      `<button class="${cls}" data-date="${key}" aria-pressed="${key === state.selected}" aria-label="${m + 1}月${d}日，${es.length}份爱">` +
      `<span class="num">${d}</span><span class="icons" data-n="${es.length}">${es.map((e) => icon(e)).join('')}</span></button>`;
  }
  $('days').innerHTML = html;
}

function slotHTML(e) {
  const t = typeOf(e.type);
  let status = '';
  if (e.status === 'pending') status = '<span class="slot-status">生成图标中…</span>';
  else if (e.status === 'error') status = '<span class="slot-status err">图标没生成成功</span><button class="retry" data-retry>重试</button>';
  return (
    `<div class="slot" role="button" tabindex="0" data-slot="${e.slot}">${icon(e, 'card-icon')}` +
    `<div class="slot-body"><div class="slot-text">${esc(e.text)}</div>` +
    `<div class="slot-meta"><span class="type-chip" style="--from:${t.from};--to:${t.to}">${t.emoji} ${t.label}</span>${status}</div></div></div>`
  );
}

function addHTML(date, i) {
  return (
    `<button class="slot add" data-slot="${i}"><span class="plus">+</span>` +
    `<span class="add-text"><span class="add-title">写下第 ${i + 1} 份爱</span><span class="add-sub">${esc(example(date, i))}</span></span></button>`
  );
}

function renderDay() {
  const key = state.selected;
  const { y, m, d } = parse(key);
  const today = todayKey();
  const tomorrow = tomorrowKey();
  const es = entriesOn(key);
  const n = es.filter(Boolean).length;

  let html =
    `<div class="day-head"><h2>${m + 1}月${d}日 · 周${WEEKDAYS[new Date(y, m, d).getDay()]}` +
    `${key === today ? '<span class="tag">今天</span>' : key === tomorrow ? '<span class="tag soft">明天</span>' : ''}</h2>` +
    `<span class="counter">${n}/${SLOTS}</span></div>`;

  if (key > tomorrow) {
    html += '<p class="day-lead">未来的爱，留给未来的你 ✨ 最多可以提前一天写哦。</p>';
  } else {
    if (n === 0) {
      html += `<p class="day-lead">${key === tomorrow ? '明天有哪些爱的表达？可以提前写下。' : `${key === today ? '今天' : '这一天'}有哪些爱的表达？给出的、收到的，都算。`}</p>`;
    }
    html += '<div class="slots">' + es.map((e, i) => (e ? slotHTML(e) : addHTML(key, i))).join('') + '</div>';
  }
  $('dayCard').innerHTML = html;
}

function streak() {
  const days = new Set([...state.entries.values()].map((e) => e.date));
  const d = new Date();
  if (!days.has(fmt(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(fmt(d))) {
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function renderStats() {
  const { y, m } = state.view;
  const prefix = `${y}-${pad(m + 1)}-`;
  const counts = new Map();
  let total = 0;
  for (const e of state.entries.values()) {
    if (!e.date.startsWith(prefix)) continue;
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    total += 1;
  }
  const rows = LOVE_TYPES.filter((t) => counts.has(t.id)).sort((a, b) => counts.get(b.id) - counts.get(a.id));
  const run = streak();

  $('statsCard').innerHTML =
    '<h3>本月的爱</h3>' +
    (total
      ? `<p class="stats-sum">记录了 ${total} 份，最多的是「${rows[0].label}」</p>`
      : '<p class="stats-sum">这个月还没有记录，从一份小小的心意开始吧</p>') +
    `<div class="bar">${rows.map((t) => `<i style="--c:${t.color};flex-grow:${counts.get(t.id)}" title="${t.label}"></i>`).join('')}</div>` +
    (total ? `<div class="legend">${rows.map((t) => `<span style="--c:${t.color}">${t.label} ${counts.get(t.id)}</span>`).join('')}</div>` : '') +
    (run ? `<div class="streak">🌟 已连续记录 ${run} 天</div>` : '');
}

function renderAll() {
  renderCalendar();
  renderDay();
  renderStats();
  popKeys.clear();
}

// ---------- navigation ----------

function select(date) {
  state.selected = date;
  renderCalendar();
  renderDay();
  if (window.innerWidth < 900) $('dayCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showMonth(y, m) {
  const first = new Date(y, m, 1);
  state.view = { y: first.getFullYear(), m: first.getMonth() };
  const t = new Date();
  const hasToday = t.getFullYear() === state.view.y && t.getMonth() === state.view.m;
  state.selected = hasToday ? fmt(t) : keyOf(state.view.y, state.view.m, 1);
  renderAll();
}

// ---------- sheets ----------

function openSheet(el) {
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  document.body.classList.add('locked');
}
function closeSheet(el) {
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  if (!document.querySelector('.backdrop.open')) document.body.classList.remove('locked');
}

// First tap arms the button, second tap within 3s confirms.
function confirmTap(btn, armedLabel, action) {
  if (btn.dataset.armed) {
    clearTimeout(Number(btn.dataset.armed));
    btn.textContent = btn.dataset.label;
    delete btn.dataset.armed;
    action();
    return;
  }
  btn.dataset.label = btn.textContent;
  btn.textContent = armedLabel;
  btn.dataset.armed = String(
    setTimeout(() => {
      btn.textContent = btn.dataset.label;
      delete btn.dataset.armed;
    }, 3000),
  );
}

// ---------- entry sheet ----------

let draft = null; // { date, slot, entry, type, locked }

function buildChips() {
  $('typeChips').innerHTML = LOVE_TYPES.map(
    (t) =>
      `<button type="button" class="chip" role="radio" data-type="${t.id}" aria-checked="false" title="${esc(t.hint)}" style="--from:${t.from};--to:${t.to};--c:${t.color}">` +
      `<span class="e">${t.emoji}</span>${t.label}</button>`,
  ).join('');
}

function syncEntryForm() {
  const t = typeOf(draft.type);
  const text = $('entryText').value.trim();
  document.querySelectorAll('#typeChips .chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.type === draft.type)));
  $('typeNote').textContent = draft.locked ? `已选择：${t.label}` : `自动识别为：${t.label}，也可以自己选`;
  $('entryCount').textContent = `${$('entryText').value.length}/60`;

  const prev = draft.entry;
  const unchanged = prev && prev.text === text && prev.type === draft.type;
  const el = $('previewIcon');
  el.style.setProperty('--from', t.from);
  el.style.setProperty('--to', t.to);
  el.innerHTML = unchanged && prev.icon ? `<img src="${prev.icon}" alt="">` : `<span class="glyph">${t.emoji}</span>`;
}

function openEntry(date, slot) {
  const entry = state.entries.get(`${date}_${slot}`) ?? null;
  const { m, d, y } = parse(date);
  draft = { date, slot, entry, type: entry?.type ?? 'other', locked: Boolean(entry) };

  $('entryTitle').textContent = entry ? '编辑这份爱' : '写下一份爱';
  $('entryDate').textContent = `${m + 1}月${d}日 周${WEEKDAYS[new Date(y, m, d).getDay()]} · 第 ${slot + 1} 份`;
  $('entryText').value = entry?.text ?? '';
  $('entryText').placeholder = example(date, slot);
  $('regenBtn').hidden = !entry;
  $('deleteBtn').hidden = !entry;
  syncEntryForm();
  openSheet($('entrySheet'));
  setTimeout(() => $('entryText').focus({ preventScroll: true }), 350);
}

async function commitEntry({ regen = false } = {}) {
  const text = $('entryText').value.trim();
  if (!text) return $('entryText').focus();

  const { date, slot, entry: prev, type } = draft;
  const id = `${date}_${slot}`;
  const changed = !prev || prev.text !== text || prev.type !== type;
  const now = Date.now();
  const entry = {
    id, date, slot, text, type,
    icon: changed ? null : prev.icon ?? null,
    status: prev?.status ?? 'fallback',
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  const needsIcon = changed || regen;
  if (needsIcon) entry.status = 'pending';

  state.entries.set(id, entry);
  state.selected = date;
  closeSheet($('entrySheet'));
  renderAll();
  navigator.vibrate?.(8);
  await store.save(entry);
  // an explicit "new icon" request skips the reuse cache; plain edits and retries reuse paid-for images
  if (needsIcon) generate(id, { fresh: regen });
}

async function deleteEntry() {
  const { date, slot } = draft;
  const id = `${date}_${slot}`;
  state.entries.delete(id);
  inflight.delete(id);
  closeSheet($('entrySheet'));
  renderAll();
  await store.remove(id);
}

// ---------- icon generation ----------

function apiBase() {
  return String(window.LOVE_CONFIG?.API_BASE ?? '').replace(/\/+$/, '');
}

async function api(path, body, timeoutMs = 120_000) {
  const headers = { 'content-type': 'application/json' };
  const code = ls.get('love.accessCode');
  if (code) headers['x-access-code'] = code;

  let res;
  try {
    res = await fetch(apiBase() + path, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw Object.assign(new Error(timedOut ? '生成超时了，请重试' : '连不上后端，请检查网络后重试'), { code: 'network' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = [404, 405].includes(res.status) && !data.error ? 'no_backend' : data.error;
    throw Object.assign(new Error(data.message || `请求失败 (${res.status})`), { code, status: res.status });
  }
  return data;
}

// Downscale to a small JPEG so hundreds of icons fit comfortably in IndexedDB.
function downscale(dataUrl, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => reject(new Error('生成的图片无法显示，请重试'));
    img.src = dataUrl;
  });
}

const norm = (s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();

function findTwin(entry) {
  const text = norm(entry.text);
  for (const e of state.entries.values()) {
    if (e.id !== entry.id && e.icon && e.status === 'ready' && e.type === entry.type && norm(e.text) === text) return e;
  }
  return null;
}

function failure(err) {
  if (err.code === 'not_configured' || err.code === 'no_backend') {
    toastOnce('还没连上图像服务，先用内置图标 ✨');
    return { status: 'fallback' };
  }
  if (err.status === 401) {
    toast('需要访问口令，请在设置里填写');
    openSettings();
  } else {
    toast(err.message || '图标生成失败');
  }
  return { status: 'error' };
}

async function generate(id, { fresh = false } = {}) {
  const current = state.entries.get(id);
  if (!current) return;
  const token = Symbol();
  inflight.set(id, token);

  // an identical expression on this device already has an icon: reuse it, no request at all
  const twin = fresh ? null : findTwin(current);

  let patch;
  if (twin) {
    patch = { icon: twin.icon, status: 'ready' };
  } else {
    try {
      const res = await api('/api/generate', { text: current.text, type: current.type, fresh });
      updateBudget(res.budget);
      patch = { icon: await downscale(res.image), status: 'ready' };
    } catch (err) {
      patch = failure(err);
    }
  }

  if (inflight.get(id) !== token) return; // edited again or deleted meanwhile
  inflight.delete(id);
  const entry = state.entries.get(id);
  Object.assign(entry, patch, { updatedAt: Date.now() });
  if (patch.status === 'ready') popKeys.add(id);
  renderAll();
  await store.save(entry);
}

// ---------- budget ----------

const usd = (n) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
let warnedBudget = false;

function updateBudget(b) {
  if (!b) return;
  state.budget = b;
  const banner = $('budgetBanner');
  banner.hidden = !b.overBudget;
  if (b.overBudget) {
    banner.textContent = `⚠️ 图标生成已经花了约 ${usd(b.spentUsd)}，超过你设的 ${usd(b.warnAtUsd)} 提醒线。建议去 OpenAI 后台核对用量，需要的话先停掉后端。`;
    if (!warnedBudget) {
      warnedBudget = true;
      toast(`⚠️ 图标花费已超过 ${usd(b.warnAtUsd)} 提醒线`);
    }
  }
  renderSpend();
}

function renderSpend() {
  const b = state.budget;
  $('spendStatus').textContent = b ? `${usd(b.spentUsd)} / ${usd(b.warnAtUsd)} 提醒线` : '—';
}

// ---------- settings ----------

function renderApiStatus() {
  const h = state.health;
  let text = '检查中…';
  if (h === null) text = '未连接（使用内置图标）';
  else if (h) text = !h.imageConfigured ? '后端未配置图像 API' : h.accessRequired && !ls.get('love.accessCode') ? '需要访问口令' : `已连接 · ${h.model}`;
  $('apiStatus').textContent = text;
}

async function checkHealth(timeoutMs) {
  try {
    state.health = await api('/api/health', null, timeoutMs);
    updateBudget(state.health.budget);
  } catch {
    state.health = null;
  }
  renderApiStatus();
}

function openSettings() {
  $('accessCode').value = ls.get('love.accessCode');
  state.health = undefined;
  renderApiStatus();
  openSheet($('settingsSheet'));
  checkHealth(8000);
}

function exportData() {
  const payload = JSON.stringify({ app: 'love-calendar', version: 1, exportedAt: new Date().toISOString(), entries: [...state.entries.values()] });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  a.download = `love-calendar-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function sanitizeEntry(raw) {
  const slot = Number(raw?.slot);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw?.date) || ![0, 1].includes(slot) || typeof raw.text !== 'string' || !raw.text.trim()) return null;
  const okIcon = typeof raw.icon === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw.icon);
  return {
    id: `${raw.date}_${slot}`,
    date: raw.date,
    slot,
    text: raw.text.trim().slice(0, 60),
    type: TYPE_IDS.includes(raw.type) ? raw.type : 'other',
    icon: okIcon ? raw.icon : null,
    status: okIcon ? 'ready' : 'fallback',
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

async function importData(file) {
  try {
    const json = JSON.parse(await file.text());
    const list = (Array.isArray(json?.entries) ? json.entries : []).map(sanitizeEntry).filter(Boolean);
    if (!list.length) return toast('文件里没有可导入的记录');
    list.forEach((e) => state.entries.set(e.id, e));
    await store.save(list);
    renderAll();
    toast(`已导入 ${list.length} 份爱`);
  } catch {
    toast('这个文件读不了，请选择导出的 JSON');
  }
}

// ---------- events ----------

function bind() {
  $('days').addEventListener('click', (ev) => {
    const cell = ev.target.closest('.day-cell[data-date]');
    if (cell) select(cell.dataset.date);
  });

  $('dayCard').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-retry]')) {
      const slot = ev.target.closest('.slot').dataset.slot;
      const id = `${state.selected}_${slot}`;
      state.entries.get(id).status = 'pending';
      renderAll();
      generate(id);
      return;
    }
    const slot = ev.target.closest('.slot');
    if (slot) openEntry(state.selected, Number(slot.dataset.slot));
  });
  $('dayCard').addEventListener('keydown', (ev) => {
    const slot = ev.target.closest?.('.slot[role="button"]');
    if (slot && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      openEntry(state.selected, Number(slot.dataset.slot));
    }
  });

  $('prevMonth').addEventListener('click', () => showMonth(state.view.y, state.view.m - 1));
  $('nextMonth').addEventListener('click', () => showMonth(state.view.y, state.view.m + 1));
  $('todayBtn').addEventListener('click', () => {
    const t = new Date();
    showMonth(t.getFullYear(), t.getMonth());
  });

  // swipe left/right on the calendar to change month
  let sx = 0, sy = 0;
  const cal = document.querySelector('.cal');
  cal.addEventListener('touchstart', (ev) => { sx = ev.touches[0].clientX; sy = ev.touches[0].clientY; }, { passive: true });
  cal.addEventListener('touchend', (ev) => {
    const t = ev.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 40) showMonth(state.view.y, state.view.m + (dx < 0 ? 1 : -1));
  }, { passive: true });

  // entry sheet
  $('entryText').addEventListener('input', () => {
    if (!draft.locked) draft.type = classify($('entryText').value);
    syncEntryForm();
  });
  $('entryText').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) $('entryForm').requestSubmit();
  });
  $('typeChips').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    draft.type = chip.dataset.type;
    draft.locked = true;
    syncEntryForm();
  });
  $('entryForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    commitEntry();
  });
  $('regenBtn').addEventListener('click', () => commitEntry({ regen: true }));
  $('cancelBtn').addEventListener('click', () => closeSheet($('entrySheet')));
  $('deleteBtn').addEventListener('click', (ev) => confirmTap(ev.currentTarget, '再点一次确认删除', deleteEntry));

  // settings sheet
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsDone').addEventListener('click', () => closeSheet($('settingsSheet')));
  $('accessCode').addEventListener('change', () => {
    ls.set('love.accessCode', $('accessCode').value.trim());
    renderApiStatus();
  });
  $('exportBtn').addEventListener('click', exportData);
  $('importFile').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (file) importData(file);
  });
  $('clearBtn').addEventListener('click', (ev) =>
    confirmTap(ev.currentTarget, '再点一次确认清空', async () => {
      state.entries.clear();
      inflight.clear();
      await store.clear();
      renderAll();
      toast('已清空');
    }),
  );

  // backdrop click + Esc close the top sheet
  document.querySelectorAll('.backdrop').forEach((el) => el.addEventListener('mousedown', (ev) => ev.target === el && closeSheet(el)));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') document.querySelectorAll('.backdrop.open').forEach(closeSheet);
  });

  // the date may roll over while the tab stays open
  let lastDay = todayKey();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayKey() !== lastDay) {
      lastDay = todayKey();
      renderAll();
    }
  });
}

// ---------- init ----------

async function init() {
  $('dow').innerHTML = DOW_MON_FIRST.map((d) => `<span>${d}</span>`).join('');
  buildChips();

  const t = new Date();
  state.view = { y: t.getFullYear(), m: t.getMonth() };

  for (const e of await store.loadAll()) {
    if (e.status === 'pending') {
      // a generation that was cut off by a reload; let the user retry instead of silently spending credits
      e.status = 'error';
      store.save(e);
    }
    state.entries.set(e.id, e);
  }
  renderAll();
  bind();
  if (!store.persistent) toast('当前浏览器禁用了本地存储，刷新后记录会丢失');

  // doubles as a warm-up ping for hosts that sleep when idle
  checkHealth(60_000);
}

init();
