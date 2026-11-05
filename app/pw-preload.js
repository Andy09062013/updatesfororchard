// Orchard password manager (runs inside every page).
// - Fills saved logins for this site.
// - When u submit a login, tells Orchard so it can offer to save it.
// Passwords are stored encrypted on this PC by the main process; this script
// only ever sees them for the site it's already running on.
const { ipcRenderer } = require('electron');
// right-click anywhere -> tell Orchard where (reliable page coords) and what was clicked
addEventListener('contextmenu', function (e) {
  try {
    var el = e.target, link = '';
    for (var a = el; a; a = a.parentElement) { if (a.tagName === 'A' && a.href) { link = a.href; break; } }
    var src = (el.tagName === 'IMG') ? (el.currentSrc || el.src || '') : '';
    var editable = !!(el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    var sel = String(getSelection ? getSelection() : '').slice(0, 300);
    ipcRenderer.sendToHost('orchard-context', { x: e.clientX, y: e.clientY, sel: sel, link: link, src: src, isEditable: editable, canCopy: !!sel, canPaste: editable, canCut: editable && !!sel });
  } catch (x) {}
}, true);
if (window.top === window && /^https?:$/.test(location.protocol)) {
  const origin = location.origin;
  const vis = (el) => el && el.offsetParent !== null && !el.disabled && el.type !== 'hidden';
  const pwFields = () => [...document.querySelectorAll('input[type=password]')].filter(vis);
  const userFor = (pw) => {
    const form = pw.form || document;
    const cands = [...form.querySelectorAll('input')].filter(vis).filter(i => i !== pw &&
      (/email|user|login|account|phone/i.test(i.name + ' ' + i.id + ' ' + (i.autocomplete || '')) || i.type === 'email' || i.type === 'text' || i.type === 'tel'));
    // prefer a field that sits just above the password box
    const before = cands.filter(i => pw.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING);
    return (before.length ? before[before.length - 1] : cands[0]) || null;
  };
  const setVal = (el, v) => {
    try {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch { el.value = v; }
  };

  let filledOnce = false;
  async function autofill() {
    const pws = pwFields();
    if (!pws.length) return;
    let saved;
    try { saved = await ipcRenderer.invoke('pw-fill', origin); } catch { return; }
    if (!saved || !saved.length) return;
    const pw = pws[0], userEl = userFor(pw);
    const pick = (userEl && userEl.value && saved.find(s => s.user === userEl.value)) || saved[0];
    if (!pick) return;
    if (userEl && !userEl.value) setVal(userEl, pick.user);
    if (!pw.value) setVal(pw, pick.pass);
    filledOnce = true;
  }

  let lastSent = '';
  function capture() {
    const pw = pwFields()[0] || [...document.querySelectorAll('input[type=password]')][0];
    if (!pw || !pw.value) return;
    const userEl = userFor(pw);
    const data = { origin, user: userEl ? userEl.value : '', pass: pw.value };
    const sig = data.user + '\u0000' + data.pass;
    if (sig === lastSent) return;
    lastSent = sig;
    try { ipcRenderer.send('pw-captured', data); } catch {}
  }

  // capture on form submit, on the Enter key in a password box, and on any button click near one
  addEventListener('submit', capture, true);
  addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target && e.target.type === 'password') capture(); }, true);
  addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button, input[type=submit], [role=button], a');
    if (b && pwFields().length) setTimeout(capture, 0);
  }, true);

  const start = () => { autofill(); };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start); else start();
  // single-page apps swap in a login form later, so re-check a few times
  let tries = 0;
  const iv = setInterval(() => { if (!filledOnce) autofill(); if (++tries > 6) clearInterval(iv); }, 1200);
}
