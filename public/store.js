// Almacén local (IndexedDB) de notas y cola de cambios pendientes. Una base de datos por usuario.
//
// Registro de nota (store "notes"):
//   { id, kind, paper, title, body, drawing, pinned,
//     updated_at,  // última versión conocida del servidor (null si aún no existe allí)
//     isNew,       // creada sin conexión y todavía no enviada
//     dirty,       // campos cambiados aquí y todavía no enviados
//     rev,         // contador de cambios locales (para saber si cambió mientras se enviaba)
//     localAt,     // momento de la última edición local (ms)
//     syncError }  // motivo por el que el servidor rechazó la nota (se limpia al editarla)
//
// Para que la lista no tenga que leer todos los dibujos, cada nota tiene un resumen ligero en el store "items".
//
// Archivo (store "files"): { id, name, type, size, embedded, created_at, hasBlob, isNew, localAt, syncError }
//   embedded: imagen insertada en un lienzo (no aparece en la lista de archivos)
//   hasBlob: el contenido ya está en el dispositivo (store "blobs", como ArrayBuffer: Safari no siempre
//            permite guardar objetos Blob en IndexedDB, p. ej. en navegación privada).
// getFile() devuelve además `blob` (Blob) si el contenido está; putFile() acepta `blob` y lo guarda aparte.

export const ALL_FIELDS = ['title', 'body', 'drawing', 'pinned', 'paper'];

export function toItem(n) {
  const pending = n.isNew || n.dirty.length > 0;
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    paper: n.paper,
    rev: n.rev,
    preview: n.body.slice(0, 280),
    pinned: n.pinned,
    has_drawing: Boolean(n.drawing?.strokes?.length),
    isNew: n.isNew,
    pending,
    syncError: n.syncError || null,
    updated_at: n.updated_at,
    sortAt: pending ? n.localAt : Date.parse(n.updated_at),
    search: `${n.title}\n${n.body.slice(0, 20000)}`.toLowerCase(),
  };
}

export function newLocalNote(id, kind) {
  return {
    id, kind, paper: 'blank', title: '', body: '', drawing: null, pinned: false,
    updated_at: null, isNew: true, dirty: [...ALL_FIELDS], rev: 1, localAt: Date.now(), syncError: null,
  };
}

export function fromServer(s, prevRev = 0) {
  return {
    id: s.id, kind: s.kind ?? 'note', paper: s.paper ?? 'blank', title: s.title, body: s.body,
    drawing: s.drawing ?? null, pinned: s.pinned, updated_at: s.updated_at,
    isNew: false, dirty: [], rev: prevRev + 1, localAt: Date.parse(s.updated_at), syncError: null,
  };
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

export async function openStore(userId) {
  if (typeof indexedDB === 'undefined') return memoryStore();
  const name = `notas-${userId}`;
  try {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 2);
      r.onupgradeneeded = (ev) => {
        const d = r.result;
        if (ev.oldVersion < 1) {
          d.createObjectStore('notes', { keyPath: 'id' });
          d.createObjectStore('items', { keyPath: 'id' });
          d.createObjectStore('deleted', { keyPath: 'id' });
        }
        if (ev.oldVersion < 2) {
          d.createObjectStore('files', { keyPath: 'id' });
          d.createObjectStore('blobs', { keyPath: 'id' });
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return idbStore(db, name);
  } catch {
    return memoryStore(); // p. ej. modo privado: funciona, pero sin guardado persistente
  }
}

function idbStore(db, name) {
  const os = (store, mode = 'readonly') => db.transaction(store, mode).objectStore(store);
  return {
    persistent: true,
    items: () => req(os('items').getAll()),
    get: (id) => req(os('notes').get(id)),
    async put(note) {
      const tx = db.transaction(['notes', 'items'], 'readwrite');
      tx.objectStore('notes').put(note);
      tx.objectStore('items').put(toItem(note));
      await done(tx);
    },
    async remove(id) {
      const tx = db.transaction(['notes', 'items'], 'readwrite');
      tx.objectStore('notes').delete(id);
      tx.objectStore('items').delete(id);
      await done(tx);
    },
    files: () => req(os('files').getAll()),
    async getFile(id) {
      const tx = db.transaction(['files', 'blobs']);
      const [meta, data] = await Promise.all([req(tx.objectStore('files').get(id)), req(tx.objectStore('blobs').get(id))]);
      if (!meta) return undefined;
      return { ...meta, blob: data ? new Blob([data.data], { type: meta.type }) : null };
    },
    async putFile(f) {
      const { blob, ...meta } = f;
      const data = blob ? await blob.arrayBuffer() : null; // antes de abrir la transacción (no puede esperar a otras promesas)
      meta.hasBlob = Boolean(data) || (blob === undefined && Boolean(f.hasBlob));
      const tx = db.transaction(['files', 'blobs'], 'readwrite');
      tx.objectStore('files').put(meta);
      if (data) tx.objectStore('blobs').put({ id: f.id, data });
      await done(tx);
    },
    async removeFile(id) {
      const tx = db.transaction(['files', 'blobs'], 'readwrite');
      tx.objectStore('files').delete(id);
      tx.objectStore('blobs').delete(id);
      await done(tx);
    },
    // kind: 'note' | 'file'
    markDeleted: (id, kind = 'note') => req(os('deleted', 'readwrite').put({ id, kind })),
    unmarkDeleted: (id) => req(os('deleted', 'readwrite').delete(id)),
    deleted: async () => (await req(os('deleted').getAll())).map((x) => ({ id: x.id, kind: x.kind || 'note' })),
    async destroy() {
      db.close();
      await new Promise((resolve) => {
        const r = indexedDB.deleteDatabase(name);
        r.onsuccess = r.onerror = r.onblocked = () => resolve();
      });
    },
  };
}

function memoryStore() {
  const notes = new Map(), items = new Map(), files = new Map(), deleted = new Map();
  return {
    persistent: false,
    items: async () => [...items.values()],
    get: async (id) => (notes.has(id) ? structuredClone(notes.get(id)) : undefined),
    async put(note) {
      notes.set(note.id, structuredClone(note));
      items.set(note.id, toItem(note));
    },
    async remove(id) { notes.delete(id); items.delete(id); },
    files: async () => [...files.values()].map(({ blob, ...meta }) => meta),
    getFile: async (id) => (files.has(id) ? { ...files.get(id) } : undefined),
    async putFile(f) {
      const prev = files.get(f.id);
      const blob = f.blob === undefined ? prev?.blob ?? null : f.blob;
      files.set(f.id, { ...f, blob, hasBlob: Boolean(blob) });
    },
    removeFile: async (id) => { files.delete(id); },
    markDeleted: async (id, kind = 'note') => { deleted.set(id, kind); },
    unmarkDeleted: async (id) => { deleted.delete(id); },
    deleted: async () => [...deleted].map(([id, kind]) => ({ id, kind })),
    async destroy() { notes.clear(); items.clear(); files.clear(); deleted.clear(); },
  };
}

export function newLocalFile(id, { name, type, blob, embedded = false }) {
  return {
    id, name, type: type || 'application/octet-stream', size: blob.size, embedded,
    created_at: new Date().toISOString(), blob, hasBlob: true, isNew: true, localAt: Date.now(), syncError: null,
  };
}
