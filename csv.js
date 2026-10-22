// csv.js — Exportación/importación CSV (separador ";" y UTF-8 con BOM para Excel en español).
import { fmtDate, isISODate, normalizeText, parseAmount, uuid } from './utils.js';

const HEADER = ['id', 'tipo', 'fecha', 'nombre', 'importe', 'categoria', 'etiqueta', 'creado', 'actualizado'];

function cell(v) {
  const s = String(v ?? '');
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(list) {
  const lines = [HEADER.join(';')];
  for (const e of list) {
    lines.push([e.id, e.type === 'income' ? 'ingreso' : 'gasto', fmtDate(e.date), e.name, e.amount.toFixed(2).replace('.', ','),
      e.category, e.tag || '', e.createdAt, e.updatedAt].map(cell).join(';'));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// Parser CSV con comillas; detecta ";" o "," como separador.
function parseRows(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.split(';').length >= firstLine.split(',').length) ? ';' : ',';
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const ALIASES = {
  id: ['id'],
  type: ['tipo', 'type'],
  date: ['fecha', 'date'],
  name: ['nombre', 'name', 'concepto'],
  amount: ['importe', 'amount', 'cantidad'],
  category: ['categoria', 'category'],
  tag: ['etiqueta', 'tag'],
  createdAt: ['creado', 'createdat'],
  updatedAt: ['actualizado', 'updatedat'],
};

// Acepta DD/MM/YYYY, D/M/YYYY o YYYY-MM-DD.
function parseDate(s) {
  s = String(s).trim();
  if (isISODate(s.slice(0, 10))) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isISODate(iso) ? iso : null;
}

// Devuelve { records, errors } con registros listos para fusionar.
export function parseCSV(text) {
  const rows = parseRows(text);
  if (rows.length < 2) return { records: [], errors: 0 };
  const header = rows[0].map((h) => normalizeText(h.trim()));
  const col = {};
  for (const [key, names] of Object.entries(ALIASES)) col[key] = header.findIndex((h) => names.includes(h));
  if (col.date < 0 || col.name < 0 || col.amount < 0) throw new Error('Faltan columnas: fecha, nombre e importe');

  const ts = new Date().toISOString();
  const records = [];
  let errors = 0;
  for (const r of rows.slice(1)) {
    const get = (k) => (col[k] >= 0 ? (r[col[k]] ?? '').trim() : '');
    const date = parseDate(get('date'));
    const amount = parseAmount(get('amount'));
    const name = get('name');
    if (!date || !name || !(amount > 0)) { errors++; continue; }
    records.push({
      id: get('id') || uuid(),
      date, name, amount,
      type: /^(ingreso|income)$/i.test(get('type')) ? 'income' : 'expense',
      category: get('category') || 'Otros',
      tag: get('tag'),
      createdAt: get('createdAt') || ts,
      updatedAt: get('updatedAt') || ts,
      deleted: false,
    });
  }
  return { records, errors };
}
