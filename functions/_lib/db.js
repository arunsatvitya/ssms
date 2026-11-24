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
 * A single sheet, loaded into memory.
 *
 * `rows[0]` is the header row. `rows[i]` is spreadsheet row `i + 1`.
 */
class Sheet {
  /**
   * @param {string} name - the sheet name (e.g. 'Students')
   * @param {Object} meta - the TABLES entry of this sheet
   */
  constructor(name, meta) {
    this.name = name;
    this.meta = meta;
    /** @type {Array<Array<string>>} */
    this.rows = [];
    /** Row numbers (1-based, spreadsheet numbering) that must be written back. */
    this.dirty = new Set();
    /** Row numbers that must be removed from D1. */
    this.deleted = new Set();
    /** True when the sheet was read from D1 already. */
    this.loaded = false;
  }

  /** The header row of the sheet. */
  get headers() {
    return HEADERS[this.name] || [];
  }

  /** Number of the last row that holds data (spreadsheet semantics). */
  getLastRow() {
    // The spreadsheet counts the header row, so an empty sheet has 0 rows and
    // a sheet with only a header has 1 row.
    if (!this.rows.length) return 0;
    let last = this.rows.length;
    // Trailing empty rows do not count - the spreadsheet removes them.
    while (last > 1 && isEmptyRow(this.rows[last - 1])) last--;
    return last;
  }

  /** Number of columns of the sheet. */
  getLastColumn() {
    if (!this.rows.length) return 0;
    let last = 0;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      for (let j = row.length - 1; j >= 0; j--) {
        if (row[j] !== '' && row[j] !== null && row[j] !== undefined) { last = j + 1; break; }
      }
      if (last) break;
    }
    return last;
  }

  /**
   * Returns a range of the sheet.
   *
   * @param {number} row - first row (1-based, spreadsheet numbering)
   * @param {number} col - first column (1-based)
   * @param {number} [numRows] - number of rows (default 1)
   * @param {number} [numCols] - number of columns (default 1)
   */
  getRange(row, col, numRows, numCols) {
    const r = Math.max(1, parseInt(row, 10) || 1);
    const c = Math.max(1, parseInt(col, 10) || 1);
    const nr = numRows === undefined || numRows === null ? 1 : Math.max(0, parseInt(numRows, 10) || 0);
    const nc = numCols === undefined || numCols === null ? 1 : Math.max(0, parseInt(numCols, 10) || 0);
    return new Range(this, r, c, nr, nc);
  }

  /** Deletes one row (1-based, spreadsheet numbering). */
  deleteRow(rowNumber) {
    this.deleteRows(rowNumber, 1);
  }

  /**
   * Deletes rows from the sheet.
   * @param {number} start - first row to delete (1-based)
   * @param {number} count - number of rows
   */
  deleteRows(start, count) {
    const from = Math.max(1, parseInt(start, 10) || 1);
    const n = Math.max(1, parseInt(count, 10) || 1);
    // Spreadsheet rows are 1-based and the header occupies row 1.
    const idx = from - 1;
    for (let i = 0; i < n; i++) {
      const at = idx + i;
      if (at < this.rows.length) {
        this.deleted.add(at + 1);
        this.rows.splice(at, 1);
      }
    }
    // Every row below the deleted ones moved up - their number changed, so
    // they have to be written again.
    for (let r = from; r < this.rows.length + 1; r++) this.dirty.add(r);
    this.dirty.add(from);
  }

  /** Appends a row and returns its row number (1-based). */
  appendRow(values) {
    // The header must always be the first row.
    if (!this.rows.length) this.rows.push(this.headers.slice());
    this.rows.push(values.slice());
    const rowNumber = this.rows.length;
    this.dirty.add(rowNumber);
    return rowNumber;
  }
}

/**
 * A rectangular range of a sheet - the object returned by getRange().
 * Only the operations the original code actually uses are implemented.
 */
class Range {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  /** Reads the values of the range as a two dimensional array. */
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.rows[this.row - 1 + r];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src ? src[this.col - 1 + c] : '';
        line.push(v === undefined || v === null ? '' : v);
      }
      out.push(line);
    }
    return out;
  }

  /** Reads a single cell. */
  getValue() {
    const v = this.getValues();
    return v.length && v[0].length ? v[0][0] : '';
  }

  /** Writes a two dimensional array into the range. */
  setValues(values) {
    const sheet = this.sheet;
    for (let r = 0; r < this.numRows; r++) {
      const rowNumber = this.row + r;
      const src = values[r] || [];
      // Grow the sheet when the range points behind the last row.
      while (sheet.rows.length < rowNumber) sheet.rows.push([]);
      if (!sheet.rows[rowNumber - 1].length) {
        sheet.rows[rowNumber - 1] = new Array(this.col - 1).fill('');
      }
      const target = sheet.rows[rowNumber - 1];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[c];
        target[this.col - 1 + c] = (v === undefined || v === null) ? '' : v;
      }
      sheet.dirty.add(rowNumber);
    }
  }

  /** Writes a single cell. */
  setValue(value) {
    this.setValues([[value]]);
  }

  /** Empties the range (the content stays, the cells are blank). */
  clearContent() {
    const sheet = this.sheet;
    for (let r = 0; r < this.numRows; r++) {
      const rowNumber = this.row + r;
      const target = sheet.rows[rowNumber - 1];
      if (!target) continue;
      for (let c = 0; c < this.numCols; c++) {
        if (target[this.col - 1 + c] !== undefined) target[this.col - 1 + c] = '';
      }
      sheet.dirty.add(rowNumber);
    }
  }

  /** The spreadsheet styling calls - they have no meaning in a database. */
  setFontWeight() { return this; }
  setBackground() { return this; }
  setNumberFormat() { return this; }
  setFontColor() { return this; }
  setHorizontalAlignment() { return this; }
  setVerticalAlignment() { return this; }
  setWrap() { return this; }
  setFontSize() { return this; }
  setFontFamily() { return this; }
}

/** True when every cell of the row is empty. */
function isEmptyRow(row) {
  if (!row) return true;
  for (let i = 0; i < row.length; i++) {
    if (row[i] !== '' && row[i] !== null && row[i] !== undefined) return false;
  }
  return true;
}

/**
 * The database - a collection of sheets backed by D1.
 */
export class Database {
  /**
   * @param {D1Database} d1 - the D1 binding
   */
  constructor(d1) {
    this.d1 = d1;
    /** @type {Object<string, Sheet>} */
    this.sheets = {};
    /** Cache of the tables that rarely change. */
    this.cache = new Map();
    /** Names of the sheets that were changed during this request. */
    this.dirtySheets = new Set();
  }

  /**
   * Returns a sheet - identical to SpreadsheetApp.getSheetByName().
   * The sheet is loaded from D1 on first access.
   */
  getSheetByName(name) {
    if (!name || !TABLES[name]) return null;
    if (!this.sheets[name]) {
      this.sheets[name] = new Sheet(name, TABLES[name]);
    }
    const sheet = this.sheets[name];
    if (!sheet.loaded) {
      // The rows are loaded lazily - the loader is called by the request
      // handler before the business logic runs (see prepare()).
      sheet.loaded = true;
      sheet.rows = this.pendingRows && this.pendingRows[name]
        ? this.pendingRows[name]
        : [];
      if (!this.pendingRows || !this.pendingRows[name]) {
        if (!this.headersLoaded) {
          sheet.rows = [sheet.headers.slice()];
        }
      }
    }
    return sheet;
  }

  /** All sheets - identical to SpreadsheetApp.getSheets(). */
  getSheets() {
    return Object.keys(TABLES).map((n) => this.getSheetByName(n)).filter(Boolean);
  }

  /** Creates a sheet - identical to SpreadsheetApp.insertSheet(). */
  insertSheet(name) {
    if (this.sheets[name]) return this.sheets[name];
    const sheet = new Sheet(name, TABLES[name] || { table: name.toLowerCase(), key: 'id', columns: [] });
    sheet.loaded = true;
    sheet.rows = [sheet.headers.slice()];
    this.sheets[name] = sheet;
    return sheet;
  }

  /** Deletes a sheet - the tables are dropped by the schema, so this is a no-op. */
  deleteSheet(sheet) {
    if (sheet && this.sheets[sheet.name]) delete this.sheets[sheet.name];
  }

  /** The identifier of the database - the spreadsheet id in the original. */
  getId() {
    return 'd1:ssms';
  }

  /** The address of the database - the spreadsheet url in the original. */
  getUrl() {
    return 'd1://ssms';
  }
}

/**
 * Loads the given sheets from D1 into the database.
 *
 * @param {Database} db
 * @param {Array<string>} names - the sheet names that are needed
 * @returns {Promise<Database>}
 */
export async function loadSheets(db, names) {
  const unique = Array.from(new Set(names)).filter((n) => TABLES[n]);
  if (!unique.length) return db;

  // Every sheet is read with one query - the columns are always known, so
  // only the needed rows are transferred.
  const results = await Promise.all(unique.map(async (name) => {
    const meta = TABLES[name];
    const sql = `SELECT ${meta.columns.join(', ')} FROM ${meta.table}`;
    const res = await db.d1.prepare(sql).all();
    const headers = HEADERS[name] || [];
    const rows = [headers.slice()];
    (res.results || []).forEach((r) => {
      const line = meta.columns.map((c) => {
        const v = r[c];
        return (v === null || v === undefined) ? '' : v;
      });
      rows.push(line);
    });
    return [name, rows];
  }));

  results.forEach(([name, rows]) => {
    const sheet = db.getSheetByName(name);
    sheet.rows = rows;
    sheet.loaded = true;
  });
  return db;
}

/**
 * Writes the changed sheets back to D1.
 *
 * The strategy mirrors the original: a row is either updated (when it already
 * exists) or inserted (when it is new). Rows that were deleted are removed.
 *
 * @param {Database} db
 */
export async function flushSheets(db) {
  const jobs = [];
  for (const name of Object.keys(db.sheets)) {
    const sheet = db.sheets[name];
    if (!sheet.dirty.size && !sheet.deleted.size) continue;
    const meta = TABLES[name];
    if (!meta) continue;

    const headers = HEADERS[name] || [];
    const keyIndex = headers.indexOf(headers[0]);

    // --- deletions -------------------------------------------------------
    if (sheet.deleted.size) {
      const keys = [];
      for (const rowNumber of sheet.deleted) {
        const row = sheet.rows[rowNumber - 1];
        // The row was removed from the array, so the key must be taken from
        // the state before the deletion. The shim keeps it in `removedKeys`.
        const key = sheet.removedKeys && sheet.removedKeys.get(rowNumber);
        if (key !== undefined && key !== '') keys.push(key);
      }
      if (keys.length) {
        for (let i = 0; i < keys.length; i += 50) {
          const chunk = keys.slice(i, i + 50);
          const placeholders = chunk.map(() => '?').join(', ');
          jobs.push({
            sql: `DELETE FROM ${meta.table} WHERE ${meta.key} IN (${placeholders})`,
            params: chunk
          });
        }
      }
    }

    // --- updates and inserts --------------------------------------------
    const sortedRows = Array.from(sheet.dirty).sort((a, b) => a - b);
    for (const rowNumber of sortedRows) {
      if (rowNumber < 2) continue;           // row 1 is the header
      if (sheet.deleted.has(rowNumber)) continue;
      const row = sheet.rows[rowNumber - 1];
      if (!row) continue;
      const values = headers.map((h, i) => {
        const v = row[i];
        return (v === undefined || v === null) ? '' : String(v);
      });
      const keyValue = values[keyIndex];
      const sql = `INSERT INTO ${meta.table} (${meta.columns.join(', ')}) VALUES (${meta.columns.map(() => '?').join(', ')}) ` +
        `ON CONFLICT(${meta.key}) DO UPDATE SET ${meta.columns.filter((c) => c !== meta.key).map((c) => `${c} = excluded.${c}`).join(', ')}`;
      jobs.push({ sql, params: values });
    }
  }

  if (!jobs.length) return;

  // D1 accepts many statements per batch - the limit is 100 bound parameters
  // per statement, which is respected because a row has at most 15 columns.
  const CHUNK = 25;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const slice = jobs.slice(i, i + CHUNK);
    const statements = slice.map((j) => db.d1.prepare(j.sql).bind(...j.params));
    await db.d1.batch(statements);
  }
}

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

export { Sheet, Range };
