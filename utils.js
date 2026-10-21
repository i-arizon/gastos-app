// utils.js — Formato (es-ES / EUR), fechas e importes, utilidades varias.

export const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
  'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
export const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const pad = (n) => String(n).padStart(2, '0');

// Formato manual para garantizar "1.234,56" (Intl es-ES no agrupa números de 4 cifras).
export function fmtNum(n, dec = 2) {
  const v = Number(n) || 0;
  const [int, frac] = Math.abs(v).toFixed(dec).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = v < 0 && Number(Math.abs(v).toFixed(dec)) !== 0 ? '-' : '';
  return sign + grouped + (dec ? ',' + frac : '');
}
export const fmtEUR = (n, dec = 2) => fmtNum(n, dec) + ' €';
export const fmtPct = (n, dec = 1) => fmtNum(n, dec) + ' %';
export const fmtSigned = (n, fmt = fmtEUR) => (n > 0 ? '+' : '') + fmt(n);

// 'YYYY-MM-DD' -> 'DD/MM/YYYY'
export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// Fecha local de hoy (no UTC) en formato ISO corto.
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const currentYM = () => todayISO().slice(0, 7);
export const currentYear = () => new Date().getFullYear();

export function shiftMonth(ym, n) {
  let [y, m] = ym.split('-').map(Number);
  m += n;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${pad(m)}`;
}
export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00'));

// Acepta "12,5", "12.50", "1.234,56", "1,234.56", "12 €".
export function parseAmount(raw) {
  let s = String(raw ?? '').replace(/[\s€ ]/g, '');
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100) / 100;
}

// Calculadora del importe: "12,50+3,20", "45/3", "2×(3+4)". Sin operadores equivale a parseAmount.
export const hasOperator = (raw) => /[+\-*/×÷−()]/.test(String(raw ?? '').trim().replace(/^-/, ''));

export function evalAmount(raw) {
  const s = String(raw ?? '').replace(/[\s€ ]/g, '')
    .replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
  if (!hasOperator(s)) return parseAmount(s);
  const tokens = s.match(/\d[\d.,]*|[+\-*/()]/g);
  if (!tokens || tokens.join('') !== s) return NaN;
  let i = 0;
  const peek = () => tokens[i];
  // Análisis por precedencia: expr = term (± term)*, term = factor (×÷ factor)*
  const factor = () => {
    const t = tokens[i++];
    if (t === '(') {
      const v = expr();
      if (tokens[i++] !== ')') throw new Error();
      return v;
    }
    if (t === '-') return -factor();
    const v = parseAmount(t);
    if (isNaN(v)) throw new Error();
    return v;
  };
  const term = () => {
    let v = factor();
    while (peek() === '*' || peek() === '/') v = tokens[i++] === '*' ? v * factor() : v / factor();
    return v;
  };
  const expr = () => {
    let v = term();
    while (peek() === '+' || peek() === '-') v = tokens[i++] === '+' ? v + term() : v - term();
    return v;
  };
  try {
    const v = expr();
    return i === tokens.length && isFinite(v) ? Math.round(v * 100) / 100 : NaN;
  } catch {
    return NaN;
  }
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Minúsculas y sin acentos, para búsquedas.
export const normalizeText = (s) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export const sum = (list) => list.reduce((acc, e) => acc + e.amount, 0);

// Orden: fecha desc, y a igual fecha el último creado primero.
export const byDateDesc = (a, b) =>
  b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '');
