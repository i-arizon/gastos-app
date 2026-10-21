// charts.js — Cálculos y gráficos de la pestaña Análisis (Chart.js cargado como global UMD).
import {
  fmtEUR, fmtNum, fmtPct, fmtSigned, fmtDate, MONTHS, MONTHS_SHORT, monthLabel, shiftMonth,
  daysInMonth, currentYM, currentYear, todayISO, escapeHTML as esc, sum,
} from './utils.js';

const charts = {};
let evoSelected = null; // categorías elegidas en "Evolución" (se conserva entre renders)

const $ = (id) => document.getElementById(id);

function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return { text: v('--text-2'), grid: v('--border'), accent: v('--accent'), card: v('--card') };
}

// Destruye el gráfico anterior del mismo canvas y crea el nuevo.
function draw(id, config) {
  charts[id]?.destroy();
  delete charts[id];
  const canvas = $(id);
  if (!window.Chart || !canvas) return;
  const t = theme();
  Chart.defaults.color = t.text;
  Chart.defaults.borderColor = t.grid;
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, system-ui, sans-serif';
  charts[id] = new Chart(canvas, config);
}

const axisEUR = {
  beginAtZero: true,
  ticks: { callback: (v) => fmtEUR(v, 0), maxTicksLimit: 6 },
};
const tooltipEUR = {
  callbacks: {
    label: (ctx) => `${ctx.dataset.label || ctx.label}: ${fmtEUR(ctx.parsed.y ?? ctx.parsed)}`,
  },
};

function aggregateByCategory(list) {
  const map = new Map();
  for (const e of list) {
    const row = map.get(e.category) || { name: e.category, total: 0, count: 0 };
    row.total += e.amount;
    row.count++;
    map.set(e.category, row);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function kpi(label, value, sub = '', wide = false) {
  return `<div class="kpi${wide ? ' wide' : ''}"><div class="k-label">${label}</div>
    <div class="k-value">${value}</div>${sub ? `<div class="k-sub">${sub}</div>` : ''}</div>`;
}

const swatch = (color) => `<span class="swatch" style="background:${color}"></span>`;

/* ======================= Vista mensual ======================= */
export function renderMonthly({ expenses, colorOf, ym }) {
  const prevYM = shiftMonth(ym, -1);
  const cur = expenses.filter((e) => e.date.startsWith(ym));
  const prev = expenses.filter((e) => e.date.startsWith(prevYM));
  const total = sum(cur);
  const prevTotal = sum(prev);

  // KPIs y variación vs mes anterior
  const diff = total - prevTotal;
  const pct = prevTotal ? (diff / prevTotal) * 100 : null;
  const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
  const variation = prevTotal || total
    ? `<span class="${cls}">${fmtSigned(diff)}${pct !== null ? ` (${fmtSigned(pct, fmtPct)})` : ''}</span>`
    : '—';
  const days = ym === currentYM() ? Number(todayISO().slice(8)) : daysInMonth(ym);
  $('m-kpis').innerHTML =
    kpi(`Total ${monthLabel(ym).toLowerCase()}`, fmtEUR(total), `${cur.length} gasto${cur.length === 1 ? '' : 's'}`, true) +
    kpi(`vs ${monthLabel(prevYM).toLowerCase()}`, variation, `Mes anterior: ${fmtEUR(prevTotal)}`) +
    kpi('Media diaria', fmtEUR(ym > currentYM() ? 0 : total / days), `Sobre ${days} días`);

  // Donut + ranking por categoría
  const byCat = aggregateByCategory(cur);
  const donutBox = $('m-donut-box');
  if (!byCat.length) {
    charts['ch-donut']?.destroy();
    delete charts['ch-donut'];
    donutBox.innerHTML = '<div class="chart-empty">No hay gastos este mes</div>';
  } else {
    if (!$('ch-donut')) donutBox.innerHTML = '<canvas id="ch-donut"></canvas>';
    draw('ch-donut', {
      type: 'doughnut',
      data: {
        labels: byCat.map((c) => c.name),
        datasets: [{
          data: byCat.map((c) => c.total),
          backgroundColor: byCat.map((c) => colorOf(c.name)),
          borderColor: theme().card,
          borderWidth: 2,
        }],
      },
      options: {
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: { legend: { display: false }, tooltip: tooltipEUR },
      },
    });
  }
  $('m-cat-table').innerHTML = byCat.length ? `
    <thead><tr><th>Categoría</th><th>Importe</th><th>%</th><th>Nº</th></tr></thead>
    <tbody>${byCat.map((c) => `<tr><td>${swatch(colorOf(c.name))}${esc(c.name)}</td>
      <td>${fmtEUR(c.total)}</td><td>${fmtPct((c.total / total) * 100)}</td><td>${c.count}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td>${fmtEUR(total)}</td><td>100 %</td><td>${cur.length}</td></tr></tfoot>` : '';

  // Top 5
  const top = [...cur].sort((a, b) => b.amount - a.amount).slice(0, 5);
  $('m-top5').innerHTML = top.length ? top.map((e) => `<li><button type="button" class="exp-item" data-id="${esc(e.id)}">
      <span class="exp-main"><span class="exp-name">${esc(e.name)}</span>
      <span class="exp-meta">${swatch(colorOf(e.category))}${esc(e.category)} · ${fmtDate(e.date)}</span></span>
      <span class="exp-amount">${fmtEUR(e.amount)}</span></button></li>`).join('')
    : '<li class="empty">Sin gastos</li>';

  // Acumulado diario (mes actual hasta hoy) comparado con el mes anterior
  const cumulative = (list, month, limit) => {
    const perDay = new Array(daysInMonth(month)).fill(0);
    list.forEach((e) => { perDay[Number(e.date.slice(8)) - 1] += e.amount; });
    let acc = 0;
    return perDay.map((v, i) => (i < limit ? Math.round((acc += v) * 100) / 100 : null));
  };
  const n = daysInMonth(ym);
  const limit = ym === currentYM() ? days : ym > currentYM() ? 0 : n;
  const t = theme();
  draw('ch-cumulative', {
    type: 'line',
    data: {
      labels: Array.from({ length: n }, (_, i) => i + 1),
      datasets: [
        {
          label: monthLabel(ym), data: cumulative(cur, ym, limit),
          borderColor: t.accent, backgroundColor: t.accent + '22', fill: true,
          tension: 0.25, pointRadius: 0, borderWidth: 2.5,
        },
        {
          label: monthLabel(prevYM), data: cumulative(prev, prevYM, n).slice(0, n),
          borderColor: t.text, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, tension: 0.25,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { y: axisEUR, x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } } },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, usePointStyle: true } },
        tooltip: { ...tooltipEUR, callbacks: { ...tooltipEUR.callbacks, title: (items) => `Día ${items[0].label}` } },
      },
    },
  });
}

/* ======================= Vista anual ======================= */
export function renderAnnual({ expenses, categories, colorOf, year }) {
  const list = expenses.filter((e) => e.date.startsWith(`${year}-`));
  const total = sum(list);
  // Meses transcurridos para la media: el año en curso cuenta hasta el mes actual.
  const months = year === currentYear() ? new Date().getMonth() + 1 : 12;
  const avg = total / months;

  const monthly = new Array(12).fill(0);
  const matrix = new Map(); // categoría -> [12]
  for (const e of list) {
    const m = Number(e.date.slice(5, 7)) - 1;
    monthly[m] += e.amount;
    if (!matrix.has(e.category)) matrix.set(e.category, new Array(12).fill(0));
    matrix.get(e.category)[m] += e.amount;
  }
  const byCat = aggregateByCategory(list);
  const maxMonth = monthly.indexOf(Math.max(...monthly));

  $('y-kpis').innerHTML =
    kpi(`Total ${year}`, fmtEUR(total), `${list.length} gastos`, true) +
    kpi('Media mensual', fmtEUR(avg), `Sobre ${months} ${months === 1 ? 'mes' : 'meses'}`) +
    kpi('Mes con más gasto', total ? MONTHS[maxMonth] : '—', total ? fmtEUR(monthly[maxMonth]) : '');

  const t = theme();
  const xMonths = { grid: { display: false } };

  // Barras: total mensual
  draw('ch-year-bar', {
    type: 'bar',
    data: { labels: MONTHS_SHORT, datasets: [{ label: 'Total', data: monthly, backgroundColor: t.accent, borderRadius: 6 }] },
    options: {
      maintainAspectRatio: false,
      scales: { y: axisEUR, x: xMonths },
      plugins: { legend: { display: false }, tooltip: tooltipEUR },
    },
  });

  // Barras apiladas por categoría
  draw('ch-year-stacked', {
    type: 'bar',
    data: {
      labels: MONTHS_SHORT,
      datasets: byCat.map((c) => ({
        label: c.name, data: matrix.get(c.name), backgroundColor: colorOf(c.name), stack: 'total',
      })),
    },
    options: {
      maintainAspectRatio: false,
      scales: { y: { ...axisEUR, stacked: true }, x: { ...xMonths, stacked: true } },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true, font: { size: 11 } } },
        tooltip: { ...tooltipEUR, filter: (item) => item.parsed.y > 0 },
      },
    },
  });

  // Ranking anual por categoría
  $('y-cat-table').innerHTML = byCat.length ? `
    <thead><tr><th>Categoría</th><th>Importe</th><th>%</th><th>Media/mes</th></tr></thead>
    <tbody>${byCat.map((c) => `<tr><td>${swatch(colorOf(c.name))}${esc(c.name)}</td>
      <td>${fmtEUR(c.total)}</td><td>${fmtPct((c.total / total) * 100)}</td><td>${fmtEUR(c.total / months)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td>${fmtEUR(total)}</td><td>100 %</td><td>${fmtEUR(avg)}</td></tr></tfoot>`
    : '<tbody><tr><td class="muted">No hay gastos este año</td></tr></tbody>';

  // Evolución: selector de categorías (por defecto las 3 con más gasto)
  const options = [...new Set([...byCat.map((c) => c.name), ...categories.map((c) => c.name)])];
  if (!evoSelected) evoSelected = new Set(byCat.slice(0, 3).map((c) => c.name));
  const chips = $('evo-chips');
  chips.innerHTML = options.map((name) => `<button type="button" class="chip${evoSelected.has(name) ? ' on' : ''}"
    data-cat="${esc(name)}" style="--c:${colorOf(name)}" aria-pressed="${evoSelected.has(name)}">${esc(name)}</button>`).join('');
  chips.onclick = (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    const name = chip.dataset.cat;
    evoSelected.has(name) ? evoSelected.delete(name) : evoSelected.add(name);
    chip.classList.toggle('on');
    chip.setAttribute('aria-pressed', evoSelected.has(name));
    drawEvolution();
  };
  const drawEvolution = () => draw('ch-evolution', {
    type: 'line',
    data: {
      labels: MONTHS_SHORT,
      datasets: options.filter((n) => evoSelected.has(n)).map((name) => ({
        label: name,
        data: matrix.get(name) || new Array(12).fill(0),
        borderColor: colorOf(name), backgroundColor: colorOf(name),
        tension: 0.25, pointRadius: 3, borderWidth: 2.5,
      })),
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { y: axisEUR, x: xMonths },
      plugins: { legend: { display: false }, tooltip: tooltipEUR },
    },
  });
  drawEvolution();

  // Matriz mes × categoría
  const cell = (v, cls = '') => `<td class="${v ? cls : `zero ${cls}`}">${v ? fmtNum(v, 0) : '–'}</td>`;
  $('y-matrix').innerHTML = byCat.length ? `
    <thead><tr><th>Categoría</th>${MONTHS_SHORT.map((m) => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead>
    <tbody>${byCat.map((c) => `<tr><td>${swatch(colorOf(c.name))}${esc(c.name)}</td>
      ${matrix.get(c.name).map((v) => cell(v)).join('')}${cell(c.total, 'total-col')}</tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td>${monthly.map((v) => cell(v)).join('')}${cell(total, 'total-col')}</tr></tfoot>`
    : '<tbody><tr><td class="muted">No hay gastos este año</td></tr></tbody>';
}
