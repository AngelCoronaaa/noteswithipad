// Almacén local (IndexedDB) de notas y cola de cambios pendientes. Una base de datos por usuario.
//
// Registro de nota (store "notes"):
//   { id, kind, paper, title, body, pinned, hasDrawing,
//     updated_at,  // última versión conocida del servidor (null si aún no existe allí)
//     isNew,       // creada sin conexión y todavía no enviada
//     dirty,       // campos cambiados aquí y todavía no enviados
//     rev,         // contador de cambios locales (para saber si cambió mientras se enviaba)
//     localAt,     // momento de la última edición local (ms)
//     syncError }  // motivo por el que el servidor rechazó la nota (se limpia al editarla)
//
// Para que la lista no tenga que leer todos los dibujos, cada nota tiene un resumen ligero en el store "items".
//
// El dibujo va aparte (store "drawings"): { id, v, h, parts }, donde `parts` es cada objeto ya convertido a JSON.
// Así guardar mientras se escribe es barato (no se recorre ni se copia el dibujo como objeto): se guardan
// textos ya preparados, y el JSON para el servidor se arma uniéndolos.
//   get(id)      → nota + `drawing` (objeto) + `drawingParts`
//   getMeta(id)  → solo los datos de la nota (sin dibujo)
//   put(note)    → con `drawing` (objeto o null) o `drawingRec` ({ v, h, parts } o null); sin ninguno, no toca el dibujo
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
    has_drawing: Boolean(n.hasDrawing),
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

// Dibujo (objeto) ⇄ registro guardado
export function toDrawingRec(drawing) {
  if (!drawing || !Array.isArray(drawing.strokes) || !drawing.strokes.length) return null;
  return { v: drawing.v ?? 2, h: drawing.h ?? null, parts: drawing.strokes.map((it) => JSON.stringify(it)) };
}
export function drawingFromRec(rec) {
  return rec?.parts?.length ? { v: rec.v, h: rec.h, strokes: rec.parts.map((x) => JSON.parse(x)) } : null;
}
// JSON del dibujo para enviarlo, sin volver a convertir cada trazo
export function drawingJson(rec) {
  if (!rec?.parts?.length) return 'null';
  return `{"v":${JSON.stringify(rec.v ?? 2)},"h":${JSON.stringify(rec.h ?? null)},"strokes":[${rec.parts.join(',')}]}`;
}

// Separa la nota en datos + registro de dibujo (undefined = no se toca el dibujo)
function splitNote(note) {
  const { drawing, drawingRec, drawingParts, ...meta } = note;
  let rec;
  if (drawingRec !== undefined) rec = drawingRec;
  else if (drawing !== undefined) rec = toDrawingRec(drawing);
  if (rec !== undefined) meta.hasDrawing = Boolean(rec?.parts?.length);
  return { meta, rec };
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
      const r = indexedDB.open(name, 3);
      r.onupgradeneeded = (ev) => {
        const d = r.result;
        const tx = r.transaction;
        if (ev.oldVersion < 1) {
          d.createObjectStore('notes', { keyPath: 'id' });
          d.createObjectStore('items', { keyPath: 'id' });
          d.createObjectStore('deleted', { keyPath: 'id' });
        }
        if (ev.oldVersion < 2) {
          d.createObjectStore('files', { keyPath: 'id' });
          d.createObjectStore('blobs', { keyPath: 'id' });
        }
        if (ev.oldVersion < 3) {
          // El dibujo pasa a su propio store (las notas guardadas antes lo tenían dentro).
          const drawings = d.createObjectStore('drawings', { keyPath: 'id' });
          const items = tx.objectStore('items');
          tx.objectStore('notes').openCursor().onsuccess = (e) => {
            const c = e.target.result;
            if (!c) return;
            const n = c.value;
            if ('drawing' in n) {
              const rec = toDrawingRec(n.drawing);
              if (rec) drawings.put({ id: n.id, ...rec });
              delete n.drawing;
              n.hasDrawing = Boolean(rec);
              c.update(n);
              items.put(toItem(n));
            }
            c.continue();
          };
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
    getMeta: (id) => req(os('notes').get(id)),
    getDrawingRec: async (id) => (await req(os('drawings').get(id))) ?? null,
    async get(id) {
      const tx = db.transaction(['notes', 'drawings']);
      const [meta, rec] = await Promise.all([req(tx.objectStore('notes').get(id)), req(tx.objectStore('drawings').get(id))]);
      if (!meta) return undefined;
      return { ...meta, drawing: drawingFromRec(rec), drawingParts: rec?.parts ?? null };
    },
    async put(note) {
      const { meta, rec } = splitNote(note);
      const tx = db.transaction(['notes', 'items', 'drawings'], 'readwrite');
      tx.objectStore('notes').put(meta);
      tx.objectStore('items').put(toItem(meta));
      if (rec) tx.objectStore('drawings').put({ id: meta.id, v: rec.v, h: rec.h, parts: rec.parts });
      else if (rec === null) tx.objectStore('drawings').delete(meta.id);
      await done(tx);
    },
    async remove(id) {
      const tx = db.transaction(['notes', 'items', 'drawings'], 'readwrite');
      tx.objectStore('notes').delete(id);
      tx.objectStore('items').delete(id);
      tx.objectStore('drawings').delete(id);
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
  const notes = new Map(), items = new Map(), drawings = new Map(), files = new Map(), deleted = new Map();
  return {
    persistent: false,
    items: async () => [...items.values()],
    getMeta: async (id) => (notes.has(id) ? { ...notes.get(id), dirty: [...notes.get(id).dirty] } : undefined),
    getDrawingRec: async (id) => drawings.get(id) ?? null,
    async get(id) {
      if (!notes.has(id)) return undefined;
      const rec = drawings.get(id);
      return { ...notes.get(id), dirty: [...notes.get(id).dirty], drawing: drawingFromRec(rec), drawingParts: rec?.parts ?? null };
    },
    async put(note) {
      const { meta, rec } = splitNote(note);
      notes.set(meta.id, { ...meta, dirty: [...meta.dirty] });
      items.set(meta.id, toItem(meta));
      if (rec) drawings.set(meta.id, { v: rec.v, h: rec.h, parts: [...rec.parts] });
      else if (rec === null) drawings.delete(meta.id);
    },
    async remove(id) { notes.delete(id); items.delete(id); drawings.delete(id); },
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
    async destroy() { notes.clear(); items.clear(); drawings.clear(); files.clear(); deleted.clear(); },
  };
}

export function newLocalFile(id, { name, type, blob, embedded = false }) {
  return {
    id, name, type: type || 'application/octet-stream', size: blob.size, embedded,
    created_at: new Date().toISOString(), blob, hasBlob: true, isNew: true, localAt: Date.now(), syncError: null,
  };
}
