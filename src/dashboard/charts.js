// Charts drawn straight on a canvas: no library, so the dashboard works offline.
import { h } from './dom.js';

const GRID = '#24402f', TEXT = '#8fb7a0';

function sized(canvas, height, draw) {
  const go = () => {
    const W = canvas.clientWidth || 640, dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = height + 'px';
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, height);
    draw(c, W, height);
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(go).observe(canvas);
  requestAnimationFrame ? requestAnimationFrame(go) : go();
  return go;
}

// series: [{ label, color, values: [number|null], dashed? }], one value per x position.
// refLine: a dashed horizontal line (the pass mark).
export function lineChart(series, { height = 210, yMin = 0, yMax = 100, labels = null, refLine = null } = {}) {
  const canvas = h('canvas', { class: 'chart' });
  const n = Math.max(1, ...series.map((s) => s.values.length));
  sized(canvas, height, (c, W, H) => {
    const L = 34, R = 10, T = 10, B = 22, w = W - L - R, ht = H - T - B;
    const X = (i) => L + (n === 1 ? w / 2 : (i / (n - 1)) * w), Y = (v) => T + ht - ((v - yMin) / (yMax - yMin)) * ht;
    c.font = '11px monospace';
    c.textAlign = 'right';
    c.fillStyle = TEXT;
    c.strokeStyle = GRID;
    c.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const v = yMin + ((yMax - yMin) * g) / 4;
      c.beginPath();
      c.moveTo(L, Y(v));
      c.lineTo(W - R, Y(v));
      c.stroke();
      c.fillText(String(Math.round(v)), L - 5, Y(v) + 4);
    }
    if (refLine != null) {
      c.setLineDash([4, 4]);
      c.strokeStyle = '#6b7f73';
      c.beginPath();
      c.moveTo(L, Y(refLine));
      c.lineTo(W - R, Y(refLine));
      c.stroke();
      c.setLineDash([]);
    }
    c.textAlign = 'center';
    const step = Math.max(1, Math.ceil(n / 10));
    for (let i = 0; i < n; i += step) c.fillText(labels ? labels[i] ?? '' : String(i + 1), X(i), H - 6);
    for (const s of series) {
      c.strokeStyle = s.color;
      c.fillStyle = s.color;
      c.lineWidth = 2;
      c.setLineDash(s.dashed ? [5, 4] : []);
      c.beginPath();
      let pen = false;
      s.values.forEach((v, i) => {
        if (v == null) {
          pen = false;
          return;
        }
        if (pen) c.lineTo(X(i), Y(v));
        else c.moveTo(X(i), Y(v));
        pen = true;
      });
      c.stroke();
      c.setLineDash([]);
      if (!s.dashed) s.values.forEach((v, i) => {
        if (v == null) return;
        c.beginPath();
        c.arc(X(i), Y(v), 3, 0, Math.PI * 2);
        c.fill();
      });
    }
  });
  const legend = h('div', { class: 'legend' }, series.map((s) => h('span', null, h('i', { style: { background: s.color } }), s.label)));
  return h('div', { class: 'chartbox' }, canvas, legend);
}

export function sparkline(values, { w = 90, hgt = 26 } = {}) {
  const canvas = h('canvas', { width: w, height: hgt, class: 'spark' });
  const c = canvas.getContext('2d');
  if (values.length) {
    c.strokeStyle = '#4dff88';
    c.lineWidth = 1.5;
    c.beginPath();
    values.forEach((v, i) => {
      const x = values.length === 1 ? w / 2 : 2 + (i / (values.length - 1)) * (w - 4), y = hgt - 2 - (v / 100) * (hgt - 4);
      if (i) c.lineTo(x, y);
      else c.moveTo(x, y);
    });
    c.stroke();
  }
  return canvas;
}

// The per-contact timeline of one session: when each contact launched, became visible, was
// designated, classified, engaged, and how it ended.
export function timeline(contacts, duration) {
  const rowH = 22, H = 28 + contacts.length * rowH;
  const canvas = h('canvas', { class: 'chart' });
  sized(canvas, H, (c, W) => {
    const L = 52, R = 12, end = Math.max(20, duration, ...contacts.map((x) => x.outcomeT || 0)) + 2;
    const X = (t) => L + (t / end) * (W - L - R);
    c.font = '11px monospace';
    c.fillStyle = TEXT;
    c.strokeStyle = GRID;
    c.textAlign = 'center';
    const tick = end > 150 ? 30 : 10;
    for (let t = 0; t <= end; t += tick) {
      c.beginPath();
      c.moveTo(X(t), 14);
      c.lineTo(X(t), H - 4);
      c.stroke();
      c.fillText(`${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, X(t), 10);
    }
    contacts.forEach((k, i) => {
      const y = 28 + i * rowH + rowH / 2;
      c.textAlign = 'right';
      c.fillStyle = k.truth === 'ATTACK' || k.truth === 'RECON' ? '#ff9a8a' : '#9be3b5';
      c.fillText(k.id, L - 8, y + 4);
      const t1 = k.outcomeT ?? k.tSpawn + 5;
      c.strokeStyle = '#3a5a49';
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(X(k.tSpawn), y);
      c.lineTo(X(t1), y);
      c.stroke();
      const dot = (t, col, shape = 'o') => {
        if (t == null) return;
        c.fillStyle = col;
        c.beginPath();
        if (shape === 'o') c.arc(X(t), y, 4, 0, Math.PI * 2);
        else if (shape === 's') c.rect(X(t) - 4, y - 4, 8, 8);
        else if (shape === '^') {
          c.moveTo(X(t), y - 5);
          c.lineTo(X(t) + 5, y + 4);
          c.lineTo(X(t) - 5, y + 4);
          c.closePath();
        }
        c.fill();
      };
      dot(k.tObs, '#ffffff');
      dot(k.tDes, '#ffd23f');
      dot(k.guessT, k.guess === k.truth ? '#4dff88' : '#ff6b6b', 's');
      dot(k.engageT, '#ff9a3d', '^');
      dot(k.outcomeT, k.outcome === 'neutralized' ? '#4dff88' : k.outcome === 'leaked' ? '#ff4d4d' : '#8a948e');
    });
  });
  const legend = h('div', { class: 'legend' }, [['#fff', 'visible'], ['#ffd23f', 'designated'], ['#4dff88', 'classified right / neutralised'], ['#ff6b6b', 'classified wrong'], ['#ff9a3d', 'engaged'], ['#ff4d4d', 'reached position']].map(([col, t]) => h('span', null, h('i', { style: { background: col } }), t)));
  return h('div', { class: 'chartbox' }, canvas, legend);
}
