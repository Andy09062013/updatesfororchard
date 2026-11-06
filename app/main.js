const { app, BrowserWindow, ipcMain, session, Menu, shell, webContents, powerMonitor, net, clipboard, nativeImage, dialog } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

// battery friendly chromium flags: throttle timers in background pages hard
app.commandLine.appendSwitch('enable-features', 'IntensiveWakeUpThrottling:grace_period_seconds/10,AlignWakeUps');
app.commandLine.appendSwitch('enable-smooth-scrolling'); // animated wheel scrolling in pages

// keep using the old Aura data folder so bookmarks/profiles carry over after the rename
try {
  const oldDir = path.join(app.getPath('appData'), 'Aura Browser');
  if (fs.existsSync(oldDir)) app.setPath('userData', oldDir);
} catch {}

// ---------- one Orchard at a time: links opened from other apps become tabs here ----------
const RELAUNCH_FLAG = '--orchard-relaunch';
const lockReady = new Promise((resolve) => {
  if (app.requestSingleInstanceLock()) return resolve(true);
  if (!process.argv.includes(RELAUNCH_FLAG)) { app.quit(); return resolve(false); }
  // restarted for an update: the previous copy may still be closing, so wait for it
  let tries = 0;
  const iv = setInterval(() => {
    if (app.requestSingleInstanceLock()) { clearInterval(iv); resolve(true); }
    else if (++tries > 40) { clearInterval(iv); app.quit(); resolve(false); }
  }, 150);
});
function urlFromArgs(argv) {
  for (const a of (argv || []).slice(1)) {
    if (typeof a !== 'string' || a.startsWith('-')) continue;
    if (/^(https?|file):\/\//i.test(a)) return a;
    if (/\.(html?|xhtml|pdf|svg|txt)$/i.test(a)) { try { if (fs.existsSync(a)) return pathToFileURL(path.resolve(a)).href; } catch {} }
  }
  return null;
}
let lastFocusedWin = null;
app.on('browser-window-focus', (e, w) => { lastFocusedWin = w; });
app.on('second-instance', (e, argv) => {
  const alive = (w) => w && !w.isDestroyed();
  const w = [BrowserWindow.getFocusedWindow(), lastFocusedWin, BrowserWindow.getAllWindows()[0]].find(alive);
  const url = urlFromArgs(argv);
  if (!w) { createWindow('default', url ? { url } : {}); return; }
  if (url) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); w.webContents.send('open-tab', { url, bg: false }); return; }
  const pid = winProfile.get(w.webContents.id);
  createWindow(pid && pid !== 'guest' ? pid : 'default'); // launching Orchard again opens a new window, like Chrome
});
const dataDir = app.getPath('userData');
if (process.platform === 'win32') { try { app.setAppUserModelId('Orchard.Browser'); } catch {} }
const profilesFile = path.join(dataDir, 'profiles.json');
const COLORS = ['#e8432e', '#ffb83d', '#6cc35a', '#c0447a', '#f2752e', '#8a5a3c', '#4fa3d1', '#e4e45e'];

// ---------- profiles ----------
let profiles;
try { profiles = JSON.parse(fs.readFileSync(profilesFile, 'utf8')); } catch { profiles = null; }
if (!Array.isArray(profiles) || !profiles.length) profiles = [{ id: 'default', name: 'Me', color: COLORS[0] }];
else if (profiles[0].id === 'default' && profiles[0].color === '#a46bff') { profiles[0].color = COLORS[0]; }
function saveProfiles() { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(profilesFile, JSON.stringify(profiles)); } catch {} }
const GUEST = { id: 'guest', name: 'Guest', color: '#9aa0b4', guest: true };
const getProfile = (id) => id === 'guest' ? GUEST : profiles.find(p => p.id === id);
// default profile keeps the old file + default session so v1.1 data carries over
const storeFileFor = (id) => path.join(dataDir, id === 'default' ? 'aura-data.json' : `aura-data-${id}.json`);
const partitionFor = (id) => (id === 'default' ? '' : id === 'guest' ? 'guest-incognito' : `persist:profile-${id}`);
const sessionFor = (id) => (id === 'default' ? session.defaultSession : session.fromPartition(partitionFor(id)));

const stores = {};
function defaultStore() {
  return { bookmarks: [
    { title: 'YouTube', url: 'https://www.youtube.com' },
    { title: 'Google', url: 'https://www.google.com' },
    { title: 'GitHub', url: 'https://github.com' }
  ], history: [], settings: { engine: 'google', adblock: true } };
}
function storeFor(id) {
  if (!stores[id]) {
    if (id === 'guest') { stores[id] = defaultStore(); stores[id].settings.savePasswords = false; }
    else { try { stores[id] = JSON.parse(fs.readFileSync(storeFileFor(id), 'utf8')); } catch { stores[id] = defaultStore(); } }
  }
  return stores[id];
}
function saveStore(id) { if (id === 'guest') return; try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(storeFileFor(id), JSON.stringify(stores[id])); } catch {} }

// ---------- adblock ----------
const AD_HOSTS = new Set(require(path.join(__dirname, 'blocklist.js')));
// block a host if it, or any domain it sits under, is on the list (ads.example.com matches example.com)
function isAdHost(h) {
  let i = -1;
  do { if (AD_HOSTS.has(h.slice(i + 1))) return true; i = h.indexOf('.', i + 1); } while (i !== -1);
  return false;
}
const blockedCount = {};
const hostOf = (wc) => { try { return wc && (wc.hostWebContents || wc); } catch { return null; } };
const sendTo = (wc, ch, d) => { if (wc && !wc.isDestroyed()) wc.send(ch, d); };

const setUp = new Set();
const downloads = new Map();
let dlId = 0;
// download history, shared across every window and kept between runs
const dlFile = path.join(dataDir, 'downloads.json');
const dlHistory = new Map();
try { JSON.parse(fs.readFileSync(dlFile, 'utf8')).forEach(d => dlHistory.set(d.id, d)); if (dlHistory.size) dlId = Math.max(...dlHistory.keys()); } catch {}
let dlSaveT = null;
function saveDlHistory() { clearTimeout(dlSaveT); dlSaveT = setTimeout(() => { try { fs.writeFileSync(dlFile, JSON.stringify([...dlHistory.values()].slice(-100))); } catch {} }, 400); }
// record a download update and push it to every open window so they stay in sync
function emitDl(d) {
  dlHistory.set(d.id, d);
  while (dlHistory.size > 120) dlHistory.delete(dlHistory.keys().next().value);
  saveDlHistory();
  BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('dl', d); } catch {} });
}
// "report.pdf" -> "report (1).pdf" if it's already there (or being downloaded right now), like Chrome
const reservedDl = new Set();
function uniqueDownloadPath(name) {
  const dir = app.getPath('downloads');
  const clean = String(name || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 180) || 'download';
  const ext = path.extname(clean), base = clean.slice(0, clean.length - ext.length);
  for (let n = 0; n < 1000; n++) {
    const p = path.join(dir, n ? `${base} (${n})${ext}` : clean);
    if (!fs.existsSync(p) && !reservedDl.has(p)) { reservedDl.add(p); return p; }
  }
  const p = path.join(dir, `${base} ${Date.now()}${ext}`); reservedDl.add(p); return p;
}
function setupSession(id) {
  if (setUp.has(id)) return;
  setUp.add(id);
  const profId = id;
  const ses = sessionFor(id);
  try {
    const vp = path.join(__dirname, 'video-preload.js'), pw = path.join(__dirname, 'pw-preload.js'), fp = path.join(__dirname, 'fps-preload.js');
    if (typeof ses.registerPreloadScript === 'function') { ses.registerPreloadScript({ type: 'frame', id: 'orchard-video', filePath: vp }); ses.registerPreloadScript({ type: 'frame', id: 'orchard-pw', filePath: pw }); ses.registerPreloadScript({ type: 'frame', id: 'orchard-fps', filePath: fp }); }
    else ses.setPreloads([...ses.getPreloads(), vp, pw, fp]);
  } catch {}
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    if (storeFor(id).settings.adblock) {
      try {
        const h = new URL(details.url).hostname;
        if (isAdHost(h)) {
          blockedCount[id] = (blockedCount[id] || 0) + 1;
          sendTo(hostOf(details.webContents), 'blocked', blockedCount[id]);
          return cb({ cancel: true });
        }
      } catch {}
    }
    cb({});
  });
  ses.on('will-download', (e, item, wc) => {
    const host = hostOf(wc);
    try { sendTo(host, 'dl-origin', { wcId: wc && !wc.isDestroyed() ? wc.id : null }); } catch {}
    const id = ++dlId;
    downloads.set(id, item);
    // like Chrome: save straight to Downloads, no "Save As" box (unless the user turned asking on)
    let savePath = '';
    if (!(storeFor(profId).settings || {}).askDownload) {
      savePath = uniqueDownloadPath(item.getFilename());
      item.setSavePath(savePath);
    }
    const info = (state) => ({ id, name: path.basename(item.getSavePath() || savePath || item.getFilename()), url: item.getURL(), received: item.getReceivedBytes(), total: item.getTotalBytes(), state, paused: item.isPaused(), path: item.getSavePath() || savePath, time: Date.now() });
    emitDl(info('progressing'));
    item.once('done', () => reservedDl.delete(savePath));
    let last = 0;
    item.on('updated', (ev, state) => { if (Date.now() - last > 250) { last = Date.now(); emitDl(info(state)); } });
    item.once('done', (ev, state) => { emitDl(info(state)); sendTo(host, 'download', { name: item.getFilename(), state, path: item.getSavePath() }); });
  });
}

// ---------- windows ----------
const openFile = path.join(dataDir, 'open-windows.json');
function rememberOpen() { try { fs.writeFileSync(openFile, JSON.stringify([...winProfile.values()].filter(x => x !== 'guest'))); } catch {} }
const winProfile = new Map(); // window webContents id -> profile id
let firstWin = null;
const initialTabs = new Map(); // window webContents id -> url for torn-off tabs
function createWindow(profileId, opts = {}) {
  const p = getProfile(profileId) || profiles[0];
  setupSession(p.id);
  const win = new BrowserWindow({
    width: opts.width || 1300, height: opts.height || 820,
    ...(opts.x != null ? { x: Math.round(opts.x), y: Math.round(opts.y) } : {}), minWidth: 600, minHeight: 400,
    frame: false, backgroundColor: '#120c0b',
    title: 'Orchard - ' + p.name,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true, contextIsolation: true, nodeIntegration: false
    }
  });
  const wcId = win.webContents.id;
  winProfile.set(wcId, p.id);
  if (opts.url !== undefined) initialTabs.set(wcId, opts.url);
  rememberOpen();
  // closing one of several windows forgets it, closing the last one keeps the list so it all reopens
  win.on('close', () => { if (BrowserWindow.getAllWindows().length > 1) { winProfile.delete(wcId); rememberOpen(); } });
  win.on('closed', () => {
    winProfile.delete(wcId);
    if (p.id === 'guest' && ![...winProfile.values()].includes('guest')) {
      delete stores['guest']; setUp.delete('guest');
      try { const s = session.fromPartition('guest-incognito'); s.clearStorageData(); s.clearCache(); } catch {}
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  // only count it as leaving when focus really left Orchard (clicking into a page can fire a fake blur on Windows)
  win.on('blur', () => setTimeout(() => {
    if (win.isDestroyed() || win.isFocused()) return;
    const f = BrowserWindow.getFocusedWindow();
    if (f === win) return;
    win.webContents.send('win-blur');
  }, 250));
  win.on('maximize', () => win.webContents.send('max-state', true));
  win.on('unmaximize', () => win.webContents.send('max-state', false));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) win.webContents.send('open-tab', { url, bg: false }); return { action: 'deny' }; });
  if (!firstWin) firstWin = win;
  return win;
}
const profileOf = (e) => winProfile.get(e.sender.id) || 'default';
const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
function windowFor(profileId) {
  for (const [wcId, pid] of winProfile) if (pid === profileId) { const w = BrowserWindow.fromWebContents(webContents.fromId(wcId)); if (w) return w; }
  return null;
}

app.whenReady().then(async () => {
  if (!(await lockReady)) return;
  Menu.setApplicationMenu(null);
  // look like normal chrome so google/gemini logins dont freak out
  app.userAgentFallback = app.userAgentFallback.replace(/\s?(Electron|aura-browser|AuraBrowser|orchard-browser|Orchard)\/\S+/gi, '');
  const lastUsed = (() => { try { return fs.readFileSync(path.join(dataDir, 'last-profile'), 'utf8').trim(); } catch { return 'default'; } })();
  let reopen = [];
  try { reopen = JSON.parse(fs.readFileSync(openFile, 'utf8')).filter(id => getProfile(id)); } catch {}
  if (!reopen.length) reopen = [getProfile(lastUsed) ? lastUsed : profiles[0].id];
  const win = createWindow(reopen[0]);
  reopen.slice(1).forEach(id => createWindow(id));
  // started by clicking a link in another app: open it as a tab once the window is ready
  const startUrl = urlFromArgs(process.argv);
  if (startUrl) win.webContents.once('did-finish-load', () => setTimeout(() => { if (!win.isDestroyed()) win.webContents.send('open-tab', { url: startUrl, bg: false }); }, 1500));
  if (process.env.AURA_SHOT) {
    if (process.env.AURA_TEST) setTimeout(() => win.webContents.executeJavaScript(process.env.AURA_TEST).catch(e => console.log('TESTERR', e)), 2500);
    app.on('browser-window-created', (e, w) => w.webContents.on('console-message', (ev) => { const m = ev.message || ''; if (m.startsWith('T:')) console.log(m); }));
    win.webContents.on('console-message', (e) => { const m = e.message || ''; if (m.startsWith('T:')) console.log(m); });
    setTimeout(async () => {
      const wins = BrowserWindow.getAllWindows();
      for (let i = 0; i < wins.length; i++) {
        const img = await wins[i].webContents.capturePage();
        fs.writeFileSync(process.env.AURA_SHOT.replace('.png', i ? `-${i}.png` : '.png'), img.toPNG());
      }
      app.quit();
    }, +(process.env.AURA_WAIT || 9000));
  }
  const sendPower = (b) => BrowserWindow.getAllWindows().forEach(w => w.webContents.send('power', b));
  powerMonitor.on('on-battery', () => sendPower(true));
  powerMonitor.on('on-ac', () => sendPower(false));
});

// popups open as tabs in the window that owns the webview
app.on('web-contents-created', (e, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url, disposition }) => {
      sendTo(contents.hostWebContents, 'open-tab', { url, bg: disposition === 'background-tab' });
      return { action: 'deny' };
    });
    // The chat (Codeline) talks to the browser through specially marked console lines (chat artifact only)
    contents.on('console-message', (ev, level, message) => {
      const msg = (ev && typeof ev.message === 'string') ? ev.message : message;
      if (typeof msg !== 'string' || !msg.startsWith('%ORCHARD%')) return;
      let url = ''; try { url = contents.getURL(); } catch {}
      if (!CHAT_URLS.some(u => url.startsWith(u)) && !url.startsWith('https://claude.ai/')) return;
      try { const d = JSON.parse(msg.slice(9)); if (d && (d.t === 'notify' || d.t === 'unread')) { chatContents.add(contents); sendTo(contents.hostWebContents, 'chat-event', { t: d.t, n: d.n, chat: String(d.chat || '').slice(0, 80), title: String(d.title || '').slice(0, 80), from: String(d.from || '').slice(0, 60), text: String(d.text || '').slice(0, 200), group: !!d.group, open: !!d.open }); } } catch {}
    });
    // orchard://tool/<name> links on the new tab page open browser features
    contents.on('will-navigate', (e, url) => {
      if (url.startsWith('orchard://')) { e.preventDefault(); sendTo(contents.hostWebContents, 'tool', url.replace('orchard://tool/', '').replace(/\/$/, '')); }
    });
    contents.on('before-input-event', (ev, input) => {
      if (input.type !== 'keyDown') return;
      const k = input.key.toLowerCase();
      if (input.control && ['t','w','l','r','d','h','tab','=','-','0','f','n','j'].includes(k) || k === 'f5' || k === 'f11' || k === 'f12' || (input.alt && (k === 'arrowleft' || k === 'arrowright' || k === 'g' || k === 'c' || k === 'f' || k === 'h' || k === 'm' || k === 'k' || k === 'e'))) {
        ev.preventDefault();
        sendTo(contents.hostWebContents, 'shortcut', { key: k, ctrl: input.control, shift: input.shift, alt: input.alt });
      }
    });
  }
});

ipcMain.handle('store-get', (e) => {
  const id = profileOf(e);
  const pr = getProfile(id);
  const email = (typeof ms === 'function' && ms(id).refresh && ms(id).email) || '';
  return { ...storeFor(id), profile: pr ? { ...pr, email } : pr, partition: partitionFor(id), blocked: blockedCount[id] || 0 };
});
ipcMain.on('store-set', (e, data) => {
  const id = profileOf(e);
  const evChanged = JSON.stringify((storeFor(id).events) || []) !== JSON.stringify(data.events || []);
  setImmediate(() => { if (evChanged) calPlan(id); });
  const { profile, partition, blocked, ...rest } = data;
  const prev = storeFor(id);
  const ps = prev.settings || {}, ns = rest.settings || {};
  // the tab lock password lives on the profile: a window with an older copy never overwrites a newer one
  if ((ps.lockVer || 0) > (ns.lockVer || 0)) {
    rest.settings = { ...ns, lockVer: ps.lockVer, lockHash: ps.lockHash, lockSalt: ps.lockSalt };
    if (!ps.lockHash) { delete rest.settings.lockHash; delete rest.settings.lockSalt; }
  }
  stores[id] = { ...prev, ...rest };
  saveStore(id);
  const s2 = stores[id].settings || {};
  if ((s2.lockVer || 0) !== (ps.lockVer || 0)) {
    for (const [wcId, pid] of winProfile) if (pid === id && wcId !== e.sender.id) sendTo(webContents.fromId(wcId), 'lock-sync', { lockVer: s2.lockVer || 0, lockHash: s2.lockHash || null, lockSalt: s2.lockSalt || null });
  }
});
ipcMain.on('win', (e, a) => {
  const win = winOf(e);
  if (!win) return;
  if (a === 'min') win.minimize();
  else if (a === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (a === 'close') win.close();
  else if (a === 'full') win.setFullScreen(!win.isFullScreen());
  else if (a === 'focus') { if (win.isMinimized()) win.restore(); win.focus(); }
});

// ---------- chat bridge (Codeline) ----------
const CHAT_URL = process.env.ORCHARD_CHAT_URL || 'https://claude.ai/artifact/RrmU2fmMyL4opSTTW2SL8u';
// claude.ai may show the same artifact under its long id
const CHAT_URLS = [CHAT_URL, 'https://claude.ai/artifact/c94e2cfc-3fae-4a88-baf1-5136fcbf9c0e'];
const chatContents = new Set();
const { Notification } = require('electron');
ipcMain.on('chat-native-note', (e, n) => {
  try {
    if (!Notification.isSupported()) return;
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed() && w.isFocused() && !w.isMinimized()) return; // the in-browser card is enough
    const note = new Notification({ title: String(n.title || 'Codeline').slice(0, 80), body: ((n.group && n.from) ? n.from + ': ' : '') + String(n.text || '').slice(0, 200), icon: path.join(__dirname, 'icon.png'), silent: false });
    note.on('click', () => { if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); w.webContents.send('chat-open', String(n.chat || '')); } });
    note.show();
  } catch {}
});
ipcMain.on('chat-open-id', async (e, id) => {
  id = String(id || '').replace(/[^A-Za-z0-9_.~:@+-]/g, '');
  for (const c of chatContents) {
    if (c.isDestroyed() || c.hostWebContents !== e.sender) continue;
    for (const f of c.mainFrame.framesInSubtree) {
      try { if (await f.executeJavaScript(`typeof window.__orchardOpen === 'function' ? (window.__orchardOpen(${JSON.stringify(id)}), true) : false`)) return; } catch {}
    }
  }
});

// ---------- tab lock password hashing ----------
ipcMain.handle('hash-pw', (e, pw, salt) => require('crypto').scryptSync(String(pw), 'orchard:' + String(salt), 32).toString('hex'));

// ---------- tab tear-off ----------
ipcMain.handle('initial-tab', (e) => { const u = initialTabs.get(e.sender.id); initialTabs.delete(e.sender.id); return u === undefined ? null : u; });
ipcMain.handle('tear-tab', (e, d) => {
  const src = BrowserWindow.fromWebContents(e.sender);
  const pid = profileOf(e);
  // dropped on another window's tab strip (same profile)? move it there
  for (const [wcId, wpid] of winProfile) {
    const w = BrowserWindow.fromWebContents(webContents.fromId(wcId));
    if (!w || w === src || wpid !== pid || w.isMinimized()) continue;
    const b = w.getBounds();
    if (d.x >= b.x && d.x <= b.x + b.width && d.y >= b.y && d.y <= b.y + 80) {
      w.webContents.send('attach-tab', d.url);
      w.focus();
      return 'moved';
    }
  }
  if (d.onlyTab) { if (src) src.setPosition(Math.round(d.x - 120), Math.round(d.y - 18)); return null; }
  const sb = src ? src.getBounds() : { width: 1100, height: 760 };
  createWindow(pid, { url: d.url, x: d.x - 120, y: d.y - 18, width: Math.min(sb.width, 1200), height: Math.min(sb.height, 800) });
  return 'new';
});

// profiles api
ipcMain.handle('profiles-list', () => profiles.map(p => ({ ...p, email: (typeof ms === 'function' && ms(p.id).refresh && ms(p.id).email) || '' })));
ipcMain.handle('profile-open', (e, id) => {
  if (!getProfile(id)) return false;
  try { fs.writeFileSync(path.join(dataDir, 'last-profile'), id); } catch {}
  const w = windowFor(id);
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); return true; }
  createWindow(id);
  return true;
});
ipcMain.handle('profile-new-window', (e) => { createWindow(profileOf(e)); return true; });
ipcMain.handle('open-guest', () => { createWindow('guest'); return true; });
ipcMain.handle('profile-add', (e, name, color) => {
  const id = 'p' + Date.now().toString(36);
  const p = { id, name: String(name || 'Person ' + (profiles.length + 1)).slice(0, 24), color: color || COLORS[profiles.length % COLORS.length] };
  profiles.push(p); saveProfiles();
  createWindow(id);
  return p;
});
ipcMain.handle('profile-edit', (e, id, name, color) => {
  const p = getProfile(id);
  if (!p) return false;
  if (name) p.name = String(name).slice(0, 24);
  if (color) p.color = color;
  saveProfiles();
  for (const [wcId, pid] of winProfile) if (pid === id) sendTo(webContents.fromId(wcId), 'profile-changed', { ...p, email: (ms(id).refresh && ms(id).email) || '' });
  return true;
});
ipcMain.handle('profile-delete', async (e, id) => {
  if (id === 'default' || !getProfile(id)) return false;
  for (const [wcId, pid] of [...winProfile]) if (pid === id) { const w = BrowserWindow.fromWebContents(webContents.fromId(wcId)); if (w) w.destroy(); }
  try { const s = sessionFor(id); await s.clearStorageData(); await s.clearCache(); } catch {}
  try { fs.unlinkSync(storeFileFor(id)); } catch {}
  delete stores[id];
  profiles = profiles.filter(p => p.id !== id); saveProfiles();
  return true;
});

// freeze / unfreeze a tab: frozen pages run zero JS, timers or animations
ipcMain.on('freeze', (e, id, frozen) => {
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) return;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    wc.debugger.sendCommand('Page.setWebLifecycleState', { state: frozen ? 'frozen' : 'active' }).catch(() => {});
  } catch {}
});
// search suggestions for the address bar
ipcMain.handle('suggest', async (e, engine, q) => {
  q = String(q || '').slice(0, 200);
  if (!q.trim()) return [];
  const enc = encodeURIComponent(q);
  const urls = {
    google: 'https://suggestqueries.google.com/complete/search?client=chrome&q=' + enc,
    duckduckgo: 'https://duckduckgo.com/ac/?type=list&q=' + enc,
    bing: 'https://api.bing.com/osjson.aspx?query=' + enc,
    brave: 'https://search.brave.com/api/suggest?q=' + enc
  };
  try {
    const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 2500);
    const r = await net.fetch(urls[engine] || urls.google, { signal: ctrl.signal, session: sessionFor(profileOf(e)) });
    clearTimeout(tm);
    const j = JSON.parse(await r.text());
    const list = Array.isArray(j) && Array.isArray(j[1]) ? j[1] : [];
    return list.filter(s => typeof s === 'string').slice(0, 8);
  } catch { return []; }
});

// tell pages to calm down (reduced motion) or go dark to save power
ipcMain.on('emulate', (e, id, o) => {
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) return;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    const features = [];
    if (o.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
    if (o.dark) features.push({ name: 'prefers-color-scheme', value: 'dark' });
    wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features }).catch(() => {});
    wc.debugger.sendCommand('Emulation.setAutoDarkModeOverride', o.dark ? { enabled: true } : {}).catch(() => {});
  } catch {}
});
ipcMain.handle('on-battery', () => { try { return powerMonitor.isOnBatteryPower(); } catch { return false; } });
ipcMain.on('show-file', (e, p) => shell.showItemInFolder(p));
ipcMain.on('open-file', (e, p) => shell.openPath(p));
ipcMain.handle('dl-history', () => [...dlHistory.values()].sort((a, b) => a.id - b.id));

// drag a finished download out of Orchard into a folder / another app
const dragIcon = (() => { try { const i = nativeImage.createFromPath(path.join(__dirname, 'icon.png')); return i.isEmpty() ? null : i.resize({ width: 28, height: 28 }); } catch { return null; } })();
ipcMain.on('drag-file', (e, filePath) => {
  try { if (filePath && fs.existsSync(filePath)) e.sender.startDrag({ file: filePath, icon: dragIcon || nativeImage.createEmpty() }); } catch {}
});

// Charge / Supercharge a tab: keep it full speed and (level 2) give it priority
function setTabPriority(pid, level) {
  if (process.platform !== 'win32' || !pid) return;
  const cls = level >= 2 ? 'AboveNormal' : 'Normal';
  try { require('child_process').spawn('powershell.exe', ['-NoProfile', '-Command', `try{(Get-Process -Id ${pid}).PriorityClass='${cls}'}catch{}`], { windowsHide: true, stdio: 'ignore' }); } catch {}
}
ipcMain.on('charge', (e, wcId, level) => {
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return;
  try { wc.setBackgroundThrottling(level >= 1 ? false : true); } catch {}
  try { setTabPriority(wc.getOSProcessId(), level); } catch {}
});
ipcMain.on('dl-action', (e, id, a) => {
  const it = downloads.get(id);
  if (!it) return;
  try { if (a === 'cancel') it.cancel(); else if (a === 'pause') it.pause(); else if (a === 'resume' && it.canResume()) it.resume(); } catch {}
});

// ---------- battery usage meter: cpu + memory per tab ----------
ipcMain.handle('metrics', (e, tabList) => {
  const metrics = app.getAppMetrics();
  const byPid = new Map(metrics.map(m => [m.pid, m]));
  const tabsOut = tabList.map(t => {
    let pid = null;
    try { const wc = webContents.fromId(t.wcId); if (wc && !wc.isDestroyed()) pid = wc.getOSProcessId(); } catch {}
    const m = pid && byPid.get(pid);
    return { key: t.key, cpu: m ? m.cpu.percentCPUUsage : 0, mem: m ? m.memory.workingSetSize : 0, pid };
  });
  const sum = (f) => metrics.filter(f).reduce((a, m) => a + m.cpu.percentCPUUsage, 0);
  const total = { cpu: sum(() => true), mem: metrics.reduce((a, m) => a + m.memory.workingSetSize, 0), gpu: sum(m => m.type === 'GPU'), browser: sum(m => m.type === 'Browser') };
  let onBat = false; try { onBat = powerMonitor.isOnBatteryPower(); } catch {}
  return { tabs: tabsOut, total, cores: require('os').cpus().length, onBattery: onBat };
});

// ---------- wifi speed test (cloudflare speed endpoints, no cors issues from main) ----------
const speedRuns = new Map();
ipcMain.on('speed-stop', (e) => { const r = speedRuns.get(e.sender.id); if (r) r.stop = true; });
ipcMain.on('speed-start', async (e) => {
  const sender = e.sender, run = { stop: false };
  speedRuns.set(sender.id, run);
  const send = (d) => sendTo(sender, 'speed', d);
  const ses = sessionFor(winProfile.get(sender.id) || 'default');
  const BASE = 'https://speed.cloudflare.com';
  const opts = { session: ses, cache: 'no-store' };
  try {
    // ping
    send({ phase: 'ping' });
    const pings = [];
    for (let i = 0; i < 8 && !run.stop; i++) {
      const t0 = performance.now();
      const r = await net.fetch(BASE + '/__down?bytes=0&r=' + Math.random(), opts);
      await r.arrayBuffer();
      pings.push(performance.now() - t0);
    }
    pings.sort((a, b) => a - b);
    const ping = pings[Math.floor(pings.length / 2)];
    const jitter = pings.length > 1 ? pings.slice(1).reduce((a, p, i) => a + Math.abs(p - pings[i]), 0) / (pings.length - 1) : 0;
    send({ phase: 'ping', ping, jitter });

    // download: 4 parallel streams for ~8s
    let bytes = 0; const start = performance.now(); const DUR = 8000;
    const dlStream = async () => {
      while (!run.stop && performance.now() - start < DUR) {
        const r = await net.fetch(BASE + '/__down?bytes=25000000&r=' + Math.random(), opts);
        const reader = r.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (run.stop || performance.now() - start > DUR) { reader.cancel().catch(() => {}); break; }
        }
      }
    };
    const tick = setInterval(() => send({ phase: 'download', mbps: bytes * 8 / ((performance.now() - start) / 1000) / 1e6, progress: Math.min(1, (performance.now() - start) / DUR) }), 200);
    await Promise.all([dlStream(), dlStream(), dlStream(), dlStream()]);
    clearInterval(tick);
    const down = bytes * 8 / ((performance.now() - start) / 1000) / 1e6;
    send({ phase: 'download', mbps: down, progress: 1, done: true });

    // upload: 3 parallel streams of 4MB posts for ~7s
    let ubytes = 0; const ustart = performance.now(); const UDUR = 7000;
    const chunk = Buffer.alloc(4 * 1024 * 1024, 97);
    const upStream = async () => {
      while (!run.stop && performance.now() - ustart < UDUR) {
        await net.fetch(BASE + '/__up', { ...opts, method: 'POST', body: chunk, headers: { 'Content-Type': 'application/octet-stream' } }).then(r => r.arrayBuffer());
        ubytes += chunk.length;
      }
    };
    const utick = setInterval(() => send({ phase: 'upload', mbps: ubytes * 8 / ((performance.now() - ustart) / 1000) / 1e6, progress: Math.min(1, (performance.now() - ustart) / UDUR) }), 300);
    await Promise.all([upStream(), upStream(), upStream()]);
    clearInterval(utick);
    const up = ubytes * 8 / ((performance.now() - ustart) / 1000) / 1e6;
    send({ phase: 'done', ping, jitter, down, up, stopped: run.stop });
  } catch (err) {
    send({ phase: 'error', error: String(err && err.message || err) });
  }
  speedRuns.delete(sender.id);
});

// ---------- custom backgrounds ----------
ipcMain.handle('bg-import', async (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(w, { title: 'Pick a background', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }] });
  if (r.canceled) return [];
  const dir = path.join(dataDir, 'backgrounds');
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const f of r.filePaths.slice(0, 8)) {
    try {
      let img = nativeImage.createFromPath(f);
      if (img.isEmpty()) continue;
      const { width } = img.getSize();
      if (width > 2560) img = img.resize({ width: 2560, quality: 'good' });
      const file = path.join(dir, 'bg-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.jpg');
      fs.writeFileSync(file, img.toJPEG(88));
      out.push(pathToFileURL(file).href);
    } catch {}
  }
  return out;
});
ipcMain.on('bg-delete', (e, url) => {
  try {
    const p = require('url').fileURLToPath(url);
    if (p.startsWith(path.join(dataDir, 'backgrounds'))) fs.unlinkSync(p);
  } catch {}
});

// ---------- google lens ----------
// capture what's on screen inside the tab's area (via the host window so it's always composited)
ipcMain.handle('capture', async (e, rect) => {
  try {
    const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    const img = await e.sender.capturePage(r);
    return img.isEmpty() ? null : img.toDataURL();
  } catch { return null; }
});
ipcMain.handle('lens', async (e, wcId, dataUrl) => {
  const img = nativeImage.createFromDataURL(dataUrl);
  try { clipboard.writeImage(img); } catch {}
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return false;
  const boundary = '----OrchardLens' + Math.random().toString(16).slice(2);
  const png = img.toPNG();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="encoded_image"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const url = 'https://lens.google.com/v3/upload?hl=en&re=df&ep=gsbubb&st=' + Date.now();
  await wc.loadURL(url, { postData: [{ type: 'rawData', bytes: body }], extraHeaders: `Content-Type: multipart/form-data; boundary=${boundary}` }).catch(() => {});
  return true;
});
ipcMain.handle('clear-data', async (e) => {
  const id = profileOf(e);
  const s = sessionFor(id);
  await s.clearStorageData();
  await s.clearCache();
  storeFor(id).history = []; saveStore(id);
  return true;
});

// ---------- remote updates (GitHub: Andy09062013/updatesfororchard) ----------
const UPDATE_BASE = process.env.ORCHARD_UPDATE_BASE || 'https://raw.githubusercontent.com/Andy09062013/updatesfororchard/main/';
const MY_VERSION = require(path.join(__dirname, 'package.json')).version;
const updRoot = path.join(app.getPath('appData'), 'Orchard Updates');
const cmpVer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1; }
  return 0;
};
let pendingUpdate = null, updating = false;
const broadcast = (ch, d) => BrowserWindow.getAllWindows().forEach(w => w.webContents.send(ch, d));
async function checkForUpdate() {
  if (pendingUpdate) return { status: 'ready', ...pendingUpdate };
  if (updating) return { status: 'busy' };
  updating = true;
  try {
    const r = await net.fetch(UPDATE_BASE + 'version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return { status: 'error', error: 'the update server returned ' + r.status };
    const man = await r.json();
    if (!man || typeof man.version !== 'string' || !Array.isArray(man.files)) return { status: 'error', error: 'the update information is invalid' };
    if (cmpVer(man.version, MY_VERSION) <= 0) return { status: 'latest', version: MY_VERSION };
    if (man.minElectron && cmpVer(man.minElectron, process.versions.electron) > 0) {
      return { status: 'full', version: man.version, notes: man.notes || '', url: man.fullDownload || '' };
    }
    const staging = path.join(updRoot, 'staging');
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    for (const f of man.files) {
      const rel = String(f.path || '');
      if (!/^[A-Za-z0-9_\-][A-Za-z0-9_.\-\/]*$/.test(rel) || rel.includes('..')) throw new Error('bad file path ' + rel);
      const res = await net.fetch(UPDATE_BASE + 'app/' + rel + '?v=' + encodeURIComponent(man.version), { cache: 'no-store' });
      if (!res.ok) throw new Error('could not download ' + rel);
      const buf = Buffer.from(await res.arrayBuffer());
      const hash = require('crypto').createHash('sha256').update(buf).digest('hex');
      if (f.sha256 && hash !== f.sha256) throw new Error(rel + ' got corrupted on the way, try again later');
      const out = path.join(staging, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
    }
    const pj = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'));
    if (pj.version !== man.version) throw new Error('version mismatch in update');
    const current = path.join(updRoot, 'current'), old = path.join(updRoot, 'previous');
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(current)) fs.renameSync(current, old);
    fs.renameSync(staging, current);
    pendingUpdate = { version: man.version, notes: String(man.notes || '').slice(0, 500) };
    broadcast('update-ready', pendingUpdate);
    return { status: 'ready', ...pendingUpdate };
  } catch (e) {
    return { status: 'error', error: String(e && e.message || e) };
  } finally { updating = false; }
}
app.whenReady().then(() => {
  setTimeout(() => checkForUpdate().catch(() => {}), 8000);
  setInterval(() => checkForUpdate().catch(() => {}), 4 * 3600 * 1000);
});
ipcMain.handle('update-check', () => checkForUpdate());
ipcMain.handle('app-version', () => ({ version: MY_VERSION, pending: pendingUpdate }));
ipcMain.on('update-restart', () => { thrShutdown().then(() => { app.relaunch({ args: process.argv.slice(1).filter(a => a !== RELAUNCH_FLAG).concat([RELAUNCH_FLAG]) }); app.exit(0); }); });

// ---------- Orchard Mail: Gmail through Google's official desktop sign-in ----------
// Sign-in happens in the user's normal browser (Chrome) with a loopback redirect +
// PKCE, the way Google wants desktop apps to do it. Tokens are encrypted with
// Windows' own encryption (safeStorage) and never leave this PC except to Google.
const http = require('http');
const { safeStorage } = require('electron');
const mailFile = (id) => path.join(dataDir, `mail-${id}.json`);
const mailState = {};
function ms(id) {
  if (!mailState[id]) {
    try {
      const j = JSON.parse(fs.readFileSync(mailFile(id), 'utf8'));
      if (j.enc && safeStorage.isEncryptionAvailable()) { try { j.refresh = safeStorage.decryptString(Buffer.from(j.enc, 'base64')); } catch {} }
      if (j.encSecret && safeStorage.isEncryptionAvailable()) { try { j.clientSecret = safeStorage.decryptString(Buffer.from(j.encSecret, 'base64')); } catch {} }
      delete j.enc; delete j.encSecret;
      mailState[id] = j;
    } catch { mailState[id] = {}; }
  }
  return mailState[id];
}
function mailSave(id) {
  const s = ms(id), out = { clientId: s.clientId || '', email: s.email || '' };
  const enc = safeStorage.isEncryptionAvailable();
  if (s.refresh) { if (enc) out.enc = safeStorage.encryptString(s.refresh).toString('base64'); else out.refresh = s.refresh; }
  if (s.clientSecret) { if (enc) out.encSecret = safeStorage.encryptString(s.clientSecret).toString('base64'); else out.clientSecret = s.clientSecret; }
  try { fs.writeFileSync(mailFile(id), JSON.stringify(out)); } catch {}
}
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
async function tokenRequest(params) {
  const r = await net.fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(j.error_description || j.error || ('token error ' + r.status)); err.code = j.error; throw err; }
  return j;
}
async function accessToken(id) {
  const s = ms(id);
  if (s.access && s.accessExp > Date.now() + 60000) return s.access;
  if (!s.refresh) { const e = new Error('not signed in'); e.code = 'signed_out'; throw e; }
  try {
    const j = await tokenRequest({ client_id: s.clientId, client_secret: s.clientSecret || '', refresh_token: s.refresh, grant_type: 'refresh_token' });
    s.access = j.access_token; s.accessExp = Date.now() + (j.expires_in || 3600) * 1000;
    return s.access;
  } catch (e) {
    if (e.code === 'invalid_grant') { s.refresh = null; s.access = null; mailSave(id); e.code = 'signed_out'; e.message = 'Your Google sign-in has expired. Please sign in again.'; }
    throw e;
  }
}
async function gmail(id, p, opts = {}, retry = true) {
  const tok = await accessToken(id);
  const r = await net.fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + p, {
    method: opts.method || 'GET',
    headers: { Authorization: 'Bearer ' + tok, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (r.status === 401 && retry) { ms(id).access = null; return gmail(id, p, opts, false); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Gmail error ' + r.status));
  return j;
}
const hdr = (msg, name) => { const h = ((msg.payload && msg.payload.headers) || []).find(x => x.name.toLowerCase() === name.toLowerCase()); return h ? h.value : ''; };
function bodyOf(payload) {
  let html = '', text = '';
  const walk = (p) => {
    if (!p) return;
    const mt = (p.mimeType || '').toLowerCase();
    if (p.body && p.body.data) {
      if (mt === 'text/html' && !html) html = unb64url(p.body.data).toString('utf8');
      else if (mt === 'text/plain' && !text) text = unb64url(p.body.data).toString('utf8');
    }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return { html, text };
}
const mailErr = (e) => ({ error: String(e && e.message || e), signedOut: e && e.code === 'signed_out' });

ipcMain.handle('mail-config', (e) => { const s = ms(profileOf(e)); return { clientId: s.clientId || '', hasSecret: !!s.clientSecret, email: s.email || '', signedIn: !!s.refresh }; });
ipcMain.handle('mail-config-set', (e, clientId, clientSecret) => {
  const id = profileOf(e), s = ms(id);
  s.clientId = String(clientId || '').trim().slice(0, 200);
  if (clientSecret) s.clientSecret = String(clientSecret).trim().slice(0, 200);
  mailSave(id); return true;
});
ipcMain.handle('mail-signin', async (e) => {
  const id = profileOf(e), s = ms(id);
  if (!s.clientId || !s.clientSecret) return { error: 'Enter your client ID and client secret first.' };
  const verifier = b64url(require('crypto').randomBytes(32));
  const challenge = b64url(require('crypto').createHash('sha256').update(verifier).digest());
  const state = require('crypto').randomBytes(16).toString('hex');
  return await new Promise((resolve) => {
    let redirect = '', finished = false;
    const page = (title, msg) => `<!doctype html><meta charset="utf-8"><title>Orchard Mail</title><body style="font-family:Segoe UI,sans-serif;background:#1e1f22;color:#e8e9eb;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p style="color:#a3a6ac">${msg}</p></div>`;
    const done = (v) => { if (finished) return; finished = true; clearTimeout(timer); try { server.close(); } catch {} resolve(v); };
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code'), err = u.searchParams.get('error');
      if (err || !code || u.searchParams.get('state') !== state) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page('Sign-in cancelled', 'You can close this tab.'));
        return done({ error: err === 'access_denied' ? 'sign in was cancelled' : (err || 'sign in failed') });
      }
      try {
        const j = await tokenRequest({ code, client_id: s.clientId, client_secret: s.clientSecret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier });
        s.refresh = j.refresh_token || s.refresh; s.access = j.access_token; s.accessExp = Date.now() + (j.expires_in || 3600) * 1000;
        const prof = await gmail(id, 'profile');
        s.email = prof.emailAddress || '';
        mailSave(id);
        const pp = getProfile(id);
        if (pp && s.email && (/^(Me|Person \d+)$/.test(pp.name))) { pp.name = s.email.split('@')[0].slice(0, 24); saveProfiles(); }
        if (pp) for (const [wcId, pid] of winProfile) if (pid === id) sendTo(webContents.fromId(wcId), 'profile-changed', { ...pp, email: s.email });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page('Signed in to Orchard Mail', 'You can close this tab and return to Orchard.'));
        const w = BrowserWindow.fromWebContents(e.sender); if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
        done({ ok: true, email: s.email });
      } catch (ex) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page('Something went wrong', 'Go back to Orchard and try again.'));
        done({ error: String(ex.message || ex) });
      }
    });
    const timer = setTimeout(() => done({ error: 'Sign-in timed out. Please try again.' }), 5 * 60 * 1000);
    server.on('error', (ex) => done({ error: 'Sign-in could not start: ' + ex.message }));
    server.listen(0, '127.0.0.1', () => {
      redirect = 'http://127.0.0.1:' + server.address().port;
      const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: s.clientId, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent',
        scope: 'https://www.googleapis.com/auth/gmail.modify', code_challenge: challenge, code_challenge_method: 'S256', state
      }).toString();
      shell.openExternal(auth);
    });
  });
});
ipcMain.handle('mail-signout', async (e) => {
  const id = profileOf(e), s = ms(id);
  if (s.refresh) net.fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(s.refresh), { method: 'POST' }).catch(() => {});
  s.refresh = null; s.access = null; s.email = ''; mailSave(id);
  const pp = getProfile(id); if (pp) for (const [wcId, pid] of winProfile) if (pid === id) sendTo(webContents.fromId(wcId), 'profile-changed', { ...pp, email: '' });
  return true;
});
ipcMain.handle('mail-list', async (e, q, pageToken) => {
  const id = profileOf(e);
  try {
    const params = new URLSearchParams({ maxResults: '30', q: q || 'in:inbox' });
    if (pageToken) params.set('pageToken', pageToken);
    const list = await gmail(id, 'messages?' + params.toString());
    const metas = await Promise.all((list.messages || []).map(m => gmail(id, `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`).catch(() => null)));
    return {
      next: list.nextPageToken || null,
      messages: metas.filter(Boolean).map(m => ({ id: m.id, threadId: m.threadId, from: hdr(m, 'From'), subject: hdr(m, 'Subject'), date: +m.internalDate || 0, snippet: m.snippet || '', unread: (m.labelIds || []).includes('UNREAD'), starred: (m.labelIds || []).includes('STARRED') }))
    };
  } catch (ex) { return mailErr(ex); }
});
ipcMain.handle('mail-get', async (e, mid) => {
  const id = profileOf(e);
  try {
    if (!/^[A-Za-z0-9]+$/.test(mid)) return { error: 'bad id' };
    const m = await gmail(id, `messages/${mid}?format=full`);
    const b = bodyOf(m.payload);
    return { id: m.id, threadId: m.threadId, from: hdr(m, 'From'), to: hdr(m, 'To'), cc: hdr(m, 'Cc'), subject: hdr(m, 'Subject'), date: +m.internalDate || 0, messageId: hdr(m, 'Message-ID'), html: b.html, text: b.text || m.snippet || '', unread: (m.labelIds || []).includes('UNREAD') };
  } catch (ex) { return mailErr(ex); }
});
ipcMain.handle('mail-modify', async (e, mid, action) => {
  const id = profileOf(e);
  try {
    if (!/^[A-Za-z0-9]+$/.test(mid)) return { error: 'bad id' };
    if (action === 'trash') await gmail(id, `messages/${mid}/trash`, { method: 'POST' });
    else {
      const body = { read: { removeLabelIds: ['UNREAD'] }, unread: { addLabelIds: ['UNREAD'] }, archive: { removeLabelIds: ['INBOX'] }, star: { addLabelIds: ['STARRED'] }, unstar: { removeLabelIds: ['STARRED'] } }[action];
      if (!body) return { error: 'bad action' };
      await gmail(id, `messages/${mid}/modify`, { method: 'POST', body });
    }
    return { ok: true };
  } catch (ex) { return mailErr(ex); }
});
ipcMain.handle('mail-send', async (e, d) => {
  const id = profileOf(e), s = ms(id);
  try {
    const clean = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim();
    const to = clean(d.to), subject = clean(d.subject);
    if (!to) return { error: 'Enter a recipient.' };
    const enc = (v) => /^[\x20-\x7e]*$/.test(v) ? v : '=?UTF-8?B?' + Buffer.from(v, 'utf8').toString('base64') + '?=';
    const lines = ['From: ' + (s.email || 'me'), 'To: ' + to, 'Subject: ' + enc(subject), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'];
    if (d.inReplyTo) { const r = clean(d.inReplyTo); lines.push('In-Reply-To: ' + r, 'References: ' + r); }
    const raw = lines.join('\r\n') + '\r\n\r\n' + Buffer.from(String(d.body || ''), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
    const body = { raw: b64url(Buffer.from(raw, 'utf8')) };
    if (d.threadId && /^[A-Za-z0-9]+$/.test(d.threadId)) body.threadId = d.threadId;
    await gmail(id, 'messages/send', { method: 'POST', body });
    return { ok: true };
  } catch (ex) { return mailErr(ex); }
});
ipcMain.handle('mail-unread', async (e) => {
  const id = profileOf(e);
  if (!ms(id).refresh) return { count: 0, signedIn: false };
  try { const l = await gmail(id, 'labels/INBOX'); return { count: l.messagesUnread || 0, signedIn: true }; } catch (ex) { return { count: 0, ...mailErr(ex) }; }
});
// open a page in the user's normal browser (Chrome) — only real web links
ipcMain.on('open-external', (e, url) => { if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url)); });

// ---------- Orchard Extensions: games + learning apps from the repo, run in tabs ----------
const extDir = path.join(dataDir, 'extensions');
const extIndex = path.join(extDir, 'installed.json');
const readExt = () => { try { return JSON.parse(fs.readFileSync(extIndex, 'utf8')); } catch { return []; } };
const writeExt = (l) => { fs.mkdirSync(extDir, { recursive: true }); fs.writeFileSync(extIndex, JSON.stringify(l)); };
const okExtId = (id) => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id);
async function extCatalog() {
  const r = await net.fetch(UPDATE_BASE + 'extensions/catalog.json?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('store answered ' + r.status);
  const j = await r.json();
  return (j.extensions || []).filter(x => x && okExtId(x.id) && typeof x.file === 'string' && /^[A-Za-z0-9_.-]+\.(html|js)$/.test(x.file)).map(x => ({
    id: x.id, name: String(x.name || x.id).slice(0, 60), category: x.category === 'educational' ? 'educational' : 'game',
    description: String(x.description || '').slice(0, 300), icon: String(x.icon || '').slice(0, 4), version: String(x.version || '1.0.0').slice(0, 20),
    size: +x.size || 0, file: x.file, sha256: String(x.sha256 || ''), inject: !!x.inject
  }));
}
ipcMain.handle('ext-catalog', async () => { try { return { items: await extCatalog() }; } catch (e) { return { error: String(e.message || e) }; } });
ipcMain.handle('ext-list', () => readExt());
ipcMain.handle('ext-install', async (e, id) => {
  try {
    if (!okExtId(id)) return { error: 'bad id' };
    const x = (await extCatalog()).find(i => i.id === id);
    if (!x) return { error: 'This extension is no longer available.' };
    const r = await net.fetch(UPDATE_BASE + 'extensions/' + x.file + '?v=' + encodeURIComponent(x.version), { cache: 'no-store' });
    if (!r.ok) return { error: 'the download failed (' + r.status + ')' };
    const buf = Buffer.from(await r.arrayBuffer());
    if (x.sha256 && require('crypto').createHash('sha256').update(buf).digest('hex') !== x.sha256) return { error: 'the download was corrupted. Please try again' };
    fs.mkdirSync(extDir, { recursive: true });
    const saved = id + (x.file.endsWith('.js') ? '.js' : '.html');
    fs.writeFileSync(path.join(extDir, saved), buf);
    const list = readExt().filter(i => i.id !== id);
    list.push({ id, name: x.name, category: x.category, description: x.description, icon: x.icon, version: x.version, size: buf.length, installed: Date.now(), inject: !!x.inject, file: saved });
    writeExt(list);
    return { ok: true };
  } catch (ex) { return { error: String(ex.message || ex) }; }
});
ipcMain.handle('ext-remove', (e, id) => {
  if (!okExtId(id)) return false;
  try { const f = (readExt().find(x => x.id === id) || {}).file; if (f && /^[A-Za-z0-9_.-]+$/.test(f)) fs.unlinkSync(path.join(extDir, f)); } catch {}
  try { fs.unlinkSync(path.join(extDir, id + '.html')); } catch {}
  try { fs.unlinkSync(path.join(extDir, id + '.js')); } catch {}
  writeExt(readExt().filter(i => i.id !== id));
  return true;
});
function extFile(id) {
  const it = readExt().find(x => x.id === id) || {};
  const cands = [];
  if (it.file && /^[A-Za-z0-9_.-]+$/.test(it.file)) cands.push(it.file);
  cands.push(id + '.js', id + '.html');
  for (const n of cands) { const p = path.join(extDir, n); try { if (fs.existsSync(p)) return p; } catch {} }
  return path.join(extDir, cands[0]);
}
ipcMain.handle('ext-url', (e, id) => {
  if (!okExtId(id)) return null;
  const f = extFile(id);
  return fs.existsSync(f) ? pathToFileURL(f).href : null;
});
ipcMain.handle('ext-code', (e, id) => {
  if (!okExtId(id)) return null;
  try { return fs.readFileSync(extFile(id), 'utf8'); } catch { return null; }
});

// ---------- Windows: apple icon on the Start menu + desktop shortcuts ----------
function ensureShortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const ico = path.join(dataDir, 'orchard.ico');
    fs.copyFileSync(path.join(__dirname, 'icon.ico'), ico);
    const opts = { target: process.execPath, cwd: path.dirname(process.execPath), icon: ico, iconIndex: 0, appUserModelId: 'Orchard.Browser', description: 'Orchard, the battery saving browser' };
    const startDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const startLnk = path.join(startDir, 'Orchard.lnk');
    shell.writeShortcutLink(startLnk, fs.existsSync(startLnk) ? 'update' : 'create', opts);
    const desk = path.join(app.getPath('desktop'), 'Orchard.lnk'), flag = path.join(dataDir, 'desktop-shortcut-made');
    if (!fs.existsSync(flag)) { shell.writeShortcutLink(desk, fs.existsSync(desk) ? 'update' : 'create', opts); fs.writeFileSync(flag, '1'); }
    else if (fs.existsSync(desk)) shell.writeShortcutLink(desk, 'update', opts);
  } catch {}
}
app.whenReady().then(() => setTimeout(ensureShortcuts, 3000));

// ---------- Calendar reminders: timers in the main process, one notification per event ----------
const calTimers = {};
const calSentFile = (id) => path.join(dataDir, `cal-sent-${id}.json`);
const calSent = (id) => { try { return new Set(JSON.parse(fs.readFileSync(calSentFile(id), 'utf8'))); } catch { return new Set(); } };
const calMark = (id, key) => { const s = calSent(id); s.add(key); try { fs.writeFileSync(calSentFile(id), JSON.stringify([...s].slice(-2000))); } catch {} };
const evWhen = (ev) => { const [y, mo, d] = String(ev.date).split('-').map(Number), [h, mi] = String(ev.time || '09:00').split(':').map(Number); return new Date(y, mo - 1, d, h, mi, 0, 0).getTime(); };
function calDeliver(id, payload) {
  let target = null;
  for (const [wcId, pid] of winProfile) {
    if (pid !== id) continue;
    const w = BrowserWindow.fromWebContents(webContents.fromId(wcId));
    if (!w) continue;
    if (!target || w.isFocused()) target = w;
  }
  if (!target) return false;
  target.webContents.send('cal-due', payload);
  return true;
}
function calPlan(id, startup) {
  (calTimers[id] || []).forEach(clearTimeout);
  calTimers[id] = [];
  const events = (storeFor(id).events || []).filter(ev => ev && ev.id && ev.date && ev.time);
  const sent = calSent(id), now = Date.now();
  for (const ev of events) {
    const at = evWhen(ev), remind = Math.max(0, +ev.remind || 0), fire = at - remind * 60000;
    const key = ev.id + '@' + ev.date + 'T' + ev.time + '-' + remind;
    if (sent.has(key) || isNaN(at)) continue;
    if (fire <= now) {
      // missed while Orchard was closed (or the time just hit): say it passed, but only within the last week
      if (now - at < 7 * 864e5) {
        const passed = at <= now - 60000;
        setTimeout(() => { if (calDeliver(id, { ...ev, passed, soon: !passed && remind > 0 })) calMark(id, key); }, startup ? 4000 : 50);
      } else calMark(id, key);
      continue;
    }
    const wait = fire - now;
    if (wait < 2147483000) calTimers[id].push(setTimeout(() => { if (calDeliver(id, { ...ev, passed: false, soon: remind > 0 })) calMark(id, key); }, wait));
  }
  // timers longer than ~24 days can't be set, so re-plan daily
  calTimers[id].push(setTimeout(() => calPlan(id), 24 * 3600 * 1000));
}
app.whenReady().then(() => setTimeout(() => { for (const p of profiles) if (storeFor(p.id).events) calPlan(p.id, true); }, 3000));
ipcMain.on('native-note', (e, n) => {
  try {
    if (!Notification.isSupported()) return;
    const w = BrowserWindow.fromWebContents(e.sender);
    const note = new Notification({ title: String(n.title || 'Orchard').slice(0, 80), body: String(n.body || '').slice(0, 200), icon: path.join(__dirname, 'icon.png') });
    note.on('click', () => { if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); w.webContents.send('note-click', n.action || ''); } });
    note.show();
  } catch {}
});

// ---------- slow down other apps on battery (Windows): priority + Efficiency mode ----------
const THROTTLE_SKIP = ['explorer', 'dwm', 'csrss', 'winlogon', 'lsass', 'services', 'smss', 'wininit', 'svchost', 'audiodg', 'ctfmon', 'sihost',
  'searchhost', 'searchapp', 'searchui', 'startmenuexperiencehost', 'shellexperiencehost', 'textinputhost', 'runtimebroker', 'fontdrvhost',
  'conhost', 'taskmgr', 'securityhealthsystray', 'securityhealthservice', 'applicationframehost', 'systemsettings', 'lockapp', 'msmpeng',
  'nissrv', 'powershell', 'pwsh', 'orchard', 'electron', 'dllhost', 'taskhostw', 'widgets', 'widgetservice', 'phoneexperiencehost',
  'gamebar', 'gamebarpresencewriter', 'useroobebroker', 'smartscreen', 'osk', 'magnify', 'narrator',
  // calls + music: slowing these can make audio stutter
  'spotify', 'discord', 'zoom', 'teams', 'ms-teams', 'msteams', 'skype', 'whatsapp', 'obs64', 'obs32', 'vlc', 'wmplayer',
  'microsoft.media.player', 'music.ui', 'itunes', 'amazon music', 'slack', 'webex', 'ciscocollabhost'];
let thr = null, thrBuf = '', thrTimer = null, thrQuitting = false;
let thrWant = { on: false, level: 0, exclude: [] };
const THR_TEST = process.env.ORCHARD_THROTTLE_TEST || '';   // test hook: a fake helper script (dev only)
let thrStatus = { supported: process.platform === 'win32' || !!THR_TEST, active: false, count: 0, apps: [] };
const thrWaiters = [];
function thrStart() {
  if (thr || !thrStatus.supported) return;
  try {
    if (THR_TEST) thr = require('child_process').spawn(process.execPath.includes('electron') ? 'node' : 'node', [THR_TEST], { stdio: ['pipe', 'pipe', 'ignore'] });
    else {
      const file = path.join(dataDir, 'throttle.ps1');
      fs.writeFileSync(file, fs.readFileSync(path.join(__dirname, 'throttle.ps1')));
      thr = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    }
  } catch { thr = null; return; }
  thrBuf = '';
  thr.stdout.setEncoding('utf8');
  thr.stdout.on('data', (d) => {
    thrBuf += d;
    let i;
    while ((i = thrBuf.indexOf('\n')) >= 0) {
      const line = thrBuf.slice(0, i).trim(); thrBuf = thrBuf.slice(i + 1);
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.op === 'applied') thrStatus = { ...thrStatus, active: true, count: +j.count || 0, apps: (Array.isArray(j.apps) ? j.apps : [j.apps]).filter(Boolean).map(String).slice(0, 60) };
      if (j.op === 'restored') { thrStatus = { ...thrStatus, active: false, count: 0, apps: [] }; thrWaiters.splice(0).forEach(f => f()); }
      BrowserWindow.getAllWindows().forEach(w => w.webContents.send('throttle-status', thrStatus));
    }
  });
  thr.on('exit', () => { thr = null; thrWaiters.splice(0).forEach(f => f()); });
  thr.on('error', () => { thr = null; });
}
const thrSend = (o) => { try { if (thr && thr.stdin.writable) thr.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
const thrOn = () => thrWant.on && thrWant.level >= 1;
function thrTick() {
  if (!thrOn()) return;
  thrStart();
  const own = [process.pid, ...app.getAppMetrics().map(x => x.pid)];
  thrSend({ op: 'apply', level: thrWant.level, exclude: thrWant.exclude, own });
}
let videoMode = { on: true, level: 0 };
ipcMain.on('orchard-video-mode', (e) => { e.returnValue = videoMode; });
ipcMain.on('video-mode', (e, w) => { videoMode = { on: !!(w && w.on), level: Math.max(0, Math.min(2, +(w && w.level) || 0)) }; });
ipcMain.on('throttle-set', (e, w) => {
  const before = { on: thrOn(), level: thrWant.level, ex: thrWant.exclude.join('|') };
  const user = (Array.isArray(w && w.exclude) ? w.exclude : []).map(x => String(x).toLowerCase().slice(0, 80)).slice(0, 200);
  thrWant = { on: !!(w && w.on), level: Math.max(0, Math.min(2, +(w && w.level) || 0)), exclude: [...new Set(THROTTLE_SKIP.concat(user))] };
  const now = thrOn();
  if (!now) { clearInterval(thrTimer); thrTimer = null; if (before.on && thr) thrSend({ op: 'restore' }); return; }
  if (!before.on || before.level !== thrWant.level || before.ex !== thrWant.exclude.join('|')) thrTick();
  if (!thrTimer) thrTimer = setInterval(thrTick, 60000);   // catch apps opened since
});
ipcMain.handle('throttle-status', () => thrStatus);
function thrShutdown() {
  return new Promise((res) => {
    if (!thr) return res();
    thrWaiters.push(res);
    thrSend({ op: 'quit' });
    setTimeout(res, 2500);
  });
}
app.on('will-quit', (e) => {
  if (thr && !thrQuitting) { e.preventDefault(); thrQuitting = true; thrShutdown().then(() => app.quit()); }
});

// ---------- password manager (encrypted with Windows' own safeStorage) ----------
const pwFileFor = (id) => path.join(dataDir, `passwords-${id}.json`);
const pwCache = {};
function pwLoad(id) {
  if (pwCache[id]) return pwCache[id];
  let list = [];
  try {
    const raw = JSON.parse(fs.readFileSync(pwFileFor(id), 'utf8'));
    list = (raw.items || []).map(it => {
      let pass = it.pass || '';
      if (it.enc && safeStorage.isEncryptionAvailable()) { try { pass = safeStorage.decryptString(Buffer.from(it.enc, 'base64')); } catch { pass = ''; } }
      return { origin: it.origin, user: it.user || '', pass, updated: it.updated || 0 };
    });
  } catch {}
  pwCache[id] = { list, never: new Set((() => { try { return JSON.parse(fs.readFileSync(pwFileFor(id), 'utf8')).never || []; } catch { return []; } })()) };
  return pwCache[id];
}
function pwSave(id) {
  const c = pwCache[id]; if (!c) return;
  const enc = safeStorage.isEncryptionAvailable();
  const items = c.list.map(it => { const o = { origin: it.origin, user: it.user, updated: it.updated }; if (enc) o.enc = safeStorage.encryptString(it.pass).toString('base64'); else o.pass = it.pass; return o; });
  try { fs.writeFileSync(pwFileFor(id), JSON.stringify({ items, never: [...c.never] })); } catch {}
}
const pwKey = (origin, user) => origin + '\u0000' + user;
// autofill: a page asks for logins saved for its origin
ipcMain.handle('pw-fill', (e, origin) => {
  const c = pwLoad(profileOf(e));
  origin = String(origin || '');
  return c.list.filter(it => it.origin === origin).sort((a, b) => b.updated - a.updated).map(it => ({ user: it.user, pass: it.pass }));
});
// a page submitted a login: offer to save it, unless it's unchanged or on the never list
ipcMain.on('pw-captured', (e, d) => {
  const id = profileOf(e), c = pwLoad(id);
  const origin = String(d && d.origin || ''), user = String(d && d.user || ''), pass = String(d && d.pass || '');
  if (!origin || !pass || !/^https?:/.test(origin)) return;
  if (c.never.has(origin)) return;
  const existing = c.list.find(it => it.origin === origin && it.user === user);
  if (existing && existing.pass === pass) return;
  sendTo(e.sender.hostWebContents, 'pw-offer', { origin, user, pass, update: !!existing });
});
ipcMain.handle('pw-store', (e, d) => {
  const id = profileOf(e); if (id === 'guest') return false;
  const c = pwLoad(id);
  const origin = String(d.origin || ''), user = String(d.user || ''), pass = String(d.pass || '');
  if (!origin || !pass) return false;
  const ex = c.list.find(it => it.origin === origin && it.user === user);
  if (ex) { ex.pass = pass; ex.updated = Date.now(); } else c.list.push({ origin, user, pass, updated: Date.now() });
  pwSave(id); return true;
});
ipcMain.handle('pw-never', (e, origin) => { const id = profileOf(e), c = pwLoad(id); c.never.add(String(origin || '')); pwSave(id); return true; });
ipcMain.handle('pw-list', (e) => { const c = pwLoad(profileOf(e)); return c.list.map(it => ({ origin: it.origin, user: it.user, len: it.pass.length, updated: it.updated })); });
ipcMain.handle('pw-reveal', (e, origin, user) => { const c = pwLoad(profileOf(e)); const it = c.list.find(x => x.origin === origin && x.user === user); return it ? it.pass : null; });
ipcMain.handle('pw-delete', (e, origin, user) => { const id = profileOf(e), c = pwLoad(id); c.list = c.list.filter(it => !(it.origin === origin && it.user === user)); pwSave(id); return true; });

app.on('window-all-closed', () => app.quit());

// ---------- chat panel visibility -> Codeline (so hidden chat does not mark messages read) ----------
ipcMain.on('chat-visible', async (e, wcId, visible) => {
  const wc = webContents.fromId(+wcId);
  if (!wc || wc.isDestroyed()) return;
  for (const f of wc.mainFrame.framesInSubtree) {
    try { await f.executeJavaScript(`typeof window.__orchardVisible === 'function' && (window.__orchardVisible(${visible ? 'true' : 'false'}), true)`); } catch {}
  }
});

// ---------- default browser (Windows) ----------
// Windows does not let apps make themselves the default. Orchard registers itself as a browser
// (so it appears in Windows' list), then opens Windows' own settings page for it.
const regRun = (args) => new Promise((res) => require('child_process').execFile('reg', args, { windowsHide: true }, (err, out) => res(err ? null : String(out))));
async function registerBrowser() {
  if (process.platform !== 'win32') return false;
  const exe = process.execPath, cmd = `"${exe}" "%1"`, icon = `"${exe}",0`;
  const C = 'HKCU\\Software\\Classes', K = 'HKCU\\Software\\Clients\\StartMenuInternet\\Orchard';
  const set = (key, name, val) => regRun(['add', key, ...(name === null ? ['/ve'] : ['/v', name]), '/t', 'REG_SZ', '/d', val, '/f']);
  const steps = [
    [C + '\\OrchardURL', null, 'Orchard URL'], [C + '\\OrchardURL', 'URL Protocol', ''],
    [C + '\\OrchardURL\\DefaultIcon', null, icon], [C + '\\OrchardURL\\shell\\open\\command', null, cmd],
    [C + '\\OrchardHTML', null, 'Orchard HTML Document'], [C + '\\OrchardHTML\\DefaultIcon', null, icon], [C + '\\OrchardHTML\\shell\\open\\command', null, cmd],
    [K, null, 'Orchard'], [K + '\\DefaultIcon', null, icon], [K + '\\shell\\open\\command', null, `"${exe}"`],
    [K + '\\Capabilities', 'ApplicationName', 'Orchard'], [K + '\\Capabilities', 'ApplicationDescription', 'The battery saving browser'], [K + '\\Capabilities', 'ApplicationIcon', icon],
    [K + '\\Capabilities\\URLAssociations', 'http', 'OrchardURL'], [K + '\\Capabilities\\URLAssociations', 'https', 'OrchardURL'],
    [K + '\\Capabilities\\FileAssociations', '.html', 'OrchardHTML'], [K + '\\Capabilities\\FileAssociations', '.htm', 'OrchardHTML'],
    [K + '\\Capabilities\\StartMenu', 'StartMenuInternet', 'Orchard'],
    ['HKCU\\Software\\RegisteredApplications', 'Orchard', 'Software\\Clients\\StartMenuInternet\\Orchard\\Capabilities'],
  ];
  for (const [k, n, v] of steps) await set(k, n, v);
  return true;
}
async function isDefaultBrowser() {
  if (process.platform !== 'win32') return null;
  const out = await regRun(['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']);
  return !!(out && /OrchardURL/i.test(out));
}
ipcMain.handle('default-browser-status', async () => ({ supported: process.platform === 'win32', isDefault: await isDefaultBrowser() }));
ipcMain.handle('default-browser-set', async () => {
  if (process.platform !== 'win32') return false;
  await registerBrowser();
  shell.openExternal('ms-settings:defaultapps?registeredAppUser=Orchard').catch(() => shell.openExternal('ms-settings:defaultapps'));
  return true;
});
// keep the registration pointing at the current Orchard.exe (what browser installers do)
app.whenReady().then(() => setTimeout(() => { lockReady.then(ok => { if (ok) registerBrowser(); }); }, 8000));

