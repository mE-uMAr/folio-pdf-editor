/* Folio PDF Editor
 * Existing-text editing is exact: glyphs are re-drawn with the PDF's own embedded font program, at their
 * original text matrices and colours, and the original glyphs are removed from the content stream (their
 * advance is preserved so nothing else moves). Everything runs locally.
 */
'use strict';

const {
  PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle, PDFName, PDFHexString,
  pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextMatrix, showText,
  setFillingRgbColor, setStrokingRgbColor, setTextRenderingMode, setLineWidth,
} = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
const OPS = pdfjsLib.OPS;
const PDFJS_OPTS = { cMapUrl: 'vendor/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/standard_fonts/', fontExtraProperties: true };

/* ---------------------------------------------------------------- helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const I = [1, 0, 0, 1, 0, 0];
// m1·m2 — apply m2 first, then m1 (same convention as pdf.js Util.transform)
const mul = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const hex2rgb = (h) => { const n = parseInt((h || '#000000').slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgb2hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
const pdfColor = (h) => { const [r, g, b] = hex2rgb(h); return rgb(r / 255, g / 255, b / 255); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toU8 = (d) => (d instanceof Uint8Array ? d : new Uint8Array(d));

/* ---------------------------------------------------------------- state */
const LINE_H = 1.2;
const STD_CSS = {
  Helvetica: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
  Times: '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
};
const STD_FONTS = {
  Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

const S = {
  sources: [], pages: [], zoom: 1, zoomMode: 'fitw', tool: 'select', sel: null, editing: null,
  fileName: 'document.pdf', fileHandle: null, images: {}, dirty: false, clip: null, fx: { bw: false, scan: false },
  defaults: {
    text: { font: 'Helvetica', size: 14, bold: false, italic: false, underline: false, color: '#111111', align: 'left', opacity: 1 },
    whiteout: { fill: '#ffffff', stroke: null, sw: 1, opacity: 1 },
    highlight: { fill: '#ffd400', stroke: null, sw: 1, opacity: 0.45 },
    rect: { fill: null, stroke: '#d93025', sw: 2, opacity: 1 },
    ellipse: { fill: null, stroke: '#d93025', sw: 2, opacity: 1 },
    line: { stroke: '#d93025', sw: 2, opacity: 1, arrow: false },
    arrow: { stroke: '#d93025', sw: 2, opacity: 1, arrow: true },
    draw: { stroke: '#1a3fb8', sw: 2, opacity: 1 },
    cut: { close: true },
  },
};
// runtime caches (never part of undo history)
const RT = {
  models: new Map(), libDocs: new Map(), fonts: new Map(), customFonts: new Map(), geoms: new Map(),
  previews: new Map(), imgUrls: new Map(), baselines: new Map(), observer: null, thumbObserver: null,
};

const R = (pg) => (((pg.baseRot + pg.rot) % 360) + 360) % 360;
const dispSize = (pg) => (R(pg) % 180 ? [pg.h, pg.w] : [pg.w, pg.h]);
const pageEl = (id) => $(`.page[data-id="${id}"]`);
const pageById = (id) => S.pages.find((p) => p.id === id);
function findObj(id) {
  for (const pg of S.pages) { const o = pg.objects.find((x) => x.id === id); if (o) return { pg, o }; }
  return null;
}
function viewportFor(pg, scale = 1) {
  // A pdf.js-compatible viewport transform built from our own page geometry (works for blank pages too).
  const [x0, y0, w, h] = [pg.x0, pg.y0, pg.w, pg.h];
  const r = R(pg);
  let m;
  if (r === 0) m = [1, 0, 0, -1, -x0, y0 + h];
  else if (r === 90) m = [0, 1, 1, 0, -y0, -x0];
  else if (r === 180) m = [-1, 0, 0, 1, x0 + w, -y0];
  else m = [0, -1, -1, 0, y0 + h, x0 + w];
  return m.map((v) => v * scale);
}

/* ---------------------------------------------------------------- toast / ask */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function ask(title, msg, buttons) {
  return new Promise((resolve) => {
    $('#askTitle').textContent = title; $('#askMsg').textContent = msg;
    const box = $('#askBtns'); box.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
      el.textContent = b.label;
      el.onclick = () => { $('#askModal').hidden = true; resolve(b.value); };
      box.appendChild(el);
    }
    $('#askModal').hidden = false;
    box.lastChild?.focus();
  });
}

/* ---------------------------------------------------------------- history */
const H = { stack: [], i: -1 };
const snap = () => JSON.stringify(S.pages);
const structKey = () => S.pages.map((p) => p.id + ':' + R(p)).join('|');
function resetHistory() { H.stack = [snap()]; H.i = 0; updateUndo(); }
function commit() {
  const s = snap();
  if (s === H.stack[H.i]) return;
  H.stack = H.stack.slice(0, H.i + 1); H.stack.push(s);
  if (H.stack.length > 200) H.stack.shift();
  H.i = H.stack.length - 1;
  setDirty(true); updateUndo();
}
function restore(s) {
  const before = structKey();
  S.pages = JSON.parse(s);
  if (S.sel && !findObj(S.sel)) S.sel = null;
  if (structKey() !== before) buildViewer();
  else S.pages.forEach((pg) => { renderLayer(pg); refreshCanvas(pg); if (S.tool === 'edit') renderHits(pg); });
  renderProps(); setDirty(true);
}
function undo() { endEdit(); if (H.i > 0) { H.i--; restore(H.stack[H.i]); updateUndo(); } }
function redo() { endEdit(); if (H.i < H.stack.length - 1) { H.i++; restore(H.stack[H.i]); updateUndo(); } }
function updateUndo() { $('#btnUndo').disabled = H.i <= 0; $('#btnRedo').disabled = H.i >= H.stack.length - 1; }
function setDirty(v) { S.dirty = v; $('#dirtyDot').hidden = !v; }

/* ================================================================ LOADING */
async function loadSource(bytes, name) {
  const doc = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice() }).promise;
  const src = S.sources.length;
  S.sources.push({ bytes, doc, name });
  const pages = [];
  for (let i = 0; i < doc.numPages; i++) {
    const p = await doc.getPage(i + 1);
    const [x0, y0, x1, y1] = p.view;
    pages.push({ id: uid(), src, index: i, baseRot: p.rotate || 0, rot: 0, w: x1 - x0, h: y1 - y0, x0, y0, blank: false, objects: [] });
  }
  return pages;
}
async function openBytes(bytes, name, handle = null) {
  try {
    endEdit();
    for (const s of S.sources) s.doc.destroy();
    for (const p of RT.previews.values()) p.doc?.destroy?.();
    Object.assign(RT, { models: new Map(), libDocs: new Map(), fonts: new Map(), previews: new Map(), geoms: new Map() });
    S.sources = []; S.images = {}; S.sel = null;
    setFx('bw', false, true); setFx('scan', false, true);
    S.pages = await loadSource(bytes, name);
    S.fileName = name; S.fileHandle = handle;
    $('#fileName').textContent = name; document.title = name + ' — Folio';
    $('#welcome').hidden = true;
    ['#btnMerge', '#btnSave', '#btnSaveAs', '#btnFind', '#btnAddPage', '#fxBw', '#fxScan'].forEach((s) => ($(s).disabled = false));
    S.zoomMode = 'fitw'; S.zoom = computeFitZoom('fitw');
    buildViewer(); resetHistory(); setDirty(false); renderProps();
    $('#viewport').scrollTop = 0;
    setTool(S.tool);
  } catch (e) {
    console.error(e);
    if (e?.name === 'PasswordException') toast('This PDF is password-protected. Remove the password first, then open it here.', 5000);
    else toast('Could not open this file: ' + (e?.message || e), 5000);
  }
}
async function openFile(file, handle = null) {
  if (!(await confirmDiscard())) return;
  await openBytes(new Uint8Array(await file.arrayBuffer()), file.name, handle);
}
async function confirmDiscard() {
  if (!S.dirty) return true;
  return await ask('Discard unsaved changes?', 'The current document has edits that have not been saved.', [
    { label: 'Cancel', value: false }, { label: 'Discard', value: true, danger: true },
  ]);
}
async function mergeFiles(files) {
  endEdit();
  let added = 0;
  for (const f of files) {
    try { const pages = await loadSource(new Uint8Array(await f.arrayBuffer()), f.name); S.pages.push(...pages); added += pages.length; }
    catch (e) { toast(`Could not merge ${f.name}: ${e.message}`, 4000); }
  }
  if (added) { buildViewer(); commit(); toast(`Added ${added} page${added > 1 ? 's' : ''}`); }
}
const getPdfPage = (pg) => S.sources[pg.src].doc.getPage(pg.index + 1);
function getLibDoc(src) {
  if (!RT.libDocs.has(src)) RT.libDocs.set(src, PDFDocument.load(S.sources[src].bytes, { ignoreEncryption: true, updateMetadata: false }));
  return RT.libDocs.get(src);
}

/* ================================================================ TEXT MODEL
 * We interpret pdf.js's operator list ourselves to know, for every glyph: its exact text rendering
 * matrix (user space), font, colour, spacing, and which content-stream show operator produced it. */
function fontObj(page, name) { try { return page.commonObjs.get(name); } catch { return null; } }
function colorOf(a) {
  if (typeof a[0] === 'string') return a[0];
  return rgb2hex(a[0], a[1], a[2]);
}
function styleFromName(n) {
  n = n || '';
  const bold = /bold|black|heavy|semibold|demi/i.test(n);
  const italic = /italic|oblique/i.test(n);
  let family = 'Helvetica';
  if (/courier|mono|consol/i.test(n)) family = 'Courier';
  else if (/times|roman|georgia|garamond|cambria|minion|palatino|book|serif/i.test(n) && !/sans/i.test(n)) family = 'Times';
  return { family, bold, italic };
}
const stdKey = (st) => STD_FONTS[st.family][(st.bold ? 1 : 0) + (st.italic ? 2 : 0)];

async function getModel(pg) {
  if (pg.blank) return { lines: [], glyphs: [], shows: [], styles: [] };
  const key = pg.src + ':' + pg.index;
  if (!RT.models.has(key)) RT.models.set(key, buildModel(pg).catch((e) => { console.error(e); return { lines: [], glyphs: [], shows: [], styles: [] }; }));
  return RT.models.get(key);
}

async function buildModel(pg) {
  const page = await getPdfPage(pg);
  const opl = await page.getOperatorList({ annotationMode: pdfjsLib.AnnotationMode.DISABLE });
  const { fnArray, argsArray } = opl;
  let st = { ctm: I, fill: '#000000', stroke: '#000000', lw: 1, font: null, size: 0, Tc: 0, Tw: 0, Th: 1, rise: 0, lead: 0, Tr: 0 };
  const stack = []; let Tm = I, Tlm = I, depth = 0, showIdx = 0;
  const glyphs = [], shows = [], styles = [], styleIndex = new Map();
  const fontNames = new Set();

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i] || [];
    switch (fn) {
      case OPS.save: stack.push({ ...st }); break;
      case OPS.restore: if (stack.length) st = stack.pop(); break;
      case OPS.transform: st.ctm = mul(st.ctm, a); break;
      case OPS.paintFormXObjectBegin: stack.push({ ...st }); depth++; if (Array.isArray(a[0]) || ArrayBuffer.isView(a[0])) st.ctm = mul(st.ctm, [...a[0]]); break;
      case OPS.paintFormXObjectEnd: if (stack.length) st = stack.pop(); depth = Math.max(0, depth - 1); break;
      case OPS.beginText: Tm = Tlm = I; break;
      case OPS.setFont: st.font = a[0]; st.size = a[1]; break;
      case OPS.setTextMatrix: Tm = Tlm = (a.length >= 6 ? [...a] : [...a[0]]).slice(0, 6); break;
      case OPS.moveText: Tlm = mul(Tlm, [1, 0, 0, 1, a[0], a[1]]); Tm = Tlm; break;
      case OPS.setLeadingMoveText: st.lead = -a[1]; Tlm = mul(Tlm, [1, 0, 0, 1, a[0], a[1]]); Tm = Tlm; break;
      case OPS.nextLine: Tlm = mul(Tlm, [1, 0, 0, 1, 0, -st.lead]); Tm = Tlm; break;
      case OPS.setLeading: st.lead = a[0]; break;
      case OPS.setCharSpacing: st.Tc = a[0]; break;
      case OPS.setWordSpacing: st.Tw = a[0]; break;
      case OPS.setHScale: st.Th = a[0] / 100; break;
      case OPS.setTextRise: st.rise = a[0]; break;
      case OPS.setTextRenderingMode: st.Tr = a[0]; break;
      case OPS.setFillRGBColor: st.fill = colorOf(a); break;
      case OPS.setStrokeRGBColor: st.stroke = colorOf(a); break;
      case OPS.setLineWidth: st.lw = a[0]; break;
      case OPS.showText: case OPS.showSpacedText: {
        const arr = a[0] || [];
        const fo = fontObj(page, st.font);
        const Tfs = st.size;
        const fm0 = fo?.fontMatrix?.[0] ?? 0.001;
        const op = depth === 0 ? showIdx++ : -1;
        const bad = !fo || fo.isType3Font || fo.vertical || Tfs <= 0 || Math.abs(fm0 - 0.001) > 1e-6;
        if (st.font) fontNames.add(st.font);
        const sk = [st.font, Tfs, st.Tc, st.Tw, st.Th, st.rise, st.fill, st.stroke, st.Tr, st.lw].join('|');
        if (!styleIndex.has(sk)) { styleIndex.set(sk, styles.length); styles.push({ font: st.font, Tfs, Tc: st.Tc, Tw: st.Tw, Th: st.Th, rise: st.rise, fill: st.fill, stroke: st.stroke, Tr: st.Tr, lw: st.lw }); }
        const si = styleIndex.get(sk);
        const Tm0 = Tm;
        let x = 0;
        for (const g of arr) {
          if (typeof g === 'number') { x += (-g * Tfs) / 1000; continue; }
          if (!g) continue;
          const spacing = (g.isSpace ? st.Tw : 0) + st.Tc;
          const cw = g.width * Tfs * fm0 + spacing;
          const M = mul(st.ctm, mul(Tm, [Tfs * st.Th, 0, 0, Tfs, x * st.Th, st.rise]));
          glyphs.push({
            u: g.unicode || '', fc: g.fontChar || '', w: g.width * fm0, adv: Tfs ? cw / Tfs : 0, M, si, op, depth,
            bad, isSpace: !!g.isSpace, inv: st.Tr === 3 || st.Tr === 7,
          });
          x += cw;
        }
        if (op >= 0) shows[op] = { Tfs, x, Th: st.Th, ctm: st.ctm, Tm: Tm0, Tlm };
        Tm = mul(Tm, [1, 0, 0, 1, x * st.Th, 0]);
        break;
      }
    }
  }
  // font metadata (embedded program → rebuilt with a unicode cmap)
  for (const n of fontNames) await ensureFontInfo(page, n, glyphs, styles);
  const lines = groupLines(glyphs, styles, page);
  return { lines, glyphs, shows, styles, showCount: showIdx };
}

function groupLines(glyphs, styles, page) {
  const lines = [];
  let cur = null, prev = null;
  const axis = (g) => [g.M[0], g.M[1]];
  const em = (g) => Math.hypot(g.M[2], g.M[3]) || 1;
  for (let gi = 0; gi < glyphs.length; gi++) {
    const g = glyphs[gi];
    let join = false, gapEm = 0;
    if (cur && prev && !g.bad && !prev.bad) {
      const [ax, ay] = axis(prev), al = Math.hypot(ax, ay) || 1;
      const dir = [ax / al, ay / al];
      const [bx, by] = axis(g), bl = Math.hypot(bx, by) || 1;
      const sameDir = Math.abs(dir[0] * by / bl - dir[1] * bx / bl) < 0.02 && dir[0] * bx + dir[1] * by > 0;
      const ex = prev.M[4] + prev.adv * ax, ey = prev.M[5] + prev.adv * ay;
      const dx = g.M[4] - ex, dy = g.M[5] - ey;
      const along = dx * dir[0] + dy * dir[1], perp = -dx * dir[1] + dy * dir[0];
      const size = em(prev);
      gapEm = along / size;
      join = sameDir && Math.abs(perp) < 0.35 * size && gapEm > -0.6 && gapEm < 1.6 && g.inv === prev.inv;
    }
    if (!join) {
      cur = { units: [], glyphIdx: [] }; lines.push(cur);
    } else if (gapEm > 0.12 && !prev.isSpace && !g.isSpace && prev.u !== ' ' && g.u !== ' ') {
      // implicit word space (positioned with Td / TJ rather than a space glyph)
      const pu = cur.units[cur.units.length - 1];
      const [ax, ay] = axis(prev);
      const len = Math.hypot(ax, ay) || 1;
      const gapAdv = (gapEm * em(prev)) / len;
      cur.units.push({ t: ' ', syn: true, M: [prev.M[0], prev.M[1], prev.M[2], prev.M[3], prev.M[4] + prev.adv * ax, prev.M[5] + prev.adv * ay], adv: gapAdv, gap: 0, si: prev.si, gi: -1 });
      pu.gap = 0;
    }
    const u = { t: g.u || '\uFFFD', M: g.M, adv: g.adv, gap: 0, si: g.si, gi, fc: g.fc };
    // gap from previous real unit to this one (kerning / justification) — stored on the previous unit
    const last = cur.units[cur.units.length - 1];
    if (last && !last.syn) {
      const [ax, ay] = [last.M[0], last.M[1]];
      const l2 = ax * ax + ay * ay || 1;
      last.gap = ((g.M[4] - (last.M[4] + last.adv * ax)) * ax + (g.M[5] - (last.M[5] + last.adv * ay)) * ay) / l2;
    }
    cur.units.push(u); cur.glyphIdx.push(gi);
    prev = g;
  }
  return lines.map((ln, key) => {
    const gl = ln.glyphIdx.map((i) => glyphs[i]);
    const text = ln.units.map((u) => u.t).join('');
    const bad = gl.some((g) => g.bad) || gl.every((g) => g.inv);
    const garbled = [...text].filter((c) => c === '\uFFFD' || (c >= '\uE000' && c <= '\uF8FF')).length > text.length * 0.3;
    const ops = new Set(gl.map((g) => g.op));
    const removable = gl.every((g) => g.op >= 0);
    return { key, units: ln.units, text, editable: !bad && !garbled && text.trim().length > 0, ops, removable, glyphIdx: ln.glyphIdx };
  });
}

/* ---- fonts: embedded programs get a unicode cmap so the browser and pdf-lib can type with them ---- */
async function ensureFontInfo(page, name, glyphs, styles) {
  if (RT.fonts.has(name)) return RT.fonts.get(name);
  const fo = fontObj(page, name);
  const psName = (fo?.name || '').replace(/^[A-Z]{6}\+/, '');
  const style = styleFromName(psName + ' ' + (fo?.fallbackName || ''));
  if (fo?.bold || fo?.black) style.bold = true;
  if (fo?.italic) style.italic = true;
  if (fo?.isMonospace) style.family = 'Courier'; else if (fo?.isSerifFont && style.family === 'Helvetica') style.family = 'Times';
  const info = {
    name, psName, style, fk: null, data: null, uni2gid: new Map(), fc2gid: new Map(), widths: new Map(),
    css: null, embedded: !!(fo?.data && !fo.missingFile), type3: !!fo?.isType3Font,
    // non-subset standard-14 names: re-reference the same standard font instead of embedding a stand-in
    std14: /^(Helvetica|Times|Courier)(-(Bold|Oblique|BoldOblique|Roman|Italic|BoldItalic))?$/i.test(psName) && !/^[A-Z]{6}\+/.test(fo?.name || ''),
    ascent: fo?.ascent || 0.8, descent: fo?.descent || -0.2,
  };
  RT.fonts.set(name, info);
  if (!info.std14 && !info.type3) await loadSystemFont(info);
  // observed unicode → width from this document
  const si = new Set(styles.map((s, i) => (s.font === name ? i : -1)).filter((i) => i >= 0));
  const obs = new Map();
  for (const g of glyphs) if (si.has(g.si) && g.u && [...g.u].length === 1 && g.fc) { obs.set(g.u.codePointAt(0), g.fc.codePointAt(0)); info.widths.set(g.u, g.w); }
  if (info.embedded && !info.type3) {
    try {
      const data = toU8(fo.data);
      const fk = fontkit.create(data);
      const u2fc = new Map();
      const tfc = fo.toFontChar, tu = fo.toUnicode;
      if (tu && tfc) {
        if (tu._map) tu._map.forEach((u, code) => {
          if (typeof u === 'string' && [...u].length === 1 && tfc[code] != null) u2fc.set(u.codePointAt(0), tfc[code]);
        });
        else if (tu.firstChar != null) for (let c = tu.firstChar; c <= tu.lastChar; c++) if (tfc[c] != null) u2fc.set(c, tfc[c]);
      }
      for (const [u, fc] of obs) u2fc.set(u, fc);
      for (const [u, fc] of u2fc) {
        let gid = 0;
        try { gid = fk.glyphForCodePoint(fc)?.id || 0; } catch {}
        if (gid > 0) { info.uni2gid.set(u, gid); info.fc2gid.set(fc, gid); }
      }
      for (const [, fc] of obs) if (!info.fc2gid.has(fc)) { try { const gid = fk.glyphForCodePoint(fc)?.id || 0; if (gid) info.fc2gid.set(fc, gid); } catch {} }
      info.fk = fk;
      info.upm = fk.unitsPerEm || 1000;
      try {
        info.data = rebuildCmap(data, info.uni2gid);
        const fam = 'pdffont_' + name.replace(/\W/g, '_');
        const face = new FontFace(fam, info.data);
        await face.load(); document.fonts.add(face);
        info.css = `"${fam}"`;
      } catch (e) { console.warn('cmap rebuild failed for', psName, e); info.data = data; }
    } catch (e) { console.warn('font parse failed', psName, e); }
  }
  return info;
}

// Ask the local server for the full installed version of this font (fills characters missing from subsets).
const sysFontCache = new Map();
async function loadSystemFont(info) {
  const want = (info.psName || '').replace(/-\d{4}$/, '');
  if (!want || location.protocol === 'file:') return;
  if (!sysFontCache.has(want)) sysFontCache.set(want, (async () => {
    try {
      const r = await fetch('/api/sysfont?name=' + encodeURIComponent(want));
      if (!r.ok) return null;
      const bytes = new Uint8Array(await r.arrayBuffer());
      const fk = fontkit.create(bytes);
      const family = 'sys_' + want.replace(/\W/g, '_');
      const face = new FontFace(family, bytes);
      await face.load(); document.fonts.add(face);
      return { family, label: decodeURIComponent(r.headers.get('X-Font-Family') || want), bytes, fk, ps: '' };
    } catch (e) { console.warn('system font lookup failed', want, e); return null; }
  })());
  info.sysFont = await sysFontCache.get(want);
}

// Replace (or add) the 'cmap' table of an sfnt so it maps Unicode → the same glyph ids.
function rebuildCmap(data, uni2gid) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sfntVersion = dv.getUint32(0);
  const numTables = dv.getUint16(4);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const o = 12 + 16 * i;
    const tag = String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]);
    const off = dv.getUint32(o + 8), len = dv.getUint32(o + 12);
    if (tag !== 'cmap') tables.push({ tag, bytes: data.subarray(off, off + len) });
  }
  tables.push({ tag: 'cmap', bytes: buildCmapTable(uni2gid) });
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const n = tables.length;
  let size = 12 + 16 * n;
  for (const t of tables) size += (t.bytes.length + 3) & ~3;
  const out = new Uint8Array(size);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, sfntVersion); ov.setUint16(4, n);
  const es = Math.floor(Math.log2(n)), sr = 2 ** es * 16;
  ov.setUint16(6, sr); ov.setUint16(8, es); ov.setUint16(10, n * 16 - sr);
  let off = 12 + 16 * n;
  tables.forEach((t, i) => {
    const o = 12 + 16 * i;
    for (let k = 0; k < 4; k++) out[o + k] = t.tag.charCodeAt(k);
    let sum = 0;
    const padded = (t.bytes.length + 3) & ~3;
    out.set(t.bytes, off);
    for (let k = 0; k < padded; k += 4) sum = (sum + ((out[off + k] << 24) | (out[off + k + 1] << 16) | (out[off + k + 2] << 8) | out[off + k + 3])) >>> 0;
    ov.setUint32(o + 4, sum); ov.setUint32(o + 8, off); ov.setUint32(o + 12, t.bytes.length);
    off += padded;
  });
  return out;
}
function buildCmapTable(map) {
  const entries = [...map].filter(([u, g]) => u > 0 && g > 0).sort((a, b) => a[0] - b[0]);
  // format 4 (BMP) — merge runs with a constant delta
  const bmp = entries.filter(([u]) => u < 0xffff);
  const segs = [];
  for (const [u, g] of bmp) {
    const s = segs[segs.length - 1];
    if (s && u === s.end + 1 && g - u === s.delta) s.end = u;
    else segs.push({ start: u, end: u, delta: g - u });
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 });
  const segX2 = segs.length * 2;
  const f4len = 16 + segs.length * 8;
  const useF4 = f4len < 65535;
  // format 12 (all planes)
  const groups = [];
  for (const [u, g] of entries) {
    const s = groups[groups.length - 1];
    if (s && u === s.end + 1 && g === s.gid + (u - s.start)) s.end = u;
    else groups.push({ start: u, end: u, gid: g });
  }
  const f12len = 16 + groups.length * 12;
  const nSub = useF4 ? 2 : 1;
  const hdr = 4 + nSub * 8;
  const total = hdr + (useF4 ? f4len : 0) + f12len;
  const b = new Uint8Array(total + ((4 - (total % 4)) % 4));
  const v = new DataView(b.buffer);
  v.setUint16(0, 0); v.setUint16(2, nSub);
  let p = 4, tOff = hdr;
  if (useF4) { v.setUint16(p, 3); v.setUint16(p + 2, 1); v.setUint32(p + 4, tOff); p += 8; }
  v.setUint16(p, 3); v.setUint16(p + 2, 10); v.setUint32(p + 4, tOff + (useF4 ? f4len : 0));
  if (useF4) {
    let o = tOff;
    v.setUint16(o, 4); v.setUint16(o + 2, f4len); v.setUint16(o + 4, 0); v.setUint16(o + 6, segX2);
    const es = Math.floor(Math.log2(segs.length)), sr = 2 * 2 ** es;
    v.setUint16(o + 8, sr); v.setUint16(o + 10, es); v.setUint16(o + 12, segX2 - sr);
    o += 14;
    segs.forEach((s, i) => v.setUint16(o + i * 2, s.end));
    o += segX2 + 2; // reservedPad
    segs.forEach((s, i) => v.setUint16(o + i * 2, s.start));
    o += segX2;
    segs.forEach((s, i) => v.setUint16(o + i * 2, (s.delta + 65536) % 65536));
    o += segX2;
    segs.forEach((s, i) => v.setUint16(o + i * 2, 0));
    tOff += f4len;
  }
  v.setUint16(tOff, 12); v.setUint16(tOff + 2, 0); v.setUint32(tOff + 4, f12len); v.setUint32(tOff + 8, 0); v.setUint32(tOff + 12, groups.length);
  groups.forEach((g, i) => { const o = tOff + 16 + i * 12; v.setUint32(o, g.start); v.setUint32(o + 4, g.end); v.setUint32(o + 8, g.gid); });
  return b.subarray(0, total);
}

/* ---- fallback for characters the embedded (subset) font does not contain ---- */
const measureCanvas = document.createElement('canvas').getContext('2d');
function fallbackFor(info) {
  if (info?.sysFont) return { custom: info.sysFont };
  // an uploaded font whose PostScript name matches beats a standard stand-in
  const want = (info.psName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const cf of RT.customFonts.values()) if (want && cf.ps && (cf.ps === want || want.startsWith(cf.ps) || cf.ps.startsWith(want))) return { custom: cf };
  return { std: info.style };
}
function fallbackCss(fb) {
  if (fb.custom) return `"${fb.custom.family}"`;
  return STD_CSS[fb.std.family];
}
function fallbackWidthEm(fb, ch) {
  if (fb.custom) { try { const g = fb.custom.fk.glyphForCodePoint(ch.codePointAt(0)); return g.advanceWidth / fb.custom.fk.unitsPerEm; } catch { return 0.5; } }
  measureCanvas.font = `${fb.std.italic ? 'italic ' : ''}${fb.std.bold ? 'bold ' : ''}100px ${STD_CSS[fb.std.family]}`;
  return measureCanvas.measureText(ch).width / 100;
}
function fontHas(info, ch) { return !!info && info.uni2gid.has(ch.codePointAt(0)); }
function charWidthEm(info, ch) {
  if (info?.widths.has(ch)) return info.widths.get(ch);
  if (fontHas(info, ch) && info.fk) { try { return info.fk.getGlyph(info.uni2gid.get(ch.codePointAt(0))).advanceWidth / info.upm; } catch {} }
  return fallbackWidthEm(fallbackFor(info || { style: { family: 'Helvetica' } }), ch);
}

/* ---- relayout a line for new text: untouched characters keep their exact matrices ---- */
function layoutLine(model, line, text) {
  const orig = line.units;
  if (text === line.text) return orig.map((u) => ({ ...u, orig: true }));
  const n = orig.length;
  let p = 0, pc = 0;
  while (p < n && text.substr(pc, orig[p].t.length) === orig[p].t) { pc += orig[p].t.length; p++; }
  let s = 0, sc = 0;
  while (s < n - p && text.length - sc - orig[n - 1 - s].t.length >= pc && text.substr(text.length - sc - orig[n - 1 - s].t.length, orig[n - 1 - s].t.length) === orig[n - 1 - s].t) {
    sc += orig[n - 1 - s].t.length; s++;
  }
  const mid = [...text.slice(pc, text.length - sc)];
  const out = orig.slice(0, p).map((u) => ({ ...u, orig: true }));
  const ref = p > 0 ? orig[p - 1] : orig[Math.min(p, n - 1)];
  let refStyle = model.styles[ref.si];
  // cursor = where the first changed character begins
  let cx, cy;
  if (p > 0) { const q = orig[p - 1]; cx = q.M[4] + (q.adv + q.gap) * q.M[0]; cy = q.M[5] + (q.adv + q.gap) * q.M[1]; }
  else { cx = orig[0].M[4]; cy = orig[0].M[5]; }
  if (ref.syn) { // inherit style from nearest real glyph
    const real = orig.slice(0, p).reverse().find((u) => !u.syn) || orig.find((u) => !u.syn);
    if (real) refStyle = model.styles[real.si];
  }
  const baseM = (ref.syn ? (orig.find((u) => !u.syn) || ref) : ref).M;
  const info = RT.fonts.get(refStyle.font);
  for (const ch of mid) {
    const w = charWidthEm(info, ch);
    const adv = w + (refStyle.Tc + (ch === ' ' ? refStyle.Tw : 0)) / (refStyle.Tfs || 1);
    out.push({ t: ch, M: [baseM[0], baseM[1], baseM[2], baseM[3], cx, cy], adv, gap: 0, si: model.styles.indexOf(refStyle), isNew: true });
    cx += adv * baseM[0]; cy += adv * baseM[1];
  }
  if (s > 0) {
    const first = orig[n - s];
    const dx = cx - first.M[4], dy = cy - first.M[5];
    for (const u of orig.slice(n - s)) out.push({ ...u, M: [u.M[0], u.M[1], u.M[2], u.M[3], u.M[4] + dx, u.M[5] + dy], orig: true });
  }
  return out;
}

function unitsBBox(model, units, vp) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const u of units) {
    const info = RT.fonts.get(model.styles[u.si]?.font);
    const asc = clamp(info?.ascent ?? 0.8, 0.6, 1.1), desc = clamp(info?.descent ?? -0.2, -0.4, -0.1);
    const adv = Math.max(u.adv, 0.05);
    for (const [gx, gy] of [[0, desc], [adv, desc], [0, asc], [adv, asc]]) {
      const [ux, uy] = apply(u.M, gx, gy);
      const [x, y] = apply(vp, ux, uy);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function tlineFor(pg, key) { return pg.objects.find((o) => o.type === 'tline' && o.key === key); }
const tlineSig = (pg) => JSON.stringify([pg.src, pg.index, ...pg.objects.filter((o) => o.type === 'tline').map((o) => [o.key, o.text, o.bg])]);

/* ================================================================ CONTENT STREAM SURGERY */
function contentBytes(page) {
  const ctx = page.doc.context;
  let c = page.node.Contents();
  if (!c) return new Uint8Array();
  const streams = c instanceof PDFLib.PDFArray ? c.asArray().map((r) => ctx.lookup(r)) : [c];
  const parts = streams.map((s) => (s instanceof PDFLib.PDFRawStream ? PDFLib.decodePDFRawStream(s).decode() : s.getContents()));
  const len = parts.reduce((a, p) => a + p.length + 1, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
  return out;
}
function scanShowOps(b) {
  const res = [];
  const n = b.length;
  let i = 0, opStart = -1;
  const ws = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
  const delim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
  const mark = (p) => { if (opStart < 0) opStart = p; };
  while (i < n) {
    const c = b[i];
    if (ws(c)) { i++; continue; }
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
    const t0 = i;
    if (c === 40) { let d = 1; i++; while (i < n && d > 0) { const x = b[i]; if (x === 92) { i += 2; continue; } if (x === 40) d++; else if (x === 41) d--; i++; } mark(t0); continue; }
    if (c === 60) { if (b[i + 1] === 60) { i += 2; mark(t0); continue; } i++; while (i < n && b[i] !== 62) i++; i++; mark(t0); continue; }
    if (c === 62) { i += b[i + 1] === 62 ? 2 : 1; continue; }
    if (c === 91 || c === 123) { i++; mark(t0); continue; }
    if (c === 93 || c === 125 || c === 41) { i++; continue; }
    if (c === 47) { i++; while (i < n && !ws(b[i]) && !delim(b[i])) i++; mark(t0); continue; }
    while (i < n && !ws(b[i]) && !delim(b[i])) i++;
    let tok = '';
    for (let k = t0; k < i && k - t0 < 12; k++) tok += String.fromCharCode(b[k]);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok) || tok === 'true' || tok === 'false' || tok === 'null') { mark(t0); continue; }
    if (tok === 'BI') { // inline image: skip binary payload
      let j = i;
      while (j < n - 2 && !(ws(b[j]) && b[j + 1] === 73 && b[j + 2] === 68 && (j + 3 >= n || ws(b[j + 3])))) j++;
      j += 4;
      while (j < n - 2 && !(ws(b[j]) && b[j + 1] === 69 && b[j + 2] === 73 && (j + 3 >= n || ws(b[j + 3]) || delim(b[j + 3])))) j++;
      i = j + 3; opStart = -1; continue;
    }
    if (tok === 'Tj' || tok === 'TJ' || tok === "'" || tok === '"') res.push({ start: opStart < 0 ? t0 : opStart, end: i, op: tok });
    opStart = -1;
  }
  return res;
}
function goneShow(bytes, op, sh) {
  const num = sh && sh.Tfs ? (-sh.x * 1000) / sh.Tfs : 0;
  const rep = `[${num.toFixed(4)}] TJ`;
  if (op.op === "'") return 'T* ' + rep;
  if (op.op === '"') {
    const nums = new TextDecoder('latin1').decode(bytes.subarray(op.start, op.end)).match(/[+-]?(\d+\.?\d*|\.\d+)/g) || ['0', '0'];
    return `${nums[0]} Tw ${nums[1]} Tc T* ` + rep;
  }
  return rep;
}
// Replace the selected show operators with pure advances: glyphs vanish, following text stays put.
function removeShowOps(doc, page, model, removeSet) {
  const bytes = contentBytes(page);
  const ops = scanShowOps(bytes);
  if (ops.length !== model.showCount) throw new Error(`show-op mismatch ${ops.length} vs ${model.showCount}`);
  const enc = new TextEncoder();
  const chunks = [];
  let last = 0;
  ops.forEach((op, k) => {
    if (!removeSet.has(k)) return;
    chunks.push(bytes.subarray(last, op.start), enc.encode(' ' + goneShow(bytes, op, model.shows[k]) + ' '));
    last = op.end;
  });
  chunks.push(bytes.subarray(last));
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  const stream = doc.context.flateStream(out);
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
}
// Isolate existing content in q…Q so our drawing starts from a clean graphics state.
function wrapContents(doc, page) {
  if (page.__wrapped) return;
  page.__wrapped = true;
  const ctx = doc.context;
  const c = page.node.get(PDFName.of('Contents'));
  if (!c) return;
  const q = ctx.register(ctx.stream('q\n')), Q = ctx.register(ctx.stream('\nQ\n'));
  const cur = ctx.lookup(c);
  const arr = cur instanceof PDFLib.PDFArray ? cur.asArray() : [c];
  page.node.set(PDFName.of('Contents'), ctx.obj([q, ...arr, Q]));
}

/* ================================================================ STRIP REMOVAL (table rows)
 * Deleting a row is structural: everything inside a horizontal strip is taken out of the content stream
 * (text, cell borders, images) and what lies below moves up to close the gap. The result becomes the
 * page's new source, so the text model, hit regions and later edits all see the page as it now is. */
const PATH_ARGS = { m: 2, l: 2, c: 6, v: 4, y: 4, re: 4, h: 0 };
const PAINT_OPS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const fnum = (v) => String(+v.toFixed(4));

// Tokenise a content stream into operators with their operands and byte ranges.
function parseOps(b) {
  const ops = [];
  const n = b.length;
  let i = 0, args = [], start = -1;
  const ws = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
  const delim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
  const push = (s, v) => { if (start < 0) start = s; args.push({ s, v }); };
  const str = () => { let d = 1; i++; while (i < n && d > 0) { const x = b[i]; if (x === 92) { i += 2; continue; } if (x === 40) d++; else if (x === 41) d--; i++; } };
  while (i < n) {
    const c = b[i];
    if (ws(c)) { i++; continue; }
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
    const t0 = i;
    if (c === 40) { str(); push(t0, null); continue; }
    if (c === 60 && b[i + 1] !== 60) { while (i < n && b[i] !== 62) i++; i++; push(t0, null); continue; }
    if (c === 60 || c === 91) { // dictionary or array operand: skip to its matching close
      let d = 0;
      while (i < n) {
        const x = b[i];
        if (x === 40) { str(); continue; }
        if (x === 91) d++; else if (x === 93) d--;
        else if (x === 60 && b[i + 1] === 60) { d++; i++; } else if (x === 62 && b[i + 1] === 62) { d--; i++; }
        i++;
        if (d <= 0) break;
      }
      push(t0, null); continue;
    }
    if (c === 62 || c === 93 || c === 41 || c === 123 || c === 125) { i++; continue; }
    if (c === 47) { i++; while (i < n && !ws(b[i]) && !delim(b[i])) i++; let s = ''; for (let k = t0 + 1; k < i; k++) s += String.fromCharCode(b[k]); push(t0, s); continue; }
    while (i < n && !ws(b[i]) && !delim(b[i])) i++;
    let tok = '';
    for (let k = t0; k < i && k - t0 < 40; k++) tok += String.fromCharCode(b[k]);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { push(t0, parseFloat(tok)); continue; }
    if (tok === 'true' || tok === 'false' || tok === 'null') { push(t0, null); continue; }
    if (tok === 'BI') { // inline image: skip binary payload
      let j = i;
      while (j < n - 2 && !(ws(b[j]) && b[j + 1] === 73 && b[j + 2] === 68 && (j + 3 >= n || ws(b[j + 3])))) j++;
      j += 4;
      while (j < n - 2 && !(ws(b[j]) && b[j + 1] === 69 && b[j + 2] === 73 && (j + 3 >= n || ws(b[j + 3]) || delim(b[j + 3])))) j++;
      i = Math.min(n, j + 3);
    }
    ops.push({ op: tok, start: start < 0 ? t0 : start, opStart: t0, end: i, args });
    args = []; start = -1;
  }
  return ops;
}
// Painted paths, text-show operators, XObjects and inline images in stream order, each with its CTM.
function walkContent(b) {
  const items = [], stack = [];
  let ctm = I, path = null, k = 0;
  for (const o of parseOps(b)) {
    switch (o.op) {
      case 'q': stack.push(ctm); break;
      case 'Q': if (stack.length) ctm = stack.pop(); break;
      case 'cm': { const m = o.args.slice(-6).map((a) => a.v); if (m.length === 6 && m.every(Number.isFinite)) ctm = mul(ctm, m); break; }
      case 'BT': case 'Tm': items.push({ kind: 'reset' }); break;
      case 'Tj': case 'TJ': case "'": case '"': items.push({ kind: 'show', o, k: k++ }); break;
      case 'Do': case 'BI': items.push({ kind: 'xobj', o, ctm, name: o.op === 'Do' ? o.args[o.args.length - 1]?.v : null }); break;
      case 'W': case 'W*': if (path) path.clip = true; break;
      default:
        if (o.op in PATH_ARGS) {
          if (!path) path = { kind: 'path', ctm, segs: [], clip: false, start: o.start };
          path.segs.push(o);
        } else if (PAINT_OPS.has(o.op) && path) { path.end = o.end; path.paint = o.op; items.push(path); path = null; }
    }
  }
  return items;
}
function segPts(o) {
  const need = PATH_ARGS[o.op];
  const v = o.args.slice(-need).map((a) => a.v);
  if (!need || v.length < need || !v.every(Number.isFinite)) return [];
  if (o.op === 're') return [[v[0], v[1]], [v[0] + v[2], v[1]], [v[0] + v[2], v[1] + v[3]], [v[0], v[1] + v[3]]];
  const pts = [];
  for (let i = 0; i < need; i += 2) pts.push([v[i], v[i + 1]]);
  return pts;
}
function xobjBox(page, name) {
  try {
    const d = name && page.node.Resources()?.lookup(PDFName.of('XObject'))?.lookup(PDFName.of(name))?.dict;
    if (d && d.get(PDFName.of('Subtype')) === PDFName.of('Form')) {
      const mt = d.lookup(PDFName.of('Matrix'));
      return { box: d.lookup(PDFName.of('BBox')).asArray().map((x) => x.asNumber()), m: mt ? mt.asArray().map((x) => x.asNumber()) : I };
    }
  } catch {}
  return { box: [0, 0, 1, 1], m: I };
}
// Remove the strip a…b (display points, top to bottom) from a page; with `close`, pull up what is below it.
function cutPageBand(doc, page, pg, model, a, b, close) {
  const bytes = contentBytes(page);
  const items = walkContent(bytes);
  if (items.filter((x) => x.kind === 'show').length !== model.showCount) throw new Error('this page has text the editor cannot restructure');
  const vp = viewportFor(pg, 1), ivp = invertM(vp);
  const h = close ? b - a : 0, tol = 0.5;
  const up = [1, 0, 0, 1, -h * ivp[2], -h * ivp[3]]; // the upward move, in page space
  const moved = (ctm, m) => mul(invertM(ctm), mul(up, mul(ctm, m)));
  const src = (s, e) => new TextDecoder('latin1').decode(bytes.subarray(s, e));
  const edits = [];
  const put = (s, e, text) => edits.push({ s, e, text: ' ' + text + ' ' });
  let shifted = false; // are the stream's current text matrices displaced by `up`?
  for (const it of items) {
    if (it.kind === 'reset') { shifted = false; continue; }
    if (it.kind === 'show') {
      const sh = model.shows[it.k], o = it.o;
      if (!sh) continue;
      const U = mul(sh.ctm, sh.Tm);
      const y = apply(vp, U[4], U[5])[1];
      if (y > a && y <= b) { put(o.start, o.end, goneShow(bytes, o, sh)); continue; }
      const want = close && y > b;
      if (want === shifted || (o.op === '"' && o.args.length < 3)) continue;
      shifted = want;
      // re-seat the line matrix, then re-apply the advance already made on this line
      const L = sh.Tlm, tx = ((sh.Tm[4] - L[4]) * L[0] + (sh.Tm[5] - L[5]) * L[1]) / (L[0] * L[0] + L[1] * L[1] || 1);
      let pre = (want ? moved(sh.ctm, L) : L).map(fnum).join(' ') + ' Tm';
      if (Math.abs(tx) > 1e-6 && sh.Tfs * sh.Th) pre += ` [${fnum((-tx * 1000) / (sh.Tfs * sh.Th))}] TJ`;
      if (o.op === "'") put(o.start, o.end, `T* ${pre} ${src(o.start, o.opStart)} Tj`);
      else if (o.op === '"') put(o.start, o.end, `${fnum(o.args[0].v || 0)} Tw ${fnum(o.args[1].v || 0)} Tc T* ${pre} ${src(o.args[2].s, o.opStart)} Tj`);
      else put(o.start, o.start, pre);
      continue;
    }
    if (it.kind === 'xobj') {
      const { box, m } = xobjBox(page, it.name);
      const D = mul(vp, mul(it.ctm, m));
      const ys = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(([x, y]) => apply(D, x, y)[1]);
      const top = Math.min(...ys), bot = Math.max(...ys);
      if (top >= a - tol && bot <= b + tol) put(it.o.start, it.o.end, '');
      else if (close && top >= b - tol) put(it.o.start, it.o.end, `q ${moved(it.ctm, I).map(fnum).join(' ')} cm ${src(it.o.start, it.o.end)} Q`);
      continue;
    }
    // paths: vertices below the strip move up, vertices inside it collapse onto its top edge
    const D = mul(vp, it.ctm), Di = invertM(D);
    const segs = it.segs.map((o) => ({ o, pts: segPts(o) }));
    const ys = segs.flatMap((s) => s.pts.map(([x, y]) => apply(D, x, y)[1]));
    if (!ys.length) continue;
    const top = Math.min(...ys), bot = Math.max(...ys), mid = (top + bot) / 2;
    const inside = bot - top < 2 * tol ? mid >= a - tol && mid < b - tol : top >= a - tol && bot <= b + tol;
    if (inside) { if (!it.clip) put(it.start, it.end, ''); continue; }
    if (!close || bot <= a + tol) continue;
    const mp = (p) => { const [X, Y] = apply(D, p[0], p[1]); return Y <= a ? p : apply(Di, X, Y >= b ? Y - h : a); };
    const axis = (Math.abs(D[1]) < 1e-6 && Math.abs(D[2]) < 1e-6) || (Math.abs(D[0]) < 1e-6 && Math.abs(D[3]) < 1e-6);
    for (const { o, pts } of segs) {
      const np = pts.map(mp);
      if (!np.length || np.every((q, i) => q === pts[i])) continue;
      if (o.op !== 're') put(o.start, o.end, np.flat().map(fnum).join(' ') + ' ' + o.op);
      else if (axis) put(o.start, o.end, [np[0][0], np[0][1], np[2][0] - np[0][0], np[2][1] - np[0][1]].map(fnum).join(' ') + ' re');
      else put(o.start, o.end, np.map((q, i) => `${fnum(q[0])} ${fnum(q[1])} ${i ? 'l' : 'm'}`).join(' ') + ' h');
    }
  }
  const enc = new TextEncoder();
  const chunks = [];
  let last = 0;
  for (const e of edits) { chunks.push(bytes.subarray(last, e.s), enc.encode(e.text)); last = e.e; }
  chunks.push(bytes.subarray(last));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(out)));
}
// Cell rectangles, horizontal rules and text-line boxes (display points) used to find the row under the pointer.
async function getGeom(pg) {
  const key = `${pg.src}:${pg.index}:${R(pg)}`;
  if (!RT.geoms.has(key)) RT.geoms.set(key, (async () => {
    const vp = viewportFor(pg, 1);
    const rects = [], rules = [];
    const page = (await getLibDoc(pg.src)).getPage(pg.index);
    for (const it of walkContent(contentBytes(page))) {
      if (it.kind !== 'path' || it.clip || it.paint === 'n') continue;
      const D = mul(vp, it.ctm);
      const pts = it.segs.flatMap(segPts).map(([x, y]) => apply(D, x, y));
      if (!pts.length) continue;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      if (r.h < 1.5) { if (r.w >= 10) rules.push(r); } else if (r.w >= 4 && r.h >= 4 && r.h <= 150) rects.push(r);
    }
    const model = await getModel(pg);
    const texts = model.lines.filter((l) => l.editable).map((l) => unitsBBox(model, l.units, vp));
    return { rects, rules, texts };
  })().catch((e) => { console.warn(e); return { rects: [], rules: [], texts: [] }; }));
  return RT.geoms.get(key);
}
// The row under a point: its table cell, else the gap between two rules, else the text line.
function detectBand(g, p) {
  const has = (r) => p.x >= r.x && p.x <= r.x + r.w;
  let cell = null;
  for (const r of g.rects) if (has(r) && p.y >= r.y && p.y <= r.y + r.h && (!cell || r.h < cell.h)) cell = r;
  if (cell) return { a: cell.y, b: cell.y + cell.h };
  let up = -Infinity, dn = Infinity;
  for (const r of g.rules) {
    if (!has(r)) continue;
    const y = r.y + r.h / 2;
    if (y <= p.y) up = Math.max(up, y); else dn = Math.min(dn, y);
  }
  if (dn - up >= 4 && dn - up <= 150) return { a: up, b: dn };
  const t = g.texts.find((r) => has(r) && p.y >= r.y && p.y <= r.y + r.h) || g.texts.find((r) => p.y >= r.y && p.y <= r.y + r.h);
  return t ? { a: t.y - 1, b: t.y + t.h + 1 } : null;
}
async function isolatePage(src, index) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [p] = await doc.copyPages(await getLibDoc(src), [index]);
  doc.addPage(p);
  return { doc, p };
}
async function deleteBand(pg, a, b) {
  endEdit();
  if (pg.blank || b - a < 1) return;
  try {
    let at = pg;
    if (pg.objects.some((o) => o.type === 'tline')) {
      // bake pending text edits first, so the strip is cut from the page as it currently looks
      const { doc, p } = await isolatePage(pg.src, pg.index);
      await applyTextEdits(doc, p, pg, new Map(), null);
      [at] = await loadSource(await doc.save({ useObjectStreams: false }), S.sources[pg.src].name);
    }
    const { doc, p } = await isolatePage(at.src, at.index);
    cutPageBand(doc, p, pg, await getModel(at), a, b, S.defaults.cut.close);
    const [np] = await loadSource(await doc.save({ useObjectStreams: false }), S.sources[pg.src].name);
    const moveUp = S.defaults.cut.close ? pg.objects.filter((o) => o.type !== 'tline' && objBBox(o, pg).y >= b - 0.5) : [];
    pg.src = np.src; pg.index = np.index;
    pg.objects = pg.objects.filter((o) => o.type !== 'tline');
    for (const o of moveUp) translateObj(o, JSON.parse(JSON.stringify(o)), 0, a - b);
    if (S.sel && !findObj(S.sel)) S.sel = null;
    RT.previews.delete(pg.id);
    commit();
    renderLayer(pg); refreshCanvas(pg); renderHits(pg); renderProps();
  } catch (e) {
    console.error(e);
    toast('Could not delete this strip: ' + e.message, 5000);
  }
}

/* ---- draw glyphs with exact matrices ---- */
async function outFont(doc, cache, key, make) {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
}
async function embedFor(doc, cache, info) {
  if (info?.data && info.embedded && !info.std14) {
    return outFont(doc, cache, 'pdf:' + info.name, async () => {
      try { return { font: await doc.embedFont(info.data, { subset: false }), kind: 'orig' }; }
      catch (e) { console.warn('embed failed', info.psName, e); return null; }
    });
  }
  return null;
}
async function embedFallback(doc, cache, fb) {
  if (fb.custom) return outFont(doc, cache, 'cf:' + fb.custom.family, async () => ({ font: await doc.embedFont(fb.custom.bytes, { subset: true }), kind: 'custom' }));
  const k = stdKey(fb.std);
  return outFont(doc, cache, 'std:' + k, async () => ({ font: await doc.embedFont(StandardFonts[k]), kind: 'std' }));
}
async function drawUnits(doc, page, model, units, cache, stats) {
  const ops = [pushGraphicsState(), beginText()];
  let curFont = null, curFill = null, curStroke = null, curTr = null, curLw = null;
  const fontKeys = new Map();
  const keyFor = (pf) => { if (!fontKeys.has(pf)) fontKeys.set(pf, page.node.newFontDictionary(pf.name, pf.ref)); return fontKeys.get(pf); };
  for (const u of units) {
    if (u.syn || !u.t.trim()) continue; // whitespace draws nothing; its advance is already in the matrices
    const st = model.styles[u.si];
    if (!st || st.Tr === 3 || st.Tr === 7) continue;
    const info = RT.fonts.get(st.font);
    let pf = null, hex = null;
    const emb = await embedFor(doc, cache, info);
    if (emb && emb.font) {
      if (u.orig && u.fc) {
        const gid = info.fc2gid.get(u.fc.codePointAt(0));
        if (gid) { try { if ([...u.t].length === 1 && info.uni2gid.has(u.t.codePointAt(0))) emb.font.encodeText(u.t); } catch {} hex = PDFHexString.of(gid.toString(16).padStart(4, '0')); pf = emb.font; }
      }
      if (!hex && [...u.t].length === 1 && fontHas(info, u.t)) {
        const gid = info.uni2gid.get(u.t.codePointAt(0));
        try { emb.font.encodeText(u.t); } catch {}
        hex = PDFHexString.of(gid.toString(16).padStart(4, '0')); pf = emb.font;
      }
    }
    if (!hex) {
      const fb = fallbackFor(info || { style: { family: 'Helvetica', bold: false, italic: false } });
      const f = await embedFallback(doc, cache, fb);
      let t = u.t;
      try { hex = f.font.encodeText(t); } catch { hex = f.font.encodeText('?'); }
      pf = f.font;
      if (stats && !info?.std14 && !info?.sysFont) stats.fallback.add(u.t);
    }
    if (pf !== curFont) { ops.push(setFontAndSize(keyFor(pf), 1)); curFont = pf; }
    if (st.fill !== curFill) { const [r, g, b] = hex2rgb(st.fill); ops.push(setFillingRgbColor(r / 255, g / 255, b / 255)); curFill = st.fill; }
    const tr = [0, 1, 2].includes(st.Tr) ? st.Tr : st.Tr >= 4 ? st.Tr - 4 : 0;
    if (tr !== curTr) { ops.push(setTextRenderingMode(tr)); curTr = tr; }
    if (tr && st.stroke !== curStroke) { const [r, g, b] = hex2rgb(st.stroke); ops.push(setStrokingRgbColor(r / 255, g / 255, b / 255)); curStroke = st.stroke; }
    if (tr && st.lw !== curLw) { ops.push(setLineWidth(st.lw)); curLw = st.lw; }
    ops.push(setTextMatrix(...u.M), showText(hex));
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

async function applyTextEdits(doc, page, pg, cache, stats) {
  const edits = pg.objects.filter((o) => o.type === 'tline');
  if (!edits.length) return;
  const model = await getModel(pg);
  const edited = edits.map((e) => ({ e, line: model.lines[e.key] })).filter((x) => x.line && x.e.text !== x.line.text);
  if (!edited.length) return;
  const removeSet = new Set();
  const coverLines = [];
  for (const { line, e } of edited) {
    if (line.removable) line.ops.forEach((k) => removeSet.add(k));
    else coverLines.push({ line, e });
  }
  let removedOK = false;
  if (removeSet.size) {
    try { removeShowOps(doc, page, model, removeSet); removedOK = true; }
    catch (err) { console.warn('content-stream edit fell back to cover mode:', err.message); }
  }
  wrapContents(doc, page);
  const editedKeys = new Set(edited.map((x) => x.e.key));
  if (!removedOK) coverLines.push(...edited.filter((x) => x.line.removable));
  // cover mode (only for text inside form XObjects or unparseable streams)
  const vp = viewportFor(pg, 1);
  const inv = invertM(vp);
  for (const { line, e } of coverLines) {
    const bb = unitsBBox(model, line.units, vp);
    const pad = 0.6;
    const corners = [[bb.x - pad, bb.y - pad], [bb.x + bb.w + pad, bb.y - pad], [bb.x + bb.w + pad, bb.y + bb.h + pad], [bb.x - pad, bb.y + bb.h + pad]].map(([x, y]) => apply(inv, x, y));
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    page.drawRectangle({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), color: pdfColor(e.bg || '#ffffff') });
  }
  // glyphs that shared a removed operator but belong to untouched lines: redraw them exactly
  if (removedOK) {
    const keep = [];
    model.lines.forEach((ln) => {
      if (editedKeys.has(ln.key)) return;
      ln.units.forEach((u) => { if (u.gi >= 0 && removeSet.has(model.glyphs[u.gi].op)) keep.push({ ...u, orig: true }); });
    });
    if (keep.length) await drawUnits(doc, page, model, keep, cache, null);
  }
  for (const { line, e } of edited) await drawUnits(doc, page, model, layoutLine(model, line, e.text), cache, stats);
}
function invertM(m) {
  const d = m[0] * m[3] - m[1] * m[2];
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}

/* ---- live preview: the canvas shows the page exactly as it will be saved ---- */
async function renderSourcePage(pg) {
  if (pg.blank) return null;
  const sig = tlineSig(pg);
  const hasEdits = pg.objects.some((o) => o.type === 'tline');
  if (!hasEdits) return { page: await getPdfPage(pg), sig };
  const cached = RT.previews.get(pg.id);
  if (cached && cached.sig === sig) return { page: await cached.page, sig };
  const job = (async () => {
    const lib = await getLibDoc(pg.src);
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const [p] = await doc.copyPages(lib, [pg.index]);
    doc.addPage(p);
    await applyTextEdits(doc, p, pg, new Map(), null);
    const bytes = await doc.save({ useObjectStreams: false });
    const pdoc = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes }).promise;
    return { pdoc, page: await pdoc.getPage(1) };
  })();
  const entry = { sig, page: job.then((r) => r.page), doc: null };
  job.then((r) => { entry.doc = r.pdoc; }).catch(() => {});
  if (cached) cached.page.then(() => cached.doc?.destroy()).catch(() => {});
  RT.previews.set(pg.id, entry);
  try { return { page: await entry.page, sig }; }
  catch (e) { console.error(e); toast('Preview failed: ' + e.message, 4000); return { page: await getPdfPage(pg), sig: '' }; }
}

/* ================================================================ VIEWER */
function computeFitZoom(mode) {
  const vp = $('#viewport');
  const pg = S.pages[currentPageIndex()] || S.pages[0];
  if (!pg) return 1;
  const [W, H] = dispSize(pg);
  const availW = vp.clientWidth - 64, availH = vp.clientHeight - 60;
  return clamp(mode === 'fitp' ? Math.min(availW / W, availH / H) : availW / W, 0.2, 6);
}
function buildViewer() {
  RT.observer?.disconnect();
  const host = $('#pages');
  const keepIdx = currentPageIndex();
  host.innerHTML = '';
  RT.observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const pg = pageById(en.target.dataset.id);
      if (!pg) continue;
      if (en.isIntersecting) { renderCanvas(pg, en.target); if (S.tool === 'edit') renderHits(pg); }
    }
  }, { root: $('#viewport'), rootMargin: '900px 0px' });
  S.pages.forEach((pg, i) => host.appendChild(buildPageEl(pg, i)));
  buildThumbs();
  updatePager();
  if (keepIdx > 0) scrollToPage(keepIdx, false);
}
function buildPageEl(pg, i) {
  const [W, H] = dispSize(pg);
  const el = document.createElement('div');
  el.className = 'page loading'; el.dataset.id = pg.id;
  el.style.width = W * S.zoom + 'px'; el.style.height = H * S.zoom + 'px';
  el.innerHTML = `<canvas></canvas><div class="hits"></div><div class="layer"></div><div class="marks"></div><div class="pno">${i + 1}</div>`;
  RT.observer.observe(el);
  queueMicrotask(() => renderLayer(pg));
  return el;
}
function refreshPage(pg) {
  const old = pageEl(pg.id);
  if (!old) return;
  RT.observer.unobserve(old);
  const el = buildPageEl(pg, S.pages.indexOf(pg));
  old.replaceWith(el);
  refreshThumb(pg);
}
function refreshCanvas(pg) {
  const el = pageEl(pg.id);
  if (!el) return;
  el._key = null;
  const r = el.getBoundingClientRect(), vr = $('#viewport').getBoundingClientRect();
  if (r.bottom > vr.top - 900 && r.top < vr.bottom + 900) renderCanvas(pg, el);
  refreshThumb(pg);
}
async function renderCanvas(pg, el) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const sig = tlineSig(pg);
  const key = `${S.zoom}:${R(pg)}:${dpr}:${sig}`;
  if (el._key === key) return;
  el._key = key;
  const [W, H] = dispSize(pg);
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(W * S.zoom * dpr); canvas.height = Math.floor(H * S.zoom * dpr);
  const ctx = canvas.getContext('2d');
  try {
    if (pg.blank) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    else {
      const src = await renderSourcePage(pg);
      if (el._key !== key) return;
      const vp = src.page.getViewport({ scale: S.zoom * dpr, rotation: R(pg) });
      el._task?.cancel();
      const task = src.page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE });
      el._task = task;
      await task.promise;
      if (el._key !== key) return;
    }
    el.querySelector('canvas').replaceWith(canvas);
    el._renderedSig = sig;
    el.classList.remove('loading');
    renderLayer(pg);
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.error(e);
  }
}

/* ---- hit regions for existing text ---- */
async function renderHits(pg) {
  const el = pageEl(pg.id);
  if (!el || pg.blank) return;
  const model = await getModel(pg);
  const hits = el.querySelector('.hits');
  if (!hits) return;
  const vp = viewportFor(pg, 1);
  const z = S.zoom;
  hits.innerHTML = '';
  const edits = new Map(pg.objects.filter((o) => o.type === 'tline').map((o) => [o.key, o]));
  const repeats = new Map();
  for (const ln of model.lines) repeats.set(ln.text, (repeats.get(ln.text) || 0) + 1);
  const under = [], over = [];
  for (const ln of model.lines) {
    if (!ln.editable) continue;
    const t = edits.get(ln.key);
    if (t && !t.text.trim()) continue; // deleted text is gone, not an empty field
    const units = t ? layoutLine(model, ln, t.text) : ln.units;
    const ref = ln.units.find((u) => !u.syn) || ln.units[0];
    if (!isHorizontalInDisplay(pg, ref.M)) continue;
    const bb = unitsBBox(model, units.length ? units : ln.units, vp);
    const d = document.createElement('div');
    d.className = 'hit'; d.dataset.key = ln.key;
    Object.assign(d.style, { left: (bb.x - 1) * z + 'px', top: (bb.y - 1) * z + 'px', width: (bb.w + 2) * z + 'px', height: (bb.h + 2) * z + 'px' });
    (repeats.get(ln.text) >= 4 ? under : over).push(d);
  }
  hits.append(...under, ...over);
}
function isHorizontalInDisplay(pg, M) {
  const d = mul(viewportFor(pg, 1), M);
  return Math.abs(d[1]) < Math.abs(d[0]) * 0.05 && d[0] > 0;
}

/* ---- overlay objects ---- */
function imgUrl(id) {
  if (!RT.imgUrls.has(id)) {
    const d = S.images[id];
    const [meta, b64] = d.split(',');
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    RT.imgUrls.set(id, URL.createObjectURL(new Blob([u8], { type: meta.slice(5).split(';')[0] })));
  }
  return RT.imgUrls.get(id);
}
function textCss(o) {
  const cf = RT.customFonts.get(o.font);
  return cf ? `"${cf.family}", Arial, sans-serif` : STD_CSS[o.font] || STD_CSS.Helvetica;
}
function styleTextEl(el, o) {
  const z = S.zoom;
  Object.assign(el.style, {
    left: o.x * z + 'px', top: o.y * z + 'px', fontSize: o.size * z + 'px', fontFamily: textCss(o),
    fontWeight: o.bold ? '700' : '400', fontStyle: o.italic ? 'italic' : 'normal', color: o.color, opacity: o.opacity,
    textDecoration: o.underline ? 'underline' : 'none', textAlign: o.align,
  });
}
function makeObjEl(o, pg) {
  const z = S.zoom;
  const el = document.createElement('div');
  el.dataset.oid = o.id;
  const box = (x, y, w, h) => Object.assign(el.style, { left: x * z + 'px', top: y * z + 'px', width: w * z + 'px', height: h * z + 'px' });
  switch (o.type) {
    case 'text':
      el.className = 'obj text'; el.textContent = o.text; styleTextEl(el, o); break;
    case 'box':
      el.className = 'obj box ' + o.kind; box(o.x, o.y, o.w, o.h);
      Object.assign(el.style, { background: o.fill || 'transparent', border: o.stroke ? `${o.sw * z}px solid ${o.stroke}` : '0', opacity: o.opacity });
      break;
    case 'ellipse':
      el.className = 'obj ellipse'; box(o.x, o.y, o.w, o.h);
      Object.assign(el.style, { borderRadius: '50%', background: o.fill || 'transparent', border: o.stroke ? `${o.sw * z}px solid ${o.stroke}` : '0', opacity: o.opacity });
      break;
    case 'image':
      el.className = 'obj image' + (o.ink ? ' ink' : ''); box(o.x, o.y, o.w, o.h); el.style.opacity = o.opacity;
      el.innerHTML = `<img alt="" draggable="false" src="${imgUrl(o.img)}">`;
      break;
    case 'line': case 'path': {
      const [W, H] = dispSize(pg);
      el.className = 'obj vecwrap';
      Object.assign(el.style, { left: 0, top: 0, width: W * z + 'px', height: H * z + 'px', pointerEvents: 'none' });
      const d = o.type === 'line' ? lineD(o) : pathD(o.points);
      el.innerHTML = `<svg class="vec" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <path d="${d}" fill="none" stroke="${o.stroke}" stroke-width="${o.sw}" stroke-linecap="round" stroke-linejoin="round" opacity="${o.opacity}"/>
        <path class="hitpath" d="${d}" fill="none" stroke-width="${Math.max(o.sw, 8 / z)}" data-oid="${o.id}"/></svg>`;
      break;
    }
    case 'tline': el.className = 'obj tline'; break;
  }
  return el;
}
function lineD(o) {
  let d = `M${o.x1} ${o.y1}L${o.x2} ${o.y2}`;
  if (o.arrow) for (const [a, b] of arrowHead(o)) d += `M${a} ${b}L${o.x2} ${o.y2}`;
  return d;
}
function arrowHead(o) {
  const ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1), L = Math.max(8, o.sw * 4);
  return [-0.45, 0.45].map((s) => [o.x2 - L * Math.cos(ang + s), o.y2 - L * Math.sin(ang + s)]);
}
function pathD(pts) {
  if (!pts.length) return '';
  if (pts.length < 3) return `M${pts[0][0]} ${pts[0][1]}` + pts.slice(1).map((p) => `L${p[0]} ${p[1]}`).join('') + (pts.length === 1 ? `l0.01 0` : '');
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += `Q${round(pts[i][0])} ${round(pts[i][1])} ${round(mx)} ${round(my)}`;
  }
  const l = pts[pts.length - 1];
  return d + `L${l[0]} ${l[1]}`;
}

async function renderLayer(pg) {
  const el = pageEl(pg.id);
  if (!el) return;
  const layer = el.querySelector('.layer');
  const z = S.zoom;
  const tlines = pg.objects.filter((o) => o.type === 'tline');
  const model = tlines.length ? await getModel(pg) : null;
  if (S.editing && pg.objects.some((o) => o.id === S.editing && o.type === 'tline')) return; // don't tear down a live editor
  layer.innerHTML = '';
  // edited existing-text lines: ghost render until the canvas preview catches up
  if (tlines.length) {
    const vp = viewportFor(pg, 1);
    const stale = el._renderedSig !== tlineSig(pg);
    for (const o of tlines) {
      const line = model.lines[o.key];
      if (!line || (!o.text.trim() && S.editing !== o.id)) continue;
      const units = layoutLine(model, line, o.text);
      const bb = unitsBBox(model, units.length ? units : line.units, vp);
      const obb = unitsBBox(model, line.units, vp);
      if ((stale || S.editing === o.id) && S.editing !== o.id) {
        const c = document.createElement('div'); c.className = 'cover';
        const u = union(bb, obb);
        Object.assign(c.style, { left: (u.x - 0.8) * z + 'px', top: (u.y - 0.8) * z + 'px', width: (u.w + 1.6) * z + 'px', height: (u.h + 1.6) * z + 'px', background: o.bg || '#fff' });
        layer.appendChild(c);
        layer.appendChild(ghostText(pg, model, line, o.text));
      }
      const h = makeObjEl(o, pg);
      Object.assign(h.style, { left: bb.x * z + 'px', top: bb.y * z + 'px', width: Math.max(bb.w, 2) * z + 'px', height: bb.h * z + 'px' });
      layer.appendChild(h);
    }
  }
  for (const o of pg.objects) if (o.type !== 'tline') layer.appendChild(makeObjEl(o, pg));
  // measure text boxes for selection geometry
  for (const o of pg.objects) if (o.type === 'text') {
    const t = layer.querySelector(`[data-oid="${o.id}"]`);
    if (t) { o._w = t.offsetWidth / z; o._h = t.offsetHeight / z; }
  }
  if (S.sel) {
    const f = findObj(S.sel);
    if (f && f.pg === pg) drawSelection(pg, f.o, layer);
  }
}
const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };

// Static HTML rendering of an edited line in the real font (used while the canvas preview rebuilds)
function ghostText(pg, model, line, text) {
  const z = S.zoom;
  const vp = viewportFor(pg, 1);
  const wrap = document.createElement('div');
  wrap.className = 'ghost';
  wrap.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  for (const u of layoutLine(model, line, text)) {
    if (u.syn || u.t === ' ') continue;
    const st = model.styles[u.si];
    const info = RT.fonts.get(st.font);
    const D = mul(vp, u.M);
    const size = Math.hypot(D[2], D[3]);
    const sx = Math.hypot(D[0], D[1]) / size;
    const s = document.createElement('span');
    const fb = fallbackFor(info || { style: { family: 'Helvetica' } });
    const fam = info?.css && fontHas(info, u.t) ? `${info.css}, ${fallbackCss(fb)}` : fallbackCss(fb);
    const bl = baselineRatio(fam, info?.css && fontHas(info, u.t) ? null : fb.std);
    s.textContent = u.t;
    s.style.cssText = `position:absolute;left:${D[4] * z}px;top:${(D[5] - bl * size) * z}px;font-size:${size * z}px;line-height:1.2;white-space:pre;` +
      `font-family:${fam};color:${st.fill};transform:scaleX(${sx});transform-origin:0 ${bl * size * z}px;` +
      (fb.std && !(info?.css && fontHas(info, u.t)) ? `font-weight:${fb.std.bold ? 700 : 400};font-style:${fb.std.italic ? 'italic' : 'normal'};` : '');
    wrap.appendChild(s);
  }
  return wrap;
}
// distance from the top of a 1.2 line box to the baseline, as a fraction of font size (measured, per font)
function baselineRatio(fam, std) {
  const k = fam + '|' + (std ? `${std.bold}${std.italic}` : '');
  if (RT.baselines.has(k)) return RT.baselines.get(k);
  const box = document.createElement('div');
  box.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;font-size:100px;line-height:1.2;white-space:nowrap;font-family:${fam};` +
    (std ? `font-weight:${std.bold ? 700 : 400};font-style:${std.italic ? 'italic' : 'normal'};` : '');
  box.innerHTML = 'Hxg<span style="display:inline-block;width:1px;height:0;vertical-align:baseline"></span>';
  document.body.appendChild(box);
  const r = box.lastChild.offsetTop / 100;
  box.remove();
  if (r > 0.3 && r < 1.5) RT.baselines.set(k, r);
  return r > 0.3 && r < 1.5 ? r : 0.95;
}

/* ---- selection ---- */
function objBBox(o, pg) {
  switch (o.type) {
    case 'text': return { x: o.x, y: o.y, w: o._w || 10, h: o._h || o.size * LINE_H };
    case 'line': return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
    case 'path': {
      const xs = o.points.map((p) => p[0]), ys = o.points.map((p) => p[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case 'tline': {
      const el = pageEl(pg.id)?.querySelector(`.obj.tline[data-oid="${o.id}"]`);
      if (!el) return { x: 0, y: 0, w: 0, h: 0 };
      return { x: el.offsetLeft / S.zoom, y: el.offsetTop / S.zoom, w: el.offsetWidth / S.zoom, h: el.offsetHeight / S.zoom };
    }
    default: return { x: o.x, y: o.y, w: o.w, h: o.h };
  }
}
function drawSelection(pg, o, layer) {
  const z = S.zoom;
  const bb = objBBox(o, pg);
  const sb = document.createElement('div');
  sb.className = 'sel-box';
  Object.assign(sb.style, { left: bb.x * z + 'px', top: bb.y * z + 'px', width: bb.w * z + 'px', height: bb.h * z + 'px' });
  layer.appendChild(sb);
  const add = (h, x, y) => {
    const d = document.createElement('div');
    d.className = 'handle'; d.dataset.h = h; d.dataset.oid = o.id;
    Object.assign(d.style, { left: x * z + 'px', top: y * z + 'px' });
    layer.appendChild(d);
  };
  if (['box', 'ellipse', 'image'].includes(o.type)) {
    const { x, y, w, h } = bb;
    add('nw', x, y); add('n', x + w / 2, y); add('ne', x + w, y); add('e', x + w, y + h / 2);
    add('se', x + w, y + h); add('s', x + w / 2, y + h); add('sw', x, y + h); add('w', x, y + h / 2);
  } else if (o.type === 'line') { add('p1', o.x1, o.y1); add('p2', o.x2, o.y2); }
  else if (o.type === 'text' && S.editing !== o.id) add('fs', bb.x + bb.w, bb.y + bb.h);
}
function select(id) {
  const prev = S.sel && findObj(S.sel);
  S.sel = id;
  if (prev) renderLayer(prev.pg);
  const f = id && findObj(id);
  if (f && (!prev || f.pg !== prev.pg)) renderLayer(f.pg);
  renderProps();
}

/* ================================================================ EDITING EXISTING TEXT */
function sampleBg(pg, bb) {
  const el = pageEl(pg.id);
  const cv = el?.querySelector('canvas');
  if (!cv || !cv.width) return '#ffffff';
  const [W] = dispSize(pg);
  const s = cv.width / W;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const x0 = Math.max(0, Math.floor((bb.x - 2) * s)), y0 = Math.max(0, Math.floor((bb.y - 2) * s));
  const x1 = Math.min(cv.width - 1, Math.ceil((bb.x + bb.w + 2) * s)), y1 = Math.min(cv.height - 1, Math.ceil((bb.y + bb.h + 2) * s));
  if (x1 <= x0 || y1 <= y0) return '#ffffff';
  const img = ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  const counts = new Map();
  const W2 = img.width, H2 = img.height;
  const push = (x, y) => {
    const i = (y * W2 + x) * 4;
    const k = ((img.data[i] >> 3) << 10) | ((img.data[i + 1] >> 3) << 5) | (img.data[i + 2] >> 3);
    const c = counts.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    c.n++; c.r += img.data[i]; c.g += img.data[i + 1]; c.b += img.data[i + 2];
    counts.set(k, c);
  };
  for (let x = 0; x < W2; x++) { push(x, 0); push(x, H2 - 1); }
  for (let y = 0; y < H2; y++) { push(0, y); push(W2 - 1, y); }
  let best = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best ? rgb2hex(best.r / best.n, best.g / best.n, best.b / best.n) : '#ffffff';
}

async function editLine(pg, key, ev) {
  const model = await getModel(pg);
  const line = model.lines[key];
  if (!line?.editable) return;
  endEdit();
  let o = tlineFor(pg, key);
  const vp = viewportFor(pg, 1);
  if (!o) {
    o = { id: uid(), type: 'tline', key, text: line.text, bg: sampleBg(pg, unitsBBox(model, line.units, vp)) };
    pg.objects.unshift(o);
  }
  S.sel = o.id;
  const before = o.text;
  await renderLayer(pg);
  S.editing = o.id;
  const el = pageEl(pg.id);
  const layer = el.querySelector('.layer');
  // editor: the line's dominant style, the PDF's own font (unicode-mapped), exact colour
  const ref = line.units.find((u) => !u.syn) || line.units[0];
  const st = model.styles[ref.si];
  const info = RT.fonts.get(st.font);
  const fb = fallbackFor(info || { style: { family: 'Helvetica' } });
  const fam = info?.css ? `${info.css}, ${fallbackCss(fb)}` : fallbackCss(fb);
  const D = mul(vp, ref.M);
  const size = Math.hypot(D[2], D[3]);
  const sx = Math.hypot(D[0], D[1]) / size;
  const bl = baselineRatio(fam, info?.css ? null : fb.std);
  const first = line.units[0];
  const F = mul(vp, first.M);
  const z = S.zoom;
  const toDisp = size / (st.Tfs || 1);
  const bbOld = union(unitsBBox(model, line.units, vp), unitsBBox(model, layoutLine(model, line, o.text), vp));
  const cover = document.createElement('div');
  cover.className = 'cover';
  const place = () => {
    const w = Math.max(bbOld.w, ed.offsetWidth * sx / z);
    Object.assign(cover.style, { left: (bbOld.x - 0.8) * z + 'px', top: (bbOld.y - 0.8) * z + 'px', width: (w + 1.6) * z + 'px', height: (bbOld.h + 1.6) * z + 'px', background: o.bg });
  };
  const ed = document.createElement('div');
  ed.className = 'obj text editing';
  ed.dataset.oid = o.id;
  ed.textContent = o.text;
  ed.style.cssText = `left:${F[4] * z}px;top:${(F[5] - bl * size) * z}px;font-size:${size * z}px;font-family:${fam};color:${st.fill};` +
    `letter-spacing:${st.Tc * toDisp * z}px;word-spacing:${st.Tw * toDisp * z}px;transform:scaleX(${sx});transform-origin:0 0;` +
    (info?.css ? '' : `font-weight:${fb.std.bold ? 700 : 400};font-style:${fb.std.italic ? 'italic' : 'normal'};`);
  layer.querySelectorAll('.ghost, .cover').forEach((n) => n.remove());
  layer.append(cover, ed);
  place();
  try { ed.contentEditable = 'plaintext-only'; } catch { ed.contentEditable = 'true'; }
  if (ed.contentEditable !== 'plaintext-only') ed.contentEditable = 'true';
  ed.focus();
  placeCaret(ed, ev);
  const warn = () => renderProps();
  ed.addEventListener('input', () => { place(); o.text = ed.textContent.replace(/\n/g, ' '); warn(); });
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); S.editFinish?.(); }
    if (e.key === 'Escape') { e.preventDefault(); ed.textContent = before; S.editFinish?.(); }
    e.stopPropagation();
  });
  ed.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = (e.clipboardData.getData('text/plain') || '').replace(/[\r\n]+/g, ' ');
    document.execCommand('insertText', false, t);
  });
  let done = false;
  S.editFinish = () => { if (done) return; done = true; S.editFinish = null; finishLineEdit(pg, o, line, ed); };
  ed.addEventListener('blur', () => S.editFinish?.());
  renderProps();
}
function placeCaret(el, ev) {
  const sel = window.getSelection();
  let range = null;
  if (ev && document.caretRangeFromPoint) range = document.caretRangeFromPoint(ev.clientX, ev.clientY);
  if (!range || !el.contains(range.startContainer)) { range = document.createRange(); range.selectNodeContents(el); range.collapse(false); }
  sel.removeAllRanges(); sel.addRange(range);
}
function finishLineEdit(pg, o, line, ed) {
  o.text = ed.textContent.replace(/\n/g, ' ');
  if (!o.text.trim()) o.text = '';
  S.editing = null;
  if (o.text === line.text) pg.objects = pg.objects.filter((x) => x !== o);
  if (S.sel === o.id && (!o.text || !pg.objects.includes(o))) S.sel = null;
  commit();
  renderLayer(pg); refreshCanvas(pg); renderHits(pg); renderProps();
}
function endEdit() { S.editFinish?.(); }

/* ---- new text boxes ---- */
function editTextObj(pg, o, ev) {
  endEdit();
  S.sel = o.id; S.editing = o.id;
  renderLayer(pg);
  const el = pageEl(pg.id).querySelector(`.obj.text[data-oid="${o.id}"]`);
  if (!el) return;
  el.classList.add('editing');
  try { el.contentEditable = 'plaintext-only'; } catch {}
  if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
  el.focus();
  placeCaret(el, ev);
  let done = false;
  S.editFinish = () => {
    if (done) return;
    done = true; S.editFinish = null;
    o.text = el.innerText.replace(/\n$/, '');
    S.editing = null;
    if (!o.text.trim()) { pg.objects = pg.objects.filter((x) => x !== o); if (S.sel === o.id) S.sel = null; }
    commit(); renderLayer(pg); renderProps();
  };
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); S.editFinish?.(); } e.stopPropagation(); });
  el.addEventListener('blur', () => S.editFinish?.());
  renderProps();
}

/* ================================================================ POINTER INTERACTION */
let drag = null;
function ptIn(el, e) { const r = el.getBoundingClientRect(); return { x: (e.clientX - r.left) / S.zoom, y: (e.clientY - r.top) / S.zoom }; }

$('#pages').addEventListener('pointerdown', async (e) => {
  if (e.button !== 0) return;
  const el = e.target.closest('.page');
  if (!el) { if (!S.editing) select(null); return; }
  const pg = pageById(el.dataset.id);
  const p = ptIn(el, e);
  const oEl = e.target.closest('[data-oid]');
  const oid = oEl?.dataset.oid;
  if (S.editing && oid === S.editing) return; // caret placement inside the editor
  const handle = e.target.closest('.handle');
  const tool = S.tool;

  if (handle) {
    const f = findObj(handle.dataset.oid);
    if (!f) return;
    e.preventDefault();
    drag = { kind: 'resize', h: handle.dataset.h, pg, o: f.o, start: p, orig: JSON.parse(JSON.stringify(f.o)), el };
    el.setPointerCapture(e.pointerId);
    return;
  }
  // edit existing text
  const hit = e.target.closest('.hit');
  if (tool === 'edit' && hit) { e.preventDefault(); editLine(pg, +hit.dataset.key, e); return; }

  if (oid && ['select', 'edit', 'text'].includes(tool)) {
    const f = findObj(oid);
    if (!f) return;
    if (f.o.type === 'tline') {
      if (tool !== 'select' || e.detail >= 2) { e.preventDefault(); editLine(pg, f.o.key, e); return; }
      e.preventDefault(); endEdit(); select(oid); return;
    }
    if (f.o.type === 'text' && (tool === 'text' || e.detail >= 2)) { e.preventDefault(); editTextObj(pg, f.o, e); return; }
    e.preventDefault(); endEdit();
    if (S.sel !== oid) select(oid);
    drag = { kind: 'move', pg, o: f.o, start: p, orig: JSON.parse(JSON.stringify(f.o)), el, moved: false };
    el.setPointerCapture(e.pointerId);
    return;
  }
  e.preventDefault();
  endEdit();
  if (tool === 'select' || tool === 'edit') { select(null); return; }
  if (tool === 'cut') {
    drag = { kind: 'cut', pg, start: p, el };
    el.setPointerCapture(e.pointerId);
    return;
  }
  if (tool === 'text') {
    const d = S.defaults.text;
    const o = { id: uid(), type: 'text', x: p.x, y: p.y - d.size * 0.6, text: '', ...d };
    pg.objects.push(o);
    editTextObj(pg, o, null);
    return;
  }
  if (tool === 'draw') {
    const d = S.defaults.draw;
    const o = { id: uid(), type: 'path', points: [[round(p.x), round(p.y)]], ...d };
    pg.objects.push(o);
    drag = { kind: 'draw', pg, o, el };
    el.setPointerCapture(e.pointerId);
    renderLayer(pg);
    return;
  }
  if (['whiteout', 'highlight', 'rect', 'ellipse'].includes(tool)) {
    drag = { kind: 'create', tool, pg, start: p, el, rect: document.createElement('div') };
    drag.rect.className = 'drag-rect';
    el.querySelector('.marks').appendChild(drag.rect);
    el.setPointerCapture(e.pointerId);
    return;
  }
  if (tool === 'line' || tool === 'arrow') {
    const d = S.defaults[tool];
    const o = { id: uid(), type: 'line', x1: p.x, y1: p.y, x2: p.x, y2: p.y, ...d };
    pg.objects.push(o);
    drag = { kind: 'line', pg, o, el };
    el.setPointerCapture(e.pointerId);
  }
});

let rafPending = false;
function schedule(fn) { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; fn(); }); }

$('#pages').addEventListener('pointermove', (e) => {
  if (!drag) { if (S.tool === 'cut') hoverBand(e); return; }
  const p = ptIn(drag.el, e);
  const { pg, o } = drag;
  if (drag.kind === 'cut') { if (Math.abs(p.y - drag.start.y) > 3) showBand(drag.el, Math.min(p.y, drag.start.y), Math.max(p.y, drag.start.y)); return; }
  if (drag.kind === 'move') {
    let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    if (Math.abs(dx) + Math.abs(dy) > 0.5) drag.moved = true;
    if (o.type === 'tline') return;
    translateObj(o, drag.orig, dx, dy);
    schedule(() => renderLayer(pg));
  } else if (drag.kind === 'resize') {
    resizeObj(o, drag.orig, drag.h, p, drag.start, e.shiftKey);
    schedule(() => { renderLayer(pg); renderProps(); });
  } else if (drag.kind === 'draw') {
    const l = o.points[o.points.length - 1];
    if (Math.hypot(p.x - l[0], p.y - l[1]) > 0.8 / S.zoom * 2) { o.points.push([round(p.x), round(p.y)]); schedule(() => renderLayer(pg)); }
  } else if (drag.kind === 'line') {
    let { x, y } = p;
    if (e.shiftKey) { const a = Math.round(Math.atan2(y - o.y1, x - o.x1) / (Math.PI / 4)) * (Math.PI / 4), L = Math.hypot(x - o.x1, y - o.y1); x = o.x1 + L * Math.cos(a); y = o.y1 + L * Math.sin(a); }
    o.x2 = x; o.y2 = y;
    schedule(() => renderLayer(pg));
  } else if (drag.kind === 'create') {
    const r = normRect(drag.start, p);
    const z = S.zoom;
    Object.assign(drag.rect.style, { left: r.x * z + 'px', top: r.y * z + 'px', width: r.w * z + 'px', height: r.h * z + 'px' });
  }
});

$('#pages').addEventListener('pointerup', async (e) => {
  if (!drag) return;
  const d = drag; drag = null;
  const { pg } = d;
  if (d.kind === 'cut') {
    const p = ptIn(d.el, e);
    const band = Math.abs(p.y - d.start.y) > 3 ? { a: Math.min(p.y, d.start.y), b: Math.max(p.y, d.start.y) } : pg.blank ? null : detectBand(await getGeom(pg), p);
    clearBand();
    if (band) await deleteBand(pg, band.a, band.b);
    else toast('No row found here. Drag to mark the strip to delete.');
    return;
  }
  if (d.kind === 'create') {
    d.rect.remove();
    const p = ptIn(d.el, e);
    const r = normRect(d.start, p);
    const small = r.w < 3 && r.h < 3;
    if (d.tool === 'highlight') {
      const boxes = await textAwareBoxes(pg, r, small);
      if (boxes.length) {
        const ids = boxes.map((b) => { const o = { id: uid(), type: 'box', kind: 'highlight', ...b, ...S.defaults.highlight }; pg.objects.push(o); return o.id; });
        commit(); S.sel = ids[ids.length - 1]; renderLayer(pg); renderProps();
        return;
      }
    }
    if (small) return;
    const kind = d.tool === 'ellipse' ? 'ellipse' : 'box';
    const o = { id: uid(), type: kind, ...r, ...S.defaults[d.tool] };
    if (kind === 'box') o.kind = d.tool === 'rect' ? 'rect' : d.tool;
    pg.objects.push(o);
    commit(); S.sel = o.id;
    if (d.tool === 'rect' || d.tool === 'ellipse') setTool('select');
    renderLayer(pg); renderProps();
  } else if (d.kind === 'line') {
    if (Math.hypot(d.o.x2 - d.o.x1, d.o.y2 - d.o.y1) < 3) pg.objects = pg.objects.filter((x) => x !== d.o);
    else { S.sel = d.o.id; setTool('select'); }
    commit(); renderLayer(pg); renderProps();
  } else if (d.kind === 'draw') {
    if (d.o.points.length === 1) d.o.points.push([d.o.points[0][0] + 0.1, d.o.points[0][1]]);
    commit(); renderLayer(pg);
  } else if (d.kind === 'move' || d.kind === 'resize') {
    commit(); renderLayer(pg); renderProps();
  }
});

/* ---- delete-row tool: preview of the strip that a click would remove ---- */
let bandEl = null;
function showBand(el, a, b) {
  if (!bandEl) { bandEl = document.createElement('div'); bandEl.className = 'cut-band'; }
  const marks = el.querySelector('.marks');
  if (bandEl.parentNode !== marks) marks.appendChild(bandEl);
  Object.assign(bandEl.style, { top: a * S.zoom + 'px', height: (b - a) * S.zoom + 'px' });
}
function clearBand() { bandEl?.remove(); }
async function hoverBand(e) {
  const el = e.target.closest('.page');
  const pg = el && pageById(el.dataset.id);
  if (!pg || pg.blank) { clearBand(); return; }
  const p = ptIn(el, e);
  const g = await getGeom(pg);
  if (S.tool !== 'cut' || drag || !el.isConnected) return;
  const band = detectBand(g, p);
  if (band) showBand(el, band.a, band.b); else clearBand();
}
$('#pages').addEventListener('pointerleave', () => { if (!drag) clearBand(); });

function normRect(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; }
function translateObj(o, orig, dx, dy) {
  if (o.type === 'line') { o.x1 = orig.x1 + dx; o.y1 = orig.y1 + dy; o.x2 = orig.x2 + dx; o.y2 = orig.y2 + dy; }
  else if (o.type === 'path') o.points = orig.points.map(([x, y]) => [round(x + dx), round(y + dy)]);
  else { o.x = orig.x + dx; o.y = orig.y + dy; }
}
function resizeObj(o, orig, h, p, start, shift) {
  const dx = p.x - start.x, dy = p.y - start.y;
  if (h === 'p1') { o.x1 = p.x; o.y1 = p.y; return; }
  if (h === 'p2') { o.x2 = p.x; o.y2 = p.y; return; }
  if (h === 'fs') { const w = orig._w || 10; o.size = clamp(round(orig.size * (w + dx) / w, 1), 4, 400); return; }
  let { x, y, w, h: hh } = orig;
  if (h.includes('w')) { x += dx; w -= dx; }
  if (h.includes('e')) w += dx;
  if (h.includes('n')) { y += dy; hh -= dy; }
  if (h.includes('s')) hh += dy;
  const keep = (o.type === 'image') !== shift;
  if (keep && h.length === 2 && orig.w && orig.h) {
    const ratio = orig.w / orig.h;
    if (Math.abs(w / orig.w) > Math.abs(hh / orig.h)) { const nh = w / ratio; if (h.includes('n')) y += hh - nh; hh = nh; }
    else { const nw = hh * ratio; if (h.includes('w')) x += w - nw; w = nw; }
  }
  if (w < 0) { x += w; w = -w; }
  if (hh < 0) { y += hh; hh = -hh; }
  Object.assign(o, { x, y, w: Math.max(w, 1), h: Math.max(hh, 1) });
}
async function textAwareBoxes(pg, r, click) {
  if (pg.blank) return [];
  const model = await getModel(pg);
  const vp = viewportFor(pg, 1);
  const out = [];
  for (const ln of model.lines) {
    if (!ln.editable) continue;
    const b = unitsBBox(model, ln.units, vp);
    if (click) {
      if (r.x >= b.x && r.x <= b.x + b.w && r.y >= b.y && r.y <= b.y + b.h) out.push(b);
      continue;
    }
    const oy = Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y);
    if (oy < b.h * 0.3) continue;
    const x0 = Math.max(r.x, b.x), x1 = Math.min(r.x + r.w, b.x + b.w);
    if (x1 - x0 < 2) continue;
    out.push({ x: x0, y: b.y, w: x1 - x0, h: b.h });
  }
  return out;
}

/* ================================================================ TOOLS */
const HINTS = {
  select: 'Select, move and resize. Double-click text to edit. Delete removes; arrows nudge (Shift = 10pt).',
  edit: 'Click any line of existing text to edit it in its original font, size and colour. Enter to finish, Esc to cancel.',
  text: 'Click to add a text box. Shift+Enter for a new line while typing.',
  whiteout: 'Drag to cover an area with a solid box.',
  cut: 'Click a table row or a line to delete it and close the gap. Drag to mark any strip. Ctrl+Z brings it back.',
  highlight: 'Drag across text to highlight it; click a line to highlight all of it.',
  rect: 'Drag to draw a rectangle. Shift keeps it square after placement.',
  ellipse: 'Drag to draw an ellipse.',
  line: 'Drag to draw a line. Shift snaps to 45°.',
  arrow: 'Drag to draw an arrow. Shift snaps to 45°.',
  draw: 'Draw freehand.',
  image: 'Choose an image to place on the current page.',
  sign: 'Draw, type or reuse a signature.',
};
function setTool(t) {
  if (t === 'image') { $('#fileImage').click(); return; }
  if (t === 'sign') { if (S.pages.length) openSign(); return; }
  endEdit();
  clearBand();
  S.tool = t;
  $$('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  const host = $('#pages');
  host.className = 'pages t-' + t;
  $('#hint').textContent = S.pages.length ? HINTS[t] : 'Open a PDF to begin.';
  if (t === 'edit') {
    const vr = $('#viewport').getBoundingClientRect();
    S.pages.forEach((pg) => {
      const r = pageEl(pg.id)?.getBoundingClientRect();
      if (r && r.bottom > vr.top - 900 && r.top < vr.bottom + 900) renderHits(pg);
    });
  }
  renderProps();
}
$('#rail').addEventListener('click', (e) => { const b = e.target.closest('.tool'); if (b && S.pages.length) setTool(b.dataset.tool); });

/* ================================================================ PROPERTIES PANEL */
const SWATCHES = ['#111111', '#555555', '#ffffff', '#d93025', '#e8710a', '#f9ab00', '#188038', '#1a73e8', '#1a3fb8', '#9334e6'];
const HL_SWATCHES = ['#ffd400', '#7cf07c', '#6fd3ff', '#ff8ad8', '#ffae57'];
function renderProps() {
  const P = $('#props');
  if (!S.pages.length) { P.innerHTML = `<div class="p-sec"><p class="p-note">Open a PDF to see tools and properties here.</p></div>`; return; }
  const f = S.sel && findObj(S.sel);
  const o = f?.o;
  let h = '';
  if (o?.type === 'tline') h = tlineProps(f.pg, o);
  else if (o) h = objProps(o, false);
  else if (S.tool === 'cut') h = cutProps();
  else if (S.defaults[S.tool]) h = objProps({ type: toolType(S.tool), ...S.defaults[S.tool], kind: S.tool }, true);
  else h = docProps();
  P.innerHTML = h;
  if (o?.type === 'tline') fillTlineInfo(f.pg, o);
}
function toolType(t) { return t === 'text' ? 'text' : t === 'ellipse' ? 'ellipse' : t === 'line' || t === 'arrow' ? 'line' : t === 'draw' ? 'path' : 'box'; }
function docProps() {
  const n = S.pages.length;
  const edits = S.pages.reduce((a, p) => a + p.objects.length, 0);
  const gone = S.pages.reduce((a, p) => a + p.objects.filter((o) => o.type === 'tline' && !o.text).length, 0);
  return `<div class="p-sec"><h3 class="p-title">Document</h3>
    <p class="p-note"><b>${esc(S.fileName)}</b><br>${n} page${n > 1 ? 's' : ''} · ${edits} edit${edits === 1 ? '' : 's'}</p>
    ${gone ? `<p class="p-note" style="margin-top:8px">${gone} deleted text line${gone > 1 ? 's' : ''}</p><div class="p-actions" style="margin-top:6px"><button class="btn small" data-act="restore-deleted">Restore deleted text</button></div>` : ''}</div>
    <div class="p-sec"><h3 class="p-title">Shortcuts</h3><ul class="tips">
      <li><kbd>E</kbd> Edit existing text</li><li><kbd>T</kbd> Add text</li><li><kbd>V</kbd> Select</li>
      <li><kbd>W</kbd> Whiteout</li><li><kbd>H</kbd> Highlight</li><li><kbd>D</kbd> Draw</li>
      <li><kbd>Ctrl F</kbd> Find &amp; replace</li><li><kbd>Ctrl Z</kbd> Undo</li><li><kbd>Ctrl S</kbd> Save</li></ul></div>`;
}
function tlineProps(pg, o) {
  return `<div class="p-sec"><h3 class="p-title">Edited text</h3>
    <p class="p-note">Saved in the document's own font, size and colour at the original position. Characters you didn't change keep their exact placement.</p>
    <div id="tlInfo" class="p-note">Reading font…</div></div>
    <div class="p-sec"><div class="p-actions">
      <button class="btn small" data-act="edit-tline">Edit text</button>
      <button class="btn small" data-act="revert">Revert to original</button></div></div>
    <div class="p-sec"><div class="p-actions">
      <button class="btn small danger" data-act="del-line">Delete text</button>
      <button class="btn small danger" data-act="del-same" id="tlSame" hidden></button></div></div>`;
}
function cutProps() {
  return `<div class="p-sec"><h3 class="p-title">Delete row</h3>
    <p class="p-note">Click a table row or a line of text to remove it, borders included. Drag to mark any strip instead.</p>
    <label class="check" style="margin-top:10px"><input type="checkbox" data-check="close" ${S.defaults.cut.close ? 'checked' : ''}> Close the gap (move what is below up)</label></div>`;
}
async function fillTlineInfo(pg, o) {
  const model = await getModel(pg);
  const line = model.lines[o.key];
  const box = $('#tlInfo');
  if (!line || !box) return;
  const ref = line.units.find((u) => !u.syn) || line.units[0];
  const st = model.styles[ref.si];
  const info = RT.fonts.get(st.font);
  const size = Math.hypot(ref.M[2], ref.M[3]);
  const missing = info?.std14 ? [] : [...new Set([...o.text].filter((c) => c !== ' ' && !fontHas(info, c) && !line.text.includes(c)))];
  const fb = fallbackFor(info || { style: { family: 'Helvetica' } });
  let h = `<b>Font</b> ${esc(info?.psName || 'Unknown')}${info?.embedded ? ' (embedded)' : ''}<br><b>Size</b> ${round(size, 2)} pt &nbsp; <b>Colour</b> <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${st.fill};vertical-align:-1px;box-shadow:0 0 0 1px var(--line-strong)"></span> ${st.fill}`;
  if (missing.length) {
    if (info?.sysFont) h += `<p class="p-note" style="margin-top:8px">New characters (${esc(missing.join(' '))}) come from the full <b>${esc(info.sysFont.label)}</b> installed on this computer — same design.</p>`;
    else h += `<p class="p-warn" style="margin-top:8px">The PDF only embeds the characters it used. ${missing.length} new character${missing.length > 1 ? 's' : ''} (${esc(missing.join(' '))}) will use ${fb.custom ? esc(fb.custom.family) : 'a matching standard font'}.</p>` +
      (fb.custom ? '' : `<p class="p-note">For a perfect match, load the full font file (e.g. from C:\\Windows\\Fonts).</p><button class="btn small" data-act="font-upload">Load ${esc(info?.psName?.split(/[-,]/)[0] || 'font')} font file…</button>`);
  }
  box.innerHTML = h;
  // repeated text (watermarks, stamps): offer to remove every copy at once
  let same = 0;
  for (const p of S.pages) if (!p.blank) same += (await getModel(p)).lines.filter((l) => l.editable && l.text === line.text).length;
  const btn = $('#tlSame');
  if (btn && same > 1 && S.sel === o.id) { btn.textContent = `Delete all ${same} matching`; btn.hidden = false; }
}
function objProps(o, isDefault) {
  const title = isDefault ? ({ text: 'New text', whiteout: 'Whiteout', highlight: 'Highlight', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', draw: 'Pen' }[S.tool] || 'Tool') :
    ({ text: 'Text', box: o.kind === 'highlight' ? 'Highlight' : o.kind === 'whiteout' ? 'Whiteout' : 'Rectangle', ellipse: 'Ellipse', line: o.arrow ? 'Arrow' : 'Line', path: 'Drawing', image: 'Image' }[o.type]);
  let h = `<div class="p-sec"><h3 class="p-title">${title}${isDefault ? ' defaults' : ''}</h3>`;
  if (o.type === 'text') {
    const fonts = ['Helvetica', 'Times', 'Courier', ...RT.customFonts.keys()];
    h += `<div class="p-row"><label for="pFont">Font</label><select id="pFont" data-prop="font">${fonts.map((f) => `<option value="${esc(f)}" ${f === o.font ? 'selected' : ''}>${esc(f === 'Helvetica' ? 'Helvetica / Arial' : f === 'Times' ? 'Times' : f)}</option>`).join('')}<option value="__upload">Load font file…</option></select></div>
      <div class="p-row"><label for="pSize">Size</label><input id="pSize" type="number" min="4" max="400" step="0.5" value="${o.size}" data-prop="size" data-num>
      <span class="seg"><button data-toggle="bold" class="${o.bold ? 'on' : ''}" title="Bold"><b>B</b></button><button data-toggle="italic" class="${o.italic ? 'on' : ''}" title="Italic"><i>I</i></button><button data-toggle="underline" class="${o.underline ? 'on' : ''}" title="Underline"><u>U</u></button></span></div>
      <div class="p-row"><label>Align</label><span class="seg">${['left', 'center', 'right'].map((a) => `<button data-set="align" data-val="${a}" class="${o.align === a ? 'on' : ''}">${a[0].toUpperCase() + a.slice(1)}</button>`).join('')}</span></div>
      ${colorRow('Colour', 'color', o.color, false)}`;
  }
  if (o.type === 'box' || o.type === 'ellipse') {
    h += colorRow('Fill', 'fill', o.fill, true, o.kind === 'highlight' ? HL_SWATCHES : SWATCHES);
    if (o.kind !== 'highlight') h += colorRow('Border', 'stroke', o.stroke, true) + (o.stroke ? rangeRow('Width', 'sw', o.sw, 0.5, 20, 0.5) : '');
  }
  if (o.type === 'line' || o.type === 'path') {
    h += colorRow('Colour', 'stroke', o.stroke, false) + rangeRow('Width', 'sw', o.sw, 0.5, 30, 0.5);
    if (o.type === 'line') h += `<label class="check"><input type="checkbox" data-check="arrow" ${o.arrow ? 'checked' : ''}> Arrow head</label>`;
  }
  h += rangeRow('Opacity', 'opacity', o.opacity, 0.05, 1, 0.05) + '</div>';
  if (!isDefault) {
    const bb = objBBox(o, findObj(o.id)?.pg);
    if (o.type !== 'path' && o.type !== 'line') {
      h += `<div class="p-sec"><h3 class="p-title">Position (pt)</h3><div class="p-grid">
        <label>X <input type="number" step="0.5" value="${round(bb.x, 1)}" data-geo="x"></label><label>Y <input type="number" step="0.5" value="${round(bb.y, 1)}" data-geo="y"></label>
        ${o.type !== 'text' ? `<label>W <input type="number" step="0.5" value="${round(bb.w, 1)}" data-geo="w"></label><label>H <input type="number" step="0.5" value="${round(bb.h, 1)}" data-geo="h"></label>` : ''}</div></div>`;
    }
    h += `<div class="p-sec"><div class="p-actions">
      ${o.type === 'text' ? '<button class="btn small" data-act="edit-text">Edit text</button>' : ''}
      <button class="btn small" data-act="dup" title="Ctrl+D"><svg><use href="#i-copy"/></svg>Duplicate</button>
      <button class="btn small" data-act="front" title="Bring to front"><svg><use href="#i-front"/></svg></button>
      <button class="btn small" data-act="back" title="Send to back"><svg><use href="#i-back"/></svg></button>
      <button class="btn small danger" data-act="delete" title="Delete"><svg><use href="#i-trash"/></svg></button></div></div>`;
  }
  return h;
}
function colorRow(label, prop, val, allowNone, sw = SWATCHES) {
  return `<div class="p-row"><label>${label}</label><input type="color" value="${val || '#ffffff'}" data-prop="${prop}" aria-label="${label}">
    <div class="swatch-row">${allowNone ? `<button class="none" data-color="${prop}" data-val="" title="None"></button>` : ''}${sw.slice(0, allowNone ? 6 : 7).map((c) => `<button style="--c:${c}" data-color="${prop}" data-val="${c}" title="${c}"></button>`).join('')}</div></div>`;
}
function rangeRow(label, prop, val, min, max, step) {
  return `<div class="p-row"><label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-prop="${prop}" data-num><span class="val">${prop === 'opacity' ? Math.round(val * 100) + '%' : val}</span></div>`;
}
function setProp(prop, val, final = true) {
  const f = S.sel && findObj(S.sel);
  if (f && f.o.type !== 'tline') {
    f.o[prop] = val;
    renderLayer(f.pg);
    if (final) { commit(); renderProps(); }
  } else if (S.defaults[S.tool]) {
    S.defaults[S.tool][prop] = val;
    if (final) renderProps();
  }
}
$('#props').addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.prop && t.type === 'range') { setProp(t.dataset.prop, +t.value, false); const v = t.nextElementSibling; if (v) v.textContent = t.dataset.prop === 'opacity' ? Math.round(t.value * 100) + '%' : t.value; }
  if (t.dataset.prop && t.type === 'color') setProp(t.dataset.prop, t.value, false);
});
$('#props').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.prop) {
    if (t.value === '__upload') { $('#fileFont').click(); renderProps(); return; }
    setProp(t.dataset.prop, 'num' in t.dataset ? +t.value : t.value, true);
  }
  if (t.dataset.check) setProp(t.dataset.check, t.checked, true);
  if (t.dataset.geo) {
    const f = findObj(S.sel);
    if (!f) return;
    const o = f.o, v = +t.value;
    if (o.type === 'text' && t.dataset.geo in { x: 1, y: 1 }) o[t.dataset.geo] = v;
    else if ('x' in o) o[t.dataset.geo] = t.dataset.geo === 'w' || t.dataset.geo === 'h' ? Math.max(1, v) : v;
    commit(); renderLayer(f.pg);
  }
});
$('#props').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const f = S.sel && findObj(S.sel);
  if (b.dataset.toggle) { const cur = f && f.o.type !== 'tline' ? f.o[b.dataset.toggle] : S.defaults[S.tool]?.[b.dataset.toggle]; setProp(b.dataset.toggle, !cur); }
  if (b.dataset.set) setProp(b.dataset.set, b.dataset.val);
  if (b.dataset.color) setProp(b.dataset.color, b.dataset.val || null);
  const act = b.dataset.act;
  if (act === 'delete') deleteSelected();
  if (act === 'dup') duplicateSelected();
  if (act === 'front' || act === 'back') {
    const arr = f.pg.objects; const i = arr.indexOf(f.o); arr.splice(i, 1);
    if (act === 'front') arr.push(f.o); else arr.splice(arr.filter((x) => x.type === 'tline').length, 0, f.o);
    commit(); renderLayer(f.pg);
  }
  if (act === 'edit-text' && f) editTextObj(f.pg, f.o, null);
  if (act === 'edit-tline' && f) editLine(f.pg, f.o.key, null);
  if (act === 'revert' && f) { f.pg.objects = f.pg.objects.filter((x) => x !== f.o); S.sel = null; commit(); renderLayer(f.pg); refreshCanvas(f.pg); renderHits(f.pg); renderProps(); toast('Original text restored'); }
  if (act === 'font-upload') $('#fileFont').click();
  if ((act === 'del-line' || act === 'del-same') && f) deleteLineText(f.pg, f.o.key, act === 'del-same');
  if (act === 'restore-deleted') {
    S.pages.forEach((pg) => {
      if (!pg.objects.some((o) => o.type === 'tline' && !o.text)) return;
      pg.objects = pg.objects.filter((o) => o.type !== 'tline' || o.text);
      renderLayer(pg); refreshCanvas(pg); renderHits(pg);
    });
    commit(); renderProps(); toast('Deleted text restored');
  }
});
// keep the line editor open while its Delete buttons are pressed, so the click still knows the line
$('#props').addEventListener('mousedown', (e) => { if (S.editing && e.target.closest('[data-act^="del-"]')) e.preventDefault(); });

/* ---- custom fonts ---- */
$('#fileFont').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fk = fontkit.create(bytes);
    const family = (fk.familyName || file.name.replace(/\.\w+$/, '')) + (fk.subfamilyName && !/regular/i.test(fk.subfamilyName) ? ' ' + fk.subfamilyName : '');
    const face = new FontFace(family, bytes);
    await face.load(); document.fonts.add(face);
    RT.customFonts.set(family, { family, bytes, fk, ps: (fk.postscriptName || '').toLowerCase().replace(/[^a-z0-9]/g, '') });
    RT.baselines.clear();
    const f = S.sel && findObj(S.sel);
    if (f?.o.type === 'text') { f.o.font = family; commit(); renderLayer(f.pg); }
    else if (S.tool === 'text') S.defaults.text.font = family;
    // matching fonts improve fallback for edited lines
    S.pages.forEach((pg) => { if (pg.objects.some((o) => o.type === 'tline')) { RT.previews.delete(pg.id); refreshCanvas(pg); renderLayer(pg); } });
    renderProps();
    toast(`Loaded font “${family}”`);
  } catch (err) { toast('That font file could not be read: ' + err.message, 4000); }
});

/* ================================================================ OBJECT OPS */
function deleteSelected() {
  const f = S.sel && findObj(S.sel);
  if (!f) return;
  if (f.o.type === 'tline') { deleteLineText(f.pg, f.o.key, false); return; }
  f.pg.objects = f.pg.objects.filter((x) => x !== f.o);
  S.sel = null;
  commit(); renderLayer(f.pg); renderProps();
}
// Remove a line of existing text from the page; with `matching`, every identical line in the document.
async function deleteLineText(pg, key, matching) {
  const text = (await getModel(pg)).lines[key]?.text;
  if (text == null) return;
  endEdit();
  const touched = new Set();
  for (const p of matching ? S.pages : [pg]) {
    if (p.blank) continue;
    const edits = new Map(p.objects.filter((o) => o.type === 'tline').map((o) => [o.key, o]));
    for (const ln of (await getModel(p)).lines) {
      if (!ln.editable || (matching ? ln.text !== text : p !== pg || ln.key !== key)) continue;
      let o = edits.get(ln.key);
      if (!o) { o = { id: uid(), type: 'tline', key: ln.key, text: ln.text, bg: '#ffffff' }; p.objects.unshift(o); }
      if (o.text) { o.text = ''; touched.add(p); }
    }
  }
  S.sel = null;
  commit();
  for (const p of touched) { renderLayer(p); refreshCanvas(p); renderHits(p); }
  renderProps();
  toast(matching ? 'Matching text deleted on ' + touched.size + ' page' + (touched.size === 1 ? '' : 's') + ' · Ctrl+Z to undo' : 'Text deleted · Ctrl+Z to undo');
}
function cloneObj(o, off = 10) {
  const c = JSON.parse(JSON.stringify(o));
  c.id = uid();
  translateObj(c, JSON.parse(JSON.stringify(c)), off, off);
  return c;
}
function duplicateSelected() {
  const f = S.sel && findObj(S.sel);
  if (!f || f.o.type === 'tline') return;
  const c = cloneObj(f.o);
  f.pg.objects.push(c);
  S.sel = c.id; commit(); renderLayer(f.pg); renderProps();
}
function currentPage() { return S.pages[currentPageIndex()]; }
function paste() {
  if (!S.clip) return;
  const pg = currentPage();
  const c = cloneObj(S.clip, 12);
  S.clip = JSON.parse(JSON.stringify(c));
  pg.objects.push(c); S.sel = c.id; commit(); renderLayer(pg); renderProps();
}

/* ---- images & signatures ---- */
async function normalizeImage(file) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  let dataUrl;
  if (file.type === 'image/jpeg' || file.type === 'image/png') dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  else { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); dataUrl = c.toDataURL('image/png'); }
  URL.revokeObjectURL(url);
  return { dataUrl, w: img.naturalWidth, h: img.naturalHeight };
}
function placeImage(dataUrl, w, h, maxFrac = 0.5, extra = {}) {
  const pg = currentPage();
  if (!pg) return;
  const id = uid();
  S.images[id] = dataUrl;
  const [W, H] = dispSize(pg);
  const scale = Math.min(1, (W * maxFrac) / w, (H * maxFrac) / h);
  const ow = w * scale, oh = h * scale;
  const vp = $('#viewport').getBoundingClientRect(), r = pageEl(pg.id).getBoundingClientRect();
  const cy = clamp((vp.top + vp.height / 2 - r.top) / S.zoom, oh / 2, H - oh / 2);
  const o = { id: uid(), type: 'image', img: id, x: (W - ow) / 2, y: cy - oh / 2, w: ow, h: oh, opacity: 1, ...extra };
  pg.objects.push(o);
  setTool('select'); S.sel = o.id; commit(); renderLayer(pg); renderProps();
}
$('#fileImage').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const im = await normalizeImage(f); placeImage(im.dataUrl, im.w, im.h); } catch { toast('That image could not be read.'); }
});
document.addEventListener('paste', async (e) => {
  if (!S.pages.length || isTyping(e.target)) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); const im = await normalizeImage(item.getAsFile()); placeImage(im.dataUrl, im.w, im.h); }
  else if (S.clip) { e.preventDefault(); paste(); }
});

const PAD_W = 1800, PAD_H = 600;
const SIG = { tab: 'draw', pen: 'ballpoint', color: '#16161d', size: 1, smooth: true, zoom: 1, strokes: [], live: false, cache: null, cached: -1, saved: [], pick: -1 };
function loadSaved() { try { SIG.saved = JSON.parse(localStorage.getItem('folio.sigs') || '[]'); } catch { SIG.saved = []; } }
function storeSaved() { try { localStorage.setItem('folio.sigs', JSON.stringify(SIG.saved.slice(0, 6))); } catch {} }
function openSign() {
  loadSaved();
  $('#signModal').hidden = false;
  padZoom(1);
  showSignTab(SIG.saved.length ? 'saved' : 'draw');
  drawPad();
}
function showSignTab(t) {
  SIG.tab = t;
  $$('#signTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $$('.sign-pane').forEach((p) => (p.hidden = p.dataset.pane !== t));
  if (t === 'saved') {
    const box = $('#savedSigs');
    box.innerHTML = SIG.saved.length ? SIG.saved.map((s, i) => `<div class="saved-sig ${i === SIG.pick ? 'on' : ''}" data-i="${i}"><img src="${s}" alt="Saved signature ${i + 1}"><button class="mini" data-del="${i}" title="Remove"><svg><use href="#i-close"/></svg></button></div>`).join('') : '<p class="p-note">No saved signatures yet. Draw or type one; it will be remembered here.</p>';
  }
  if (t === 'type') setTimeout(() => $('#signText').focus(), 0);
}
$('#signTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showSignTab(b.dataset.tab); });
$('#savedSigs').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { SIG.saved.splice(+del.dataset.del, 1); storeSaved(); SIG.pick = -1; showSignTab('saved'); return; }
  const s = e.target.closest('.saved-sig');
  if (s) { SIG.pick = +s.dataset.i; showSignTab('saved'); }
});
$('#signModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === $('#signModal')) $('#signModal').hidden = true; });
function setInkColor(c, from) {
  SIG.color = c;
  $$('#signColors button').forEach((x) => x.classList.toggle('on', x === from));
  $('#signColor').value = c;
  $('#signPreview').style.color = c; inkChanged();
}
$('#signColors').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setInkColor(b.dataset.c, b); });
$('#signColor').addEventListener('input', (e) => setInkColor(e.target.value, null));
$('#signPens').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  SIG.pen = b.dataset.pen;
  $$('#signPens button').forEach((x) => x.classList.toggle('on', x === b));
  inkChanged();
});
$('#signSize').addEventListener('input', (e) => { SIG.size = +e.target.value; inkChanged(); });
$('#signUndo').addEventListener('click', () => { SIG.strokes.pop(); inkChanged(); });
$('#signSmooth').addEventListener('change', (e) => { SIG.smooth = e.target.checked; inkChanged(); });
// Zoom the board to write larger or finer; fx, fy is the spot (0…1 across the visible board) that stays put.
function padZoom(z, fx = 0.5, fy = 0.5) {
  const board = $('#signBoard'), pad = $('#signPad');
  z = clamp(z, 1, 4);
  const px = pad.offsetWidth ? (board.scrollLeft + fx * board.clientWidth) / pad.offsetWidth : 0.5, py = pad.offsetHeight ? (board.scrollTop + fy * board.clientHeight) / pad.offsetHeight : 0.5;
  if (z > 1 && !board.style.height) board.style.height = pad.offsetHeight + 'px'; // the board keeps its size; the sheet grows inside it
  if (z === 1) board.style.height = '';
  SIG.zoom = z;
  pad.style.width = z * 100 + '%';
  board.style.overflow = z > 1 ? 'auto' : 'hidden';
  board.scrollLeft = px * pad.offsetWidth - fx * board.clientWidth; board.scrollTop = py * pad.offsetHeight - fy * board.clientHeight;
  $('#signZoomVal').textContent = Math.round(z * 100) + '%';
}
$('#signZoomIn').addEventListener('click', () => padZoom(SIG.zoom < 2 ? SIG.zoom + 0.5 : SIG.zoom + 1));
$('#signZoomOut').addEventListener('click', () => padZoom(SIG.zoom <= 2 ? SIG.zoom - 0.5 : SIG.zoom - 1));
$('#signBoard').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect();
  padZoom(SIG.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
}, { passive: false });
$('#signText').addEventListener('input', (e) => { $('#signPreview').textContent = e.target.value || 'Your Name'; });
$('#signClear').addEventListener('click', () => { SIG.strokes = []; inkChanged(); });
/* ---- ink: strokes are rendered the way a pen lays them down, not as uniform lines.
 * A stroke is a spline through every point the hand produced, so no wave or corner is rounded away. It is
 * drawn as it grows (only the new part each frame, which keeps touch input responsive), with speed standing
 * in for pressure when there is no stylus: a slower hand leaves a slightly wider, denser line. */
function rng(a) {
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
let grainTile = null, inkL = null;
function inkGrain(ctx) {
  if (!grainTile) {
    grainTile = document.createElement('canvas'); grainTile.width = grainTile.height = 256;
    const g = grainTile.getContext('2d'), im = g.createImageData(256, 256), r = rng(7);
    for (let i = 0; i < im.data.length; i += 4) { const v = r(); im.data[i + 3] = v * v * v * 255; }
    g.putImageData(im, 0, 0);
  }
  return ctx.createPattern(grainTile, 'repeat');
}
// The stroke being worked on is built on its own layer and laid onto the sheet as one piece.
function inkLayer() {
  if (!inkL) { const c = document.createElement('canvas'); c.width = PAD_W; c.height = PAD_H; inkL = c.getContext('2d'); }
  return inkL;
}
const inkPen = () => { const marker = SIG.pen === 'marker'; return { marker, base: (marker ? 26 : 7.5) * SIG.size }; };
const inkWidth = (pen, p) => pen.base * (pen.marker ? 0.92 + 0.1 * p : 0.8 + 0.24 * p);
function inkReset(st) { st.Q = []; st.S = []; st.len = []; st.cf = []; st.seg = 0; st.np = 0; st.v = 0; st.body = 0; st.thin = 0; }
// Take in the points added since the last call. A span between two points is final once the point after it is
// known (or the pen has lifted: `fin`), so everything drawn here never has to be redrawn.
function inkFeed(st, L, fin) {
  const P = st.pts, n = P.length, Q = st.Q, pen = inkPen();
  for (; st.np < n; st.np++) { // pressure
    const i = st.np;
    if (i) {
      const dt = Math.max(1, P[i][3] - P[i - 1][3]);
      st.v += (Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]) / st.k / dt - st.v) * Math.min(1, dt / 50);
    }
    P[i][4] = st.stylus ? clamp(0.25 + P[i][2] * 1.1, 0.1, 1) : clamp(1.05 - st.v / 2.8, 0.15, 1);
  }
  // Steadying: the small wobbles a hand makes on glass are averaged out over a short stretch of line (D).
  // Corners and stroke ends are left exactly where they were drawn, and the stretch shrinks to nothing as it
  // nears one, so letters keep their shape; only the tremor goes. S holds the steadied points.
  const S = st.S, len = st.len, cf = st.cf, D = SIG.smooth ? 16 * st.k : 0, C = D * 0.75; // C: arm length for judging a corner, long enough that tremor is not mistaken for one
  for (let i = len.length; i < n; i++) len.push(i ? len[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]) : 0);
  const corner = (k) => {
    if (k <= 0 || k >= n - 1) return true;
    if (cf[k] !== undefined) return cf[k];
    let a = k, b = k;
    while (a > 0 && len[k] - len[a] < C) a--;
    while (b < n - 1 && len[b] - len[k] < C) b++;
    const ux = P[k][0] - P[a][0], uy = P[k][1] - P[a][1], vx = P[b][0] - P[k][0], vy = P[b][1] - P[k][1];
    return (cf[k] = ux * vx + uy * vy < 0.35 * Math.hypot(ux, uy) * Math.hypot(vx, vy)); // turns sharper than ~70°
  };
  while (S.length < n) {
    const i = S.length;
    if (!fin && (i === n - 1 || len[n - 1] - len[i] < D + C)) break; // not enough line ahead yet to judge this point
    let R = D;
    if (D && corner(i)) R = 0;
    for (let a = i - 1; R && a >= 0 && len[i] - len[a] <= R; a--) if (corner(a)) R = len[i] - len[a];
    for (let b = i + 1; R && b < n && len[b] - len[i] <= R; b++) if (corner(b)) R = len[b] - len[i];
    let sw = 0, sx = 0, sy = 0;
    for (let j = i; j >= 0 && len[i] - len[j] <= R; j--) { const w = Math.exp(-2 * ((len[i] - len[j]) / (R || 1)) ** 2); sw += w; sx += w * P[j][0]; sy += w * P[j][1]; }
    for (let j = i + 1; j < n && len[j] - len[i] <= R; j++) { const w = Math.exp(-2 * ((len[j] - len[i]) / (R || 1)) ** 2); sw += w; sx += w * P[j][0]; sy += w * P[j][1]; }
    S.push([sx / sw, sy / sw, 0, 0, P[i][4]]);
  }
  const ns = S.length;
  if (!Q.length && ns) Q.push({ x: S[0][0], y: S[0][1], p: S[0][4] });
  for (const last = fin ? ns - 1 : ns - 2; st.seg < last; st.seg++) { // Catmull-Rom span S[i] → S[i+1]
    const i = st.seg, a = S[Math.max(0, i - 1)], b = S[i], c = S[i + 1], d = S[Math.min(ns - 1, i + 2)];
    const steps = Math.max(1, Math.ceil(Math.hypot(c[0] - b[0], c[1] - b[1]) / 2));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const cr = (j) => 0.5 * (2 * b[j] + (c[j] - a[j]) * t + (2 * a[j] - 5 * b[j] + 4 * c[j] - d[j]) * t2 + (3 * b[j] - a[j] - 3 * c[j] + d[j]) * t3);
      Q.push({ x: cr(0), y: cr(1), p: b[4] + (c[4] - b[4]) * t });
    }
  }
  const dab = (q, rad) => { L.beginPath(); L.arc(q.x, q.y, rad, 0, 7); L.fill(); };
  L.save();
  L.lineCap = L.lineJoin = 'round'; L.strokeStyle = L.fillStyle = SIG.color;
  if (pen.marker) { L.shadowColor = SIG.color; L.shadowBlur = pen.base * 0.06; } // felt tips bleed slightly into the paper
  for (; st.body < Q.length; st.body++) { // the body of the line, width following pressure
    const i = st.body, q = Q[i], w = inkWidth(pen, q.p);
    if (!i) { dab(q, w * (pen.marker ? 0.5 : 0.56)); continue; } // where the tip first rests it leaves a little extra
    L.lineWidth = (inkWidth(pen, Q[i - 1].p) + w) / 2;
    L.beginPath(); L.moveTo(Q[i - 1].x, Q[i - 1].y); L.lineTo(q.x, q.y); L.stroke();
  }
  if (!pen.marker) { // ballpoint: a quicker hand leaves a little less ink, and the paper's tooth shows through it
    L.shadowBlur = 0; L.globalCompositeOperation = 'destination-out';
    const grain = inkGrain(L);
    for (const upto = fin ? Q.length : Q.length - 10; st.thin < upto; st.thin++) { // kept behind the body so later ink cannot cover it
      const i = st.thin, q = Q[i], w = inkWidth(pen, q.p), lite = 0.02 + 0.16 * Math.pow(1 - q.p, 1.5);
      L.globalAlpha = 1; L.fillStyle = `rgba(0,0,0,${1 - Math.pow(1 - lite, 1 / Math.max(2, w * 0.75))})`; dab(q, w * 0.75);
      if (i % 2 === 0) { L.fillStyle = grain; L.globalAlpha = 0.06 + 0.16 * (1 - q.p); dab(q, w * 0.8); }
    }
  }
  L.restore();
}
// Touches that need the whole stroke: done once, when the pen lifts.
function inkFinish(st, L) {
  const Q = st.Q, m = Q.length, pen = inkPen(), r = rng(st.seed);
  const trace = (off, when) => { // one path along the stroke, shifted sideways by `off`
    L.beginPath();
    let on = false;
    for (let i = 0; i < m; i++) {
      if (when && !when(Q[i])) { on = false; continue; }
      const a = Q[Math.max(0, i - 1)], b = Q[Math.min(m - 1, i + 1)], l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const x = Q[i].x - ((b.y - a.y) / l) * off, y = Q[i].y + ((b.x - a.x) / l) * off;
      if (on) L.lineTo(x, y); else L.moveTo(x, y);
      on = true;
    }
    L.stroke();
  };
  L.save();
  L.lineCap = L.lineJoin = 'round';
  L.globalCompositeOperation = 'destination-out';
  if (!pen.marker) { L.strokeStyle = 'rgba(0,0,0,.1)'; L.lineWidth = pen.base * 0.16; trace(pen.base * 0.13); } // the groove the ball rolls in
  else {
    L.strokeStyle = 'rgba(0,0,0,.06)'; L.lineWidth = pen.base * 0.6; trace(0); // ink gathers at the edges of the line
    for (let k = 0; k < 3; k++) { // a quick stroke drags the odd dry streak
      const off = (r() - 0.5) * pen.base * 0.8, thr = 0.2 + 0.15 * r();
      L.strokeStyle = `rgba(0,0,0,${0.06 + 0.12 * r()})`; L.lineWidth = pen.base * (0.03 + 0.03 * r());
      trace(off, (q) => q.p < thr);
    }
    L.fillStyle = inkGrain(L); L.globalAlpha = 0.1; L.fillRect(0, 0, PAD_W, PAD_H);
  }
  L.restore();
}
function inkStroke(L, st) { L.clearRect(0, 0, PAD_W, PAD_H); inkReset(st); inkFeed(st, L, true); inkFinish(st, L); }
// Lay a finished (or growing) stroke on the sheet; crossings come out darker, as they do with real ink.
function inkStamp(ctx, L) { ctx.save(); ctx.globalAlpha = SIG.pen === 'marker' ? 0.9 : 0.96; ctx.drawImage(L.canvas, 0, 0); ctx.restore(); }
function renderSig(ctx) { const L = inkLayer(); for (const st of SIG.strokes) { inkStroke(L, st); inkStamp(ctx, L); } }
function inkChanged() { SIG.cached = -1; drawPad(); }
// Finished strokes are cached; while the pen is down only the new part of its stroke is drawn.
function drawPad() {
  const ctx = $('#signPad').getContext('2d'), L = inkLayer();
  if (!SIG.cache) { SIG.cache = document.createElement('canvas'); SIG.cache.width = PAD_W; SIG.cache.height = PAD_H; }
  const done = SIG.strokes.length - (SIG.live ? 1 : 0), c = SIG.cache.getContext('2d');
  if (SIG.cached < 0 || SIG.cached > done) { c.clearRect(0, 0, PAD_W, PAD_H); SIG.cached = 0; }
  for (; SIG.cached < done; SIG.cached++) { inkStroke(L, SIG.strokes[SIG.cached]); inkStamp(c, L); }
  ctx.clearRect(0, 0, PAD_W, PAD_H);
  ctx.strokeStyle = '#d8d8d8'; ctx.lineWidth = 2; ctx.setLineDash([10, 10]); ctx.beginPath(); ctx.moveTo(90, PAD_H * 0.75); ctx.lineTo(PAD_W - 90, PAD_H * 0.75); ctx.stroke(); ctx.setLineDash([]);
  ctx.drawImage(SIG.cache, 0, 0);
  if (!SIG.live) return;
  const st = SIG.strokes[SIG.strokes.length - 1], pen = inkPen();
  inkFeed(st, L, false);
  inkStamp(ctx, L);
  const a = st.Q[st.Q.length - 1], P = st.pts; // the newest stretch is not settled yet: show it as drawn
  ctx.save(); ctx.globalAlpha = 0.9; ctx.strokeStyle = SIG.color; ctx.lineCap = ctx.lineJoin = 'round'; ctx.lineWidth = inkWidth(pen, P[P.length - 1][4] ?? 0.6);
  ctx.beginPath();
  if (a) ctx.moveTo(a.x, a.y); else ctx.moveTo(P[0][0], P[0][1]);
  for (let j = a ? st.seg + 1 : 0; j < P.length; j++) ctx.lineTo(P[j][0], P[j][1]);
  ctx.stroke(); ctx.restore();
}
(() => {
  const pad = $('#signPad'), board = $('#signBoard');
  const down = new Map(); // every finger or pen currently on the board
  let cur = null, raf = 0, pan = null;
  const pt = (e) => { const r = pad.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * PAD_W, ((e.clientY - r.top) / r.height) * PAD_H, e.pressure || 0.5, e.timeStamp]; };
  const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawPad(); }); };
  const two = () => { const [a, b] = [...down.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; };
  pad.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  pad.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { pad.setPointerCapture(e.pointerId); } catch {}
    if (cur) {
      // Two fingers landing together move or pinch-zoom the board. A touch that arrives later is a resting palm
      // and is ignored: only one pen writes at a time.
      if (e.pointerType === 'touch' && down.size === 2 && e.timeStamp - cur.t0 < 300 && cur.pts.length < 12) {
        SIG.strokes.pop(); SIG.live = false; cur = null;
        pan = { ...two(), z: SIG.zoom };
        drawPad();
      }
      return;
    }
    if (pan) return;
    drawPad(); // settle earlier strokes before the layer is reused
    cur = { pts: [pt(e)], seed: (Math.random() * 1e9) | 0, stylus: e.pointerType === 'pen', id: e.pointerId, t0: e.timeStamp, k: PAD_W / pad.getBoundingClientRect().width };
    inkLayer().clearRect(0, 0, PAD_W, PAD_H); inkReset(cur);
    SIG.strokes.push(cur); SIG.live = true;
    redraw();
  });
  pad.addEventListener('pointermove', (e) => {
    const f = down.get(e.pointerId);
    if (f) { f.x = e.clientX; f.y = e.clientY; }
    if (pan && down.size >= 2) {
      const t = two(), r = board.getBoundingClientRect();
      board.scrollLeft -= t.x - pan.x; board.scrollTop -= t.y - pan.y;
      pan.x = t.x; pan.y = t.y;
      if (Math.abs(t.d / pan.d - 1) > 0.06) padZoom(pan.z * (t.d / pan.d), (t.x - r.left) / r.width, (t.y - r.top) / r.height);
      return;
    }
    if (!cur || e.pointerId !== cur.id) return;
    const evs = e.getCoalescedEvents?.() || [];
    for (const c of evs.length ? evs : [e]) {
      const p = pt(c), l = cur.pts[cur.pts.length - 1];
      if (Math.hypot(p[0] - l[0], p[1] - l[1]) >= 1.6 * cur.k) cur.pts.push(p); // same spacing as the Draw tool
    }
    redraw();
  });
  const end = (e) => {
    down.delete(e.pointerId);
    if (pan) { if (down.size < 2) pan = null; return; }
    if (!cur || e.pointerId !== cur.id) return;
    const p = pt(e), l = cur.pts[cur.pts.length - 1];
    if (e.type === 'pointerup' && Math.hypot(p[0] - l[0], p[1] - l[1]) >= 0.5 * cur.k) cur.pts.push(p);
    const L = inkLayer();
    inkFeed(cur, L, true); inkFinish(cur, L);
    inkStamp(SIG.cache.getContext('2d'), L);
    SIG.cached = SIG.strokes.length;
    cur = null; SIG.live = false;
    drawPad();
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
})();
function trimCanvas(c) {
  const ctx = c.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}
$('#signPlace').addEventListener('click', async () => {
  let url = null, c;
  if (SIG.tab === 'saved') url = SIG.saved[SIG.pick];
  else if (SIG.tab === 'draw') {
    c = document.createElement('canvas'); c.width = PAD_W; c.height = PAD_H;
    renderSig(c.getContext('2d'));
    c = trimCanvas(c);
  } else {
    const t = $('#signText').value.trim();
    if (t) {
      c = document.createElement('canvas'); c.width = 2400; c.height = 500;
      const ctx = c.getContext('2d');
      ctx.font = '220px "Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive';
      ctx.fillStyle = SIG.color; ctx.textBaseline = 'middle'; ctx.fillText(t, 40, 250);
      c = trimCanvas(c);
    }
  }
  if (c) url = c.toDataURL('image/png');
  if (!url) { toast(SIG.tab === 'saved' ? 'Pick a saved signature first.' : 'Draw or type a signature first.'); return; }
  if (SIG.tab !== 'saved' && $('#signRemember').checked && !SIG.saved.includes(url)) { SIG.saved.unshift(url); storeSaved(); }
  const img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = url; });
  $('#signModal').hidden = true;
  const drawn = SIG.tab === 'draw';
  SIG.strokes = []; inkChanged();
  if (drawn) { // keep the pen's real line weight: the whole pad is about 230pt of paper
    const w = Math.max(24, (img.width / PAD_W) * 230);
    placeImage(url, w, (w * img.height) / img.width, 0.6, { ink: true });
    return;
  }
  const pg = currentPage();
  const [W] = dispSize(pg);
  const targetW = Math.min(W * 0.3, 180);
  placeImage(url, targetW * 4, (targetW * 4 * img.height) / img.width, 0.3, { ink: true });
});

/* ================================================================ PAGES & THUMBNAILS */
function buildThumbs() {
  RT.thumbObserver?.disconnect();
  const host = $('#thumbs');
  host.innerHTML = '';
  RT.thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { const pg = pageById(en.target.dataset.id); if (pg) renderThumb(pg, en.target); }
  }, { root: host, rootMargin: '300px 0px' });
  S.pages.forEach((pg, i) => {
    const [W, H] = dispSize(pg);
    const tw = 120, th = Math.round((tw * H) / W);
    const t = document.createElement('div');
    t.className = 'thumb'; t.dataset.id = pg.id; t.draggable = true; t.tabIndex = 0;
    t.innerHTML = `<div class="tcanvas" style="width:${tw}px;height:${th}px"></div><span class="tno">${i + 1}</span>
      <div class="tactions">
        <button class="mini" data-pa="rotl" title="Rotate left"><svg><use href="#i-rotl"/></svg></button>
        <button class="mini" data-pa="rotr" title="Rotate right"><svg><use href="#i-rotr"/></svg></button>
        <button class="mini" data-pa="dup" title="Duplicate page"><svg><use href="#i-copy"/></svg></button>
        <button class="mini" data-pa="del" title="Delete page"><svg><use href="#i-trash"/></svg></button></div>`;
    host.appendChild(t);
    RT.thumbObserver.observe(t);
  });
  updatePager();
}
async function renderThumb(pg, t) {
  const sig = tlineSig(pg) + R(pg);
  if (t._sig === sig) return;
  t._sig = sig;
  const box = t.querySelector('.tcanvas');
  const [W] = dispSize(pg);
  const scale = (120 / W) * Math.min(2, window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.style.width = '100%'; c.style.height = '100%';
  if (pg.blank) { box.replaceChildren(c); return; }
  try {
    const src = await renderSourcePage(pg);
    const vp = src.page.getViewport({ scale, rotation: R(pg) });
    c.width = vp.width; c.height = vp.height;
    await src.page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    if (t._sig === sig) box.replaceChildren(c);
  } catch (e) { if (e?.name !== 'RenderingCancelledException') console.warn(e); }
}
function refreshThumb(pg) { const t = $(`.thumb[data-id="${pg.id}"]`); if (t) { t._sig = null; renderThumb(pg, t); } }
$('#thumbs').addEventListener('click', (e) => {
  const t = e.target.closest('.thumb'); if (!t) return;
  const idx = S.pages.findIndex((p) => p.id === t.dataset.id);
  const b = e.target.closest('[data-pa]');
  if (!b) { scrollToPage(idx); return; }
  pageAction(b.dataset.pa, idx);
});
async function pageAction(a, idx) {
  endEdit();
  const pg = S.pages[idx];
  if (a === 'rotl' || a === 'rotr') { rotatePage(pg, a === 'rotr' ? 90 : -90); return; }
  if (a === 'dup') {
    const c = JSON.parse(JSON.stringify(pg));
    c.id = uid(); c.objects.forEach((o) => (o.id = uid()));
    S.pages.splice(idx + 1, 0, c);
  }
  if (a === 'del') {
    if (S.pages.length === 1) { toast('A document needs at least one page.'); return; }
    S.pages.splice(idx, 1);
    if (S.sel && !findObj(S.sel)) S.sel = null;
  }
  commit(); buildViewer(); renderProps();
}
function rotatePage(pg, delta) {
  const [W, H] = dispSize(pg);
  // keep placed objects attached to the same spot on the page
  const pt = (x, y) => (delta > 0 ? [H - y, x] : [y, W - x]);
  for (const o of pg.objects) {
    if (o.type === 'line') { [o.x1, o.y1] = pt(o.x1, o.y1); [o.x2, o.y2] = pt(o.x2, o.y2); }
    else if (o.type === 'path') o.points = o.points.map(([x, y]) => pt(x, y).map((v) => round(v)));
    else if (o.type === 'text') { const [nx, ny] = pt(o.x, o.y + (delta > 0 ? (o._h || o.size) : 0)); o.x = nx; o.y = ny; }
    else if ('w' in o) {
      const [ax, ay] = pt(o.x, o.y), [bx, by] = pt(o.x + o.w, o.y + o.h);
      Object.assign(o, { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) });
    }
  }
  pg.rot = (pg.rot + delta + 360) % 360;
  commit(); refreshPage(pg);
  const t = $(`.thumb[data-id="${pg.id}"]`);
  if (t) { const [W2, H2] = dispSize(pg); t.querySelector('.tcanvas').style.height = Math.round((120 * H2) / W2) + 'px'; refreshThumb(pg); }
}
function insertBlank() {
  endEdit();
  const idx = currentPageIndex();
  const ref = S.pages[idx];
  const [W, H] = ref ? dispSize(ref) : [612, 792];
  S.pages.splice(idx + 1, 0, { id: uid(), src: -1, index: -1, baseRot: 0, rot: 0, w: W, h: H, x0: 0, y0: 0, blank: true, objects: [] });
  commit(); buildViewer(); scrollToPage(idx + 1);
}
// drag-to-reorder
let dragIdx = -1;
$('#thumbs').addEventListener('dragstart', (e) => {
  const t = e.target.closest('.thumb'); if (!t) return;
  dragIdx = S.pages.findIndex((p) => p.id === t.dataset.id);
  t.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/x-folio-page', String(dragIdx));
});
$('#thumbs').addEventListener('dragover', (e) => {
  if (dragIdx < 0) return;
  e.preventDefault();
  $$('.thumb').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  const t = e.target.closest('.thumb'); if (!t) return;
  const r = t.getBoundingClientRect();
  t.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
});
$('#thumbs').addEventListener('drop', (e) => {
  if (dragIdx < 0) return;
  e.preventDefault(); e.stopPropagation();
  const t = e.target.closest('.thumb');
  if (t) {
    let to = S.pages.findIndex((p) => p.id === t.dataset.id);
    if (t.classList.contains('drop-after')) to++;
    const [m] = S.pages.splice(dragIdx, 1);
    if (dragIdx < to) to--;
    S.pages.splice(to, 0, m);
    commit(); buildViewer();
  }
  dragIdx = -1;
});
$('#thumbs').addEventListener('dragend', () => { dragIdx = -1; $$('.thumb').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'dragging')); });

/* ---- navigation ---- */
function currentPageIndex() {
  const vp = $('#viewport');
  const els = $$('.page');
  if (!els.length) return 0;
  const mid = vp.getBoundingClientRect().top + vp.clientHeight * 0.35;
  let best = 0, bd = Infinity;
  els.forEach((el, i) => { const r = el.getBoundingClientRect(); const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid)); if (d < bd) { bd = d; best = i; } });
  return best;
}
function scrollToPage(i, smooth = true) {
  const el = $$('.page')[i];
  if (el) $('#viewport').scrollTo({ top: el.offsetTop - 16, behavior: smooth ? 'smooth' : 'auto' });
}
function updatePager() {
  const i = currentPageIndex();
  $('#pageInput').value = S.pages.length ? i + 1 : 0;
  $('#pageCount').textContent = '/ ' + S.pages.length;
  $$('.thumb').forEach((t, k) => t.classList.toggle('on', k === i));
}
$('#viewport').addEventListener('scroll', () => schedule(updatePager), { passive: true });
$('#pageInput').addEventListener('change', (e) => { scrollToPage(clamp((+e.target.value || 1) - 1, 0, S.pages.length - 1)); });
$('#btnPrev').onclick = () => scrollToPage(Math.max(0, currentPageIndex() - 1));
$('#btnNext').onclick = () => scrollToPage(Math.min(S.pages.length - 1, currentPageIndex() + 1));
$('#btnAddPage').onclick = insertBlank;

/* ---- zoom ---- */
function setZoom(z, mode = null) {
  endEdit();
  const vp = $('#viewport');
  const idx = currentPageIndex();
  const el = $$('.page')[idx];
  const rel = el ? (vp.scrollTop - el.offsetTop) / el.offsetHeight : 0;
  S.zoomMode = mode;
  S.zoom = clamp(round(z, 3), 0.2, 6);
  const sel = $('#zoomSel');
  if (mode) sel.value = mode;
  else if ([...sel.options].some((o) => +o.value === S.zoom)) sel.value = String(S.zoom);
  else { $('#zoomCustom').textContent = Math.round(S.zoom * 100) + '%'; sel.value = 'custom'; }
  RT.observer?.disconnect();
  const host = $('#pages'); host.innerHTML = '';
  S.pages.forEach((pg, i) => host.appendChild(buildPageEl(pg, i)));
  const nel = $$('.page')[idx];
  if (nel) vp.scrollTop = nel.offsetTop + rel * nel.offsetHeight;
}
$('#zoomSel').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === 'fitw' || v === 'fitp') setZoom(computeFitZoom(v), v);
  else if (v !== 'custom') setZoom(+v);
});
const ZSTEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];
function zoomStep(dir) {
  const z = S.zoom;
  const next = dir > 0 ? ZSTEPS.find((s) => s > z + 0.001) : [...ZSTEPS].reverse().find((s) => s < z - 0.001);
  if (next) setZoom(next);
}
$('#btnZoomIn').onclick = () => zoomStep(1);
$('#btnZoomOut').onclick = () => zoomStep(-1);
$('#viewport').addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !S.pages.length) return;
  e.preventDefault();
  schedule(() => zoomStep(e.deltaY < 0 ? 1 : -1));
}, { passive: false });
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (S.zoomMode && S.pages.length) setZoom(computeFitZoom(S.zoomMode), S.zoomMode); }, 200); });

/* ================================================================ FIND & REPLACE */
const F = { results: [], i: -1 };
function openFind() {
  if (!S.pages.length) return;
  endEdit();
  $('#findbar').hidden = false;
  const inp = $('#findInput'); inp.focus(); inp.select();
  if (inp.value) runSearch();
}
function closeFind() { $('#findbar').hidden = true; $$('.flash').forEach((x) => x.remove()); F.results = []; }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function runSearch(keepIndex = false) {
  const q = $('#findInput').value;
  const cs = $('#findCase').checked;
  $$('.flash').forEach((x) => x.remove());
  F.results = [];
  if (!q) { $('#findCount').textContent = ''; return; }
  const re = new RegExp(escapeRe(q), cs ? 'g' : 'gi');
  for (const pg of S.pages) {
    const model = await getModel(pg);
    for (const ln of model.lines) {
      if (!ln.editable) continue;
      const t = tlineFor(pg, ln.key);
      const text = t ? t.text : ln.text;
      for (const m of text.matchAll(re)) F.results.push({ pg: pg.id, kind: 'line', key: ln.key, at: m.index, len: m[0].length });
    }
    for (const o of pg.objects) if (o.type === 'text') for (const m of o.text.matchAll(re)) F.results.push({ pg: pg.id, kind: 'obj', oid: o.id, at: m.index, len: m[0].length });
  }
  if (!keepIndex) F.i = F.results.length ? 0 : -1;
  else F.i = Math.min(F.i, F.results.length - 1);
  $('#findCount').textContent = F.results.length ? `${F.i + 1} of ${F.results.length}` : 'No results';
  showResult();
}
async function resultBox(r) {
  const pg = pageById(r.pg);
  if (r.kind === 'obj') { const f = findObj(r.oid); return f ? objBBox(f.o, pg) : null; }
  const model = await getModel(pg);
  const ln = model.lines[r.key];
  const t = tlineFor(pg, r.key);
  const units = layoutLine(model, ln, t ? t.text : ln.text);
  let c = 0;
  const sel = units.filter((u) => { const s = c; c += u.t.length; return s < r.at + r.len && c > r.at; });
  return unitsBBox(model, sel.length ? sel : units, viewportFor(pg, 1));
}
async function showResult() {
  $$('.flash').forEach((x) => x.remove());
  const r = F.results[F.i];
  if (!r) return;
  $('#findCount').textContent = `${F.i + 1} of ${F.results.length}`;
  const pg = pageById(r.pg);
  const el = pageEl(pg.id);
  const bb = await resultBox(r);
  if (!bb || !el) return;
  const z = S.zoom;
  const d = document.createElement('div');
  d.className = 'flash';
  Object.assign(d.style, { left: (bb.x - 1) * z + 'px', top: (bb.y - 1) * z + 'px', width: (bb.w + 2) * z + 'px', height: (bb.h + 2) * z + 'px' });
  el.querySelector('.marks').appendChild(d);
  const vp = $('#viewport');
  const top = el.offsetTop + bb.y * z - vp.clientHeight / 3;
  const left = el.offsetLeft + bb.x * z - vp.clientWidth / 3;
  vp.scrollTo({ top, left: Math.max(0, left), behavior: 'smooth' });
}
function stepResult(d) { if (!F.results.length) return; F.i = (F.i + d + F.results.length) % F.results.length; showResult(); }
async function replaceIn(r, rep) {
  const pg = pageById(r.pg);
  if (r.kind === 'obj') { const f = findObj(r.oid); if (f) f.o.text = f.o.text.slice(0, r.at) + rep + f.o.text.slice(r.at + r.len); return pg; }
  const model = await getModel(pg);
  const ln = model.lines[r.key];
  let t = tlineFor(pg, r.key);
  if (!t) { t = { id: uid(), type: 'tline', key: r.key, text: ln.text, bg: sampleBg(pg, unitsBBox(model, ln.units, viewportFor(pg, 1))) }; pg.objects.unshift(t); }
  t.text = t.text.slice(0, r.at) + rep + t.text.slice(r.at + r.len);
  if (t.text === ln.text) pg.objects = pg.objects.filter((x) => x !== t);
  return pg;
}
$('#replaceOne').onclick = async () => {
  const r = F.results[F.i];
  if (!r) return;
  const pg = await replaceIn(r, $('#replaceInput').value);
  commit(); renderLayer(pg); refreshCanvas(pg); renderHits(pg);
  await runSearch(true);
};
$('#replaceAll').onclick = async () => {
  if (!F.results.length) return;
  const rep = $('#replaceInput').value;
  const touched = new Set();
  // replace from the end so earlier offsets stay valid
  for (const r of [...F.results].reverse()) touched.add(await replaceIn(r, rep));
  const n = F.results.length;
  commit();
  touched.forEach((pg) => { renderLayer(pg); refreshCanvas(pg); renderHits(pg); });
  await runSearch();
  toast(`Replaced ${n} occurrence${n > 1 ? 's' : ''}`);
};
let findT;
$('#findInput').addEventListener('input', () => { clearTimeout(findT); findT = setTimeout(() => runSearch(), 180); });
$('#findCase').addEventListener('change', () => runSearch());
$('#findInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); stepResult(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') closeFind(); });
$('#replaceInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFind(); if (e.key === 'Enter') $('#replaceOne').click(); });
$('#findNext').onclick = () => stepResult(1);
$('#findPrev').onclick = () => stepResult(-1);
$('#findClose').onclick = closeFind;
$('#btnFind').onclick = openFind;

/* ================================================================ EXPORT */
function mapper(pg) {
  const r = R(pg), { w, h, x0, y0 } = pg;
  return (x, y) => {
    let X, Y;
    if (r === 0) { X = x; Y = h - y; } else if (r === 90) { X = y; Y = x; } else if (r === 180) { X = w - x; Y = y; } else { X = w - y; Y = h - x; }
    return { x: X + x0, y: Y + y0 };
  };
}
async function exportPdf() {
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const cache = new Map();
  const stats = { fallback: new Set(), replaced: 0 };
  // copy source pages (one copyPages call per source keeps shared resources shared)
  const wanted = new Map();
  S.pages.forEach((pg) => { if (!pg.blank) { if (!wanted.has(pg.src)) wanted.set(pg.src, []); wanted.get(pg.src).push(pg.index); } });
  const copied = new Map();
  for (const [src, idxs] of wanted) copied.set(src, await out.copyPages(await getLibDoc(src), idxs));
  const cursor = new Map();
  const first = await getLibDoc(S.pages.find((p) => !p.blank)?.src ?? 0).catch(() => null);
  for (const pg of S.pages) {
    let page;
    if (pg.blank) page = out.addPage([pg.w, pg.h]);
    else {
      const k = cursor.get(pg.src) || 0; cursor.set(pg.src, k + 1);
      page = out.addPage(copied.get(pg.src)[k]);
      await applyTextEdits(out, page, pg, cache, stats);
    }
    page.setRotation(degrees(R(pg)));
    const others = pg.objects.filter((o) => o.type !== 'tline');
    if (others.length) { wrapContents(out, page); for (const o of others) await drawObj(out, page, pg, o, cache, stats); }
  }
  try { if (first) { const t = first.getTitle(); if (t) out.setTitle(t); const a = first.getAuthor(); if (a) out.setAuthor(a); } } catch {}
  out.setProducer('Folio PDF Editor'); out.setModificationDate(new Date());
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, stats };
}
async function textFont(doc, cache, o) {
  const cf = RT.customFonts.get(o.font);
  if (cf) return outFont(doc, cache, 'cf:' + cf.family, async () => ({ font: await doc.embedFont(cf.bytes, { subset: true }), kind: 'custom' })).then((x) => x.font);
  const k = stdKey({ family: STD_FONTS[o.font] ? o.font : 'Helvetica', bold: o.bold, italic: o.italic });
  return outFont(doc, cache, 'std:' + k, async () => ({ font: await doc.embedFont(StandardFonts[k]), kind: 'std' })).then((x) => x.font);
}
function encodable(font, s, stats) {
  let out = '';
  for (const ch of s) { try { font.encodeText(ch); out += ch; } catch { out += '?'; stats.replaced++; } }
  return out;
}
async function drawObj(doc, page, pg, o, cache, stats) {
  const map = mapper(pg);
  const rot = degrees(R(pg));
  const op = o.opacity ?? 1;
  if (o.type === 'text') {
    const font = await textFont(doc, cache, o);
    const lines = o.text.split('\n').map((l) => encodable(font, l, stats));
    const widths = lines.map((l) => font.widthOfTextAtSize(l, o.size));
    const boxW = Math.max(0, ...widths);
    const fam = textCss(o);
    const bl = baselineRatio(fam, RT.customFonts.has(o.font) ? null : { bold: o.bold, italic: o.italic });
    lines.forEach((l, i) => {
      const dx = o.align === 'center' ? (boxW - widths[i]) / 2 : o.align === 'right' ? boxW - widths[i] : 0;
      const by = o.y + bl * o.size + i * LINE_H * o.size;
      if (l) { const p = map(o.x + dx, by); page.drawText(l, { x: p.x, y: p.y, size: o.size, font, color: pdfColor(o.color), opacity: op, rotate: rot }); }
      if (o.underline && l) {
        const a = map(o.x + dx, by + o.size * 0.12), b = map(o.x + dx + widths[i], by + o.size * 0.12);
        page.drawLine({ start: a, end: b, thickness: Math.max(0.5, o.size * 0.06), color: pdfColor(o.color), opacity: op });
      }
    });
  } else if (o.type === 'box' || o.type === 'ellipse') {
    const common = { opacity: op, borderOpacity: op, rotate: rot };
    if (o.fill) common.color = pdfColor(o.fill);
    if (o.stroke) { common.borderColor = pdfColor(o.stroke); common.borderWidth = o.sw; }
    if (o.kind === 'highlight') common.blendMode = BlendMode.Multiply;
    if (o.type === 'box') {
      // border drawn inside the box, like the on-screen rendering
      const inset = o.stroke ? o.sw / 2 : 0;
      const p = map(o.x + inset, o.y + o.h - inset);
      page.drawRectangle({ x: p.x, y: p.y, width: Math.max(0, o.w - 2 * inset), height: Math.max(0, o.h - 2 * inset), ...common });
    } else {
      const inset = o.stroke ? o.sw / 2 : 0;
      const c = map(o.x + o.w / 2, o.y + o.h / 2);
      page.drawEllipse({ x: c.x, y: c.y, xScale: Math.max(0, o.w / 2 - inset), yScale: Math.max(0, o.h / 2 - inset), ...common });
    }
  } else if (o.type === 'line' || o.type === 'path') {
    const d = o.type === 'line' ? lineD(o) : pathD(o.points);
    const origin = map(0, 0);
    page.drawSvgPath(d, { x: origin.x, y: origin.y, rotate: rot, borderColor: pdfColor(o.stroke), borderWidth: o.sw, borderOpacity: op, borderLineCap: LineCapStyle.Round });
  } else if (o.type === 'image') {
    const key = 'img:' + o.img;
    const img = await outFont(doc, cache, key, async () => {
      const data = S.images[o.img];
      const bytes = Uint8Array.from(atob(data.split(',')[1]), (c) => c.charCodeAt(0));
      return data.startsWith('data:image/jpeg') ? doc.embedJpg(bytes) : doc.embedPng(bytes);
    });
    const p = map(o.x, o.y + o.h);
    page.drawImage(img, { x: p.x, y: p.y, width: o.w, height: o.h, rotate: rot, opacity: op, ...(o.ink ? { blendMode: BlendMode.Multiply } : {}) });
  }
}
async function save(saveAs = false) {
  if (!S.pages.length) return;
  endEdit();
  const btn = $('#btnSave');
  btn.disabled = true;
  const label = btn.querySelector('span').textContent;
  btn.querySelector('span').textContent = 'Saving…';
  try {
    let { bytes, stats } = await exportPdf();
    if (S.fx.bw || S.fx.scan) bytes = await filterPdf(bytes, S.fx, (i, n) => toast(`Applying filter: page ${i} of ${n}…`, 60000));
    const base = S.fileName.replace(/\.pdf$/i, '');
    const suggested = S.fileHandle && !saveAs ? S.fileName : `${base}${/-edited$/.test(base) ? '' : '-edited'}.pdf`;
    let savedName = null;
    if (window.showSaveFilePicker) {
      try {
        if (!S.fileHandle || saveAs) S.fileHandle = await window.showSaveFilePicker({ suggestedName: suggested, types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] });
        const w = await S.fileHandle.createWritable();
        await w.write(bytes); await w.close();
        savedName = S.fileHandle.name;
      } catch (e) {
        if (e.name === 'AbortError') return;
        console.warn('File System Access failed, downloading instead', e);
        S.fileHandle = null;
      }
    }
    if (!savedName) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      a.download = suggested; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      savedName = suggested;
    }
    setDirty(false);
    let msg = `Saved ${savedName}`;
    if (stats.fallback.size) msg += ` · ${stats.fallback.size} new character${stats.fallback.size > 1 ? 's' : ''} used a fallback font`;
    if (stats.replaced) msg += ` · ${stats.replaced} unsupported character${stats.replaced > 1 ? 's' : ''} replaced with “?” (load a Unicode font)`;
    toast(msg, 4500);
  } catch (e) {
    console.error(e);
    toast('Saving failed: ' + e.message, 6000);
  } finally {
    btn.disabled = false; btn.querySelector('span').textContent = label;
  }
}
$('#btnSave').onclick = () => save(false);
$('#btnSaveAs').onclick = () => save(true);

/* ================================================================ PAGE FILTERS
 * Black & white and Scanned are independent switches. A filtered document is saved the way a scanner would
 * deliver it: every page becomes an image. The editor view only approximates the look with CSS so the page
 * stays editable; the saved file carries the real one. */
function setFx(name, on, quiet = false) {
  S.fx[name] = on;
  document.body.toggleAttribute('data-' + name, on);
  $(name === 'bw' ? '#fxBw' : '#fxScan').classList.toggle('on', on);
  if (quiet) return;
  setDirty(true);
  if (on) toast('Applied when you save. Filtered pages are saved as images, so their text is no longer selectable.', 4500);
}
$('#fxBw').onclick = () => setFx('bw', !S.fx.bw);
$('#fxScan').onclick = () => setFx('scan', !S.fx.scan);
function grayLook(c) {
  const ctx = c.getContext('2d'), im = ctx.getImageData(0, 0, c.width, c.height), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = clamp((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] - 128) * 1.08 + 128, 0, 255);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(im, 0, 0);
  return c;
}
// What a print-and-scan round trip does to a page, and no more: a good scan is clean and evenly lit. The sheet
// lies a fraction of a degree off square, toner spreads so strokes soften and thicken, black comes back as
// a slightly faded dark grey that is never perfectly even, paper as clean white (scanner apps whiten it), with
// fine sensor noise over it all.
// In `mono` (black & white scan) every ink, whatever its colour or how lightly it was laid, comes back as the
// same black, and anything fainter than ink (tints, pale stamps) drops out to white, as a scanner's text mode does.
function scanLook(src, seed, mono) {
  const w = src.width, h = src.height, r = rng(seed * 7919 + 13), u = w / 1700;
  const o = document.createElement('canvas'); o.width = w; o.height = h;
  const ctx = o.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2 + (r() - 0.5) * w * 0.005, h / 2 + (r() - 0.5) * h * 0.004);
  ctx.rotate((r() - 0.5) * 0.012);
  ctx.filter = `blur(${(0.6 * u).toFixed(2)}px)`;
  ctx.drawImage(src, -w / 2, -h / 2);
  ctx.restore();
  const im = ctx.getImageData(0, 0, w, h), d = im.data;
  const gw = 9, gh = 12, grid = new Float32Array((gw + 1) * (gh + 1)).map(() => 0.91 + (r() - 0.5) * 0.18); // toner fades in patches
  const lut = new Float32Array(256); // how much ink a scanned value amounts to (0 = paper, 1 = solid)
  for (let v = 0; v < 256; v++) {
    if (mono) { const t = clamp((v - 105) / 100, 0, 1); lut[v] = 1 - t * t * (3 - 2 * t); }
    else lut[v] = 1 - Math.pow(clamp((v - 22) / 213, 0, 1), 1.18);
    lut[v] = clamp((lut[v] - 0.07) / 0.93, 0, 1); // auto-whitening: the faintest tones wash out to paper
  }
  const paper = mono ? [254, 254, 254] : [254, 254, 251], black = mono ? 42 : 44; // print comes back a little faded
  const tilt = (r() - 0.5) * 0.02;
  for (let y = 0, i = 0; y < h; y++) {
    const fy = (y / h) * gh, y0 = Math.min(gh - 1, fy | 0), ty = fy - y0;
    for (let x = 0; x < w; x++, i += 4) {
      const fx = (x / w) * gw, x0 = Math.min(gw - 1, fx | 0), tx = fx - x0, g = y0 * (gw + 1) + x0;
      const den = (grid[g] * (1 - tx) + grid[g + 1] * tx) * (1 - ty) + (grid[g + gw + 1] * (1 - tx) + grid[g + gw + 2] * tx) * ty;
      const light = 1 - tilt * (x / w - 0.5), n = r() - 0.5;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      for (let k = 0; k < 3; k++) {
        const a = lut[mono ? Math.round(l) : Math.round(l + (d[i + k] - l) * 0.86)], ink = Math.min(1, a * den * (1 - 0.3 * Math.abs(n)));
        d[i + k] = clamp((paper[k] - (paper[k] - black) * ink) * light + n * (1.5 + 7 * a), 0, 255);
      }
    }
  }
  ctx.putImageData(im, 0, 0);
  for (let k = Math.round(3 + r() * 5); k > 0; k--) { // a few specks of dust on the glass
    ctx.fillStyle = `rgba(40,40,40,${0.2 + 0.3 * r()})`;
    ctx.beginPath(); ctx.arc(r() * w, r() * h, (0.4 + r() * r()) * u, 0, 7); ctx.fill();
  }
  return o;
}
async function filterPdf(bytes, fx, progress) {
  const src = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice() }).promise;
  const out = await PDFDocument.create();
  try {
    for (let i = 1; i <= src.numPages; i++) {
      progress?.(i, src.numPages);
      const page = await src.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(200 / 72, Math.sqrt(12e6 / (v1.width * v1.height))) }); // 200 dpi
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const done = fx.scan ? scanLook(c, i, fx.bw) : grayLook(c);
      const blob = await new Promise((res) => done.toBlob(res, 'image/jpeg', fx.scan ? 0.82 : 0.9));
      const img = await out.embedJpg(await blob.arrayBuffer());
      out.addPage([v1.width, v1.height]).drawImage(img, { x: 0, y: 0, width: v1.width, height: v1.height });
      page.cleanup(); c.width = done.width = 0;
    }
  } finally { src.destroy(); }
  out.setProducer('Folio PDF Editor');
  return out.save();
}

/* ================================================================ FILE ENTRY POINTS */
async function pickOpen() {
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] });
      await openFile(await h.getFile(), h);
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  $('#fileOpen').click();
}
$('#btnOpen').onclick = pickOpen;
$('#btnOpen2').onclick = pickOpen;
$('#fileOpen').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f); });
$('#btnMerge').onclick = () => $('#fileMerge').click();
$('#fileMerge').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) mergeFiles(fs); });
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#dropOverlay').hidden = false; } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true;
  const files = [...e.dataTransfer.files];
  const pdfs = files.filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  if (imgs.length && S.pages.length) { const im = await normalizeImage(imgs[0]); placeImage(im.dataUrl, im.w, im.h); return; }
  if (!pdfs.length) { toast('Drop a PDF file to open it.'); return; }
  if (!S.pages.length) { await openFile(pdfs[0]); if (pdfs.length > 1) mergeFiles(pdfs.slice(1)); return; }
  const choice = await ask('Add this PDF?', `${pdfs.map((f) => f.name).join(', ')}`, [
    { label: 'Cancel', value: null }, { label: 'Open instead', value: 'open' }, { label: 'Append pages', value: 'merge', primary: true },
  ]);
  if (choice === 'merge') mergeFiles(pdfs);
  else if (choice === 'open') openFile(pdfs[0]);
});
window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ---- sample document ---- */
$('#btnSample').onclick = async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const hb = await doc.embedFont(StandardFonts.HelveticaBold);
  const h = await doc.embedFont(StandardFonts.Helvetica);
  const t = await doc.embedFont(StandardFonts.TimesRoman);
  const ti = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const ink = rgb(0.1, 0.12, 0.16), blue = rgb(0.12, 0.3, 0.72), grey = rgb(0.42, 0.45, 0.5);
  page.drawRectangle({ x: 0, y: 712, width: 612, height: 80, color: rgb(0.93, 0.95, 0.99) });
  page.drawText('Northwind Studio', { x: 56, y: 752, size: 22, font: hb, color: blue });
  page.drawText('INVOICE  #2026-0418', { x: 56, y: 730, size: 10, font: h, color: grey });
  page.drawText('Billed to', { x: 56, y: 670, size: 9, font: hb, color: grey });
  page.drawText('Harbor & Pine Architects', { x: 56, y: 654, size: 12, font: h, color: ink });
  page.drawText('14 Quay Street, Portland, ME 04101', { x: 56, y: 639, size: 10, font: h, color: grey });
  page.drawText('Issued 18 September 2026 · Due 18 October 2026', { x: 330, y: 654, size: 10, font: h, color: ink });
  const rows = [['Brand identity refresh', '1', '$4,800.00'], ['Website design, 12 templates', '1', '$9,600.00'], ['Photography day rate', '2', '$2,400.00']];
  page.drawLine({ start: { x: 56, y: 600 }, end: { x: 556, y: 600 }, thickness: 0.8, color: grey });
  page.drawText('Description', { x: 56, y: 584, size: 9, font: hb, color: grey });
  page.drawText('Qty', { x: 400, y: 584, size: 9, font: hb, color: grey });
  page.drawText('Amount', { x: 490, y: 584, size: 9, font: hb, color: grey });
  rows.forEach((r, i) => {
    const y = 560 - i * 24;
    page.drawText(r[0], { x: 56, y, size: 11, font: h, color: ink });
    page.drawText(r[1], { x: 404, y, size: 11, font: h, color: ink });
    page.drawText(r[2], { x: 490, y, size: 11, font: h, color: ink });
  });
  page.drawLine({ start: { x: 330, y: 480 }, end: { x: 556, y: 480 }, thickness: 0.8, color: grey });
  page.drawText('Total due', { x: 330, y: 460, size: 12, font: hb, color: ink });
  page.drawText('$16,800.00', { x: 482, y: 460, size: 12, font: hb, color: blue });
  const para = [
    'Thank you for the collaboration this season. Payment is accepted by bank transfer to the',
    'account listed below; please quote the invoice number as the reference so we can match it',
    'quickly. Questions about this invoice can go to accounts@northwind.example.',
  ];
  para.forEach((l, i) => page.drawText(l, { x: 56, y: 380 - i * 16, size: 11.5, font: t, color: ink }));
  page.drawText('— Northwind Studio, Portland', { x: 56, y: 320, size: 11.5, font: ti, color: grey });
  await openBytes(await doc.save(), 'sample-invoice.pdf');
  setTool('edit');
  toast('Sample loaded. Click any line of text to edit it.');
};

/* ================================================================ KEYBOARD */
function isTyping(t) { return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }
const TOOL_KEYS = { v: 'select', e: 'edit', t: 'text', x: 'cut', w: 'whiteout', h: 'highlight', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', d: 'draw', i: 'image', s: 'sign' };
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); save(e.shiftKey); return; }
  if (mod && k === 'o') { e.preventDefault(); pickOpen(); return; }
  if (mod && k === 'f') { e.preventDefault(); openFind(); return; }
  if (isTyping(e.target)) return;
  if (!$('#signModal').hidden || !$('#askModal').hidden) { if (e.key === 'Escape') { $('#signModal').hidden = true; } return; }
  if (!S.pages.length) return;
  if (mod && (k === 'z' || k === 'y')) { e.preventDefault(); if (k === 'y' || e.shiftKey) redo(); else undo(); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomStep(1); return; }
  if (mod && k === '-') { e.preventDefault(); zoomStep(-1); return; }
  if (mod && k === '0') { e.preventDefault(); setZoom(1); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (mod && k === 'c') { const f = S.sel && findObj(S.sel); if (f && f.o.type !== 'tline') S.clip = JSON.parse(JSON.stringify(f.o)); return; }
  if (mod && k === 'x') { const f = S.sel && findObj(S.sel); if (f && f.o.type !== 'tline') { S.clip = JSON.parse(JSON.stringify(f.o)); deleteSelected(); } return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (S.sel) { e.preventDefault(); deleteSelected(); } return; }
  if (e.key === 'Escape') { if (!$('#findbar').hidden) closeFind(); else if (S.sel) select(null); else setTool('select'); return; }
  if (e.key === 'Enter' && S.sel) { const f = findObj(S.sel); if (f?.o.type === 'text') editTextObj(f.pg, f.o, null); else if (f?.o.type === 'tline') editLine(f.pg, f.o.key, null); return; }
  if (e.key.startsWith('Arrow') && S.sel) {
    const f = findObj(S.sel);
    if (!f || f.o.type === 'tline') return;
    e.preventDefault();
    const s = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, dy = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0;
    translateObj(f.o, JSON.parse(JSON.stringify(f.o)), dx, dy);
    commit(); renderLayer(f.pg); renderProps();
    return;
  }
  if (!mod && !e.altKey && TOOL_KEYS[k]) { setTool(TOOL_KEYS[k]); }
});

/* ---- boot ---- */
setTool('select');
renderProps();
