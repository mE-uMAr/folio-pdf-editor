// Tiny zero-dependency static server for Folio PDF Editor. Binds to localhost only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5317;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.pdf': 'application/pdf',
};

/* ---- system font index: lets the editor complete subset-embedded fonts with the full installed font ---- */
const FONT_DIRS = [
  process.env.WINDIR && path.join(process.env.WINDIR, 'Fonts'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'),
  '/Library/Fonts', '/System/Library/Fonts', path.join(require('os').homedir(), 'Library', 'Fonts'),
  '/usr/share/fonts', '/usr/local/share/fonts', path.join(require('os').homedir(), '.fonts'),
].filter(Boolean);
let fontIndex = null;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function readNames(buf, base = 0) {
  const n = buf.readUInt16BE(base + 4);
  for (let i = 0; i < n; i++) {
    const o = base + 12 + i * 16;
    if (buf.toString('latin1', o, o + 4) !== 'name') continue;
    const t = buf.readUInt32BE(o + 8);
    const count = buf.readUInt16BE(t + 2), strOff = t + buf.readUInt16BE(t + 4);
    const names = {};
    for (let k = 0; k < count; k++) {
      const r = t + 6 + k * 12;
      const pid = buf.readUInt16BE(r), id = buf.readUInt16BE(r + 6), len = buf.readUInt16BE(r + 8), off = buf.readUInt16BE(r + 10);
      if (![1, 2, 4, 6, 16, 17].includes(id) || names[id]) continue;
      const raw = buf.subarray(strOff + off, strOff + off + len);
      names[id] = pid === 3 || pid === 0 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
    }
    return names;
  }
  return {};
}
function buildFontIndex() {
  const list = [];
  const walk = (dir, depth = 0) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) { walk(p, depth + 1); continue; }
      if (!/\.(ttf|otf)$/i.test(e.name)) continue;
      try {
        const fd = fs.openSync(p, 'r');
        const head = Buffer.alloc(65536);
        const got = fs.readSync(fd, head, 0, head.length, 0);
        fs.closeSync(fd);
        let buf = head.subarray(0, got);
        let names;
        try { names = readNames(buf); } catch { names = readNames(fs.readFileSync(p)); }
        if (!names[6] && !names[4]) names = readNames(fs.readFileSync(p));
        if (names[6] || names[4]) list.push({ ps: norm(names[6] || names[4]), full: norm(names[4]), family: names[16] || names[1] || '', style: names[17] || names[2] || '', file: p });
      } catch {}
    }
  };
  FONT_DIRS.forEach((d) => walk(d));
  return list;
}
function findFont(want) {
  if (!fontIndex) fontIndex = buildFontIndex();
  const w = norm(want).replace(/mt$|ps$/, '');
  if (!w) return null;
  const variants = (f) => [f.ps, f.ps.replace(/mt$|ps$/, ''), f.full, f.full.replace(/regular$/, '')];
  return fontIndex.find((f) => variants(f).includes(w)) ||
    fontIndex.find((f) => variants(f).some((v) => v === w + 'regular' || v === w + 'roman')) || null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/sysfont') {
    const f = findFont(url.searchParams.get('name'));
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'font/ttf', 'X-Font-Family': encodeURIComponent(f.family + (f.style && !/regular/i.test(f.style) ? ' ' + f.style : '')) });
    return fs.createReadStream(f.file).pipe(res);
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || file.includes('node_modules')) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log(`Port ${PORT} busy — Folio is probably already running.`); openBrowser(); }
  else console.error(e);
});

function openBrowser() {
  const url = `http://localhost:${PORT}/`;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  if (!process.argv.includes('--no-open')) exec(cmd);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Folio PDF Editor running at http://localhost:${PORT}/  (Ctrl+C to stop)`);
  openBrowser();
});
