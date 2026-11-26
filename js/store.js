// Armazenamento: local (IndexedDB) e, quando configurado, nuvem (Firebase).
// Todas as telas leem do estado em memória e são avisadas a cada mudança.
import { FIREBASE_CONFIG } from './config.js';

export const COLLECTIONS = ['tasks', 'ideas', 'wishes', 'weeks', 'meta'];

const state = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
const listeners = new Set();
let cloud = null;          // módulo cloud.js quando ativo
let cloudUser = null;
let notifyQueued = false;
const readyCols = new Set();

export const store = {
  user: () => cloudUser,
  cloudAvailable: () => !!FIREBASE_CONFIG,
  isCloud: () => !!(cloud && cloudUser),
  /** true quando a coleção já veio completa (do servidor, se logada) */
  ready: (col) => readyCols.has(col),
  all: (col) => [...state[col].values()],
  get: (col, id) => state[col].get(id),
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  async put(col, doc) {
    doc.updatedAt = Date.now();
    if (!doc.createdAt) doc.createdAt = doc.updatedAt;
    state[col].set(doc.id, doc);
    notify();
    if (store.isCloud()) await cloud.put(col, doc).catch((e) => console.error(e));
    else await idbPut(col, doc);
    return doc;
  },

  async remove(col, id) {
    state[col].delete(id);
    notify();
    if (store.isCloud()) await cloud.remove(col, id).catch((e) => console.error(e));
    else await idbDelete(col, id);
  },

  async signIn() { if (cloud) return cloud.signIn(); },
  async signOut() { if (cloud) return cloud.signOut(); },

  exportJSON() {
    const out = { app: 'minha-agenda', version: 1, exportedAt: new Date().toISOString() };
    for (const c of COLLECTIONS) out[c] = store.all(c);
    return JSON.stringify(out, null, 2);
  },

  async importJSON(text) {
    const data = JSON.parse(text);
    if (data.app !== 'minha-agenda') throw new Error('Arquivo de backup inválido');
    for (const c of COLLECTIONS) for (const d of data[c] || []) { state[c].set(d.id, d); }
    notify();
    if (store.isCloud()) await cloud.bulkPut(data);
    else for (const c of COLLECTIONS) for (const d of data[c] || []) await idbPut(c, d);
  },
};

function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => { notifyQueued = false; listeners.forEach((fn) => fn()); });
}

// ---------------- IndexedDB local ----------------
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('minha-agenda', 1);
    r.onupgradeneeded = () => { for (const c of COLLECTIONS) r.result.createObjectStore(c, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(col, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(col, mode);
    const out = fn(t.objectStore(col));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
}
const idbPut = (col, doc) => tx(col, 'readwrite', (s) => s.put(doc)).catch(console.error);
const idbDelete = (col, id) => tx(col, 'readwrite', (s) => s.delete(id)).catch(console.error);
const idbAll = (col) => tx(col, 'readonly', (s) => s.getAll());
const idbClear = (col) => tx(col, 'readwrite', (s) => s.clear());

async function loadLocal() {
  readyCols.clear();
  for (const c of COLLECTIONS) {
    state[c].clear();
    try { for (const d of await idbAll(c)) state[c].set(d.id, d); } catch (e) { console.warn('IndexedDB indisponível', e); }
  }
  if (!FIREBASE_CONFIG) COLLECTIONS.forEach((c) => readyCols.add(c));
  notify();
}

// ---------------- Inicialização ----------------
export async function initStore(onAuthChange) {
  await loadLocal();
  if (!FIREBASE_CONFIG) return;
  try {
    cloud = await import('./cloud.js');
    await cloud.init(FIREBASE_CONFIG, {
      onUser: async (user) => {
        cloudUser = user;
        if (user) {
          // Primeiro login: leva para a nuvem o que já estava salvo neste aparelho
          const local = Object.fromEntries(await Promise.all(COLLECTIONS.map(async (c) => [c, await idbAll(c).catch(() => [])])));
          if (COLLECTIONS.some((c) => local[c].length)) {
            await cloud.bulkPut(local);
            for (const c of COLLECTIONS) await idbClear(c);
          }
          for (const c of COLLECTIONS) state[c].clear();
          readyCols.clear();
          cloud.listen(COLLECTIONS, (col, changes, fromServer) => {
            if (fromServer) readyCols.add(col);
            for (const ch of changes) {
              if (ch.type === 'removed') state[col].delete(ch.id); else state[col].set(ch.id, ch.data);
            }
            notify();
          });
        } else {
          await loadLocal();
        }
        onAuthChange?.(user);
        notify();
      },
    });
  } catch (e) {
    console.error('Falha ao iniciar o Firebase', e);
    cloud = null;
  }
}
