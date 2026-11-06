const $ = (id) => document.getElementById(id);
const NEWTAB = new URL('newtab.html', location.href).href;
const ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q='
};
let store = { bookmarks: [], history: [], settings: { engine: 'google', adblock: true } };
let tabs = [], active = null, idc = 0, closed = [];

const isNewtab = (u) => !u || (u.startsWith('file:') && u.includes('newtab.html'));
const save = () => window.aura.setStore(store);
const fav = (u) => { try { return 'https://www.google.com/s2/favicons?sz=32&domain=' + new URL(u).hostname; } catch { return ''; } };

function toUrl(q) {
  q = q.trim();
  if (!q) return null;
  if (/^(https?|file|about|chrome):/i.test(q)) return q;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(q) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(q) && !q.includes(' ')) return 'https://' + q;
  return ENGINES[store.settings.engine || 'google'] + encodeURIComponent(q);
}
function newtabSrc() {
  const bm = store.bookmarks.slice(0, 12).map(b => ({ t: b.title, u: b.url }));
  const eco = { lvl: saverLevel(), pct: battLevel === null ? null : Math.round(battLevel * 100), chg: !!(charging && !onBattery), rest: restingCount(), ads: blocked };
  return NEWTAB + '#' + encodeURIComponent(JSON.stringify({ e: ENGINES[store.settings.engine || 'google'], bm, bg: store.settings.bg || { type: 'preset', value: 'aura' }, eco }));
}

function makeWebview(t, url) {
  const wv = document.createElement('webview');
  wv.setAttribute('allowpopups', '');
  if (store.partition) wv.setAttribute('partition', store.partition);
  if (saverActive()) wv.setAttribute('webpreferences', 'autoplayPolicy=document-user-activation-required, backgroundThrottling=true');
  else wv.setAttribute('webpreferences', 'backgroundThrottling=true');
  wv.setAttribute('src', url);
  $('views').appendChild(wv);
  wv.addEventListener('focus', () => { if (t !== active && isShown(t)) activate(t); });
  t.wv = wv; t.ready = false; t.loading = true; t.frozen = false; t.sleeping = false;

  wv.addEventListener('dom-ready', () => { t.ready = true; try { t.wcId = wv.getWebContentsId(); } catch {} emulateFor(t); sendFps(t); t.hideKey = null; applyHides(t); if (t === active) updateNav(); else if (!isShown(t)) scheduleFreeze(t); });
  wv.addEventListener('did-start-loading', () => { t.loading = true; renderTab(t); if (t === active) progress(30); });
  wv.addEventListener('did-stop-loading', () => { t.loading = false; renderTab(t); if (t === active) { progress(100); updateNav(); } });
  wv.addEventListener('page-title-updated', (e) => { t.title = e.title; renderTab(t); saveSession(); if (!isNewtab(t.url)) addHistory(t); });
  wv.addEventListener('page-favicon-updated', (e) => { t.icon = e.favicons[0]; renderTab(t); });
  const nav = (e) => { t.url = e.url; t.icon = null; if (t === active) { updateNav(); } renderTab(t); saveSession(); };
  wv.addEventListener('ipc-message', (e) => { if (e.channel === 'orchard-context') showPageMenu(t, e.args[0]); });
  wv.addEventListener('did-navigate', nav);
  wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) nav(e); });
  wv.addEventListener('found-in-page', (e) => { $('findRes').textContent = e.result.matches ? e.result.activeMatchOrdinal + '/' + e.result.matches : '0/0'; });
  wv.addEventListener('media-started-playing', () => { t.audio = true; renderTab(t); });
  wv.addEventListener('media-paused', () => { t.audio = false; renderTab(t); if (t !== active) scheduleFreeze(t); });
  wv.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3 || !e.isMainFrame) return;
    wv.executeJavaScript(`document.body.innerHTML='<div style="font-family:Segoe UI;text-align:center;margin-top:18vh;color:#444"><h1 style=font-size:60px>&#128565;</h1><h2>Bro this page aint loading</h2><p>${String(e.errorDescription).replace(/[<>'"`]/g,'')}</p></div>'`).catch(()=>{});
  });
}

function createTab(url, bg, asleep) {
  const id = ++idc;
  const el = document.createElement('div');
  el.className = 'tab new';
  setTimeout(() => el.classList.remove('new'), 260);
  $('tabs').insertBefore(el, $('newtab'));
  const t = { id, el, title: 'New Tab', url: url || '', lastActive: Date.now() };
  tabs.push(t);
  if (asleep && url) { t.sleeping = true; t.title = url; }
  else makeWebview(t, url || newtabSrc());
  renderTab(t);
  saveSession();
  el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } });
  el.addEventListener('click', (e) => { if (dragJustEnded) return; if (e.target.classList.contains('x')) closeTab(t); else activate(t); });
  el.addEventListener('pointerdown', (e) => startTabDrag(e, t));
  el.addEventListener('contextmenu', (e) => tabMenu(e, t));
  if (!bg) activate(t);
  return t;
}

// ---- tab dragging: reorder, tear off into a new window, or drop into another window ----
let drag = null, dragJustEnded = false;
function startTabDrag(e, t) {
  if (e.button !== 0 || e.target.classList.contains('x')) return;
  drag = { t, x0: e.clientX, y0: e.clientY, off: e.clientX - t.el.getBoundingClientRect().left, on: false, out: false, pid: e.pointerId };
  try { t.el.setPointerCapture(e.pointerId); } catch {}
}
let dragFrame = 0, dragEvt = null;
document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pid) return;
  dragEvt = e;
  if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; if (drag && dragEvt) dragStep(dragEvt); });
});
function glide(el, fromLeft) {
  // FLIP: start where it was, glide to where it is now
  const now = el.getBoundingClientRect().left, dx = fromLeft - now;
  if (!dx) return;
  el.style.transition = 'none'; el.style.transform = `translateX(${dx}px)`;
  el.getBoundingClientRect();
  el.style.transition = 'transform .2s var(--ease)'; el.style.transform = '';
  setTimeout(() => { if (!el.classList.contains('dragging')) el.style.transition = ''; }, 220);
}
function dragStep(e) {
  const d = drag;
  if (!d.on) {
    if (Math.abs(e.clientX - d.x0) < 5 && Math.abs(e.clientY - d.y0) < 5) return;
    d.on = true; d.t.el.classList.add('dragging'); activate(d.t);
  }
  const strip = $('tabs').getBoundingClientRect();
  d.out = e.clientY < strip.top - 40 || e.clientY > strip.bottom + 50 || e.clientX < -20 || e.clientX > innerWidth + 20;
  document.body.classList.toggle('tearing', d.out);
  if (d.out) { d.t.el.style.transform = `translate(${e.clientX - d.x0}px, ${e.clientY - d.y0}px)`; return; }
  const els = [...$('tabs').querySelectorAll('.tab:not(.closing)')];
  const me = d.t.el;
  const base = me.getBoundingClientRect().left - (parseFloat(me.dataset.dx) || 0);
  const maxRight = strip.right - me.offsetWidth - 40;
  const dx = Math.max(strip.left - base, Math.min(maxRight - base, e.clientX - d.off - base));
  me.style.transform = `translateX(${dx}px)`; me.dataset.dx = dx;
  const mid = base + dx + me.offsetWidth / 2;
  for (const o of els) {
    if (o === me) continue;
    const rr = o.getBoundingClientRect();
    const om = rr.left + rr.width / 2;
    const idxMe = els.indexOf(me), idxO = els.indexOf(o);
    if ((idxO > idxMe && mid > om) || (idxO < idxMe && mid < om)) {
      const before = me.getBoundingClientRect().left - dx, oBefore = rr.left;
      if (idxO > idxMe) o.after(me); else o.before(me);
      const shift = (me.getBoundingClientRect().left - dx) - before;
      me.dataset.dx = dx - shift; me.style.transform = `translateX(${dx - shift}px)`;
      glide(o, oBefore);
      syncTabOrder();
      break;
    }
  }
}
function syncTabOrder() {
  const order = [...$('tabs').querySelectorAll('.tab:not(.closing)')];
  tabs.sort((a, b) => order.indexOf(a.el) - order.indexOf(b.el));
  saveSession();
}
async function endTabDrag(e) {
  if (!drag || (e && e.pointerId !== drag.pid)) return;
  const d = drag; drag = null;
  document.body.classList.remove('tearing');
  const el = d.t.el;
  el.classList.remove('dragging'); el.dataset.dx = 0;
  if (d.on && !d.out) { el.classList.add('settle'); requestAnimationFrame(() => { el.style.transform = ''; setTimeout(() => el.classList.remove('settle'), 220); }); }
  else el.style.transform = '';
  if (!d.on) return;
  dragJustEnded = true; setTimeout(() => dragJustEnded = false, 50);
  if (!d.out || !e) return;
  const t = d.t;
  const url = t.url && !isNewtab(t.url) ? t.url : '';
  const res = await window.aura.tearTab({ url, title: t.title, x: e.screenX, y: e.screenY, onlyTab: tabs.length === 1 });
  if (!res) return;
  if (tabs.length === 1) { if (res === 'moved') window.aura.win('close'); return; }
  closeTab(t, true);
}
document.addEventListener('pointerup', endTabDrag);
document.addEventListener('pointercancel', () => endTabDrag(null));

function renderTab(t) {
  let icon;
  const masked = t.locked && !t.unlocked && lockReady();
  if (masked) icon = '<span style="width:16px;text-align:center">&#128274;</span>';
  else if (t.sleeping) icon = '<span style="width:16px;text-align:center" title="sleeping, saving battery">&#128164;</span>';
  else if (t.loading && !t.frozen) icon = '<span class="spin"></span>';
  else if (t.icon || !isNewtab(t.url)) icon = `<img src="${t.icon || fav(t.url)}" onerror="this.style.visibility='hidden'">`;
  else icon = '<img src="apple-logo.png" alt="">';
  const title = masked ? 'Locked tab' : isNewtab(t.url) ? 'New Tab' : (t.title || t.url);
  t.el.innerHTML = icon + '<span class="t"></span>' + (t.locked && !masked ? '<span title="locked tab, unlocked for now" style="font-size:11px">&#128275;</span>' : '') + (t.audio ? '<span title="playing audio">&#128266;</span>' : '') + '<span class="x">&#10005;</span>';
  t.el.querySelector('.t').textContent = title;
  t.el.title = title + (t.sleeping ? ' (sleeping)' : t.frozen ? ' (frozen)' : '');
  t.el.classList.toggle('sleep', !!(t.sleeping || t.frozen));
}

// ---- session restore ----
let sessT, restoring = false;
function saveSession(now) {
  if (restoring) return;
  clearTimeout(sessT);
  const doSave = () => {
    store.session = {
      tabs: tabs.filter(t => t.url && !isNewtab(t.url)).map(t => ({ url: t.url, title: t.title, locked: !!t.locked, notes: (t.notes || []).map(n => ({ x: n.x, y: n.y, text: n.text, c: n.c })) })),
      active: Math.max(0, tabs.filter(t => t.url && !isNewtab(t.url)).indexOf(active))
    };
    save();
  };
  if (now) doSave(); else sessT = setTimeout(doSave, 800);
}
window.addEventListener('beforeunload', () => saveSession(true));
function restoreSession() {
  const s = store.session;
  if (store.settings.restore === false || !s || !s.tabs || !s.tabs.length) return false;
  restoring = true;
  s.tabs.forEach((x, i) => {
    const t = createTab(x.url, true, i !== s.active);
    if (x.title) t.title = x.title;
    if (x.locked) t.locked = true;
    if (Array.isArray(x.notes) && x.notes.length) t.notes = x.notes.map(n => ({ id: 'n' + Math.random().toString(36).slice(2), x: +n.x || 20, y: +n.y || 20, text: String(n.text || ''), c: +n.c || 0 }));
    renderTab(t);
  });
  restoring = false;
  activate(tabs[Math.min(s.active || 0, tabs.length - 1)]);
  return true;
}

// ---- battery stuff ----
let onBattery = false, battLevel = null, charging = true;
// battery is the core of Orchard: 0 = normal (still frugal), 1 = saver, 2 = ultra
function saverLevel() {
  const m = (store.settings && store.settings.saver) || 'auto';
  if (m === 'off') return 0;
  if (m === 'on') return 1;
  if (m === 'ultra') return 2;
  const unplugged = onBattery || (battLevel !== null && !charging);
  if (!unplugged) return 0;
  return battLevel !== null && battLevel <= 0.2 ? 2 : 1;
}
function saverActive() { return saverLevel() > 0; }
function emulateFor(t) {
  if (!t || !t.ready || t.wcId == null || t.frozen) return;
  const lvl = saverLevel();
  window.aura.emulate(t.wcId, { reducedMotion: lvl >= 1, dark: (lvl >= 2 && store.settings.ultraDark !== false) || !!store.settings.darkPages });
}
function freeze(t, f) {
  if (!t.wv || !t.ready || t.wcId == null || t.frozen === f) return;
  window.aura.freeze(t.wcId, f); t.frozen = f; renderTab(t); if (!f) emulateFor(t); updateSaverUI();
}
function audible(t) { try { return t.audio || (t.ready && t.wv.isCurrentlyAudible()); } catch { return false; } }
function scheduleFreeze(t) {
  clearTimeout(t.freezeT);
  if (store.settings.freeze === false) return;
  const lvl = saverLevel();
  t.freezeT = setTimeout(() => { if (!isShown(t) && !audible(t)) freeze(t, true); }, lvl >= 2 ? 1000 : lvl === 1 ? 3000 : 15000);
}
function sleepTab(t) {
  if (isShown(t) || t.sleeping || audible(t) || !t.wv) return;
  clearTimeout(t.freezeT);
  t.wv.remove(); t.wv = null; t.ready = false; t.frozen = false; t.sleeping = true; t.loading = false;
  renderTab(t); updateSaverUI();
}
function wake(t) {
  if (!t.sleeping) return;
  makeWebview(t, t.url || newtabSrc());
}
function sleepCheck() {
  const base = store.settings.sleepMins || 5, lvl = saverLevel();
  const mins = lvl >= 2 ? 1 : lvl === 1 ? Math.min(2, base) : base;
  if (!store.settings.sleepMins && store.settings.sleepMins === 0) return;
  tabs.forEach(t => { if (!isShown(t) && Date.now() - t.lastActive > mins * 60000) sleepTab(t); });
}
setInterval(sleepCheck, 20000);

let lastLvl = -1, warned20 = false, warned10 = false;
function restingCount() { return tabs.filter(t => t.sleeping || t.frozen).length; }
function updateSaverUI() {
  const lvl = saverLevel(), on = lvl > 0;
  document.body.classList.toggle('saver', on);
  document.body.classList.toggle('ultra', lvl >= 2);
  const b = $('batt');
  const pct = battLevel === null ? '' : Math.round(battLevel * 100) + '%';
  const plugged = charging && !onBattery;
  b.innerHTML = '<span class="leaf">&#127811;</span> ' + (plugged ? '&#9889;' : '') + pct + ' <b>' + (lvl >= 2 ? 'Ultra' : lvl ? 'Saver' : 'Eco') + '</b>' + (restingCount() ? ' <span class="rest">' + restingCount() + ' &#128164;</span>' : '');
  b.classList.toggle('on', on); b.classList.toggle('ultra', lvl >= 2);
  b.title = 'Battery: ' + (pct || '?') + (plugged ? ' (charging)' : '') + '\nMode: ' + ['Eco (normal, still frugal)', 'Saver', 'Ultra saver'][lvl] + '\n' + restingCount() + ' tab(s) frozen or asleep, using no power\n' + blocked + ' ads blocked\nclick for battery usage';
}
let thrStat = { supported: false, active: false, count: 0, apps: [] };
function syncThrottle() { window.aura.videoMode({ on: store.settings.cheapVideo !== false, level: saverLevel() }); window.aura.throttle({ on: store.settings.slowApps !== false, level: saverLevel(), exclude: store.settings.slowExclude || [] }); }
// cap each tab's frame rate on battery (30fps Saver, 20fps Ultra) to cut GPU/CPU work
function fpsCap() { if (store.settings.capFps === false) return 0; const lvl = saverLevel(); return lvl >= 2 ? 20 : lvl === 1 ? 30 : 0; }
function sendFps(t) { try { if (t && t.wv && t.ready) t.wv.send('orchard-fps', fpsCap()); } catch {} }
function applyFps() { const c = fpsCap(); tabs.forEach(t => { try { if (t.wv && t.ready) t.wv.send('orchard-fps', c); } catch {} }); }
window.aura.on('throttle-status', (s) => { thrStat = s || thrStat; if (panelIs('battery')) renderBattery(); });
window.aura.throttleStatus().then(s => { thrStat = s || thrStat; });
function applySaver() {
  const lvl = saverLevel();
  syncThrottle();
  applyFps();
  updateSaverUI();
  tabs.forEach(t => { if (!isShown(t) && t.ready) scheduleFreeze(t); emulateFor(t); });
  if (lvl >= 2 && lastLvl < 2 && lastLvl !== -1) { tabs.forEach(t => { if (!isShown(t)) sleepTab(t); }); toast('Ultra saver on 🥶 background tabs asleep, pages calmed down'); }
  else if (lvl === 1 && lastLvl === 0) toast('unplugged, Saver mode on 🍃');
  lastLvl = lvl;
  if (typeof placeChat === 'function') placeChat();
  if (battLevel !== null && !charging) {
    if (battLevel <= 0.1 && !warned10) { warned10 = true; toast('10% battery bro, Ultra saver is on 🪫'); }
    else if (battLevel <= 0.2 && !warned20) { warned20 = true; if (store.settings.saver === 'auto' || !store.settings.saver) toast('20% battery, switched to Ultra saver 🪫'); }
  } else { warned20 = warned10 = false; }
  sleepCheck();
}

// ---- split screen (up to 4) + tab lock aware layout ----
let split = [];
const CELLS = {
  1: [[0, 0, 1, 1]],
  2: [[0, 0, .5, 1], [.5, 0, .5, 1]],
  3: [[0, 0, .5, 1], [.5, 0, .5, .5], [.5, .5, .5, .5]],
  4: [[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]]
};
function visibleSet() { return active && split.includes(active) ? split : (active ? [active] : []); }
const isShown = (t) => visibleSet().includes(t);
function rectStyle(cell, n) {
  const [x, y, w, h] = cell, g = n > 1 ? 2 : 0;
  return { left: `calc((100% - var(--sw,0px)) * ${x} + ${x ? g : 0}px)`, top: `calc(${y * 100}% + ${y ? g : 0}px)`,
    width: `calc((100% - var(--sw,0px)) * ${w} - ${x ? g : 0}px)`, height: `calc(${h * 100}% - ${y ? g : 0}px)`, bottom: 'auto' };
}
function layoutViews() {
  const vis = visibleSet(), n = vis.length;
  tabs.forEach(t => {
    const i = vis.indexOf(t), shown = i >= 0;
    const locked = shown && t.locked && !t.unlocked && !!store.settings.lockHash;
    if (shown && t.sleeping) wake(t);
    if (shown && t.frozen) freeze(t, false);
    if (shown) clearTimeout(t.freezeT);
    const st = shown ? rectStyle(CELLS[n][i], n) : null;
    if (t.wv) {
      t.wv.classList.toggle('active', shown && !locked);
      if (st && n > 1) Object.assign(t.wv.style, st); else t.wv.removeAttribute('style');
    }
    if (locked) showLock(t, st && n > 1 ? st : null); else hideLock(t);
    t.el.classList.toggle('insplit', split.length > 1 && split.includes(t));
  });
  const ring = $('paneRing');
  if (n > 1) { Object.assign(ring.style, rectStyle(CELLS[n][vis.indexOf(active)], n)); ring.hidden = false; } else ring.hidden = true;
  renderNotes();
}
function activate(t) {
  const prevVis = visibleSet();
  if (active && active !== t) { active.el.classList.remove('active'); active.lastActive = Date.now(); }
  active = t;
  t.lastActive = Date.now();
  const vis = visibleSet();
  prevVis.forEach(p => { if (!vis.includes(p) && tabs.includes(p)) { p.lastActive = Date.now(); scheduleFreeze(p); if (p.locked) { p.unlocked = false; renderTab(p); } } });
  layoutViews();
  t.el.classList.add('active');
  renderTab(t);
  t.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  closeFind();
  updateNav();
  if (isNewtab(t.url) && !(t.locked && !t.unlocked)) setTimeout(() => $('url').focus(), 50);
  saveSession();
}
function splitWith(t) {
  if (t === active) return;
  if (!split.includes(active)) split = [active];
  if (split.includes(t)) return;
  if (split.length >= 4) { toast('split screen fits 4 tabs max bro 🫩'); return; }
  split.push(t);
  layoutViews(); updateNav(); toast('split screen on, click a side to use it');
}
function unsplit(t) {
  split = t ? split.filter(x => x !== t) : [];
  if (split.length < 2) split = [];
  if (t && t === active && split.length) activate(split[0]); else layoutViews();
}

// ---- tab lock ----
function lockReady() { return !!store.settings.lockHash; }
function showLock(t, st) {
  if (!t.lockEl) {
    const d = document.createElement('div');
    d.className = 'lockpane';
    d.innerHTML = '<div class="lockcard"><div style="font-size:40px">&#128274;</div><b>This tab is locked</b><small>enter your tab password</small><div style="display:flex;gap:6px;width:100%"><input type="password" placeholder="Password"><span class="pbtn eye" title="Show password">&#128065;</span></div><div class="lockerr"></div><span class="pbtn ok unl">Unlock</span><a class="forgot">Forgot password?</a></div>';
    const inp = d.querySelector('input'), err = d.querySelector('.lockerr');
    d.querySelector('.eye').onclick = () => { inp.type = inp.type === 'password' ? 'text' : 'password'; inp.focus(); };
    inp.addEventListener('keyup', (e) => { if (e.getModifierState && e.getModifierState('CapsLock')) err.textContent = 'caps lock is on'; else if (err.textContent === 'caps lock is on') err.textContent = ''; });
    d.querySelector('.forgot').onclick = async () => {
      const v = await modal('Forgot ur tab password?', 'This closes every locked tab and removes the password. Ur other tabs stay. Type RESET to do it.', [{ id: 'c', label: 'Type RESET' }], 'Reset');
      if (!v || v.c.trim().toUpperCase() !== 'RESET') return;
      tabs.filter(x => x.locked).forEach(x => closeTab(x, true));
      delete store.settings.lockHash; delete store.settings.lockSalt; store.settings.lockVer = (store.settings.lockVer || 0) + 1;
      save(); saveSession(true); layoutViews(); toast('password removed, locked tabs closed');
    };
    let fails = 0, wait = 0;
    const tryIt = async () => {
      if (Date.now() < wait) { err.textContent = 'too many tries, wait a sec'; return; }
      if (await checkPw(inp.value)) { lastUnlock = Date.now(); t.unlocked = true; inp.value = ''; err.textContent = ''; fails = 0; layoutViews(); renderTab(t); updateNav(); toast('unlocked 🔓'); }
      else { fails++; err.textContent = 'wrong password 💔'; inp.select(); if (fails >= 5) { wait = Date.now() + 15000; fails = 0; } }
    };
    d.querySelector('.unl').onclick = tryIt;
    inp.onkeydown = (e) => { if (e.key === 'Enter') tryIt(); };
    d.onmousedown = () => { if (t !== active) activate(t); };
    $('views').appendChild(d);
    t.lockEl = d;
  }
  t.lockEl.removeAttribute('style');
  if (st) Object.assign(t.lockEl.style, st);
  t.lockEl.hidden = false;
  if (t === active) setTimeout(() => { const i = t.lockEl && t.lockEl.querySelector('input'); if (i && !t.lockEl.hidden) i.focus(); }, 30);
}
function hideLock(t) { if (t.lockEl) t.lockEl.hidden = true; }
async function checkPw(pw) { return !!pw && lockReady() && (await window.aura.hashPw(pw, store.settings.lockSalt)) === store.settings.lockHash; }
async function setPw(pw) {
  const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
  store.settings.lockSalt = salt;
  store.settings.lockHash = await window.aura.hashPw(pw, salt);
  store.settings.lockVer = (store.settings.lockVer || 0) + 1;
  save();
}
function relockAll() {
  tabs.forEach(t => { if (t.locked && t.unlocked) { t.unlocked = false; renderTab(t); } });
  layoutViews(); updateNav();
}
async function toggleLock(t) {
  if (t.locked) {
    if (!t.unlocked && !(await askPw('Unlock this tab for good', 'Enter your tab password to remove the lock.'))) return;
    t.locked = false; t.unlocked = false; toast('lock removed');
  } else {
    if (!lockReady()) { const ok = await pwSetupModal(); if (!ok) return; }
    t.locked = true; t.unlocked = t === active || isShown(t); toast('tab locked 🔒 it locks when u leave it');
  }
  renderTab(t); layoutViews(); saveSession(true);
}
async function askPw(title, sub) {
  const v = await modal(title, sub, [{ id: 'p', label: 'Password', type: 'password' }], 'Unlock');
  if (!v) return false;
  if (await checkPw(v.p)) { lastUnlock = Date.now(); return true; }
  toast('wrong password 💔'); return false;
}
async function pwSetupModal(change) {
  const fields = (change ? [{ id: 'old', label: 'Current password', type: 'password' }] : []).concat([{ id: 'a', label: 'New password', type: 'password' }, { id: 'b', label: 'Type it again', type: 'password' }]);
  const v = await modal(change ? 'Change tab password' : 'Set a tab password', 'Locked tabs need this to open.', fields, 'Save');
  if (!v) return false;
  if (change && !(await checkPw(v.old))) { toast('current password is wrong 💔'); return false; }
  if (!v.a || v.a.length < 4) { toast('make it at least 4 characters'); return false; }
  if (v.a !== v.b) { toast('passwords dont match'); return false; }
  await setPw(v.a); toast('password saved 🔥'); return true;
}
function modal(title, sub, fields, okText) {
  return new Promise((res) => {
    const bg = document.createElement('div'); bg.className = 'modalbg';
    bg.innerHTML = `<div class="modal"><h3></h3><p></p>${fields.map(f => `<label>${esc(f.label)}<input id="mf_${f.id}" type="${f.type || 'text'}" autocomplete="off"></label>`).join('')}<div class="mrow"><span class="pbtn" data-a="no">Cancel</span><span class="pbtn ok" data-a="ok">${esc(okText)}</span></div></div>`;
    bg.querySelector('h3').textContent = title; bg.querySelector('p').textContent = sub;
    const done = (ok) => { const v = {}; fields.forEach(f => v[f.id] = bg.querySelector('#mf_' + f.id).value); bg.remove(); res(ok ? v : null); };
    bg.onclick = (e) => { if (e.target === bg || e.target.dataset.a === 'no') done(false); else if (e.target.dataset.a === 'ok') done(true); };
    bg.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
    document.body.appendChild(bg);
    fields.forEach(f => { if (f.value) bg.querySelector('#mf_' + f.id).value = f.value; });
    const first = bg.querySelector('input'); if (first) { first.focus(); first.select(); }
  });
}

// ---- hide elements (pick anything on a page and hide it for that site) ----
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
function hideRulesFor(u) { const h = hostOf(u); return h ? ((store.hideRules || {})[h] || []) : []; }
function cssFor(rules) { return rules.length ? rules.map(s => s + '{display:none!important}').join('\n') : ''; }
async function applyHides(t) {
  if (!t.wv || !t.ready) return;
  try { if (t.hideKey) await t.wv.removeInsertedCSS(t.hideKey); } catch {}
  t.hideKey = null;
  if (store.settings.hidesPaused) return;
  const css = cssFor(hideRulesFor(t.url));
  if (css) { try { t.hideKey = await t.wv.insertCSS(css); } catch {} }
}
const PICKER = `new Promise((done) => {
  if (window.__orchardPick) { done(null); return; }
  window.__orchardPick = true;
  const box = document.createElement('div'), tag = document.createElement('div'), bar = document.createElement('div');
  const Z = 2147483647;
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:' + Z + ';background:rgba(232,67,46,.25);outline:2px solid #e8432e;border-radius:3px;transition:all .05s';
  tag.style.cssText = 'position:fixed;pointer-events:none;z-index:' + Z + ';background:#1b1211;color:#ffb83d;font:12px/1.4 Consolas,monospace;padding:3px 7px;border-radius:5px;max-width:60vw;overflow:hidden;white-space:nowrap;text-overflow:ellipsis';
  bar.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:' + Z + ';background:#1b1211;color:#f6ece8;font:13px Segoe UI,system-ui,sans-serif;padding:8px 14px;border-radius:10px;border:1px solid #e8432e;box-shadow:0 8px 30px rgba(0,0,0,.5);pointer-events:none';
  bar.textContent = 'Click something to hide it  ·  ↑ bigger  ↓ smaller  ·  Esc to stop';
  document.documentElement.append(box, tag, bar);
  let cur = null, trail = [];
  const okId = (id) => id && !/\\d{3,}|[:.]/.test(id) && id.length < 40;
  const okCls = (c) => c && !/\\d{3,}|^(is-|has-|js-)|hover|active|focus|selected|open/.test(c) && c.length < 40;
  const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  function part(el) {
    if (okId(el.id)) return '#' + esc(el.id);
    let s = el.tagName.toLowerCase();
    const cls = [...el.classList].filter(okCls).slice(0, 2);
    if (cls.length) s += cls.map(c => '.' + esc(c)).join('');
    const p = el.parentElement;
    if (p) { const same = [...p.children].filter(x => x.tagName === el.tagName); if (same.length > 1 && !cls.length) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')'; }
    return s;
  }
  function selector(el) {
    let parts = [], node = el;
    for (let i = 0; node && node.nodeType === 1 && node !== document.documentElement && i < 6; i++) {
      parts.unshift(part(node));
      const s = parts.join(' > ');
      try { if (parts[0][0] === '#' || document.querySelectorAll(s).length === 1) return s; } catch {}
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function show(el) {
    cur = el; if (!el) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    tag.textContent = selector(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    tag.style.left = Math.max(4, Math.min(r.left, innerWidth - 300)) + 'px';
    tag.style.top = (r.top > 26 ? r.top - 24 : r.bottom + 4) + 'px';
  }
  const ours = (el) => el === box || el === tag || el === bar;
  const move = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); if (el && !ours(el) && el !== cur) { trail = []; show(el); } };
  const block = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const finish = (val) => { removeEventListener('mousemove', move, true); ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup', 'auxclick', 'contextmenu'].forEach(t => removeEventListener(t, block, true)); removeEventListener('click', pick, true); removeEventListener('keydown', key, true); box.remove(); tag.remove(); bar.remove(); window.__orchardPick = false; done(val); };
  const pick = (e) => { block(e); if (cur && cur !== document.body && cur !== document.documentElement) { const s = selector(cur); cur.style.setProperty('display', 'none', 'important'); finish(s); } };
  const key = (e) => {
    if (e.key === 'Escape') { block(e); finish(null); }
    else if (e.key === 'ArrowUp' && cur && cur.parentElement && cur.parentElement !== document.documentElement) { block(e); trail.push(cur); show(cur.parentElement); }
    else if (e.key === 'ArrowDown' && trail.length) { block(e); show(trail.pop()); }
    else if (e.key === 'Enter' && cur) { pick(e); }
  };
  addEventListener('mousemove', move, true);
  ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'contextmenu'].forEach(t => addEventListener(t, block, true));
  addEventListener('click', pick, true);
  addEventListener('keydown', key, true);
})`;
let picking = false;
async function startHidePicker() {
  const t = active;
  if (!t || !t.wv || !t.ready || isNewtab(t.url) || !/^https?:/.test(t.url)) { toast('open a website first, then pick stuff to hide 🫩'); return; }
  if (t.locked && !t.unlocked && lockReady()) { toast('unlock the tab first 🔒'); return; }
  if (picking) return;
  picking = true; $('hideBtn').classList.add('on');
  $('panel').classList.remove('show');
  t.wv.focus();
  let n = 0;
  try {
    // keep picking until Esc, one element per click
    while (true) {
      const sel = await t.wv.executeJavaScript(PICKER, true);
      if (!sel) break;
      const h = hostOf(t.url);
      store.hideRules = store.hideRules || {};
      const list = store.hideRules[h] = store.hideRules[h] || [];
      if (!list.includes(sel)) list.push(sel);
      save(); n++;
      await applyHides(t);
    }
  } catch {}
  picking = false; $('hideBtn').classList.remove('on');
  if (n) toast('hid ' + n + ' thing' + (n > 1 ? 's' : '') + ' on ' + hostOf(t.url) + ' 🔥 manage them with the eye button');
}
function renderHides() {
  const list = $('plist'), t = active, h = t ? hostOf(t.url) : '';
  $('ptitle').textContent = 'Hidden elements';
  const rules = hideRulesFor(t && t.url);
  const all = Object.entries(store.hideRules || {}).filter(([, v]) => v.length);
  list.innerHTML = `<div class="set" style="display:block;font-size:12px;color:var(--dim);line-height:1.6">Pick anything on a website (ads, popups, sidebars, comments) and Orchard hides it every time u visit that site.</div>
    <div class="set"><span class="pbtn ok" id="hidePick">&#128065; Pick elements to hide</span><span class="pbtn" id="hidePause">${store.settings.hidesPaused ? 'Hiding paused' : 'Hiding on'}</span></div>
    <div class="mhead">${h ? 'ON ' + esc(h.toUpperCase()) : 'THIS PAGE'}</div>`;
  if (!rules.length) list.insertAdjacentHTML('beforeend', '<div class="set" style="color:var(--dim);font-size:12px">nothing hidden on this site yet</div>');
  rules.forEach((s, i) => {
    const r = document.createElement('div'); r.className = 'row';
    r.innerHTML = '<div class="rt"><div style="font:12px Consolas,monospace"></div></div><span class="pbtn mini">Show again</span>';
    r.querySelector('.rt div').textContent = s;
    r.querySelector('.pbtn').onclick = async () => { rules.splice(i, 1); save(); tabs.filter(x => hostOf(x.url) === h).forEach(x => { applyHides(x); if (x.wv && x.ready) x.wv.reload(); }); renderHides(); };
    list.appendChild(r);
  });
  if (rules.length) {
    const c = document.createElement('div'); c.className = 'set';
    c.innerHTML = '<span style="color:var(--dim);font-size:12px">' + rules.length + ' hidden here</span><span class="pbtn" id="hideClr">Show everything on this site</span>';
    list.appendChild(c);
  }
  const others = all.filter(([k]) => k !== h);
  if (others.length) {
    list.insertAdjacentHTML('beforeend', '<div class="mhead">OTHER SITES</div>');
    others.forEach(([k, v]) => {
      const r = document.createElement('div'); r.className = 'row';
      r.innerHTML = `<img src="${fav('https://' + k)}" width=16 height=16 onerror="this.style.visibility='hidden'"><div class="rt"><div></div><small>${v.length} hidden</small></div><span class="pbtn mini">Clear</span>`;
      r.querySelector('.rt div').textContent = k;
      r.querySelector('.pbtn').onclick = () => { delete store.hideRules[k]; save(); renderHides(); };
      list.appendChild(r);
    });
  }
  $('hidePick').onclick = startHidePicker;
  $('hidePause').onclick = () => { store.settings.hidesPaused = !store.settings.hidesPaused; save(); tabs.forEach(applyHides); if (store.settings.hidesPaused) tabs.forEach(x => { if (x.wv && x.ready && hideRulesFor(x.url).length) x.wv.reload(); }); renderHides(); };
  if ($('hideClr')) $('hideClr').onclick = () => { delete store.hideRules[h]; save(); tabs.filter(x => hostOf(x.url) === h).forEach(x => { applyHides(x); if (x.wv && x.ready) x.wv.reload(); }); renderHides(); };
}

// ---- Orchard Chat: one persistent webview + notifications bottom right ----
let chatWv = null, chatWcId = null, chatUnread = 0;
function ensureChat() {
  if (chatWv) return;
  chatWv = document.createElement('webview');
  if (store.partition) chatWv.setAttribute('partition', store.partition);
  chatWv.setAttribute('allowpopups', '');
  chatWv.setAttribute('src', AIS.chat);
  chatWv.addEventListener('dom-ready', () => { try { chatWcId = chatWv.getWebContentsId(); } catch {} });
  $('chatHold').appendChild(chatWv);
}
function placeChat() {
  const hold = $('chatHold'), on = aiOpen && aiWhich === 'chat';
  hold.classList.toggle('show', on);
  if (on) { const r = $('sbody').getBoundingClientRect(); Object.assign(hold.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); setTimeout(() => chatWv && chatWv.focus(), 80); }
  else Object.assign(hold.style, { left: '-20px', top: '-20px', width: '2px', height: '2px' });
  if (chatWcId != null) window.aura.freeze(chatWcId, !on && (store.settings.chatNotify === false || saverLevel() >= 2));
}
try { new ResizeObserver(() => { if (aiOpen && aiWhich === 'chat') placeChat(); }).observe($('sbody')); } catch {}
window.addEventListener('resize', () => placeChat());
const NOTE_COLORS = ['#d8392a', '#e8862a', '#6cab3c', '#c0447a', '#d9a521', '#8a5a3c'];
function showNote(n) {
  const box = $('notes');
  while (box.children.length >= 4) box.lastElementChild.remove();
  const d = document.createElement('div'); d.className = 'note';
  let hsh = 0; for (const ch of String(n.chat)) hsh = (hsh * 31 + ch.charCodeAt(0)) | 0;
  d.innerHTML = '<div class="nav"></div><div class="nb"><div class="nt"><span class="ntt"></span><small>now</small></div><div class="nm"></div></div><span class="nx" title="Dismiss">&#10005;</span>';
  const av = d.querySelector('.nav'); av.style.background = NOTE_COLORS[Math.abs(hsh) % NOTE_COLORS.length]; av.textContent = (n.group ? n.title : n.from || n.title || '?').trim().charAt(0).toUpperCase() || '?';
  d.querySelector('.ntt').textContent = n.title || 'Orchard Chat';
  d.querySelector('.nm').textContent = (n.group ? (n.from || 'Someone') + ': ' : '') + (n.text || 'sent a message');
  const kill = () => { d.style.transition = 'opacity .2s'; d.style.opacity = 0; setTimeout(() => d.remove(), 200); };
  d.onclick = (e) => { kill(); if (!e.target.classList.contains('nx')) openChatTo(n.chat); };
  box.prepend(d);
  setTimeout(kill, 8000);
}
function openChatTo(id) {
  if (!(aiOpen && aiWhich === 'chat')) openChat();
  if (id) setTimeout(() => window.aura.chatOpen(id), 250);
}
function chatBadge(n) { chatUnread = n; const b = $('chatBadge'); b.hidden = !n; b.textContent = n > 99 ? '99+' : n; }
window.aura.on('chat-event', (ev) => {
  if (!ev || typeof ev !== 'object') return;
  if (ev.t === 'unread') chatBadge(Math.max(0, +ev.n || 0));
  if (ev.t === 'notify') {
    if (store.settings.chatNotify === false) return;
    const looking = aiOpen && aiWhich === 'chat' && ev.open && document.hasFocus();
    if (looking) return;
    if (document.hasFocus()) showNote(ev); else window.aura.nativeNote(ev);
  }
});
window.aura.on('chat-open', (id) => openChatTo(id));
// Orchard Chat background notifier only runs once the user actually opens Orchard Chat

// ---- Orchard Mail (Gmail via Google's official sign-in in Chrome) ----
const M = window.aura.mail;
let mailView = 'list', mailQ = 'in:inbox', mailMsgs = [], mailNext = null, mailCur = null, mailCfg = null, mailBusy = false;
const ext = (u) => window.aura.openExternal(u);
const nameFrom = (f) => { const m = String(f).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/); return m ? (m[1].trim() || m[2]) : f; };
const addrFrom = (f) => { const m = String(f).match(/<([^>]+)>/); return m ? m[1] : String(f).trim(); };
const mdate = (ts) => { const d = new Date(ts), n = new Date(); return d.toDateString() === n.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.getFullYear() === n.getFullYear() ? d.toLocaleDateString([], { day: 'numeric', month: 'short' }) : d.toLocaleDateString(); };
async function mailShow() {
  mailCfg = await M.config();
  if (!mailCfg.signedIn) return mailSetup();
  if (mailView === 'read' && mailCur) return mailRead(mailCur.id);
  if (mailView === 'compose') return;
  mailList();
}
function mailSetup(err) {
  const p = $('mailPane'), c = mailCfg || {};
  p.innerHTML = `<div class="mtop"><b style="flex:1">&#9993; Orchard Mail</b><span class="pbtn" id="mX">&#10005;</span></div>
  <div class="msetup">
    <h3>Ur Gmail, inside Orchard</h3>
    <p>Google won't let u log in on Orchard's pages, but it does allow apps to sign in through ur normal browser. So u sign in once in <b>Chrome</b>, then ur inbox shows up right here.</p>
    ${c.clientId && c.hasSecret ? '' : `<p><b>One time setup (about 10 min, do it in Chrome):</b></p>
    <ol>
      <li><a data-u="https://console.cloud.google.com/projectcreate">Make a Google Cloud project</a>, name it Orchard, click Create.</li>
      <li><a data-u="https://console.cloud.google.com/apis/library/gmail.googleapis.com">Turn on the Gmail API</a> (click Enable).</li>
      <li><a data-u="https://console.cloud.google.com/auth/branding">Set up the sign in screen</a>: app name Orchard, ur email, audience <b>External</b>, finish.</li>
      <li>On <a data-u="https://console.cloud.google.com/auth/audience">Audience</a>, add ur own Gmail under <b>Test users</b>.</li>
      <li><a data-u="https://console.cloud.google.com/auth/clients/create">Create a client</a>: type <b>Desktop app</b>, name Orchard, Create.</li>
      <li>Copy the <b>Client ID</b> and <b>Client secret</b> into the boxes below.</li>
    </ol>`}
    <label style="font-size:12px;color:var(--dim)">Client ID<input id="mCid" value="${esc(c.clientId || '')}" placeholder="something.apps.googleusercontent.com"></label>
    <label style="font-size:12px;color:var(--dim)">Client secret<input id="mSec" type="password" placeholder="${c.hasSecret ? 'saved (paste to change)' : 'GOCSPX-...'}"></label>
    ${err ? `<p style="color:#ff6b6b">${esc(err)}</p>` : ''}
    <span class="pbtn ok" id="mGo" style="align-self:flex-start;padding:9px 16px">Sign in with Google (opens Chrome)</span>
    <p>When Chrome opens, pick ur personal Gmail. If Google says "<b>Google hasn't verified this app</b>", that's normal for ur own project: click <b>Continue</b>. Ur emails go straight between Orchard and Google, nobody else sees them.</p>
  </div>`;
  p.querySelectorAll('a[data-u]').forEach(a => a.onclick = () => ext(a.dataset.u));
  $('mX').onclick = () => toggleAi(false);
  $('mGo').onclick = async () => {
    const cid = $('mCid').value.trim(), sec = $('mSec').value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(cid)) return mailSetup('that Client ID doesnt look right, it ends with .apps.googleusercontent.com');
    if (!sec && !c.hasSecret) return mailSetup('paste the Client secret too');
    await M.setConfig(cid, sec);
    $('mGo').textContent = 'Waiting for u to sign in in Chrome…';
    const r = await M.signIn();
    if (r.ok) { toast('signed in as ' + r.email + ' 🔥'); mailView = 'list'; mailShow(); mailPoll(); }
    else { mailCfg = await M.config(); mailSetup(r.error); }
  };
}
async function mailList(append) {
  const p = $('mailPane');
  if (!append) {
    p.innerHTML = `<div class="mtop"><input id="mSearch" placeholder="Search mail" value="${mailQ === 'in:inbox' ? '' : esc(mailQ)}"><span class="pbtn" id="mRef" title="Refresh">&#8635;</span><span class="pbtn ok" id="mNew" title="New email">&#9998; Write</span><span class="pbtn" id="mMenu" title="Account">&#8942;</span></div><div class="mlist" id="mList"><div class="empty" style="padding:20px;text-align:center;color:var(--dim)">Loading ur inbox…</div></div>`;
    $('mSearch').onkeydown = (e) => { if (e.key === 'Enter') { mailQ = e.target.value.trim() || 'in:inbox'; mailList(); } };
    $('mRef').onclick = () => mailList();
    $('mNew').onclick = () => mailCompose();
    $('mMenu').onclick = (e) => showMenu(e, [
      [esc(mailCfg.email || 'signed in'), () => {}, true],
      null,
      ['Inbox', () => { mailQ = 'in:inbox'; mailList(); }],
      ['Unread', () => { mailQ = 'is:unread in:inbox'; mailList(); }],
      ['Starred', () => { mailQ = 'is:starred'; mailList(); }],
      ['Sent', () => { mailQ = 'in:sent'; mailList(); }],
      null,
      ['Open Gmail in Chrome', () => ext('https://mail.google.com/')],
      ['Sign out', async () => { await M.signOut(); mailBadge(0); toast('signed out of Orchard Mail'); mailShow(); }]
    ]);
  }
  if (mailBusy) return; mailBusy = true;
  const r = await M.list(mailQ, append ? mailNext : null);
  mailBusy = false;
  const box = $('mList'); if (!box) return;
  if (r.error) { if (r.signedOut) return mailShow(); box.innerHTML = `<div style="padding:20px;color:#ff6b6b;font-size:13px">${esc(r.error)}</div>`; return; }
  mailMsgs = append ? mailMsgs.concat(r.messages) : r.messages; mailNext = r.next;
  if (!mailMsgs.length) { box.innerHTML = '<div style="padding:24px;text-align:center;color:var(--dim)">nothing here 🍃</div>'; return; }
  box.innerHTML = '';
  mailMsgs.forEach(m => {
    const d = document.createElement('div'); d.className = 'mrow' + (m.unread ? ' unread' : '');
    d.innerHTML = '<div class="l1"><span class="fr"></span><span class="dt"></span></div><div class="sj"></div><div class="sn"></div>';
    d.querySelector('.fr').textContent = (m.starred ? '★ ' : '') + nameFrom(m.from);
    d.querySelector('.dt').textContent = mdate(m.date);
    d.querySelector('.sj').textContent = m.subject || '(no subject)';
    d.querySelector('.sn').textContent = m.snippet.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    d.onclick = () => mailRead(m.id);
    box.appendChild(d);
  });
  if (mailNext) { const mo = document.createElement('div'); mo.className = 'mmore'; mo.innerHTML = '<span class="pbtn">Load more</span>'; mo.firstChild.onclick = () => mailList(true); box.appendChild(mo); }
}
async function mailRead(id) {
  mailView = 'read';
  const p = $('mailPane');
  p.innerHTML = `<div class="mtop"><span class="pbtn" id="mBack">&#8592; Back</span><span style="flex:1"></span><span class="pbtn" id="mReply" title="Reply">&#8617; Reply</span><span class="pbtn" id="mArch" title="Archive">&#128229;</span><span class="pbtn" id="mTrash" title="Delete">&#128465;</span><span class="pbtn" id="mMore">&#8942;</span></div><div class="mread" id="mRead"><div style="padding:20px;color:var(--dim)">Opening…</div></div>`;
  $('mBack').onclick = () => { mailView = 'list'; mailCur = null; mailList(); };
  const m = await M.get(id);
  if (m.error) { if (m.signedOut) return mailShow(); $('mRead').innerHTML = `<div style="padding:20px;color:#ff6b6b">${esc(m.error)}</div>`; return; }
  mailCur = m;
  const box = $('mRead'); box.innerHTML = '<div class="mhd"><h3></h3><small class="a"></small><small class="b"></small></div>';
  box.querySelector('h3').textContent = m.subject || '(no subject)';
  box.querySelector('.a').textContent = 'From: ' + m.from;
  box.querySelector('.b').textContent = 'To: ' + m.to + ' · ' + new Date(m.date).toLocaleString();
  if (m.html) {
    const f = document.createElement('iframe'); f.className = 'mbody';
    f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    f.srcdoc = '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'"><base target="_blank"><style>body{font-family:Segoe UI,sans-serif;margin:12px;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>' + m.html;
    box.appendChild(f);
  } else {
    const t = document.createElement('div'); t.className = 'mtext';
    const re = /https?:\/\/[^\s<>"]+/g; let i = 0, x; const s = m.text;
    while ((x = re.exec(s))) { t.append(document.createTextNode(s.slice(i, x.index))); const a = document.createElement('a'); a.textContent = x[0]; a.href = '#'; const u = x[0]; a.onclick = (e) => { e.preventDefault(); createTab(u); }; t.append(a); i = x.index + x[0].length; }
    t.append(document.createTextNode(s.slice(i)));
    box.appendChild(t);
  }
  if (m.unread) { M.modify(id, 'read').then(() => mailPoll()); const li = mailMsgs.find(x => x.id === id); if (li) li.unread = false; }
  const act = async (a, msg) => { const r = await M.modify(id, a); if (r.error) toast(r.error); else { toast(msg); mailMsgs = mailMsgs.filter(x => x.id !== id); mailView = 'list'; mailCur = null; mailList(); mailPoll(); } };
  $('mArch').onclick = () => act('archive', 'archived');
  $('mTrash').onclick = () => act('trash', 'moved to trash');
  $('mReply').onclick = () => mailCompose({ to: addrFrom(m.from), subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject, threadId: m.threadId, inReplyTo: m.messageId, quote: m });
  $('mMore').onclick = (e) => showMenu(e, [
    ['Mark unread', async () => { await M.modify(id, 'unread'); mailView = 'list'; mailList(); mailPoll(); }],
    ['Star', async () => { await M.modify(id, 'star'); toast('starred ★'); }],
    ['Forward', () => mailCompose({ subject: 'Fwd: ' + m.subject, body: '\n\n---------- Forwarded message ----------\nFrom: ' + m.from + '\nSubject: ' + m.subject + '\n\n' + (m.text || '') })],
    ['Open in Chrome', () => ext('https://mail.google.com/mail/u/0/#all/' + m.threadId)]
  ]);
}
function mailCompose(d = {}) {
  mailView = 'compose';
  const p = $('mailPane');
  p.innerHTML = `<div class="mtop"><span class="pbtn" id="mCancel">&#8592; Cancel</span><b style="flex:1;text-align:center">${d.threadId ? 'Reply' : 'New email'}</b><span class="pbtn ok" id="mSend">Send</span></div>
  <div class="mform"><input id="mTo" placeholder="To (email)"><input id="mSubj" placeholder="Subject"><textarea id="mBody" placeholder="Write ur email…"></textarea></div>`;
  $('mTo').value = d.to || ''; $('mSubj').value = d.subject || '';
  let body = d.body || '';
  if (d.quote) body = '\n\nOn ' + new Date(d.quote.date).toLocaleString() + ', ' + d.quote.from + ' wrote:\n' + (d.quote.text || '').split('\n').map(l => '> ' + l).join('\n');
  $('mBody').value = body;
  (d.to ? $('mBody') : $('mTo')).focus(); if (d.to) $('mBody').setSelectionRange(0, 0);
  $('mCancel').onclick = () => { mailView = d.threadId && mailCur ? 'read' : 'list'; mailShow(); };
  $('mSend').onclick = async () => {
    $('mSend').textContent = 'Sending…';
    const r = await M.send({ to: $('mTo').value, subject: $('mSubj').value, body: $('mBody').value, threadId: d.threadId, inReplyTo: d.inReplyTo });
    if (r.error) { $('mSend').textContent = 'Send'; toast(r.error); return; }
    toast('sent ✉️'); mailView = 'list'; mailCur = null; mailList();
  };
}
function mailBadge(n) { const b = $('mailBadge'); b.hidden = !n; b.textContent = n > 99 ? '99+' : n; $('mailBtn').title = 'Orchard Mail' + (n ? ' · ' + n + ' unread' : '') + ' (Alt+M)'; }
async function mailPoll() { try { const r = await M.unread(); mailBadge(r.count || 0); } catch {} }
setTimeout(mailPoll, 4000);
setInterval(() => { if (saverLevel() < 2) mailPoll(); }, 5 * 60 * 1000);


// ---- toolbar: choose what shows (Settings > Toolbar) ----
const TOOLBAR = [
  ['batt', '&#127811;', 'Battery', 'mode, % and resting tabs'],
  ['shield', '&#128737;', 'Ad blocker counter', 'how many ads got blocked'],
  ['speedBtn', '&#128246;', 'WiFi speed test', ''],
  ['dlBtn', '&#11015;', 'Downloads', ''],
  ['histBtn', '&#128339;', 'History', ''],
  ['calBtn', '&#128197;', 'Calendar', ''],
  ['calcBtn', '&#129518;', 'Calculator', ''],
  ['extBtn', '&#129513;', 'Extensions', ''],
  ['setBtn', '&#9881;', 'Settings', 'u can still open it from the ☰ menu'],
  ['mailBtn', '&#9993;', 'Orchard Mail', ''],
  ['chatBtn', '&#128172;', 'Orchard Chat', ''],
  ['aiBtn', '&#10022;', 'Ask AI', ''],
  ['avatar', '&#128100;', 'Profile picture', ''],
  ['hideBtn', '&#128065;', 'Hide elements (address bar)', ''],
  ['lensBtn', '&#128269;', 'Google Lens (address bar)', ''],
  ['star', '&#11088;', 'Bookmark star (address bar)', '']
];
function applyToolbar() {
  const tb = store.settings.toolbar || {};
  TOOLBAR.forEach(([id]) => { const el = $(id); if (el) el.hidden = tb[id] === false; });
  // tidy separators so hidden groups don't leave double lines
  const kids = [...$('nav').children];
  kids.forEach((el, i) => {
    if (!el.classList.contains('sep')) return;
    let before = false, after = false;
    for (let j = i - 1; j >= 0 && !kids[j].classList.contains('sep'); j--) if (!kids[j].hidden && kids[j].id !== 'urlwrap') before = true;
    if (kids[i - 1] && kids[i - 1].id === 'urlwrap') before = true;
    for (let j = i + 1; j < kids.length && !kids[j].classList.contains('sep'); j++) if (!kids[j].hidden && kids[j].id !== 'menuBtn' && kids[j].id !== 'updPill') after = true;
    el.hidden = !(before && after);
  });
}

// ---- full page overlays (settings, extensions) ----
let pageKind = null;
function openPage(kind, icon, title, navItems, render) {
  $('panel').classList.remove('show');
  pageKind = kind;
  $('opicon').innerHTML = icon; $('optitle').textContent = title;
  const nav = $('opnav'); nav.innerHTML = '';
  navItems.forEach(([key, ic, label]) => {
    const a = document.createElement('a'); a.dataset.k = key; a.innerHTML = `<span>${ic}</span><span></span>`; a.lastChild.textContent = label;
    a.onclick = () => render(key);
    nav.appendChild(a);
  });
  $('opage').hidden = false;
  render(navItems[0][0]);
}
function markNav(key) { document.querySelectorAll('#opnav a').forEach(a => a.classList.toggle('on', a.dataset.k === key)); }
function closePage() { $('opage').hidden = true; pageKind = null; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('opage').hidden && !document.querySelector('.modalbg')) closePage(); });
const swHtml = (on, id) => `<span class="sw${on ? ' on' : ''}" id="${id}" role="switch" aria-checked="${on}"></span>`;
function row(icon, label, sub, control) { return `<div class="oprow"><span class="oi2">${icon}</span><div class="ol">${label}${sub ? `<small>${sub}</small>` : ''}</div>${control}</div>`; }
function bindSwitch(id, get, set) { const el = $(id); if (!el) return; el.onclick = () => { const v = !get(); set(v); el.classList.toggle('on', v); el.setAttribute('aria-checked', v); }; }

function openSettings() { openPanel('settings'); }
// simple scrolling settings panel (the familiar dropdown, not a whole page)
function renderSettings() {
  $('ptitle').innerHTML = '&#9881; Settings';
  const list = $('plist'), S = store.settings;
  const hd = (t) => `<div class="mhead">${t}</div>`;
  const sw = (on, id) => `<span class="sw${on ? ' on' : ''}" id="${id}"></span>`;
  const sel = (id, opts) => `<select id="${id}">${opts}</select>`;
  list.innerHTML =
    hd('SEARCH')
    + `<div class="set">Search engine ${sel('eng', Object.keys(ENGINES).map(k => `<option value="${k}" ${S.engine === k ? 'selected' : ''}>${k}</option>`).join(''))}</div>`
    + `<div class="set">Search suggestions ${sw(S.suggest !== false, 'sgT')}</div>`
    + hd('BATTERY')
    + `<div class="set">Battery saver ${sel('svr', SAVER_OPTS)}</div>`
    + `<div class="set">Sleep unused tabs after ${sel('slp', [[2, '2 min'], [5, '5 min'], [10, '10 min'], [30, '30 min'], [0, 'never']].map(([v, l]) => `<option value="${v}" ${(S.sleepMins ?? 5) == v ? 'selected' : ''}>${l}</option>`).join(''))}</div>`
    + `<div class="set">Freeze background tabs ${sw(S.freeze !== false, 'frz')}</div>`
    + (thrStat.supported ? `<div class="set">Slow down other apps on battery ${sw(S.slowApps !== false, 'slowT2')}</div>` : '')
    + `<div class="set">Cheaper videos on battery ${sw(S.cheapVideo !== false, 'cvT2')}</div>`
    + `<div class="set">Dark pages always ${sw(!!S.darkPages, 'dkp2')}</div>`
    + `<div class="set">See what's using battery <span class="pbtn" id="battOpen">Open</span></div>`
    + hd('TABS')
    + `<div class="set">Reopen tabs on startup ${sw(S.restore !== false, 'rst')}</div>`
    + `<div class="set">Rest all other tabs now <span class="pbtn" id="slpNow">Rest</span></div>`
    + hd('AI, CHAT & MAIL')
    + `<div class="set">AI side panel ${sel('aiDef', [['gemini', 'Gemini'], ['chatgpt', 'ChatGPT'], ['claude', 'Claude']].map(([k, l]) => `<option value="${k}" ${(S.ai || 'gemini') === k ? 'selected' : ''}>${l}</option>`).join(''))}</div>`
    + `<div class="set">Orchard Chat notifications ${sw(S.chatNotify !== false, 'cnT')}</div>`
    + `<div class="set">Orchard Mail <span class="pbtn" id="mailOpen">Open</span></div>`
    + hd('TAB LOCK')
    + `<div class="set">Tab lock password <span style="display:flex;gap:6px">${S.lockHash ? '<span class="pbtn" id="pwChg">Change</span><span class="pbtn" id="pwRst">Reset</span>' : '<span class="pbtn" id="pwSet">Set</span>'}</span></div>`
    + `<div class="set" style="color:var(--dim);font-size:12px;display:block;line-height:1.5">Right click a tab and pick Lock tab. It locks again when u switch tabs or leave Orchard.</div>`
    + hd('PASSWORDS')
    + `<div class="set">Offer to save passwords ${sw(S.savePasswords !== false, 'spw')}</div>`
    + `<div class="set">Saved passwords <span class="pbtn" id="pwMng">Manage</span></div>`
    + hd('DOWNLOADS')
    + `<div class="set">Ask where to save each file ${sw(!!S.askDownload, 'askDl')}</div>`
    + `<div class="set" style="color:var(--dim);font-size:12px;display:block;line-height:1.5">Off: files go straight into ur Downloads folder, like Chrome.</div>`
    + hd('LOOKS')
    + `<div class="set">New tab background <span class="pbtn" id="thm">Change</span></div>`
    + hd('PRIVACY')
    + `<div class="set">Ad blocker ${sw(!!S.adblock, 'adT')}</div>`
    + `<div class="set">Hidden elements <span class="pbtn" id="hidesOpen">Manage</span></div>`
    + `<div class="set">Clear history, cookies, cache <span class="pbtn" id="clr">Clear</span></div>`
    + hd('TOOLBAR BUTTONS')
    + `<div class="set" style="color:var(--dim);font-size:12px;display:block;line-height:1.5">Turn the top buttons on or off. The ☰ menu always stays.</div>`
    + TOOLBAR.map(([id, ic, label]) => `<div class="set"><span style="display:flex;gap:8px;align-items:center"><span style="width:18px;text-align:center">${ic}</span>${label}</span>${sw((S.toolbar || {})[id] !== false, 'tb_' + id)}</div>`).join('')
    + `<div class="set"><span></span><span class="pbtn" id="tbReset">Show everything</span></div>`
    + hd('ABOUT & UPDATES')
    + `<div class="set">Orchard <b id="verTxt">v…</b></div>`
    + `<div class="set">Updates <span class="pbtn" id="updChk">Check for updates</span></div>`
    + `<div class="set" style="color:var(--dim);font-size:11px;line-height:1.7;display:block">Shortcuts: Ctrl+T new tab · Ctrl+W close · Ctrl+Shift+T reopen · Ctrl+L address bar · Ctrl+Tab next tab · Ctrl+D bookmark · Ctrl+H history · Ctrl+J downloads · Ctrl+F find · Ctrl+N new window · Alt+G AI · Alt+C chat · Alt+M mail · Alt+K calculator · Alt+E calendar · Alt+H hide elements · Alt+F menu · F11 fullscreen · F12 devtools</div>`;
  const toggle = (id, get, set2) => { const el = $(id); if (el) el.onclick = () => { const v = !get(); set2(v); el.classList.toggle('on', v); }; };
  $('eng').onchange = (e) => { store.settings.engine = e.target.value; save(); };
  toggle('sgT', () => store.settings.suggest !== false, (v) => { store.settings.suggest = v; save(); });
  $('svr').onchange = (e) => { store.settings.saver = e.target.value; save(); applySaver(); };
  $('slp').onchange = (e) => { store.settings.sleepMins = +e.target.value; save(); sleepCheck(); };
  toggle('frz', () => store.settings.freeze !== false, (v) => { store.settings.freeze = v; save(); if (!v) tabs.forEach(t => freeze(t, false)); else applySaver(); });
  toggle('dkp2', () => !!store.settings.darkPages, (v) => { store.settings.darkPages = v; save(); applySaver(); });
  toggle('spw', () => store.settings.savePasswords !== false, (v) => { store.settings.savePasswords = v; save(); });
  if ($('pwMng')) $('pwMng').onclick = () => openPanel('passwords');
  toggle('askDl', () => !!store.settings.askDownload, (v) => { store.settings.askDownload = v; save(); });
  toggle('cvT2', () => store.settings.cheapVideo !== false, (v) => { store.settings.cheapVideo = v; save(); syncThrottle(); });
  toggle('slowT2', () => store.settings.slowApps !== false, (v) => { store.settings.slowApps = v; save(); syncThrottle(); });
  $('battOpen').onclick = () => openPanel('battery');
  toggle('rst', () => store.settings.restore !== false, (v) => { store.settings.restore = v; save(); });
  $('slpNow').onclick = () => { let n = 0; tabs.forEach(t => { if (!isShown(t) && !t.sleeping) { sleepTab(t); if (t.sleeping) n++; } }); toast(n + ' tab(s) resting 💤'); };
  $('aiDef').onchange = (e) => { store.settings.ai = e.target.value; save(); if (aiOpen && !['chat', 'mail', 'gchat'].includes(aiWhich)) { aiWcId = null; loadAi(e.target.value); } };
  toggle('cnT', () => store.settings.chatNotify !== false, (v) => { store.settings.chatNotify = v; save(); if (v) ensureChat(); placeChat(); });
  $('mailOpen').onclick = () => openMail();
  $('thm').onclick = () => openPanel('theme');
  if ($('pwSet')) $('pwSet').onclick = async () => { if (await pwSetupModal()) renderSettings(); };
  if ($('pwChg')) $('pwChg').onclick = async () => { if (await pwSetupModal(true)) renderSettings(); };
  if ($('pwRst')) $('pwRst').onclick = async () => {
    const v = await modal('Reset tab password', 'Know it? Type it to remove it. Forgot it? Type FORGOT and every locked tab gets closed, then the password is removed.', [{ id: 'p', label: 'Password or FORGOT', type: 'password' }], 'Reset');
    if (!v) return;
    if (v.p === 'FORGOT') tabs.filter(t => t.locked).forEach(t => closeTab(t, true));
    else if (!(await checkPw(v.p))) { toast('wrong password 💔'); return; }
    else tabs.forEach(t => { t.locked = false; t.unlocked = false; renderTab(t); });
    delete store.settings.lockHash; delete store.settings.lockSalt; store.settings.lockVer = (store.settings.lockVer || 0) + 1;
    save(); saveSession(true); layoutViews(); toast('password reset'); renderSettings();
  };
  toggle('adT', () => !!store.settings.adblock, () => { toggleAdblock(); });
  $('hidesOpen').onclick = () => openPanel('hides');
  let armed = false;
  $('clr').onclick = async () => { if (!armed) { armed = true; $('clr').textContent = 'Click again'; return; } await window.aura.clearData(); store.history = []; toast('everything wiped 🥶'); $('clr').textContent = 'Cleared'; };
  TOOLBAR.forEach(([id]) => toggle('tb_' + id, () => (store.settings.toolbar || {})[id] !== false, (v) => { store.settings.toolbar = { ...(store.settings.toolbar || {}), [id]: v }; save(); applyToolbar(); }));
  $('tbReset').onclick = () => { store.settings.toolbar = {}; save(); applyToolbar(); renderSettings(); };
  window.aura.appVersion().then(v => { if ($('verTxt')) $('verTxt').textContent = 'v' + v.version + (v.pending ? ' · update ' + v.pending.version + ' ready' : ''); });
  $('updChk').onclick = async () => {
    $('updChk').textContent = 'Checking…';
    const res = await window.aura.checkUpdate();
    const msg = { latest: 'ur on the newest version 🔥', ready: 'update ' + res.version + ' ready, restart to get it', busy: 'already checking', full: 'v' + res.version + ' needs a fresh download of the full zip', error: 'couldnt check: ' + res.error };
    $('updChk').textContent = 'Check for updates';
    toast(msg[res.status] || 'hmm');
    if (res.status === 'ready') showUpdate(res);
  };
}

// ---- extensions (games + learning apps from the Orchard repo, run in tabs) ----
const EXT = window.aura.ext;
let extFilter = 'all', extCatalogCache = null;
async function extMenu(e) {
  const list = await EXT.list();
  showMenu(e, list.map(x => [`${esc(x.icon || '&#129513;')} ${esc(x.name)}`, () => extPlay(x.id)]).concat(list.length ? [null] : [], [
    ['&#129513; ' + (list.length ? 'Manage extensions' : 'Get extensions'), () => openExtensions()]
  ]));
}
async function extPlay(id) {
  const it = (await EXT.list()).find(x => x.id === id);
  if (it && it.inject) {
    if (!active || !active.wv || !active.ready || isNewtab(active.url) || !/^https?:|^file:/.test(active.url)) { toast('open a website first, then run it 🫩'); return; }
    const code = await EXT.code(id);
    if (!code) { toast("couldn't load the extension"); return; }
    try { await active.wv.executeJavaScript(code, true); } catch (e) { toast('that page blocked it'); }
    return;
  }
  const u = await EXT.url(id); if (u) createTab(u);
}
function openExtensions() {
  openPage('extensions', '&#129513;', 'Orchard Extensions', [
    ['all', '&#10024;', 'Discover'], ['game', '&#127918;', 'Games'], ['educational', '&#128218;', 'Educational'], ['installed', '&#9989;', 'Installed']
  ], renderExtensions);
}
async function renderExtensions(f) {
  extFilter = f; markNav(f);
  const m = $('opmain');
  const head = { all: ['Discover', 'Games and learning apps that run right inside Orchard. Get one and it works offline too.'], game: ['Games', ''], educational: ['Educational', ''], installed: ['Installed', 'Extensions on this computer.'] }[f];
  m.innerHTML = `<div class="opsec" style="max-width:none"><h2>${head[0]}</h2>${head[1] ? `<p>${head[1]}</p>` : ''}<div class="extgrid" id="extGrid"><div style="color:var(--dim)">Loading…</div></div></div>`;
  const installed = await EXT.list();
  let items;
  if (f === 'installed') items = installed.map(x => ({ ...x, installed: x }));
  else {
    const cat = extCatalogCache || await EXT.catalog();
    if (cat.error) { $('extGrid').innerHTML = `<div style="color:#ff6b6b">couldn't reach the extension store: ${esc(cat.error)}</div>`; if (!installed.length) return; items = installed.map(x => ({ ...x, installed: x })); }
    else { extCatalogCache = cat; items = cat.items.filter(x => f === 'all' || x.category === f).map(x => ({ ...x, installed: installed.find(i => i.id === x.id) })); }
  }
  const g = $('extGrid');
  if (!items.length) { g.innerHTML = `<div style="color:var(--dim)">${f === 'installed' ? 'nothing installed yet, check Discover' : 'nothing here yet'}</div>`; return; }
  g.innerHTML = '';
  items.forEach(x => {
    const c = document.createElement('div'); c.className = 'extcard';
    const upd = x.installed && x.version && x.installed.version !== x.version && f !== 'installed';
    c.innerHTML = `<div class="eh"><div class="ei"></div><div><div class="en"></div><span class="lab ${x.category === 'educational' ? 'educational' : 'game'}">${x.category === 'educational' ? 'Educational' : 'Game'}</span></div></div><p></p><div class="ef"><small></small>${x.installed ? `<span class="pbtn" data-a="rm">Remove</span>${upd ? '<span class="pbtn" data-a="get">Update</span>' : ''}<span class="pbtn ok" data-a="play">${x.inject ? '&#9889; Activate' : '&#9654; Play'}</span>` : '<span class="pbtn ok" data-a="get">Get</span>'}</div>`;
    c.querySelector('.ei').textContent = x.icon || '🧩';
    c.querySelector('.en').textContent = x.name;
    c.querySelector('p').textContent = x.description || '';
    c.querySelector('small').textContent = (x.size ? (x.size / 1e6).toFixed(1) + ' MB' : '') + (x.version ? ' · v' + x.version : '');
    c.onclick = async (ev) => {
      const a = ev.target.dataset.a; if (!a) return;
      if (a === 'play') { closePage(); extPlay(x.id); }
      if (a === 'get') { ev.target.textContent = 'Getting…'; const res = await EXT.install(x.id); if (res.error) { toast("couldn't get it: " + res.error); ev.target.textContent = 'Get'; return; } toast(x.name + ' installed 🔥'); renderExtensions(extFilter); }
      if (a === 'rm') { await EXT.remove(x.id); toast(x.name + ' removed'); renderExtensions(extFilter); }
    };
    g.appendChild(c);
  });
}

// ---- calculator (normal + scientific) ----
let calcExpr = '', calcAns = 0, calcHist = [], calcDeg = true, calcJust = false;
function calcEval(src) {
  const s = src.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/π/g, ' pi ').replace(/√/g, ' sqrt ');
  const toks = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++; const v = Number(s.slice(i, j)); if (isNaN(v)) throw 0; toks.push({ t: 'n', v }); i = j; continue; }
    if (/[a-z]/i.test(c)) { let j = i; while (j < s.length && /[a-z]/i.test(s[j])) j++; toks.push({ t: 'id', v: s.slice(i, j).toLowerCase() }); i = j; continue; }
    if ('+-*/^()!%'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw 0;
  }
  let p = 0;
  const peek = () => toks[p], take = () => toks[p++];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  const toRad = (x) => calcDeg ? x * Math.PI / 180 : x, fromRad = (x) => calcDeg ? x * 180 / Math.PI : x;
  const F = { sin: x => Math.sin(toRad(x)), cos: x => Math.cos(toRad(x)), tan: x => Math.tan(toRad(x)), asin: x => fromRad(Math.asin(x)), acos: x => fromRad(Math.acos(x)), atan: x => fromRad(Math.atan(x)), ln: Math.log, log: Math.log10, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp };
  const fact = (n) => { if (n < 0 || n !== Math.floor(n) || n > 170) throw 0; let r = 1; for (let k = 2; k <= n; k++) r *= k; return r; };
  function expr() { let v = term(); while (isOp('+') || isOp('-')) { const o = take().v, b = term(); v = o === '+' ? v + b : v - b; } return v; }
  function term() {
    let v = unary();
    while (true) {
      if (isOp('*') || isOp('/')) { const o = take().v, b = unary(); v = o === '*' ? v * b : v / b; }
      else if (peek() && (peek().t === 'n' || peek().t === 'id' || isOp('('))) v *= power(); // 2π, 3(4)
      else break;
    }
    return v;
  }
  function unary() { if (isOp('-')) { take(); return -unary(); } if (isOp('+')) { take(); return unary(); } return power(); }
  function power() { const b = post(); if (isOp('^')) { take(); return Math.pow(b, unary()); } return b; }
  function post() { let v = prim(); while (isOp('!') || isOp('%')) { const o = take().v; v = o === '!' ? fact(v) : v / 100; } return v; }
  function prim() {
    const t = take(); if (!t) throw 0;
    if (t.t === 'n') return t.v;
    if (t.t === 'op' && t.v === '(') { const v = expr(); if (isOp(')')) take(); return v; }
    if (t.t === 'id') {
      if (t.v === 'pi') return Math.PI; if (t.v === 'e') return Math.E; if (t.v === 'ans') return calcAns;
      if (F[t.v]) return F[t.v](unary());
    }
    throw 0;
  }
  const v = expr();
  if (p < toks.length) throw 0;
  if (!isFinite(v)) throw 0;
  return v;
}
const calcFmt = (v) => { if (Math.abs(v) < 1e-12) return '0'; const s = Math.abs(v) >= 1e12 || Math.abs(v) < 1e-6 ? v.toExponential(8) : String(+v.toPrecision(12)); return s.replace(/(\.\d*?)0+e/, '$1e').replace(/\.e/, 'e'); };
function calcPress(k) {
  if (k === 'C') { calcExpr = ''; calcJust = false; }
  else if (k === '⌫') { calcExpr = calcExpr.replace(/(sin\(|cos\(|tan\(|asin\(|acos\(|atan\(|ln\(|log\(|√\(|ans|.)$/, ''); }
  else if (k === '=') {
    if (!calcExpr.trim()) return;
    try { const v = calcEval(calcExpr); calcHist.unshift(calcExpr + ' = ' + calcFmt(v)); calcHist = calcHist.slice(0, 8); calcAns = v; calcExpr = calcFmt(v); calcJust = true; }
    catch { renderCalcDisp('error, check ur sum'); return; }
  }
  else if (k === 'DEG') { calcDeg = !calcDeg; renderCalc(); return; }
  else {
    const fn = { 'x²': '^2', 'xʸ': '^', '√': '√(', 'sin': 'sin(', 'cos': 'cos(', 'tan': 'tan(', 'sin⁻¹': 'asin(', 'cos⁻¹': 'acos(', 'tan⁻¹': 'atan(', 'ln': 'ln(', 'log': 'log(', 'eˣ': 'e^(', '10ˣ': '10^(', '1/x': '^(-1)', 'Ans': 'ans' }[k] || k;
    if (calcJust && /^[0-9.π(√a-z]/.test(fn) && !/^ans/.test(fn)) calcExpr = '';
    calcJust = false;
    calcExpr += fn;
  }
  renderCalcDisp();
}
function renderCalcDisp(err) {
  if (!$('cExpr')) return;
  $('cExpr').textContent = calcExpr || ' ';
  let preview = '';
  if (!err && calcExpr) { try { preview = calcFmt(calcEval(calcExpr)); } catch {} }
  $('cRes').textContent = err || preview || (calcExpr ? '…' : '0');
  $('cRes').classList.toggle('err', !!err);
  $('cHist').innerHTML = ''; calcHist.forEach(h => { const d = document.createElement('div'); d.textContent = h; d.onclick = () => { calcExpr = h.split(' = ')[1]; calcJust = true; renderCalcDisp(); }; $('cHist').appendChild(d); });
}
function renderCalc() {
  const sci = !!store.settings.calcSci, p = $('panel');
  p.classList.add('calcw'); p.classList.toggle('sci', sci);
  $('ptitle').innerHTML = '&#129518; Calculator <span class="pbtn" id="cMode" style="margin-left:8px;font-size:11px">' + (sci ? 'Normal' : 'Scientific') + '</span>';
  const K = (k, cls) => `<div class="ck ${cls || ''}" data-k="${k}">${k === '*' ? '×' : k === '/' ? '÷' : k === '-' ? '−' : k}</div>`;
  const basic = ['C', '⌫', '%', '/', '7', '8', '9', '*', '4', '5', '6', '-', '1', '2', '3', '+', 'Ans', '0', '.', '='];
  const sciKeys = ['DEG', '(', ')', 'sin', 'cos', 'tan', 'sin⁻¹', 'cos⁻¹', 'tan⁻¹', 'ln', 'log', '√', 'x²', 'xʸ', '!', 'π', 'e', '1/x', 'eˣ', '10ˣ'];
  $('plist').innerHTML = `<div class="calc"><div class="cdisp"><div class="cexpr" id="cExpr"></div><div class="cres" id="cRes">0</div></div>
    <div class="ckeys">${sci ? `<div class="cgrid sci">${sciKeys.map(k => k === 'DEG' ? `<div class="ck fn" data-k="DEG">${calcDeg ? 'DEG' : 'RAD'}</div>` : K(k, 'fn')).join('')}</div>` : ''}
    <div class="cgrid">${basic.map(k => K(k, k === '=' ? 'eq' : '/*-+%'.includes(k) || k === '⌫' || k === 'C' ? 'op' : '')).join('')}</div></div>
    ${sci ? '' : `<div class="cgrid" style="grid-template-columns:repeat(2,1fr);margin-top:7px">${K('(', 'fn')}${K(')', 'fn')}</div>`}
    <div class="chist" id="cHist"></div></div>`;
  $('plist').querySelectorAll('.ck').forEach(b => b.onmousedown = (e) => { e.preventDefault(); calcPress(b.dataset.k); });
  $('cMode').onclick = () => { store.settings.calcSci = !sci; save(); renderCalc(); };
  renderCalcDisp();
}
document.addEventListener('keydown', (e) => {
  if (!$('panel').classList.contains('show') || $('panel').dataset.kind !== 'calc') return;
  if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const map = { Enter: '=', '=': '=', Backspace: '⌫', Escape: 'C', Delete: 'C', '*': '*', '/': '/', x: '*' };
  const k = map[e.key] || (/^[0-9.+\-()%^!]$/.test(e.key) ? e.key : null);
  if (k) { e.preventDefault(); e.stopPropagation(); calcPress(k); }
}, true);

// ---- calendar: month view + events with reminders ----
let calView = new Date(), calSel = null;
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const evAt = (ev) => { const [y, m, d] = ev.date.split('-').map(Number), [h, mi] = ev.time.split(':').map(Number); return new Date(y, m - 1, d, h, mi); };
const fmtT = (t) => { const [h, mi] = t.split(':').map(Number); return new Date(2000, 0, 1, h, mi).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
const eventsOn = (key) => (store.events || []).filter(e => e.date === key).sort((a, b) => a.time.localeCompare(b.time));
function openCalendar(dateKey) {
  if (dateKey) { const [y, m, d] = dateKey.split('-').map(Number); calView = new Date(y, m - 1, 1); calSel = dateKey; }
  openPage('calendar', '&#128197;', 'Calendar', [['month', '&#128197;', 'Month'], ['upcoming', '&#9200;', 'Upcoming']], renderCalendar);
}
function renderCalendar(sec) {
  markNav(sec);
  const m = $('opmain');
  if (!calSel) calSel = ymd(new Date());
  if (sec === 'upcoming') {
    const now = Date.now();
    const up = (store.events || []).filter(e => evAt(e).getTime() >= now - 3600e3).sort((a, b) => evAt(a) - evAt(b));
    m.innerHTML = `<div class="opsec"><h2>Upcoming</h2><p>Everything coming up. Orchard pings u when it's time (while it's open), and tells u if u missed one.</p><div class="agenda" id="upList"></div></div>`;
    const box = $('upList');
    if (!up.length) box.innerHTML = '<div style="color:var(--dim)">nothing coming up 🍃</div>';
    up.forEach(ev => box.appendChild(agendaItem(ev, true)));
    return;
  }
  const y = calView.getFullYear(), mo = calView.getMonth();
  const first = new Date(y, mo, 1), start = new Date(y, mo, 1 - ((first.getDay() + 6) % 7)); // weeks start Monday
  const todayKey = ymd(new Date());
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i), key = ymd(d), evs = eventsOn(key);
    cells += `<div class="cday${d.getMonth() !== mo ? ' other' : ''}${key === todayKey ? ' today' : ''}${key === calSel ? ' sel' : ''}" data-d="${key}"><span class="dn">${d.getDate()}</span><div class="evs">${evs.slice(0, 2).map(e => `<span class="ev" title="${esc(fmtT(e.time))} ${esc(e.title)}">${esc(e.title)}</span>`).join('')}${evs.length > 2 ? `<span class="more">+${evs.length - 2} more</span>` : ''}</div></div>`;
  }
  const selD = (() => { const [a, b, c] = calSel.split('-').map(Number); return new Date(a, b - 1, c); })();
  m.innerHTML = `<div class="calwrap">
    <div class="calmonth">
      <div class="calhead"><b>${first.toLocaleDateString([], { month: 'long', year: 'numeric' })}</b><span class="pbtn" id="calPrev">&#8249;</span><span class="pbtn" id="calToday">Today</span><span class="pbtn" id="calNext">&#8250;</span></div>
      <div class="calgrid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => `<div class="dow">${x}</div>`).join('')}${cells}</div>
    </div>
    <div class="calday">
      <h3>${selD.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
      <small>${eventsOn(calSel).length ? eventsOn(calSel).length + ' event' + (eventsOn(calSel).length > 1 ? 's' : '') : 'no events yet'}</small>
      <div class="agenda" id="agList"></div>
      <form class="evform" id="evForm">
        <b style="font-size:13px">Add an event</b>
        <input id="evTitle" placeholder="What's happening? (e.g. maths test)" maxlength="80" required>
        <div class="r2"><input id="evTime" type="time" value="${pad2(Math.min(23, new Date().getHours() + 1))}:00" required>
        <select id="evRemind"><option value="0">At the time</option><option value="5">5 min before</option><option value="10">10 min before</option><option value="15">15 min before</option><option value="30">30 min before</option><option value="60">1 hour before</option><option value="1440">1 day before</option></select></div>
        <input id="evNote" placeholder="Note (optional)" maxlength="200">
        <button class="pbtn ok" type="submit" style="padding:9px">Add to ${selD.toLocaleDateString([], { day: 'numeric', month: 'short' })}</button>
      </form>
    </div></div>`;
  eventsOn(calSel).forEach(ev => $('agList').appendChild(agendaItem(ev)));
  m.querySelectorAll('.cday').forEach(c => c.onclick = () => { calSel = c.dataset.d; const [a, b] = calSel.split('-').map(Number); if (b - 1 !== mo) calView = new Date(a, b - 1, 1); renderCalendar('month'); });
  $('calPrev').onclick = () => { calView = new Date(y, mo - 1, 1); renderCalendar('month'); };
  $('calNext').onclick = () => { calView = new Date(y, mo + 1, 1); renderCalendar('month'); };
  $('calToday').onclick = () => { calView = new Date(); calSel = ymd(new Date()); renderCalendar('month'); };
  $('evForm').onsubmit = (e) => {
    e.preventDefault();
    const title = $('evTitle').value.trim(), time = $('evTime').value;
    if (!title || !/^\d\d:\d\d$/.test(time)) return;
    const ev = { id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), date: calSel, time, title, note: $('evNote').value.trim(), remind: +$('evRemind').value };
    store.events = (store.events || []).concat(ev); save();
    const when = evAt(ev);
    toast(when < new Date() ? 'added (that time already passed)' : 'event added, Orchard will ping u 🔔');
    renderCalendar('month');
  };
}
function agendaItem(ev, showDate) {
  const d = document.createElement('div');
  const past = evAt(ev) < new Date();
  d.className = 'agi' + (past ? ' past' : '');
  d.innerHTML = '<span class="at"></span><div class="ab"><b></b><small></small></div><span class="ax" title="Delete">&#10005;</span>';
  d.querySelector('.at').textContent = (showDate ? evAt(ev).toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' : '') + fmtT(ev.time);
  d.querySelector('b').textContent = ev.title;
  const remindTxt = { 0: '', 5: '5 min before', 10: '10 min before', 15: '15 min before', 30: '30 min before', 60: '1 hour before', 1440: '1 day before' }[ev.remind || 0];
  d.querySelector('small').textContent = [ev.note, remindTxt ? '🔔 ' + remindTxt : (past ? 'done' : '🔔 at the time')].filter(Boolean).join(' · ');
  d.querySelector('.ax').onclick = () => { store.events = (store.events || []).filter(x => x.id !== ev.id); save(); renderCalendar(pageKind === 'calendar' && document.querySelector('#opnav a.on') ? document.querySelector('#opnav a.on').dataset.k : 'month'); };
  return d;
}
function showEventNote(ev) {
  const box = $('notes');
  while (box.children.length >= 4) box.lastElementChild.remove();
  const d = document.createElement('div'); d.className = 'note';
  d.style.borderLeftColor = ev.passed ? '#8a5a3c' : 'var(--acc2)';
  const head = ev.passed ? 'Event passed' : ev.soon ? 'Coming up at ' + fmtT(ev.time) : 'Happening now';
  d.innerHTML = '<div class="nav" style="background:#33201d;font-size:18px">' + (ev.passed ? '&#8987;' : '&#128197;') + '</div><div class="nb"><div class="nt"><span class="ntt"></span><small></small></div><div class="nm"></div></div><span class="nx" title="Dismiss">&#10005;</span>';
  d.querySelector('.ntt').textContent = ev.title;
  d.querySelector('small').textContent = head;
  d.querySelector('.nm').textContent = (ev.passed ? 'Was ' + evAt(ev).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + ' at ' + fmtT(ev.time) : fmtT(ev.time)) + (ev.note ? ' · ' + ev.note : '');
  const kill = () => { d.style.transition = 'opacity .2s'; d.style.opacity = 0; setTimeout(() => d.remove(), 200); };
  d.onclick = (e) => { kill(); if (!e.target.classList.contains('nx')) openCalendar(ev.date); };
  box.prepend(d);
  if (!ev.passed) setTimeout(kill, 30000); // reminders stay longer than chat pings
}
window.aura.on('cal-due', (ev) => {
  if (!ev || !ev.title) return;
  if (document.hasFocus()) showEventNote(ev);
  else window.aura.notify({ title: (ev.passed ? 'Event passed: ' : ev.soon ? 'Coming up: ' : '📅 ') + ev.title, body: (ev.passed ? 'Was at ' : 'At ') + fmtT(ev.time) + (ev.note ? ' · ' + ev.note : ''), action: 'cal:' + ev.date });
});
window.aura.on('note-click', (a) => { if (String(a).startsWith('cal:')) openCalendar(String(a).slice(4)); });

// ---- sticky notes: taped to a tab, right-click a note to crumple it ----
let noteDrag = null;
function renderNotes() {
  const layer = $('noteLayer');
  const show = active && visibleSet().length === 1 && !(active.locked && !active.unlocked && lockReady());
  layer.innerHTML = '';
  if (!show || !active.notes || !active.notes.length) return;
  const b = layer.getBoundingClientRect();
  active.notes.forEach(n => layer.appendChild(buildNote(active, n, b)));
}
function buildNote(tab, n, b) {
  const d = document.createElement('div');
  d.className = 'snote' + (n.c ? ' c' + n.c : '');
  d.style.left = Math.max(2, Math.min(n.x, b.width - 60)) + 'px';
  d.style.top = Math.max(2, Math.min(n.y, b.height - 40)) + 'px';
  d.innerHTML = '<div class="tape"></div><div class="shandle"></div><textarea placeholder="write something…" spellcheck="false"></textarea>';
  const ta = d.querySelector('textarea');
  ta.value = n.text;
  ta.oninput = () => { n.text = ta.value; saveSession(); };
  d.querySelector('.shandle').addEventListener('pointerdown', (e) => {
    e.preventDefault(); noteDrag = { d, n, dx: e.clientX - d.offsetLeft, dy: e.clientY - d.offsetTop };
    d.classList.add('drag'); try { d.setPointerCapture(e.pointerId); } catch {} d.style.zIndex = 5;
  });
  d.addEventListener('pointermove', (e) => {
    if (!noteDrag || noteDrag.d !== d) return;
    const lb = $('noteLayer').getBoundingClientRect();
    n.x = Math.max(2, Math.min(e.clientX - noteDrag.dx, lb.width - 60));
    n.y = Math.max(2, Math.min(e.clientY - noteDrag.dy, lb.height - 40));
    d.style.left = n.x + 'px'; d.style.top = n.y + 'px';
  });
  const end = () => { if (noteDrag && noteDrag.d === d) { noteDrag = null; d.classList.remove('drag'); saveSession(); } };
  d.addEventListener('pointerup', end); d.addEventListener('pointercancel', end);
  d.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showMenu(e, [['&#128168; Crumple', () => crumpleNote(tab, n, d)], ['Change colour', () => { n.c = (n.c + 1) % 4; saveSession(); renderNotes(); }]]); });
  return d;
}
function addNote(tab, x, y) {
  tab.notes = tab.notes || [];
  if (tab.notes.length >= 40) { toast('thats a lot of notes on one tab 😭'); return; }
  const n = { id: 'n' + Math.random().toString(36).slice(2), x: x - 14, y: y - 8, text: '', c: tab.notes.length % 4 };
  tab.notes.push(n); saveSession(); renderNotes();
  setTimeout(() => { const el = [...$('noteLayer').children].pop(); if (el) el.querySelector('textarea').focus(); }, 30);
}
function crumpleNote(tab, n, el) {
  el.classList.add('crumpling');
  tab.notes = (tab.notes || []).filter(x => x !== n); saveSession();
  setTimeout(() => { el.remove(); }, 450);
}
window.addEventListener('resize', () => { if ($('noteLayer').children.length) renderNotes(); });

// ---- page right-click menu (also where "add sticky note" lives) ----
function showPageMenu(t, p) {
  if (!t || !t.wv || !p) return;
  if (t.locked && !t.unlocked && lockReady()) return;
  if (t !== active && visibleSet().length === 1) activate(t);
  const b = t.wv.getBoundingClientRect();
  const ev = { clientX: b.left + p.x, clientY: b.top + p.y, preventDefault() {} };
  const wv = t.wv, items = [];
  items.push(['&#128221; Add sticky note here', () => addNote(t, p.x, p.y)]);
  items.push(null);
  if (p.sel) {
    items.push(['Copy', () => wv.copy()]);
    const q = p.sel.trim().slice(0, 40);
    items.push(['Search “' + esc(q) + (p.sel.length > 40 ? '…' : '') + '”', () => createTab(ENGINES[store.settings.engine || 'google'] + encodeURIComponent(p.sel))]);
    items.push(['Ask AI about this', () => { toggleAi(true); setTimeout(() => askAboutPage('explain'), 300); }]);
  }
  if (p.link) { items.push(['Open link in new tab', () => createTab(p.link, true)]); items.push(['Copy link', () => navigator.clipboard.writeText(p.link).catch(() => {})]); }
  if (p.src) { items.push(['Open image in new tab', () => createTab(p.src, true)]); items.push(['Search image with Lens', () => startLens()]); }
  if (p.isEditable) { items.push(null); if (p.canCut) items.push(['Cut', () => wv.cut()]); if (p.canCopy) items.push(['Copy', () => wv.copy()]); if (p.canPaste) items.push(['Paste', () => wv.paste()]); items.push(['Select all', () => wv.selectAll()]); }
  items.push(null);
  items.push(['Back', () => { if (wv.canGoBack()) wv.goBack(); }, !wv.canGoBack()]);
  items.push(['Reload', () => wv.reload()]);
  showMenu(ev, items);
}

// ---- password manager: offer to save a login after u submit it ----
let pwOffer = null;
window.aura.on('pw-offer', (d) => {
  if (store.settings.savePasswords === false) return;
  pwOffer = d;
  const bar = $('pwbar');
  const host = (() => { try { return new URL(d.origin).hostname.replace(/^www\./, ''); } catch { return d.origin; } })();
  bar.innerHTML = `<h4>&#128273; ${d.update ? 'Update password?' : 'Save password?'}</h4>
    <div class="site">${esc(host)}</div>
    ${d.user ? `<div class="fld"><b>User</b><span>${esc(d.user)}</span></div>` : ''}
    <div class="fld"><b>Pass</b><span id="pwDot">${'•'.repeat(Math.min(12, d.pass.length))}</span><span class="eye" id="pwEye">&#128065;</span></div>
    <div class="pwrow"><span class="pbtn" id="pwNever">Never</span><span class="pbtn" id="pwNo">Not now</span><span class="pbtn ok" id="pwYes">${d.update ? 'Update' : 'Save'}</span></div>`;
  bar.hidden = false;
  const r = $('star').getBoundingClientRect();
  bar.style.left = Math.max(12, Math.min(r.left - 150, innerWidth - 332)) + 'px';
  bar.style.top = (r.bottom + 8) + 'px';
  let shown = false;
  $('pwEye').onclick = () => { shown = !shown; $('pwDot').textContent = shown ? d.pass : '•'.repeat(Math.min(12, d.pass.length)); };
  $('pwYes').onclick = async () => { await window.aura.pwStore(d); toast('password saved 🔐'); closePwBar(); };
  $('pwNo').onclick = closePwBar;
  $('pwNever').onclick = async () => { await window.aura.pwNever(d.origin); toast('wont ask for this site'); closePwBar(); };
  clearTimeout(window._pwT); window._pwT = setTimeout(closePwBar, 25000);
});
function closePwBar() { $('pwbar').hidden = true; pwOffer = null; }
document.addEventListener('mousedown', (e) => { if (!$('pwbar').hidden && !e.target.closest('#pwbar') && !e.target.closest('#url')) closePwBar(); });

async function renderPasswords() {
  $('ptitle').innerHTML = '&#128273; Saved passwords';
  const list = $('plist');
  const items = await window.aura.pwList();
  if (!items.length) { list.innerHTML = '<div class="set" style="color:var(--dim)">nothing saved yet. log into a site and Orchard will offer to save it.</div>'; return; }
  list.innerHTML = '';
  items.sort((a, b) => b.updated - a.updated).forEach(it => {
    const host = (() => { try { return new URL(it.origin).hostname.replace(/^www\./, ''); } catch { return it.origin; } })();
    const r = document.createElement('div'); r.className = 'row';
    r.innerHTML = `<img src="${fav(it.origin)}" width=16 height=16 onerror="this.style.visibility='hidden'"><div class="rt"><div></div><small></small></div><span class="pbtn mini" data-a="show">Show</span><span class="pbtn mini" data-a="copy">Copy</span><span class="del" data-a="del">&#10005;</span>`;
    r.querySelector('.rt div').textContent = host;
    r.querySelector('small').textContent = it.user || '(no username)';
    r.onclick = async (e) => {
      const a = e.target.dataset.a;
      if (a === 'del') { await window.aura.pwDelete(it.origin, it.user); renderPasswords(); }
      else if (a === 'copy') { const p = await window.aura.pwReveal(it.origin, it.user); if (p) { navigator.clipboard.writeText(p).catch(() => {}); toast('password copied'); } }
      else if (a === 'show') { const p = await window.aura.pwReveal(it.origin, it.user); const s = e.target; if (p) { s.textContent = s.textContent === 'Show' ? p : 'Show'; } }
    };
    list.appendChild(r);
  });
}

// ---- main menu: every feature in one place ----
const FEATURES = [
  ['BATTERY (THE CORE OF ORCHARD)'],
  ['&#127811;', 'Battery saver', 'see what drains it, pick Eco, Saver or Ultra', 'Battery pill', () => openPanel('battery')],
  ['&#128164;', 'Rest all tabs', 'put every background tab to sleep now', '', () => { let n = 0; tabs.forEach(t => { if (!isShown(t) && !t.sleeping) { sleepTab(t); if (t.sleeping) n++; } }); toast(n + ' tab(s) resting 💤'); }],
  ['TABS & WINDOWS'],
  ['&#10133;', 'New tab', 'opens the start page', 'Ctrl+T', () => createTab()],
  ['&#128468;', 'New window', 'same profile, fresh window', 'Ctrl+N', () => window.aura.newWindow()],
  ['&#128274;', 'Lock a tab', 'password protect a tab, locks again when u leave it', 'Right click tab', () => active && toggleLock(active)],
  ['&#9707;', 'Split screen', 'right click a tab, pick split. up to 4', 'Right click tab', () => { const o = tabs.find(t => t !== active); if (o) splitWith(o); else toast('open another tab first, then right click it'); }],
  ['&#8634;', 'Reopen closed tab', 'brings back the last tab u closed', 'Ctrl+Shift+T', () => { const u = closed.pop(); if (u) createTab(u); else toast('no closed tabs'); }],
  ['&#128433;', 'Drag tabs', 'drag to reorder, drag out for a new window', 'Drag', () => toast('grab a tab and drag it out of the window')],
  ['SMART STUFF'],
  ['&#9993;', 'Orchard Mail', 'ur Gmail in a side panel, sign in through Chrome', 'Alt+M', () => openMail()],
  ['&#128172;', 'Google Chat', 'ur school Google Chat in the side panel', 'Alt+C', () => openGoogleChat()],
  ['&#127822;', 'Orchard Chat', 'the built-in chat, friends join by email', '', () => openChat()],
  ['&#10022;', 'Ask AI', 'Gemini, ChatGPT or Claude on the side', 'Alt+G', () => toggleAi(true)],
  ['&#9889;', 'Answer quickly', 'answers the questions on this page, short', '', () => askAboutPage('answer')],
  ['&#9989;', 'Answer only', 'just the answers, nothing else', '', () => askAboutPage('answeronly')],
  ['&#128269;', 'Google Lens', 'drag over anything to search it', 'Lens icon', () => startLens()],
  ['&#128065;', 'Hide elements', 'click ads, popups, anything to hide it on that site', 'Alt+H', () => startHidePicker()],
  ['TOOLS'],
  ['&#128246;', 'WiFi speed test', 'ping, download and upload', 'WiFi icon', () => openPanel('speed')],
  ['&#11015;', 'Downloads', 'progress, open, show in folder', 'Ctrl+J', () => openPanel('downloads')],
  ['&#128339;', 'History', 'everything u visited', 'Ctrl+H', () => openPanel('history')],
  ['&#128270;', 'Find in page', 'search words on this page', 'Ctrl+F', () => openFind()],
  ['YOU'],
  ['&#128100;', 'Profiles', 'separate logins and bookmarks', 'Avatar', () => openPanel('profiles')],
  ['\uD83D\uDD76', 'Guest window', 'nothing saved, like incognito', 'Ctrl+Shift+N', () => window.aura.openGuest()],
  ['&#127912;', 'Backgrounds', 'colors, gradients, ur own pics', 'Settings', () => openPanel('theme')],
  ['&#11088;', 'Bookmark page', 'adds it to the bar', 'Ctrl+D', () => toggleBookmark()],
  ['&#129513;', 'Extensions', 'games and learning apps that run in Orchard', '', () => openExtensions()],
  ['&#128197;', 'Calendar', 'events with reminders', 'Alt+E', () => openCalendar()],
  ['&#129518;', 'Calculator', 'normal or scientific', 'Alt+K', () => openPanel('calc')],
  ['&#9881;', 'Settings', 'toolbar, search, battery, chat and more', '', () => openSettings()]
];
function renderMenu() {
  $('ptitle').textContent = 'Everything in Orchard';
  const list = $('plist'); list.innerHTML = '';
  let grid = null;
  FEATURES.forEach(f => {
    if (f.length === 1) { list.appendChild(Object.assign(document.createElement('div'), { className: 'mhead', textContent: f[0] })); grid = document.createElement('div'); grid.className = 'mgrid'; list.appendChild(grid); return; }
    const d = document.createElement('div'); d.className = 'mi';
    d.innerHTML = `<b><i>${f[0]}</i><span></span></b><small></small>${f[3] ? '<kbd></kbd>' : ''}`;
    d.querySelector('b span').textContent = f[1]; d.querySelector('small').textContent = f[2];
    if (f[3]) d.querySelector('kbd').textContent = f[3];
    d.onclick = () => { $('panel').classList.remove('show'); f[4](); };
    grid.appendChild(d);
  });
}

// ---- tab right click menu ----
function tabMenu(e, t) {
  e.preventDefault();
  closeMenu();
  const m = document.createElement('div'); m.id = 'ctx';
  const items = [
    ['Reload', () => t.wv && t.wv.reload()],
    ['Duplicate', () => createTab(t.url && !isNewtab(t.url) ? t.url : undefined)],
    /^https?:/.test(t.url || '') ? ['Open in Chrome (default browser)', () => ext(t.url)] : null,
    null,
    t === active ? null : [split.includes(t) && split.includes(active) ? 'Already in split' : 'Split screen with this tab', () => splitWith(t), split.includes(t) && split.includes(active)],
    split.includes(t) ? ['Remove from split', () => unsplit(t)] : null,
    split.length ? ['Exit split screen', () => unsplit()] : null,
    null,
    [t.locked ? '&#128275; Remove lock' : '&#128274; Lock tab', () => toggleLock(t)],
    t.locked && t.unlocked ? ['Lock now', () => { t.unlocked = false; renderTab(t); layoutViews(); updateNav(); }] : null,
    null,
    ['Close tab', () => closeTab(t)]
  ];
  showMenu(e, items);
}
function showMenu(e, items) {
  e.preventDefault();
  closeMenu();
  const m = document.createElement('div'); m.id = 'ctx';
  let lastSep = true;
  items.forEach(it => {
    if (it === null) { if (!lastSep) { m.appendChild(Object.assign(document.createElement('hr'))); lastSep = true; } return; }
    if (!it) return;
    const d = document.createElement('div'); d.className = 'ci' + (it[2] ? ' dis' : ''); d.innerHTML = it[0];
    d.onclick = () => { closeMenu(); if (!it[2]) it[1](); };
    m.appendChild(d); lastSep = false;
  });
  if (m.lastChild && m.lastChild.tagName === 'HR') m.lastChild.remove();
  document.body.appendChild(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(e.clientX, innerWidth - w - 6) + 'px';
  m.style.top = Math.min(e.clientY, innerHeight - h - 6) + 'px';
}
function closeMenu() { const m = $('ctx'); if (m) m.remove(); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx')) closeMenu(); });
window.addEventListener('blur', closeMenu);

function closeTab(t, moved) {
  const i = tabs.indexOf(t);
  if (!isNewtab(t.url) && !moved) closed.push(t.url);
  clearTimeout(t.freezeT);
  if (t.wv) t.wv.remove();
  if (t.lockEl) t.lockEl.remove();
  const gone = t.el; gone.classList.add('closing'); setTimeout(() => gone.remove(), document.body.classList.contains('saver') ? 0 : 190);
  if (split.includes(t)) { split = split.filter(x => x !== t); if (split.length < 2) split = []; }
  tabs.splice(i, 1);
  saveSession();
  if (!tabs.length) { active = null; createTab(); return; }
  if (active === t) { active = null; activate(tabs[Math.min(i, tabs.length - 1)]); }
}

function updateNav() {
  if (!active) return;
  const t = active, u = t.url;
  const masked = t.locked && !t.unlocked && lockReady();
  if (document.activeElement !== $('url')) $('url').value = isNewtab(u) || masked ? '' : u;
  $('lock').innerHTML = isNewtab(u) ? '&#128269;' : (u.startsWith('https') ? '&#128274;' : '&#9888;');
  let back = false, fwd = false;
  try { if (t.ready) { back = t.wv.canGoBack(); fwd = t.wv.canGoForward(); } } catch {}
  $('back').classList.toggle('off', !back);
  $('fwd').classList.toggle('off', !fwd);
  $('star').classList.toggle('on', store.bookmarks.some(b => b.url === u));
  $('star').innerHTML = $('star').classList.contains('on') ? '&#9733;' : '&#9734;';
  try { const z = t.ready ? t.wv.getZoomFactor() : 1; $('zoom').style.display = z !== 1 ? 'inline' : 'none'; $('zoom').textContent = Math.round(z * 100) + '%'; } catch {}
}

function progress(p) {
  const el = $('progress');
  el.style.opacity = 1; el.style.width = p + '%';
  if (p >= 100) setTimeout(() => { el.style.opacity = 0; setTimeout(() => el.style.width = 0, 400); }, 200);
}

function go(q) {
  const u = toUrl(q);
  if (!u || !active) return;
  if (active.locked && !active.unlocked && lockReady()) { toast('unlock the tab first 🔒'); return; }
  active.wv.loadURL(u).catch(() => {});
  active.wv.focus();
}

function addHistory(t) {
  const h = store.history;
  if (h[0] && h[0].url === t.url) h[0].title = t.title;
  else h.unshift({ title: t.title, url: t.url, time: Date.now() });
  if (h.length > 5000) h.length = 5000;
  save();
}

function renderBookmarks() {
  const bm = $('bm'); bm.innerHTML = '';
  store.bookmarks.forEach(b => {
    const d = document.createElement('div');
    d.className = 'bmi';
    d.innerHTML = `<img src="${fav(b.url)}" onerror="this.style.display='none'"><span></span>`;
    d.querySelector('span').textContent = b.title;
    d.title = b.url;
    d.onclick = (e) => e.ctrlKey ? createTab(b.url, true) : active.wv.loadURL(b.url);
    d.onauxclick = (e) => { if (e.button === 1) createTab(b.url, true); };
    d.oncontextmenu = (e) => showMenu(e, [
      ['Open', () => active.wv.loadURL(b.url)],
      ['Open in new tab', () => createTab(b.url, true)],
      null,
      ['Rename', async () => { const v = await modal('Rename bookmark', b.url, [{ id: 'n', label: 'Name', value: b.title }], 'Save'); if (v && v.n.trim()) { b.title = v.n.trim().slice(0, 40); save(); renderBookmarks(); } }],
      ['&#128465; Remove bookmark', () => { store.bookmarks = store.bookmarks.filter(x => x !== b); save(); renderBookmarks(); updateNav(); toast('bookmark removed'); }]
    ]);
    bm.appendChild(d);
  });
}

function toggleBookmark() {
  if (!active || isNewtab(active.url)) return;
  const i = store.bookmarks.findIndex(b => b.url === active.url);
  if (i >= 0) { store.bookmarks.splice(i, 1); toast('Bookmark removed 💔'); }
  else { store.bookmarks.push({ title: (active.title || active.url).slice(0, 40), url: active.url }); toast('Bookmarked 🔥'); }
  save(); renderBookmarks(); updateNav();
}

// panel
function openPanel(kind) {
  if (kind === 'extensions') { openExtensions(); return; }
  const p = $('panel'), list = $('plist');
  p.classList.toggle('calcw', kind === 'calc'); p.classList.toggle('sci', kind === 'calc' && !!store.settings.calcSci);
  if (p.classList.contains('show') && p.dataset.kind === kind) { p.classList.remove('show'); return; }
  p.dataset.kind = kind; p.classList.add('show'); list.innerHTML = '';
  if (kind === 'calc') { renderCalc(); return; }
  if (kind === 'history') {
    $('ptitle').textContent = 'History';
    if (!store.history.length) list.innerHTML = '<div class="set" style="color:var(--dim)">nothing here yet</div>';
    store.history.slice(0, 300).forEach((h, i) => {
      const r = document.createElement('div'); r.className = 'row';
      r.innerHTML = `<img src="${fav(h.url)}" width=16 height=16 onerror="this.style.visibility='hidden'"><div class="rt"><div></div><small></small></div><span class="del">&#10005;</span>`;
      r.querySelector('.rt div').textContent = h.title || h.url;
      r.querySelector('small').textContent = new Date(h.time).toLocaleString() + ' · ' + h.url;
      r.onclick = (e) => {
        if (e.target.classList.contains('del')) { store.history.splice(i, 1); save(); r.remove(); return; }
        active.wv.loadURL(h.url); p.classList.remove('show');
      };
      list.appendChild(r);
    });
  } else if (kind === 'profiles') {
    renderProfiles();
  } else if (kind === 'hides') {
    renderHides();
  } else if (kind === 'menu') {
    renderMenu();
  } else if (kind === 'passwords') {
    renderPasswords();
  } else if (kind === 'settings') {
    renderSettings();
  } else if (kind === 'theme') {
    renderTheme();
  } else if (kind === 'downloads') {
    renderDownloads();
  } else if (kind === 'speed') {
    renderSpeed();
  } else if (kind === 'battery') {
    renderBattery();
    clearInterval(meterT);
    meterT = setInterval(() => { if (panelIs('battery')) renderBattery(); else clearInterval(meterT); }, 2000);
  } else {
    $('ptitle').textContent = 'Settings';
    list.innerHTML = `
      <div class="set">Search engine <select id="eng">${Object.keys(ENGINES).map(k => `<option value="${k}" ${store.settings.engine === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="set"><span>Orchard <b id="verTxt">v…</b></span><span class="pbtn" id="updChk">Check for updates</span></div>
      <div class="set">Orchard Chat notifications <span class="pbtn" id="cnT">${store.settings.chatNotify === false ? 'OFF' : 'ON'}</span></div>
      <div class="set">Search suggestions <span class="pbtn" id="sgT">${store.settings.suggest === false ? 'OFF' : 'ON'}</span></div>
      <div class="set">New tab background <span class="pbtn" id="thm">&#127912; Change</span></div>
      <div class="set">Reopen tabs on startup <span class="pbtn" id="rst">${store.settings.restore === false ? 'OFF' : 'ON'}</span></div>
      <div class="set">Battery saver <select id="svr">${SAVER_OPTS}</select></div>
      <div class="set">Sleep unused tabs after <select id="slp">${[[2,'2 min'],[5,'5 min'],[10,'10 min'],[30,'30 min'],[0,'never']].map(([v,l]) => `<option value="${v}" ${(store.settings.sleepMins ?? 5) == v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="set">Freeze background tabs <span class="pbtn" id="frz">${store.settings.freeze === false ? 'OFF' : 'ON'}</span></div>
      <div class="set">Sleep all other tabs now <span class="pbtn" id="slpNow">&#128164; Sleep</span></div>
      <div class="set">Ad blocker <span class="pbtn" id="adT">${store.settings.adblock ? 'ON' : 'OFF'}</span></div>
      <div class="set">Clear history, cookies, cache <span class="pbtn" id="clr">Clear</span></div>
      <div class="set" style="color:var(--dim);font-size:12px;line-height:1.7;display:block">Shortcuts: Ctrl+T new tab · Ctrl+W close · Ctrl+Shift+T reopen · Ctrl+L address bar · Ctrl+Tab next tab · Ctrl+D bookmark · Ctrl+H history · Ctrl+F find · Alt+G Gemini · Alt+C chat · Ctrl+J downloads · Ctrl+N new window · Ctrl +/-/0 zoom · F11 fullscreen · F12 devtools</div>`;
    $('eng').onchange = (e) => { store.settings.engine = e.target.value; save(); };
    $('thm').onclick = () => openPanel('theme');
    $('cnT').onclick = () => { store.settings.chatNotify = store.settings.chatNotify === false; save(); $('cnT').textContent = store.settings.chatNotify === false ? 'OFF' : 'ON'; if (store.settings.chatNotify !== false) ensureChat(); placeChat(); };
    $('sgT').onclick = () => { store.settings.suggest = store.settings.suggest === false; save(); $('sgT').textContent = store.settings.suggest === false ? 'OFF' : 'ON'; };
    window.aura.appVersion().then(v => { if ($('verTxt')) $('verTxt').textContent = 'v' + v.version; });
    $('updChk').onclick = async () => {
      $('updChk').textContent = 'Checking…';
      const r = await window.aura.checkUpdate();
      const msg = { latest: 'ur on the newest version 🔥', ready: 'update ' + r.version + ' ready, restart to get it', busy: 'already checking', full: 'v' + r.version + ' needs a fresh download of the full zip', error: 'couldnt check: ' + r.error };
      $('updChk').textContent = 'Check for updates';
      toast(msg[r.status] || 'hmm');
      if (r.status === 'ready') showUpdate(r);
    };
    $('rst').onclick = () => { store.settings.restore = store.settings.restore === false; save(); $('rst').textContent = store.settings.restore === false ? 'OFF' : 'ON'; };
    $('svr').onchange = (e) => { store.settings.saver = e.target.value; save(); applySaver(); };
    $('slp').onchange = (e) => { store.settings.sleepMins = +e.target.value; save(); sleepCheck(); };
    $('frz').onclick = () => { store.settings.freeze = store.settings.freeze === false; save(); $('frz').textContent = store.settings.freeze === false ? 'OFF' : 'ON'; if (store.settings.freeze === false) tabs.forEach(t => freeze(t, false)); else applySaver(); };
    $('slpNow').onclick = () => { let n = 0; tabs.forEach(t => { if (t !== active && !t.sleeping) { sleepTab(t); if (t.sleeping) n++; } }); toast(n + ' tab(s) put to sleep 💤'); };
    $('adT').onclick = () => { toggleAdblock(); $('adT').textContent = store.settings.adblock ? 'ON' : 'OFF'; };
    $('clr').onclick = async () => { await window.aura.clearData(); store.history = []; toast('Everything wiped 🥶'); };
  }
}

// ---- downloads ----
const dls = new Map();
const fmtB = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b > 1e3 ? (b / 1e3).toFixed(0) + ' KB' : b + ' B';
function updateDlBtn() {
  const list = [...dls.values()];
  const busy = list.some(d => d.state === 'progressing');
  $('dlBtn').classList.toggle('busy', busy);
  if (busy) $('dlBtn').classList.remove('done');
}
function renderDownloads() {
  const list = $('plist');
  $('ptitle').textContent = 'Downloads';
  $('dlBtn').classList.remove('done');
  const items = [...dls.values()].sort((a, b) => b.id - a.id);
  if (!items.length) { list.innerHTML = '<div class="set" style="color:var(--dim)">no downloads yet</div>'; return; }
  list.innerHTML = '';
  items.forEach(d => {
    const r = document.createElement('div'); r.className = 'row'; r.style.alignItems = 'flex-start';
    const pct = d.total ? Math.round(d.received / d.total * 100) : 0;
    const status = d.state === 'completed' ? fmtB(d.total || d.received) + ' · done'
      : d.state === 'cancelled' ? 'cancelled' : d.state === 'interrupted' ? 'failed' : d.paused ? 'paused · ' + pct + '%'
      : fmtB(d.received) + (d.total ? ' / ' + fmtB(d.total) : '') + (d.speed ? ' · ' + fmtB(d.speed) + '/s' : '');
    r.innerHTML = `<span style="font-size:20px">${d.state === 'completed' ? '&#128196;' : d.state === 'progressing' ? '&#11015;' : '&#9888;'}</span>
      <div class="rt"><div></div><small>${esc(status)}</small>${d.state === 'progressing' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>
      <div style="display:flex;gap:4px;flex-direction:column">${d.state === 'completed' ? '<span class="pbtn mini" data-a="open">Open</span><span class="pbtn mini" data-a="show">Folder</span>' : d.state === 'progressing' ? `<span class="pbtn mini" data-a="${d.paused ? 'resume' : 'pause'}">${d.paused ? 'Resume' : 'Pause'}</span><span class="pbtn mini" data-a="cancel">Cancel</span>` : ''}</div>`;
    r.querySelector('.rt div').textContent = d.name;
    if (d.state === 'completed') { r.style.cursor = 'pointer'; r.title = 'Click to open ' + d.name; }
    r.onclick = (e) => {
      const a = e.target.dataset.a;
      if (a === 'open') window.aura.openFile(d.path);
      else if (a === 'show') window.aura.showFile(d.path);
      else if (a) window.aura.dlAction(d.id, a);
      else if (d.state === 'completed') window.aura.openFile(d.path); // click anywhere on the row opens it
    };
    list.appendChild(r);
  });
}
// load downloads shared from other windows / past runs so every window matches
window.aura.dlHistory().then(list => {
  (list || []).forEach(d => { if (!dls.has(d.id)) dls.set(d.id, d); });
  updateDlBtn();
  if (panelIs('downloads')) renderDownloads();
}).catch(() => {});
window.aura.on('dl', (d) => {
  const prev = dls.get(d.id);
  if (!prev && d.state === 'progressing') toast('⬇ downloading ' + d.name);
  if (prev && d.state === 'progressing') d.speed = Math.max(0, (d.received - prev.received) / Math.max(0.05, (d.time - prev.time) / 1000));
  dls.set(d.id, d);
  updateDlBtn();
  if (d.state === 'completed') $('dlBtn').classList.add('done');
  if (panelIs('downloads')) renderDownloads();
});
const panelIs = (k) => $('panel').classList.contains('show') && $('panel').dataset.kind === k;

// ---- wifi speed test ----
let speed = { running: false, res: null, live: null };
function renderSpeed() {
  const list = $('plist');
  $('ptitle').textContent = 'WiFi speed test';
  const s = speed, L = s.live || {}, R = s.res || {};
  const num = s.running ? (L.mbps != null ? L.mbps : null) : (R.down != null ? R.down : null);
  const label = s.running ? (L.phase === 'ping' ? 'checking ping...' : L.phase === 'upload' ? 'upload' : 'download') : (R.down != null ? 'download' : 'hit start');
  const f = (v, d = 1) => v == null || isNaN(v) ? '--' : v.toFixed(d);
  list.innerHTML = `<div class="big">${num == null ? '&mdash;' : f(num)} <small>Mbps</small></div>
    <div style="text-align:center;color:var(--dim);font-size:12px">${label}</div>
    ${s.running ? `<div style="padding:8px 14px"><div class="bar"><i style="width:${Math.round((L.progress || 0) * 100)}%"></i></div></div>` : ''}
    <div class="stats"><div><span>Ping</span><b>${f(s.running ? s.ping : R.ping, 0)}</b><span>ms</span></div><div><span>Download</span><b>${f(s.running ? s.down : R.down)}</b><span>Mbps</span></div><div><span>Upload</span><b>${f(s.running ? s.up : R.up)}</b><span>Mbps</span></div></div>
    ${R.jitter != null && !s.running ? `<div class="set" style="color:var(--dim);font-size:12px">Jitter ${f(R.jitter, 0)} ms · ${verdict(R.down)}</div>` : ''}
    ${s.err ? `<div class="set" style="color:#ff5e5e;font-size:12px">${esc(s.err)}</div>` : ''}
    <div class="set" style="justify-content:center"><span class="pbtn" id="spGo">${s.running ? 'Stop' : R.down != null ? 'Test again' : 'Start'}</span></div>
    <div class="set" style="color:var(--dim);font-size:11px;display:block">uses Cloudflare's speed test servers · ~50-150 MB data</div>`;
  $('spGo').onclick = () => {
    if (speed.running) { window.aura.speedStop(); return; }
    speed = { running: true, res: null, live: { phase: 'ping' }, err: null };
    window.aura.speedStart(); renderSpeed();
  };
}
function verdict(d) { return d == null ? '' : d < 5 ? 'pretty slow 💔' : d < 25 ? 'decent' : d < 100 ? 'fast 🔥' : 'crazy fast 🥶'; }
window.aura.on('speed', (d) => {
  if (d.phase === 'ping' && d.ping != null) speed.ping = d.ping;
  if (d.phase === 'download') speed.down = d.mbps;
  if (d.phase === 'upload') speed.up = d.mbps;
  if (d.phase === 'done') { speed.running = false; speed.res = d; toast('Speed: ' + d.down.toFixed(1) + ' down / ' + d.up.toFixed(1) + ' up Mbps'); }
  if (d.phase === 'error') { speed.running = false; speed.err = 'test failed: ' + d.error; }
  speed.live = d;
  if (panelIs('speed')) renderSpeed();
});

// ---- battery usage meter ----
const SAVER_LABELS = { auto: 'Auto (Saver unplugged, Ultra under 20%)', on: 'Saver always', ultra: 'Ultra always', off: 'Off (Eco only)' };
const SAVER_OPTS_FN = () => Object.entries(SAVER_LABELS).map(([k, l]) => `<option value="${k}" ${(store.settings.saver || 'auto') === k ? 'selected' : ''}>${l}</option>`).join('');
Object.defineProperty(window, 'SAVER_OPTS', { get: SAVER_OPTS_FN });
let meterT = null;
async function renderBattery() {
  const list = $('plist');
  $('ptitle').textContent = 'Battery usage';
  const keyed = tabs.map(t => ({ key: t.id, wcId: t.wv && t.ready ? t.wcId : null })).filter(x => x.wcId != null);
  if (aiWcId != null && aiOpen) keyed.push({ key: 'ai', wcId: aiWcId });
  let m;
  try { m = await window.aura.metrics(keyed); } catch { return; }
  if (!panelIs('battery')) return;
  const byKey = new Map(m.tabs.map(x => [x.key, x]));
  const energy = (c) => c < 2 ? ['Low', 'e-low'] : c < 15 ? ['Medium', 'e-med'] : ['High', 'e-high'];
  const pct = battLevel === null ? '--' : Math.round(battLevel * 100) + '%';
  let left = '';
  try { const bt = await navigator.getBattery(); if (!bt.charging && isFinite(bt.dischargingTime) && bt.dischargingTime > 0) left = Math.floor(bt.dischargingTime / 3600) + 'h ' + Math.round(bt.dischargingTime % 3600 / 60) + 'm left'; else if (bt.charging) left = 'charging'; } catch {}
  const totalCpu = m.total.cpu / m.cores;
  const [tl, tc] = energy(m.total.cpu);
  const rows = tabs.map(t => {
    const x = byKey.get(t.id);
    return { t, cpu: x ? x.cpu : 0, mem: x ? x.mem : 0, state: t.sleeping ? 'sleeping' : t.frozen ? 'frozen' : '' };
  });
  if (byKey.has('ai')) rows.push({ t: { title: (store.settings.ai || 'gemini') + ' panel', id: 'ai', url: AIS[store.settings.ai || 'gemini'] }, cpu: byKey.get('ai').cpu, mem: byKey.get('ai').mem, state: '' });
  rows.sort((a, b) => b.cpu - a.cpu);
  list.innerHTML = `<div class="stats"><div><span>Battery</span><b>${pct}</b><span>${esc(left || (onBattery ? 'on battery' : 'plugged in'))}</span></div>
      <div><span>Orchard CPU</span><b>${totalCpu.toFixed(1)}%</b><span>of your PC</span></div>
      <div><span>Energy</span><b class="${tc}">${tl}</b><span>${fmtB(m.total.mem * 1024)} RAM</span></div></div>
    <div class="set">Battery saver <select id="svr2">${SAVER_OPTS}</select></div>
    <div class="set" style="display:block;font-size:12px;color:var(--dim);line-height:1.6">${['<b style="color:var(--txt)">Eco</b> (always on): background tabs freeze after 15s, unused tabs sleep after ' + (store.settings.sleepMins || 5) + ' min, ads blocked, background timers throttled.', '<b style="color:var(--leaf)">Saver</b>: tabs freeze after 3s and sleep after 2 min, videos never autoplay and use cheaper formats (YouTube max 720p), websites told to cut animations, Orchard\'s own animations off' + (thrStat.supported && store.settings.slowApps !== false ? ', other apps in the background slowed down.' : '.'), '<b style="color:#ffb83d">Ultra</b>: everything in Saver, plus every background tab sleeps right away, YouTube drops to 480p' + (store.settings.ultraDark === false ? '' : ', pages go dark (saves power on OLED screens)') + (thrStat.supported && store.settings.slowApps !== false ? ' and background apps drop to the lowest priority.' : '.')][saverLevel()]}</div>
    ${thrStat.supported ? `<div class="set">Slow down other apps on battery <span class="pbtn" id="slowT">${store.settings.slowApps === false ? 'OFF' : 'ON'}</span></div>
    <div class="set" style="display:block;font-size:12px;color:var(--dim);line-height:1.6">${store.settings.slowApps === false ? 'Off. Other apps run at full speed.' : saverLevel() === 0 ? 'Kicks in when u unplug. Background apps get lower priority and Windows Efficiency mode, the app in front always stays full speed.' : thrStat.count ? `&#128034; Slowing <b style="color:var(--txt)">${thrStat.count}</b> background process${thrStat.count === 1 ? '' : 'es'}${saverLevel() >= 2 ? ' (Ultra: lowest priority)' : ''}. Tap one to keep it full speed:` : 'Checking ur apps…'}</div>
    ${thrStat.count && store.settings.slowApps !== false && saverLevel() > 0 ? `<div style="display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 10px" id="slowList">${thrStat.apps.slice(0, 30).map(a => `<span class="pbtn mini" data-app="${esc(a)}" title="Keep ${esc(a)} at full speed">${esc(a)} &#10005;</span>`).join('')}</div>` : ''}
    ${(store.settings.slowExclude || []).length ? `<div class="set" style="display:block;font-size:12px;color:var(--dim)">Never slowed: ${(store.settings.slowExclude || []).map(a => `<span class="pbtn mini" data-unskip="${esc(a)}" title="Let Orchard slow it again">${esc(a)} &#8635;</span>`).join(' ')}</div>` : ''}` : ''}
    <div class="set">Cheaper videos on battery <span class="pbtn" id="cvT">${store.settings.cheapVideo === false ? 'OFF' : 'ON'}</span></div>
    <div class="set" style="display:block;font-size:12px;color:var(--dim);line-height:1.6;padding-top:0">Sites send the H.264 video format ur graphics chip plays cheaply, and YouTube is capped at 720p (480p in Ultra). Reload a video tab for it to kick in.</div>
    <div class="set">Cap tab frame rate on battery <span class="pbtn" id="fpsT">${store.settings.capFps === false ? 'OFF' : 'ON'}</span></div>
    <div class="set" style="display:block;font-size:12px;color:var(--dim);line-height:1.6;padding-top:0">Slows animations and game loops to 30fps in Saver, 20fps in Ultra, so pages draw less. Video keeps playing normally.</div>
    <div class="set">Auto dark pages in Ultra <span class="pbtn" id="udk">${store.settings.ultraDark === false ? 'OFF' : 'ON'}</span></div>
    <div class="set" style="display:block;font-size:12px;color:var(--dim);line-height:1.6;padding-top:0">Off: Ultra won't force pages dark. The "Dark pages always" switch below still works.</div>
    <div class="set">Dark pages always <span class="pbtn" id="dkp">${store.settings.darkPages ? 'ON' : 'OFF'}</span></div>
    <div class="set">Rest all other tabs now <span class="pbtn" id="restNow">&#128164; Rest</span></div>
    <div style="padding:2px 12px 4px;font-size:11px;color:var(--dim)">PER TAB</div>`;
  rows.forEach(({ t, cpu, mem, state }) => {
    const [el, ec] = state ? ['Zero', 'e-low'] : energy(cpu);
    const r = document.createElement('div'); r.className = 'row';
    r.innerHTML = `<img src="${fav(t.url)}" width=16 height=16 onerror="this.style.visibility='hidden'"><div class="rt"><div></div><small>${state ? state + ' · saving battery' : cpu.toFixed(1) + '% CPU · ' + fmtB(mem * 1024)}</small></div><b class="${ec}" style="font-size:12px">${el}</b>${!state && t !== active && t.id !== 'ai' ? '<span class="pbtn mini" data-a="sleep">Sleep</span>' : ''}`;
    r.querySelector('.rt div').textContent = t.locked && !t.unlocked ? 'Locked tab' : isNewtab(t.url) ? 'New Tab' : (t.title || t.url);
    r.onclick = (e) => { if (e.target.dataset.a === 'sleep') { sleepTab(t); renderBattery(); } else if (t.id !== 'ai') { activate(t); } };
    list.appendChild(r);
  });
  $('svr2').onchange = (e) => { store.settings.saver = e.target.value; save(); applySaver(); renderBattery(); };
  $('dkp').onclick = () => { store.settings.darkPages = !store.settings.darkPages; save(); applySaver(); renderBattery(); };
  $('cvT').onclick = () => { store.settings.cheapVideo = store.settings.cheapVideo === false; save(); syncThrottle(); toast(store.settings.cheapVideo === false ? 'videos back to full quality' : 'cheaper videos on battery 🎬'); renderBattery(); };
  $('fpsT').onclick = () => { store.settings.capFps = store.settings.capFps === false; save(); applyFps(); toast(store.settings.capFps === false ? 'tab frame rate uncapped' : 'tab frame rate capped on battery 🎞️'); renderBattery(); };
  $('udk').onclick = () => { store.settings.ultraDark = store.settings.ultraDark === false; save(); tabs.forEach(emulateFor); toast(store.settings.ultraDark === false ? 'Ultra wont force dark pages now' : 'Ultra auto dark on 🌙'); renderBattery(); };
  if ($('slowT')) $('slowT').onclick = () => { store.settings.slowApps = store.settings.slowApps === false; save(); syncThrottle(); toast(store.settings.slowApps === false ? 'other apps back to full speed' : 'other apps get slowed when ur on battery 🐢'); renderBattery(); };
  list.querySelectorAll('[data-app]').forEach(b => b.onclick = () => { const a = b.dataset.app.toLowerCase(); store.settings.slowExclude = [...new Set((store.settings.slowExclude || []).concat(a))]; save(); syncThrottle(); toast(b.dataset.app + ' stays full speed now'); renderBattery(); });
  list.querySelectorAll('[data-unskip]').forEach(b => b.onclick = () => { store.settings.slowExclude = (store.settings.slowExclude || []).filter(x => x !== b.dataset.unskip); save(); syncThrottle(); renderBattery(); });
  $('restNow').onclick = () => { let n = 0; tabs.forEach(t => { if (!isShown(t) && !t.sleeping) { sleepTab(t); if (t.sleeping) n++; } }); toast(n + ' tab(s) resting 💤'); renderBattery(); };
}

// ---- google lens ----
let lensShot = null, lensDrag = null;
async function startLens() {
  if (active && active.locked && !active.unlocked && lockReady()) { toast('unlock the tab first 🔒'); return; }
  if (!active || !active.wv || !active.ready || isNewtab(active.url) || !/^https?:|^file:/.test(active.url)) { createTab('https://lens.google.com/'); toast('Google Lens opened, upload or paste a pic 🔍'); return; }
  $('panel').classList.remove('show'); closeFind();
  await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
  const b = active.wv.getBoundingClientRect();
  lensShot = await window.aura.capture({ x: b.left, y: b.top, width: b.width, height: b.height });
  if (!lensShot) { toast('couldnt screenshot this page 💔'); return; }
  $('lensImg').src = lensShot;
  $('lensSel').style.display = 'none';
  $('lens').classList.add('show');
}
function endLens() { $('lens').classList.remove('show'); lensDrag = null; }
async function sendLens(rect) {
  const img = new Image();
  img.src = lensShot;
  await img.decode();
  const box = $('lens').getBoundingClientRect();
  const sx = img.naturalWidth / box.width, sy = img.naturalHeight / box.height;
  const c = document.createElement('canvas');
  const r = rect || { x: 0, y: 0, w: box.width, h: box.height };
  c.width = Math.max(1, Math.round(r.w * sx)); c.height = Math.max(1, Math.round(r.h * sy));
  c.getContext('2d').drawImage(img, r.x * sx, r.y * sy, r.w * sx, r.h * sy, 0, 0, c.width, c.height);
  const data = c.toDataURL('image/png');
  endLens();
  const t = createTab('about:blank');
  t.title = 'Google Lens'; renderTab(t);
  const go = async () => { await window.aura.lens(t.wcId, data); };
  if (t.ready && t.wcId != null) go(); else t.wv.addEventListener('dom-ready', () => { if (!t.lensSent) { t.lensSent = true; go(); } });
  toast('searching with Lens... screenshot also copied, Ctrl+V works too');
}
$('lens').addEventListener('mousedown', (e) => {
  if (e.target.closest('#lensBar')) return;
  const b = $('lens').getBoundingClientRect();
  lensDrag = { x0: e.clientX - b.left, y0: e.clientY - b.top };
});
$('lens').addEventListener('mousemove', (e) => {
  if (!lensDrag) return;
  const b = $('lens').getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - b.left, b.width)), y = Math.max(0, Math.min(e.clientY - b.top, b.height));
  const r = { x: Math.min(x, lensDrag.x0), y: Math.min(y, lensDrag.y0), w: Math.abs(x - lensDrag.x0), h: Math.abs(y - lensDrag.y0) };
  lensDrag.r = r;
  Object.assign($('lensSel').style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', backgroundImage: `url(${lensShot})`, backgroundSize: b.width + 'px ' + b.height + 'px', backgroundPosition: -r.x + 'px ' + -r.y + 'px' });
});
$('lens').addEventListener('mouseup', () => {
  if (!lensDrag) return;
  const r = lensDrag.r; lensDrag = null;
  if (r && r.w > 12 && r.h > 12) sendLens(r);
  else $('lensSel').style.display = 'none';
});
$('lensAll').onclick = () => sendLens(null);
$('lensX').onclick = endLens;
$('lensBtn').onclick = startLens;
$('hideBtn').onclick = (e) => { if (e.shiftKey || picking) openPanel('hides'); else if (hideRulesFor(active && active.url).length && !e.altKey) openPanel('hides'); else startHidePicker(); };

// ---- backgrounds ----
const BG_PRESETS = {
  aura: 'radial-gradient(ellipse at 18% 12%,#5a1712 0%,transparent 55%),radial-gradient(ellipse at 88% 92%,#21451a 0%,transparent 50%),#120c0b',
  sunset: 'linear-gradient(160deg,#2b0f3a 0%,#7a1f4b 45%,#e0603a 100%)',
  ocean: 'linear-gradient(160deg,#021b2e 0%,#04476b 55%,#0aa1a8 100%)',
  forest: 'linear-gradient(160deg,#07140c 0%,#11402a 60%,#3d7a3a 100%)',
  candy: 'linear-gradient(135deg,#ff7eb3 0%,#a46bff 50%,#4fd1ff 100%)',
  orchard: 'linear-gradient(170deg,#7fb34a 0%,#3d6b2a 45%,#1d2e14 100%)',
  honeycrisp: 'linear-gradient(160deg,#ffcf5a 0%,#f2752e 50%,#b8211a 100%)',
  midnight: 'linear-gradient(180deg,#000 0%,#0b0b12 60%,#16163a 100%)',
  lava: 'radial-gradient(ellipse at 50% 120%,#ff4d00 0%,#7a0b0b 45%,#120404 80%)',
  mint: 'linear-gradient(135deg,#0f2027 0%,#2c5364 50%,#6dffb0 130%)',
  black: '#000000'
};
function setBg(bg) {
  store.settings.bg = bg; save();
  tabs.forEach(t => { if (t.wv && isNewtab(t.url)) t.wv.loadURL(newtabSrc()).catch(() => {}); });
  if (panelIs('theme')) renderTheme();
}
function renderTheme() {
  const list = $('plist');
  $('ptitle').textContent = 'Backgrounds';
  const cur = store.settings.bg || { type: 'preset', value: 'aura' };
  const custom = store.customBgs || [];
  const sw = (style, sel, attrs) => `<span ${attrs} style="width:52px;height:36px;border-radius:9px;cursor:pointer;background:${style};background-size:cover;background-position:center;border:2px solid ${sel ? '#fff' : '#ffffff22'};flex:none;position:relative"></span>`;
  list.innerHTML = `<div style="padding:4px 12px;font-size:11px;color:var(--dim)">PRESETS</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;padding:6px 12px">${Object.entries(BG_PRESETS).map(([k, v]) => sw(v, cur.type === 'preset' && cur.value === k, `data-p="${k}" title="${k}"`)).join('')}</div>
    <div class="set">Solid colour <input type="color" id="bgCol" value="${cur.type === 'color' ? esc(cur.value) : '#1a1030'}" style="width:52px;height:30px;border:0;background:none;cursor:pointer"></div>
    <div class="set">Gradient <span style="display:flex;gap:6px;align-items:center"><input type="color" id="g1" value="${cur.type === 'gradient' ? esc(cur.value[0]) : '#ffb83d'}" style="width:36px;height:28px;border:0;background:none"><input type="color" id="g2" value="${cur.type === 'gradient' ? esc(cur.value[1]) : '#e8432e'}" style="width:36px;height:28px;border:0;background:none"><span class="pbtn mini" id="gGo">Use</span></span></div>
    <div style="padding:8px 12px 4px;font-size:11px;color:var(--dim);display:flex;justify-content:space-between;align-items:center">YOUR IMAGES <span class="pbtn mini" id="bgImp">+ Import</span></div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;padding:6px 12px 10px">${custom.length ? custom.map((u, i) => sw(`url('${esc(u)}')`, cur.type === 'image' && cur.value === u, `data-i="${i}" title="click to use, right click to delete"`)).join('') : '<span style="color:var(--dim);font-size:12px">import ur own pics, png jpg webp gif</span>'}</div>
    <div class="set">Dim image <input type="range" id="bgDim" min="0" max="80" value="${store.settings.bgDim ?? 35}"></div>`;
  list.querySelectorAll('[data-p]').forEach(el => el.onclick = () => setBg({ type: 'preset', value: el.dataset.p }));
  list.querySelectorAll('[data-i]').forEach(el => {
    const u = custom[+el.dataset.i];
    el.onclick = () => setBg({ type: 'image', value: u, dim: store.settings.bgDim ?? 35 });
    el.oncontextmenu = (e) => {
      e.preventDefault();
      store.customBgs = custom.filter(x => x !== u);
      window.aura.bgDelete(u);
      if (cur.type === 'image' && cur.value === u) setBg({ type: 'preset', value: 'aura' }); else { save(); renderTheme(); }
    };
  });
  $('bgCol').onchange = (e) => setBg({ type: 'color', value: e.target.value });
  $('gGo').onclick = () => setBg({ type: 'gradient', value: [$('g1').value, $('g2').value] });
  $('bgDim').onchange = (e) => { store.settings.bgDim = +e.target.value; const b = store.settings.bg; if (b && b.type === 'image') setBg({ ...b, dim: +e.target.value }); else save(); };
  $('bgImp').onclick = async () => {
    const urls = await window.aura.bgImport();
    if (!urls.length) return;
    store.customBgs = [...urls, ...(store.customBgs || [])].slice(0, 12);
    setBg({ type: 'image', value: urls[0], dim: store.settings.bgDim ?? 35 });
    toast('background imported 🔥');
  };
}

// ---- profiles ----
const PCOLORS = ['#e8432e', '#ffb83d', '#6cc35a', '#c0447a', '#f2752e', '#8a5a3c', '#4fa3d1', '#e4e45e'];
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function applyProfile(p) {
  if (!p) return;
  store.profile = p;
  const guest = !!p.guest;
  document.body.classList.toggle('guestmode', guest);
  if (!guest) document.documentElement.style.setProperty('--acc', p.color);
  $('avatar').textContent = guest ? '\uD83D\uDD76' : (p.name || '?')[0].toUpperCase();
  $('avatar').title = guest ? 'Guest window — nothing is saved' : 'Profile: ' + p.name + (p.email ? '\n' + p.email : '\nnot signed in to Google');
  const chip = $('guestChip'); if (chip) chip.hidden = !guest;
  document.title = (guest ? 'Guest — Orchard' : 'Orchard - ' + p.name);
}
async function renderProfiles(editing) {
  const list = $('plist'), me = store.profile || { id: 'default' };
  const ps = await window.aura.profiles();
  $('ptitle').textContent = 'Profiles';
  list.innerHTML = '';
  ps.forEach(p => {
    const r = document.createElement('div');
    r.className = 'row' + (p.id === me.id ? ' cur' : '');
    r.innerHTML = `<div class="av" style="background:${esc(p.color)}">${esc((p.name || '?')[0].toUpperCase())}</div><div class="rt"><div>${esc(p.name)}</div><small>${p.email ? esc(p.email) + ' · ' : ''}${p.id === me.id ? 'this window' : 'click to open'}</small></div><span class="del" data-a="edit" title="Edit">&#9998;</span>${p.id !== 'default' ? '<span class="del" data-a="del" title="Delete">&#128465;</span>' : ''}`;
    r.onclick = async (e) => {
      const a = e.target.dataset.a;
      if (a === 'edit') return profileForm(p);
      if (a === 'del') {
        if (!confirm('Delete profile "' + p.name + '"? Its bookmarks, history, cookies and logins get wiped for good.')) return;
        await window.aura.deleteProfile(p.id); toast('Profile deleted 💔'); renderProfiles(); return;
      }
      if (p.id !== me.id) { window.aura.openProfile(p.id); $('panel').classList.remove('show'); }
    };
    list.appendChild(r);
  });
  const add = document.createElement('div');
  add.className = 'row';
  add.innerHTML = '<div class="av" style="background:#2e2e48;color:var(--txt)">+</div><div class="rt"><div>Add profile</div><small>separate logins, bookmarks and history</small></div>';
  add.onclick = () => profileForm(null);
  list.appendChild(add);
  if (!(store.profile && store.profile.guest)) {
    const g = document.createElement('div'); g.className = 'row';
    g.innerHTML = '<div class="av" style="background:#2a2230;color:#cfcfe6">\uD83D\uDD76</div><div class="rt"><div>Guest window</div><small>nothing saved, like incognito</small></div>';
    g.onclick = () => { window.aura.openGuest(); $('panel').classList.remove('show'); };
    list.appendChild(g);
  }
  const nw = document.createElement('div');
  nw.className = 'set';
  nw.innerHTML = '<span style="color:var(--dim)">New window (Ctrl+N)</span><span class="pbtn" id="nwBtn">Open</span>';
  list.appendChild(nw);
  $('nwBtn').onclick = () => window.aura.newWindow();
}
function profileForm(p) {
  const list = $('plist');
  let color = p ? p.color : PCOLORS[Math.floor(Math.random() * PCOLORS.length)];
  $('ptitle').textContent = p ? 'Edit profile' : 'New profile';
  list.innerHTML = `<div class="set" style="display:block"><input class="pin" id="pname" maxlength="24" placeholder="Name" value="${p ? esc(p.name) : ''}"></div>
    <div class="set"><div class="colors" id="pcol">${PCOLORS.map(c => `<span data-c="${c}" style="background:${c}" class="${c === color ? 'sel' : ''}"></span>`).join('')}</div></div>
    <div class="set"><span class="pbtn" id="pcancel">Back</span><span class="pbtn" id="psave">${p ? 'Save' : 'Create'}</span></div>`;
  $('pcol').onclick = (e) => { const c = e.target.dataset.c; if (!c) return; color = c; [...$('pcol').children].forEach(s => s.classList.toggle('sel', s.dataset.c === c)); };
  $('pcancel').onclick = () => renderProfiles();
  const go = async () => {
    const name = $('pname').value.trim();
    if (!name) { $('pname').focus(); return; }
    if (p) { await window.aura.editProfile(p.id, name, color); renderProfiles(); }
    else { await window.aura.addProfile(name, color); $('panel').classList.remove('show'); toast('Profile created, it opened in a new window 🔥'); }
  };
  $('psave').onclick = go;
  $('pname').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  $('pname').focus();
}

// ---- AI side panel (Gemini / ChatGPT / Claude) ----
const AIS = { gemini: 'https://gemini.google.com/app', chatgpt: 'https://chatgpt.com/', claude: 'https://claude.ai/new', chat: 'https://claude.ai/artifact/28878hcboZzAuyHNtgbMAQ', gchat: 'https://chat.google.com/' };
let aiWhich = null;
let aiWv = null, aiOpen = false, aiWcId = null;
function sideWidth(w) {
  w = Math.max(320, Math.min(w, window.innerWidth - 360));
  store.settings.sideW = w;
  document.documentElement.style.setProperty('--sw', aiOpen ? w + 'px' : '0px');
}
function loadAi(which) {
  aiWhich = which; $('aiPick').value = which; setTimeout(markSideBtns);
  $('askPage').parentElement.hidden = which === 'chat' || which === 'mail' || which === 'gchat';
  if (which === 'mail') { $('mailPane').hidden = false; if (aiWv) { aiWv.remove(); aiWv = null; aiWcId = null; } placeChat(); mailShow(); return; }
  $('mailPane').hidden = true;
  if (which === 'chat') { if (aiWv) { aiWv.remove(); aiWv = null; aiWcId = null; } ensureChat(); placeChat(); return; }
  if (aiWv) aiWv.remove();
  aiWv = document.createElement('webview');
  if (store.partition) aiWv.setAttribute('partition', store.partition);
  aiWv.setAttribute('allowpopups', '');
  aiWv.setAttribute('src', AIS[which] || AIS.gemini);
  aiWv.addEventListener('dom-ready', () => { try { aiWcId = aiWv.getWebContentsId(); } catch {} });
  $('sbody').appendChild(aiWv);
}
function markSideBtns() {
  $('aiBtn').classList.toggle('on', aiOpen && !['chat', 'mail', 'gchat'].includes(aiWhich));
  $('chatBtn').classList.toggle('on', aiOpen && aiWhich === 'gchat');
  $('mailBtn').classList.toggle('on', aiOpen && aiWhich === 'mail');
  document.querySelectorAll('#aipills span').forEach(s => s.classList.toggle('on', s.dataset.ai === aiWhich));
  $('aipills').classList.toggle('off', ['chat', 'mail', 'gchat'].includes(aiWhich));
}
function toggleAi(force) {
  aiOpen = force === undefined ? !aiOpen : force;
  $('side').classList.toggle('show', aiOpen);
  markSideBtns();
  sideWidth(store.settings.sideW || 420);
  if (aiOpen && (aiWhich === 'mail' || aiWhich === 'chat' || aiWhich === 'gchat')) loadAi(aiWhich);
  else if (aiOpen && !aiWv) loadAi(store.settings.ai && !['mail', 'chat', 'gchat'].includes(store.settings.ai) ? store.settings.ai : 'gemini');
  // freeze the ai panel while it's closed so it doesnt eat battery
  if (aiWcId != null) window.aura.freeze(aiWcId, !aiOpen);
  placeChat();
  if (aiOpen) setTimeout(() => aiWv && aiWv.focus(), 100);
}
async function askAboutPage(mode) {
  if (active && active.locked && !active.unlocked && lockReady()) { toast('unlock the tab first 🔒'); return; }
  if (!active || !active.wv || !active.ready || isNewtab(active.url)) { toast('open a real page first bro 🫩'); return; }
  let info = { sel: '', text: '' };
  const limit = mode === 'answer' ? 14000 : 6000;
  try {
    info = await active.wv.executeJavaScript(`({ sel: String(getSelection()), text: (document.body && document.body.innerText || '').replace(/[ \\t]+/g,' ').replace(/\\n{3,}/g,'\\n\\n').slice(0, ${limit}) })`);
  } catch {}
  const sel = info.sel.trim();
  let prompt;
  if (mode === 'answeronly') {
    prompt = `Answer the questions ${sel ? 'below' : 'on this page'}. Give ONLY the answers, numbered, nothing else. No working, no explanations, no extra words.\nTitle: ${active.title}\nURL: ${active.url}\n\n${sel ? 'Questions:\n' + sel.slice(0, 8000) : 'Page text:\n' + info.text}`;
  } else if (mode === 'answer') {
    prompt = `Answer the questions ${sel ? 'below' : 'on this page'} quickly. For each one, give the answer and a one-line reason, nothing more. Keep it short.\nTitle: ${active.title}\nURL: ${active.url}\n\n${sel ? 'Questions:\n' + sel.slice(0, 8000) : 'Page text:\n' + info.text}`;
  } else if (mode === 'explain' || mode === 'summary' || (!mode && sel)) {
    prompt = sel
      ? `Explain this to me simply, like I'm a student:\n\n"${sel.slice(0, 4000)}"\n\n(from "${active.title}", ${active.url})`
      : `Explain this page/question to me simply, like I'm a student, so I actually get it.\nTitle: ${active.title}\nURL: ${active.url}\n\nPage text:\n${info.text}`;
  }
  if (aiWhich === 'chat' || aiWhich === 'mail' || aiWhich === 'gchat') { aiWhich = store.settings.ai && !['chat','mail','gchat'].includes(store.settings.ai) ? store.settings.ai : 'gemini'; if (aiOpen) loadAi(aiWhich); }
  if (!aiOpen) toggleAi(true);
  if (!aiWv) loadAi(aiWhich || 'gemini');
  const fill = () => aiWv.executeJavaScript(`(() => {
    const el = document.querySelector('rich-textarea .ql-editor, div[contenteditable="true"], textarea');
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA') { el.value = ${JSON.stringify(prompt)}; el.dispatchEvent(new Event('input', { bubbles: true })); }
    else document.execCommand('insertText', false, ${JSON.stringify(prompt)});
    return true;
  })()`).catch(() => false);
  let ok = false;
  for (let i = 0; i < 10 && !ok; i++) { ok = await fill(); if (!ok) await new Promise(r => setTimeout(r, 700)); }
  if (ok) toast('page sent to the AI box, hit enter 🔥');
  else { try { await navigator.clipboard.writeText(prompt); } catch {} toast('couldnt reach the box, copied it so just paste ✌️'); }
}

function toggleAdblock() {
  store.settings.adblock = !store.settings.adblock; save();
  $('shield').classList.toggle('off', !store.settings.adblock);
  if (!store.settings.adblock) $('shield').innerHTML = '&#128737; off';
  else $('shield').innerHTML = '&#128737; ' + blocked + ' blocked';
}
let blocked = 0;

// find
function openFind() { $('find').classList.add('show'); $('findIn').focus(); $('findIn').select(); }
function closeFind() { $('find').classList.remove('show'); try { active && active.wv && active.ready && active.wv.stopFindInPage('clearSelection'); } catch {} }

let toastT;
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }

function zoom(d) {
  if (!active || !active.ready) return;
  let z = d === 0 ? 1 : Math.min(3, Math.max(0.3, active.wv.getZoomFactor() + d));
  active.wv.setZoomFactor(z); updateNav();
}

function handleKey(k, ctrl, shift, alt) {
  if (ctrl && k === 't') { if (shift) { const u = closed.pop(); if (u) createTab(u); } else createTab(); }
  else if (ctrl && k === 'w') active && closeTab(active);
  else if (ctrl && k === 'n') { if (shift) window.aura.openGuest(); else window.aura.newWindow(); }
  else if (alt && k === 'g') toggleAi();
  else if (alt && k === 'c') openGoogleChat();
  else if (alt && k === 'f') openPanel('menu');
  else if (alt && k === 'h') startHidePicker();
  else if (alt && k === 'm') openMail();
  else if (alt && k === 'k') openPanel('calc');
  else if (alt && k === 'e') openCalendar();
  else if (ctrl && k === 'j') openPanel('downloads');
  else if (k === 'escape' && $('lens').classList.contains('show')) endLens();
  else if (ctrl && k === 'l') { $('url').focus(); $('url').select(); }
  else if ((ctrl && k === 'r') || k === 'f5') active && active.wv.reload();
  else if (ctrl && k === 'd') toggleBookmark();
  else if (ctrl && k === 'h') openPanel('history');
  else if (ctrl && k === 'f') openFind();
  else if (ctrl && k === 'tab') { const i = tabs.indexOf(active); activate(tabs[(i + (shift ? -1 : 1) + tabs.length) % tabs.length]); }
  else if (ctrl && (k === '=' || k === '+')) zoom(0.1);
  else if (ctrl && k === '-') zoom(-0.1);
  else if (ctrl && k === '0') zoom(0);
  else if (k === 'f11') window.aura.win('full');
  else if (k === 'f12') active && active.wv.openDevTools();
  else if (alt && k === 'arrowleft') active && active.wv.canGoBack() && active.wv.goBack();
  else if (alt && k === 'arrowright') active && active.wv.canGoForward() && active.wv.goForward();
  else return false;
  return true;
}

// wiring
$('newtab').onclick = () => createTab();
$('back').onclick = () => active.wv.goBack();
$('fwd').onclick = () => active.wv.goForward();
$('reload').onclick = () => active.wv.reload();
$('home').onclick = () => active.wv.loadURL(newtabSrc());
$('star').onclick = toggleBookmark;
$('shield').onclick = toggleAdblock;
$('batt').onclick = () => openPanel('battery');
$('dlBtn').onclick = () => openPanel('downloads');
$('speedBtn').onclick = () => openPanel('speed');
$('histBtn').onclick = () => openPanel('history');
$('setBtn').onclick = () => openSettings();
$('calcBtn').onclick = () => openPanel('calc');
$('calBtn').onclick = () => { if (pageKind === 'calendar') closePage(); else openCalendar(); };
$('extBtn').onclick = (e) => extMenu(e);
$('opX').onclick = closePage;
document.querySelectorAll('#aipills span').forEach(s => s.onclick = () => { store.settings.ai = s.dataset.ai; save(); aiWcId = null; loadAi(s.dataset.ai); });
$('avatar').onclick = () => openPanel('profiles');
$('aiBtn').onclick = () => { if (aiOpen && (aiWhich === 'chat' || aiWhich === 'mail' || aiWhich === 'gchat')) { aiWcId = null; loadAi(store.settings.ai && !['chat','mail','gchat'].includes(store.settings.ai) ? store.settings.ai : 'gemini'); } else toggleAi(); };
const openChat = () => {
  if (aiOpen && aiWhich === 'chat') { toggleAi(false); return; }
  aiWhich = 'chat';
  if (!aiOpen) toggleAi(true); else loadAi('chat');
};
// the 💬 button now opens Google Chat (Orchard Chat stays in the ☰ menu)
const openGoogleChat = () => {
  if (aiOpen && aiWhich === 'gchat') { toggleAi(false); return; }
  aiWhich = 'gchat';
  if (!aiOpen) toggleAi(true); else loadAi('gchat');
};
$('chatBtn').onclick = openGoogleChat;
const openMail = () => {
  if (aiOpen && aiWhich === 'mail') { toggleAi(false); return; }
  aiWhich = 'mail';
  if (!aiOpen) toggleAi(true); else loadAi('mail');
};
$('mailBtn').onclick = openMail;
$('menuBtn').onclick = () => openPanel('menu');
$('updPill').onclick = () => { saveSession(true); window.aura.restartUpdate(); };
// middle click empty tab bar = new tab, double click empty = maximize
$('tabs').addEventListener('mousedown', (e) => { if (e.button === 1 && (e.target.id === 'tabs')) { e.preventDefault(); createTab(); } });
$('tabs').addEventListener('auxclick', (e) => { if (e.button === 1 && e.target.id === 'newtab') { e.preventDefault(); createTab(); } });
$('sideX').onclick = () => toggleAi(false);
$('askPage').onclick = () => askAboutPage('answer');
$('askMore').onclick = async (e) => {
  let hasSel = false;
  try { hasSel = !!(active && active.wv && active.ready && (await active.wv.executeJavaScript('String(getSelection()).trim().length')) > 0); } catch {}
  showMenu(e, [
    ['&#9889; Answer quickly' + (hasSel ? ' (highlighted)' : ''), () => askAboutPage('answer')],
    ['&#9989; Answer only (just the answers)' + (hasSel ? ' (highlighted)' : ''), () => askAboutPage('answeronly')],
    ['&#128161; Explain this page/question', () => askAboutPage('summary')],
    hasSel ? ['&#128161; Explain the highlighted bit', () => askAboutPage('explain')] : null
  ]);
};
$('aiPick').onchange = (e) => { if (!['chat', 'mail', 'gchat'].includes(e.target.value)) { store.settings.ai = e.target.value; save(); } aiWcId = null; loadAi(e.target.value); };
$('sgrip').onmousedown = (e) => {
  e.preventDefault(); document.body.classList.add('dragging');
  const mv = (ev) => sideWidth(window.innerWidth - ev.clientX);
  const up = () => { document.body.classList.remove('dragging'); removeEventListener('mousemove', mv); removeEventListener('mouseup', up); save(); };
  addEventListener('mousemove', mv); addEventListener('mouseup', up);
};
$('pclose').onclick = () => $('panel').classList.remove('show');
$('mn').onclick = () => window.aura.win('min');
$('mx').onclick = () => window.aura.win('max');
$('cl').onclick = () => window.aura.win('close');
$('top').ondblclick = (e) => { if (e.target.id === 'top' || e.target.id === 'tabs') window.aura.win('max'); };
// ---- omnibox: history, bookmarks and live search suggestions as u type ----
let omniItems = [], omniSel = 0, omniSeq = 0, omniTyped = '';
const searchQueryOf = (u) => {
  try {
    const x = new URL(u);
    if (/(^|\.)google\.[a-z.]+$/.test(x.hostname) && x.pathname === '/search') return x.searchParams.get('q');
    if (/duckduckgo\.com$/.test(x.hostname)) return x.searchParams.get('q');
    if (/bing\.com$/.test(x.hostname) && x.pathname === '/search') return x.searchParams.get('q');
    if (/search\.brave\.com$/.test(x.hostname)) return x.searchParams.get('q');
  } catch {}
  return null;
};
function historyStats() {
  // one entry per url: visit count + latest time
  const m = new Map();
  for (const h of store.history) {
    if (!h.url || isNewtab(h.url)) continue;
    const e = m.get(h.url);
    if (e) { e.n++; if (h.time > e.time) e.time = h.time; }
    else m.set(h.url, { url: h.url, title: h.title || h.url, time: h.time || 0, n: 1 });
  }
  return [...m.values()];
}
function localMatches(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const now = Date.now(), out = [], seenSearch = new Set();
  const score = (e) => e.n * 3 + Math.max(0, 20 - (now - e.time) / 864e5);
  const hits = (s) => words.every(w => s.includes(w));
  for (const e of historyStats()) {
    const sq = searchQueryOf(e.url);
    if (sq) {
      const k = sq.toLowerCase();
      if (seenSearch.has(k) || (words.length && !hits(k))) continue;
      seenSearch.add(k);
      out.push({ kind: 'past', text: sq, sub: 'u searched this', go: sq, s: score(e) + 5 });
      continue;
    }
    const hay = (e.title + ' ' + e.url).toLowerCase();
    if (words.length && !hits(hay)) continue;
    const starts = words.length && e.url.replace(/^https?:\/\/(www\.)?/, '').toLowerCase().startsWith(words[0]);
    out.push({ kind: 'hist', text: e.title, sub: e.url, go: e.url, url: e.url, s: score(e) + (starts ? 30 : 0) });
  }
  for (const b of store.bookmarks) {
    const hay = (b.title + ' ' + b.url).toLowerCase();
    if (words.length && hits(hay)) out.push({ kind: 'bm', text: b.title, sub: b.url, go: b.url, url: b.url, s: 25 });
  }
  const best = new Map();
  out.forEach(o => { const k = o.kind === 'past' ? 'q:' + o.text.toLowerCase() : o.go; if (!best.has(k) || best.get(k).s < o.s) best.set(k, o); });
  return [...best.values()].sort((a, b) => b.s - a.s);
}
function omniRender() {
  const box = $('omni');
  if (!omniItems.length) { box.hidden = true; return; }
  const ICON = { search: '&#128269;', sugg: '&#128269;', past: '&#128339;', hist: '', bm: '&#11088;', url: '&#127760;' };
  box.innerHTML = '';
  omniItems.forEach((it, i) => {
    const d = document.createElement('div');
    d.className = 'oi' + (i === omniSel ? ' sel' : '');
    const ic = it.kind === 'hist' ? `<img src="${fav(it.url)}" onerror="this.replaceWith(document.createTextNode('\u{1F310}'))">` : ICON[it.kind];
    d.innerHTML = `<span class="oic">${ic}</span><span class="ot"></span><span class="os"></span>${it.kind === 'hist' || it.kind === 'past' ? '<span class="ox" title="Remove from history">&#10005;</span>' : ''}`;
    d.querySelector('.ot').textContent = it.text;
    d.querySelector('.os').textContent = it.sub ? (it.kind === 'hist' || it.kind === 'bm' ? ' — ' : ' · ') + it.sub : '';
    d.onmousedown = (e) => {
      e.preventDefault();
      if (e.target.classList.contains('ox')) { forget(it); return; }
      omniGo(it, e.button === 1 || e.ctrlKey);
    };
    d.onmouseenter = () => { omniSel = i; [...box.children].forEach((c, j) => c.classList.toggle('sel', j === i)); };
    box.appendChild(d);
  });
  const r = $('urlwrap').getBoundingClientRect();
  Object.assign(box.style, { left: r.left + 'px', top: (r.bottom + 4) + 'px', width: r.width + 'px' });
  box.hidden = false;
}
function forget(it) {
  if (it.kind === 'past') store.history = store.history.filter(h => (searchQueryOf(h.url) || '').toLowerCase() !== it.text.toLowerCase());
  else store.history = store.history.filter(h => h.url !== it.url);
  save(); toast('removed from history'); omniUpdate(true);
}
function omniClose() { $('omni').hidden = true; omniItems = []; }
function omniGo(it, newTab) {
  omniClose();
  $('url').blur();
  if (newTab) { const u = toUrl(it.go); if (u) createTab(u, true); return; }
  go(it.go);
}
// links (history + bookmarks) go first, like Chrome; the best site match is picked by default when what u typed starts its address
let omniDefaultLink = false;
function omniAssemble(trimmed, sugg) {
  const local = localMatches(trimmed);
  const links = local.filter(i => i.kind === 'hist' || i.kind === 'bm').slice(0, trimmed ? 4 : 8);
  const past = local.filter(i => i.kind === 'past').slice(0, trimmed ? 2 : 3);
  const base = [];
  if (trimmed) {
    const asUrl = toUrl(trimmed), isUrl = asUrl && !asUrl.startsWith(ENGINES[store.settings.engine || 'google']);
    if (isUrl) base.push({ kind: 'url', text: trimmed, sub: 'open site', go: trimmed });
    base.push({ kind: 'search', text: trimmed, sub: 'search ' + (store.settings.engine || 'google'), go: trimmed.startsWith('?') ? trimmed.slice(1) : trimmed });
  }
  const have = new Set(base.concat(past).map(i => i.text.toLowerCase()));
  const extra = (sugg || []).filter(s => s && !have.has(s.toLowerCase())).slice(0, 5).map(s => ({ kind: 'sugg', text: s, sub: '', go: s }));
  const items = links.concat(base, past, extra);
  const t = trimmed.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
  const strong = links.length && t.length >= 2 && links[0].url.replace(/^https?:\/\/(www\.)?/, '').toLowerCase().startsWith(t);
  return { items, def: strong ? 0 : (trimmed ? links.length : 0), strong };
}
async function omniUpdate(keepSel) {
  const q = $('url').value, seq = ++omniSeq, trimmed = q.trim();
  let a = omniAssemble(trimmed, []);
  omniItems = a.items; omniDefaultLink = a.strong;
  if (!keepSel) omniSel = a.def;
  omniRender();
  if (!trimmed || store.settings.suggest === false || /^[a-z]+:\/\//i.test(trimmed)) return;
  // live suggestions from the search engine (fetched by the main process)
  const sugg = await window.aura.suggest(store.settings.engine || 'google', trimmed).catch(() => []);
  if (seq !== omniSeq || document.activeElement !== $('url')) return;
  const prevSel = omniItems[omniSel];
  a = omniAssemble(trimmed, sugg);
  omniItems = a.items; omniDefaultLink = a.strong;
  const keep = prevSel ? omniItems.findIndex(i => i.kind === prevSel.kind && i.text === prevSel.text) : -1;
  omniSel = keep >= 0 ? keep : a.def;
  omniRender();
}
$('url').addEventListener('input', () => { omniTyped = $('url').value; omniUpdate(); });
$('url').addEventListener('keydown', (e) => {
  const open = !$('omni').hidden && omniItems.length;
  if (e.key === 'ArrowDown' && open) { e.preventDefault(); omniSel = (omniSel + 1) % omniItems.length; omniRender(); $('url').value = omniItems[omniSel].kind === 'hist' || omniItems[omniSel].kind === 'bm' ? omniItems[omniSel].url : omniItems[omniSel].text; }
  else if (e.key === 'ArrowUp' && open) { e.preventDefault(); omniSel = (omniSel - 1 + omniItems.length) % omniItems.length; omniRender(); $('url').value = omniItems[omniSel].kind === 'hist' || omniItems[omniSel].kind === 'bm' ? omniItems[omniSel].url : omniItems[omniSel].text; }
  else if (e.key === 'Delete' && e.shiftKey && open && ['hist', 'past'].includes(omniItems[omniSel].kind)) { e.preventDefault(); forget(omniItems[omniSel]); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const it = open ? omniItems[omniSel] : null;
    const typedNow = $('url').value;
    if (it && (it.text === typedNow || it.url === typedNow || (omniDefaultLink && omniSel === 0 && typedNow === omniTyped))) omniGo(it, e.altKey); else { omniClose(); if (e.altKey) { const u = toUrl(typedNow); if (u) createTab(u, true); } else go(typedNow); $('url').blur(); }
  }
  else if (e.key === 'Escape') { if (open) { omniClose(); $('url').value = omniTyped || $('url').value; } else { updateNav(); $('url').blur(); } }
});
let omniHandoff = false;
$('url').addEventListener('focus', () => { if (omniHandoff) { omniHandoff = false; return; } setTimeout(() => $('url').select(), 0); omniTyped = ''; omniUpdate(); });
$('url').addEventListener('blur', () => setTimeout(omniClose, 120));
window.addEventListener('resize', () => { if (!$('omni').hidden) omniRender(); });
$('findIn').addEventListener('input', (e) => { const v = e.target.value; if (v) active.wv.findInPage(v); else closeFind(), openFind(); });
$('findIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value) active.wv.findInPage(e.target.value, { findNext: true, forward: !e.shiftKey }); if (e.key === 'Escape') closeFind(); });
$('findX').onclick = closeFind;
document.addEventListener('keydown', (e) => { if (handleKey(e.key.toLowerCase(), e.ctrlKey, e.shiftKey, e.altKey)) e.preventDefault(); });

window.aura.on('open-tab', (d) => typeof d === 'string' ? createTab(d) : createTab(d.url, d.bg));
window.aura.on('tool', (name) => {
  if (name.startsWith('omnibox')) { const q = decodeURIComponent(name.split('/')[1] || ''); omniHandoff = true; $('url').focus(); $('url').value = q; omniTyped = q; omniUpdate(); const n = $('url'); n.setSelectionRange(q.length, q.length); return; }
  const map = { mail: () => openMail(), chat: () => openGoogleChat(), gchat: () => openGoogleChat(), orchardchat: () => openChat(), ai: () => toggleAi(true), lens: () => startLens(), battery: () => openPanel('battery'), speed: () => openPanel('speed'), downloads: () => openPanel('downloads'), menu: () => openPanel('menu'), theme: () => openPanel('theme'), profiles: () => openPanel('profiles'), history: () => openPanel('history') };
  if (map[name]) map[name]();
});
window.aura.on('shortcut', (s) => handleKey(s.key, s.ctrl, s.shift, s.alt));
window.aura.on('blocked', (n) => { blocked = n; if (store.settings.adblock) $('shield').innerHTML = '&#128737; ' + n + ' blocked'; });
window.aura.on('download', (d) => toast(d.state === 'completed' ? 'Downloaded ' + d.name + ' 🔥' : 'Download failed 💔'));
let lastUnlock = 0;
// leaving Orchard (another app) relocks unlocked tabs; a short grace period after unlocking avoids false blurs
window.aura.on('win-blur', () => { if (Date.now() - lastUnlock < 1500 || document.hasFocus()) return; relockAll(); });

window.aura.on('lock-sync', (s) => {
  if ((s.lockVer || 0) <= (store.settings.lockVer || 0)) return;
  store.settings.lockVer = s.lockVer;
  if (s.lockHash) { store.settings.lockHash = s.lockHash; store.settings.lockSalt = s.lockSalt; } else { delete store.settings.lockHash; delete store.settings.lockSalt; }
  tabs.forEach(renderTab); layoutViews();
});
function showUpdate(u) {
  const p = $('updPill'); p.hidden = false;
  p.innerHTML = '&#11014; Update ' + esc(u.version);
  p.title = (u.notes ? 'New: ' + u.notes + '\n' : '') + 'Click to restart into it';
}
window.aura.on('update-ready', (u) => { showUpdate(u); toast('Orchard ' + u.version + ' downloaded, click the green button to restart 🔥'); });
window.aura.appVersion().then(v => { if (v.pending) showUpdate(v.pending); });
window.aura.on('profile-changed', (p) => applyProfile(p));
window.aura.on('power', (b) => { onBattery = b; applySaver(); });
window.aura.on('max-state', (m) => $('mx').innerHTML = m ? '&#10697;' : '&#9744;');

window.aura.on('attach-tab', (u) => { const t = createTab(u || undefined); window.aura.win('focus'); });
window.aura.getStore().then(async (s) => {
  store = s;
  store.settings = store.settings || { engine: 'google', adblock: true };
  $('shield').classList.toggle('off', !store.settings.adblock);
  if (!store.settings.adblock) $('shield').innerHTML = '&#128737; off';
  if (store.settings.sleepMins === undefined) store.settings.sleepMins = 5;
  applyProfile(store.profile);
  applyToolbar();

  $('aiPick').value = store.settings.ai || 'gemini';
  blocked = store.blocked || 0;
  renderBookmarks();
  const first = await window.aura.initialTab();
  if (first !== null && first !== undefined) createTab(first || undefined);
  else if (!restoreSession()) createTab();
  window.aura.onBattery().then(b => { onBattery = b; applySaver(); });
  if (navigator.getBattery) navigator.getBattery().then(bt => {
    const up = () => { battLevel = bt.level; charging = bt.charging; applySaver(); };
    bt.addEventListener('levelchange', up); bt.addEventListener('chargingchange', up); up();
  }).catch(() => updateSaverUI());
  else updateSaverUI();
  setInterval(updateSaverUI, 15000);
});
