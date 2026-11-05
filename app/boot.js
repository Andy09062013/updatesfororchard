// Orchard bootstrap: runs the newest app code. Updates download into
// %APPDATA%/Orchard Updates/current; if that copy is newer than the one
// bundled with the exe it runs instead. A broken update falls back to the bundled copy.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const cmp = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1; }
  return 0;
};
const bundled = require('./package.json').version;
global.ORCHARD_BUNDLED_DIR = __dirname;

let target = __dirname, dir = null;
try {
  dir = path.join(app.getPath('appData'), 'Orchard Updates', 'current');
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (cmp(pj.version, bundled) > 0 && fs.existsSync(path.join(dir, 'main.js'))) target = dir;
} catch {}

try {
  require(path.join(target, 'main.js'));
} catch (e) {
  if (target === __dirname) throw e;
  // the downloaded update crashed on start: park it and run the bundled version
  try { fs.renameSync(dir, dir + '-broken-' + Date.now()); } catch {}
  require(path.join(__dirname, 'main.js'));
}
