// Unanchored — an Orchard extension.
// Floating UI (fixed/sticky bars, buttons, chat bubbles, popups) drops with
// gravity. Drag them, throw them, they bounce off the edges and still work
// when u tap them. Run the extension again to put everything back.
(function () {
  if (window.__unanchored) { window.__unanchored.stop(); return; }
  var GRAV = 0.9, BOUNCE = 0.45, AIR = 0.995, FLOORF = 0.84, MAX = 80;
  var bodies = [], seen = new WeakSet();
  var vw = function () { return window.innerWidth; }, vh = function () { return window.innerHeight; };

  function floating(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el === document.body || el === document.documentElement) return false;
    var cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky' && cs.position !== 'absolute') return false;
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    if (r.width > vw() * 0.92 && r.height > vh() * 0.92) return false; // full-screen overlay
    if (r.height > vh() * 0.96) return false; // tall page-height wrapper
    return true;
  }
  function place(b) { b.el.style.transform = 'translate(' + b.x + 'px,' + b.y + 'px) rotate(' + b.rot + 'deg)'; }

  function addBody(el) {
    if (bodies.length >= MAX || seen.has(el) || !floating(el)) return;
    for (var p = el.parentElement; p; p = p.parentElement) if (seen.has(p)) return;
    var r = el.getBoundingClientRect();
    seen.add(el);
    var b = { el: el, x: r.left, y: r.top, w: r.width, h: r.height, vx: (Math.random() - 0.5) * 2, vy: 0, rot: 0, vr: (Math.random() - 0.5) * 2, held: false, orig: el.getAttribute('style') || '' };
    var s = el.style;
    s.position = 'fixed'; s.margin = '0'; s.left = '0'; s.top = '0'; s.right = 'auto'; s.bottom = 'auto';
    s.width = r.width + 'px'; s.height = r.height + 'px'; s.zIndex = '2147482000'; s.willChange = 'transform';
    s.transition = 'none'; s.touchAction = 'none';
    place(b); drag(b); bodies.push(b);
  }

  function drag(b) {
    var el = b.el, moved = 0, sx = 0, sy = 0, last = [];
    el.addEventListener('pointerdown', function (e) {
      if (e.button) return;
      b.held = true; b.dragging = false; moved = 0; sx = e.clientX; sy = e.clientY;
      b.gx = e.clientX - b.x; b.gy = e.clientY - b.y; last = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
    }, true);
    el.addEventListener('pointermove', function (e) {
      if (!b.held) return;
      moved += Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy); sx = e.clientX; sy = e.clientY;
      b.x = e.clientX - b.gx; b.y = e.clientY - b.gy; b.vx = 0; b.vy = 0;
      last.push({ x: e.clientX, y: e.clientY, t: performance.now() }); if (last.length > 5) last.shift();
      if (moved > 6) { b.dragging = true; place(b); e.preventDefault(); }
    }, true);
    function up(e) {
      if (!b.held) return;
      b.held = false;
      try { el.releasePointerCapture(e.pointerId); } catch (x) {}
      if (b.dragging && last.length > 1) {
        var a = last[0], z = last[last.length - 1], dt = Math.max(16, z.t - a.t);
        b.vx = (z.x - a.x) / dt * 16; b.vy = (z.y - a.y) / dt * 16; b.vr = b.vx * 0.3;
      }
      if (moved > 6) { b.noClick = true; setTimeout(function () { b.noClick = false; }, 60); }
    }
    el.addEventListener('pointerup', up, true);
    el.addEventListener('pointercancel', up, true);
    // a real tap passes through; a throw swallows the click it would fire
    el.addEventListener('click', function (e) { if (b.noClick) { e.preventDefault(); e.stopPropagation(); } }, true);
  }

  var raf;
  function tick() {
    var W = vw(), H = vh();
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      if (b.held) { place(b); continue; }
      b.vy += GRAV; b.vx *= AIR; b.x += b.vx; b.y += b.vy; b.rot += b.vr; b.vr *= 0.98;
      var floor = H - b.h;
      if (b.y > floor) { b.y = floor; if (Math.abs(b.vy) > 1.2) b.vy = -b.vy * BOUNCE; else { b.vy = 0; } b.vx *= FLOORF; b.vr *= 0.7; }
      if (b.y < 0) { b.y = 0; b.vy = -b.vy * BOUNCE; }
      if (b.x < 0) { b.x = 0; b.vx = -b.vx * BOUNCE; b.vr = -b.vr; }
      if (b.x > W - b.w) { b.x = W - b.w; b.vx = -b.vx * BOUNCE; b.vr = -b.vr; }
      place(b);
    }
    raf = requestAnimationFrame(tick);
  }

  function scan() { var all = document.querySelectorAll('*'); for (var i = 0; i < all.length; i++) addBody(all[i]); }
  scan();
  var mo;
  try {
    mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) for (var j = 0; j < muts[i].addedNodes.length; j++) {
        var n = muts[i].addedNodes[j];
        if (n.nodeType === 1) { addBody(n); if (n.querySelectorAll) { var k = n.querySelectorAll('*'); for (var q = 0; q < k.length; q++) addBody(k[q]); } }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (x) {}
  var rescans = 0, ri = setInterval(function () { scan(); if (++rescans > 6) clearInterval(ri); }, 1000);
  raf = requestAnimationFrame(tick);

  var t = document.createElement('div');
  t.textContent = '⚓ Unanchored on — run it again to stop';
  t.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;background:#1b1211;color:#ffb83d;font:600 13px system-ui,sans-serif;padding:8px 14px;border-radius:10px;box-shadow:0 8px 24px #0007;pointer-events:none;transition:opacity .4s';
  document.documentElement.appendChild(t);
  setTimeout(function () { t.style.opacity = '0'; }, 2500);
  setTimeout(function () { if (t.parentNode) t.remove(); }, 3100);

  window.__unanchored = { stop: function () {
    cancelAnimationFrame(raf); clearInterval(ri); try { mo && mo.disconnect(); } catch (x) {}
    for (var i = 0; i < bodies.length; i++) bodies[i].el.setAttribute('style', bodies[i].orig);
    bodies = []; window.__unanchored = null;
  } };
})();
