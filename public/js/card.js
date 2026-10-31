// Share card: a 1080×1350 PNG with your grade, style, time and the shape of your run
// (briefed route dashed, your path in orange / red where you went off it). No map tiles,
// so it draws instantly and offline.

const W = 1080;
const H = 1350;
const C = { bg: '#0a0a0b', raise: '#151517', line: '#26262a', text: '#f2f2ef', muted: '#8d8f96', accent: '#ff8a1f', danger: '#ff5a52', ok: '#3ddc84' };
const DISPLAY = '"Barlow Condensed", "Arial Narrow", sans-serif';

/** Fit lat/lon points into a box, north up, equal scale on both axes. */
function projector(points, box) {
  const k = Math.cos(((points.reduce((a, p) => a + p.lat, 0) / points.length) * Math.PI) / 180);
  const xs = points.map((p) => p.lon * k);
  const ys = points.map((p) => p.lat);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.min(box.w / (x1 - x0 || 1e-9), box.h / (y1 - y0 || 1e-9));
  const ox = box.x + (box.w - (x1 - x0) * s) / 2;
  const oy = box.y + (box.h - (y1 - y0) * s) / 2;
  return (p) => [ox + (p.lon * k - x0) * s, oy + (y1 - p.lat) * s];
}

function fitText(ctx, text, maxW, size, weight = 800) {
  let s = size;
  do ctx.font = `${weight} ${s}px ${DISPLAY}`;
  while (ctx.measureText(text).width > maxW && (s -= 4) > 20);
  return s;
}

/**
 * @param {object} d { grade, score, style: {name, line}, name, label, time, stats: [[label, value]], route: [{lat,lon}], track: [[lat,lon,t,off]], url }
 * @returns {Promise<Blob>}
 */
export async function renderCard(d) {
  await document.fonts?.ready;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const pad = 80;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.8, 0, 0, W * 0.8, 0, W);
  glow.addColorStop(0, 'rgba(255,138,31,.22)');
  glow.addColorStop(1, 'rgba(255,138,31,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Run shape
  const box = { x: W - pad - 420, y: pad + 10, w: 420, h: 420 };
  const all = [...(d.route ?? []), ...(d.track ?? []).map(([lat, lon]) => ({ lat, lon }))];
  if (all.length > 1) {
    const P = projector(all, box);
    ctx.lineCap = ctx.lineJoin = 'round';
    if (d.route?.length > 1) {
      ctx.setLineDash([10, 16]);
      ctx.strokeStyle = 'rgba(242,242,239,.5)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      d.route.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...P(p)));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const t = d.track ?? [];
    ctx.lineWidth = 10;
    for (let i = 1; i < t.length; i++) {
      ctx.strokeStyle = t[i][3] ? C.danger : C.accent;
      ctx.beginPath();
      ctx.moveTo(...P({ lat: t[i - 1][0], lon: t[i - 1][1] }));
      ctx.lineTo(...P({ lat: t[i][0], lon: t[i][1] }));
      ctx.stroke();
    }
    const end = d.route?.at(-1) ?? (t.length ? { lat: t.at(-1)[0], lon: t.at(-1)[1] } : null);
    if (end) {
      const [x, y] = P(end);
      const sq = 9;
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        ctx.fillStyle = (r + c) % 2 ? '#111' : '#fff';
        ctx.fillRect(x - 2 * sq + c * sq, y - 2 * sq + r * sq, sq, sq);
      }
    }
  }

  // Grade
  ctx.fillStyle = C.accent;
  ctx.font = `800 400px ${DISPLAY}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(d.grade ?? '—', pad - 10, pad + 330);
  ctx.fillStyle = C.muted;
  ctx.font = `700 40px ${DISPLAY}`;
  ctx.fillText(`${d.score ?? 0} / 1000`, pad, pad + 400);

  // Style
  let y = 640;
  ctx.fillStyle = C.text;
  fitText(ctx, d.style.name.toUpperCase(), W - pad * 2, 96);
  ctx.fillText(d.style.name.toUpperCase(), pad, y);
  y += 56;
  ctx.fillStyle = C.muted;
  ctx.font = `500 40px ${DISPLAY}`;
  ctx.fillText(d.style.line, pad, y);

  // Destination + time
  y += 110;
  ctx.fillStyle = C.accent;
  ctx.font = `700 30px ${DISPLAY}`;
  ctx.letterSpacing = '5px';
  ctx.fillText((d.label ?? '').toUpperCase(), pad, y);
  ctx.letterSpacing = '0px';
  y += 70;
  ctx.fillStyle = C.text;
  fitText(ctx, d.name.toUpperCase(), W - pad * 2, 72);
  ctx.fillText(d.name.toUpperCase(), pad, y);
  y += 150;
  ctx.fillStyle = C.accent;
  ctx.font = `800 150px ${DISPLAY}`;
  ctx.fillText(d.time, pad - 4, y);

  // Stats row
  y += 50;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, y);
  ctx.lineTo(W - pad, y);
  ctx.stroke();
  const colW = (W - pad * 2) / d.stats.length;
  d.stats.forEach(([label, value], i) => {
    const x = pad + i * colW;
    ctx.fillStyle = C.muted;
    ctx.font = `700 26px ${DISPLAY}`;
    ctx.fillText(label.toUpperCase(), x, y + 56);
    ctx.fillStyle = C.text;
    ctx.font = `800 64px ${DISPLAY}`;
    ctx.fillText(String(value), x, y + 126);
  });

  // Footer
  ctx.fillStyle = C.text;
  ctx.font = `800 44px ${DISPLAY}`;
  ctx.fillText('BLIND', pad, H - pad);
  const bw = ctx.measureText('BLIND ').width;
  ctx.fillStyle = C.accent;
  ctx.fillText('RALLY', pad + bw, H - pad);
  ctx.fillStyle = C.muted;
  ctx.font = `500 32px ${DISPLAY}`;
  ctx.textAlign = 'right';
  ctx.fillText(d.url, W - pad, H - pad);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Card failed'))), 'image/png'));
}
