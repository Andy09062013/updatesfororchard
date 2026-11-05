// Orchard video saver (runs before each page loads, only on battery).
// 1. Tells sites the VP8/VP9/AV1 video formats aren't available, so YouTube and others send H.264,
//    which almost every laptop decodes with its graphics chip instead of the CPU.
// 2. On YouTube, caps quality (720p in Saver, 480p in Ultra).
const { ipcRenderer, webFrame } = require('electron');
let mode = null;
try { mode = ipcRenderer.sendSync('orchard-video-mode'); } catch {}
if (mode && mode.on && mode.level >= 1) {
  const page = function (m) {
    const heavy = /vp0?8|vp0?9|av01/i;
    const wrapType = (obj, key) => {
      try {
        const orig = obj && obj[key];
        if (typeof orig !== 'function') return;
        obj[key] = function (t) { return heavy.test(String(t)) ? false : orig.call(this, t); };
      } catch {}
    };
    wrapType(window.MediaSource, 'isTypeSupported');
    wrapType(window.ManagedMediaSource, 'isTypeSupported');
    try {
      const cp = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (t) { return heavy.test(String(t)) ? '' : cp.call(this, t); };
    } catch {}
    try {
      const mc = navigator.mediaCapabilities;
      if (mc && mc.decodingInfo) {
        const di = mc.decodingInfo.bind(mc);
        mc.decodingInfo = (cfg) => {
          const ct = cfg && cfg.video && cfg.video.contentType;
          return heavy.test(String(ct || '')) ? Promise.resolve({ supported: false, smooth: false, powerEfficient: false }) : di(cfg);
        };
      }
    } catch {}
    if (/(^|\.)youtube\.com$/.test(location.hostname)) {
      const q = m.level >= 2 ? 'large' : 'hd720';   // large = 480p
      const cap = () => {
        const p = document.getElementById('movie_player');
        if (p && typeof p.setPlaybackQualityRange === 'function') { try { p.setPlaybackQualityRange(q, q); } catch {} }
      };
      document.addEventListener('yt-navigate-finish', () => setTimeout(cap, 800));
      window.addEventListener('load', () => setTimeout(cap, 1500));
      let n = 0; const iv = setInterval(() => { cap(); if (++n > 8) clearInterval(iv); }, 2500);
    }
  };
  try { webFrame.executeJavaScript('(' + page.toString() + ')(' + JSON.stringify({ level: mode.level }) + ')'); } catch {}
}
