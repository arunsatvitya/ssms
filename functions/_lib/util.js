/**
 * ============================================================================
 *  SSMS on Cloudflare - Utility layer
 *  Replaces the Google Apps Script services: Utilities, CacheService,
 *  LockService, PropertiesService, ScriptApp.
 * ============================================================================
 */

import { APP, ID_FIELDS } from './constants.js';

/* ==========================================================================
 * SECTION A: ERROR HANDLING
 * ========================================================================== */

/** Creates a structured error object - identical to the original error_(). */
export function error_(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/* ==========================================================================
 * SECTION B: JSON-SAFE TRANSPORT
 * ========================================================================== */

/**
 * Recursively converts a value into plain JSON types.
 *
 * The original used this because google.script.run cannot transport Date
 * objects. A Worker returns real JSON, so the function is kept - it also
 * removes the internal helper fields and guarantees a stable response shape.
 */
export function jsonSafe_(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return cellToString_(value);
  const t = typeof value;
  if (t === 'number') return isFinite(value) ? value : null;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'function' || t === 'symbol') return null;
  if (Array.isArray(value)) return value.map((v) => jsonSafe_(v));
  const out = {};
  Object.keys(value).forEach((k) => {
    if (k === '__row') return;
    out[k] = jsonSafe_(value[k]);
  });
  return out;
}

/* ==========================================================================
 * SECTION C: CRYPTOGRAPHY
 * ========================================================================== */

/**
 * Converts a byte array into a lowercase hex string - identical to the
 * original bytesToHex_().
 */
export function bytesToHex_(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push((bytes[i] + 0x100).toString(16).substring(1));
  }
  return out.join('');
}

const encoder = new TextEncoder();

/** Hex string into a byte array. */
export function hexToBytes_(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) {
    out.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return new Uint8Array(out);
}

/**
 * HMAC-SHA256 of a value with a key.
 *
 * The original called Utilities.computeHmacSha256Signature(value, key) which
 * signs `value` with `key`. The Web Crypto API works the other way round
 * (the key signs the data), therefore the arguments are swapped here on
 * purpose - the result is byte for byte the same as in Apps Script.
 *
 * @param {string} value - the data that is signed
 * @param {string} key - the key of the signature
 * @returns {Promise<Uint8Array>} - the raw signature bytes
 */
export async function hmacSha256_(value, key) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(key)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(String(value)));
  return new Uint8Array(signature);
}

/**
 * Salted PBKDF2-style password hash - identical to the original
 * hashPassword_().
 *
 *   U1     = HMAC(password, salt)
 *   U2     = HMAC(hex(U1), password)
 *   ...
 *   U1000  = HMAC(hex(U999), password)
 *   stored = pbkdf2-sha256$1000$<hex(U1 XOR U2 XOR ... XOR U1000)>
 *
 * @param {string} password
 * @param {string} salt
 * @param {number} [iterations]
 * @returns {Promise<string>} - the hash in the storage format
 */
export async function hashPassword_(password, salt, iterations) {
  const rounds = Math.max(1, parseInt(iterations || APP.HASH_ITERATIONS, 10));
  const pwd = String(password);
  let u = await hmacSha256_(pwd, String(salt));
  const out = u.slice();
  for (let i = 1; i < rounds; i++) {
    u = await hmacSha256_(bytesToHex_(u), pwd);
    for (let j = 0; j < out.length; j++) {
      out[j] = (out[j] ^ u[j]) & 0xFF;
    }
  }
  return APP.HASH_PREFIX + rounds + '$' + bytesToHex_(out);
}

/**
 * Verifies a password against a stored hash - identical to the original
 * verifyPassword_().
 *
 * @returns {Promise<string|boolean>} - true, false or 'LEGACY'
 */
export async function verifyPassword_(password, salt, storedHash) {
  const stored = String(storedHash || '');
  if (!stored) return false;
  if (stored.indexOf(APP.HASH_PREFIX) !== 0) return 'LEGACY';
  const parts = stored.split('$');
  const rounds = parseInt(parts[1], 10) || APP.HASH_ITERATIONS;
  const candidate = await hashPassword_(password, salt, rounds);
  return safeEqual_(candidate, stored);
}

/**
 * SHA-256 hex digest of a string - identical to the original sha256_().
 * @returns {Promise<string>}
 */
export async function sha256_(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return bytesToHex_(new Uint8Array(digest));
}

/**
 * Timing-safe-ish string comparison - identical to the original safeEqual_().
 */
export function safeEqual_(a, b) {
  const x = String(a === null || a === undefined ? '' : a);
  const y = String(b === null || b === undefined ? '' : b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Random salt - identical to the original generateSalt_(). */
export function generateSalt_() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

/** Random monitor access key - identical to the original generateAccessKey_(). */
export function generateAccessKey_() {
  return 'MON-' + crypto.randomUUID().replace(/-/g, '').substring(0, 16).toUpperCase();
}

/** A random token for a session - identical to the original login_(). */
export function generateToken_() {
  return crypto.randomUUID() + '-' + crypto.randomUUID().replace(/-/g, '');
}

/* ==========================================================================
 * SECTION D: DATE AND TIME
 * ========================================================================== */

/**
 * Formats a date in the timezone of the application - the replacement of
 * Utilities.formatDate(date, 'Asia/Bangkok', 'yyyy-MM-dd').
 *
 * The Intl API of the runtime does the same job as the Apps Script service.
 *
 * @param {Date} date
 * @param {string} pattern - 'yyyy-MM-dd' or 'yyyy-MM-dd HH:mm:ss'
 * @returns {string}
 */
export function formatDate_(date, pattern) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP.TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(d);
  const get = (t) => {
    const hit = parts.find((p) => p.type === t);
    return hit ? hit.value : '00';
  };
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  if (pattern === 'yyyy-MM-dd') return day;
  return `${day} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Current timestamp in the application timezone. */
export function now_() {
  return formatDate_(new Date(), 'yyyy-MM-dd HH:mm:ss');
}

/** Today's date in the application timezone. */
export function today_() {
  return formatDate_(new Date(), 'yyyy-MM-dd');
}

/**
 * Normalises a date value to `yyyy-mm-dd` - identical to the original
 * normalizeDate_().
 */
export function normalizeDate_(value) {
  if (!value) return '';
  if (value instanceof Date) return formatDate_(value, 'yyyy-MM-dd');
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return formatDate_(d, 'yyyy-MM-dd');
}

/** Normalises an ISO timestamp string. */
export function normalizeDateTime_(value) {
  if (!value) return now_();
  const d = (value instanceof Date) ? value : new Date(value);
  if (isNaN(d.getTime())) return now_();
  return formatDate_(d, 'yyyy-MM-dd HH:mm:ss');
}

/**
 * Converts a cell value into a JSON-safe string - identical to the original
 * cellToString_(). The date part keeps the date-only format when the time of
 * day is midnight, so the text survives the round trip unchanged.
 */
export function cellToString_(value) {
  if (!(value instanceof Date)) return value;
  if (isNaN(value.getTime())) return '';
  const midnight = value.getHours() === 0 && value.getMinutes() === 0 &&
    value.getSeconds() === 0 && value.getMilliseconds() === 0;
  return midnight
    ? formatDate_(value, 'yyyy-MM-dd')
    : formatDate_(value, 'yyyy-MM-dd HH:mm:ss');
}

/**
 * Lists the dates between two dates (inclusive, at most 400 days) -
 * identical to the original dateRange_().
 */
export function dateRange_(from, to) {
  const out = [];
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  let d = new Date(start.getTime());
  while (d <= end && out.length < 400) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push(y + '-' + m + '-' + day);
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

/** The date `n` days before the given date - identical to daysBefore_(). */
export function daysBefore_(date, n) {
  const d = new Date(String(date) + 'T00:00:00');
  const back = new Date(d.getTime() - n * 86400000);
  const y = back.getFullYear();
  const m = String(back.getMonth() + 1).padStart(2, '0');
  const day = String(back.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/* ==========================================================================
 * SECTION E: VALUE HELPERS
 * ========================================================================== */

/** Returns true when the field name holds an identifier. */
export function isIdField_(name) {
  return ID_FIELDS.indexOf(String(name)) !== -1;
}

/**
 * Compares two identifiers regardless of whether one of them is a number -
 * identical to the original idEq_().
 */
export function idEq_(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a).trim() === String(b).trim();
}

/** Escapes a string for safe HTML output. */
export function escapeHtml_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Removes empty / null values from an object. */
export function compact_(obj) {
  const out = {};
  Object.keys(obj || {}).forEach((k) => {
    const v = obj[k];
    if (v !== '' && v !== null && v !== undefined) out[k] = v;
  });
  return out;
}

/**
 * Converts a database row into a plain serialisable object - identical to the
 * original plain_().
 */
export function plain_(row) {
  const out = {};
  Object.keys(row || {}).forEach((k) => {
    if (k === '__row') return;
    const v = row[k];
    out[k] = cellToString_(v);
  });
  return out;
}

/**
 * Sorts an array of objects by a key (string compare, null safe) - identical
 * to the original sortBy_().
 */
export function sortBy_(arr, key, desc) {
  return arr.slice().sort((a, b) => {
    const x = String(a[key] === undefined || a[key] === null ? '' : a[key]);
    const y = String(b[key] === undefined || b[key] === null ? '' : b[key]);
    const r = x.localeCompare(y, 'th', { numeric: true });
    return desc ? -r : r;
  });
}

/** Validates a required string field. */
export function requireText_(value, label, maxLen) {
  const v = String(value === null || value === undefined ? '' : value).trim();
  if (!v) throw error_('VALIDATION', 'กรุณากรอก' + label);
  if (maxLen && v.length > maxLen) {
    throw error_('VALIDATION', label + 'ยาวเกิน ' + maxLen + ' ตัวอักษร');
  }
  return v;
}

/** Validates a password policy. */
export function validatePassword_(pwd) {
  const v = String(pwd || '');
  if (v.length < 6) return { ok: false, message: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' };
  if (v.length > 100) return { ok: false, message: 'รหัสผ่านยาวเกินไป' };
  return { ok: true };
}

/**
 * Generates a sequential-ish identifier with a prefix - identical to the
 * original nextId_().
 */
export function nextId_(prefix, existing) {
  let max = 0;
  (existing || []).forEach((row) => {
    const id = String(row || '');
    const m = id.match(/(\d+)\s*$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

/**
 * Packs a table into a compact text (one line per row, tab separated).
 * Numbers keep their type through a leading marker - identical to the
 * original packTable_().
 */
export function packTable_(rows, headers) {
  const cols = headers.filter((h) => h !== '__row');
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const vals = [];
    for (let j = 0; j < cols.length; j++) {
      const v = r[cols[j]];
      if (v === undefined || v === null || v === '') { vals.push(''); continue; }
      if (typeof v === 'number') { vals.push('#' + v); continue; }
      if (typeof v === 'boolean') { vals.push('~' + v); continue; }
      vals.push(String(v).replace(/[\t\r\n]+/g, ' '));
    }
    lines.push(vals.join('\t'));
  }
  return lines.join('\n');
}

/** Restores a packed table - identical to the original unpackTable_(). */
export function unpackTable_(text, headers) {
  const cols = headers.filter((h) => h !== '__row');
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    const vals = lines[i].split('\t');
    const o = {};
    for (let j = 0; j < cols.length; j++) {
      const raw = vals[j] === undefined ? '' : vals[j];
      if (raw === '') { o[cols[j]] = ''; continue; }
      if (raw.charAt(0) === '#') {
        const n = Number(raw.substring(1));
        o[cols[j]] = isNaN(n) ? '' : n;
        continue;
      }
      if (raw.charAt(0) === '~') { o[cols[j]] = raw.substring(1) === 'true'; continue; }
      o[cols[j]] = raw;
    }
    out.push(o);
  }
  return out;
}

/* ==========================================================================
 * SECTION F: CACHE
 * ========================================================================== */

/**
 * The request cache.
 *
 * In Apps Script the CacheService kept the data in a shared cache. In a
 * Worker the Cache API of the Cloudflare edge does the same job - it is
 * available without a binding and works in the free plan.
 *
 * @param {Cache} cache - the cache instance (caches.default)
 * @param {string} key
 * @param {number} seconds - the lifetime of the entry
 */
export async function cacheGet_(cache, key, seconds) {
  try {
    const res = await cache.match(cacheKey_(key));
    if (!res) return null;
    const body = await res.json();
    // The expiry is checked again because the edge may keep the entry longer.
    if (body && body.expires && body.expires < Date.now()) return null;
    return body ? body.value : null;
  } catch (err) {
    return null;
  }
}

/**
 * Stores a value in the cache.
 */
export async function cachePut_(cache, key, value, seconds) {
  try {
    const ttl = Math.min(Math.max(seconds || 60, 1), 21600);
    const body = JSON.stringify({ value, expires: Date.now() + ttl * 1000 });
    const res = new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${ttl}`
      }
    });
    await cache.put(cacheKey_(key), res);
  } catch (err) {
    /* the cache is best effort only */
  }
}

/** Removes a cache key. */
export async function cacheRemove_(cache, key) {
  try {
    await cache.delete(cacheKey_(key));
  } catch (err) { /* ignore */ }
}

/**
 * Removes the cached tables - identical to the original clearAppCache_().
 * The cache of the edge cannot be listed, so the known keys are deleted.
 */
export async function clearAppCache_(cache, keys) {
  const now = new Date();
  const list = (keys || []).slice();
  list.push('ano_' + now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0'));
  list.push('monitor_payload');
  list.push('attendance_stats');
  for (const k of list) {
    await cacheRemove_(cache, k);
  }
}

/** The cache key of the application - a prefix keeps it apart from others. */
function cacheKey_(key) {
  return 'https://ssms.local/' + key;
}
