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

// ---------- Catálogos ----------

// w: grosor base (px sobre hoja de 800 px). lo/hi: factor de grosor según presión. alpha: opacidad del trazo completo.
const PENS = {
  ballpoint: { name: 'Bolígrafo', w: 2.2, lo: 0.7, hi: 1.2, alpha: 1 },
  fountain: { name: 'Pluma', w: 3.4, lo: 0.25, hi: 2, alpha: 1 },
  pencil: { name: 'Lápiz', w: 2.8, lo: 0.55, hi: 1.5, alpha: 0.85, grain: true },
  marker: { name: 'Marcador', w: 9, lo: 1, hi: 1, alpha: 1 },
  highlighter: { name: 'Resaltador', w: 20, lo: 1, hi: 1, alpha: 0.35, flat: true },
  brush: { name: 'Pincel', w: 7, lo: 0.15, hi: 2.3, alpha: 1 },
};

const PEN_PREVIEW = {
  ballpoint: '<path d="M6 17C30 1 62 27 94 9" stroke-width="2"/>',
  fountain: '<path d="M6 17C30 1 62 27 94 9C62 31 30 5 6 17Z" fill="currentColor" stroke-width="0.6"/>',
  pencil: '<path d="M6 17C30 1 62 27 94 9" stroke-width="2.6" stroke-dasharray="2.4 0.7" opacity="0.8"/>',
  marker: '<path d="M6 17C30 1 62 27 94 9" stroke-width="7"/>',
  highlighter: '<path d="M6 17C30 1 62 27 94 9" stroke-width="13" stroke="#ffd60a" opacity="0.55" stroke-linecap="butt"/>',
  brush: '<path d="M6 17C30 1 62 27 94 9C62 36 30 9 6 17Z" fill="currentColor" stroke-width="0.6"/>',
};

const SHAPES = {
  line: '<path d="M5 19L19 5"/>',
  arrow: '<path d="M5 19L19 5M10 5h9v9"/>',
  rect: '<rect x="4" y="5.5" width="16" height="13" rx="1.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  triangle: '<path d="M12 4l9 16H3z"/>',
  diamond: '<path d="M12 3l9 9-9 9-9-9z"/>',
  star: '<path d="M12 3l2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17.2 6.4 20.3l1.2-6.3L3 9.6l6.3-.8z"/>',
};
const SHAPE_NAMES = { line: 'Línea', arrow: 'Flecha', rect: 'Rectángulo', ellipse: 'Elipse', triangle: 'Triángulo', diamond: 'Rombo', star: 'Estrella' };

const PALETTE = ['ink', '#8e8e93', '#a2845e', '#ff453a', '#ff9f0a', '#ffd60a', '#a8e03c', '#30d158',
  '#40c8e0', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ffadc7', '#ffffff', '#000000'];

const EMOJIS = ['⭐', '❤️', '🔥', '✅', '❗', '❓', '💡', '📌', '📎', '🎯', '🏆', '🎉', '😀', '😍', '🤔', '😎',
  '👍', '👏', '🙏', '💪', '📚', '✏️', '📝', '📅', '⏰', '💰', '🌈', '☀️', '🌙', '⚡', '🌸', '🐱',
  '🐶', '🚀', '💻', '🎵', '🔔', '⚠️', '❌', '➡️', '🍎', '☕', '🎁', '✨', '💬', '🔒', '📷', '🧠'];
const LABELS = [['IDEA', '#ff9f0a'], ['HECHO', '#30d158'], ['URGENTE', '#ff453a'], ['TO-DO', '#0a84ff']];

const HANDLE_ROOM = 0.025; // margen derecho para el asa de escala (fracción del ancho)
const REF_WIDTH = 800; // los grosores se guardan como px sobre una hoja de 800 px de ancho
const DEFAULT_SHEET_H = { note: 1.3, canvas: 1.7 };

// ---------- Estado ----------

const state = {
  notes: [],
  current: null,        // { id, title, body, pinned, kind, paper }
  items: [],            // trazos, formas y stickers
  undo: [],
  redo: [],
  sel: null,            // índice del objeto seleccionado
  tool: 'text',         // text | pen | eraser | shape | sticker | select
  pen: 'ballpoint',
  color: 'ink',
  mult: 1,
  shape: 'rect',
  shapeFill: false,
  sticker: '⭐',
  fingerDraws: false,
  query: '',
};
const dirty = new Set();
let saveTimer = null;
let saving = Promise.resolve();

try {
  Object.assign(state, JSON.parse(localStorage.getItem('prefs') || '{}'));
  state.fingerDraws = localStorage.getItem('fingerDraws') === '1';
} catch {}
if (!PENS[state.pen]) state.pen = 'ballpoint';
if (!SHAPES[state.shape]) state.shape = 'rect';
state.tool = 'text';
state.sel = null;

function savePrefs() {
  const { pen, color, mult, shape, shapeFill, sticker } = state;
  try { localStorage.setItem('prefs', JSON.stringify({ pen, color, mult, shape, shapeFill, sticker })); } catch {}
}

const els = {
  auth: $('#auth'), app: $('#app'), authForm: $('#auth-form'), authError: $('#auth-error'),
  list: $('#note-list'), search: $('#search'), whoami: $('#whoami'),
  empty: $('#empty'), noteView: $('#note-view'), sheet: $('#sheet'), scroller: $('#scroller'),
  title: $('#title'), ctitle: $('#ctitle'), body: $('#body'), canvas: $('#canvas'), live: $('#live'), status: $('#status'),
  pin: $('#pin'), undo: $('#undo'), redo: $('#redo'), finger: $('#finger'),
  pop: $('#pop'), selUi: $('#sel-ui'), paperPicker: $('#paper-picker'), colorBtn: $('#color-btn'),
  newMenu: $('#new-menu'), newBtn: $('#new-note'),
};
const ctx = els.canvas.getContext('2d');
const lctx = els.live.getContext('2d');
const layer = document.createElement('canvas'); // capa temporal para trazos translúcidos
const layerCtx = layer.getContext('2d');

const isCanvasKind = () => state.current?.kind === 'canvas';

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

const noteTitle = (n) => n.title.trim() || (n.kind === 'canvas' ? 'Lienzo sin título' : 'Sin título');
const noteMeta = (n) =>
  `${formatDate(n.updated_at)}  ${n.preview.replace(/\s+/g, ' ').trim() || (n.kind === 'canvas' ? 'Lienzo' : 'Sin texto adicional')}`;

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
    t.textContent = noteTitle(n);
    row.append(t);
    if (n.kind === 'canvas') row.append(svgIcon('canvas'));
    else if (n.has_drawing) row.append(svgIcon('pen'));
    if (n.pinned) row.append(svgIcon('pin', 'pin-ic'));

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = noteMeta(n);

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

// Menú "nuevo": nota o lienzo
function toggleNewMenu(open = els.newMenu.hidden) {
  els.newMenu.hidden = !open;
  els.newBtn.setAttribute('aria-expanded', String(open));
}
els.newBtn.addEventListener('click', () => toggleNewMenu());
$$('button', els.newMenu).forEach((b) =>
  b.addEventListener('click', async () => {
    toggleNewMenu(false);
    await flush().catch(() => {});
    const note = await api('POST', '/api/notes', { kind: b.dataset.kind });
    if (note.kind === undefined && b.dataset.kind === 'canvas') {
      alert('El servidor está desactualizado y no soporta lienzos. Deténlo y vuelve a iniciarlo con npm start.');
    }
    state.notes.unshift(note);
    await openNote(note.id, { focusTitle: true });
    if (b.dataset.kind === 'canvas') openPop('pen'); // muestra lápices y colores al crear un lienzo
  })
);
document.addEventListener('pointerdown', (e) => {
  if (!els.newMenu.hidden && !e.target.closest('#new-menu, #new-note')) toggleNewMenu(false);
  if (!els.pop.hidden && !e.target.closest('#pop, .toolbar')) closePop();
});

// ---------- Editor ----------

async function openNote(id, { focusTitle = false } = {}) {
  await flush().catch(() => {});
  const note = await api('GET', `/api/notes/${id}`);
  const staleServer = note.kind === undefined;
  note.kind ??= 'note';
  note.paper ??= 'blank';
  state.current = { id: note.id, title: note.title, body: note.body, pinned: note.pinned, kind: note.kind, paper: note.paper };
  state.items = Array.isArray(note.drawing?.strokes) ? note.drawing.strokes : [];
  state.undo = [];
  state.redo = [];
  state.sel = null;
  liveItem = null;
  dirty.clear();
  closePop();

  const canvasKind = note.kind === 'canvas';
  els.noteView.dataset.kind = note.kind;
  els.title.value = els.ctitle.value = note.title;
  els.body.value = note.body;
  els.ctitle.hidden = !canvasKind;
  els.paperPicker.hidden = !canvasKind;
  els.sheet.dataset.paper = canvasKind ? note.paper : 'blank';
  syncPaperPicker();
  els.sheet.style.setProperty('--sheet-h', String(note.drawing?.h ?? DEFAULT_SHEET_H[note.kind]));
  els.pin.setAttribute('aria-pressed', String(note.pinned));
  if (staleServer) setStatus('Servidor desactualizado: reinícialo con npm start', true);
  else setStatus('');

  els.empty.hidden = true;
  els.noteView.hidden = false;
  els.app.dataset.view = 'note';
  els.scroller.scrollTop = 0;
  autoGrow();
  if (canvasKind) setTool(state.tool === 'text' ? 'pen' : state.tool);
  else setTool(state.items.length && !note.body ? 'pen' : 'text');
  syncCanvasSize();
  updateHistoryButtons();
  renderList();
  if (focusTitle && !canvasKind && state.tool === 'text') els.title.focus();
}

function closeNote() {
  state.current = null;
  els.noteView.hidden = true;
  els.empty.hidden = false;
  els.app.dataset.view = 'list';
  closePop();
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

function onTitleInput(value, source) {
  state.current.title = value;
  (source === els.title ? els.ctitle : els.title).value = value;
  patchListItem({ title: value });
  markDirty('title');
}
els.title.addEventListener('input', () => onTitleInput(els.title.value, els.title));
els.ctitle.addEventListener('input', () => onTitleInput(els.ctitle.value, els.ctitle));
els.ctitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.ctitle.blur(); });
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
  if ('title' in patch) $('.t', item).textContent = noteTitle(n);
  if ('preview' in patch) $('.meta', item).textContent = noteMeta(n);
}

els.pin.addEventListener('click', () => {
  state.current.pinned = !state.current.pinned;
  els.pin.setAttribute('aria-pressed', String(state.current.pinned));
  markDirty('pinned');
});

$('#delete').addEventListener('click', async () => {
  if (!state.current || !confirm(`¿Eliminar ${isCanvasKind() ? 'este lienzo' : 'esta nota'}?`)) return;
  const id = state.current.id;
  clearTimeout(saveTimer);
  dirty.clear();
  await api('DELETE', `/api/notes/${id}`).catch(() => {});
  state.notes = state.notes.filter((n) => n.id !== id);
  closeNote();
});

// Papel del lienzo
function syncPaperPicker() {
  $$('button', els.paperPicker).forEach((b) => b.classList.toggle('on', b.dataset.paper === state.current?.paper));
}
$$('button', els.paperPicker).forEach((b) =>
  b.addEventListener('click', () => {
    state.current.paper = b.dataset.paper;
    els.sheet.dataset.paper = b.dataset.paper;
    syncPaperPicker();
    markDirty('paper');
  })
);

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
  if (!state.items.length) return null;
  const h = els.sheet.offsetHeight / els.sheet.offsetWidth;
  return { v: 2, h: Math.round(h * 1000) / 1000, strokes: state.items };
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

// ---------- Herramientas y paneles ----------

const DRAW_CLASSES = ['pen', 'eraser', 'shape', 'sticker', 'select'];

function setTool(tool) {
  state.tool = tool;
  const drawing = tool !== 'text';
  els.noteView.classList.toggle('is-drawing', drawing);
  els.sheet.classList.toggle('drawing', drawing);
  DRAW_CLASSES.forEach((c) => els.sheet.classList.toggle(c, c === tool));
  $$('.tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  if (drawing) {
    document.activeElement?.blur?.();
    getSelection()?.removeAllRanges();
  }
  if (tool !== 'select') state.sel = null;
  if (!['pen', 'shape', 'sticker'].includes(tool) && els.pop.dataset.open !== 'color') closePop();
  renderLive();
}

function openPop(name) {
  els.pop.dataset.open = name;
  els.pop.hidden = false;
}
function closePop() {
  els.pop.hidden = true;
  els.pop.dataset.open = '';
}
function togglePop(name) {
  if (!els.pop.hidden && els.pop.dataset.open === name) closePop();
  else openPop(name);
}

$$('.tool[data-tool]').forEach((b) =>
  b.addEventListener('click', () => {
    const tool = b.dataset.tool;
    const again = state.tool === tool;
    setTool(tool);
    if (tool === 'pen' || tool === 'shape' || tool === 'sticker') { if (again) togglePop(tool); else openPop(tool); }
  })
);
els.colorBtn.addEventListener('click', () => togglePop('color'));

function syncColorButton() {
  if (state.color === 'ink') els.colorBtn.style.removeProperty('--c');
  else els.colorBtn.style.setProperty('--c', state.color);
  $$('.sw', els.pop).forEach((b) => b.classList.toggle('on', b.dataset.color === state.color));
}

function setColor(c) {
  state.color = c;
  if (['text', 'eraser'].includes(state.tool)) setTool('pen');
  if (state.tool === 'select' && state.sel != null) {
    const it = state.items[state.sel];
    if (it && it.t !== 'sticker') {
      pushUndo();
      state.items = state.items.map((x, i) => (i === state.sel ? { ...x, c } : x));
      redraw();
      commitDrawing();
    }
  }
  syncColorButton();
  savePrefs();
}

function buildPanels() {
  // Lápices
  const penList = $('#pen-list');
  for (const [key, pen] of Object.entries(PENS)) {
    const b = document.createElement('button');
    b.className = 'pen-row';
    b.dataset.pen = key;
    b.innerHTML = `<svg viewBox="0 0 100 26" aria-hidden="true">${PEN_PREVIEW[key]}</svg>`;
    const name = document.createElement('span');
    name.textContent = pen.name;
    b.append(name);
    b.addEventListener('click', () => {
      state.pen = key;
      if (key === 'highlighter' && state.color === 'ink') state.color = '#ffd60a';
      if (state.tool !== 'pen') setTool('pen');
      syncPanels();
      savePrefs();
    });
    penList.append(b);
  }

  // Colores
  const palette = $('#palette');
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.className = 'sw';
    b.dataset.color = c;
    b.setAttribute('aria-label', c === 'ink' ? 'Tinta' : c);
    if (c !== 'ink') b.style.setProperty('--c', c);
    b.addEventListener('click', () => setColor(c));
    palette.append(b);
  }
  $('#custom-color').addEventListener('input', (e) => setColor(e.target.value));

  // Formas
  const shapeList = $('#shape-list');
  for (const key of Object.keys(SHAPES)) {
    const b = document.createElement('button');
    b.className = 'shape-btn';
    b.dataset.shape = key;
    b.title = b.ariaLabel = SHAPE_NAMES[key];
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${SHAPES[key]}</svg>`;
    b.addEventListener('click', () => {
      state.shape = key;
      syncPanels();
      savePrefs();
    });
    shapeList.append(b);
  }
  $('#shape-fill').addEventListener('change', (e) => {
    state.shapeFill = e.target.checked;
    savePrefs();
  });

  // Stickers
  const stickerList = $('#sticker-list');
  const addSticker = (value, el) => {
    el.dataset.sticker = value;
    el.addEventListener('click', () => {
      state.sticker = value;
      syncPanels();
      savePrefs();
      closePop();
    });
    stickerList.append(el);
  };
  for (const e of EMOJIS) {
    const b = document.createElement('button');
    b.className = 'sticker-btn';
    b.textContent = e;
    addSticker(e, b);
  }
  for (const [text, color] of LABELS) {
    const b = document.createElement('button');
    b.className = 'sticker-btn lbl';
    b.style.setProperty('--c', color);
    b.textContent = text;
    addSticker(`lbl:${text}:${color}`, b);
  }

  // Grosor (el mismo valor en lápiz y formas)
  for (const id of ['#size', '#size2']) {
    $(id).addEventListener('input', (e) => {
      state.mult = Number(e.target.value);
      syncPanels();
      savePrefs();
    });
  }
}

function syncPanels() {
  $$('.pen-row').forEach((b) => b.classList.toggle('on', b.dataset.pen === state.pen));
  $$('.shape-btn').forEach((b) => b.classList.toggle('on', b.dataset.shape === state.shape));
  $$('.sticker-btn').forEach((b) => b.classList.toggle('on', b.dataset.sticker === state.sticker));
  $('#shape-fill').checked = state.shapeFill;
  $('#size').value = $('#size2').value = String(state.mult);
  syncColorButton();
}
buildPanels();
syncPanels();

els.finger.addEventListener('click', () => {
  state.fingerDraws = !state.fingerDraws;
  try { localStorage.setItem('fingerDraws', state.fingerDraws ? '1' : '0'); } catch {}
  els.finger.setAttribute('aria-pressed', String(state.fingerDraws));
});
els.finger.setAttribute('aria-pressed', String(state.fingerDraws));

$('#more-page').addEventListener('click', extendSheet);

function extendSheet() {
  const h = els.sheet.offsetHeight / els.sheet.offsetWidth;
  els.sheet.style.setProperty('--sheet-h', String(Math.round((h + 0.5) * 100) / 100));
  markDirty('drawing');
}

// ---------- Geometría de objetos ----------

const round4 = (n) => Math.round(n * 10000) / 10000;
const penOf = (it) => PENS[it.k] ?? PENS.ballpoint;
const strokeW = (it, pressure) => {
  const pen = penOf(it);
  return (it.w / REF_WIDTH) * (pen.lo + (pen.hi - pen.lo) * pressure);
};

function stickerSize(it) {
  if (!it.e.startsWith('lbl:')) return { w: it.s, h: it.s };
  const text = it.e.split(':')[1];
  const h = it.s * 0.5;
  return { w: text.length * h * 0.41 + h, h };
}

function shapePolys(s) {
  const x0 = Math.min(s.x1, s.x2), x1 = Math.max(s.x1, s.x2);
  const y0 = Math.min(s.y1, s.y2), y1 = Math.max(s.y1, s.y2);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  switch (s.s) {
    case 'line':
      return [{ pts: [[s.x1, s.y1], [s.x2, s.y2]] }];
    case 'arrow': {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const len = Math.hypot(dx, dy) || 1;
      const hl = Math.min(0.05, len * 0.4);
      const ang = Math.atan2(dy, dx);
      const head = [-1, 1].map((sign) => [s.x2 - hl * Math.cos(ang + sign * 0.5), s.y2 - hl * Math.sin(ang + sign * 0.5)]);
      return [{ pts: [[s.x1, s.y1], [s.x2, s.y2]] }, { pts: [head[0], [s.x2, s.y2], head[1]] }];
    }
    case 'rect':
      return [{ closed: true, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] }];
    case 'ellipse': {
      const pts = [];
      for (let i = 0; i < 64; i++) pts.push([cx + rx * Math.cos((i / 64) * Math.PI * 2), cy + ry * Math.sin((i / 64) * Math.PI * 2)]);
      return [{ closed: true, pts }];
    }
    case 'triangle':
      return [{ closed: true, pts: [[cx, y0], [x1, y1], [x0, y1]] }];
    case 'diamond':
      return [{ closed: true, pts: [[cx, y0], [x1, cy], [cx, y1], [x0, cy]] }];
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.42 : 1;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push([cx + rx * r * Math.cos(a), cy + ry * r * Math.sin(a)]);
      }
      return [{ closed: true, pts }];
    }
    default:
      return [];
  }
}

function bounds(it) {
  if (it.t === 'sticker') {
    const { w, h } = stickerSize(it);
    return { x0: it.x - w / 2, y0: it.y - h / 2, x1: it.x + w / 2, y1: it.y + h / 2 };
  }
  if (it.t === 'shape') {
    const pad = it.w / REF_WIDTH / 2 + 0.004;
    return {
      x0: Math.min(it.x1, it.x2) - pad, y0: Math.min(it.y1, it.y2) - pad,
      x1: Math.max(it.x1, it.x2) + pad, y1: Math.max(it.y1, it.y2) + pad,
    };
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of it.p) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const pad = strokeW(it, 1) / 2 + 0.002;
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

const inBounds = (b, x, y, tol = 0) => x >= b.x0 - tol && x <= b.x1 + tol && y >= b.y0 - tol && y <= b.y1 + tol;

function distToSegment(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2)) : 0;
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function nearPolyline(pts, closed, x, y, r) {
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= r;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) if (distToSegment(x, y, pts[i], pts[(i + 1) % pts.length]) <= r) return true;
  return false;
}

// interior: también cuenta el interior de formas rellenas y stickers (para seleccionar)
function hitItem(it, x, y, r, interior) {
  if (it.t === 'sticker') return inBounds(bounds(it), x, y, r / 2);
  if (it.t === 'shape') {
    const rr = r + it.w / REF_WIDTH / 2;
    if (shapePolys(it).some((p) => nearPolyline(p.pts, p.closed, x, y, rr))) return true;
    return interior && it.f && inBounds(bounds(it), x, y);
  }
  return nearPolyline(it.p, false, x, y, r + strokeW(it, 1) / 2);
}

function mapItem(it, fx, fy, k) {
  if (it.t === 'sticker') return { ...it, x: round4(fx(it.x)), y: round4(fy(it.y)), s: it.s * k };
  if (it.t === 'shape') return { ...it, x1: round4(fx(it.x1)), y1: round4(fy(it.y1)), x2: round4(fx(it.x2)), y2: round4(fy(it.y2)) };
  return { ...it, p: it.p.map(([x, y, pr]) => [round4(fx(x)), round4(fy(y)), pr]), w: it.w * k };
}

// ---------- Render ----------

const resolveColor = (c) => (c === 'ink' ? getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#000' : c);
const setNormalized = (c) => c.setTransform(c.canvas.width, 0, 0, c.canvas.width, 0, 0);

function syncCanvasSize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = els.sheet.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (els.canvas.width !== w || els.canvas.height !== h) {
    for (const c of [els.canvas, els.live, layer]) {
      c.width = w;
      c.height = h;
    }
  }
  redraw();
  renderLive();
}
new ResizeObserver(syncCanvasSize).observe(els.sheet);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { redraw(); renderLive(); });

function strokeSegment(c, it, a, b) {
  c.lineWidth = strokeW(it, (a[2] + b[2]) / 2);
  c.beginPath();
  c.moveTo(a[0], a[1]);
  c.lineTo(b[0], b[1]);
  c.stroke();
}

// Dibuja un trazo opaco; la opacidad del lápiz se aplica al componerlo.
function drawStroke(c, it) {
  const pen = penOf(it);
  const color = resolveColor(it.c);
  c.strokeStyle = c.fillStyle = color;
  c.lineCap = pen.flat ? 'square' : 'round';
  c.lineJoin = 'round';
  const p = it.p;
  if (p.length === 1) {
    c.beginPath();
    c.arc(p[0][0], p[0][1], strokeW(it, p[0][2]) / 2, 0, Math.PI * 2);
    c.fill();
    return;
  }
  for (let i = 1; i < p.length; i++) strokeSegment(c, it, p[i - 1], p[i]);
}

function drawShape(c, it) {
  c.strokeStyle = c.fillStyle = resolveColor(it.c);
  c.lineWidth = it.w / REF_WIDTH;
  c.lineCap = c.lineJoin = 'round';
  for (const poly of shapePolys(it)) {
    c.beginPath();
    poly.pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    if (poly.closed) c.closePath();
    if (it.f && poly.closed) {
      c.globalAlpha = 0.25;
      c.fill();
      c.globalAlpha = 1;
    }
    c.stroke();
  }
}

function drawSticker(c, it) {
  const W = c.canvas.width;
  const { w, h } = stickerSize(it);
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  if (it.e.startsWith('lbl:')) {
    const [, text, color] = it.e.split(':');
    c.fillStyle = color;
    c.beginPath();
    c.roundRect((it.x - w / 2) * W, (it.y - h / 2) * W, w * W, h * W, (h * W) / 2);
    c.fill();
    c.fillStyle = '#fff';
    c.font = `800 ${h * 0.5 * W}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
    c.fillText(text, it.x * W, (it.y + h * 0.03) * W);
  } else {
    c.font = `${it.s * 0.82 * W}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    c.fillText(it.e, it.x * W, (it.y + it.s * 0.05) * W);
  }
  c.restore();
}

function drawItem(c, it) {
  if (it.t === 'sticker') drawSticker(c, it);
  else if (it.t === 'shape') drawShape(c, it);
  else drawStroke(c, it);
}

// Textura de grafito: un patrón de ruido para borrar píxeles (canvas) y su inverso como máscara CSS (trazo en vivo).
const GRAIN = 96;
let grain = null;
function getGrain() {
  if (grain) return grain;
  const make = () => Object.assign(document.createElement('canvas'), { width: GRAIN, height: GRAIN });
  const erase = make(), mask = make();
  const ei = new ImageData(GRAIN, GRAIN), mi = new ImageData(GRAIN, GRAIN);
  for (let i = 0; i < GRAIN * GRAIN; i++) {
    const a = Math.random() < 0.45 ? 150 + Math.random() * 105 : 0;
    ei.data[i * 4 + 3] = a;
    mi.data[i * 4 + 3] = 255 - a;
  }
  erase.getContext('2d').putImageData(ei, 0, 0);
  mask.getContext('2d').putImageData(mi, 0, 0);
  grain = { erasePattern: layerCtx.createPattern(erase, 'repeat'), maskUrl: `url(${mask.toDataURL()})` };
  return grain;
}

// Trazo translúcido: se dibuja opaco en una capa y se compone con la opacidad del lápiz (sin oscurecer los cruces).
function drawAlphaStroke(it) {
  const pen = penOf(it);
  const W = els.canvas.width;
  const b = bounds(it);
  const x0 = Math.max(0, Math.floor(b.x0 * W) - 2), y0 = Math.max(0, Math.floor(b.y0 * W) - 2);
  const x1 = Math.min(layer.width, Math.ceil(b.x1 * W) + 2), y1 = Math.min(layer.height, Math.ceil(b.y1 * W) + 2);
  if (x1 <= x0 || y1 <= y0) return;
  layerCtx.setTransform(1, 0, 0, 1, 0, 0);
  layerCtx.clearRect(x0, y0, x1 - x0, y1 - y0);
  setNormalized(layerCtx);
  drawStroke(layerCtx, it);
  if (pen.grain) {
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    layerCtx.globalCompositeOperation = 'destination-out';
    layerCtx.fillStyle = getGrain().erasePattern;
    layerCtx.fillRect(x0, y0, x1 - x0, y1 - y0);
    layerCtx.globalCompositeOperation = 'source-over';
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = pen.alpha;
  ctx.drawImage(layer, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  ctx.globalAlpha = 1;
}

function redraw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  for (const it of state.items) {
    if (!it.t && penOf(it).alpha < 1) {
      drawAlphaStroke(it);
    } else {
      setNormalized(ctx);
      drawItem(ctx, it);
    }
  }
}

// Capa en vivo: trazo/forma en curso o recuadro de selección.
let liveItem = null;

function setLiveStyle(pen) {
  els.live.style.opacity = pen ? String(pen.alpha) : '1';
  const mask = pen?.grain ? getGrain().maskUrl : '';
  els.live.style.webkitMaskImage = els.live.style.maskImage = mask;
  const size = mask ? `${GRAIN / (window.devicePixelRatio || 1)}px` : '';
  els.live.style.webkitMaskSize = els.live.style.maskSize = size;
}

function renderLive() {
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.clearRect(0, 0, els.live.width, els.live.height);
  if (liveItem) {
    setLiveStyle(liveItem.t ? null : penOf(liveItem));
    setNormalized(lctx);
    drawItem(lctx, liveItem);
    els.selUi.hidden = true;
  } else {
    setLiveStyle(null);
    drawSelection();
  }
}

function drawSelection() {
  const it = state.tool === 'select' ? state.items[state.sel] : null;
  if (!it) {
    els.selUi.hidden = true;
    return;
  }
  const W = els.live.width;
  const dpr = window.devicePixelRatio || 1;
  const b = bounds(it);
  const pad = 6 * dpr;
  const x = b.x0 * W - pad, y = b.y0 * W - pad, w = (b.x1 - b.x0) * W + pad * 2, h = (b.y1 - b.y0) * W + pad * 2;
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.lineWidth = 1.6 * dpr;
  lctx.strokeStyle = '#0a84ff';
  lctx.setLineDash([6 * dpr, 4 * dpr]);
  lctx.beginPath();
  lctx.roundRect(x, y, w, h, 8 * dpr);
  lctx.stroke();
  lctx.setLineDash([]);
  lctx.fillStyle = '#fff';
  lctx.beginPath();
  lctx.arc(x + w, y + h, 7 * dpr, 0, Math.PI * 2);
  lctx.fill();
  lctx.stroke();

  // botones flotantes sobre el objeto
  const css = els.sheet.offsetWidth;
  const top = (y / W) * css;
  els.selUi.hidden = false;
  els.selUi.style.left = `${((x + w) / W) * css}px`;
  els.selUi.style.top = `${top > 52 ? top - 46 : ((y + h) / W) * css + 10}px`;
  els.selUi.style.transform = 'translateX(-100%)';
}

// ---------- Historial ----------

function pushUndo() {
  state.undo.push(state.items);
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
  renderLive();
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(state.items);
  state.items = state.undo.pop();
  state.sel = null;
  redraw();
  commitDrawing();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(state.items);
  state.items = state.redo.pop();
  state.sel = null;
  redraw();
  commitDrawing();
}
els.undo.addEventListener('click', undo);
els.redo.addEventListener('click', redo);

function deleteSelected() {
  if (state.sel == null) return;
  pushUndo();
  state.items = state.items.filter((_, i) => i !== state.sel);
  state.sel = null;
  redraw();
  commitDrawing();
}
function duplicateSelected() {
  const it = state.items[state.sel];
  if (!it) return;
  pushUndo();
  state.items = [...state.items, mapItem(it, (x) => x + 0.03, (y) => y + 0.03, 1)];
  state.sel = state.items.length - 1;
  redraw();
  commitDrawing();
}
$('#sel-del').addEventListener('click', deleteSelected);
$('#sel-copy').addEventListener('click', duplicateSelected);

document.addEventListener('keydown', (e) => {
  if (!state.current || state.tool === 'text') return;
  if (e.target.closest?.('input, textarea')) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel != null) {
    e.preventDefault();
    deleteSelected();
  } else if (e.key === 'Escape') {
    closePop();
    if (state.sel != null) { state.sel = null; renderLive(); }
  }
});

// ---------- Entrada con Pencil / ratón / dedo ----------

let active = null; // acción en curso: { id, mode, ... }
let inertia = 0;

const stopInertia = () => cancelAnimationFrame(inertia);

function toPoint(e, rect, prevPressure) {
  let pressure = e.pressure > 0 ? e.pressure : 0.5;
  if (prevPressure != null) pressure = prevPressure + (pressure - prevPressure) * 0.5; // suaviza saltos de presión
  return [round4((e.clientX - rect.left) / rect.width), round4((e.clientY - rect.top) / rect.width), Math.round(pressure * 100) / 100];
}

const pos = (e, rect) => [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.width];

function selectedHandleHit(x, y, rect) {
  const it = state.items[state.sel];
  if (!it) return false;
  const b = bounds(it);
  const pad = 6 / rect.width;
  return Math.hypot(x - (b.x1 + pad), y - (b.y1 + pad)) <= 22 / rect.width;
}

function itemAt(x, y, rect) {
  for (let i = state.items.length - 1; i >= 0; i--) if (hitItem(state.items[i], x, y, 10 / rect.width, true)) return i;
  return -1;
}

function onCanvasDown(e) {
  if (state.tool === 'text') return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (active) {
    // El Pencil tiene prioridad sobre una palma o un dedo que ya estaba apoyado.
    if (active.mode === 'pan' && e.pointerType === 'pen') active = null;
    else return;
  }
  e.preventDefault();
  els.canvas.setPointerCapture(e.pointerId);
  stopInertia();

  const rect = els.canvas.getBoundingClientRect();
  const [x, y] = pos(e, rect);

  // Con el dedo solo se desplaza la hoja, salvo para arrastrar lo que ya está seleccionado.
  if (e.pointerType === 'touch' && !state.fingerDraws) {
    const sel = state.tool === 'select' ? state.items[state.sel] : null;
    const grabbing = sel && (selectedHandleHit(x, y, rect) || hitItem(sel, x, y, 12 / rect.width, true));
    if (!grabbing) {
      active = { id: e.pointerId, mode: 'pan', startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, v: 0, moved: false, x, y };
      return;
    }
  }
  beginAction(e, rect, x, y);
}
els.canvas.addEventListener('pointerdown', onCanvasDown);

// En una nota, tocar con el Pencil sobre la hoja pasa a dibujar sin tener que cambiar de herramienta.
els.sheet.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'pen' || state.tool !== 'text' || !state.current || e.target === els.canvas) return;
  e.preventDefault();
  setTool('pen');
  closePop();
  onCanvasDown(e);
}, true);

function placeSticker(x, y) {
  pushUndo();
  const item = { t: 'sticker', e: state.sticker, x, y, s: 0.11 };
  const { w, h } = stickerSize(item);
  item.x = round4(Math.min(Math.max(x, w / 2 + 0.01), 1 - HANDLE_ROOM - w / 2 - 0.01));
  item.y = round4(Math.max(y, h / 2 + 0.01));
  state.items = [...state.items, item];
  state.sel = state.items.length - 1;
  redraw();
  setTool('select');
  commitDrawing();
}

function beginAction(e, rect, x, y) {
  const id = e.pointerId;
  switch (state.tool) {
    case 'pen':
    case 'eraser': {
      // El botón borrador del lápiz (si el hardware lo reporta) borra aunque esté la herramienta lápiz.
      const mode = state.tool === 'eraser' || (e.buttons & 32) ? 'eraser' : 'pen';
      active = { id, mode, undoPushed: false };
      if (mode === 'pen') {
        liveItem = { k: state.pen, c: state.color, w: round4(PENS[state.pen].w * state.mult), p: [toPoint(e, rect)] };
        renderLive();
      } else {
        eraseAt(e, rect);
      }
      break;
    }
    case 'shape':
      active = { id, mode: 'shape' };
      liveItem = { t: 'shape', s: state.shape, c: state.color, w: round4(3 * state.mult), f: state.shapeFill, x1: x, y1: y, x2: x, y2: y };
      break;
    case 'sticker':
      active = { id, mode: 'none' };
      placeSticker(x, y);
      break;
    case 'select': {
      if (selectedHandleHit(x, y, rect)) {
        const orig = state.items[state.sel];
        const b = bounds(orig);
        active = { id, mode: 'scale', orig, b, ax: b.x0, ay: b.y0, undoPushed: false };
      } else {
        const idx = itemAt(x, y, rect);
        state.sel = idx >= 0 ? idx : null;
        active = idx >= 0 ? { id, mode: 'move', orig: state.items[idx], sx: x, sy: y, undoPushed: false } : { id, mode: 'none' };
        renderLive();
      }
      break;
    }
  }
}

els.canvas.addEventListener('pointermove', (e) => {
  if (!active || e.pointerId !== active.id) return;
  const rect = els.canvas.getBoundingClientRect();

  switch (active.mode) {
    case 'pan': {
      const dy = e.clientY - active.lastY;
      if (Math.abs(e.clientY - active.startY) > 6) active.moved = true;
      if (active.moved) els.scroller.scrollTop -= dy;
      const dt = Math.max(1, e.timeStamp - active.lastT);
      active.v = active.v * 0.6 + (dy / dt) * 0.4; // px/ms
      active.lastY = e.clientY;
      active.lastT = e.timeStamp;
      break;
    }
    case 'pen': {
      const events = e.getCoalescedEvents?.();
      for (const ev of events?.length ? events : [e]) {
        const prev = liveItem.p[liveItem.p.length - 1];
        const pt = toPoint(ev, rect, prev[2]);
        if (pt[0] === prev[0] && pt[1] === prev[1]) continue;
        liveItem.p.push(pt);
        setNormalized(lctx);
        lctx.strokeStyle = resolveColor(liveItem.c);
        lctx.lineCap = penOf(liveItem).flat ? 'square' : 'round';
        strokeSegment(lctx, liveItem, prev, pt);
      }
      const last = liveItem.p[liveItem.p.length - 1];
      if (last[1] * rect.width > rect.height - 160) extendSheet();
      break;
    }
    case 'eraser': {
      const events = e.getCoalescedEvents?.();
      for (const ev of events?.length ? events : [e]) eraseAt(ev, rect);
      break;
    }
    case 'shape': {
      let [x, y] = pos(e, rect);
      if (e.shiftKey) {
        const dx = x - liveItem.x1, dy = y - liveItem.y1;
        if (liveItem.s === 'line' || liveItem.s === 'arrow') {
          if (Math.abs(dx) > Math.abs(dy) * 2) y = liveItem.y1;
          else if (Math.abs(dy) > Math.abs(dx) * 2) x = liveItem.x1;
        } else {
          const m = Math.max(Math.abs(dx), Math.abs(dy));
          x = liveItem.x1 + Math.sign(dx || 1) * m;
          y = liveItem.y1 + Math.sign(dy || 1) * m;
        }
      }
      liveItem.x2 = round4(x);
      liveItem.y2 = round4(y);
      renderLive();
      if (y * rect.width > rect.height - 160) extendSheet();
      break;
    }
    case 'move': {
      const [x, y] = pos(e, rect);
      if (!active.undoPushed && Math.hypot(x - active.sx, y - active.sy) * rect.width < 3) break;
      // Mantén el objeto (y su asa de escala) dentro de la hoja.
      const b = bounds(active.orig);
      const dx = Math.max(-b.x0, Math.min(Math.max(0, 1 - HANDLE_ROOM - b.x1), x - active.sx));
      const dy = Math.max(-b.y0, y - active.sy);
      applyTransform(active.orig, (v) => v + dx, (v) => v + dy, 1);
      break;
    }
    case 'scale': {
      const [x, y] = pos(e, rect);
      const hx = active.b.x1 - active.ax, hy = active.b.y1 - active.ay;
      const kMax = Math.max(0.1, (1 - HANDLE_ROOM - active.ax) / hx);
      const k = Math.max(0.1, Math.min(12, kMax, ((x - active.ax) * hx + (y - active.ay) * hy) / (hx * hx + hy * hy)));
      applyTransform(active.orig, (v) => active.ax + (v - active.ax) * k, (v) => active.ay + (v - active.ay) * k, k);
      break;
    }
  }
});

function applyTransform(orig, fx, fy, k) {
  if (!active.undoPushed) {
    pushUndo();
    active.undoPushed = true;
  }
  const next = mapItem(orig, fx, fy, k);
  state.items = state.items.map((it, i) => (i === state.sel ? next : it));
  redraw();
  renderLive();
}

function eraseAt(e, rect) {
  const [x, y] = pos(e, rect);
  const r = 14 / rect.width;
  const kept = state.items.filter((it) => !hitItem(it, x, y, r, false));
  if (kept.length === state.items.length) return;
  if (!active.undoPushed) {
    pushUndo();
    active.undoPushed = true;
  }
  state.items = kept;
  state.sel = null;
  redraw();
}

function endAction(e) {
  if (!active || e.pointerId !== active.id) return;
  const a = active;
  active = null;
  const cancelled = e.type === 'pointercancel';

  switch (a.mode) {
    case 'pan': {
      if (!a.moved && !cancelled) {
        // toque con el dedo: seleccionar o colocar sin desplazar
        if (state.tool === 'select') {
          const rect = els.canvas.getBoundingClientRect();
          const idx = itemAt(a.x, a.y, rect);
          state.sel = idx >= 0 ? idx : null;
          renderLive();
        } else if (state.tool === 'sticker') {
          placeSticker(a.x, a.y);
        }
      } else if (Math.abs(a.v) > 0.05) {
        let v = Math.max(-48, Math.min(48, a.v * 16)); // px por frame, con tope
        const step = () => {
          els.scroller.scrollTop -= v;
          v *= 0.95;
          if (Math.abs(v) > 0.4) inertia = requestAnimationFrame(step);
        };
        inertia = requestAnimationFrame(step);
      }
      break;
    }
    case 'pen':
      if (liveItem && !cancelled) {
        pushUndo();
        state.items = [...state.items, liveItem];
        liveItem = null;
        redraw();
        commitDrawing();
      } else {
        liveItem = null;
        renderLive();
      }
      break;
    case 'shape': {
      const s = liveItem;
      liveItem = null;
      const rect = els.canvas.getBoundingClientRect();
      const tiny = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) * rect.width < 8;
      if (!tiny && !cancelled) {
        pushUndo();
        state.items = [...state.items, s];
        redraw();
        commitDrawing();
      } else {
        renderLive();
      }
      break;
    }
    case 'eraser':
      if (a.undoPushed) commitDrawing();
      break;
    case 'move':
    case 'scale':
      if (a.undoPushed) commitDrawing();
      break;
  }
}
els.canvas.addEventListener('pointerup', endAction);
els.canvas.addEventListener('pointercancel', endAction);
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
