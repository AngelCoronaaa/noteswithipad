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

export const ALL_FIELDS = ['title', 'body', 'drawing', 'pinned', 'paper'];

export function toItem(n) {
  const pending = n.isNew || n.dirty.length > 0;
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    preview: n.body.slice(0, 140),
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
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('notes', { keyPath: 'id' });
        d.createObjectStore('items', { keyPath: 'id' });
        d.createObjectStore('deleted', { keyPath: 'id' });
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
    markDeleted: (id) => req(os('deleted', 'readwrite').put({ id })),
    unmarkDeleted: (id) => req(os('deleted', 'readwrite').delete(id)),
    deleted: async () => (await req(os('deleted').getAll())).map((x) => x.id),
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
  const notes = new Map(), items = new Map(), deleted = new Set();
  return {
    persistent: false,
    items: async () => [...items.values()],
    get: async (id) => (notes.has(id) ? structuredClone(notes.get(id)) : undefined),
    async put(note) {
      notes.set(note.id, structuredClone(note));
      items.set(note.id, toItem(note));
    },
    async remove(id) { notes.delete(id); items.delete(id); },
    markDeleted: async (id) => { deleted.add(id); },
    unmarkDeleted: async (id) => { deleted.delete(id); },
    deleted: async () => [...deleted],
    async destroy() { notes.clear(); items.clear(); deleted.clear(); },
  };
}
