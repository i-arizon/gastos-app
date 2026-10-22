// app.js — Controlador principal: navegación, formularios, listados, ajustes y service worker.
import * as db from './db.js';
import * as sync from './sync.js';
import { renderMonthly, renderAnnual } from './charts.js';
import { toCSV, parseCSV } from './csv.js';
import {
  fmtEUR, fmtDate, todayISO, currentYM, currentYear, shiftMonth, monthLabel, evalAmount, hasOperator,
  isISODate, escapeHTML as esc, normalizeText, sum, byDateDesc,
} from './utils.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  all: [],          // todos los gastos (incluidos borrados), para exportar
  expenses: [],     // gastos activos, ordenados por fecha desc
  categories: [],
  view: 'add',
  statsMode: 'month',
  catType: 'expense', // tipo de categorías mostrado en Ajustes
  month: currentYM(),
  year: currentYear(),
};

const colorOf = (name) => state.categories.find((c) => c.name === name)?.color || '#94a3b8';
const isIncome = (m) => m.type === 'income';
const expensesOnly = () => state.expenses.filter((m) => !isIncome(m));
const incomesOnly = () => state.expenses.filter(isIncome);
const catsOfType = (type) => state.categories.filter((c) => c.type === type);

/* ---------- Carga y render ---------- */
async function loadData() {
  state.all = await db.getAllExpenses();
  state.expenses = state.all.filter((e) => !e.deleted).sort(byDateDesc);
  state.categories = await db.getCategories();
  renderAll();
}

function renderAll() {
  renderCatGrid($('#add-form [data-cat-grid]'), undefined, formType($('#add-form')));
  renderFilterOptions();
  renderRecent();
  renderNameSuggestions();
  renderCurrentView();
}

function renderCurrentView() {
  if (state.view === 'list') renderList();
  if (state.view === 'stats') renderStats();
  if (state.view === 'settings') { renderCatSettings(); renderExportYears(); }
}

/* ---------- Navegación ---------- */
function showView(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#view-title').textContent = $(`#view-${view}`).dataset.title;
  window.scrollTo(0, 0);
  renderCurrentView();
  tryAutoUpdate();
}

/* ---------- Avisos ---------- */
let toastTimer;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = type; }, type === 'error' ? 4000 : 1800);
}

// Diálogo genérico. Devuelve true / valor introducido / null si se cancela.
function ask({ title, message = '', input = null, select = null, okText = 'Aceptar', danger = false }) {
  const dlg = $('#ask-dialog');
  const form = $('#ask-form');
  $('[data-title]', dlg).textContent = title;
  $('[data-message]', dlg).textContent = message;
  const body = $('[data-body]', dlg);
  body.innerHTML = '';
  let field = null;
  if (input) {
    field = document.createElement('input');
    field.type = 'text';
    field.value = input.value || '';
    field.placeholder = input.placeholder || '';
    field.maxLength = 40;
  } else if (select) {
    field = document.createElement('select');
    field.innerHTML = select.options.map((o) => `<option>${esc(o)}</option>`).join('');
  }
  if (field) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    wrap.append(field);
    body.append(wrap);
  }
  const ok = $('[data-ok]', dlg);
  ok.textContent = okText;
  ok.className = `btn ${danger ? 'danger' : 'primary'}`;

  return new Promise((resolve) => {
    const done = (value) => {
      form.onsubmit = null;
      $('[data-act="cancel"]', dlg).onclick = null;
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(value);
    };
    form.onsubmit = (ev) => { ev.preventDefault(); done(field ? field.value.trim() : true); };
    $('[data-act="cancel"]', dlg).onclick = () => done(null);
    dlg.onclose = () => done(null);
    dlg.showModal();
    if (input) field.focus();
  });
}

/* ---------- Formularios de gasto ---------- */
const USAGE_DAYS = 90;

// Categorías del tipo indicado, ordenadas por nº de usos en los últimos 90 días; a igualdad, el orden de Ajustes.
function categoriesByUsage(type) {
  const since = new Date(Date.now() - USAGE_DAYS * 864e5);
  const sinceISO = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`;
  const uses = {};
  for (const e of state.expenses) {
    if (e.date >= sinceISO) uses[e.category] = (uses[e.category] || 0) + 1;
  }
  return catsOfType(type).sort((a, b) => (uses[b.name] || 0) - (uses[a.name] || 0) || a.order - b.order);
}

function renderCatGrid(container, selected, type = 'expense') {
  if (selected === undefined) selected = $('input:checked', container)?.value;
  container.innerHTML = categoriesByUsage(type).map((c) => `
    <label class="cat-chip" style="--c:${c.color}">
      <input type="radio" name="category" value="${esc(c.name)}" ${c.name === selected ? 'checked' : ''}>
      <span>${esc(c.name)}</span>
    </label>`).join('');
}

function readForm(form) {
  return {
    name: form.elements.name.value.trim(),
    amount: evalAmount(form.elements.amount.value),
    date: form.elements.date.value,
    category: $('input[name="category"]:checked', form)?.value || '',
    tag: form.elements.tag.value.trim(),
    type: formType(form),
  };
}

/* ---------- Selector Gasto | Ingreso ---------- */
const formType = (form) => (form.elements.type.value === 'income' ? 'income' : 'expense');

// Pinta el formulario según el tipo: verde para ingresos, categorías del tipo y textos.
function applyType(form, selected) {
  const type = formType(form);
  const income = type === 'income';
  form.classList.toggle('is-income', income);
  const grid = $('[data-cat-grid]', form);
  if (selected === undefined) {
    // Al cambiar de tipo se quita la categoría elegida si es del otro tipo.
    const current = $('input:checked', grid)?.value;
    selected = catsOfType(type).some((c) => c.name === current) ? current : '';
  }
  renderCatGrid(grid, selected, type);
  const submit = $('[data-submit]', form);
  if (submit) submit.textContent = income ? 'Guardar ingreso' : 'Guardar gasto';
  const title = $('[data-edit-title]', form);
  if (title) title.textContent = income ? 'Editar ingreso' : 'Editar gasto';
  form.elements.name.placeholder = income ? 'Ej. Nómina' : (form.id === 'add-form' ? 'Ej. Mercadona' : '');
}

function setupTypeToggle(form) {
  form.addEventListener('change', (ev) => {
    if (ev.target.name !== 'type') return;
    $('fieldset', form).classList.remove('invalid');
    applyType(form);
  });
}

// Valida y marca los campos con error. Devuelve true si es válido.
function validate(form, data) {
  const errors = [];
  const mark = (el, bad) => el.classList.toggle('invalid', bad);
  mark(form.elements.name, !data.name);
  mark(form.elements.amount, !(data.amount > 0));
  mark(form.elements.date, !isISODate(data.date));
  $('fieldset', form).classList.toggle('invalid', !data.category);
  if (!data.name) errors.push('el concepto');
  if (!(data.amount > 0)) errors.push('un importe mayor que 0');
  if (!data.category) errors.push('la categoría');
  if (!isISODate(data.date)) errors.push('una fecha válida');
  const err = $('[data-error]', form);
  err.hidden = !errors.length;
  err.textContent = errors.length ? `Falta ${errors.join(', ')}.` : '';
  return !errors.length;
}

// Barra de operaciones bajo el importe (el teclado decimal del iPhone no tiene + − × ÷).
// Muestra el resultado mientras se escribe y lo deja como importe al salir del campo.
function setupCalculator(form) {
  const input = form.elements.amount;
  input.closest('.row2').insertAdjacentHTML('afterend', `
    <div class="calc-bar" hidden>
      ${['+', '−', '×', '÷'].map((op) => `<button type="button" class="btn" data-op="${op}" aria-label="${op}">${op}</button>`).join('')}
      <span class="calc-result" aria-live="polite"></span>
    </div>`);
  const bar = input.closest('.row2').nextElementSibling;
  const result = $('.calc-result', bar);

  const preview = () => {
    if (!hasOperator(input.value)) { result.textContent = ''; return; }
    const v = evalAmount(input.value);
    result.textContent = isNaN(v) ? '= …' : `= ${fmtEUR(v)}`;
  };
  input.addEventListener('input', preview);
  input.addEventListener('focus', () => { bar.hidden = false; preview(); });
  input.addEventListener('blur', () => {
    // Pequeña espera: al pulsar un operador el foco vuelve al campo.
    setTimeout(() => {
      if (document.activeElement === input) return;
      bar.hidden = true;
      const v = evalAmount(input.value);
      if (hasOperator(input.value) && !isNaN(v)) input.value = String(v).replace('.', ',');
    }, 200);
  });
  // preventDefault evita que el campo pierda el foco (y se cierre el teclado) al pulsar.
  bar.addEventListener('pointerdown', (ev) => { if (ev.target.closest('[data-op]')) ev.preventDefault(); });
  bar.addEventListener('click', (ev) => {
    const op = ev.target.closest('[data-op]')?.dataset.op;
    if (!op) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.setRangeText(op, start, end, 'end');
    input.focus();
    preview();
  });
}

// Pide confirmación y borra (desde el diálogo de edición o deslizando en la lista).
async function confirmDelete(id) {
  const exp = state.expenses.find((e) => e.id === id);
  if (!exp) return;
  const ok = await ask({
    title: '¿Eliminar gasto?',
    message: `${exp.name} · ${fmtEUR(exp.amount)} · ${fmtDate(exp.date)}`,
    okText: 'Eliminar', danger: true,
  });
  if (!ok) return;
  await db.deleteExpense(id);
  toast('Gasto eliminado');
  await afterChange();
}

function clearValidation(form) {
  $$('.invalid', form).forEach((el) => el.classList.remove('invalid'));
  $('[data-error]', form).hidden = true;
}

function resetAddForm() {
  const form = $('#add-form');
  form.elements.name.value = '';
  form.elements.amount.value = '';
  form.elements.tag.value = '';
  form.elements.date.value = todayISO();
  $$('input[name="category"]', form).forEach((r) => { r.checked = false; });
  // Tras guardar se vuelve a Gasto, que es lo habitual (los ingresos son pocos al mes).
  form.elements.type.value = 'expense';
  applyType(form, '');
  clearValidation(form);
}

function setupAddForm() {
  const form = $('#add-form');
  form.elements.date.value = todayISO();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = readForm(form);
    if (!validate(form, data)) return;
    // Reset y foco síncronos (dentro del gesto del usuario, para que iOS muestre el teclado).
    resetAddForm();
    form.elements.name.focus();
    try {
      await db.saveExpense(data);
      toast(`${data.type === 'income' ? 'Ingreso guardado · +' : 'Guardado · '}${fmtEUR(data.amount)}`);
      await loadData();
      await sync.refreshStatus();
      sync.syncNow();
    } catch (err) {
      toast(`Error al guardar: ${err.message}`, 'error');
    }
  });
  // Quita la marca de error al corregir un campo.
  form.addEventListener('input', (ev) => ev.target.classList.remove('invalid'));
  form.addEventListener('change', (ev) => {
    if (ev.target.name === 'category') $('fieldset', form).classList.remove('invalid');
  });
}

function setupEditDialog() {
  const dlg = $('#edit-dialog');
  const form = $('#edit-form');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = readForm(form);
    if (!validate(form, data)) return;
    await db.saveExpense({ ...data, id: form.dataset.id });
    dlg.close();
    toast('Gasto actualizado');
    await afterChange();
  });
  $('[data-act="cancel"]', form).addEventListener('click', () => dlg.close());
  $('[data-act="delete"]', form).addEventListener('click', () => {
    dlg.close();
    confirmDelete(form.dataset.id);
  });
  form.addEventListener('input', (ev) => ev.target.classList.remove('invalid'));
}

function openEdit(id) {
  const exp = state.expenses.find((e) => e.id === id);
  if (!exp) return;
  const form = $('#edit-form');
  form.dataset.id = id;
  form.elements.name.value = exp.name;
  form.elements.tag.value = exp.tag || '';
  form.elements.type.value = isIncome(exp) ? 'income' : 'expense';
  form.elements.amount.value = String(exp.amount).replace('.', ',');
  form.elements.date.value = exp.date;
  // Si la categoría ya no existe, se muestra igualmente para no perderla.
  const grid = $('[data-cat-grid]', form);
  applyType(form, exp.category);
  if (!catsOfType(formType(form)).some((c) => c.name === exp.category)) {
    grid.insertAdjacentHTML('beforeend', `<label class="cat-chip" style="--c:#94a3b8"><input type="radio" name="category" value="${esc(exp.category)}" checked><span>${esc(exp.category)}</span></label>`);
  }
  clearValidation(form);
  $('#edit-dialog').showModal();
}

async function afterChange() {
  await loadData();
  await sync.refreshStatus();
  sync.syncNow();
}

/* ---------- Listas ---------- */
// Cada fila lleva detrás los botones Editar/Eliminar, que aparecen al deslizar a la izquierda.
function expenseItem(e) {
  return `<li class="swipe">
    <div class="swipe-actions">
      <button type="button" class="swipe-edit" data-swipe="edit" tabindex="-1">Editar</button>
      <button type="button" class="swipe-delete" data-swipe="delete" tabindex="-1">Eliminar</button>
    </div>
    <button type="button" class="exp-item swipe-front" data-id="${esc(e.id)}">
    <span class="exp-dot" style="background:${colorOf(e.category)}"></span>
    <span class="exp-main"><span class="exp-name">${esc(e.name)}</span>
      <span class="exp-meta">${esc(e.category)} · ${fmtDate(e.date)}${e.tag ? ` <span class="tag-pill">${esc(e.tag)}</span>` : ''}</span></span>
    ${amountHTML(e)}</button></li>`;
}

// Los ingresos van en verde y con «+»; los gastos, sin signo, como siempre.
const amountHTML = (m) => (isIncome(m)
  ? `<span class="exp-amount amount-income">+${fmtEUR(m.amount)}</span>`
  : `<span class="exp-amount">${fmtEUR(m.amount)}</span>`);

/* ---------- Deslizar para ver acciones (gastos y categorías) ---------- */
// Estructura: <li class="swipe"><div class="swipe-actions">[data-swipe]…</div><… class="swipe-front">…</li>
let openRow = null;

const swipeWidth = (row) => $('.swipe-actions', row).offsetWidth; // ancho de los botones de detrás

function closeSwipe(row = openRow) {
  if (!row) return;
  $('.swipe-front', row).style.transform = '';
  row.classList.remove('open');
  if (row === openRow) openRow = null;
}

// onAction(acción, fila) se llama al pulsar uno de los botones que aparecen al deslizar.
function setupSwipe(container, onAction) {
  let row = null, startX = 0, startY = 0, base = 0, dx = 0, width = 0, dragging = false;

  container.addEventListener('pointerdown', (ev) => {
    const front = ev.target.closest('.swipe .swipe-front');
    if (!front || ev.button > 0) return;
    if (openRow && openRow !== front.parentElement) closeSwipe();
    row = front.parentElement;
    width = swipeWidth(row);
    startX = ev.clientX; startY = ev.clientY;
    base = row.classList.contains('open') ? -width : 0;
    dx = 0; dragging = false;
  });

  container.addEventListener('pointermove', (ev) => {
    if (!row) return;
    const mx = ev.clientX - startX, my = ev.clientY - startY;
    if (!dragging) {
      if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { row = null; return; } // es scroll vertical
      if (Math.abs(mx) < 10) return;
      dragging = true;
      row.classList.add('dragging');
    }
    dx = Math.max(-width - 40, Math.min(0, base + mx));
    $('.swipe-front', row).style.transform = `translateX(${dx}px)`;
  });

  const end = () => {
    if (!row) return;
    row.classList.remove('dragging');
    if (dragging) {
      // Se abre si se desliza más de un tercio; si no, vuelve a su sitio.
      if (dx < -width / 3) {
        $('.swipe-front', row).style.transform = `translateX(${-width}px)`;
        row.classList.add('open');
        openRow = row;
      } else closeSwipe(row);
      const swiped = row;
      swiped.dataset.justSwiped = '1'; // evita que el "click" de soltar abra la edición o el color
      setTimeout(() => { delete swiped.dataset.justSwiped; }, 350);
    }
    row = null;
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);

  container.addEventListener('click', (ev) => {
    const li = ev.target.closest('.swipe');
    if (!li) return;
    const action = ev.target.closest('[data-swipe]')?.dataset.swipe;
    if (action) {
      closeSwipe(li);
      onAction(action, li);
    } else if (li.dataset.justSwiped || li.classList.contains('open')) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (!li.dataset.justSwiped) closeSwipe(li); // tocar una fila abierta la cierra
    }
  }, true);
}

const onExpenseSwipe = (action, li) => {
  const id = $('.exp-item', li).dataset.id;
  if (action === 'edit') openEdit(id);
  else confirmDelete(id);
};

// Tocar fuera de una fila abierta la cierra.
document.addEventListener('pointerdown', (ev) => {
  if (openRow && !openRow.contains(ev.target)) closeSwipe();
});

function renderRecent() {
  const list = state.expenses.slice(0, 10);
  $('#recent-list').innerHTML = list.length
    ? list.map(expenseItem).join('')
    : '<li class="empty">Aún no hay movimientos. ¡Añade el primero!</li>';
}

// Etiquetas usadas, de la más reciente a la más antigua.
const allTags = () => [...new Set(state.expenses.filter((e) => e.tag).map((e) => e.tag))];

function renderNameSuggestions() {
  const names = [...new Set(state.expenses.slice(0, 300).map((e) => e.name))].slice(0, 60);
  $('#name-suggestions').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
  $('#tag-suggestions').innerHTML = allTags().slice(0, 30).map((t) => `<option value="${esc(t)}">`).join('');
}

function renderFilterOptions() {
  const sel = $('#filter-cat');
  const current = sel.value;
  // Categorías de gasto e ingreso en grupos separados (más las que solo existan en movimientos).
  const known = new Set(state.categories.map((c) => c.name));
  const orphans = [...new Set(state.expenses.map((e) => e.category))].filter((n) => !known.has(n));
  const opts = (list) => list.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.innerHTML = '<option value="">Todas las categorías</option>' +
    `<optgroup label="Gastos">${opts(catsOfType('expense').map((c) => c.name).concat(orphans))}</optgroup>` +
    `<optgroup label="Ingresos">${opts(catsOfType('income').map((c) => c.name))}</optgroup>`;
  const names = [...known, ...orphans];
  sel.value = names.includes(current) ? current : '';

  // El filtro de etiquetas solo aparece si se ha usado alguna.
  const tagSel = $('#filter-tag');
  const tags = allTags();
  const currentTag = tagSel.value;
  tagSel.innerHTML = '<option value="">Todas las etiquetas</option>' +
    tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  tagSel.value = tags.includes(currentTag) ? currentTag : '';
  tagSel.hidden = !tags.length;
}

function renderList() {
  const q = normalizeText($('#search').value.trim());
  const cat = $('#filter-cat').value;
  const tag = $('#filter-tag').value;
  const items = state.expenses.filter((e) =>
    (!cat || e.category === cat) && (!tag || e.tag === tag) &&
    (!q || normalizeText(`${e.name} ${e.category} ${e.tag || ''}`).includes(q)));

  const groups = new Map();
  for (const e of items) {
    const ym = e.date.slice(0, 7);
    if (!groups.has(ym)) groups.set(ym, []);
    groups.get(ym).push(e);
  }
  // Totales: gastos e ingresos por separado (el ingreso solo se muestra si hay alguno).
  const totals = (list) => {
    const inc = sum(list.filter(isIncome));
    const exp = sum(list.filter((m) => !isIncome(m)));
    return `<span class="amount-expense">${fmtEUR(exp)}</span>${inc ? ` <span class="amount-income">+${fmtEUR(inc)}</span>` : ''}`;
  };
  const inc = sum(items.filter(isIncome));
  $('#list-summary').innerHTML = `${items.length} ${items.length === 1 ? 'movimiento' : 'movimientos'} · Gastos ${fmtEUR(sum(items.filter((m) => !isIncome(m))))}` +
    (inc ? ` · <span class="amount-income">Ingresos +${fmtEUR(inc)}</span>` : '');
  $('#month-groups').innerHTML = groups.size
    ? [...groups].map(([ym, list]) => `
      <section class="month-group">
        <h3><span>${monthLabel(ym)}</span><span>${totals(list)}</span></h3>
        <ul class="expense-list card">${list.map(expenseItem).join('')}</ul>
      </section>`).join('')
    : `<p class="empty">${state.expenses.length ? 'No hay movimientos que coincidan.' : 'Aún no hay movimientos.'}</p>`;
}

/* ---------- Análisis ---------- */
function renderStats() {
  const mode = state.statsMode;
  $('#stats-month').hidden = mode !== 'month';
  $('#stats-year').hidden = mode !== 'year';
  $('#stats-tags').hidden = mode !== 'tags';
  $$('.segmented button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  if (mode === 'tags') return renderTagsTable();
  if (!window.Chart) toast('No se pudo cargar Chart.js (¿sin conexión la primera vez?)', 'error');
  // Los gráficos y tablas por categoría son solo de gastos; los ingresos van al resumen.
  const ctx = { expenses: expensesOnly(), incomes: incomesOnly(), categories: catsOfType('expense'), colorOf, onOpen: openEdit };
  if (mode === 'month') {
    $('#month-input').value = state.month;
    renderMonthly({ ...ctx, ym: state.month });
  } else {
    $('#year-label').textContent = state.year;
    renderAnnual({ ...ctx, year: state.year });
  }
}

// Una fila por etiqueta: total, nº de gastos, fechas y la categoría con más gasto.
function renderTagsTable() {
  const groups = new Map();
  for (const e of expensesOnly()) {
    if (!e.tag) continue;
    if (!groups.has(e.tag)) groups.set(e.tag, []);
    groups.get(e.tag).push(e);
  }
  const table = $('#tags-table');
  if (!groups.size) {
    table.innerHTML = '<tbody><tr><td class="muted">Aún no has usado etiquetas. Escribe una en el campo «Etiqueta» al apuntar un gasto, por ejemplo «Viaje Lisboa».</td></tr></tbody>';
    return;
  }
  // state.expenses va por fecha descendente: la primera etiqueta es la más reciente.
  table.innerHTML = `
    <thead><tr><th>Etiqueta</th><th>Total</th><th>Nº</th></tr></thead>
    <tbody>${[...groups].map(([tag, list]) => {
      const dates = list.map((e) => e.date).sort();
      const range = dates[0] === dates[dates.length - 1] ? fmtDate(dates[0]) : `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}`;
      const byCat = {};
      list.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + e.amount; });
      const [topCat, topAmount] = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
      return `<tr class="tag-row" data-tag="${esc(tag)}">
        <td><span class="tag-pill">${esc(tag)}</span><div class="muted small">${range} · más gasto en ${esc(topCat)} (${fmtEUR(topAmount)})</div></td>
        <td>${fmtEUR(sum(list))}</td><td>${list.length}</td></tr>`;
    }).join('')}</tbody>`;
}

// Abre la pestaña Gastos filtrada por esa etiqueta.
function showTag(tag) {
  $('#search').value = '';
  $('#filter-cat').value = '';
  $('#filter-tag').value = tag;
  showView('list');
}

function setupStats() {
  $('#tags-table').addEventListener('click', (ev) => {
    const row = ev.target.closest('.tag-row');
    if (row) showTag(row.dataset.tag);
  });
  $$('.segmented button').forEach((b) => b.addEventListener('click', () => {
    state.statsMode = b.dataset.mode;
    renderStats();
  }));
  $$('[data-month-step]').forEach((b) => b.addEventListener('click', () => {
    state.month = shiftMonth(state.month, Number(b.dataset.monthStep));
    renderStats();
  }));
  $('#month-input').addEventListener('change', (ev) => {
    if (/^\d{4}-\d{2}$/.test(ev.target.value)) { state.month = ev.target.value; renderStats(); }
  });
  $$('[data-year-step]').forEach((b) => b.addEventListener('click', () => {
    state.year += Number(b.dataset.yearStep);
    renderStats();
  }));
  $('#m-top5').addEventListener('click', onListClick);
}

/* ---------- Ajustes: sincronización ---------- */
const STATUS_TEXT = {
  idle: () => '…',
  synced: () => 'Sincronizado',
  syncing: () => 'Sincronizando…',
  pending: (s) => `${s.pending} pendiente${s.pending === 1 ? '' : 's'}`,
  error: () => 'Error de sync',
  unconfigured: (s) => (s.pending ? `Sin sync · ${s.pending}` : 'Sin sync'),
};

function renderSyncStatus(s) {
  const pill = $('#sync-indicator');
  pill.dataset.status = s.status;
  $('.label', pill).textContent = STATUS_TEXT[s.status](s);

  const box = $('#sync-status-text');
  const last = s.lastSync ? new Date(s.lastSync).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca';
  const lines = {
    idle: 'Comprobando…',
    synced: 'Todo sincronizado.',
    syncing: `Enviando ${s.pending} cambio(s)…`,
    pending: `${s.pending} cambio(s) pendientes de enviar.${s.message ? ` ${s.message}.` : ''}`,
    error: `Error: ${s.message}. ${s.pending} cambio(s) pendientes; se reintentará automáticamente.`,
    unconfigured: `Sincronización sin configurar${s.pending ? ` · ${s.pending} cambio(s) guardados solo en este iPhone` : ''}.`,
  };
  box.textContent = `${lines[s.status]} Última sincronización: ${last}.`;
  box.classList.toggle('error', s.status === 'error');
  renderScriptWarning(s);
}

// Aviso de script desactualizado: en Ajustes, con un punto en la pestaña y un aviso al detectarlo.
let scriptWarned = false;
function renderScriptWarning(s) {
  const outdated = sync.isScriptOutdated(s);
  const box = $('#script-warning');
  box.hidden = !outdated;
  $('.tabbar [data-view="settings"]').classList.toggle('alert', outdated);
  if (!outdated) return;
  $('[data-script-v]', box).textContent = s.scriptVersion;
  $('[data-script-req]', box).textContent = sync.REQUIRED_SCRIPT_VERSION;
  if (!scriptWarned) {
    scriptWarned = true;
    toast('Actualiza el script de Google (mira Ajustes)', 'error');
  }
}

async function setupSyncSettings() {
  const form = $('#sync-form');
  form.elements.url.value = await db.getSetting('scriptUrl', '');
  form.elements.token.value = await db.getSetting('token', '');

  // Guarda URL y token en IndexedDB (nunca en el código: el repositorio es público).
  const save = async () => {
    const url = form.elements.url.value.trim();
    const token = form.elements.token.value.trim();
    if (url && !/^https:\/\/\S+$/.test(url)) {
      toast('La URL debe empezar por https://', 'error');
      return false;
    }
    await db.setSetting('scriptUrl', url);
    await db.setSetting('token', token);
    return true;
  };

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!(await save())) return;
    toast('Ajustes guardados');
    sync.syncNow();
    sync.ping().catch(() => {}); // comprueba la versión del script nuevo
  });

  $('#btn-test').addEventListener('click', async () => {
    if (!(await save())) return;
    try {
      const r = await sync.ping();
      toast(`Conexión correcta · ${r.count} filas en la hoja`);
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#btn-sync').addEventListener('click', async () => {
    if (!(await sync.isConfigured())) return toast('Configura primero la URL y el token', 'error');
    await sync.syncNow();
    const s = sync.getState();
    toast(s.status === 'error' ? s.message : 'Sincronización completada', s.status === 'error' ? 'error' : '');
  });

  $('#btn-restore').addEventListener('click', async () => {
    const ok = await ask({
      title: 'Restaurar desde Google Sheets',
      message: 'Se descargarán todos los gastos de la hoja y se fusionarán con los de este dispositivo (gana la versión más reciente de cada gasto). No se borra nada local.',
      okText: 'Restaurar',
    });
    if (!ok) return;
    try {
      const r = await sync.restore();
      await loadData();
      toast(`Restaurado: ${r.added} nuevos, ${r.updated} actualizados`);
    } catch (err) { toast(err.message, 'error'); }
  });

  sync.events.addEventListener('change', (ev) => renderSyncStatus(ev.detail));
  $('#sync-indicator').addEventListener('click', () => showView('settings'));
}

/* ---------- Ajustes: categorías ---------- */
function renderCatSettings() {
  const counts = {};
  state.expenses.forEach((e) => { counts[e.category] = (counts[e.category] || 0) + 1; });
  // Renombrar/Eliminar quedan detrás de cada fila y aparecen al deslizar a la izquierda.
  $$('#cat-type button').forEach((b) => b.classList.toggle('active', b.dataset.catType === state.catType));
  $('#cat-list').innerHTML = catsOfType(state.catType).map((c) => `
    <li class="swipe" data-name="${esc(c.name)}">
      <div class="swipe-actions">
        <button type="button" class="swipe-edit" data-swipe="rename" tabindex="-1">Renombrar</button>
        <button type="button" class="swipe-delete" data-swipe="delete" tabindex="-1">Eliminar</button>
      </div>
      <div class="cat-row swipe-front">
        <input type="color" value="${c.color}" data-act="color" aria-label="Color de ${esc(c.name)}">
        <span class="cat-name">${esc(c.name)}</span>
        <span class="count">${counts[c.name] || 0} ${c.type === 'income' ? 'ingreso' : 'gasto'}${counts[c.name] === 1 ? '' : 's'}</span>
      </div>
    </li>`).join('');
}

const nameTaken = (name, except) =>
  state.categories.some((c) => c.name !== except && normalizeText(c.name) === normalizeText(name));

async function renameCategoryFlow(name) {
  const newName = await ask({ title: 'Renombrar categoría', input: { value: name }, okText: 'Renombrar' });
  if (!newName || newName === name) return;
  if (nameTaken(newName, name)) return toast('Ya existe una categoría con ese nombre', 'error');
  const moved = await db.renameCategory(name, newName);
  toast(`Categoría renombrada${moved ? ` · ${moved} gastos actualizados` : ''}`);
  await afterChange();
}

async function deleteCategoryFlow(name) {
  const type = state.categories.find((c) => c.name === name)?.type || 'expense';
  const sameType = catsOfType(type);
  if (sameType.length <= 1) return toast(`Debe quedar al menos una categoría de ${type === 'income' ? 'ingreso' : 'gasto'}`, 'error');
  const count = state.expenses.filter((e) => e.category === name).length;
  let target = null;
  if (count) {
    target = await ask({
      title: `Eliminar «${name}»`,
      message: `Tiene ${count} movimiento(s). ¿A qué categoría quieres moverlos?`,
      select: { options: sameType.filter((c) => c.name !== name).map((c) => c.name) },
      okText: 'Mover y eliminar', danger: true,
    });
    if (!target) return;
  } else if (!(await ask({ title: `¿Eliminar «${name}»?`, okText: 'Eliminar', danger: true }))) {
    return;
  }
  await db.deleteCategory(name, target);
  toast('Categoría eliminada');
  await afterChange();
}

function setupCategorySettings() {
  const list = $('#cat-list');
  list.addEventListener('change', async (ev) => {
    if (ev.target.dataset.act !== 'color') return;
    await db.updateCategoryColor(ev.target.closest('.swipe').dataset.name, ev.target.value);
    await loadData();
  });

  $$('#cat-type button').forEach((b) => b.addEventListener('click', () => {
    state.catType = b.dataset.catType;
    renderCatSettings();
  }));

  setupSwipe(list, (action, li) => {
    if (action === 'rename') renameCategoryFlow(li.dataset.name);
    else deleteCategoryFlow(li.dataset.name);
  });

  $('#cat-add-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const name = form.elements.name.value.trim();
    if (!name) return toast('Escribe un nombre', 'error');
    if (nameTaken(name)) return toast('Ya existe una categoría con ese nombre', 'error');
    await db.addCategory(name, form.elements.color.value, state.catType);
    form.elements.name.value = '';
    toast('Categoría añadida');
    await loadData();
  });
}

/* ---------- Ajustes: CSV ---------- */
function renderExportYears() {
  const sel = $('#export-year');
  const current = sel.value;
  const years = [...new Set([currentYear(), ...state.expenses.map((e) => Number(e.date.slice(0, 4)))])].sort((a, b) => b - a);
  sel.innerHTML = years.map((y) => `<option>${y}</option>`).join('');
  if (years.includes(Number(current))) sel.value = current;
  if (!$('#export-month').value) $('#export-month').value = currentYM();
}

// En iOS se usa la hoja de compartir (permite guardar en Archivos); si no, descarga normal.
async function shareOrDownload(text, filename) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const file = new File([blob], filename, { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function setupBackup() {
  const scope = $('#export-scope');
  scope.addEventListener('change', () => {
    $('#export-month-field').hidden = scope.value !== 'month';
    $('#export-year-field').hidden = scope.value !== 'year';
  });

  $('#btn-export').addEventListener('click', () => {
    let list = [...state.expenses].sort((a, b) => a.date.localeCompare(b.date));
    let suffix = 'todos';
    if (scope.value === 'month') {
      suffix = $('#export-month').value || currentYM();
      list = list.filter((e) => e.date.startsWith(suffix));
    } else if (scope.value === 'year') {
      suffix = $('#export-year').value;
      list = list.filter((e) => e.date.startsWith(`${suffix}-`));
    }
    if (!list.length) return toast('No hay gastos en ese periodo', 'error');
    shareOrDownload(toCSV(list), `gastos-${suffix}.csv`);
  });

  $('#import-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const { records, errors } = parseCSV(await file.text());
      if (!records.length) return toast('No se encontraron gastos válidos en el archivo', 'error');
      const ok = await ask({
        title: 'Importar CSV',
        message: `${records.length} gasto(s) válidos${errors ? ` y ${errors} fila(s) con errores que se ignorarán` : ''}. Se fusionarán por id con los existentes.`,
        okText: 'Importar',
      });
      if (!ok) return;
      await db.ensureCategories(records);
      const r = await db.mergeExpenses(records, { fromServer: false });
      toast(`Importado: ${r.added} nuevos, ${r.updated} actualizados`);
      await afterChange();
    } catch (err) { toast(`Error al importar: ${err.message}`, 'error'); }
  });
}

/* ---------- Service worker y actualizaciones ---------- */
// Solo se actualiza sola si no hay nada a medio escribir (formulario vacío, sin diálogos ni campo enfocado).
function isIdle() {
  const form = $('#add-form');
  return !form.elements.name.value && !form.elements.amount.value &&
    !$$('dialog').some((d) => d.open) &&
    !document.activeElement?.matches('input, select, textarea');
}

let swReg = null;
let updateRequested = false;
function applyUpdate() {
  if (!swReg?.waiting) return;
  updateRequested = true;
  try { sessionStorage.setItem('justUpdated', '1'); } catch {}
  swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
}

// Llamado al detectar versión nueva, al cambiar de pestaña y al salir de la app.
function tryAutoUpdate() {
  if (swReg?.waiting && navigator.serviceWorker.controller && isIdle()) applyUpdate();
}

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Recarga solo cuando la app ha aplicado una versión nueva (no en la primera instalación).
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || !updateRequested) return;
    refreshing = true;
    location.reload();
  });

  navigator.serviceWorker.register('sw.js').then((reg) => {
    swReg = reg;
    // Si hay algo a medio escribir se muestra el aviso; se aplicará en cuanto quede libre.
    const onWaiting = () => {
      if (!navigator.serviceWorker.controller) return;
      $('#btn-update').onclick = applyUpdate;
      $('#update-banner').hidden = false;
      tryAutoUpdate();
    };
    if (reg.waiting) onWaiting();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed') onWaiting();
      });
    });
    // Busca versiones nuevas al volver a la app y cada 30 minutos; al salir, aplica la pendiente.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
      else tryAutoUpdate();
    });
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  }).catch((err) => console.warn('SW no registrado:', err));

  // Muestra la versión publicada (definida en sw.js) y avisa si se acaba de actualizar.
  navigator.serviceWorker.ready.then((reg) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (ev) => {
      $('#app-version').textContent = ev.data;
      let updated = false;
      try { updated = sessionStorage.getItem('justUpdated') === '1'; sessionStorage.removeItem('justUpdated'); } catch {}
      if (updated) toast(`App actualizada · versión ${ev.data}`);
    };
    reg.active?.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
  });
}

/* ---------- Tirar hacia abajo para sincronizar ---------- */
const PULL_TRIGGER = 64; // px que hay que bajar para que se active

// Envía lo pendiente y descarga los cambios de la hoja.
async function pullSync() {
  if (!(await sync.isConfigured())) return toast('Configura la sincronización en Ajustes', 'error');
  try {
    await sync.syncNow();
    if (sync.getState().status === 'error') throw new Error(sync.getState().message);
    const r = await sync.restore();
    await loadData();
    const changes = r.added + r.updated;
    toast(changes ? `Sincronizado · ${changes} cambio${changes === 1 ? '' : 's'} descargado${changes === 1 ? '' : 's'}` : 'Todo al día');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function setupPullToSync() {
  const ptr = $('#ptr');
  const text = $('.ptr-text', ptr);
  let startY = null, startX = 0, pull = 0, pulling = false, busy = false;

  const setPull = (px) => {
    pull = px;
    ptr.style.height = `${px}px`;
    ptr.classList.toggle('ready', px >= PULL_TRIGGER);
    text.textContent = px >= PULL_TRIGGER ? 'Suelta para sincronizar' : 'Desliza para sincronizar';
  };

  document.addEventListener('touchstart', (ev) => {
    startY = null;
    if (busy || window.scrollY > 0 || ev.touches.length > 1 || $$('dialog').some((d) => d.open)) return;
    startY = ev.touches[0].clientY;
    startX = ev.touches[0].clientX;
    pulling = false;
  }, { passive: true });

  // No pasivo: hay que poder cancelar el desplazamiento mientras se tira.
  document.addEventListener('touchmove', (ev) => {
    if (startY === null) return;
    const dy = ev.touches[0].clientY - startY;
    const dx = ev.touches[0].clientX - startX;
    if (!pulling) {
      if (dy > 10 && dy > Math.abs(dx) && window.scrollY <= 0) {
        pulling = true;
        ptr.classList.add('dragging');
      } else if (Math.abs(dx) > 10 || dy < -10) { startY = null; return; } else return;
    }
    if (ev.cancelable) ev.preventDefault();
    setPull(Math.min(Math.max(0, dy - 10) * 0.5, 96)); // resistencia, como en iOS
  }, { passive: false });

  document.addEventListener('touchend', async () => {
    if (startY === null || !pulling) { startY = null; return; }
    startY = null;
    ptr.classList.remove('dragging');
    if (pull < PULL_TRIGGER) return setPull(0);
    busy = true;
    ptr.classList.add('busy');
    setPull(48);
    text.textContent = 'Sincronizando…';
    await pullSync();
    ptr.classList.remove('busy');
    busy = false;
    setPull(0);
  });
}

/* ---------- Inicio ---------- */
function onListClick(ev) {
  const item = ev.target.closest('.exp-item');
  if (item) openEdit(item.dataset.id);
}

async function init() {
  // Sin un listener de touchstart, Safari en iOS no aplica :active y los botones no reaccionan al tocar.
  document.addEventListener('touchstart', () => {}, { passive: true });
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#recent-list').addEventListener('click', onListClick);
  $('#month-groups').addEventListener('click', onListClick);
  $('#search').addEventListener('input', renderList);
  $('#filter-cat').addEventListener('change', renderList);
  $('#filter-tag').addEventListener('change', renderList);

  setupSwipe($('#recent-list'), onExpenseSwipe);
  setupSwipe($('#month-groups'), onExpenseSwipe);
  setupPullToSync();

  setupAddForm();
  setupCalculator($('#add-form'));
  setupTypeToggle($('#add-form'));
  setupEditDialog();
  setupCalculator($('#edit-form'));
  setupTypeToggle($('#edit-form'));
  setupStats();
  setupCategorySettings();
  setupBackup();
  await setupSyncSettings();
  await loadData();

  // Redibuja los gráficos al cambiar entre modo claro/oscuro.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.view === 'stats') renderStats();
  });

  // Si la app queda abierta pasada la medianoche, la fecha por defecto pasa a hoy.
  document.addEventListener('visibilitychange', () => {
    const form = $('#add-form');
    if (document.visibilityState === 'visible' && !form.elements.name.value && !form.elements.amount.value) {
      form.elements.date.value = todayISO();
    }
  });

  sync.startAutoSync();
  setupServiceWorker();

  // Pide que el navegador no borre los datos locales por falta de espacio o de uso.
  navigator.storage?.persist?.().catch(() => {});
}

init().catch((err) => {
  console.error(err);
  toast(`Error al iniciar: ${err.message}`, 'error');
});
