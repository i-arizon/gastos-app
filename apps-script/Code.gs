/**
 * Gastos — backend de sincronización con Google Sheets (Google Apps Script).
 *
 * Despliegue: Implementar > Nueva implementación > Aplicación web
 *   - Ejecutar como: Yo
 *   - Quién tiene acceso: Cualquier usuario
 * Guarda el token en Configuración del proyecto > Propiedades del script con la clave TOKEN.
 *
 * POST (cuerpo JSON enviado como text/plain):
 *   { "token": "...", "action": "upsert" | "delete", "expenses": [ {id, date, name, amount, category, createdAt, updatedAt, deleted}, ... ] }
 * GET:
 *   ?token=...               -> todos los gastos (incluidos los borrados)
 *   ?token=...&action=ping   -> comprobación de conexión
 */

var SHEET_NAME = 'Gastos';
var HEADERS = ['id', 'date', 'name', 'amount', 'category', 'createdAt', 'updatedAt', 'deleted'];
// Texto plano para id/fecha/nombre/categoría/timestamps: evita que Sheets convierta las fechas.
var FORMATS = ['@', '@', '@', '#,##0.00', '@', '@', '@', '@'];
var UPDATED_AT_COL = 6; // índice (base 0) de updatedAt

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkToken_(body.token);

    var action = body.action;
    if (action !== 'upsert' && action !== 'delete') throw new Error('Acción no válida: ' + action);
    var list = Array.isArray(body.expenses) ? body.expenses : (body.expense ? [body.expense] : []);
    if (!list.length) throw new Error('No se han recibido gastos');

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) throw new Error('La hoja está ocupada, inténtalo de nuevo');
    try {
      var result = writeExpenses_(list, action === 'delete');
      return json_({ status: 'ok', action: action, inserted: result.inserted, updated: result.updated, skipped: result.skipped });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ status: 'error', message: String((err && err.message) || err) });
  }
}

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    checkToken_(params.token);

    var rows = readRows_();
    if (params.action === 'ping') return json_({ status: 'ok', count: rows.length });

    var tz = Session.getScriptTimeZone();
    var expenses = rows.map(function (r) {
      return {
        id: String(r[0]),
        date: toDateString_(r[1], tz),
        name: String(r[2]),
        amount: Number(r[3]) || 0,
        category: String(r[4]),
        createdAt: toTimestamp_(r[5]),
        updatedAt: toTimestamp_(r[6]),
        deleted: r[7] === true || String(r[7]).toUpperCase() === 'TRUE',
      };
    });
    return json_({ status: 'ok', count: expenses.length, expenses: expenses });
  } catch (err) {
    return json_({ status: 'error', message: String((err && err.message) || err) });
  }
}

/* ---------- Escritura ---------- */

// Actualiza la fila existente por id (si el cambio es más reciente) o añade una nueva.
function writeExpenses_(list, isDelete) {
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  var rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues() : [];
  var index = {};
  rows.forEach(function (r, i) { if (r[0] !== '') index[String(r[0])] = i; });

  var changed = {};   // índice de fila -> true
  var appended = [];
  var inserted = 0, updated = 0, skipped = 0;

  list.forEach(function (exp) {
    if (!exp || !exp.id) { skipped++; return; }
    var row = toRow_(exp, isDelete);
    var i = index[row[0]];
    if (i === undefined) {
      index[row[0]] = rows.length + appended.length;
      appended.push(row);
      inserted++;
    } else if (i >= rows.length) {
      appended[i - rows.length] = row; // id repetido en el mismo envío
    } else if (String(rows[i][UPDATED_AT_COL]) > row[UPDATED_AT_COL]) {
      skipped++; // la hoja tiene una versión más reciente
    } else {
      rows[i] = row;
      changed[i] = true;
      updated++;
    }
  });

  var changedIdx = Object.keys(changed).map(Number);
  if (changedIdx.length > 20) {
    // Muchos cambios: se reescribe todo el bloque de una vez (más rápido).
    writeRange_(sheet, 2, rows);
  } else {
    changedIdx.forEach(function (i) { writeRange_(sheet, i + 2, [rows[i]]); });
  }
  if (appended.length) writeRange_(sheet, sheet.getLastRow() + 1, appended);

  return { inserted: inserted, updated: updated, skipped: skipped };
}

function writeRange_(sheet, startRow, values) {
  if (!values.length) return;
  var range = sheet.getRange(startRow, 1, values.length, HEADERS.length);
  range.setNumberFormats(values.map(function () { return FORMATS; }));
  range.setValues(values);
}

function toRow_(exp, forceDeleted) {
  return [
    String(exp.id),
    String(exp.date || '').slice(0, 10),
    String(exp.name || ''),
    Math.round(Number(exp.amount) * 100) / 100 || 0,
    String(exp.category || ''),
    String(exp.createdAt || ''),
    String(exp.updatedAt || new Date().toISOString()),
    forceDeleted || exp.deleted === true ? 'TRUE' : 'FALSE',
  ];
}

/* ---------- Lectura y utilidades ---------- */

function readRows_() {
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues()
    .filter(function (r) { return r[0] !== ''; });
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function checkToken_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!expected) throw new Error('Falta la propiedad TOKEN en las propiedades del script');
  if (!token || String(token) !== expected) throw new Error('Token no válido');
}

// Si alguien editó la hoja a mano, Sheets puede haber convertido la fecha en Date.
function toDateString_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}
function toTimestamp_(v) {
  return v instanceof Date ? v.toISOString() : String(v);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Funciones de ayuda (ejecutar a mano desde el editor) ---------- */

// Crea la hoja "Gastos" con cabeceras y pide los permisos necesarios.
function setup() {
  var sheet = getSheet_();
  Logger.log('Hoja lista: ' + sheet.getName());
}

// Genera un token aleatorio, lo guarda en TOKEN y lo muestra en el registro.
function crearToken() {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('TOKEN', token);
  Logger.log('Token guardado en Propiedades del script: ' + token);
}
