const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- API ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !url.startsWith('/api/auth')) {
    showAuth();
    throw Object.assign(new Error('Sesión expirada'), { status: 401 });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || 'Error'), { status: res.status });
  return data;
}

// ---------- Estado ----------

const state = {
  notes: [],
  current: null,        // { id, title, body, pinned }
  strokes: [],
  undo: [],
  redo: [],
  tool: 'text',         // text | pen | eraser
  color: 'ink',
  size: 3.4,
  fingerDraws: false,
  query: '',
};
const dirty = new Set();
let saveTimer = null;
let saving = Promise.resolve();

const els = {
  auth: $('#auth'), app: $('#app'), authForm: $('#auth-form'), authError: $('#auth-error'),
  list: $('#note-list'), search: $('#search'), whoami: $('#whoami'),
  empty: $('#empty'), noteView: $('#note-view'), sheet: $('#sheet'), scroller: $('#scroller'),
  title: $('#title'), body: $('#body'), canvas: $('#canvas'), status: $('#status'),
  pin: $('#pin'), undo: $('#undo'), redo: $('#redo'), finger: $('#finger'),
};
const ctx = els.canvas.getContext('2d');

// ---------- Acceso ----------

let authMode = 'login';

function showAuth() {
  els.app.hidden = true;
  els.auth.hidden = false;
  state.current = null;
  dirty.clear();
}

$$('.segmented button').forEach((b) =>
  b.addEventListener('click', () => {
    authMode = b.dataset.mode;
    $$('.segmented button').forEach((x) => x.classList.toggle('on', x === b));
    $('.primary', els.authForm).textContent = authMode === 'login' ? 'Entrar' : 'Crear cuenta';
    els.authForm.password.autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
    els.authError.textContent = '';
  })
);

els.authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('.primary', els.authForm);
  btn.disabled = true;
  els.authError.textContent = '';
  try {
    const user = await api('POST', `/api/auth/${authMode}`, {
      username: els.authForm.username.value,
      password: els.authForm.password.value,
    });
    els.authForm.password.value = '';
    await startApp(user);
  } catch (err) {
    els.authError.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await flush().catch(() => {});
  await api('POST', '/api/auth/logout', {}).catch(() => {});
  showAuth();
});

async function startApp(user) {
  els.auth.hidden = true;
  els.app.hidden = false;
  els.whoami.textContent = `@${user.username}`;
  closeNote();
  await loadNotes();
}

// ---------- Lista ----------

const dateFmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });

function formatDate(iso) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? timeFmt.format(d) : dateFmt.format(d);
}

function svgIcon(name, cls) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function renderList() {
  els.list.replaceChildren();
  if (!state.notes.length) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = state.query ? 'Sin resultados' : 'Aún no tienes notas';
    els.list.append(li);
    return;
  }
  for (const n of state.notes) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'note-item' + (state.current?.id === n.id ? ' on' : '');
    btn.dataset.id = n.id;

    const row = document.createElement('div');
    row.className = 'row';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = n.title.trim() || 'Sin título';
    row.append(t);
    if (n.has_drawing) row.append(svgIcon('pen'));
    if (n.pinned) row.append(svgIcon('pin', 'pin-ic'));

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${formatDate(n.updated_at)}  ${n.preview.replace(/\s+/g, ' ').trim() || 'Sin texto adicional'}`;

    btn.append(row, meta);
    btn.addEventListener('click', () => openNote(n.id));
    li.append(btn);
    els.list.append(li);
  }
}

async function loadNotes() {
  const q = state.query;
  const notes = await api('GET', `/api/notes${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  if (q !== state.query) return;
  state.notes = notes;
  renderList();
}

let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = els.search.value.trim();
    loadNotes().catch(() => {});
  }, 250);
});

$('#new-note').addEventListener('click', async () => {
  await flush().catch(() => {});
  const note = await api('POST', '/api/notes', {});
  state.notes.unshift(note);
  await openNote(note.id, { focusTitle: true });
});

// ---------- Editor ----------

const ZERO_DRAWING_H = 1.3;

async function openNote(id, { focusTitle = false } = {}) {
  await flush().catch(() => {});
  const note = await api('GET', `/api/notes/${id}`);
  state.current = { id: note.id, title: note.title, body: note.body, pinned: note.pinned };
  state.strokes = Array.isArray(note.drawing?.strokes) ? note.drawing.strokes : [];
  state.undo = [];
  state.redo = [];
  dirty.clear();

  els.title.value = note.title;
  els.body.value = note.body;
  els.sheet.style.setProperty('--sheet-h', String(note.drawing?.h ?? ZERO_DRAWING_H));
  els.pin.setAttribute('aria-pressed', String(note.pinned));
  setStatus('');

  els.empty.hidden = true;
  els.noteView.hidden = false;
  els.app.dataset.view = 'note';
  els.scroller.scrollTop = 0;
  autoGrow();
  setTool(state.strokes.length && !note.body ? 'pen' : 'text');
  syncCanvasSize();
  updateHistoryButtons();
  renderList();
  if (focusTitle && state.tool === 'text') els.title.focus();
}

function closeNote() {
  state.current = null;
  els.noteView.hidden = true;
  els.empty.hidden = false;
  els.app.dataset.view = 'list';
  renderList();
}

$('#back').addEventListener('click', async () => {
  await flush().catch(() => {});
  closeNote();
});

function autoGrow() {
  els.body.style.height = 'auto';
  els.body.style.height = `${Math.max(els.body.scrollHeight, 0)}px`;
}

els.title.addEventListener('input', () => {
  state.current.title = els.title.value;
  patchListItem({ title: els.title.value });
  markDirty('title');
});
els.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); els.body.focus(); }
});
els.body.addEventListener('input', () => {
  state.current.body = els.body.value;
  patchListItem({ preview: els.body.value.slice(0, 140) });
  autoGrow();
  markDirty('body');
});

function patchListItem(patch) {
  const n = state.notes.find((x) => x.id === state.current?.id);
  if (!n) return;
  Object.assign(n, patch);
  const item = $(`.note-item[data-id="${n.id}"]`);
  if (!item) return;
  if ('title' in patch) $('.t', item).textContent = n.title.trim() || 'Sin título';
  if ('preview' in patch) $('.meta', item).textContent = `${formatDate(n.updated_at)}  ${n.preview.replace(/\s+/g, ' ').trim() || 'Sin texto adicional'}`;
}

els.pin.addEventListener('click', () => {
  state.current.pinned = !state.current.pinned;
  els.pin.setAttribute('aria-pressed', String(state.current.pinned));
  markDirty('pinned');
});

$('#delete').addEventListener('click', async () => {
  if (!state.current || !confirm('¿Eliminar esta nota?')) return;
  const id = state.current.id;
  clearTimeout(saveTimer);
  dirty.clear();
  await api('DELETE', `/api/notes/${id}`).catch(() => {});
  state.notes = state.notes.filter((n) => n.id !== id);
  closeNote();
});

// ---------- Guardado ----------

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('err', isError);
}

function markDirty(field) {
  dirty.add(field);
  setStatus('Guardando…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush().catch(() => {}), 700);
}

function drawingPayload() {
  if (!state.strokes.length) return null;
  const h = els.sheet.offsetHeight / els.sheet.offsetWidth;
  return { v: 1, h: Math.round(h * 1000) / 1000, strokes: state.strokes };
}

function flush() {
  clearTimeout(saveTimer);
  // Serializa los guardados para que no se pisen entre sí.
  const run = saving.then(async () => {
    if (!state.current || !dirty.size) return;
    const id = state.current.id;
    const fields = [...dirty];
    dirty.clear();
    const patch = {};
    for (const f of fields) {
      patch[f] = f === 'drawing' ? drawingPayload() : state.current[f];
    }
    try {
      const saved = await api('PUT', `/api/notes/${id}`, patch);
      const i = state.notes.findIndex((n) => n.id === id);
      if (i >= 0) state.notes[i] = saved;
      if (state.current?.id === id) {
        setStatus('Guardado');
        if (!dirty.size) reorderList();
      }
    } catch (err) {
      if (err.status === 401) return;
      fields.forEach((f) => dirty.add(f));
      setStatus('Sin conexión · reintentando', true);
      saveTimer = setTimeout(() => flush().catch(() => {}), 4000);
      throw err;
    }
  });
  saving = run.catch(() => {}); // un fallo no debe bloquear los guardados siguientes
  return run;
}

function reorderList() {
  if (state.query) return renderList();
  state.notes.sort((a, b) => b.pinned - a.pinned || new Date(b.updated_at) - new Date(a.updated_at));
  renderList();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush().catch(() => {});
});
addEventListener('pagehide', () => flush().catch(() => {}));

// ---------- Herramientas ----------

function setTool(tool) {
  state.tool = tool;
  const drawing = tool !== 'text';
  els.noteView.classList.toggle('is-drawing', drawing);
  els.sheet.classList.toggle('drawing', drawing);
  els.sheet.classList.toggle('pen', tool === 'pen');
  els.sheet.classList.toggle('eraser', tool === 'eraser');
  $$('.tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  if (drawing) {
    document.activeElement?.blur?.();
    getSelection()?.removeAllRanges();
  }
}

function applyFingerMode() {
  // Con el dedo desactivado, el dedo hace scroll y solo el Pencil dibuja.
  els.canvas.style.touchAction = state.fingerDraws ? 'none' : 'pan-y';
  els.finger.setAttribute('aria-pressed', String(state.fingerDraws));
}

$$('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

$$('.swatch').forEach((b) => {
  if (b.dataset.color !== 'ink') b.style.setProperty('--c', b.dataset.color);
  b.addEventListener('click', () => {
    state.color = b.dataset.color;
    if (state.tool !== 'pen') setTool('pen');
    syncToolbar();
  });
});
$$('.size').forEach((b) =>
  b.addEventListener('click', () => {
    state.size = Number(b.dataset.size);
    if (state.tool !== 'pen') setTool('pen');
    syncToolbar();
  })
);
function syncToolbar() {
  $$('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.color === state.color));
  $$('.size').forEach((b) => b.classList.toggle('on', Number(b.dataset.size) === state.size));
}
syncToolbar();

els.finger.addEventListener('click', () => {
  state.fingerDraws = !state.fingerDraws;
  try { localStorage.setItem('fingerDraws', state.fingerDraws ? '1' : '0'); } catch {}
  applyFingerMode();
});
try { state.fingerDraws = localStorage.getItem('fingerDraws') === '1'; } catch {}
applyFingerMode();

$('#more-page').addEventListener('click', extendSheet);

function extendSheet() {
  const h = els.sheet.offsetHeight / els.sheet.offsetWidth;
  els.sheet.style.setProperty('--sheet-h', String(Math.round((h + 0.5) * 100) / 100));
  markDirty('drawing');
}

// ---------- Dibujo ----------

const REF_WIDTH = 800; // el grosor se guarda como px sobre una hoja de 800 px de ancho
const resolveColor = (c) => (c === 'ink' ? getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#000' : c);

function syncCanvasSize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = els.sheet.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (els.canvas.width !== w || els.canvas.height !== h) {
    els.canvas.width = w;
    els.canvas.height = h;
  }
  redraw();
}
new ResizeObserver(syncCanvasSize).observe(els.sheet);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);

function strokeWidth(stroke, pressure) {
  return (stroke.w / REF_WIDTH) * (0.45 + pressure * 1.1);
}

function drawSegment(stroke, a, b) {
  ctx.strokeStyle = resolveColor(stroke.c);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = strokeWidth(stroke, (a[2] + b[2]) / 2);
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}

function drawStroke(stroke) {
  const p = stroke.p;
  if (p.length === 1) {
    ctx.fillStyle = resolveColor(stroke.c);
    ctx.beginPath();
    ctx.arc(p[0][0], p[0][1], strokeWidth(stroke, p[0][2]) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  for (let i = 1; i < p.length; i++) drawSegment(stroke, p[i - 1], p[i]);
}

let live = null;

function redraw() {
  // Coordenadas normalizadas: x en [0,1] del ancho, y en unidades de ancho.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.setTransform(els.canvas.width, 0, 0, els.canvas.width, 0, 0);
  for (const s of state.strokes) drawStroke(s);
  if (live) drawStroke(live);
}

const round4 = (n) => Math.round(n * 10000) / 10000;

function toPoint(e, rect) {
  const pressure = e.pressure > 0 ? e.pressure : 0.5;
  return [round4((e.clientX - rect.left) / rect.width), round4((e.clientY - rect.top) / rect.width), Math.round(pressure * 100) / 100];
}

function pushUndo() {
  state.undo.push(state.strokes);
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  updateHistoryButtons();
}

function updateHistoryButtons() {
  els.undo.disabled = !state.undo.length;
  els.redo.disabled = !state.redo.length;
}

function commitDrawing() {
  markDirty('drawing');
  updateHistoryButtons();
}

els.undo.addEventListener('click', () => {
  if (!state.undo.length) return;
  state.redo.push(state.strokes);
  state.strokes = state.undo.pop();
  redraw();
  commitDrawing();
});
els.redo.addEventListener('click', () => {
  if (!state.redo.length) return;
  state.undo.push(state.strokes);
  state.strokes = state.redo.pop();
  redraw();
  commitDrawing();
});

function distToSegment(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2)) : 0;
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function strokeHit(stroke, x, y, r) {
  const p = stroke.p;
  if (p.length === 1) return Math.hypot(p[0][0] - x, p[0][1] - y) <= r;
  for (let i = 1; i < p.length; i++) if (distToSegment(x, y, p[i - 1], p[i]) <= r) return true;
  return false;
}

let active = null; // { id, mode, undoPushed }

els.canvas.addEventListener('pointerdown', (e) => {
  if (state.tool === 'text' || active) return;
  if (e.pointerType === 'touch' && !state.fingerDraws) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  els.canvas.setPointerCapture(e.pointerId);

  // El botón borrador del lápiz (si el hardware lo reporta) borra aunque esté la herramienta lápiz.
  const mode = state.tool === 'eraser' || (e.buttons & 32) ? 'eraser' : 'pen';
  active = { id: e.pointerId, mode, undoPushed: false };
  const rect = els.canvas.getBoundingClientRect();

  if (mode === 'pen') {
    live = { c: state.color, w: state.size, p: [toPoint(e, rect)] };
    redraw();
  } else {
    eraseAt(e, rect);
  }
});

els.canvas.addEventListener('pointermove', (e) => {
  if (!active || e.pointerId !== active.id) return;
  const rect = els.canvas.getBoundingClientRect();
  const events = e.getCoalescedEvents?.();
  const batch = events?.length ? events : [e];

  if (active.mode === 'pen') {
    for (const ev of batch) {
      const pt = toPoint(ev, rect);
      const prev = live.p[live.p.length - 1];
      if (pt[0] === prev[0] && pt[1] === prev[1]) continue;
      live.p.push(pt);
      ctx.setTransform(els.canvas.width, 0, 0, els.canvas.width, 0, 0);
      drawSegment(live, prev, pt);
    }
    const last = live.p[live.p.length - 1];
    if (last[1] * rect.width > rect.height - 160) extendSheet();
  } else {
    for (const ev of batch) eraseAt(ev, rect);
  }
});

function eraseAt(e, rect) {
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.width;
  const r = 14 / rect.width;
  const kept = state.strokes.filter((s) => !strokeHit(s, x, y, r));
  if (kept.length === state.strokes.length) return;
  if (!active.undoPushed) {
    pushUndo();
    active.undoPushed = true;
  }
  state.strokes = kept;
  redraw();
}

function endStroke(e) {
  if (!active || e.pointerId !== active.id) return;
  if (active.mode === 'pen' && live) {
    pushUndo();
    state.strokes = [...state.strokes, live];
    live = null;
    redraw();
    commitDrawing();
  } else if (active.mode === 'eraser' && active.undoPushed) {
    commitDrawing();
  }
  active = null;
}
els.canvas.addEventListener('pointerup', endStroke);
els.canvas.addEventListener('pointercancel', endStroke);
els.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- Arranque ----------

(async function init() {
  try {
    const user = await api('GET', '/api/me');
    await startApp(user);
  } catch {
    showAuth();
  }
})();
