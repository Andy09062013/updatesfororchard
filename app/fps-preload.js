// Orchard tab frame-rate cap (runs inside every page).
// Orchard tells it a target fps on battery; it throttles requestAnimationFrame
// so animations, canvas and game loops run slower, which cuts GPU/CPU work and
// saves battery. 0 = no cap (plugged in / Eco). Video playback isn't affected.
(function () {
  const { ipcRenderer } = require('electron');
  const raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
  if (!raf) return;

  let cap = 0;                 // frames per second, 0 = uncapped
  let queue = [];              // callbacks waiting for the next allowed frame
  let map = new Map();         // our id -> item
  let nextId = 1, looping = false, last = -1e9;

  function run(ts) {
    looping = false;
    if (cap > 0 && ts - last < 1000 / cap - 0.5) { pump(); return; } // too soon, wait
    last = ts;
    const due = queue; queue = [];
    for (const item of due) {
      map.delete(item.id);
      if (!item.cancelled) { try { item.cb(ts); } catch (e) {} }
    }
    if (queue.length) pump();
  }
  function pump() { if (!looping) { looping = true; raf(run); } }

  // always route through our queue so ids never mix native/ours when cap changes
  window.requestAnimationFrame = function (cb) {
    const id = nextId++;
    const item = { id: id, cb: cb, cancelled: false };
    map.set(id, item); queue.push(item); pump();
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    const item = map.get(id);
    if (item) { item.cancelled = true; map.delete(id); }
  };

  ipcRenderer.on('orchard-fps', function (e, n) { cap = (+n > 0) ? +n : 0; });
})();
