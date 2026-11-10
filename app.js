'use strict';

/* tegaki — 手写数字识别
   画板 → 裁墨迹包围盒 → 等比缩到 20×20 → 质心居中到 28×28 → 喂模型 */

const MODEL_URL = 'model/model.json';
const SIDE = 28;          // 模型输入边长
const BOX = 20;           // MNIST 里数字占据的框
const CENTER = 13.5;      // 28×28 的中心

const cv = document.getElementById('pad');
const ctx = cv.getContext('2d');
const wrap = cv.parentElement;
const elHint = document.getElementById('padHint');
const elDigit = document.getElementById('digit');
const elConf = document.getElementById('conf');
const elTop3 = document.getElementById('top3');
const elRows = document.getElementById('rows');
const btnUndo = document.getElementById('undo');
const btnClear = document.getElementById('clear');
const elStatus = document.getElementById('status');

/* ---------- 十档概率行 ---------- */
const cells = [];
for (let i = 0; i < 10; i++) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = '<span class="d">' + i + '</span><span class="track"><i></i></span><span class="p">0.0</span>';
  elRows.appendChild(row);
  cells.push({ row: row, bar: row.querySelector('i'), num: row.querySelector('.p') });
}

/* ---------- 画板 ---------- */
let size = 0;             // CSS 像素边长
let dpr = 1;
let lineW = 12;           // CSS 像素笔宽
let strokes = [];         // 每笔：[{x,y}] 归一化坐标
let live = null;
let drawing = false;
let activeId = null;

function fitCanvas() {
  const w = Math.round(wrap.getBoundingClientRect().width);
  const nextDpr = Math.min(window.devicePixelRatio || 1, 3);
  if (w < 1) return;
  if (w === size && cv.width === Math.round(w * nextDpr)) return;
  size = w;
  dpr = nextDpr;
  cv.width = Math.round(size * dpr);
  cv.height = Math.round(size * dpr);
  lineW = Math.max(6, size * 0.05);
  redraw();
}

function pathOf(points) {
  const n = points.length;
  if (!n) return;
  ctx.beginPath();
  if (n === 1) {
    ctx.arc(points[0].x * size, points[0].y * size, lineW / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    return;
  }
  ctx.moveTo(points[0].x * size, points[0].y * size);
  for (let i = 1; i < n - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    ctx.quadraticCurveTo(a.x * size, a.y * size, (a.x + b.x) / 2 * size, (a.y + b.y) / 2 * size);
  }
  const last = points[n - 1];
  ctx.lineTo(last.x * size, last.y * size);
  ctx.stroke();
}

function redraw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = lineW;
  for (let i = 0; i < strokes.length; i++) pathOf(strokes[i]);
  if (live) pathOf(live);
}

function localPoint(e) {
  const r = cv.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
  };
}

cv.addEventListener('pointerdown', function (e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (drawing) return;
  e.preventDefault();
  drawing = true;
  activeId = e.pointerId;
  try { cv.setPointerCapture(e.pointerId); } catch (err) {}
  live = [localPoint(e)];
  redraw();
  syncControls();
});

cv.addEventListener('pointermove', function (e) {
  if (!drawing || e.pointerId !== activeId) return;
  e.preventDefault();
  const p = localPoint(e);
  const last = live[live.length - 1];
  if (Math.hypot(p.x - last.x, p.y - last.y) * size < 1.1) return;
  live.push(p);
  redraw();
  schedulePredict();
});

function endStroke(e) {
  if (!drawing || (e && e.pointerId !== activeId)) return;
  drawing = false;
  activeId = null;
  if (live && live.length) strokes.push(live);
  live = null;
  redraw();
  syncControls();
  schedulePredict(true);
}

cv.addEventListener('pointerup', endStroke);
cv.addEventListener('pointercancel', endStroke);
cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });

/* ---------- 控件 ---------- */
function syncControls() {
  const empty = strokes.length === 0 && !live;
  btnUndo.disabled = empty;
  btnClear.disabled = empty;
  elHint.hidden = !empty;
}

btnUndo.addEventListener('click', function () {
  if (!strokes.length) return;
  strokes.pop();
  redraw();
  syncControls();
  schedulePredict(true);
});

btnClear.addEventListener('click', function () {
  strokes = [];
  live = null;
  redraw();
  syncControls();
  clearResult();
});

/* ---------- 预处理 ---------- */
function inkBox() {
  if (!strokes.length) return null;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (let s = 0; s < strokes.length; s++) {
    const pts = strokes[s];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
  }
  const pad = (lineW / 2) / size;
  const W = cv.width, H = cv.height;
  const sx = Math.max(0, Math.floor((x0 - pad) * W));
  const sy = Math.max(0, Math.floor((y0 - pad) * H));
  const ex = Math.min(W, Math.ceil((x1 + pad) * W));
  const ey = Math.min(H, Math.ceil((y1 + pad) * H));
  const sw = Math.max(3, ex - sx);
  const sh = Math.max(3, ey - sy);
  return { sx: sx, sy: sy, sw: Math.min(sw, W - sx), sh: Math.min(sh, H - sy) };
}

const tmp = document.createElement('canvas');
let tctx = null;

function centerOn(img) {
  let m = 0, mx = 0, my = 0;
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const v = img[y * SIDE + x];
      if (v > 0.06) { m += v; mx += x * v; my += y * v; }
    }
  }
  if (m <= 0) return null;
  const dx = Math.round(CENTER - mx / m);
  const dy = Math.round(CENTER - my / m);
  if (!dx && !dy) return img;
  const out = new Float32Array(SIDE * SIDE);
  for (let y = 0; y < SIDE; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= SIDE) continue;
    for (let x = 0; x < SIDE; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= SIDE) continue;
      out[ty * SIDE + tx] = img[y * SIDE + x];
    }
  }
  return out;
}

function toInput() {
  const b = inkBox();
  if (!b) return null;
  const scale = BOX / Math.max(b.sw, b.sh);
  const dw = Math.max(2, Math.round(b.sw * scale));
  const dh = Math.max(2, Math.round(b.sh * scale));
  if (tmp.width !== dw || tmp.height !== dh) {
    tmp.width = dw;
    tmp.height = dh;
    tctx = tmp.getContext('2d', { willReadFrequently: true });
  }
  tctx.clearRect(0, 0, dw, dh);
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(cv, b.sx, b.sy, b.sw, b.sh, 0, 0, dw, dh);

  const data = tctx.getImageData(0, 0, dw, dh).data;
  const img = new Float32Array(SIDE * SIDE);
  const ox = Math.round((SIDE - dw) / 2);
  const oy = Math.round((SIDE - dh) / 2);
  for (let y = 0; y < dh; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= SIDE) continue;
    for (let x = 0; x < dw; x++) {
      const tx = ox + x;
      if (tx < 0 || tx >= SIDE) continue;
      img[ty * SIDE + tx] = data[(y * dw + x) * 4 + 3] / 255;
    }
  }
  return centerOn(img);
}

/* ---------- 推理 ---------- */
let model = null;
let busy = false;
let nextAt = 0;
let pendTimer = 0;
let reqId = 0;

function schedulePredict(immediate) {
  if (!model) return;
  if (busy) {
    if (!pendTimer) pendTimer = setTimeout(function () { pendTimer = 0; schedulePredict(); }, 120);
    return;
  }
  const now = performance.now();
  const wait = immediate ? 0 : Math.max(0, nextAt - now);
  if (wait > 0) {
    if (!pendTimer) pendTimer = setTimeout(function () { pendTimer = 0; schedulePredict(); }, wait);
    return;
  }
  nextAt = now + 120;
  runPredict();
}

function softmax(a) {
  const m = Math.max.apply(null, a);
  const e = a.map(function (v) { return Math.exp(v - m); });
  const s = e.reduce(function (x, y) { return x + y; }, 0);
  return e.map(function (v) { return v / s; });
}

async function runPredict() {
  if (!model || busy) return;
  const input = toInput();
  if (!input) { clearResult(); return; }
  const my = ++reqId;
  busy = true;
  try {
    const probs = await infer(input);
    if (my === reqId) render(probs);
  } catch (err) {
    console.error(err);
  } finally {
    busy = false;
  }
}

async function infer(arr) {
  const x = tf.tensor4d(arr, [1, SIDE, SIDE, 1]);
  let y = null;
  try {
    y = model.execute(x);
    const t = Array.isArray(y) ? y[0] : y;
    const raw = Array.from(t.dataSync());
    const sum = raw.reduce(function (a, b) { return a + b; }, 0);
    return Math.abs(sum - 1) > 0.05 ? softmax(raw) : raw;
  } finally {
    if (y) {
      if (Array.isArray(y)) y.forEach(function (t) { t.dispose(); });
      else y.dispose();
    }
    x.dispose();
  }
}

/* ---------- 结果渲染 ---------- */
function render(p) {
  let idx = 0;
  for (let i = 1; i < 10; i++) if (p[i] > p[idx]) idx = i;
  const top = p[idx];
  const pct = p.map(function (v) { return v * 100; });

  elDigit.textContent = idx;
  elDigit.classList.remove('dim');

  let note = '';
  if (top < 0.55) note = ' <span style="color:#94a3b8;font-weight:500">· 不太确定</span>';
  elConf.innerHTML = '置信度 <b>' + pct[idx].toFixed(1) + '%</b>' + note;

  const order = p.map(function (v, i) { return { v: v, i: i }; })
    .sort(function (a, b) { return b.v - a.v; })
    .slice(0, 3);
  elTop3.innerHTML = order.map(function (o, k) {
    return '<span class="chip' + (k === 0 ? ' hot' : '') + '">' + o.i +
      ' <i>' + (o.v * 100).toFixed(1) + '%</i></span>';
  }).join('');

  for (let i = 0; i < 10; i++) {
    cells[i].bar.style.width = pct[i] < 0.4 ? '0' : pct[i].toFixed(1) + '%';
    cells[i].num.textContent = pct[i].toFixed(1);
    cells[i].row.classList.toggle('hot', i === idx);
  }
}

function clearResult() {
  reqId++;
  elDigit.textContent = '–';
  elDigit.classList.add('dim');
  elConf.textContent = '写一个数字试试';
  elTop3.innerHTML = '';
  for (let i = 0; i < 10; i++) {
    cells[i].bar.style.width = '0';
    cells[i].num.textContent = '0.0';
    cells[i].row.classList.remove('hot');
  }
}

/* ---------- 模型加载 ---------- */
function setStatus(kind, text) {
  elStatus.className = 'pill ' + kind;
  elStatus.textContent = text;
}

async function loadModel() {
  setStatus('loading', '模型加载中');
  try {
    model = await tf.loadGraphModel(MODEL_URL, {
      onProgress: function (f) {
        if (f > 0 && f < 1) setStatus('loading', '模型 ' + Math.round(f * 100) + '%');
      }
    });
    await tf.ready();
    tf.tidy(function () { model.execute(tf.zeros([1, SIDE, SIDE, 1])); });
    setStatus('ok', '模型已就绪');
    if (strokes.length) schedulePredict(true);
  } catch (err) {
    console.error(err);
    model = null;
    setStatus('error', '加载失败 · 点此重试');
  }
}

elStatus.addEventListener('click', function () {
  if (!model && elStatus.classList.contains('error')) {
    if (typeof tf === 'undefined') { location.reload(); return; }
    loadModel();
  }
});

/* ---------- 启动 ---------- */
if (window.ResizeObserver) {
  new ResizeObserver(fitCanvas).observe(wrap);
} else {
  window.addEventListener('resize', fitCanvas);
}
fitCanvas();
syncControls();
clearResult();

if (typeof tf === 'undefined') {
  setStatus('error', 'tfjs 没加载出来 · 点此重试');
} else {
  loadModel();
}

/* 调试口子：?debug=1 才挂，用来对比新旧预处理 */
if (location.search.indexOf('debug') >= 0) {
  window.__teg = {
    get model() { return model; },
    toInput: toInput,
    infer: infer,
    whole: function () {
      const c = document.createElement('canvas');
      c.width = SIDE;
      c.height = SIDE;
      const g = c.getContext('2d');
      g.drawImage(cv, 0, 0, cv.width, cv.height, 0, 0, SIDE, SIDE);
      const d = g.getImageData(0, 0, SIDE, SIDE).data;
      const out = new Float32Array(SIDE * SIDE);
      for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] / 255;
      return out;
    }
  };
}
