// db.js — Capa de datos local en IndexedDB (fuente de verdad de la app).
// Stores: expenses (movimientos: gastos e ingresos), categories, queue (cambios pendientes), settings.
// Un movimiento: { id, type, date, name, amount, category, tag, createdAt, updatedAt, deleted }
//   type: 'expense' | 'income' (los antiguos sin type son gastos); amount siempre positivo; tag puede ser ''.
// Una categoría: { name, color, order, type }; el nombre es único entre gastos e ingresos.
import { uuid } from './utils.js';

const DB_NAME = 'gastos-db';
const DB_VERSION = 1;

export const DEFAULT_CATEGORIES = [
  ['Supermercado', '#16a34a'], ['Restaurantes', '#f97316'], ['Transporte', '#2563eb'],
  ['Vivienda', '#7c3aed'], ['Suministros', '#0891b2'], ['Ocio', '#db2777'],
  ['Deporte', '#65a30d'], ['Salud', '#dc2626'], ['Compras', '#ca8a04'],
  ['Viajes', '#0d9488'], ['Suscripciones', '#4f46e5'], ['Otros', '#64748b'],
];
export const DEFAULT_INCOME_CATEGORIES = [
  ['Nómina', '#15803d'], ['Extra / Bonus', '#0e7490'], ['Bizum recibido', '#0891b2'],
  ['Reembolsos', '#65a30d'], ['Intereses', '#ca8a04'], ['Ventas', '#7c3aed'], ['Otros ingresos', '#64748b'],
];
export const typeOf = (x) => (x?.type === 'income' ? 'income' : 'expense');
// Colores para categorías nuevas o importadas.
const EXTRA_COLORS = ['#e11d48', '#0284c7', '#9333ea', '#ea580c', '#059669', '#a16207', '#be185d', '#475569'];

let dbPromise;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('expenses')) {
          db.createObjectStore('expenses', { keyPath: 'id' }).createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('categories')) db.createObjectStore('categories', { keyPath: 'name' });
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// Ejecuta fn(stores...) en una transacción; resuelve al completarse.
// Si fn devuelve un IDBRequest, se resuelve con su resultado.
async function run(storeNames, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = [].concat(storeNames).map((n) => t.objectStore(n));
    const out = fn(...stores);
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const now = () => new Date().toISOString();
const queueEntry = (id, action) => ({ id, action, queuedAt: now() });

/* ---------- Ajustes ---------- */
export async function getSetting(key, fallback = null) {
  const row = await run('settings', 'readonly', (s) => s.get(key));
  return row ? row.value : fallback;
}
export const setSetting = (key, value) => run('settings', 'readwrite', (s) => { s.put({ key, value }); });

/* ---------- Gastos ---------- */
export const getAllExpenses = () => run('expenses', 'readonly', (s) => s.getAll());
export const getExpense = (id) => run('expenses', 'readonly', (s) => s.get(id));

export async function getExpensesByIds(ids) {
  const all = await getAllExpenses();
  const wanted = new Set(ids);
  return new Map(all.filter((e) => wanted.has(e.id)).map((e) => [e.id, e]));
}

// Crea o actualiza un gasto y lo encola para sincronizar.
export async function saveExpense(data) {
  const existing = data.id ? await getExpense(data.id) : null;
  const ts = now();
  const exp = {
    id: data.id || uuid(),
    type: typeOf(data),
    date: data.date,
    name: data.name.trim(),
    amount: data.amount,
    category: data.category,
    tag: (data.tag || '').trim(), // etiqueta opcional (p. ej. "Lisboa 2026")
    createdAt: existing?.createdAt || ts,
    updatedAt: ts,
    deleted: false,
  };
  await run(['expenses', 'queue'], 'readwrite', (e, q) => {
    e.put(exp);
    q.put(queueEntry(exp.id, 'upsert'));
  });
  return exp;
}

// Borrado lógico: se marca deleted=true para que el borrado llegue a la hoja.
export async function deleteExpense(id) {
  const exp = await getExpense(id);
  if (!exp) return;
  exp.deleted = true;
  exp.updatedAt = now();
  await run(['expenses', 'queue'], 'readwrite', (e, q) => {
    e.put(exp);
    q.put(queueEntry(id, 'delete'));
  });
}

// Guarda varios gastos; si enqueue=true también los encola.
async function putExpenses(list, enqueue) {
  if (!list.length) return;
  await run(['expenses', 'queue'], 'readwrite', (e, q) => {
    for (const exp of list) {
      e.put(exp);
      if (enqueue) q.put(queueEntry(exp.id, exp.deleted ? 'delete' : 'upsert'));
    }
  });
}

// Fusiona gastos externos (hoja o CSV) por id, conservando el updatedAt más reciente.
// fromServer=true: lo que gana el remoto no se reenvía; lo local más nuevo o ausente en la hoja se encola.
export async function mergeExpenses(incoming, { fromServer }) {
  const local = new Map((await getAllExpenses()).map((e) => [e.id, e]));
  const toPut = [];
  const toQueue = [];
  let added = 0, updated = 0;
  const seen = new Set();
  for (const r of incoming) {
    seen.add(r.id);
    const l = local.get(r.id);
    if (!l) { toPut.push(r); added++; }
    else if (r.updatedAt > l.updatedAt) { toPut.push(r); updated++; }
    else if (fromServer && l.updatedAt > r.updatedAt) toQueue.push(l);
  }
  if (fromServer) {
    for (const l of local.values()) if (!seen.has(l.id)) toQueue.push(l);
  }
  await putExpenses(toPut, !fromServer);
  await putExpenses(toQueue, true);
  return { added, updated };
}

/* ---------- Cola de sincronización ---------- */
export const getQueue = () => run('queue', 'readonly', (s) => s.getAll());
export const queueCount = () => run('queue', 'readonly', (s) => s.count());

// Quita de la cola las entradas enviadas, salvo que hayan cambiado mientras tanto.
export const dequeue = (entries) => run('queue', 'readwrite', (q) => {
  for (const en of entries) {
    const r = q.get(en.id);
    r.onsuccess = () => {
      if (r.result && r.result.queuedAt === en.queuedAt) q.delete(en.id);
    };
  }
});

/* ---------- Categorías ---------- */
// Devuelve todas las categorías (gastos e ingresos) con su type.
export async function getCategories() {
  if (!(await getSetting('seeded', false))) {
    await run('categories', 'readwrite', (s) => {
      DEFAULT_CATEGORIES.forEach(([name, color], order) => s.put({ name, color, order, type: 'expense' }));
    });
    await setSetting('seeded', true);
  }
  // Categorías de ingreso: se crean una vez (también en instalaciones anteriores a los ingresos).
  if (!(await getSetting('seededIncome', false))) {
    const existing = new Set((await run('categories', 'readonly', (s) => s.getAll())).map((c) => c.name));
    await run('categories', 'readwrite', (s) => {
      DEFAULT_INCOME_CATEGORIES.forEach(([name, color], i) => {
        if (!existing.has(name)) s.put({ name, color, order: 1000 + i, type: 'income' });
      });
    });
    await setSetting('seededIncome', true);
  }
  const cats = await run('categories', 'readonly', (s) => s.getAll());
  return cats.map((c) => ({ ...c, type: typeOf(c) })).sort((a, b) => a.order - b.order);
}

export async function addCategory(name, color, type = 'expense') {
  const cats = await getCategories();
  const order = cats.reduce((m, c) => Math.max(m, c.order), -1) + 1;
  color = color || EXTRA_COLORS[cats.length % EXTRA_COLORS.length];
  await run('categories', 'readwrite', (s) => { s.put({ name, color, order, type }); });
}

export async function updateCategoryColor(name, color) {
  const cats = await getCategories();
  const cat = cats.find((c) => c.name === name);
  if (cat) await run('categories', 'readwrite', (s) => { s.put({ ...cat, color }); });
}

// Cambia la categoría de todos los movimientos activos de `from` a `to`.
async function moveExpenses(from, to) {
  const ts = now();
  const affected = (await getAllExpenses())
    .filter((e) => !e.deleted && e.category === from)
    .map((e) => ({ ...e, category: to, updatedAt: ts }));
  await putExpenses(affected, true);
  return affected.length;
}

export async function renameCategory(oldName, newName) {
  const cat = (await getCategories()).find((c) => c.name === oldName);
  if (!cat) return 0;
  await run('categories', 'readwrite', (s) => {
    s.delete(oldName);
    s.put({ ...cat, name: newName });
  });
  return moveExpenses(oldName, newName);
}

export async function deleteCategory(name, reassignTo) {
  const moved = reassignTo ? await moveExpenses(name, reassignTo) : 0;
  await run('categories', 'readwrite', (s) => { s.delete(name); });
  return moved;
}

// Crea las categorías que aparezcan en movimientos importados y no existan (con su tipo).
export async function ensureCategories(movements) {
  const existing = new Set((await getCategories()).map((c) => c.name));
  for (const m of movements) {
    if (m.category && !existing.has(m.category)) {
      await addCategory(m.category, null, typeOf(m));
      existing.add(m.category);
    }
  }
}
