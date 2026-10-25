import { openStore, newLocalNote, newLocalFile } from './store.js?v=__V__';
import { createSync } from './sync.js?v=__V__';
import { recognizeShape } from './shapes.js?v=__V__';

const BUILD = '__V__'; // el servidor lo sustituye por el id del despliegue

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- API ----------

// quiet: no redirigir a la pantalla de acceso si la sesión caducó (lo usa la sincronización en segundo plano)
async function api(method, url, body, { quiet = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), // texto = JSON ya armado
    credentials: 'same-origin',
  });
  if (res.status === 401 && !url.startsWith('/api/auth')) {
    if (!quiet) showAuth();
    throw Object.assign(new Error('Sesión expirada'), { status: 401 });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || 'Error'), { status: res.status, data });
  return data;
}

// UUID v4 (crypto.randomUUID solo existe en HTTPS; getRandomValues funciona siempre)
function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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
const MAX_SHEET_H = 10;       // alto máximo de la hoja (en anchos)
const MAX_CANVAS_PX = 12e6;   // Safari/iPad deja de dibujar por encima de ~16,7 M px
const REF_WIDTH = 800; // los grosores se guardan como px sobre una hoja de 800 px de ancho
const DEFAULT_SHEET_H = { note: 1.3, canvas: 1.7 };

// ---------- Estado ----------

const state = {
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
  snapShapes: true,     // formas perfectas al mantener el lápiz quieto
  fingerDraws: false,
  query: '',
  filter: 'all',        // all | note | canvas | file
  notes: [],            // resúmenes de notas y lienzos
  entries: [],          // lo que muestra el inicio (notas, lienzos y archivos)
  pendingIds: new Set(), // con cambios sin sincronizar
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
  const { pen, color, mult, shape, shapeFill, sticker, snapShapes } = state;
  try { localStorage.setItem('prefs', JSON.stringify({ pen, color, mult, shape, shapeFill, sticker, snapShapes })); } catch {}
}

const els = {
  auth: $('#auth'), app: $('#app'), authForm: $('#auth-form'), authError: $('#auth-error'),
  hub: $('#hub'), hubBody: $('#hub-body'), search: $('#search'), userBtn: $('#user-btn'), net: $('#net'),
  importBtn: $('#import-btn'), importInput: $('#import-input'), imageInput: $('#image-input'), dropHint: $('#drop-hint'),
  floatMenu: $('#float-menu'), toast: $('#toast'),
  noteView: $('#note-view'), sheet: $('#sheet'), scroller: $('#scroller'), back: $('#back'),
  title: $('#title'), ctitle: $('#ctitle'), body: $('#body'), canvas: $('#canvas'), live: $('#live'), status: $('#status'),
  pin: $('#pin'), deleteBtn: $('#delete'), exportBtn: $('#export-btn'), undo: $('#undo'), redo: $('#redo'), finger: $('#finger'),
  pop: $('#pop'), selUi: $('#sel-ui'), paperPicker: $('#paper-picker'), colorBtn: $('#color-btn'), insertImage: $('#insert-image'),
  fileView: $('#file-view'), fileBody: $('#file-body'), fileName: $('#file-name'), fileBack: $('#file-back'),
  fileSave: $('#file-save'), fileDelete: $('#file-delete'), fileAnnotate: $('#file-annotate'),
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

let store = null;       // almacén local del usuario actual
let sync = null;        // motor de sincronización
let currentUser = null;
let netState = { s: 'idle', pending: 0 };
let lastEditAt = -Infinity; // momento de la última edición (para no pisar lo que se está escribiendo)

async function logout() {
  await flush().catch(() => {});
  if (!navigator.onLine) {
    alert('Necesitas conexión para cerrar sesión: así no se pierden cambios sin sincronizar.');
    return;
  }
  await sync?.flushNow().catch(() => {});
  const left = sync ? await sync.pendingCount() : 0;
  if (left) {
    // Sin poder sincronizar, cerrar sesión borraría cambios que solo existen en este dispositivo.
    if (['offline', 'error'].includes(sync.getState())) {
      alert(`Hay ${left} cambio(s) sin sincronizar y ahora no hay conexión con el servidor. Inténtalo de nuevo cuando vuelva la conexión para no perderlos.`);
      return;
    }
    if (!confirm(`Hay ${left} cambio(s) que no se pudieron sincronizar. Si cierras sesión se perderán. ¿Cerrar sesión de todos modos?`)) return;
  }
  try {
    await api('POST', '/api/auth/logout', {});
  } catch (err) {
    if (!err.status) {
      alert('No se pudo contactar con el servidor. Inténtalo de nuevo.');
      return;
    }
  }
  try { localStorage.removeItem('lastUser'); } catch {}
  await teardown({ wipe: true }); // se borran las copias locales de este dispositivo
  showAuth();
}

async function teardown({ wipe = false } = {}) {
  sync?.stop();
  sync = null;
  if (store && wipe) await store.destroy();
  store = null;
  clearImageCache();
  thumbCache.clear();
  cardEls.clear();
}

// Subida y descarga binaria de archivos (las usa la sincronización)
async function uploadFile(id, f) {
  const res = await fetch(`/api/files/${id}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(f.name),
      'X-File-Type': f.type,
      'X-Embedded': f.embedded ? '1' : '0',
    },
    body: f.blob,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw Object.assign(new Error(data?.error || 'Error'), { status: res.status, data });
  }
}

async function downloadFile(id) {
  const res = await fetch(`/api/files/${id}`, { credentials: 'same-origin' });
  if (!res.ok) throw Object.assign(new Error('Error'), { status: res.status });
  return res.blob();
}

async function startApp(user) {
  currentUser = user;
  try { localStorage.setItem('lastUser', JSON.stringify(user)); } catch {}
  await teardown();
  store = await openStore(user.id);
  sync = createSync({ store, api, upload: uploadFile, download: downloadFile, uuid, hooks: syncHooks });
  els.auth.hidden = true;
  els.app.hidden = false;
  els.userBtn.textContent = (user.username[0] || '?').toUpperCase();
  state.current = null;
  setView('hub');
  await loadNotes();
  sync.schedule({ pull: true, ms: 0 });
}

const syncHooks = {
  isBusy: () => isWriting(),
  onState(s, pending) {
    netState = { s, pending };
    renderNet();
    updateStatus();
  },
  onListChanged: () => loadNotes().catch(() => {}),
  onNoteReplaced(id) {
    thumbCache.delete(id);
    if (state.current?.id === id) refreshOpenNote(id);
  },
  onNoteRemoved(id) {
    if (state.current?.id === id) closeNote().catch(() => {});
  },
  onFileRemoved(id) {
    if (currentFileId === id) closeFile();
  },
  onFileReady(id) {
    // Llegó una imagen: se repintan el lienzo abierto y las miniaturas que la usan.
    imageCache.delete(id);
    if (state.items.some((it) => it.t === 'image' && it.f === id)) redraw();
    thumbCache.clear();
    for (const el of cardEls.values()) el.dataset.sig = '';
    renderHub();
  },
  onNotice: (msg) => showToast(msg),
  isEditing: (id) => state.current?.id === id && (dirty.size > 0 || active !== null || performance.now() - lastEditAt < 4000),
};

// Indicador de conexión / sincronización en la cabecera
function renderNet() {
  const { s, pending } = netState;
  const n = pending ? ` · ${pending} pendiente${pending === 1 ? '' : 's'}` : '';
  let text = '';
  if (s === 'offline') text = `Sin conexión${n}`;
  else if (s === 'error') text = `Error del servidor${n}`;
  else if (s === 'auth') text = 'Sesión caducada · Entrar';
  else if (s === 'syncing' && pending) text = `Sincronizando…`;
  els.net.hidden = !text;
  els.net.textContent = text;
  els.net.dataset.state = s;
}
els.net.addEventListener('click', () => {
  if (netState.s === 'auth') showAuth();
  else sync?.schedule({ pull: true, ms: 0 });
});

let toastTimer;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 8000);
}
els.toast.addEventListener('click', () => (els.toast.hidden = true));

addEventListener('online', () => sync?.schedule({ pull: true, ms: 0 }));
addEventListener('offline', () => syncHooks.onState('offline', netState.pending));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync?.schedule({ pull: true, ms: 0 });
});
setInterval(() => {
  if (document.visibilityState === 'visible' && navigator.onLine) sync?.schedule({ pull: true, ms: 0 });
}, 45000);

// ---------- Vistas y transiciones ----------

const supportsVT = typeof document.startViewTransition === 'function';
if (!supportsVT) document.documentElement.classList.add('no-vt');
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function setView(view) {
  els.app.dataset.view = view;
  els.hub.hidden = view !== 'hub';
  els.noteView.hidden = view !== 'note';
  els.fileView.hidden = view !== 'file';
}

// Cambia de vista con View Transitions; si se indica, un elemento se "transforma" en otro (tarjeta ⇄ hoja).
function transition(update, { morphFrom = null, morphTo = null } = {}) {
  if (!supportsVT || reduceMotion() || document.visibilityState !== 'visible') return Promise.resolve(update());
  const root = document.documentElement;
  const target = () => (typeof morphTo === 'function' ? morphTo() : morphTo);
  root.classList.add('vt-view');
  if (morphFrom) morphFrom.style.viewTransitionName = 'morph';
  const t = document.startViewTransition(async () => {
    if (morphFrom) morphFrom.style.viewTransitionName = '';
    await update();
    const el = target();
    if (el) el.style.viewTransitionName = 'morph';
  });
  t.finished.catch(() => {}).finally(() => {
    root.classList.remove('vt-view');
    const el = target();
    if (el) el.style.viewTransitionName = '';
    if (morphFrom) morphFrom.style.viewTransitionName = '';
  });
  return t.updateCallbackDone.catch(() => {});
}

// ---------- Inicio: notas, lienzos y archivos ----------

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

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const noteTitle = (n) => n.title.trim() || (n.kind === 'canvas' ? 'Lienzo sin título' : 'Sin título');
const KIND = {
  note: { label: 'Nota', icon: 'type' },
  canvas: { label: 'Lienzo', icon: 'canvas' },
  file: { label: 'Archivo', icon: 'file' },
};

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const fileExt = (name) => (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'archivo').toUpperCase();

function fileEntry(f) {
  return {
    id: f.id, kind: 'file', title: f.name, type: f.type, size: f.size, preview: '', pinned: false,
    pending: f.isNew, syncError: f.syncError, hasBlob: Boolean(f.hasBlob),
    sortAt: f.localAt || Date.parse(f.created_at), search: f.name.toLowerCase(),
  };
}

// El inicio sale del almacén local (funciona sin conexión); la sincronización lo mantiene al día.
let loadSeq = 0;
async function loadNotes() {
  if (!store) return;
  const seq = ++loadSeq;
  const [items, files] = await Promise.all([store.items(), store.files()]);
  if (seq !== loadSeq) return;
  state.pendingIds = new Set([...items.filter((i) => i.pending).map((i) => i.id), ...files.filter((f) => f.isNew).map((f) => f.id)]);
  state.notes = items;
  state.entries = [...items, ...files.filter((f) => !f.embedded).map(fileEntry)];
  renderHub();
  updateStatus();
}

const cardEls = new Map(); // id → tarjeta (se reutilizan: así solo se animan las nuevas)
const thumbCache = new Map(); // id → { key, url } miniaturas del dibujo
let thumbQueue = Promise.resolve();

const themeKey = () => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();

function renderHub() {
  if (els.app.dataset.view !== 'hub') return; // se dibuja al volver al inicio
  const q = state.query.toLowerCase();
  const matches = state.entries.filter((e) => !q || e.search.includes(q));
  const counts = { all: matches.length, note: 0, canvas: 0, file: 0 };
  for (const e of matches) counts[e.kind]++;
  $$('#filters button').forEach((b) => {
    b.classList.toggle('on', b.dataset.filter === state.filter);
    b.setAttribute('aria-selected', String(b.dataset.filter === state.filter));
    $('.count', b).textContent = counts[b.dataset.filter] ? String(counts[b.dataset.filter]) : '';
  });

  const list = matches.filter((e) => state.filter === 'all' || e.kind === state.filter).sort((a, b) => b.sortAt - a.sortAt);
  if (!list.length) {
    cardEls.clear();
    const empty = el('div', 'hub-empty');
    empty.append(svgIcon(q ? 'search' : 'scribble'));
    empty.append(el('p', null, q ? 'Sin resultados' : state.filter === 'file' ? 'Aún no tienes archivos. Usa “Importar” o arrástralos aquí.' : 'Aún no hay nada aquí. Crea una nota o un lienzo.'));
    els.hubBody.replaceChildren(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  const seen = new Set();
  let i = 0;
  const section = (title, entries) => {
    if (!entries.length) return;
    const grid = el('div', 'grid');
    for (const e of entries) {
      grid.append(cardFor(e, i++));
      seen.add(e.id);
    }
    frag.append(el('h2', 'section-title', title), grid);
  };
  const pinned = list.filter((e) => e.pinned);
  section('Fijadas', pinned);
  section('Recientes', list.filter((e) => !e.pinned));
  for (const id of [...cardEls.keys()]) if (!seen.has(id)) cardEls.delete(id);
  els.hubBody.replaceChildren(frag);
}

function cardFor(e, i) {
  let card = cardEls.get(e.id);
  const sig = [e.kind, e.title, e.preview, e.pinned, e.pending, e.syncError, e.sortAt, e.paper, e.rev, e.hasBlob, themeKey()].join('|');
  if (card && card.dataset.sig === sig) return card;
  if (!card) {
    card = el('div', 'card enter');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.dataset.id = e.id;
    card.style.setProperty('--i', String(Math.min(i, 14)));
    card.addEventListener('animationend', () => card.classList.remove('enter'), { once: true });
    card.addEventListener('click', (ev) => {
      if (!ev.target.closest('.card-more')) openEntry(card.dataset.id, card);
    });
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openEntry(card.dataset.id, card); });
    card.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openCardMenu(card.dataset.id, card);
    });
    cardEls.set(e.id, card);
  }
  card.dataset.sig = sig;
  card.dataset.kind = e.kind;

  const thumb = el('div', 'thumb');
  if (e.kind === 'file') {
    if (e.type.startsWith('image/')) {
      const img = el('img', 'photo');
      img.alt = '';
      img.decoding = 'async';
      thumb.append(img);
      loadImage(e.id).then((im) => { img.src = im.src; img.classList.add('ready'); }).catch(() => {
        img.replaceWith(fileIcon(e));
      });
    } else {
      thumb.append(fileIcon(e));
    }
  } else {
    if (e.kind === 'canvas') thumb.dataset.paper = e.paper || 'blank';
    if (e.kind === 'note') {
      const text = el('div', 'text', e.preview);
      thumb.append(text);
    }
    if (e.has_drawing) {
      const ink = el('img', 'ink');
      ink.alt = '';
      thumb.append(ink);
      thumbFor(e).then((url) => { if (url) { ink.src = url; ink.classList.add('ready'); } }).catch(() => {});
    }
  }

  const tag = el('span', 'kind-tag');
  tag.append(svgIcon(KIND[e.kind].icon), document.createTextNode(e.kind === 'file' ? fileExt(e.title) : KIND[e.kind].label));

  const title = el('div', 'card-title');
  title.append(el('span', null, e.kind === 'file' ? e.title : noteTitle(e)));
  if (e.pinned) title.append(svgIcon('pin', 'pin-ic'));
  if (e.pending) {
    const dot = el('i', 'pend' + (e.syncError ? ' err' : ''));
    dot.title = e.syncError ? `No se pudo sincronizar: ${e.syncError}` : 'Pendiente de sincronizar';
    title.append(dot);
  }
  const meta = el('div', 'card-meta', e.kind === 'file' ? `${formatDate(e.sortAt)} · ${formatSize(e.size)}` : formatDate(e.sortAt));
  const info = el('div', 'card-info');
  info.append(title, meta);

  const more = el('button', 'card-more');
  more.type = 'button';
  more.title = 'Más opciones';
  more.setAttribute('aria-label', 'Más opciones');
  more.setAttribute('aria-haspopup', 'menu');
  more.append(svgIcon('more'));
  more.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openCardMenu(e.id, more);
  });

  card.replaceChildren(thumb, tag, info, more);
  return card;
}

function fileIcon(e) {
  const wrap = el('div', 'file-ic');
  wrap.append(svgIcon('file'), el('span', 'file-ext', fileExt(e.title)));
  return wrap;
}

// Miniatura del dibujo (se genera en segundo plano, una por una, y se guarda en memoria)
function thumbFor(e) {
  const key = `${e.rev}|${themeKey()}`;
  const hit = thumbCache.get(e.id);
  if (hit?.key === key) return Promise.resolve(hit.url);
  const job = thumbQueue.then(async () => {
    const again = thumbCache.get(e.id);
    if (again?.key === key) return again.url;
    const note = await store?.get(e.id);
    if (!note?.drawing?.strokes?.length) return null;
    const c = await renderDrawing(note.drawing.strokes, { width: 360, height: 270 });
    const url = c.toDataURL('image/png');
    thumbCache.set(e.id, { key, url });
    return url;
  });
  thumbQueue = job.catch(() => {});
  return job;
}

// Filtros y búsqueda
$$('#filters button').forEach((b) =>
  b.addEventListener('click', () => {
    state.filter = b.dataset.filter;
    renderHub();
  })
);
let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = els.search.value.trim();
    renderHub();
  }, 150);
});

$$('[data-new]').forEach((b) => b.addEventListener('click', () => createNote(b.dataset.new).catch(() => {})));
els.importBtn.addEventListener('click', () => els.importInput.click());
els.importInput.addEventListener('change', () => {
  const files = [...els.importInput.files];
  els.importInput.value = '';
  if (files.length) importFiles(files);
});

// Arrastrar y soltar archivos en el inicio
let dragDepth = 0;
const draggingFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!draggingFiles(e) || els.app.hidden || els.app.dataset.view !== 'hub') return;
  dragDepth++;
  els.dropHint.hidden = false;
});
document.addEventListener('dragleave', () => {
  if (dragDepth && --dragDepth === 0) els.dropHint.hidden = true;
});
document.addEventListener('dragover', (e) => { if (draggingFiles(e) && els.app.dataset.view === 'hub') e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropHint.hidden = true;
  if (els.app.dataset.view === 'hub' && e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]);
});

async function openEntry(id, card) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  if (entry.kind === 'file') return openFile(id, card);
  return openNote(id, { from: card });
}

// ---------- Menús flotantes ----------

let menuAnchor = null;

function openMenu(anchor, items) {
  if (!els.floatMenu.hidden && menuAnchor === anchor) return closeMenu();
  menuAnchor = anchor;
  const m = els.floatMenu;
  m.replaceChildren();
  for (const it of items) {
    if (it.head) {
      const head = el('div', 'menu-head');
      head.append(el('strong', null, it.head));
      if (it.sub) head.append(el('small', 'muted', it.sub));
      m.append(head);
      continue;
    }
    const b = el('button', it.danger ? 'danger' : '');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(svgIcon(it.icon));
    const label = el('span', null, it.label);
    if (it.sub) label.append(el('small', null, it.sub));
    b.append(label);
    b.addEventListener('click', () => {
      closeMenu();
      it.action();
    });
    m.append(b);
  }
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const left = Math.min(innerWidth - m.offsetWidth - 8, Math.max(8, r.right - m.offsetWidth));
  let top = r.bottom + 8;
  if (top + m.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - m.offsetHeight - 8);
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
}

function closeMenu() {
  els.floatMenu.hidden = true;
  menuAnchor = null;
}

document.addEventListener('pointerdown', (e) => {
  if (!els.floatMenu.hidden && !e.target.closest('#float-menu') && !(menuAnchor && menuAnchor.contains(e.target))) closeMenu();
  if (!els.pop.hidden && !e.target.closest('#pop, .toolbar')) closePop();
});
addEventListener('resize', closeMenu);

els.userBtn.addEventListener('click', () =>
  openMenu(els.userBtn, [
    { head: `@${currentUser?.username ?? ''}`, sub: `Versión ${BUILD}` },
    { icon: 'download', label: 'Exportar copia de seguridad', sub: 'Notas, lienzos y archivos (.json)', action: exportBackup },
    { icon: 'upload', label: 'Importar', sub: 'Archivos, textos o copias de seguridad', action: () => els.importInput.click() },
    { icon: 'logout', label: 'Cerrar sesión', danger: true, action: logout },
  ])
);

function openCardMenu(id, anchor) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  if (entry.kind === 'file') {
    return openMenu(anchor, [
      { icon: 'file', label: 'Abrir', action: () => openFile(id) },
      { icon: 'download', label: 'Descargar o compartir', action: () => saveFile(id) },
      ...(entry.type.startsWith('image/') ? [{ icon: 'pen', label: 'Anotar en un lienzo', action: () => annotateImage(id) }] : []),
      { icon: 'trash', label: 'Eliminar', danger: true, action: () => deleteFile(id) },
    ]);
  }
  openMenu(anchor, [
    { icon: KIND[entry.kind].icon, label: 'Abrir', action: () => openNote(id) },
    { icon: 'pin', label: entry.pinned ? 'Quitar de fijadas' : 'Fijar', action: () => togglePin(id) },
    { icon: 'copy', label: 'Duplicar', action: () => duplicateNote(id) },
    { icon: 'share', label: 'Exportar…', action: () => openMenu(anchor, exportOptions(id, entry.kind)) },
    { icon: 'trash', label: 'Eliminar', danger: true, action: () => deleteNote(id) },
  ]);
}

// ---------- Crear, abrir y cerrar ----------

async function createNote(kind) {
  if (!store) return;
  await flush().catch(() => {});
  const note = newLocalNote(uuid(), kind);
  await store.put(note);
  await loadNotes();
  await openNote(note.id, { focusTitle: true });
  if (kind === 'canvas') openPop('pen'); // muestra lápices y colores al crear un lienzo
  sync.schedule();
}

// keepView: recarga el contenido (p. ej. llegó una versión nueva de otro dispositivo) sin mover la hoja ni la herramienta.
async function openNote(id, { focusTitle = false, keepView = false, from = null } = {}) {
  await flush().catch(() => {});
  const note = await store.get(id);
  if (!note) return;
  const scrollTop = els.scroller.scrollTop;

  const apply = () => {
    state.current = { id: note.id, title: note.title, body: note.body, pinned: note.pinned, kind: note.kind, paper: note.paper };
    state.items = Array.isArray(note.drawing?.strokes) ? note.drawing.strokes : [];
    note.drawingParts?.forEach((part, i) => { if (state.items[i]) itemJson.set(state.items[i], part); });
    state.undo = [];
    state.redo = [];
    state.sel = null;
    liveItem = null;
    dirty.clear();
    if (!keepView) closePop();

    const canvasKind = note.kind === 'canvas';
    els.noteView.dataset.kind = note.kind;
    els.noteView.dataset.id = note.id;
    els.title.value = els.ctitle.value = note.title;
    els.body.value = note.body;
    els.ctitle.hidden = !canvasKind;
    els.paperPicker.hidden = !canvasKind;
    els.sheet.dataset.paper = canvasKind ? note.paper : 'blank';
    syncPaperPicker();
    els.sheet.style.setProperty('--sheet-h', String(note.drawing?.h ?? DEFAULT_SHEET_H[note.kind]));
    els.pin.setAttribute('aria-pressed', String(note.pinned));
    updateStatus();

    setView('note');
    els.scroller.scrollTop = keepView ? scrollTop : 0;
    autoGrow();
    if (!keepView) {
      if (canvasKind) setTool(state.tool === 'text' ? 'pen' : state.tool);
      else setTool(state.items.length && !note.body ? 'pen' : 'text');
    }
    canvasNoteId = null;
    syncCanvasSize();
    updateHistoryButtons();
  };

  if (keepView || els.app.dataset.view === 'note') apply();
  else await transition(apply, { morphFrom: from?.querySelector('.thumb') ?? null, morphTo: els.sheet });
  if (focusTitle && note.kind !== 'canvas' && state.tool === 'text') els.title.focus();
}

// Llegó una versión nueva de la nota abierta: se recarga solo si no se está editando.
function refreshOpenNote(id) {
  if (state.current?.id !== id || syncHooks.isEditing(id)) return;
  openNote(id, { keepView: true }).catch(() => {});
}

async function closeNote() {
  await flush().catch(() => {});
  await loadNotes(); // (no dibuja: aún no se ve el inicio) datos frescos para la transición
  const id = state.current?.id;
  await transition(() => {
    state.current = null;
    closePop();
    setView('hub');
    renderHub();
  }, { morphFrom: els.sheet, morphTo: () => cardEls.get(id)?.querySelector('.thumb') });
}

els.back.addEventListener('click', () => closeNote().catch(() => {}));

function autoGrow() {
  els.body.style.height = 'auto';
  els.body.style.height = `${Math.max(els.body.scrollHeight, 0)}px`;
}

function onTitleInput(value, source) {
  state.current.title = value;
  (source === els.title ? els.ctitle : els.title).value = value;
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
  autoGrow();
  markDirty('body');
});

els.pin.addEventListener('click', () => {
  state.current.pinned = !state.current.pinned;
  els.pin.setAttribute('aria-pressed', String(state.current.pinned));
  markDirty('pinned');
});

els.deleteBtn.addEventListener('click', () => { if (state.current) deleteNote(state.current.id); });
els.exportBtn.addEventListener('click', () => {
  if (state.current) openMenu(els.exportBtn, exportOptions(state.current.id, state.current.kind));
});

// Cambia campos de una nota que no está abierta (fijar desde el inicio, etc.)
async function updateNote(id, patch) {
  if (state.current?.id === id) {
    for (const [k, v] of Object.entries(patch)) {
      state.current[k] = v;
      markDirty(k);
    }
    if ('pinned' in patch) els.pin.setAttribute('aria-pressed', String(patch.pinned));
    return flush();
  }
  const n = await store.getMeta(id);
  if (!n) return;
  Object.assign(n, patch);
  n.dirty = [...new Set([...n.dirty, ...Object.keys(patch)])];
  n.rev += 1;
  n.syncError = null;
  await store.put(n);
  await loadNotes();
  sync.schedule();
}

async function togglePin(id) {
  const n = await store.getMeta(id);
  if (n) await updateNote(id, { pinned: !n.pinned });
}

async function duplicateNote(id) {
  await flush().catch(() => {});
  const n = await store.get(id);
  if (!n) return;
  const copy = newLocalNote(uuid(), n.kind);
  Object.assign(copy, { title: `${noteTitle(n)} (copia)`, body: n.body, drawing: n.drawing, paper: n.paper });
  await store.put(copy);
  await loadNotes();
  sync.schedule();
  showToast('Duplicado');
}

async function deleteNote(id) {
  const note = await store.getMeta(id);
  if (!note || !confirm(`¿Eliminar ${note.kind === 'canvas' ? 'este lienzo' : 'esta nota'}?`)) return;
  const open = state.current?.id === id;
  if (open) {
    clearTimeout(saveTimer);
    saveTimer = null;
    dirty.clear();
  }
  await store.remove(id);
  if (!note.isNew) await store.markDeleted(id); // el borrado se envía al servidor al sincronizar
  thumbCache.delete(id);
  if (open) await closeNote();
  await loadNotes();
  sync.schedule();
}

// ---------- Archivos ----------

let currentFileId = null;
let fileUrl = null;

// El tipo guardado en el registro manda (el servidor puede devolver algunos como octet-stream)
const typed = (blob, type) => (blob.type === type ? blob : new Blob([blob], { type }));

async function fileBlob(id) {
  const f = await store.getFile(id);
  if (!f) return null;
  if (f.blob) return typed(f.blob, f.type);
  const blob = await downloadFile(id);
  await store.putFile({ ...f, blob });
  return typed(blob, f.type);
}

async function openFile(id, from = null) {
  const f = await store.getFile(id);
  if (!f) return;
  await flush().catch(() => {});
  currentFileId = id;
  await transition(() => {
    state.current = null;
    els.fileName.textContent = f.name;
    els.fileAnnotate.hidden = !f.type.startsWith('image/');
    els.fileBody.replaceChildren(el('div', 'file-empty', 'Cargando…'));
    setView('file');
  }, { morphFrom: from?.querySelector('.thumb') ?? null, morphTo: els.fileBody });

  let blob;
  try {
    blob = await fileBlob(id);
  } catch {
    if (currentFileId !== id) return;
    const msg = el('div', 'file-empty');
    msg.append(svgIcon('file'), el('p', null, 'Este archivo aún no está en este dispositivo. Ábrelo con conexión para guardarlo y verlo sin conexión.'));
    els.fileBody.replaceChildren(msg);
    return;
  }
  if (currentFileId !== id || !blob) return;
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = URL.createObjectURL(blob);

  const t = f.type;
  let view;
  if (t.startsWith('image/')) {
    view = el('img');
    view.alt = f.name;
    view.src = fileUrl;
  } else if (t === 'application/pdf') {
    // Vista integrada + botón al visor nativo (en iPad muestra todas las páginas y permite buscar).
    view = el('div', 'pdf-view');
    const frame = el('iframe');
    frame.title = f.name;
    frame.src = fileUrl;
    const open = el('button', 'pill-btn glass-pill pdf-open');
    open.type = 'button';
    open.append(svgIcon('share'), el('span', null, 'Abrir PDF'));
    open.addEventListener('click', () => window.open(fileUrl, '_blank'));
    view.append(frame, open);
  } else if (t.startsWith('video/')) {
    view = el('video');
    view.controls = true;
    view.playsInline = true;
    view.src = fileUrl;
  } else if (t.startsWith('audio/')) {
    view = el('audio');
    view.controls = true;
    view.src = fileUrl;
  } else if (t.startsWith('text/') || /json|xml|markdown|csv/.test(t) || /\.(txt|md|csv|json|log)$/i.test(f.name)) {
    view = el('pre');
    blob.slice(0, 2e6).text().then((x) => (view.textContent = x));
  } else {
    view = el('div', 'file-empty');
    const btn = el('button', 'primary', 'Descargar');
    btn.type = 'button';
    btn.addEventListener('click', () => saveFile(id));
    view.append(svgIcon('file'), el('p', null, `No hay vista previa para este tipo de archivo (${fileExt(f.name)}).`), btn);
  }
  els.fileBody.replaceChildren(view);
}

function closeFile() {
  const id = currentFileId;
  currentFileId = null;
  transition(() => {
    setView('hub');
    renderHub();
  }, { morphFrom: els.fileBody, morphTo: () => cardEls.get(id)?.querySelector('.thumb') }).then(() => {
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = null;
    els.fileBody.replaceChildren();
  });
}

async function saveFile(id) {
  const f = await store.getFile(id);
  try {
    const blob = await fileBlob(id);
    if (blob) await deliver(blob, f.name);
  } catch {
    showToast('Este archivo no está disponible sin conexión.');
  }
}

async function deleteFile(id) {
  const f = await store.getFile(id);
  if (!f || !confirm(`¿Eliminar “${f.name}”?`)) return;
  await store.removeFile(id);
  if (!f.isNew) await store.markDeleted(id, 'file');
  imageCache.delete(id);
  if (currentFileId === id) closeFile();
  await loadNotes();
  sync.schedule();
}

els.fileBack.addEventListener('click', closeFile);
els.fileSave.addEventListener('click', () => currentFileId && saveFile(currentFileId));
els.fileDelete.addEventListener('click', () => currentFileId && deleteFile(currentFileId));
els.fileAnnotate.addEventListener('click', () => currentFileId && annotateImage(currentFileId));

// Reduce fotos grandes antes de guardarlas en un lienzo (menos datos que sincronizar).
async function downscaleImage(blob, max = 2400) {
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch { return blob; }
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (s === 1 && blob.size < 3e6) {
    bmp.close?.();
    return blob;
  }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const type = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return new Promise((resolve) => c.toBlob((b) => resolve(b || blob), type, 0.88));
}

// Guarda una imagen como archivo incrustado y devuelve su id y proporción.
async function embedImage(blob, name) {
  const small = await downscaleImage(blob);
  const id = uuid();
  await store.putFile(newLocalFile(id, { name: name || 'imagen.jpg', type: small.type || 'image/jpeg', blob: small, embedded: true }));
  const img = await loadImage(id);
  return { id, ratio: img.naturalHeight / img.naturalWidth };
}

async function insertImage(file) {
  if (!state.current) return;
  try {
    const { id, ratio } = await embedImage(file, file.name);
    const w = Math.min(0.6, 0.8 / ratio);
    const h = w * ratio;
    const y = els.scroller.scrollTop / els.sheet.offsetWidth + 0.06;
    const item = { t: 'image', f: id, x: round4((1 - w) / 2), y: round4(y), w: round4(w), h: round4(h) };
    pushUndo();
    state.items = [...state.items, item];
    state.sel = state.items.length - 1;
    redraw();
    setTool('select');
    commitDrawing();
  } catch (err) {
    console.error(err);
    showToast('No se pudo insertar la imagen.');
  }
}
els.insertImage.addEventListener('click', () => els.imageInput.click());
els.imageInput.addEventListener('change', () => {
  const file = els.imageInput.files[0];
  els.imageInput.value = '';
  if (file) insertImage(file);
});

// Crea un lienzo con la imagen para escribir encima
async function annotateImage(fileId) {
  try {
    const f = await store.getFile(fileId);
    const blob = await fileBlob(fileId);
    const { id, ratio } = await embedImage(blob, f.name);
    const w = 0.9;
    const h = w * ratio;
    const note = newLocalNote(uuid(), 'canvas');
    note.title = f.name.replace(/\.[^.]+$/, '');
    note.drawing = { v: 2, h: Math.max(DEFAULT_SHEET_H.canvas, round4(h + 0.15)), strokes: [{ t: 'image', f: id, x: 0.05, y: 0.05, w, h: round4(h) }] };
    await store.put(note);
    await loadNotes();
    await openNote(note.id);
    sync.schedule();
  } catch (err) {
    console.error(err);
    showToast('No se pudo abrir la imagen para anotar.');
  }
}

// ---------- Importar ----------

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function parseText(text, filename) {
  const m = text.match(/^\s*#\s+(.+)\r?\n?/);
  if (m) return { title: m[1].trim().slice(0, 300), body: text.slice(m[0].length).replace(/^\s*\n/, '') };
  return { title: filename.replace(/\.[^.]+$/, '').slice(0, 300), body: text };
}

// Copia de seguridad o nota exportada (.notas.json). Todo se importa con ids nuevos.
async function importPackage(data) {
  const fileMap = new Map();
  let files = 0, notes = 0;
  for (const f of Array.isArray(data.files) ? data.files : []) {
    if (!f?.data) continue;
    const id = uuid();
    fileMap.set(f.id, id);
    await store.putFile(newLocalFile(id, { name: String(f.name || 'archivo'), type: String(f.type || ''), blob: base64ToBlob(f.data, f.type), embedded: Boolean(f.embedded) }));
    if (!f.embedded) files++;
  }
  for (const n of Array.isArray(data.notes) ? data.notes : []) {
    const rec = newLocalNote(uuid(), n?.kind === 'canvas' ? 'canvas' : 'note');
    rec.title = String(n?.title ?? '').slice(0, 300);
    rec.body = String(n?.body ?? '');
    rec.pinned = Boolean(n?.pinned);
    rec.paper = ['blank', 'grid', 'lined', 'dots'].includes(n?.paper) ? n.paper : 'blank';
    if (n?.drawing && Array.isArray(n.drawing.strokes)) {
      rec.drawing = { ...n.drawing, strokes: n.drawing.strokes.map((it) => (it?.t === 'image' ? { ...it, f: fileMap.get(it.f) ?? it.f } : it)) };
    }
    await store.put(rec);
    notes++;
  }
  return { notes, files };
}

const MAX_FILE = 30 * 1024 * 1024;

async function importFiles(list) {
  if (!store) return;
  let notes = 0, files = 0;
  const failed = [];
  for (const file of list) {
    try {
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.json') && file.size < 200 * 1024 * 1024) {
        let data = null;
        try { data = JSON.parse(await file.text()); } catch {}
        if (data?.app === 'notas') {
          const r = await importPackage(data);
          notes += r.notes;
          files += r.files;
          continue;
        }
      }
      if (/\.(md|markdown|txt)$/.test(lower) && file.size < 5 * 1024 * 1024) {
        const { title, body } = parseText(await file.text(), file.name);
        const n = newLocalNote(uuid(), 'note');
        n.title = title;
        n.body = body;
        await store.put(n);
        notes++;
        continue;
      }
      if (file.size > MAX_FILE) {
        failed.push(`${file.name} (más de 30 MB)`);
        continue;
      }
      await store.putFile(newLocalFile(uuid(), { name: file.name, type: file.type, blob: file }));
      files++;
    } catch (err) {
      console.error(err);
      failed.push(file.name);
    }
  }
  await loadNotes();
  sync?.schedule();
  const parts = [];
  if (notes) parts.push(`${notes} nota${notes === 1 ? '' : 's'}`);
  if (files) parts.push(`${files} archivo${files === 1 ? '' : 's'}`);
  showToast([parts.length ? `Importado: ${parts.join(' y ')}.` : '', failed.length ? `No se pudo importar: ${failed.join(', ')}.` : ''].filter(Boolean).join(' ') || 'Nada que importar.');
}

// ---------- Exportar ----------

const safeName = (s) => (s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'nota');

// Entrega un archivo: hoja de compartir en iPad/iPhone (Guardar en Archivos, AirDrop…) o descarga normal.
async function deliver(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Empaqueta notas (y los archivos que usan, o todos) en un .json que se puede volver a importar.
async function notesPackage(notes, { allFiles = false } = {}) {
  const used = new Set();
  for (const n of notes) for (const it of n.drawing?.strokes ?? []) if (it.t === 'image') used.add(it.f);
  const chosen = (await store.files()).filter((f) => allFiles || used.has(f.id));
  const parts = [
    `{"app":"notas","version":1,"exported_at":${JSON.stringify(new Date().toISOString())},"notes":`,
    JSON.stringify(notes.map((n) => ({ id: n.id, kind: n.kind, paper: n.paper, title: n.title, body: n.body, drawing: n.drawing, pinned: n.pinned }))),
    ',"files":[',
  ];
  let first = true, missing = 0;
  for (const f of chosen) {
    let blob = f.hasBlob ? (await store.getFile(f.id))?.blob : null;
    if (!blob) {
      try { blob = await downloadFile(f.id); } catch { missing++; continue; }
    }
    const head = JSON.stringify({ id: f.id, name: f.name, type: f.type, embedded: f.embedded });
    parts.push(`${first ? '' : ','}${head.slice(0, -1)},"data":"${await blobToBase64(blob)}"}`);
    first = false;
  }
  parts.push(']}');
  return { blob: new Blob(parts, { type: 'application/json' }), missing };
}

async function exportBackup() {
  if (!store) return;
  await flush().catch(() => {});
  showToast('Preparando copia de seguridad…');
  const notes = (await Promise.all((await store.items()).map((i) => store.get(i.id)))).filter(Boolean);
  const { blob, missing } = await notesPackage(notes, { allFiles: true });
  await deliver(blob, `notas-copia-${new Date().toISOString().slice(0, 10)}.notas.json`);
  showToast(missing ? `Copia lista. ${missing} archivo(s) no se incluyeron porque no están en este dispositivo.` : 'Copia de seguridad lista.');
}

function exportOptions(id, kind) {
  const opts = [];
  if (kind === 'canvas') opts.push({ icon: 'image', label: 'Imagen PNG', sub: 'Para compartir o imprimir', action: () => exportNote(id, 'png') });
  opts.push({ icon: 'file', label: 'PDF', sub: 'Desde el diálogo de impresión', action: () => exportNote(id, 'pdf') });
  if (kind === 'note') opts.push({ icon: 'type', label: 'Texto (.md)', sub: 'Solo el texto', action: () => exportNote(id, 'md') });
  opts.push({ icon: 'download', label: 'Archivo de Notas (.json)', sub: 'Se puede volver a importar', action: () => exportNote(id, 'json') });
  return opts;
}

function contentBottom(items) {
  return items.reduce((m, it) => Math.max(m, bounds(it).y1), 0);
}

async function exportNote(id, format) {
  await flush().catch(() => {});
  const note = await store.get(id);
  if (!note) return;
  const name = safeName(noteTitle(note));
  try {
    if (format === 'json') {
      const { blob } = await notesPackage([note]);
      return deliver(blob, `${name}.notas.json`);
    }
    if (format === 'md') {
      return deliver(new Blob([`# ${noteTitle(note)}\n\n${note.body}\n`], { type: 'text/markdown' }), `${name}.md`);
    }
    if (format === 'png') {
      const items = note.drawing?.strokes ?? [];
      const sheetH = note.drawing?.h ?? DEFAULT_SHEET_H[note.kind];
      const h = Math.min(sheetH, Math.max(0.75, contentBottom(items) + 0.06));
      const W = Math.round(Math.min(1800, Math.sqrt(14e6 / h))); // sin pasar el límite de canvas de Safari
      const c = await renderDrawing(items, {
        width: W, height: Math.round(W * h), ink: '#14171f', background: '#ffffff',
        paper: note.kind === 'canvas' ? note.paper : null, paperColor: 'rgba(20, 23, 31, 0.12)',
      });
      const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
      return deliver(blob, `${name}.png`);
    }
    if (format === 'pdf') {
      if (state.current?.id !== id) await openNote(id);
      printSheet();
    }
  } catch (err) {
    console.error(err);
    showToast('No se pudo exportar.');
  }
}

// PDF: se imprime solo la hoja (en iPad: Imprimir → Compartir → Guardar en Archivos).
function printSheet() {
  const pref = themePref();
  const dark = document.documentElement.dataset.theme === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) applyTheme('light', { save: false });
  const textCopy = el('div', 'print-body', els.body.value); // el textarea no crece al imprimir: se imprime una copia
  els.body.after(textCopy);
  const restore = () => {
    removeEventListener('afterprint', restore);
    textCopy.remove();
    if (dark) applyTheme(pref, { save: false });
  };
  addEventListener('afterprint', restore);
  setTimeout(() => window.print(), 60);
}

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
// Cada cambio se guarda enseguida en el dispositivo (IndexedDB) y la sincronización lo envía al servidor
// cuando hay conexión. Así se puede editar sin conexión.

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('err', isError);
}

// Estado de la nota abierta: guardada, pendiente (sin conexión) o sincronizando.
function updateStatus() {
  if (!state.current) return;
  if (dirty.size) return setStatus('Guardando…');
  const item = state.notes.find((n) => n.id === state.current.id);
  if (item?.syncError) return setStatus('No se pudo sincronizar', true);
  if (!state.pendingIds.has(state.current.id)) return setStatus(store && !store.persistent ? 'Guardado' : 'Guardado');
  if (netState.s === 'offline' || netState.s === 'error') return setStatus('Guardado en este dispositivo · se sincronizará');
  if (netState.s === 'auth') return setStatus('Guardado en este dispositivo · inicia sesión para sincronizar');
  setStatus('Guardado · sincronizando…');
}

// Escribiendo con el Pencil (o justo después): se evita cualquier trabajo pesado (guardar, sincronizar,
// miniaturas) porque bloquearía el hilo principal y Safari podría cortar el trazo siguiente.
const WRITE_PAUSE_MS = 1500;
const FORCE_SAVE_MS = 20000;
let firstDirtyAt = 0;
let lastStrokeAt = -Infinity;
const isWriting = () => active !== null || penDown || performance.now() - Math.max(lastPenAt, lastStrokeAt) < WRITE_PAUSE_MS;

function markDirty(field) {
  if (!dirty.size) firstDirtyAt = performance.now();
  dirty.add(field);
  lastEditAt = performance.now();
  setStatus('Guardando…');
  // Cada cambio pospone el guardado, salvo que ya lleve 20 s pendiente: entonces el temporizador sigue su curso.
  if (!saveTimer || performance.now() - firstDirtyAt < FORCE_SAVE_MS) scheduleFlush(600);
}

function scheduleFlush(ms) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // Si se sigue escribiendo, se espera a una pausa; tras 20 s se guarda igual, pero nunca con el lápiz apoyado.
    const overdue = performance.now() - firstDirtyAt > FORCE_SAVE_MS;
    if (isWriting() && !(overdue && active === null && !penDown)) return scheduleFlush(400);
    flush().catch(() => {});
  }, ms);
}

// JSON de cada objeto del dibujo, calculado una sola vez (los objetos no se modifican, se reemplazan).
// Guardar = unir textos ya hechos: no se recorre ni se copia el dibujo entero mientras se escribe.
const itemJson = new WeakMap();
function jsonOf(it) {
  let s = itemJson.get(it);
  if (s === undefined) {
    s = JSON.stringify(it);
    itemJson.set(it, s);
  }
  return s;
}

function drawingRecord() {
  if (!state.items.length) return null;
  const h = Math.round((els.sheet.offsetHeight / els.sheet.offsetWidth) * 1000) / 1000;
  return { v: 2, h, parts: state.items.map(jsonOf) };
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  // Serializa los guardados para que no se pisen entre sí.
  const run = saving.then(async () => {
    if (!state.current || !dirty.size || !store) return;
    const id = state.current.id;
    const fields = [...dirty];
    dirty.clear();
    try {
      const note = await store.getMeta(id); // solo datos (sin el dibujo)
      if (!note) return; // se eliminó
      for (const f of fields) if (f !== 'drawing') note[f] = state.current[f];
      if (fields.includes('drawing')) note.drawingRec = drawingRecord();
      note.dirty = [...new Set([...note.dirty, ...fields])];
      note.rev += 1;
      if (fields.some((f) => f !== 'pinned')) note.localAt = Date.now();
      note.syncError = null;
      await store.put(note);
    } catch (err) {
      fields.forEach((f) => dirty.add(f));
      setStatus(err?.name === 'QuotaExceededError' ? 'No hay espacio para guardar en este dispositivo' : 'No se pudo guardar en el dispositivo', true);
      throw err;
    }
    state.pendingIds.add(id);
    updateStatus();
    if (els.app.dataset.view === 'hub') await loadNotes();
    sync.schedule({ ms: 1200 });
  });
  saving = run.catch(() => {}); // un fallo no debe bloquear los guardados siguientes
  return run;
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
    if (it && it.t !== 'sticker' && it.t !== 'image') {
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
  $('#snap-shapes').addEventListener('change', (e) => {
    state.snapShapes = e.target.checked;
    savePrefs();
  });
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
  $('#snap-shapes').checked = state.snapShapes;
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
  if (h >= MAX_SHEET_H) return;
  els.sheet.style.setProperty('--sheet-h', String(Math.round((h + 0.8) * 100) / 100));
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

const boundsCache = new WeakMap(); // los objetos son inmutables: se pueden cachear
function bounds(it) {
  let b = boundsCache.get(it);
  if (!b) boundsCache.set(it, (b = computeBounds(it)));
  return b;
}

function computeBounds(it) {
  if (it.t === 'image') return { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h };
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
  if (!inBounds(bounds(it), x, y, r + 0.02)) return false;
  if (it.t === 'image') return inBounds(bounds(it), x, y, r / 2);
  if (it.t === 'sticker') return inBounds(bounds(it), x, y, r / 2);
  if (it.t === 'shape') {
    const rr = r + it.w / REF_WIDTH / 2;
    if (shapePolys(it).some((p) => nearPolyline(p.pts, p.closed, x, y, rr))) return true;
    return interior && it.f && inBounds(bounds(it), x, y);
  }
  return nearPolyline(it.p, false, x, y, r + strokeW(it, 1) / 2);
}

// Ramer–Douglas–Peucker; también conserva puntos donde cambia la presión.
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const spatial = distToSegment(pts[i][0], pts[i][1], pts[a], pts[b]) / eps;
      const pr = pts[a][2] + ((pts[b][2] - pts[a][2]) * (i - a)) / (b - a);
      const err = Math.max(spatial, Math.abs(pts[i][2] - pr) / 0.1);
      if (err > worst) { worst = err; idx = i; }
    }
    if (worst > 1) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function mapItem(it, fx, fy, k) {
  if (it.t === 'image') return { ...it, x: round4(fx(it.x)), y: round4(fy(it.y)), w: round4(it.w * k), h: round4(it.h * k) };
  if (it.t === 'sticker') return { ...it, x: round4(fx(it.x)), y: round4(fy(it.y)), s: it.s * k };
  if (it.t === 'shape') return { ...it, x1: round4(fx(it.x1)), y1: round4(fy(it.y1)), x2: round4(fx(it.x2)), y2: round4(fy(it.y2)) };
  return { ...it, p: it.p.map(([x, y, pr]) => [round4(fx(x)), round4(fy(y)), pr]), w: it.w * k };
}

// ---------- Render ----------

let inkOverride = null; // color de la tinta "automática" al exportar (siempre oscura sobre blanco)
const resolveColor = (c) => (c === 'ink' ? inkOverride || getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#000' : c);
const setNormalized = (c) => c.setTransform(c.canvas.width, 0, 0, c.canvas.width, 0, 0);

function syncCanvasSize() {
  const rect = els.sheet.getBoundingClientRect();
  // Si la hoja crece mucho, baja la resolución en lugar de pasarse del límite de memoria del navegador.
  const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PX / Math.max(1, rect.width * rect.height)));
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (els.canvas.width === w && els.canvas.height === h && canvasNoteId === state.current?.id) return;
  // Misma nota, mismo ancho y la hoja solo creció hacia abajo: se conserva lo dibujado (copia rápida).
  const grow = canvasNoteId === state.current?.id && els.canvas.width === w && h > els.canvas.height;
  let snap = null;
  if (grow) {
    snap = document.createElement('canvas');
    snap.width = w;
    snap.height = els.canvas.height;
    snap.getContext('2d').drawImage(els.canvas, 0, 0);
  }
  for (const c of [els.canvas, els.live]) {
    c.width = w;
    c.height = h;
  }
  if (snap) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(snap, 0, 0);
    snap.width = snap.height = 0; // libera memoria enseguida (Safari)
  } else {
    redraw();
  }
  canvasNoteId = state.current?.id;
  renderLive();
}
let canvasNoteId = null; // nota cuyo dibujo está ahora en el canvas
new ResizeObserver(syncCanvasSize).observe(els.sheet);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(themePref(), { save: false }));

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
  c.lineCap = 'round';
  c.lineJoin = 'round';
  const p = it.p;
  if (pen.lo === pen.hi && p.length > 1) {
    // Ancho constante (resaltador, marcador): un solo trazo continuo, sin uniones ni dientes.
    // El resaltador tiene punta plana; las formas reconocidas (it.sh) conservan sus esquinas.
    c.lineCap = pen.flat ? 'butt' : 'round';
    c.lineWidth = strokeW(it, 0.5);
    c.beginPath();
    c.moveTo(p[0][0], p[0][1]);
    if (it.sh) {
      for (let i = 1; i < p.length; i++) c.lineTo(p[i][0], p[i][1]);
    } else {
      for (let i = 1; i < p.length - 1; i++) c.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
      c.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
    }
    c.stroke();
    return;
  }
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

// Imágenes insertadas: se cargan del dispositivo (o del servidor) y se repinta al llegar.
const imageCache = new Map(); // id → { img, url, promise, failedAt }

function loadImage(id) {
  const hit = imageCache.get(id);
  if (hit && !(hit.failedAt && Date.now() - hit.failedAt > 15000)) return hit.promise;
  const entry = {};
  entry.promise = (async () => {
    const f = await store?.getFile(id);
    let blob = f?.blob;
    if (!blob) {
      blob = await downloadFile(id);
      if (f) await store.putFile({ ...f, blob });
    }
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await img.decode();
    entry.img = img;
    entry.url = url;
    return img;
  })();
  entry.promise.catch(() => { entry.failedAt = Date.now(); });
  imageCache.set(id, entry);
  return entry.promise;
}

function clearImageCache() {
  for (const e of imageCache.values()) if (e.url) URL.revokeObjectURL(e.url);
  imageCache.clear();
}

function drawImageItem(c, it) {
  const W = c.canvas.width;
  const x = it.x * W, y = it.y * W, w = it.w * W, h = it.h * W;
  const img = imageCache.get(it.f)?.img;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (img) {
    c.drawImage(img, x, y, w, h);
  } else {
    c.fillStyle = 'rgba(128, 128, 128, 0.12)';
    c.fillRect(x, y, w, h);
    c.strokeStyle = 'rgba(128, 128, 128, 0.45)';
    c.setLineDash([8, 6]);
    c.strokeRect(x, y, w, h);
    if (c === ctx) loadImage(it.f).then(() => { if (state.items.includes(it)) redraw(); }).catch(() => {});
  }
  c.restore();
}

function drawItem(c, it) {
  if (it.t === 'image') drawImageItem(c, it);
  else if (it.t === 'sticker') drawSticker(c, it);
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
function drawAlphaStroke(it, target = ctx) {
  const pen = penOf(it);
  const W = target.canvas.width;
  const b = bounds(it);
  const x0 = Math.max(0, Math.floor(b.x0 * W) - 2), y0 = Math.max(0, Math.floor(b.y0 * W) - 2);
  const x1 = Math.min(target.canvas.width, Math.ceil(b.x1 * W) + 2), y1 = Math.min(target.canvas.height, Math.ceil(b.y1 * W) + 2);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  if (layer.width < w) layer.width = w;
  if (layer.height < h) layer.height = h;
  layerCtx.setTransform(1, 0, 0, 1, 0, 0);
  layerCtx.clearRect(0, 0, layer.width, layer.height);
  layerCtx.setTransform(W, 0, 0, W, -x0, -y0);
  drawStroke(layerCtx, it);
  if (pen.grain) {
    layerCtx.setTransform(1, 0, 0, 1, -x0, -y0); // el patrón queda anclado al origen de la hoja
    layerCtx.globalCompositeOperation = 'destination-out';
    layerCtx.fillStyle = getGrain().erasePattern;
    layerCtx.fillRect(x0, y0, w, h);
    layerCtx.globalCompositeOperation = 'source-over';
  }
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalAlpha = pen.alpha;
  target.drawImage(layer, 0, 0, w, h, x0, y0, w, h);
  target.globalAlpha = 1;
}

// Dibuja solo un objeto recién creado (sin repintar toda la hoja).
function drawCommitted(it, target = ctx) {
  if (!it.t && penOf(it).alpha < 1) {
    drawAlphaStroke(it, target);
  } else {
    setNormalized(target);
    drawItem(target, it);
  }
}

// Papel dibujado en un canvas (para exportar PNG); mismas medidas que en pantalla.
function drawPaper(g, paper, w, h, color) {
  const u = w / 26;
  g.save();
  g.fillStyle = g.strokeStyle = color;
  g.lineWidth = Math.max(1, w / 900);
  g.beginPath();
  if (paper === 'grid') {
    for (let x = 0; x <= w; x += u) { g.moveTo(x, 0); g.lineTo(x, h); }
    for (let y = 0; y <= h; y += u) { g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
  } else if (paper === 'lined') {
    for (let y = u * 0.6 + u * 1.35; y <= h; y += u * 1.35) { g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
  } else if (paper === 'dots') {
    const r = Math.max(1.2, w / 700);
    for (let y = u / 2; y <= h; y += u) for (let x = u / 2; x <= w; x += u) { g.moveTo(x + r, y); g.arc(x, y, r, 0, Math.PI * 2); }
    g.fill();
  }
  g.restore();
}

// Dibuja los objetos en un canvas nuevo (miniaturas y exportación). Espera a que carguen las imágenes.
async function renderDrawing(items, { width, height, ink = null, background = null, paper = null, paperColor = null }) {
  await Promise.all(items.filter((it) => it.t === 'image').map((it) => loadImage(it.f).catch(() => null)));
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  if (background) {
    g.fillStyle = background;
    g.fillRect(0, 0, width, height);
  }
  if (paper && paper !== 'blank') drawPaper(g, paper, width, height, paperColor || 'rgba(128, 128, 128, 0.2)');
  const prev = inkOverride;
  inkOverride = ink;
  try {
    for (const it of items) drawCommitted(it, g);
  } finally {
    inkOverride = prev;
  }
  return c;
}

function redraw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  for (const it of state.items) drawCommitted(it);
}

// Capa en vivo: trazo/forma en curso o recuadro de selección.
let liveItem = null;

const pxScale = () => els.canvas.width / (els.sheet.offsetWidth || 1);

function setLiveStyle(pen) {
  els.live.style.opacity = pen ? String(pen.alpha) : '1';
  const mask = pen?.grain ? getGrain().maskUrl : '';
  els.live.style.webkitMaskImage = els.live.style.maskImage = mask;
  const size = mask ? `${GRAIN / pxScale()}px` : '';
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
  const dpr = pxScale();
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
function sendToBack() {
  const it = state.items[state.sel];
  if (!it || state.sel === 0) return;
  pushUndo();
  state.items = [it, ...state.items.filter((_, i) => i !== state.sel)];
  state.sel = 0;
  redraw();
  commitDrawing();
}
$('#sel-back').addEventListener('click', sendToBack);
$('#sel-del').addEventListener('click', deleteSelected);
$('#sel-copy').addEventListener('click', duplicateSelected);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.floatMenu.hidden) return closeMenu();
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

let active = null; // acción en curso: { id, mode, t, ... }
let lastPenAt = 0; // última vez que se vio el Pencil (también al pasar sobre la pantalla)
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
  const now = performance.now();
  if (e.pointerType === 'pen') lastPenAt = now;
  // Rechazo de palma: mientras el Pencil esté cerca, los toques con la mano se ignoran.
  if (e.pointerType === 'touch' && now - lastPenAt < 1500) {
    e.preventDefault();
    return;
  }
  if (active) {
    if (e.pointerType === 'pen') {
      // El Pencil siempre tiene prioridad: suelta lo que estuviera en curso (una palma, o un trazo cuyo "levantar" se perdió).
      if (active.mode === 'pan') active = null;
      else finishAction(false);
    } else if (now - active.t > 1500) {
      // Un dedo/ratón que dejó de dar señales: se considera terminado para no bloquear la entrada.
      if (active.mode === 'pan') active = null;
      else finishAction(true);
    } else {
      return;
    }
  }
  e.preventDefault();
  try { els.canvas.setPointerCapture(e.pointerId); } catch {}
  stopInertia();

  const rect = els.canvas.getBoundingClientRect();
  const [x, y] = pos(e, rect);

  // Con el dedo solo se desplaza la hoja, salvo para arrastrar lo que ya está seleccionado.
  if (e.pointerType === 'touch' && !state.fingerDraws) {
    const sel = state.tool === 'select' ? state.items[state.sel] : null;
    const grabbing = sel && (selectedHandleHit(x, y, rect) || hitItem(sel, x, y, 12 / rect.width, true));
    if (!grabbing) {
      active = { id: e.pointerId, mode: 'pan', t: now, startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, v: 0, moved: false, x, y };
      return;
    }
  }
  beginAction(e, rect, x, y);
  if (active) active.t = now;
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

// ---------- Formas perfectas ----------
// Si al terminar un trazo el lápiz se queda quieto un momento, el trazo se reemplaza por la forma limpia
// que se reconozca (línea, círculo, elipse, rectángulo, triángulo, polígono o línea quebrada).
const HOLD_MS = 550;
const HOLD_MOVE_PX = 4;

function armHold(a, e) {
  a.holdX = e.clientX;
  a.holdY = e.clientY;
  clearTimeout(a.holdTimer);
  a.holdTimer = setTimeout(() => snapToShape(a), HOLD_MS);
}

function snapToShape(a) {
  if (active !== a || a.mode !== 'pen' || !liveItem || liveItem.sh || liveItem.p.length < 3) return;
  const W = els.canvas.getBoundingClientRect().width;
  const shape = recognizeShape(liveItem.p.map(([x, y]) => [x * W, y * W]));
  if (!shape) return;
  const pressures = liveItem.p.map((p) => p[2]).sort((x, y) => x - y);
  const pr = pressures[Math.floor(pressures.length / 2)]; // grosor uniforme (mediana de la presión)
  liveItem = { ...liveItem, sh: 1, p: shape.points.map(([x, y]) => [round4(x / W), round4(y / W), pr]) };
  renderLive();
}

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
        if (state.snapShapes) armHold(active, e);
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
  active.t = performance.now();
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
      if (liveItem.sh) break; // ya se convirtió en forma: se ignora el resto hasta levantar el lápiz
      const pen = penOf(liveItem);
      const constant = pen.lo === pen.hi;
      const events = e.getCoalescedEvents?.();
      for (const ev of events?.length ? events : [e]) {
        const prev = liveItem.p[liveItem.p.length - 1];
        const pt = toPoint(ev, rect, prev[2]);
        if (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) * rect.width < 0.3) continue;
        liveItem.p.push(pt);
        if (!constant) {
          setNormalized(lctx);
          lctx.strokeStyle = resolveColor(liveItem.c);
          lctx.lineCap = 'round';
          strokeSegment(lctx, liveItem, prev, pt);
        }
      }
      if (constant) renderLive(); // un solo trazo suavizado (sin uniones visibles)
      if (state.snapShapes && Math.hypot(e.clientX - active.holdX, e.clientY - active.holdY) > HOLD_MOVE_PX) armHold(active, e);
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
  // Se revisa todo el recorrido desde la posición anterior (no solo el punto actual), para no saltarse
  // trazos finos cuando el Pencil se mueve rápido.
  const from = active.last ?? [x, y];
  active.last = [x, y];
  const steps = Math.max(1, Math.ceil(Math.hypot(x - from[0], y - from[1]) / (r * 0.6)));
  const samples = [];
  for (let i = 1; i <= steps; i++) samples.push([from[0] + ((x - from[0]) * i) / steps, from[1] + ((y - from[1]) * i) / steps]);
  const kept = state.items.filter((it) => it.t === 'image' || !samples.some(([sx, sy]) => hitItem(it, sx, sy, r, false)));
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
  finishAction(e.type === 'pointercancel');
}

function finishAction(cancelled) {
  const a = active;
  active = null;
  clearTimeout(a.holdTimer);
  if (a.mode !== 'pan' && a.mode !== 'none') lastStrokeAt = performance.now();

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
      // Si el sistema cancela el gesto a media palabra, se conserva lo ya dibujado.
      if (liveItem && (!cancelled || liveItem.p.length > 1)) {
        const item = liveItem.sh ? liveItem : { ...liveItem, p: simplify(liveItem.p, 0.35 / els.sheet.offsetWidth) };
        liveItem = null;
        pushUndo();
        state.items = [...state.items, item];
        drawCommitted(item);
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
        drawCommitted(s);
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
els.canvas.addEventListener('lostpointercapture', endAction);
els.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- Rechazo de palma ----------
// Mientras el Pencil está apoyado o se usó hace muy poco, los toques de la mano se anulan en TODA la app:
// no desplazan la hoja, no seleccionan texto, no pulsan botones (barra de herramientas, tarjetas…).
let penDown = false;
const PALM_MS = 900;
const palmGuard = () => penDown || performance.now() - lastPenAt < PALM_MS;

document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'pen') {
    penDown = true;
    lastPenAt = performance.now();
  } else if (e.pointerType === 'touch' && palmGuard()) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, (e) => {
    if (e.pointerType === 'pen') {
      penDown = false;
      lastPenAt = performance.now();
    }
  }, true);
}
// También al pasar el Pencil sobre la pantalla (iPad con "hover"): la palma suele apoyarse antes de escribir.
document.addEventListener('pointermove', (e) => { if (e.pointerType === 'pen') lastPenAt = performance.now(); }, { capture: true, passive: true });
// Safari: anular el toque de la palma evita el desplazamiento, la lupa de selección y los clics.
document.addEventListener('touchstart', (e) => {
  const fingers = [...e.changedTouches].some((t) => t.touchType !== 'stylus');
  if (fingers && palmGuard()) e.preventDefault();
}, { capture: true, passive: false });
// Al dibujar no se selecciona nada (salvo en campos de texto).
document.addEventListener('selectstart', (e) => {
  const target = e.target.nodeType === 1 ? e.target : e.target.parentElement;
  if ((palmGuard() || (els.app.dataset.view === 'note' && state.tool !== 'text')) && !target?.closest('input, textarea')) e.preventDefault();
});
document.addEventListener('contextmenu', (e) => {
  if (els.app.dataset.view === 'note' && state.tool !== 'text' && !e.target.closest?.('input, textarea')) e.preventDefault();
});

// ---------- Apariencia (automática / clara / oscura) ----------

const themeMeta = $('#theme-meta');

function themePref() {
  try {
    const m = localStorage.getItem('theme');
    return m === 'light' || m === 'dark' ? m : 'auto';
  } catch {
    return 'auto';
  }
}

// animate + origin: revelado circular desde el botón pulsado (View Transitions) o fundido de colores.
function applyTheme(mode, { save = true, animate = false, origin = null } = {}) {
  if (!animate || reduceMotion()) return applyThemeNow(mode, save);
  const root = document.documentElement;
  if (supportsVT && document.visibilityState === 'visible') {
    if (origin) {
      const r = origin.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      root.style.setProperty('--vt-x', `${x}px`);
      root.style.setProperty('--vt-y', `${y}px`);
      root.style.setProperty('--vt-r', `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`);
    }
    root.classList.add('vt-theme');
    const t = document.startViewTransition(() => applyThemeNow(mode, save));
    t.finished.catch(() => {}).finally(() => root.classList.remove('vt-theme'));
  } else {
    root.classList.add('theme-anim');
    applyThemeNow(mode, save);
    setTimeout(() => root.classList.remove('theme-anim'), 500);
  }
}

function applyThemeNow(mode, save) {
  const root = document.documentElement;
  if (mode === 'auto') delete root.dataset.theme;
  else root.dataset.theme = mode;
  if (save) {
    try { mode === 'auto' ? localStorage.removeItem('theme') : localStorage.setItem('theme', mode); } catch {}
  }
  $$('#theme-picker button').forEach((b) => {
    const on = b.dataset.themeMode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  themeMeta.content = getComputedStyle(root).getPropertyValue('--bg').trim(); // barra de estado / ventana de la PWA
  redraw(); // la tinta "automática" cambia de color con el tema
  renderLive();
  if (store) renderHub(); // miniaturas con la tinta del tema nuevo
}
$$('#theme-picker button').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.themeMode, { animate: true, origin: b })));
applyTheme(themePref(), { save: false });

// ---------- PWA ----------

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------- Arranque ----------

(async function init() {
  let user = null;
  try {
    user = await api('GET', '/api/me');
  } catch (err) {
    if (err.status) return; // 401: api() ya mostró la pantalla de acceso
    // Sin conexión con el servidor: se entra con el último usuario y sus notas guardadas en este dispositivo.
    try { user = JSON.parse(localStorage.getItem('lastUser') || 'null'); } catch {}
    if (!user?.id) {
      showAuth();
      els.authError.textContent = 'Sin conexión con el servidor. Inténtalo de nuevo cuando tengas internet.';
      return;
    }
  }
  try {
    await startApp(user);
    // Accesos directos de la app instalada (/?new=note | /?new=canvas)
    const want = new URLSearchParams(location.search).get('new');
    if (want === 'note' || want === 'canvas') {
      history.replaceState(null, '', location.pathname);
      await createNote(want);
    }
  } catch (err) {
    console.error(err);
    showAuth();
  }
})();
