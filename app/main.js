const { app, BrowserWindow, ipcMain, session, Menu, shell, webContents, powerMonitor, net, clipboard, nativeImage, dialog } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

// battery friendly chromium flags: throttle timers in background pages hard
app.commandLine.appendSwitch('enable-features', 'IntensiveWakeUpThrottling:grace_period_seconds/10,AlignWakeUps');

// keep using the old Aura data folder so bookmarks/profiles carry over after the rename
try {
  const oldDir = path.join(app.getPath('appData'), 'Aura Browser');
  if (fs.existsSync(oldDir)) app.setPath('userData', oldDir);
} catch {}
const dataDir = app.getPath('userData');
const profilesFile = path.join(dataDir, 'profiles.json');
const COLORS = ['#e8432e', '#ffb83d', '#6cc35a', '#c0447a', '#f2752e', '#8a5a3c', '#4fa3d1', '#e4e45e'];

// ---------- profiles ----------
let profiles;
try { profiles = JSON.parse(fs.readFileSync(profilesFile, 'utf8')); } catch { profiles = null; }
if (!Array.isArray(profiles) || !profiles.length) profiles = [{ id: 'default', name: 'Me', color: COLORS[0] }];
else if (profiles[0].id === 'default' && profiles[0].color === '#a46bff') { profiles[0].color = COLORS[0]; }
function saveProfiles() { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(profilesFile, JSON.stringify(profiles)); } catch {} }
const getProfile = (id) => profiles.find(p => p.id === id);
// default profile keeps the old file + default session so v1.1 data carries over
const storeFileFor = (id) => path.join(dataDir, id === 'default' ? 'aura-data.json' : `aura-data-${id}.json`);
const partitionFor = (id) => (id === 'default' ? '' : `persist:profile-${id}`);
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
  if (!stores[id]) { try { stores[id] = JSON.parse(fs.readFileSync(storeFileFor(id), 'utf8')); } catch { stores[id] = defaultStore(); } }
  return stores[id];
}
function saveStore(id) { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(storeFileFor(id), JSON.stringify(stores[id])); } catch {} }

// ---------- adblock ----------
const AD_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
  'adnxs.com', 'ads.yahoo.com', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net',
  'amazon-adsystem.com', 'scorecardresearch.com', 'zedo.com', 'popads.net', 'propellerads.com',
  'adsrvr.org', 'moatads.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'adcolony.com',
  'quantserve.com', 'smartadserver.com', 'yieldmo.com', 'media.net', 'exoclick.com'
];
const blockedCount = {};
const hostOf = (wc) => { try { return wc && (wc.hostWebContents || wc); } catch { return null; } };
const sendTo = (wc, ch, d) => { if (wc && !wc.isDestroyed()) wc.send(ch, d); };

const setUp = new Set();
const downloads = new Map();
let dlId = 0;
function setupSession(id) {
  if (setUp.has(id)) return;
  setUp.add(id);
  const ses = sessionFor(id);
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    if (storeFor(id).settings.adblock) {
      try {
        const h = new URL(details.url).hostname;
        if (AD_HOSTS.some(a => h === a || h.endsWith('.' + a))) {
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
    const id = ++dlId;
    downloads.set(id, item);
    const info = (state) => ({ id, name: item.getFilename(), url: item.getURL(), received: item.getReceivedBytes(), total: item.getTotalBytes(), state, paused: item.isPaused(), path: item.getSavePath(), time: Date.now() });
    sendTo(host, 'dl', info('progressing'));
    let last = 0;
    item.on('updated', (ev, state) => { if (Date.now() - last > 250) { last = Date.now(); sendTo(host, 'dl', info(state)); } });
    item.once('done', (ev, state) => { sendTo(host, 'dl', info(state)); sendTo(host, 'download', { name: item.getFilename(), state, path: item.getSavePath() }); });
  });
}

// ---------- windows ----------
const openFile = path.join(dataDir, 'open-windows.json');
function rememberOpen() { try { fs.writeFileSync(openFile, JSON.stringify([...winProfile.values()])); } catch {} }
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
  win.on('closed', () => winProfile.delete(wcId));
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
  if (!firstWin) firstWin = win;
  return win;
}
const profileOf = (e) => winProfile.get(e.sender.id) || 'default';
const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
function windowFor(profileId) {
  for (const [wcId, pid] of winProfile) if (pid === profileId) { const w = BrowserWindow.fromWebContents(webContents.fromId(wcId)); if (w) return w; }
  return null;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // look like normal chrome so google/gemini logins dont freak out
  app.userAgentFallback = app.userAgentFallback.replace(/\s?(Electron|aura-browser|AuraBrowser|orchard-browser|Orchard)\/\S+/gi, '');
  const lastUsed = (() => { try { return fs.readFileSync(path.join(dataDir, 'last-profile'), 'utf8').trim(); } catch { return 'default'; } })();
  let reopen = [];
  try { reopen = JSON.parse(fs.readFileSync(openFile, 'utf8')).filter(id => getProfile(id)); } catch {}
  if (!reopen.length) reopen = [getProfile(lastUsed) ? lastUsed : profiles[0].id];
  const win = createWindow(reopen[0]);
  reopen.slice(1).forEach(id => createWindow(id));
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
    // orchard://tool/<name> links on the new tab page open browser features
    contents.on('will-navigate', (e, url) => {
      if (url.startsWith('orchard://')) { e.preventDefault(); sendTo(contents.hostWebContents, 'tool', url.replace('orchard://tool/', '').replace(/\/$/, '')); }
    });
    contents.on('before-input-event', (ev, input) => {
      if (input.type !== 'keyDown') return;
      const k = input.key.toLowerCase();
      if (input.control && ['t','w','l','r','d','h','tab','=','-','0','f','n','j'].includes(k) || k === 'f5' || k === 'f11' || k === 'f12' || (input.alt && (k === 'arrowleft' || k === 'arrowright' || k === 'g' || k === 'c' || k === 'f' || k === 'h'))) {
        ev.preventDefault();
        sendTo(contents.hostWebContents, 'shortcut', { key: k, ctrl: input.control, shift: input.shift, alt: input.alt });
      }
    });
  }
});

ipcMain.handle('store-get', (e) => {
  const id = profileOf(e);
  return { ...storeFor(id), profile: getProfile(id), partition: partitionFor(id), blocked: blockedCount[id] || 0 };
});
ipcMain.on('store-set', (e, data) => {
  const id = profileOf(e);
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
ipcMain.handle('profiles-list', () => profiles);
ipcMain.handle('profile-open', (e, id) => {
  if (!getProfile(id)) return false;
  try { fs.writeFileSync(path.join(dataDir, 'last-profile'), id); } catch {}
  const w = windowFor(id);
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); return true; }
  createWindow(id);
  return true;
});
ipcMain.handle('profile-new-window', (e) => { createWindow(profileOf(e)); return true; });
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
  for (const [wcId, pid] of winProfile) if (pid === id) sendTo(webContents.fromId(wcId), 'profile-changed', p);
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
    if (!r.ok) return { status: 'error', error: 'update server answered ' + r.status };
    const man = await r.json();
    if (!man || typeof man.version !== 'string' || !Array.isArray(man.files)) return { status: 'error', error: 'bad version.json' };
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
ipcMain.on('update-restart', () => { app.relaunch(); app.exit(0); });

app.on('window-all-closed', () => app.quit());
