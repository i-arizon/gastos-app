// sync.js — Sincronización con Google Sheets vía Apps Script.
// Cada cambio queda en la cola de IndexedDB y se envía en cuanto es posible.
import * as db from './db.js';

const AUTO_INTERVAL_MS = 3 * 60 * 1000;
const CHUNK = 200;

export const events = new EventTarget();
let state = { status: 'idle', pending: 0, message: '', lastSync: null };
let running = null;
let again = false;

function emit(patch) {
  state = { ...state, ...patch };
  events.dispatchEvent(new CustomEvent('change', { detail: state }));
}
export const getState = () => state;

async function getConfig() {
  const url = (await db.getSetting('scriptUrl', '')).trim();
  const token = (await db.getSetting('token', '')).trim();
  return { url, token };
}
export async function isConfigured() {
  const { url, token } = await getConfig();
  return Boolean(url && token);
}

// Apps Script responde con JSON {status:'ok'|'error', ...}
async function parseResponse(res) {
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(res.ok
      ? 'Respuesta no válida. Revisa la URL y que el acceso sea "Cualquier usuario".'
      : `HTTP ${res.status}`);
  }
  if (data.status !== 'ok') throw new Error(data.message || 'Error desconocido del script');
  return data;
}

function netError(err) {
  return err instanceof TypeError ? new Error('No se pudo conectar con el script') : err;
}

// text/plain evita la petición CORS preflight, que Apps Script no admite.
async function post(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
    return await parseResponse(res);
  } catch (err) { throw netError(err); }
}

// Lecturas (list/ping) también por POST: el token va en el cuerpo y no queda en registros de URL.
async function read(url, token, action) {
  try {
    return await post(url, { token, action });
  } catch (err) {
    if (/Acción no válida/.test(err.message)) {
      throw new Error('Actualiza el código del Apps Script e implementa una nueva versión');
    }
    throw err;
  }
}

// Recalcula el estado sin enviar nada (p. ej. al guardar un gasto offline).
export async function refreshStatus() {
  const pending = await db.queueCount();
  if (!(await isConfigured())) return emit({ status: 'unconfigured', pending });
  if (state.status === 'syncing') return emit({ pending });
  if (state.status === 'error' && pending) return emit({ pending });
  emit({ status: pending ? 'pending' : 'synced', pending, message: navigator.onLine ? '' : 'Sin conexión' });
}

// Envía la cola. Si ya hay una sincronización en marcha, se repite al terminar.
export function syncNow() {
  if (running) { again = true; return running; }
  running = doSync().finally(() => {
    running = null;
    if (again) { again = false; syncNow(); }
  });
  return running;
}

async function doSync() {
  const { url, token } = await getConfig();
  const queue = await db.getQueue();
  if (!url || !token) return emit({ status: 'unconfigured', pending: queue.length, message: '' });
  if (!queue.length) return emit({ status: 'synced', pending: 0, message: '' });
  if (!navigator.onLine) return emit({ status: 'pending', pending: queue.length, message: 'Sin conexión' });

  emit({ status: 'syncing', pending: queue.length, message: '' });
  try {
    const records = await db.getExpensesByIds(queue.map((q) => q.id));
    const groups = { upsert: [], delete: [] };
    const orphans = [];
    for (const entry of queue) {
      const exp = records.get(entry.id);
      if (exp) groups[entry.action === 'delete' ? 'delete' : 'upsert'].push({ entry, exp });
      else orphans.push(entry);
    }
    if (orphans.length) await db.dequeue(orphans);
    for (const action of ['upsert', 'delete']) {
      const items = groups[action];
      for (let i = 0; i < items.length; i += CHUNK) {
        const chunk = items.slice(i, i + CHUNK);
        await post(url, { token, action, expenses: chunk.map((c) => c.exp) });
        await db.dequeue(chunk.map((c) => c.entry));
      }
    }
    const lastSync = new Date().toISOString();
    await db.setSetting('lastSync', lastSync);
    const left = await db.queueCount();
    emit({ status: left ? 'pending' : 'synced', pending: left, message: '', lastSync });
  } catch (err) {
    emit({ status: 'error', pending: await db.queueCount(), message: err.message });
  }
}

// Comprueba URL y token sin modificar nada.
export async function ping() {
  const { url, token } = await getConfig();
  if (!url || !token) throw new Error('Introduce la URL y el token');
  return read(url, token, 'ping');
}

// Normaliza una fila devuelta por la hoja.
function normalizeRemote(r) {
  if (!r || !r.id) return null;
  return {
    id: String(r.id),
    date: String(r.date).slice(0, 10),
    name: String(r.name ?? ''),
    amount: Math.round(Number(String(r.amount).replace(',', '.')) * 100) / 100 || 0,
    type: r.type === 'income' ? 'income' : 'expense',
    category: String(r.category ?? 'Otros'),
    tag: String(r.tag ?? '').trim(),
    createdAt: String(r.createdAt || r.updatedAt || ''),
    updatedAt: String(r.updatedAt || ''),
    deleted: r.deleted === true || String(r.deleted).toLowerCase() === 'true',
  };
}

// Descarga todos los gastos de la hoja y los fusiona por id (gana el updatedAt más reciente).
export async function restore() {
  const { url, token } = await getConfig();
  if (!url || !token) throw new Error('Configura primero la URL y el token');
  const data = await read(url, token, 'list');
  const remote = (data.expenses || []).map(normalizeRemote).filter(Boolean);
  const result = await db.mergeExpenses(remote, { fromServer: true });
  await db.ensureCategories(remote.filter((e) => !e.deleted));
  syncNow();
  return { ...result, total: remote.length };
}

// Reintentos automáticos: al abrir, al recuperar conexión, al volver a la app y cada pocos minutos.
export async function startAutoSync() {
  const lastSync = await db.getSetting('lastSync', null);
  emit({ lastSync });
  syncNow();
  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => refreshStatus());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
  setInterval(() => syncNow(), AUTO_INTERVAL_MS);
}
