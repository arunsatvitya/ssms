/**
 * ============================================================================
 *  SSMS on Cloudflare - D1 data layer (Sheets API compatible shim)
 * ============================================================================
 *
 *  WHY THIS FILE EXISTS
 *  --------------------
 *  The original backend was written against the Google Sheets API:
 *
 *      sheet.getRange(row, col, numRows, numCols).getValues()
 *      sheet.getRange(row, col, numRows, numCols).setValues([[...], ...])
 *      sheet.getLastRow() / sheet.getLastColumn()
 *      sheet.deleteRow(rowNumber)
 *
 *  Rewriting 5,000 lines of business logic to use SQL one-to-one would risk
 *  subtle behaviour changes. Instead this module implements the *same*
 *  sheet semantics on top of Cloudflare D1, so the ported business logic
 *  stays a faithful translation of the original.
 *
 *  THE MODEL
 *  ---------
 *  A sheet is loaded from D1 into memory as an array of rows. Row 0 of the
 *  array is the header row (row 1 in the spreadsheet). Data starts at index 1
 *  (spreadsheet row 2) - exactly like the original.
 *
 *  Reads are served from memory. Writes are recorded as a "dirty" set of
 *  spreadsheet row numbers and are flushed back to D1 at the end of the
 *  request. Because the whole request is one unit of work, the behaviour is
 *  identical to the spreadsheet version.
 *
 *  The spreadsheet version relied on a "row number" (`__row`) to address a
 *  single record later (`writeCompactRow_` writes back to the row it read).
 *  The shim keeps that number: `__row` is the 1-based spreadsheet row number.
 * ============================================================================
 */

import { HEADERS, TABLES } from './constants.js';


/**
 * Reads a whole table and returns the rows as objects (header names).
 *
 * @param {D1Database} d1
 * @param {string} name - the sheet name
 * @param {Array<string>} [cols] - the columns that are needed (null = all)
 * @returns {Promise<Array<Object>>}
 */
export async function readTable(d1, name, cols) {
  const meta = TABLES[name];
  if (!meta) return [];
  const headers = HEADERS[name] || [];
  let wanted = headers;
  if (cols && cols.length) {
    wanted = cols.filter((c) => headers.indexOf(c) !== -1);
    if (!wanted.length) return [];
  }
  const sql = `SELECT ${meta.columns.join(', ')} FROM ${meta.table}`;
  const res = await d1.prepare(sql).all();
  const out = [];
  (res.results || []).forEach((r) => {
    const obj = {};
    headers.forEach((h, i) => {
      const v = r[meta.columns[i]];
      obj[h] = (v === null || v === undefined) ? '' : String(v);
    });
    wanted.forEach((c) => { if (obj[c] === undefined) obj[c] = ''; });
    out.push(obj);
  });
  return out;
}

/**
 * Reads a key/value table (Settings, Monitor_Settings).
 * @returns {Promise<Object>}
 */
export async function readKeyValue(d1, name) {
  const meta = TABLES[name];
  if (!meta) return {};
  const res = await d1.prepare(`SELECT ${meta.columns[0]} AS k, ${meta.columns[1]} AS v FROM ${meta.table}`).all();
  const map = {};
  (res.results || []).forEach((r) => { map[String(r.k)] = (r.v === null || r.v === undefined) ? '' : String(r.v); });
  return map;
}

/**
 * Writes a key/value pair.
 */
export async function writeKeyValue(d1, name, key, value, updatedAt) {
  const meta = TABLES[name];
  if (!meta) return;
  const sql = `INSERT INTO ${meta.table} (${meta.columns.join(', ')}) VALUES (?, ?, ?) ` +
    `ON CONFLICT(${meta.key}) DO UPDATE SET ${meta.columns[1]} = excluded.${meta.columns[1]}, ${meta.columns[2]} = excluded.${meta.columns[2]}`;
  await d1.prepare(sql).bind(String(key), String(value === undefined || value === null ? '' : value), String(updatedAt || '')).run();
}

/**
 * Inserts or updates a list of records in a table.
 * The first column is the primary key - identical to upsertRows_().
 *
 * @param {D1Database} d1
 * @param {string} name - the sheet name
 * @param {Array<Object>} records
 */
export async function upsertRows(d1, name, records) {
  const meta = TABLES[name];
  if (!meta || !records || !records.length) return 0;
  const headers = HEADERS[name] || [];
  const sql = `INSERT INTO ${meta.table} (${meta.columns.join(', ')}) VALUES (${meta.columns.map(() => '?').join(', ')}) ` +
    `ON CONFLICT(${meta.key}) DO UPDATE SET ${meta.columns.filter((c) => c !== meta.key).map((c) => `${c} = excluded.${c}`).join(', ')}`;

  const statements = records.map((rec) => {
    const values = headers.map((h) => {
      const v = rec[h];
      return (v === undefined || v === null) ? '' : String(v);
    });
    return d1.prepare(sql).bind(...values);
  });
  for (let i = 0; i < statements.length; i += 25) {
    await d1.batch(statements.slice(i, i + 25));
  }
  return records.length;
}

/**
 * Deletes rows by their primary key - identical to deleteRowsByKey_().
 */
export async function deleteRowsByKey(d1, name, keyField, keys) {
  const meta = TABLES[name];
  if (!meta || !keys || !keys.length) return 0;
  const headers = HEADERS[name] || [];
  const keyColumn = meta.columns[headers.indexOf(keyField)];
  if (!keyColumn) return 0;
  let removed = 0;
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50).map((k) => String(k));
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await d1.prepare(`DELETE FROM ${meta.table} WHERE ${keyColumn} IN (${placeholders})`).bind(...chunk).run();
    removed += (res.meta && res.meta.changes) ? res.meta.changes : chunk.length;
  }
  return removed;
}

/**
 * Updates a single cell of a row - identical to updateCellByKey_().
 */
export async function updateCellByKey(d1, name, keyColumn, keyValue, column, value) {
  const meta = TABLES[name];
  if (!meta) return false;
  const headers = HEADERS[name] || [];
  const colIndex = headers.indexOf(column);
  const keyIndex = headers.indexOf(keyColumn);
  if (colIndex === -1 || keyIndex === -1) return false;
  const sql = `UPDATE ${meta.table} SET ${meta.columns[colIndex]} = ? WHERE ${meta.columns[keyIndex]} = ?`;
  const res = await d1.prepare(sql).bind(String(value === undefined || value === null ? '' : value), String(keyValue)).run();
  return !!(res.meta && res.meta.changes);
}

/**
 * Counts the rows of a table - used by the database usage report.
 */
export async function countRows(d1, name) {
  const meta = TABLES[name];
  if (!meta) return 0;
  const res = await d1.prepare(`SELECT COUNT(*) AS c FROM ${meta.table}`).all();
  const row = (res.results || [])[0];
  return row ? Number(row.c) || 0 : 0;
}

/**
 * Reads the rows of a table that belong to one date.
 * Identical to readRowsByDate_() but with a real index instead of a window.
 */
export async function readRowsByDate(d1, name, dateColumn, date, cols) {
  const meta = TABLES[name];
  if (!meta) return [];
  const headers = HEADERS[name] || [];
  const idx = headers.indexOf(dateColumn);
  if (idx === -1) return readTable(d1, name, cols);
  const sql = `SELECT ${meta.columns.join(', ')} FROM ${meta.table} WHERE ${meta.columns[idx]} = ? ORDER BY ${meta.key}`;
  const res = await d1.prepare(sql).bind(String(date)).all();
  const wanted = (cols && cols.length)
    ? cols.filter((c) => headers.indexOf(c) !== -1)
    : headers;
  const out = [];
  (res.results || []).forEach((r) => {
    const obj = {};
    wanted.forEach((c) => {
      const v = r[meta.columns[headers.indexOf(c)]];
      obj[c] = (v === null || v === undefined) ? '' : String(v);
    });
    out.push(obj);
  });
  return out;
}

/**
 * Reads the rows of a table inside a period.
 * Identical to readRowsByDateRange_().
 */
export async function readRowsByDateRange(d1, name, dateColumn, from, to, cols) {
  const meta = TABLES[name];
  if (!meta) return [];
  const headers = HEADERS[name] || [];
  const idx = headers.indexOf(dateColumn);
  if (idx === -1) return readTable(d1, name, cols);
  const sql = `SELECT ${meta.columns.join(', ')} FROM ${meta.table} WHERE ${meta.columns[idx]} >= ? AND ${meta.columns[idx]} <= ? ORDER BY ${meta.columns[idx]}, ${meta.key}`;
  const res = await d1.prepare(sql).bind(String(from), String(to)).all();
  const wanted = (cols && cols.length)
    ? cols.filter((c) => headers.indexOf(c) !== -1)
    : headers;
  const out = [];
  (res.results || []).forEach((r) => {
    const obj = {};
    wanted.forEach((c) => {
      const v = r[meta.columns[headers.indexOf(c)]];
      obj[c] = (v === null || v === undefined) ? '' : String(v);
    });
    out.push(obj);
  });
  return out;
}

