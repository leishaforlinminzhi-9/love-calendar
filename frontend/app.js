import { LOVE_TYPES, TYPE_IDS, typeOf, classify, maxLengthOf, tidyText } from './love-types.js';
import * as store from './store.js';

const SLOTS = 2;
const WEEKDAYS = '日一二三四五六';
const DOW_MON_FIRST = ['一', '二', '三', '四', '五', '六', '日'];
const EXAMPLES = [
  'TA 下雨天来接我下班',
  'TA 半夜给我煮了碗面',
  'TA 提前到车站等我',
  'TA 夸我今天表现很好',
  'TA 给我准备了生日蛋糕',
  'TA 抱了我很久',
  '一起看了场电影',
  'TA 主动洗了碗',
  'TA 听我吐槽了一整晚',
  'TA 说了句：想你了',
  'TA 给我带了杯奶茶',
  'TA 送了我一束花',
];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// A web address in an entry becomes a button under the text (a small game, a song, a page for the other person); the text keeps all
// its other words. Only http(s) is ever linked, and every piece is escaped on its own, so nothing typed into an entry can become
// markup. An address is plain ASCII, so the Chinese text right after it is not swallowed; closing punctuation stays in the sentence.
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;
const MAX_LINKS = 3;
const LINK_LABEL = '点开看看';
function splitLinks(text) {
  const urls = [];
  const lines = String(text).split('\n').map((line) => {
    let linked = false;
    const rest = line
      .replace(URL_RE, (m) => {
        const url = m.replace(/[.,;:!?)\]']+$/, '');
        if (!/^https?:\/\/[^/?#]+/.test(url)) return m;
        if (!urls.includes(url)) {
          if (urls.length >= MAX_LINKS) return m; // more than that stay plain text
          urls.push(url);
        }
        linked = true;
        return m.slice(url.length);
      })
      .replace(/[^\S\n]{2,}/g, ' ')
      .trim();
    return linked && /^[\s\p{P}\p{S}]*$/u.test(rest) ? null : rest; // a line that held only an address (and maybe its brackets) goes away; a blank line the author wrote stays
  });
  return { text: lines.filter((l) => l !== null).join('\n'), urls };
}
function linkButtons(urls) {
  if (!urls.length) return '';
  const label = (i) => (urls.length > 1 ? `${LINK_LABEL} ${i + 1}` : LINK_LABEL);
  return (
    '<div class="slot-links">' +
    urls.map((url, i) => `<a class="link-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">${label(i)}<span class="arrow" aria-hidden="true">↗</span></a>`).join('') +
    '</div>'
  );
}
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
  remove: (k) => { try { localStorage.removeItem(k); } catch {} },
};
const ss = {
  get: (k) => { try { return sessionStorage.getItem(k) ?? ''; } catch { return ''; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
  remove: (k) => { try { sessionStorage.removeItem(k); } catch {} },
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

// Deleted entries stay in the map as tombstones so the deletion can sync to other devices.
const live = () => [...state.entries.values()].filter((e) => !e.deleted);
const liveEntry = (id) => {
  const e = state.entries.get(id);
  return e && !e.deleted ? e : null;
};
// A day has two normal slots (0, 1). Each one is a love entry, a "banked" placeholder (too busy, owe it for later),
// or empty. Slots 2..5 are extras written on a later day to redeem what was banked.
const EXTRA_SLOTS = 4;
const isBusy = (e) => e.kind === 'busy';
const loved = () => live().filter((e) => !isBusy(e)); // real expressions only
const entriesOn = (date) => Array.from({ length: SLOTS }, (_, i) => liveEntry(`${date}_${i}`) ?? undefined);
const extrasOn = (date) => Array.from({ length: EXTRA_SLOTS }, (_, i) => liveEntry(`${date}_${SLOTS + i}`)).filter(Boolean);
const itemsOn = (date) => [...entriesOn(date).filter(Boolean), ...extrasOn(date)]; // everything shown for a day
const nextExtraSlot = (date) => {
  for (let s = SLOTS; s < SLOTS + EXTRA_SLOTS; s++) if (!liveEntry(`${date}_${s}`)) return s;
  return null;
};
// How many expressions are still owed: banked placeholders minus extras already written. Derived from the
// entries themselves, so it is always consistent and syncs between devices for free.
function bank() {
  let banked = 0;
  let redeemed = 0;
  for (const e of live()) {
    if (isBusy(e)) banked += 1;
    else if (e.slot >= SLOTS) redeemed += 1;
  }
  return { banked, redeemed, owed: Math.max(0, banked - redeemed) };
}
// Strictly increasing per entry, so a fast second edit (or a clock that went back) still wins the merge.
const nextStamp = (id) => Math.max(Date.now(), (state.entries.get(id)?.updatedAt ?? 0) + 1);

// ---------- toast ----------

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------- rendering ----------

// The icon for a banked ("too busy") slot: a small, round, sleepy zzz. Drawn as SVG so it looks the same everywhere.
const ZZZ =
  '<svg class="zzz" viewBox="0 0 64 64" aria-hidden="true">' +
  '<path d="M9 44h12L9 57h12"/><path d="M24 27h15L24 44h15"/><path d="M42 7h17L42 28h17"/></svg>';

function icon(e, cls = '') {
  if (isBusy(e)) return `<span class="icon busy ${cls}">${ZZZ}</span>`;
  const t = typeOf(e.type);
  const classes = ['icon', cls, e.status === 'pending' && 'loading', popKeys.has(e.id) && 'pop'].filter(Boolean).join(' ');
  const inner = e.icon ? `<img src="${e.icon}" alt="" draggable="false">` : `<span class="glyph">${t.emoji}</span>`;
  return `<span class="${classes}" style="--from:${t.from};--to:${t.to}">${inner}</span>`;
}

function renderCalendar() {
  const { y, m } = state.view;
  $('monthLabel').textContent = `${y}.${pad(m + 1)}`;
  const offset = (new Date(y, m, 1).getDay() + 6) % 7; // Monday-first
  const count = new Date(y, m + 1, 0).getDate();
  const today = todayKey();
  const limit = tomorrowKey();
  let html = '<span class="day-cell empty"></span>'.repeat(offset);
  for (let d = 1; d <= count; d++) {
    const key = keyOf(y, m, d);
    const es = itemsOn(key);
    const shown = es.slice(0, 2);
    const more = es.length - shown.length;
    const busyCount = es.filter(isBusy).length;
    const cls = ['day-cell', key === today && 'today', key === state.selected && 'sel', key > limit && 'future'].filter(Boolean).join(' ');
    html +=
      `<button class="${cls}" data-date="${key}" aria-pressed="${key === state.selected}" aria-label="${m + 1}月${d}日，${es.length - busyCount}条记录${busyCount ? `，攒${busyCount}` : ''}">` +
      `<span class="num">${d}</span><span class="icons" data-n="${shown.length}">${shown.map((e) => icon(e)).join('')}</span>` +
      `${more > 0 ? `<span class="more">+${more}</span>` : ''}</button>`;
  }
  $('days').innerHTML = html;
}

function slotHTML(e) {
  const t = typeOf(e.type);
  const { text, urls } = splitLinks(e.text);
  const links = linkButtons(urls);
  // a picture that could not be made is not an error the visitor needs to see: the built-in icon simply stays
  const status = e.status === 'pending' ? '<span class="slot-status">生成中…</span>' : '';
  const redeem = e.slot >= SLOTS ? '<span class="type-chip redeem">兑现</span>' : '';
  if (t.multiline) {
    // 回音: a poem or a longer text gets its own layout, line breaks kept, set in a serif face
    return (
      `<div class="slot echo" role="button" tabindex="0" data-slot="${e.slot}" style="--c:${t.color}">` +
      `<div class="echo-head">${icon(e, 'card-icon')}` +
      `<span class="type-chip" style="--from:${t.from};--to:${t.to}">${t.emoji} ${t.label}</span>${redeem}${status}</div>` +
      `${text ? `<blockquote class="echo-text">${esc(text)}</blockquote>` : ''}${links}</div>`
    );
  }
  return (
    `<div class="slot" role="button" tabindex="0" data-slot="${e.slot}">${icon(e, 'card-icon')}` +
    `<div class="slot-body">${text ? `<div class="slot-text">${esc(text)}</div>` : ''}${links}` +
    `<div class="slot-meta"><span class="type-chip" style="--from:${t.from};--to:${t.to}">${t.emoji} ${t.label}</span>` +
    `${redeem}${status}</div></div></div>`
  );
}

function busySlotHTML(e) {
  return (
    `<div class="slot busy" role="button" tabindex="0" data-slot="${e.slot}">${icon(e, 'card-icon')}` +
    '<div class="slot-body"><div class="slot-text">已攒下</div>' +
    '<div class="slot-meta">稍后兑现 · 点按可补记或取消</div></div></div>'
  );
}

function redeemHTML(owed) {
  return (
    '<button class="slot add redeem" data-redeem><span class="plus">+</span>' +
    `<span class="add-text"><span class="add-title">兑现一条</span><span class="add-sub">还欠 ${owed} · 在这天额外记一条</span></span></button>`
  );
}

function addHTML(date, i) {
  return (
    `<button class="slot add" data-slot="${i}"><span class="plus">+</span>` +
    `<span class="add-text"><span class="add-title">记第 ${i + 1} 条</span><span class="add-sub">${esc(example(date, i))}</span></span></button>`
  );
}

function renderDay() {
  const key = state.selected;
  const { y, m, d } = parse(key);
  const today = todayKey();
  const tomorrow = tomorrowKey();
  const es = entriesOn(key);
  const loveN = es.filter((e) => e && !isBusy(e)).length;
  const busyN = es.filter((e) => e && isBusy(e)).length;
  const emptyN = es.filter((e) => !e).length;
  const extras = extrasOn(key);
  const { owed } = bank();
  const dayWord = key === today ? '今天' : key === tomorrow ? '明天' : '这天';

  let html =
    `<div class="day-head"><h2>${m + 1}月${d}日 周${WEEKDAYS[new Date(y, m, d).getDay()]}` +
    `${key === today ? '<span class="tag">今天</span>' : key === tomorrow ? '<span class="tag soft">明天</span>' : ''}</h2>` +
    `<span class="counter">${loveN}/${SLOTS}${busyN ? ` · 攒${busyN}` : ''}${extras.length ? ` · 兑现${extras.length}` : ''}</span></div>`;

  if (key > tomorrow) {
    html += '<p class="day-lead">还没到。最多提前一天。</p>';
  } else {
    if (loveN + busyN + extras.length === 0) {
      html += `<p class="day-lead">${key === tomorrow ? '明天，可以提前记。' : `${dayWord}还没有记录。`}</p>`;
    }
    html += '<div class="slots">' + es.map((e, i) => (!e ? addHTML(key, i) : isBusy(e) ? busySlotHTML(e) : slotHTML(e))).join('') + '</div>';
    // too busy to write them? bank the empty slots now and pay them back later
    if (emptyN) html += `<button class="busy-btn" data-busy>${dayWord}太忙 · 先攒 ${emptyN} 条</button>`;
    // extras: expressions written beyond the daily two, which pay back what was banked
    // (not on a day that was itself banked: too busy to write today, but writing extra today makes no sense)
    const canRedeem = owed > 0 && extras.length < EXTRA_SLOTS && busyN === 0;
    if (extras.length || canRedeem) {
      html += '<div class="extras-title">兑现</div><div class="slots">' + extras.map(slotHTML).join('') + (canRedeem ? redeemHTML(owed) : '') + '</div>';
    }
  }
  $('dayCard').innerHTML = html;
}

function streak() {
  const days = new Set(loved().map((e) => e.date));
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
  for (const e of loved()) {
    if (!e.date.startsWith(prefix)) continue;
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    total += 1;
  }
  const rows = LOVE_TYPES.filter((t) => counts.has(t.id)).sort((a, b) => counts.get(b.id) - counts.get(a.id));
  const run = streak();
  const { banked, redeemed, owed } = bank();

  $('statsCard').innerHTML =
    '<h3>本月</h3>' +
    (total
      ? `<p class="stats-sum">${total} 条</p>`
      : '<p class="stats-sum">暂无记录</p>') +
    `<div class="bar">${rows.map((t) => `<i style="--c:${t.color};flex-grow:${counts.get(t.id)}" title="${t.label}"></i>`).join('')}</div>` +
    (total ? `<div class="legend">${rows.map((t) => `<span style="--c:${t.color}">${t.label} ${counts.get(t.id)}</span>`).join('')}</div>` : '') +
    (run ? `<div class="streak">连续 ${run} 天</div>` : '') +
    (banked
      ? `<div class="bank"><b>待兑现 ${owed}</b><span>累计攒 ${banked} · 已兑现 ${redeemed}</span></div>`
      : '');
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
  $('typeNote').textContent = draft.locked ? `${t.label}` : `自动识别：${t.label}`;
  // the limit, the size of the box and the hint follow the type: a 回音 may be a whole poem, the rest is one short line
  const max = maxLengthOf(draft.type);
  const field = $('entryText');
  // until the visitor picks a type themselves, typing is allowed up to the longest limit: a text past the short limit is
  // recognised as a 回音 (see classify), so it must be possible to type it
  field.maxLength = draft.locked ? max : Math.max(...LOVE_TYPES.map((x) => maxLengthOf(x.id)));
  field.rows = t.multiline ? 9 : 3;
  field.classList.toggle('echo-input', Boolean(t.multiline));
  field.placeholder = t.multiline ? '一首诗、一段歌词，或一段想说的话。可以换行。' : draft.example;
  $('entryCount').textContent = `${field.value.length}/${max}`;
  $('entryCount').classList.toggle('over', field.value.trim().length > max);

  const prev = draft.entry;
  const unchanged = prev && prev.text === text && prev.type === draft.type;
  const el = $('previewIcon');
  el.style.setProperty('--from', t.from);
  el.style.setProperty('--to', t.to);
  el.innerHTML = unchanged && prev.icon ? `<img src="${prev.icon}" alt="">` : `<span class="glyph">${t.emoji}</span>`;
}

function openEntry(date, slot) {
  const existing = liveEntry(`${date}_${slot}`);
  const busy = Boolean(existing && isBusy(existing)); // a banked "too busy" placeholder, not a real expression
  const entry = existing && !busy ? existing : null;
  const extra = slot >= SLOTS;
  const { m, d, y } = parse(date);
  draft = { date, slot, entry, busy, type: entry?.type ?? 'other', locked: Boolean(entry), example: example(date, slot) };

  $('entryTitle').textContent = entry ? '编辑' : busy ? '补记' : extra ? '兑现' : '新记录';
  $('entryDate').textContent = `${m + 1}月${d}日 周${WEEKDAYS[new Date(y, m, d).getDay()]} · ${extra ? '兑现' : `第 ${slot + 1} 条`}`;
  $('entryText').value = entry?.text ?? '';
  $('regenBtn').hidden = !entry;
  $('deleteBtn').hidden = !(entry || busy);
  $('deleteBtn').textContent = busy ? '取消积攒' : '删除';
  syncEntryForm();
  openSheet($('entrySheet'));
  setTimeout(() => $('entryText').focus({ preventScroll: true }), 350);
}

async function commitEntry({ regen = false } = {}) {
  const typed = $('entryText').value.trim();
  if (!typed) return $('entryText').focus();

  const { date, slot, entry: prev, type } = draft;
  const max = maxLengthOf(type);
  if (typed.length > max) {
    // never cut someone's words silently: say what to do instead
    toast(`这个类型最多 ${max} 字（现在 ${typed.length} 字），长一点的话请选「回音」`);
    return;
  }
  const text = tidyText(type, typed);
  const id = `${date}_${slot}`;
  const changed = !prev || prev.text !== text || prev.type !== type;
  const old = state.entries.get(id); // may be a tombstone of an earlier deletion
  const entry = {
    id, date, slot, kind: 'love', text, type,
    icon: changed ? null : prev.icon ?? null,
    iconKey: changed ? null : prev.iconKey ?? null,
    iconUploaded: changed ? false : prev.iconUploaded ?? false,
    status: prev?.status ?? 'fallback',
    deleted: false,
    dirty: true,
    rev: old?.rev,
    createdAt: prev?.createdAt ?? old?.createdAt ?? Date.now(),
    updatedAt: nextStamp(id),
  };
  const needsIcon = changed || regen;
  if (needsIcon) entry.status = 'pending';

  state.entries.set(id, entry);
  state.selected = date;
  closeSheet($('entrySheet'));
  renderAll();
  navigator.vibrate?.(8);
  await store.save(entry);
  scheduleSync();
  // an explicit "new icon" request skips the reuse cache; plain edits and retries reuse paid-for images
  if (needsIcon) generate(id, { fresh: regen });
}

// "Too busy": bank the day's empty slots as placeholders, to be paid back later with extra expressions.
async function markBusy(date) {
  const es = entriesOn(date);
  const made = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    if (es[slot]) continue;
    const id = `${date}_${slot}`;
    const old = state.entries.get(id);
    const entry = {
      id, date, slot, kind: 'busy', text: '', type: 'other',
      icon: null, iconKey: null, iconUploaded: true, status: 'fallback',
      deleted: false, dirty: true, rev: old?.rev,
      createdAt: old?.createdAt ?? Date.now(),
      updatedAt: nextStamp(id),
    };
    state.entries.set(id, entry);
    made.push(entry);
  }
  if (!made.length) return;
  renderAll();
  navigator.vibrate?.(8);
  toast(`已攒下 ${made.length} 条`);
  await store.save(made);
  scheduleSync();
}

function tombstone(e) {
  return {
    id: e.id, date: e.date, slot: e.slot, kind: e.kind ?? 'love', text: '', type: e.type,
    icon: null, iconKey: null, iconUploaded: false, status: 'fallback',
    deleted: true, dirty: true, rev: e.rev, createdAt: e.createdAt,
    updatedAt: nextStamp(e.id),
  };
}

async function deleteEntry() {
  const { date, slot } = draft;
  const id = `${date}_${slot}`;
  const prev = state.entries.get(id);
  if (!prev) return;
  const tomb = tombstone(prev);
  state.entries.set(id, tomb);
  inflight.delete(id);
  closeSheet($('entrySheet'));
  renderAll();
  await store.save(tomb);
  scheduleSync();
}

// ---------- icon generation ----------

// API_BASE may list several addresses of the SAME backend, separated by commas (for example one reachable from mainland
// China and one that is not). A request that cannot connect is repeated on the next address, and the address that worked
// last is tried first from then on. All addresses share one database, so nothing else depends on which one answered.
const apiBases = () =>
  String(window.LOVE_CONFIG?.API_BASE ?? '')
    .split(',')
    .map((b) => b.trim().replace(/\/+$/, ''))
    .filter(Boolean);

function apiBase() {
  const list = apiBases();
  const last = ls.get('love.apiBase');
  return list.includes(last) ? last : (list[0] ?? '');
}

const tryOrder = () => {
  const list = apiBases();
  if (!list.length) return ['']; // same origin (a local run)
  const first = apiBase();
  return [first, ...list.filter((b) => b !== first)];
};

const hostOf = (base) => {
  try {
    return new URL(base).host;
  } catch {
    return base || location.host;
  }
};

// GitHub Pages only serves static files: with no API_BASE configured there is no backend to call at all.
const staticHostWithoutBackend = () => !apiBases().length && /\.github\.io$/.test(location.hostname);

// AbortSignal.timeout() is missing in older browsers (before Safari 16): without this fallback every request would
// throw before it is even sent, and look like "can't reach the backend".
function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms);
  return controller.signal;
}

// What actually went wrong with the latest request, shown in Settings. "Can't reach the backend" alone cannot tell a
// dead network from a blocked domain, a dropped long request or an old browser; the error type and the time it took can.
function noteError(method, path, what, startedAt) {
  const secs = ((performance.now() - startedAt) / 1000).toFixed(1);
  const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('lastError').textContent = `${method} ${path} · ${what} · ${secs}s · ${time}`;
}

async function api(path, body, timeoutMs = 120_000, method = body ? 'POST' : 'GET') {
  if (staticHostWithoutBackend()) throw Object.assign(new Error('还没有连接后端'), { code: 'no_backend' });
  const headers = { 'content-type': 'application/json' };
  const code = accessCode.get();
  if (code) headers['x-access-code'] = code;

  const startedAt = performance.now();
  let res;
  let failed = null;
  for (const base of tryOrder()) {
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: timeoutSignal(timeoutMs),
      });
      failed = null;
      if (base && apiBases().length > 1 && ls.get('love.apiBase') !== base) ls.set('love.apiBase', base);
      break;
    } catch (err) {
      failed = err;
      const where = apiBases().length > 1 ? `${hostOf(base)} ` : '';
      noteError(method, path, `${where}${err?.name ?? 'Error'}: ${String(err?.message ?? err).slice(0, 70)}`, startedAt);
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      if (timedOut && path === '/api/generate') break; // the backend may have received it: never pay for it twice
    }
  }
  if (failed) {
    const timedOut = failed?.name === 'TimeoutError' || failed?.name === 'AbortError';
    throw Object.assign(new Error(timedOut ? '生成超时，请重试' : '无法连接后端'), { code: 'network' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    noteError(method, path, `HTTP ${res.status}${data.error ? ' ' + data.error : ''}`, startedAt);
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
    img.onerror = () => reject(new Error('图片无法解码，请重试'));
    img.src = dataUrl;
  });
}

const norm = (s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();

function findTwin(entry) {
  const text = norm(entry.text);
  const shared = Boolean(typeOf(entry.type).fixedSubject); // hotel / 回音: one picture for all of them, whatever the text
  for (const e of state.entries.values()) {
    if (e.id !== entry.id && !e.deleted && e.icon && e.status === 'ready' && e.type === entry.type && (shared || norm(e.text) === text)) return e;
  }
  return null;
}

// Whatever the reason (image service unreachable, region refused, over the limit, timeout), the entry keeps its built-in
// icon and nothing is shown about it. The reason is still kept in Settings → last error, and healing tries again later.
// Only a missing passcode is acted on, because that is something the visitor can fix.
function failure(err) {
  if (err.status === 401) reauth();
  return { status: 'fallback' };
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
    patch = { icon: twin.icon, iconKey: twin.iconKey ?? null, iconUploaded: twin.iconUploaded ?? false, status: 'ready' };
  } else {
    try {
      const res = await api('/api/generate', { text: current.text.slice(0, 80), type: current.type, fresh });
      updateBudget(res.budget);
      // `small` = the server handed back an icon that is already downscaled (and already stored there)
      patch = {
        icon: res.small ? res.image : await downscale(res.image),
        iconKey: res.iconKey ?? null,
        iconUploaded: res.small === true,
        status: 'ready',
      };
    } catch (err) {
      patch = failure(err);
    }
  }

  if (inflight.get(id) !== token) return; // edited again or deleted meanwhile
  inflight.delete(id);
  const entry = state.entries.get(id);
  Object.assign(entry, patch); // an icon is derived data: it does not bump updatedAt or mark the entry dirty
  if (patch.status === 'ready') popKeys.add(id);
  renderAll();
  await store.save(entry);
  if (patch.status === 'ready' && !patch.iconUploaded) scheduleSync(200); // upload the new icon for other devices
}

// ---------- access gate ----------
// The backend sits behind a passcode. On a device that does not have it yet, the very first thing on screen is a
// window asking for it; nothing behind it can be used until it is accepted.

const accessCode = {
  get: () => ls.get('love.accessCode') || ss.get('love.accessCode'),
  // "remember" keeps it on this device; otherwise it only lives until the browser session ends
  set(code, remember) {
    this.clear();
    (remember ? ls : ss).set('love.accessCode', code);
  },
  clear() {
    ls.remove('love.accessCode');
    ss.remove('love.accessCode');
  },
};

// Checks a code against the backend without storing it: 'ok' | 'wrong' | 'blocked' | 'offline'
async function verifyAccessCode(code) {
  try {
    const res = await fetch(`${apiBase()}/api/icons/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-code': code },
      body: '{"keys":[]}', // the cheapest endpoint that is behind the passcode
      signal: timeoutSignal(20_000),
    });
    if (res.ok) return { result: 'ok' };
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) return { result: 'wrong' };
    if (res.status === 403) return { result: 'blocked', message: data.message };
    return { result: 'offline' };
  } catch {
    return { result: 'offline' };
  }
}

let gatePromise = null; // non-null while the window is open

function showGate(message = '') {
  gatePromise ??= new Promise((resolve) => {
    const gate = $('gate');
    const form = $('gateForm');
    const input = $('gateCode');
    const btn = $('gateBtn');
    const skip = $('gateSkip');
    const shell = document.querySelector('.app');
    const say = (text, isError) => {
      $('gateMsg').textContent = text;
      gate.classList.toggle('err', Boolean(isError));
    };
    const close = (how) => {
      gate.hidden = true;
      shell.inert = false;
      form.onsubmit = null;
      skip.onclick = null;
      gatePromise = null;
      resolve(how);
    };

    say(message || '输入访问口令', Boolean(message));
    input.value = '';
    skip.hidden = true;
    btn.disabled = false;
    gate.hidden = false;
    shell.inert = true;
    setTimeout(() => input.focus(), 60);

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const code = input.value.trim();
      if (!code) return;
      btn.disabled = true;
      btn.textContent = '验证中…';
      const { result, message: serverMessage } = await verifyAccessCode(code);
      btn.disabled = false;
      btn.textContent = '进入';
      if (result === 'ok') {
        accessCode.set(code, $('gateRemember').checked);
        return close('ok');
      }
      if (result === 'wrong') {
        say('口令错误', true);
        input.select();
        gate.classList.remove('shake');
        void gate.offsetWidth; // restart the animation
        gate.classList.add('shake');
      } else if (result === 'blocked') {
        say(serverMessage || '后端不允许访问', true);
      } else {
        say('无法连接后端', true);
        skip.hidden = false; // can't verify while offline: let the local diary stay usable
      }
    };
    skip.onclick = () => close('skip');
  });
  return gatePromise;
}

// Startup: ask first, before anything is synced. Nothing to ask when there is no backend, when this device already
// has a code (a changed code is caught by the first sync), or when the backend does not require one.
async function ensureAccess() {
  if (staticHostWithoutBackend() || accessCode.get()) return;
  let health;
  try {
    health = await api('/api/health', null, 20_000); // generous: through a proxy the first answer can take a few seconds
  } catch {
    return; // backend unreachable: stay local, syncing retries on its own
  }
  state.health = health;
  updateBudget(health.budget);
  if (health.accessRequired) await showGate();
}

// The stored code was rejected (it was changed on the server): forget it and ask again.
async function reauth(message = '口令无效或已更改，请重新输入') {
  if (gatePromise) return;
  accessCode.clear();
  if ((await showGate(message)) === 'ok') runSync();
}

// ---------- sync ----------
// Offline-first: this device always works from its own IndexedDB copy. Changed entries are flagged `dirty`
// and pushed; the server answers with everything newer than our cursor. Per entry the latest updatedAt wins.

const syncMeta = {
  key: () => `love.sync:${apiBases()[0] ?? ''}`, // the first address: stable, whichever mirror answers
  load() {
    try {
      return JSON.parse(ls.get(this.key())) ?? {};
    } catch {
      return {};
    }
  },
  save(value) {
    ls.set(this.key(), JSON.stringify(value));
  },
};
const sync = { status: 'idle', lastAt: 0, running: false, again: false, timer: 0, missUntil: new Map(), authWarned: false };
const dirtyCount = () => [...state.entries.values()].filter((e) => e.dirty).length;

function renderSyncStatus() {
  const n = dirtyCount();
  const time = sync.lastAt ? new Date(sync.lastAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  const labels = {
    idle: ['等待同步', '联网后自动同步'],
    syncing: ['同步中…', '同步中…'],
    ok: [`已同步 · ${time}`, '已同步'],
    offline: [n ? `离线，${n} 条待同步` : '离线', '离线 · 联网后自动同步'],
    auth: ['需要访问口令', '在设置中填写访问口令以同步'],
    off: ['仅本机（未连接后端）', '仅本地存储'],
  };
  const [setting, footer] = labels[sync.status] ?? labels.idle;
  $('syncStatus').textContent = setting;
  $('foot').textContent = footer;
}

function setSyncStatus(status) {
  sync.status = status;
  if (status === 'ok') sync.lastAt = Date.now();
  renderSyncStatus();
}

function scheduleSync(delay = 800) {
  clearTimeout(sync.timer);
  sync.timer = setTimeout(runSync, delay);
}

// Offer the server our full copy: entries *and* their icons (a reset server has lost both).
async function markAllDirty() {
  const all = [...state.entries.values()];
  all.forEach((e) => {
    e.dirty = true;
    if (e.icon) e.iconUploaded = false;
  });
  await store.save(all);
}

const wire = (e) => ({ date: e.date, slot: e.slot, kind: e.kind ?? 'love', text: e.text, type: e.type, deleted: e.deleted === true, createdAt: e.createdAt, updatedAt: e.updatedAt, baseRev: e.rev ?? 0 });

// Last resort when a conflicting record cannot be kept in the calendar (that day is completely full): it is kept here and
// included in "导出备份", so that no record is ever simply gone.
function keepOverwritten(snap) {
  let list = [];
  try {
    list = JSON.parse(ls.get('love.overwritten') || '[]');
  } catch {}
  list.push({ date: snap.date, text: snap.text, type: snap.type, at: new Date().toISOString() });
  ls.set('love.overwritten', JSON.stringify(list.slice(-100)));
}

// The server refused to overwrite someone else's different content with ours, and sent theirs. Ours is not thrown away: it
// moves to the next free place on that day (pushed on the next round), so that both records exist.
function placeRescues(rescues, touched) {
  let kept = 0;
  for (const snap of rescues) {
    let slot = -1;
    for (let s = 0; s < SLOTS + EXTRA_SLOTS; s++) {
      if (!liveEntry(`${snap.date}_${s}`)) {
        slot = s;
        break;
      }
    }
    if (slot < 0) {
      keepOverwritten(snap);
      kept += 1;
      continue;
    }
    const id = `${snap.date}_${slot}`;
    const old = state.entries.get(id); // may be a tombstone
    const entry = {
      id, date: snap.date, slot, kind: 'love', text: snap.text, type: snap.type,
      icon: snap.icon ?? null, iconKey: snap.iconKey ?? null, iconUploaded: snap.iconUploaded ?? false,
      status: snap.status === 'pending' ? 'fallback' : snap.status ?? 'fallback',
      deleted: false, dirty: true, rev: old?.rev,
      createdAt: snap.createdAt, updatedAt: nextStamp(id),
    };
    state.entries.set(id, entry);
    touched.set(id, entry);
    kept += 1;
  }
  if (rescues.length) {
    sync.again = true; // push the saved copies
    toast(`有 ${kept} 条记录和别处的修改撞在同一格，已保留并另存到同一天的空位`);
  }
}

// `force`: the server reported this entry as a conflict, so its version replaces ours even when ours looks newer (ours was
// already set aside by placeRescues). `sentAt`: what we pushed this round (id -> updatedAt).
function applyRemote(r, touched, { force = false, sentAt = new Map() } = {}) {
  const local = state.entries.get(r.id);
  if (!force && local && local.updatedAt > r.updatedAt) {
    // our edit is newer and still unsent. If the remote entry is just our own previous push coming back, move our base
    // forward; if it is someone else's, leave the base behind so that our next push is recognised as a conflict
    if (sentAt.get(r.id) === r.updatedAt) {
      local.rev = r.rev;
      local.iconKey = r.iconKey ?? local.iconKey ?? null;
      touched.set(local.id, local);
    }
    return;
  }
  if (!force && local && local.updatedAt === r.updatedAt) {
    local.rev = r.rev;
    local.iconKey = r.iconKey ?? local.iconKey ?? null;
    touched.set(local.id, local);
    return;
  }

  // the other device's version is newer (or this entry is new here)
  const kind = r.kind === 'busy' ? 'busy' : 'love';
  const contentChanged =
    !local || (local.kind ?? 'love') !== kind || local.text !== r.text || local.type !== r.type || local.deleted !== (r.deleted === true);
  const merged = {
    ...(local ?? {}),
    id: r.id, date: r.date, slot: r.slot, kind, text: r.text, type: r.type,
    deleted: r.deleted === true, createdAt: r.createdAt, updatedAt: r.updatedAt, rev: r.rev,
    iconKey: r.iconKey ?? null, dirty: false,
  };
  if (contentChanged) {
    inflight.delete(r.id); // a generation for the old text is no longer wanted
    Object.assign(merged, { icon: null, iconUploaded: true, status: 'fallback' }); // the icon is fetched below
  }
  state.entries.set(r.id, merged);
  touched.set(r.id, merged);
}

async function syncIcons() {
  const changed = new Map();
  const rethrow = (err) => { if (err.code === 'network' || err.status === 401 || err.code === 'access_code_required') throw err; };

  // 1. give the server the small icons it does not have yet (so other devices can show them)
  for (const e of live()) {
    if (!(e.icon && e.iconKey && !e.iconUploaded && e.status === 'ready')) continue;
    try {
      await api(`/api/icons/${e.iconKey}`, { image: e.icon }, 30_000, 'PUT');
      e.iconUploaded = true;
      changed.set(e.id, e);
    } catch (err) {
      rethrow(err);
    }
  }

  // 2. fetch icons that other devices (or the server) already have
  const need = live().filter((e) => !e.icon && e.iconKey && e.status !== 'pending' && !(sync.missUntil.get(e.iconKey) > Date.now()));
  const keys = [...new Set(need.map((e) => e.iconKey))];
  for (let i = 0; i < keys.length; i += 40) {
    const chunk = keys.slice(i, i + 40);
    const { icons } = await api('/api/icons/get', { keys: chunk }, 30_000);
    for (const k of chunk) if (!icons[k]) sync.missUntil.set(k, Date.now() + 5 * 60_000);
    for (const e of need) {
      if (!icons[e.iconKey]) continue;
      Object.assign(e, { icon: icons[e.iconKey], iconUploaded: true, status: 'ready' });
      popKeys.add(e.id);
      changed.set(e.id, e);
    }
  }

  if (changed.size) {
    await store.save([...changed.values()]);
    renderAll();
  }
}

async function syncOnce() {
  let meta = syncMeta.load();
  if (!meta.epoch) {
    await markAllDirty(); // first time with this backend: offer everything we have
    meta = { cursor: 0, epoch: null };
  }

  const sent = [...state.entries.values()].filter((e) => e.dirty);
  const sentAt = new Map(sent.map((e) => [e.id, e.updatedAt]));
  const res = await api('/api/sync', { since: meta.cursor ?? 0, epoch: meta.epoch ?? null, changes: sent.map(wire) }, 60_000);

  const touched = new Map();
  for (const s of sent) {
    const cur = state.entries.get(s.id);
    if (cur && cur.updatedAt === s.updatedAt) { // not edited again while the request was in flight
      cur.dirty = false;
      touched.set(cur.id, cur);
    }
  }
  // entries the server refused to overwrite because someone else wrote different content there: keep ours, then take theirs
  const conflictIds = new Set(res.conflicts ?? []);
  const rescues = [];
  for (const id of conflictIds) {
    const local = state.entries.get(id);
    if (local && !local.deleted && (local.kind ?? 'love') === 'love' && sentAt.has(id)) rescues.push({ ...local });
  }
  for (const remote of res.entries) applyRemote(remote, touched, { force: conflictIds.has(remote.id), sentAt });
  placeRescues(rescues, touched);

  if (res.resync) {
    // the server's data was reset since we last talked to it: push our full copy again
    syncMeta.save({ cursor: 0, epoch: res.epoch });
    await markAllDirty();
    sync.again = true;
  } else {
    syncMeta.save({ cursor: res.cursor, epoch: res.epoch });
  }

  if (touched.size) await store.save([...touched.values()]);
  renderAll();
  await syncIcons();
}

async function runSync() {
  if (gatePromise) return; // wait until the passcode window is closed
  if (sync.running) {
    sync.again = true;
    return;
  }
  sync.running = true;
  setSyncStatus('syncing');
  let outcome = 'ok';
  try {
    do {
      sync.again = false;
      await syncOnce();
    } while (sync.again);
  } catch (err) {
    if (err.code === 'no_backend' || err.code === 'not_configured') outcome = 'off';
    else if (err.status === 401) {
      outcome = 'auth';
      reauth();
    } else if (err.code === 'access_code_required') {
      outcome = 'auth';
      if (!sync.authWarned) {
        sync.authWarned = true;
        toast(err.message || '后端不允许访问');
      }
    } else outcome = 'offline';
  } finally {
    sync.running = false;
  }
  setSyncStatus(outcome);
  if (outcome === 'ok') setTimeout(() => healIcons(), 0); // fill in pictures that are missing, without blocking the sync
}

// ---------- healing: a record never stays stuck without its picture ----------
// A picture is only decoration. A failed generation must not leave an entry broken for good, and nothing a visitor has
// written is ever lost because a picture failed. Gaps are filled from anything already finished: first another entry on
// this device, then the backend's stored copy (both free), and only then by generating, a few times with growing pauses.

const HEAL_MAX_TRIES = 3;
const HEAL_BACKOFF = [30_000, 5 * 60_000, 30 * 60_000]; // wait after the 1st, 2nd and 3rd failed automatic attempt
let healing = false;

async function healIcons({ force = false } = {}) {
  if (healing || gatePromise || sync.status !== 'ok') return; // only while the backend is reachable
  healing = true;
  const changed = new Map();
  try {
    let generated = 0;
    for (const candidate of live().filter((x) => !isBusy(x) && !x.icon && x.status !== 'pending')) {
      const e = state.entries.get(candidate.id);
      if (!e || e.icon || e.status === 'pending') continue;

      // 1) an identical entry on this device already has a picture
      const twin = findTwin(e);
      if (twin) {
        Object.assign(e, { icon: twin.icon, iconKey: twin.iconKey ?? e.iconKey ?? null, iconUploaded: twin.iconUploaded ?? false, status: 'ready' });
        popKeys.add(e.id);
        changed.set(e.id, e);
        continue;
      }

      // 2) the backend may already hold a finished one (asking is free and never generates)
      if (force || Date.now() >= (e.healCheckAt ?? 0)) {
        try {
          const res = await api('/api/generate', { text: e.text.slice(0, 80), type: e.type, cacheOnly: true }, 20_000);
          if (res.image) {
            Object.assign(e, {
              icon: res.small ? res.image : await downscale(res.image),
              iconKey: res.iconKey ?? e.iconKey ?? null,
              iconUploaded: res.small === true,
              status: 'ready',
            });
            popKeys.add(e.id);
            changed.set(e.id, e);
            continue;
          }
          e.healCheckAt = Date.now() + 2 * 60_000; // nothing stored yet: don't ask again for a couple of minutes
          changed.set(e.id, e);
        } catch (err) {
          if (err.status === 401) {
            reauth();
            break;
          }
          if (err.code === 'network') break; // offline again: try on the next sync
        }
      }

      // 3) generate it (this part costs about $0.007): at most a few times, never in a tight loop
      const tries = e.healTries ?? 0;
      if (generated >= 2 || (!force && (tries >= HEAL_MAX_TRIES || Date.now() < (e.healNextAt ?? 0)))) continue;
      generated += 1;
      e.healTries = tries + 1;
      e.healNextAt = Date.now() + HEAL_BACKOFF[Math.min(tries, HEAL_BACKOFF.length - 1)];
      e.status = 'pending';
      changed.set(e.id, e);
      renderAll();
      await generate(e.id);
    }
  } finally {
    healing = false;
    if (changed.size) {
      await store.save([...changed.values()]);
      renderAll();
      scheduleSync(300); // upload the pictures that were just found or made
    }
  }
}

// "Force refresh": throw away every cached failure and pull everything from the backend again. Records are never touched,
// only their pictures' state and the sync bookkeeping.
async function forceRefresh() {
  toast('正在从后端重新同步…');
  sync.missUntil.clear();
  syncMeta.save({ ...syncMeta.load(), cursor: 0 }); // ask for everything, not only what changed
  const all = [...state.entries.values()];
  for (const e of all) {
    if (e.status === 'error') e.status = 'fallback';
    Object.assign(e, { healTries: 0, healNextAt: 0, healCheckAt: 0 });
  }
  await store.save(all);
  renderAll();
  await runSync();
  await healIcons({ force: true });
  await checkForNewVersion();
  navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {}); // pick up a newer sw.js too
}

// One tap that explains why this device cannot reach the backend. Every step is timed and shows its exact error, so
// "blocked address" can be told apart from "no internet at all", "refused by the server" and "something in the browser".
async function diagnose() {
  const out = $('diagOut');
  const copy = $('diagCopyBtn');
  out.hidden = false;
  copy.hidden = true;
  $('diagBtn').disabled = true;
  const lines = [];
  const show = () => (out.textContent = lines.join('\n'));
  const probe = async (label, fn) => {
    const t0 = performance.now();
    let ok = false;
    try {
      const detail = await fn();
      lines.push(`✓ ${label} · ${Math.round(performance.now() - t0)}ms${detail ? ' · ' + detail : ''}`);
      ok = true;
    } catch (err) {
      lines.push(`✗ ${label} · ${Math.round(performance.now() - t0)}ms · ${err?.name ?? 'Error'}: ${String(err?.message ?? err).slice(0, 80)}`);
    }
    show();
    return ok;
  };

  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  lines.push(
    'CALENDAR 连接诊断',
    `${new Date().toISOString()} · 版本 ${(window.LOVE_CONFIG?.BUILD ?? 'dev').slice(0, 7)}`,
    navigator.userAgent,
    `在线 ${navigator.onLine ? '是' : '否'} · 主屏幕模式 ${standalone ? '是' : '否'} · 本机存储 ${store.persistent ? '正常' : '不可用'}`,
    '',
  );
  show();

  // does this device reach Cloudflare at all? (opaque answer is enough: it only has to connect)
  const cloudflare = await probe('能连上 Cloudflare', async () => {
    await fetch('https://www.cloudflare.com/cdn-cgi/trace', { mode: 'no-cors', cache: 'no-store', signal: timeoutSignal(12_000) });
  });

  let reachable = 0;
  const bases = apiBases().length ? apiBases() : [''];
  for (const base of bases) {
    const name = base ? hostOf(base) : '本机';
    const health = await probe(`${name} · 健康检查`, async () => {
      const res = await fetch(`${base}/api/health`, { cache: 'no-store', signal: timeoutSignal(15_000) });
      const data = await res.json().catch(() => ({}));
      const via = data.via?.country ? ` · 后端看到你在 ${data.via.country}${data.via.colo ? ' (' + data.via.colo + ')' : ''}` : '';
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { name: 'HTTP' });
      return `HTTP ${res.status}${via}`;
    });
    // the request the app really uses for syncing: a JSON POST, which the browser pre-flights across origins
    const channel = await probe(`${name} · 同步通道`, async () => {
      const res = await fetch(`${base}/api/icons/get`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"keys":[]}',
        cache: 'no-store',
        signal: timeoutSignal(15_000),
      });
      return `HTTP ${res.status}${res.status === 401 ? '（需要口令，但已连通）' : ''}`;
    });
    if (health && channel) reachable += 1;
  }

  lines.push('');
  if (reachable === bases.length) lines.push('结论：所有后端地址都能连上。如果应用里仍然失败，把这段结果发给开发者。');
  else if (reachable > 0) lines.push(`结论：有 ${bases.length - reachable} 个后端地址连不上，但至少有 ${reachable} 个正常，应用会自动改用能连上的那个。`);
  else if (cloudflare) lines.push('结论：这台设备的网络是通的，但所有后端地址都连不上，说明这个网络拦了这些地址。');
  else lines.push('结论：这台设备连 Cloudflare 都连不上，可能没有网络，或网络限制很严。');
  show();
  copy.hidden = false;
  $('diagBtn').disabled = false;
}

async function copyDiagnosis() {
  const text = $('diagOut').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('长按上面的文字，选择全部后复制');
  }
}

// A page can outlive a deployment by minutes (the host lets browsers reuse files for up to 10). Every deployment stamps its
// build id into config.js and version.json; if the live id differs from the one this page was loaded with, reload once onto
// a URL that cannot be cached.
async function checkForNewVersion() {
  const mine = window.LOVE_CONFIG?.BUILD;
  if (!mine) return; // local development: nothing to compare
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { build } = await res.json();
    if (build && build !== mine && ss.get('love.reloadedFor') !== build) {
      ss.set('love.reloadedFor', build); // never loop if the new files are somehow not served yet
      location.replace(`${location.pathname}?v=${build}`);
    }
  } catch {}
}

// ---------- budget ----------

const usd =(n) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
let warnedBudget = false;

function updateBudget(b) {
  if (!b) return;
  state.budget = b;
  const banner = $('budgetBanner');
  banner.hidden = !b.overBudget;
  if (b.overBudget) {
    banner.textContent = `图标生成已花费约 ${usd(b.spentUsd)}，超过 ${usd(b.warnAtUsd)} 提醒线。请到 OpenAI 后台核对用量。`;
    if (!warnedBudget) {
      warnedBudget = true;
      toast(`花费已超过 ${usd(b.warnAtUsd)} 提醒线`);
    }
  }
  renderSpend();
}

function renderSpend() {
  const b = state.budget;
  $('spendStatus').textContent = b ? `${usd(b.spentUsd)} / ${usd(b.warnAtUsd)}` : '—';
}

// ---------- settings ----------

function renderApiStatus() {
  const h = state.health;
  let text = '检查中…';
  if (h === null) text = '未连接';
  else if (h) text = !h.imageConfigured ? '后端未配置图像 API' : h.accessRequired && !accessCode.get() ? '需要访问口令' : `已连接 · ${h.model}`;
  $('apiStatus').textContent = text;

  // the passcode rows only make sense when the backend actually asks for one
  const gated = Boolean(h?.accessRequired);
  $('accessCode').closest('.group-row').hidden = !gated;
  $('lockBtn').hidden = !gated;

  let storage = h === null ? '—' : '检查中…';
  if (h) storage = h.store === 'upstash' ? 'Upstash（持久）' : h.ephemeralRisk ? '临时磁盘，重启会丢数据（需接 Upstash）' : '服务器本地文件';
  $('storeStatus').textContent = storage;
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
  $('accessCode').value = accessCode.get();
  state.health = undefined;
  renderApiStatus();
  openSheet($('settingsSheet'));
  checkHealth(20_000);
}

function exportData() {
  const entries = live().map(({ id, date, slot, kind, text, type, icon, createdAt, updatedAt }) => ({ id, date, slot, kind: kind ?? 'love', text, type, icon, createdAt, updatedAt }));
  let overwritten = [];
  try {
    overwritten = JSON.parse(ls.get('love.overwritten') || '[]');
  } catch {}
  const payload = JSON.stringify({ app: 'love-calendar', version: 1, exportedAt: new Date().toISOString(), entries, overwritten });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  a.download = `love-calendar-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function sanitizeEntry(raw) {
  const slot = Number(raw?.slot);
  const kind = raw?.kind === 'busy' ? 'busy' : 'love';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw?.date) || !Number.isInteger(slot) || slot < 0 || slot >= SLOTS + EXTRA_SLOTS) return null;
  if (kind === 'busy' && slot >= SLOTS) return null; // only the two daily slots can be banked
  if (kind === 'love' && (typeof raw.text !== 'string' || !raw.text.trim())) return null;
  const importedType = kind === 'love' && TYPE_IDS.includes(raw.type) ? raw.type : 'other';
  const okIcon = kind === 'love' && typeof raw.icon === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw.icon);
  return {
    id: `${raw.date}_${slot}`,
    date: raw.date,
    slot,
    kind,
    text: kind === 'busy' ? '' : tidyText(importedType, raw.text),
    type: importedType,
    icon: okIcon ? raw.icon : null,
    iconKey: null, // the server assigns it on the next sync; the icon is then uploaded from here
    iconUploaded: kind === 'busy', // a banked placeholder has no icon to upload
    status: okIcon ? 'ready' : 'fallback',
    deleted: false,
    dirty: true,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
}

async function importData(file) {
  try {
    const json = JSON.parse(await file.text());
    const list = (Array.isArray(json?.entries) ? json.entries : []).map(sanitizeEntry).filter(Boolean);
    if (!list.length) return toast('文件里没有可导入的记录');
    list.forEach((e) => {
      e.updatedAt = nextStamp(e.id); // an import is a deliberate act: it wins over what is there, on every device
      state.entries.set(e.id, e);
    });
    await store.save(list);
    renderAll();
    scheduleSync();
    toast(`已导入 ${list.length} 条`);
  } catch {
    toast('无法读取，请选择导出的 JSON 文件');
  }
}

// ---------- events ----------

function bind() {
  $('days').addEventListener('click', (ev) => {
    const cell = ev.target.closest('.day-cell[data-date]');
    if (cell) select(cell.dataset.date);
  });

  $('dayCard').addEventListener('click', (ev) => {
    if (ev.target.closest('a')) return; // a link in an entry: let the browser follow it
    if (ev.target.closest('[data-busy]')) {
      markBusy(state.selected);
      return;
    }
    if (ev.target.closest('[data-redeem]')) {
      const slot = nextExtraSlot(state.selected);
      if (slot !== null) openEntry(state.selected, slot);
      return;
    }
    const slot = ev.target.closest('.slot');
    if (slot) openEntry(state.selected, Number(slot.dataset.slot));
  });
  $('dayCard').addEventListener('keydown', (ev) => {
    if (ev.target.closest?.('a')) return; // Enter on a link follows it
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
  $('deleteBtn').addEventListener('click', (ev) => confirmTap(ev.currentTarget, draft.busy ? '再点一次确认取消' : '再点一次确认删除', deleteEntry));

  // settings sheet
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsDone').addEventListener('click', () => closeSheet($('settingsSheet')));
  $('accessCode').addEventListener('change', () => {
    const typed = $('accessCode').value.trim();
    if (typed) accessCode.set(typed, true);
    else accessCode.clear();
    sync.authWarned = false;
    renderApiStatus();
    runSync();
  });
  $('syncNowBtn').addEventListener('click', runSync);
  $('forceBtn').addEventListener('click', forceRefresh);
  $('diagBtn').addEventListener('click', diagnose);
  $('diagCopyBtn').addEventListener('click', copyDiagnosis);
  $('lockBtn').addEventListener('click', () => {
    closeSheet($('settingsSheet'));
    reauth('已锁定，请输入访问口令');
  });
  $('exportBtn').addEventListener('click', exportData);
  $('importFile').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (file) importData(file);
  });
  $('clearBtn').addEventListener('click', (ev) =>
    confirmTap(ev.currentTarget, '再点一次：所有设备都会清空', async () => {
      // tombstones, not a wipe: otherwise the next sync would simply bring everything back
      const tombs = live().map(tombstone);
      tombs.forEach((t) => state.entries.set(t.id, t));
      inflight.clear();
      await store.save(tombs);
      renderAll();
      scheduleSync();
      toast('已清空');
    }),
  );

  // backdrop click + Esc close the top sheet
  document.querySelectorAll('.backdrop').forEach((el) => el.addEventListener('mousedown', (ev) => ev.target === el && closeSheet(el)));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') document.querySelectorAll('.backdrop.open').forEach(closeSheet);
  });

  // the date may roll over while the tab stays open; coming back to the tab is also a good moment to sync
  let lastDay = todayKey();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (todayKey() !== lastDay) {
      lastDay = todayKey();
      renderAll();
    }
    runSync();
    checkForNewVersion();
  });
  window.addEventListener('online', runSync);
  // pick up what other devices wrote; skip while there is no backend / no passcode, a retry won't help
  setInterval(() => {
    if (document.visibilityState === 'visible' && sync.status !== 'off' && sync.status !== 'auth') runSync();
  }, 60_000);
}

// While a host badge floats over the bottom-right corner (it is a direct child of <body>, and disappears when the visitor
// dismisses it), the stylesheet reserves room at the bottom so no button of ours can end up underneath it.
function watchHostBadge() {
  const sync = () => document.documentElement.classList.toggle('has-host-badge', Boolean(document.getElementById('nl-badge-frame')));
  sync();
  new MutationObserver(sync).observe(document.body, { childList: true });
}

// ---------- visit log ----------
// Anonymous: when this page was opened, for how long it was in view (time in the foreground), and the kind of device.
// Nothing else is sent: no address, no name, nothing from the diary, and the visit number is made up fresh on every open,
// so two visits cannot be linked. Not recorded on the owner's own devices (open the site once with ?me to mark one, ?me=0
// to unmark it), nor while developing locally (?track forces it, for testing).
function startVisitLog() {
  const q = new URLSearchParams(location.search);
  if (q.has('me')) {
    if (q.get('me') === '0') ls.remove('love.owner');
    else ls.set('love.owner', '1');
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if ((local && !q.has('track')) || q.has('debug') || ls.get('love.owner') || staticHostWithoutBackend()) return;

  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);
  const touch = navigator.maxTouchPoints > 0;
  const device = touch ? (Math.min(screen.width, screen.height) < 700 ? 'phone' : 'tablet') : 'desktop';

  let total = 0; // milliseconds in view so far, not counting the stretch that is still running
  let since = document.visibilityState === 'visible' ? performance.now() : null; // when the current stretch began
  const stop = () => {
    if (since === null) return;
    total += performance.now() - since;
    since = null;
  };
  const report = () => {
    const url = `${apiBase()}/api/visit`;
    const body = JSON.stringify({ id, device, seconds: Math.round((total + (since === null ? 0 : performance.now() - since)) / 1000) });
    // text/plain keeps this a "simple" request: no pre-flight, which a beacon sent while the page is closing could not wait for
    const sent = navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
    if (!sent) fetch(url, { method: 'POST', body, headers: { 'content-type': 'text/plain;charset=UTF-8' }, keepalive: true }).catch(() => {});
  };

  report(); // opened
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stop();
      report(); // left (switched app, locked the phone, closed the tab): the total so far
    } else if (since === null) since = performance.now();
  });
  window.addEventListener('pagehide', () => {
    if (since === null) return; // already reported when it went to the background
    stop();
    report();
  });
}

// ---------- init ----------

async function init() {
  store.onPersistFailure(() => toast('本机存储失败：记录暂时只在内存里，请尽快「导出备份」'));
  checkForNewVersion(); // a stale page reloads itself onto the latest version before doing anything else
  $('dow').innerHTML = DOW_MON_FIRST.map((d) => `<span>${d}</span>`).join('');
  buildChips();

  const t = new Date();
  state.view = { y: t.getFullYear(), m: t.getMonth() };

  for (const e of await store.loadAll()) {
    if (e.status === 'pending' || e.status === 'error') {
      // a generation that was cut off by a reload, or a failure stored by an older version: show the built-in icon;
      // healing fills in the picture later (a few automatic tries, never in a loop)
      e.status = 'fallback';
      store.save(e);
    }
    state.entries.set(e.id, e);
  }
  renderAll();
  renderSyncStatus();
  bind();
  watchHostBadge();
  startVisitLog();
  // lets the app open like an installed one, also with no network (see sw.js); a failure here changes nothing else
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (new URLSearchParams(location.search).has('debug')) window.__love = { state, runSync, healIcons, forceRefresh, checkForNewVersion, api };
  if (!store.persistent) toast('当前浏览器禁用了本地存储，刷新后记录会丢失');

  await ensureAccess(); // may show the passcode window first; nothing below runs until it is closed

  // both double as a warm-up ping for hosts that sleep when idle
  checkHealth(60_000);
  runSync();
}

init();
