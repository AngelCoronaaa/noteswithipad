// Sincronización entre el almacén local y el servidor.
//
//  - push: envía borrados y cambios pendientes (notas nuevas o con campos "dirty").
//  - pull: baja del servidor lo que cambió en otros dispositivos y quita lo que se borró allí.
//  - Conflictos: si la nota cambió en el servidor y aquí también, el servidor responde 409 y se conserva
//    la versión del servidor en la nota original y la versión local como una copia nueva "(conflicto)".
//    Así nunca se pierde texto ni dibujos.

import { ALL_FIELDS, fromServer } from './store.js';

const MAX_LIST = 500; // el servidor devuelve como máximo 500 notas: con ese tope no se puede saber qué se borró

async function pool(list, size, fn) {
  const queue = [...list];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

export function createSync({ store, api, uuid, hooks }) {
  let running = false, again = false, wantPull = false, stopped = false;
  let timer = null, retryTimer = null, delay = 4000;
  let state = 'idle';

  const q = (method, url, body) => api(method, url, body, { quiet: true });

  async function pendingCount() {
    const items = await store.items();
    return items.filter((i) => i.pending && !i.syncError).length + (await store.deleted()).length;
  }

  async function emit(s) {
    state = s;
    if (!stopped) hooks.onState(s, await pendingCount());
  }

  function schedule({ pull = false, ms = 800 } = {}) {
    if (stopped) return;
    if (pull) wantPull = true;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  }

  async function run() {
    if (stopped) return;
    if (running) { again = true; return; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      await emit('offline'); // el evento "online" vuelve a lanzar la sincronización
      return;
    }
    running = true;
    clearTimeout(retryTimer);
    const doPull = wantPull;
    wantPull = false;
    try {
      await emit('syncing');
      await push();
      if (doPull) await pull();
      delay = 4000;
      hooks.onListChanged();
      await emit('idle');
    } catch (err) {
      if (stopped) return;
      hooks.onListChanged();
      if (err.status === 401) {
        await emit('auth'); // sesión caducada: se reanuda al volver a entrar
      } else {
        await emit(err.status ? 'error' : 'offline');
        wantPull ||= doPull;
        retryTimer = setTimeout(run, delay);
        delay = Math.min(delay * 2, 20000); // reintentos: 4 s, 8 s, 16 s, luego cada 20 s
      }
    } finally {
      running = false;
      if (again && !stopped) { again = false; schedule({ ms: 200 }); }
    }
  }

  async function push() {
    for (const id of await store.deleted()) {
      try {
        await q('DELETE', `/api/notes/${id}`);
      } catch (err) {
        if (err.status !== 404) throw err;
      }
      await store.unmarkDeleted(id);
    }
    const pending = (await store.items()).filter((i) => i.pending && !i.syncError).sort((a, b) => a.sortAt - b.sortAt);
    for (const it of pending) await pushOne(it.id, false);
  }

  async function pushOne(id, retried) {
    const note = await store.get(id);
    if (!note || (!note.isNew && !note.dirty.length)) return;

    const fields = note.isNew ? ALL_FIELDS : note.dirty.filter((f) => ALL_FIELDS.includes(f));
    const payload = {};
    for (const f of fields) payload[f] = note[f];
    if (note.isNew) payload.create = { kind: note.kind, paper: note.paper };
    else payload.base = note.updated_at;

    let saved;
    try {
      saved = await q('PUT', `/api/notes/${id}`, payload);
    } catch (err) {
      if (err.status === 409 && err.data?.server) return resolveConflict(note, err.data.server);
      if (err.status === 404 && !note.isNew && !retried) {
        // Se borró en otro dispositivo pero aquí se editó: se vuelve a crear para no perder lo escrito.
        await store.put({ ...note, isNew: true, dirty: [...ALL_FIELDS], updated_at: null, rev: note.rev + 1 });
        return pushOne(id, true);
      }
      if (err.status === 400 || err.status === 413) {
        const why = err.status === 413 ? 'es demasiado grande para guardarse' : err.message;
        await store.put({ ...note, syncError: why });
        hooks.onNotice(`“${note.title.trim() || 'Sin título'}” no se pudo sincronizar: ${why}.`);
        return;
      }
      throw err;
    }

    const cur = await store.get(id);
    if (!cur) {
      // Se eliminó aquí mientras se enviaba: ya existe en el servidor, así que se encola su borrado.
      await store.markDeleted(id);
      again = true;
      return;
    }
    cur.updated_at = saved.updated_at;
    cur.isNew = false;
    // Lo que se editó mientras se enviaba sigue pendiente; lo demás queda sincronizado.
    const unchanged = (f) => cur.rev === note.rev || JSON.stringify(cur[f]) === JSON.stringify(note[f]);
    cur.dirty = cur.dirty.filter((f) => !(fields.includes(f) && unchanged(f)));
    await store.put(cur);
  }

  async function resolveConflict(local, server) {
    const title = local.title.trim() || 'Sin título';
    await store.put({
      ...local,
      id: uuid(),
      title: `${title} (conflicto)`,
      pinned: false,
      updated_at: null,
      isNew: true,
      dirty: [...ALL_FIELDS],
      rev: 1,
      localAt: Date.now(),
      syncError: null,
    });
    await store.put(fromServer(server, local.rev));
    hooks.onNotice(`“${title}” se editó en otro dispositivo: tu versión se guardó como copia “${title} (conflicto)”.`);
    hooks.onNoteReplaced(local.id);
    again = true; // la copia se envía enseguida
  }

  async function pull() {
    const list = await q('GET', '/api/notes');
    const items = await store.items();
    const local = new Map(items.map((i) => [i.id, i]));
    const deleted = new Set(await store.deleted());
    const serverIds = new Set(list.map((n) => n.id));

    const todo = list.filter((s) => {
      if (deleted.has(s.id)) return false;
      const l = local.get(s.id);
      return !l || (!l.pending && (l.updated_at !== s.updated_at || l.pinned !== s.pinned));
    });
    await pool(todo, 4, async (s) => {
      if (hooks.isEditing(s.id)) return; // se está editando ahora: se baja en la próxima sincronización
      const full = await q('GET', `/api/notes/${s.id}`);
      const prev = await store.get(s.id);
      if (prev && (prev.isNew || prev.dirty.length)) return; // se editó aquí mientras tanto: gana lo local
      if (hooks.isEditing(s.id)) return;
      await store.put(fromServer(full, prev?.rev ?? 0));
      hooks.onNoteReplaced(s.id);
    });

    if (list.length < MAX_LIST) {
      for (const l of items) {
        if (l.isNew || serverIds.has(l.id)) continue;
        if (l.pending) {
          // Se borró en otro dispositivo pero aquí tiene cambios sin enviar: se conserva y se vuelve a subir.
          const n = await store.get(l.id);
          if (n) await store.put({ ...n, isNew: true, dirty: [...ALL_FIELDS], updated_at: null, rev: n.rev + 1 });
          again = true;
        } else {
          await store.remove(l.id);
          hooks.onNoteRemoved(l.id);
        }
      }
    }
  }

  // Sincroniza y espera a que termine (hasta 3 intentos).
  async function flushNow() {
    for (let i = 0; i < 3; i++) {
      while (running) await new Promise((r) => setTimeout(r, 100));
      await run();
      if (!(await pendingCount())) break;
    }
  }

  return {
    schedule,
    run,
    flushNow,
    pendingCount,
    getState: () => state,
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
    },
  };
}
