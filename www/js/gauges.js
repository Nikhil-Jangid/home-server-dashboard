// Radial gauges (SVG) and sparklines (canvas).
import { cssColor } from './format.js';

const ARC = 240.3; // 75% of 2π·51 → the 270° arc

export function gaugeDash(pct) {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return ((p / 100) * ARC).toFixed(1) + ' 320.4';
}

export function setGauge(root, pct, color, text) {
  const value = root.querySelector('.value');
  value.setAttribute('stroke-dasharray', gaugeDash(pct));
  value.style.stroke = color; // a style, not the attribute: presentation attributes can't take var()
  root.querySelector('.gauge-num').textContent = text;
}

export function sparkPoints(data, w, h, max) {
  const step = w / 59;
  const m = Number.isFinite(max) && max > 0 ? max : 0; // no usable scale → flat line on the baseline
  return data.map((v, i) => {
    const r = m && Number.isFinite(v) ? Math.min(Math.max(v, 0), m) / m : 0;
    return [Math.round(i * step * 100) / 100, Math.round((h - 3 - r * (h - 6)) * 100) / 100];
  });
}

/**
 * One easing step of displayed values toward targets. A value snaps once it is within
 * 0.05% of its own range (so percentages and bytes/s settle alike). Returns true while anything is still moving.
 */
export function easeStep(disp, tgt, ranges = {}) {
  let moving = false;
  for (const k in tgt) {
    const d = tgt[k] - disp[k];
    const eps = (ranges[k] > 0 ? ranges[k] : 100) * 0.0005;
    if (Math.abs(d) > eps) { disp[k] += d * 0.16; moving = true; } else disp[k] = tgt[k];
  }
  return moving;
}

/** Colours may be 'var(--token)': they are resolved on every draw, so a theme switch shows on the next frame. */
export function drawSpark(canvas, series, { max, readVar } = {}) {
  if (!canvas) return;
  const dpr = globalThis.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const col = v => cssColor(v, readVar);
  c.strokeStyle = col('var(--spark-grid)');
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(0, h - 0.5); c.lineTo(w, h - 0.5); c.stroke();
  const top = max || Math.max(1, ...series.flatMap(s => s.data.filter(Number.isFinite)));
  for (const s of series) {
    if (s.data.length < 2) continue;
    const pts = sparkPoints(s.data, w, h, top);
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.strokeStyle = col(s.color); c.lineWidth = 1.6; c.lineJoin = 'round'; c.stroke();
    if (s.fill) {
      c.lineTo(pts[pts.length - 1][0], h); c.lineTo(0, h); c.closePath();
      c.fillStyle = col(s.fill); c.fill();
    }
  }
}
