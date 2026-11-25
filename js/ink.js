// Escrita à mão (Apple Pencil): traços vetoriais com pressão.
// Quando a caneta é detectada, o toque do dedo/palma não desenha.

export function createInk(box, initial = []) {
  const canvas = document.createElement('canvas');
  box.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const strokes = initial.map((s) => ({ ...s, p: s.p.slice() }));
  const undone = [];
  let current = null;
  let penSeen = false;
  let opts = { color: '#2C1B1F', size: 3, eraser: false };
  let dpr = 1, W = 0, H = 0;

  function resize() {
    const r = box.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    redraw();
  }

  function drawStroke(c, s, scale = 1) {
    const p = s.p;
    if (s.e) { c.globalCompositeOperation = 'destination-out'; } else { c.globalCompositeOperation = 'source-over'; }
    c.strokeStyle = s.c; c.fillStyle = s.c; c.lineCap = 'round'; c.lineJoin = 'round';
    if (p.length < 6) {
      c.beginPath(); c.arc(p[0] * scale, p[1] * scale, (s.w * (p[2] || .5) + .5) * scale, 0, Math.PI * 2); c.fill();
      return;
    }
    for (let i = 3; i < p.length; i += 3) {
      const pr = (p[i - 1] + p[i + 2]) / 2 || .5;
      c.lineWidth = Math.max(.6, s.w * (s.e ? 1 : (0.35 + pr * 1.1))) * scale;
      c.beginPath();
      if (i >= 6) {
        const mx0 = (p[i - 6] + p[i - 3]) / 2, my0 = (p[i - 5] + p[i - 2]) / 2;
        const mx1 = (p[i - 3] + p[i]) / 2, my1 = (p[i - 2] + p[i + 1]) / 2;
        c.moveTo(mx0 * scale, my0 * scale);
        c.quadraticCurveTo(p[i - 3] * scale, p[i - 2] * scale, mx1 * scale, my1 * scale);
      } else {
        c.moveTo(p[i - 3] * scale, p[i - 2] * scale);
        c.lineTo(p[i] * scale, p[i + 1] * scale);
      }
      c.stroke();
    }
    c.globalCompositeOperation = 'source-over';
  }

  function redraw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    for (const s of strokes) drawStroke(ctx, s);
    if (current) drawStroke(ctx, current);
  }

  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [Math.round((e.clientX - r.left) * 10) / 10, Math.round((e.clientY - r.top) * 10) / 10]; };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') penSeen = true;
    if (penSeen && e.pointerType === 'touch') return; // rejeição de palma
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = pos(e);
    const pr = e.pointerType === 'pen' ? (e.pressure || .5) : .5;
    current = { c: opts.color, w: opts.eraser ? opts.size * 5 : opts.size, e: opts.eraser ? 1 : 0, p: [x, y, +pr.toFixed(2)] };
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    if (penSeen && e.pointerType === 'touch') return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) {
      const [x, y] = pos(ev);
      const pr = ev.pointerType === 'pen' ? (ev.pressure || .5) : .5;
      const n = current.p.length;
      if (Math.hypot(x - current.p[n - 3], y - current.p[n - 2]) < 1.2) continue;
      current.p.push(x, y, +pr.toFixed(2));
    }
    redraw();
  });
  const end = () => {
    if (!current) return;
    strokes.push(current); current = null; undone.length = 0;
    redraw();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  const ro = new ResizeObserver(resize);
  ro.observe(box);
  resize();

  return {
    set(o) { opts = { ...opts, ...o }; },
    undo() { if (strokes.length) { undone.push(strokes.pop()); redraw(); } },
    redo() { if (undone.length) { strokes.push(undone.pop()); redraw(); } },
    clear() { strokes.length = 0; redraw(); },
    strokes: () => strokes,
    isEmpty: () => strokes.filter((s) => !s.e).length === 0,
    destroy() { ro.disconnect(); },
    /** Miniatura recortada no conteúdo, para os cartões */
    thumbnail(maxW = 640) {
      const pts = strokes.filter((s) => !s.e);
      if (!pts.length) return '';
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of pts) for (let i = 0; i < s.p.length; i += 3) {
        minX = Math.min(minX, s.p[i]); maxX = Math.max(maxX, s.p[i]);
        minY = Math.min(minY, s.p[i + 1]); maxY = Math.max(maxY, s.p[i + 1]);
      }
      const m = 16; minX -= m; minY -= m; maxX += m; maxY += m;
      const w = maxX - minX, h = maxY - minY;
      const scale = Math.min(2, maxW / w);
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      const x = c.getContext('2d');
      x.fillStyle = '#FFFDF8'; x.fillRect(0, 0, c.width, c.height);
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      const o = off.getContext('2d');
      o.translate(-minX * scale, -minY * scale);
      for (const s of strokes) drawStroke(o, s, scale);
      x.drawImage(off, 0, 0);
      return c.toDataURL('image/jpeg', 0.82);
    },
  };
}
