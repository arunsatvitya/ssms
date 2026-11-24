/**
 * ============================================================================
 *  SSMS on Cloudflare - Authentication, authorization, users and settings
 * ============================================================================
 *
 *  Ported from the Google Apps Script version (Code.gs):
 *    SECTION 3   system information / bootstrap
 *    SECTION 4   authentication (login / logout / me / change password)
 *    SECTION 5   authorization (permissions / scope)
 *    SECTION 6   user management
 *    SECTION 15b settings & lookup
 *    SECTION 17  audit log
 *    SECTION 21  error handling
 *
 *  DIFFERENCES TO THE ORIGINAL
 *  ----------------------------
 *  - The spreadsheet became a D1 database. Every sheet access goes through the
 *    helpers of `_lib/db.js`; the Sessions table is the only table that is
 *    touched with raw SQL because the original compacted the sheet in place.
 *  - `requireSession_` / `requirePermission_` live on the request context
 *    (ctx.requireSession / ctx.requirePermission). The functions below are thin
 *    wrappers around them so that this module stays usable on its own.
 *  - The password helpers (hashPassword_ / verifyPassword_ / sha256_) come
 *    from `_lib/util.js`. They are byte compatible with the Apps Script
 *    version, so existing password hashes keep working.
 * ============================================================================
 */

import {
  APP, SHEETS, HEADERS, ROLES, ROLE_PERMISSIONS, LEAVE_TYPES, ANIMATIONS
} from './constants.js';

import {
  readTable, readKeyValue, writeKeyValue, upsertRows, deleteRowsByKey,
  updateCellByKey, countRows, readRowsByDate
} from './db.js';

import { hashPassword_, verifyPassword_, sha256_ } from './util.js';

/* ==========================================================================
 * SMALL INTERNAL HELPERS (port of the utility functions of Code.gs)
 * ========================================================================== */

/** Creates a structured error object - identical to error_() of Code.gs. */
export function error_(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Current timestamp in the application timezone. */
function nowOf_(ctx) {
  if (ctx && typeof ctx.now === 'function') return ctx.now();
  if (ctx && typeof ctx.now === 'string') return ctx.now;
  return new Date().toISOString();
}

/** Today's date in the application timezone. */
function todayOf_(ctx) {
  if (ctx && typeof ctx.today === 'function') return ctx.today();
  if (ctx && typeof ctx.today === 'string') return ctx.today;
  return new Date().toISOString().substring(0, 10);
}

/**
 * Reads a field of a session object.
 * The context may expose the sheet column names (ExpiresAt) or the raw D1
 * column names (expires_at) - both are accepted.
 */
function sessionField_(session, header, column) {
  if (!session) return '';
  const v = session[header];
  if (v !== undefined && v !== null) return v;
  const alt = session[column];
  return (alt === undefined || alt === null) ? '' : alt;
}

/** Validates a required string field. */
function requireText_(value, label, maxLen) {
  const v = String(value === null || value === undefined ? '' : value).trim();
  if (!v) throw error_('VALIDATION', 'กรุณากรอก' + label);
  if (maxLen && v.length > maxLen) {
    throw error_('VALIDATION', label + 'ยาวเกิน ' + maxLen + ' ตัวอักษร');
  }
  return v;
}

/** Validates a password policy. */
function validatePassword_(pwd) {
  const v = String(pwd || '');
  if (v.length < 6) return { ok: false, message: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' };
  if (v.length > 100) return { ok: false, message: 'รหัสผ่านยาวเกินไป' };
  return { ok: true, message: '' };
}

/** Random salt. */
function generateSalt_() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

/** Random monitor access key. */
function generateAccessKey_() {
  return 'MON-' + crypto.randomUUID().replace(/-/g, '').substring(0, 16).toUpperCase();
}

/** Timing-safe-ish string comparison. */
function safeEqual_(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * Compares two identifiers regardless of whether one of them is a number.
 * A numeric student/user id must still match the text sent by the browser.
 */
function idEq_(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a).trim() === String(b).trim();
}

/**
 * Converts a cell value into a JSON-safe string.
 * D1 always returns text, so this is only a safety net for Date objects.
 */
function cellToString_(value) {
  if (!(value instanceof Date)) return value;
  if (isNaN(value.getTime())) return '';
  return value.toISOString().replace('T', ' ').substring(0, 19);
}

/** Converts a spreadsheet row object into a plain serialisable object. */
function plain_(row) {
  const out = {};
  Object.keys(row || {}).forEach(function (k) {
    if (k === '__row') return;
    out[k] = cellToString_(row[k]);
  });
  return out;
}

/** Sorts an array of objects by a key (string compare, null safe). */
function sortBy_(arr, key, desc) {
  return arr.slice().sort(function (a, b) {
    const x = String(a[key] === undefined || a[key] === null ? '' : a[key]);
    const y = String(b[key] === undefined || b[key] === null ? '' : b[key]);
    const r = x.localeCompare(y, 'th', { numeric: true });
    return desc ? -r : r;
  });
}

/** Generates a sequential-ish identifier with a prefix. */
function nextId_(prefix, existing) {
  let max = 0;
  (existing || []).forEach(function (row) {
    const id = String(row || '');
    const m = id.match(/(\d+)\s*$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

/** Cache read - best effort, the cache is an optimisation only. */
async function cacheGet_(ctx, key, seconds) {
  if (ctx && typeof ctx.cacheGet === 'function') {
    try { return await ctx.cacheGet(key, seconds); } catch (err) { return null; }
  }
  return null;
}

/** Cache write - best effort, the cache is an optimisation only. */
async function cachePut_(ctx, key, value, seconds) {
  if (ctx && typeof ctx.cachePut === 'function') {
    try { await ctx.cachePut(key, value, seconds); } catch (err) { /* ignore */ }
  }
}

/** The current data version - used by the monitor polling. */
async function currentDataVersion_(ctx) {
  if (ctx && typeof ctx.currentDataVersion === 'function') {
    try { return await ctx.currentDataVersion(); } catch (err) { /* fall through */ }
  }
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  return parseInt(settings.DataVersion || '1', 10);
}

/** Increments the global data version used by monitor polling. */
async function bumpDataVersion_(ctx) {
  if (ctx && typeof ctx.bumpDataVersion === 'function') {
    try { return await ctx.bumpDataVersion(); } catch (err) { /* fall through */ }
  }
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  const v = parseInt(settings.DataVersion || '1', 10) + 1;
  await writeKeyValue(ctx.d1, SHEETS.SETTINGS, 'DataVersion', String(v), nowOf_(ctx));
  return v;
}

/** The identifier of the database - the spreadsheet id in the original. */
function dbId_(ctx) {
  if (ctx && ctx.db && typeof ctx.db.getId === 'function') return ctx.db.getId();
  return 'd1:ssms';
}

/** The address of the database - the spreadsheet url in the original. */
function dbUrl_(ctx) {
  if (ctx && ctx.db && typeof ctx.db.getUrl === 'function') return ctx.db.getUrl();
  return 'd1://ssms';
}

/** The name of the database - the spreadsheet name in the original. */
function dbName_(ctx) {
  if (ctx && ctx.db && typeof ctx.db.getName === 'function') return ctx.db.getName();
  return APP.SHORT_NAME;
}

/**
 * Re-entrancy guards.
 *
 * The context may implement ctx.requireSession / ctx.requirePermission /
 * ctx.logAudit by calling the functions of this module. The flags make sure
 * that such a call falls back to the database implementation instead of
 * calling itself again.
 */
let resolvingSession_ = false;
let resolvingPermission_ = false;
let writingAudit_ = false;

/* ==========================================================================
 * SECTION 3: SYSTEM INFORMATION / BOOTSTRAP
 * ========================================================================== */

/**
 * Public bootstrap information for the login screen.
 * Contains no secrets and no personal data.
 */
export async function systemPublicInfo_(ctx, payload) {
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  return {
    appName: APP.NAME,
    version: APP.VERSION,
    schoolName: settings.SchoolName || APP.NAME,
    academicYear: settings.AcademicYear || '',
    semester: settings.Semester || '',
    // Whether the default account hint is shown on the login screen.
    showDefaultAccounts: String(settings.ShowDefaultAccounts || 'true') === 'true',
    defaultUsername: APP.DEFAULT_ADMIN_USERNAME,
    initialized: true
  };
}

/** Public bootstrap information (no secrets, no personal data). */
export async function systemInfo_(ctx, payload) {
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  const info = {
    appName: APP.NAME,
    version: APP.VERSION,
    timezone: APP.TIMEZONE,
    schoolName: settings.SchoolName || APP.NAME,
    academicYear: settings.AcademicYear || '',
    semester: settings.Semester || '',
    initialized: true
  };
  // The database coordinates are only revealed to an authenticated admin.
  try {
    await requirePermission_(ctx, payload.token, 'settings.view');
    info.spreadsheetId = dbId_(ctx);
    info.spreadsheetName = dbName_(ctx);
    info.spreadsheetUrl = dbUrl_(ctx);
    // The same values under the names the Cloudflare frontend uses.
    info.databaseId = info.spreadsheetId;
    info.databaseName = info.spreadsheetName;
    info.databaseUrl = info.spreadsheetUrl;
  } catch (err) {
    info.spreadsheetUrl = '';
    info.databaseUrl = '';
  }
  return info;
}

/** Returns the public URL of the web app deployment. */
export async function systemWebAppUrl_(ctx, payload) {
  await requirePermission_(ctx, payload.token, 'settings.view');
  return { webAppUrl: (ctx && ctx.webAppUrl) ? String(ctx.webAppUrl) : '' };
}

/**
 * Ensures the database exists and returns the bootstrap payload.
 *
 * The schema is created by schema/001_schema.sql and the default data is
 * seeded by seedDefaults_(), so there is nothing to create here any more -
 * the function only confirms that the database is ready.
 */
export async function systemSetup_(ctx, payload) {
  await requirePermission_(ctx, payload.token, 'settings.manage');
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);

  // The readiness flag lives in the app_meta table (the script properties of
  // the original). It documents that the schema is in place.
  if (ctx && ctx.meta && typeof ctx.meta.set === 'function') {
    try {
      await ctx.meta.set('schemaVersion', APP.SCHEMA_VERSION);
      await ctx.meta.set('databaseReadyAt', nowOf_(ctx));
    } catch (err) {
      // The meta table is a nicety - the setup must not fail because of it.
    }
  }

  return {
    ok: true,
    spreadsheetId: dbId_(ctx),
    spreadsheetUrl: dbUrl_(ctx),
    monitorAccessKey: settings.MonitorAccessKey || '',
    note: 'ฐานข้อมูลถูกสร้าง/ตรวจสอบเรียบร้อยแล้ว'
  };
}

/**
 * Makes sure the database is ready to be used.
 *
 * The tables are created by schema/001_schema.sql (once, through the D1
 * console or `wrangler d1 execute`). This function only fills the database
 * with the default settings and the first accounts when it is still empty.
 *
 * The flag "the database is ready" is kept in the edge cache, so a normal
 * request does not have to ask the database at all. Only the first request
 * after the cache expired (one hour) reads the flag from D1.
 *
 * @param {Object} ctx
 * @returns {Promise<boolean>} - true when something was written
 */
export async function ensureDatabase_(ctx) {
  // The fast path: the cache says the database is ready.
  const cached = await ctx.cacheGet('db_ready', 3600);
  if (cached === '1') return false;

  // The slow path: ask the database once.
  let seeded = '';
  try {
    seeded = await ctx.meta.get('schemaVersion');
  } catch (err) {
    seeded = '';
  }
  if (seeded === APP.SCHEMA_VERSION) {
    await ctx.cachePut('db_ready', '1', 3600);
    return false;
  }

  const users = await readTable(ctx.d1, SHEETS.USERS);
  if (!users.length) {
    await seedDefaults_(ctx);
  }
  try {
    await ctx.meta.set('schemaVersion', APP.SCHEMA_VERSION);
  } catch (err) {
    /* the meta table is a nicety - the setup must not fail because of it */
  }
  await ctx.cachePut('db_ready', '1', 3600);
  return true;
}

/**
 * Seeds default settings, monitor settings and the first Super Admin.
 *
 * Idempotent: only the keys that do not exist yet are written, and the seed
 * accounts are only created while the Users table is still empty.
 */
export async function seedDefaults_(ctx) {
  const now = nowOf_(ctx);
  const defaults = {
    SchoolName: 'โรงเรียนตัวอย่าง',
    SchoolLogoUrl: '',
    AcademicYear: String(new Date().getFullYear() + 543),
    Semester: '1',
    GradeLevels: 'ป.1,ป.2,ป.3,ป.4,ป.5,ป.6,ม.1,ม.2,ม.3',
    AttendanceRounds: 'HOMEROOM,RELIGIOUS,GENERAL',
    SystemColor: '#4361ee',
    SessionTimeoutMinutes: '480',
    /** Show the default account hint on the login screen. */
    ShowDefaultAccounts: 'true',
    /** Which classroom system round 1 follows - RELIGIOUS or GENERAL. */
    Round1RoomType: 'RELIGIOUS',
    /** Grade levels that count as secondary (middleschool). Empty = auto detect. */
    SecondaryGradeLevels: '',
    /** Grade levels of the religious classrooms (empty = same as GradeLevels). */
    ReligiousGradeLevels: '',
    MonitorAccessKey: generateAccessKey_(),
    DataVersion: '1'
  };
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  for (const k of Object.keys(defaults)) {
    if (settings[k] === undefined) {
      await writeKeyValue(ctx.d1, SHEETS.SETTINGS, k, defaults[k], now);
    }
  }

  const monitorDefaults = {
    Title: 'ระบบจอมอนิเตอร์โรงเรียน',
    Template: 'midnight',
    RotationAttendanceSeconds: '30',
    RotationLeaveSeconds: '20',
    RotationAnnouncementSeconds: '25',
    ShowAttendance: 'true',
    ShowLeaves: 'true',
    ShowAnnouncements: 'true',
    PollIntervalSeconds: '10',
    DefaultAnimationType: 'MARQUEE',
    DefaultFontSize: '48',
    DefaultTextColor: '#ffffff',
    DefaultBackgroundColor: '#4361ee',
    DefaultAnimationSpeed: '50',
    ItemsPerPage: '0',
    AbsenceCardColumns: '2',
    LeaveCardColumns: '2',
    LeaveItemsPerPage: '0',
    LeaveFontSize: '0',
    ShowPendingAnomalies: 'true',
    FooterText: ''
  };
  const monitor = await readKeyValue(ctx.d1, SHEETS.MONITOR);
  for (const k of Object.keys(monitorDefaults)) {
    if (monitor[k] === undefined) {
      await writeKeyValue(ctx.d1, SHEETS.MONITOR, k, monitorDefaults[k], now);
    }
  }

  // Seed accounts (only once).
  const users = await readTable(ctx.d1, SHEETS.USERS);
  if (!users.length) {
    const salt = generateSalt_();
    const hash = await hashPassword_(APP.DEFAULT_ADMIN_PASSWORD, salt);
    const rowsUsers = [
      {
        UserID: 'USR-0001', Username: APP.DEFAULT_ADMIN_USERNAME, PasswordHash: hash, Salt: salt,
        FullName: 'ผู้ดูแลระบบสูงสุด', Role: ROLES.SUPER_ADMIN, Email: '', Phone: '',
        Status: 'ACTIVE', LastLoginAt: '', CreatedAt: now, UpdatedAt: now
      },
      {
        UserID: 'USR-0002', Username: 'admin', PasswordHash: hash, Salt: salt,
        FullName: 'ผู้ดูแลระบบ', Role: ROLES.ADMIN, Email: '', Phone: '',
        Status: 'ACTIVE', LastLoginAt: '', CreatedAt: now, UpdatedAt: now
      }
    ];
    await upsertRows(ctx.d1, SHEETS.USERS, rowsUsers);
  } else {
    // Self-heal: an account created by an older hash algorithm can never be
    // verified, so its credentials must be re-issued.
    //   - the seeded accounts get the documented default password back
    //   - every other legacy account gets a random password and must be
    //     reset by an administrator after signing in
    const legacy = users.filter(function (u) {
      return String(u.PasswordHash || '').indexOf(APP.HASH_PREFIX) !== 0;
    });
    for (const u of legacy) {
      const username = String(u.Username || '').toLowerCase();
      const isSeed = username === APP.DEFAULT_ADMIN_USERNAME || username === 'admin';
      const tempPassword = isSeed
        ? APP.DEFAULT_ADMIN_PASSWORD
        : ('Reset-' + crypto.randomUUID().replace(/-/g, '').substring(0, 12));
      const salt = generateSalt_();
      await updateCellByKey(ctx.d1, SHEETS.USERS, 'UserID', u.UserID, 'PasswordHash',
        await hashPassword_(tempPassword, salt));
      await updateCellByKey(ctx.d1, SHEETS.USERS, 'UserID', u.UserID, 'Salt', salt);
      await updateCellByKey(ctx.d1, SHEETS.USERS, 'UserID', u.UserID, 'UpdatedAt', now);
      console.log('Re-issued legacy password hash for user ' + u.UserID +
        (isSeed ? ' (seed account, default password restored).' : ' (temporary password assigned, admin reset required).'));
    }
  }

  return { ok: true };
}

/* ==========================================================================
 * SECTION 4: AUTHENTICATION
 * ========================================================================== */

/** Login: verifies credentials, creates a session and returns a bearer token. */
export async function login_(ctx, payload) {
  const username = String(payload.username || '').trim().toLowerCase();
  const password = String(payload.password || '');
  if (!username || !password) {
    throw error_('VALIDATION', 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');
  }
  const users = await readTable(ctx.d1, SHEETS.USERS);
  const user = users.filter(function (u) {
    return String(u.Username || '').trim().toLowerCase() === username;
  })[0];
  if (!user) {
    throw error_('AUTH', 'ไม่พบผู้ใช้งานนี้ในระบบ');
  }
  if (String(user.Status || 'ACTIVE').toUpperCase() !== 'ACTIVE') {
    throw error_('AUTH', 'บัญชีของคุณถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
  }
  const check = await verifyPassword_(password, String(user.Salt || ''), String(user.PasswordHash || ''));
  if (check === 'LEGACY') {
    // The account was created with an older algorithm - force a reset.
    await logAudit_(ctx, { username: username, action: 'LOGIN_LEGACY_HASH', entity: 'Users', entityId: user.UserID, details: 'ต้องตั้งรหัสผ่านใหม่' });
    throw error_('AUTH', 'บัญชีนี้ใช้รหัสผ่านรูปแบบเก่า กรุณาให้ผู้ดูแลระบบตั้งรหัสผ่านใหม่');
  }
  if (!check) {
    await logAudit_(ctx, { username: username, action: 'LOGIN_FAILED', entity: 'Users', details: 'รหัสผ่านไม่ถูกต้อง' });
    throw error_('AUTH', 'รหัสผ่านไม่ถูกต้อง');
  }
  const token = crypto.randomUUID() + '-' + crypto.randomUUID().replace(/-/g, '');
  const now = new Date();
  const expires = new Date(now.getTime() + APP.SESSION_TTL_SECONDS * 1000);

  // The original compacted the Sessions sheet: the expired sessions were
  // dropped and the remaining ones were rewritten. In D1 the expired rows are
  // simply deleted - the remaining rows stay untouched.
  await ctx.d1.prepare('DELETE FROM sessions WHERE CAST(expires_at AS INTEGER) <= ?')
    .bind(now.getTime()).run();

  await ctx.d1.prepare(
    'INSERT INTO sessions (session_id, user_id, username, role, token_hash, created_at, expires_at, last_seen_at, user_agent) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    crypto.randomUUID(),
    String(user.UserID || ''),
    String(user.Username || ''),
    String(user.Role || ''),
    await sha256_(token),
    nowOf_(ctx),
    String(expires.getTime()),
    nowOf_(ctx),
    String(payload.userAgent || '').slice(0, 120)
  ).run();

  // Stamp last login.
  await updateCellByKey(ctx.d1, SHEETS.USERS, 'UserID', user.UserID, 'LastLoginAt', nowOf_(ctx));
  await logAudit_(ctx, { userId: user.UserID, username: user.Username, role: user.Role, action: 'LOGIN', entity: 'Users', entityId: user.UserID, details: 'เข้าสู่ระบบ' });
  return {
    token: token,
    expiresAt: nowOf_(ctx),
    user: publicUser_(user),
    permissions: permissionsFor_(user.Role)
  };
}

/** Logout: invalidates the session token. */
export async function logout_(ctx, payload) {
  const token = String(payload.token || '');
  if (!token) return { ok: true };
  const hash = await sha256_(token);
  const sessions = await readTable(ctx.d1, SHEETS.SESSIONS);
  const hit = sessions.filter(function (s) { return String(s.TokenHash || '') === hash; })[0];
  if (hit) {
    await deleteRowsByKey(ctx.d1, SHEETS.SESSIONS, 'SessionID', [hit.SessionID]);
    await logAudit_(ctx, { userId: hit.UserID, username: hit.Username, role: hit.Role, action: 'LOGOUT', entity: 'Users', entityId: hit.UserID, details: 'ออกจากระบบ' });
  }
  return { ok: true };
}

/** Returns the profile of the currently authenticated user. */
export async function me_(ctx, payload) {
  const session = await requireSession_(ctx, payload.token);
  const users = await readTable(ctx.d1, SHEETS.USERS);
  const user = users.filter(function (u) {
    return idEq_(u.UserID, sessionField_(session, 'UserID', 'user_id'));
  })[0];
  if (!user) throw error_('AUTH', 'ไม่พบข้อมูลผู้ใช้งาน');
  return {
    user: publicUser_(user),
    permissions: permissionsFor_(user.Role),
    expiresAt: sessionField_(session, 'ExpiresAt', 'expires_at')
  };
}

/** Self service password change. */
export async function changePassword_(ctx, payload) {
  const session = await requireSession_(ctx, payload.token);
  const users = await readTable(ctx.d1, SHEETS.USERS);
  const user = users.filter(function (u) {
    return idEq_(u.UserID, sessionField_(session, 'UserID', 'user_id'));
  })[0];
  if (!user) throw error_('AUTH', 'ไม่พบข้อมูลผู้ใช้งาน');
  const current = String(payload.currentPassword || '');
  const next = String(payload.newPassword || '');
  const currentHash = await hashPassword_(current, String(user.Salt || ''));
  if (!safeEqual_(currentHash, String(user.PasswordHash || ''))) {
    throw error_('AUTH', 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
  }
  const v = validatePassword_(next);
  if (!v.ok) throw error_('VALIDATION', v.message);
  const salt = generateSalt_();
  await updateCellByKey(ctx.d1, SHEETS.USERS, 'UserID', user.UserID, 'PasswordHash',
    await hashPassword_(next, salt));
  await updateCellByKey(ctx.d1, SHEETS.USERS, 'UserID', user.UserID, 'Salt', salt);
  await updateCellByKey(ctx.d1, SHEETS.USERS, 'UserID', user.UserID, 'UpdatedAt', nowOf_(ctx));
  await logAudit_(ctx, { userId: user.UserID, username: user.Username, role: user.Role, action: 'CHANGE_PASSWORD', entity: 'Users', entityId: user.UserID, details: 'เปลี่ยนรหัสผ่าน' });
  return { ok: true };
}

/* ==========================================================================
 * SECTION 5: AUTHORIZATION
 * ========================================================================== */

/** Permissions granted to a role. */
export function permissionsFor_(role) {
  const list = ROLE_PERMISSIONS[role] || [];
  if (list.indexOf('*') !== -1) {
    const all = [];
    Object.keys(ROLE_PERMISSIONS).forEach(function (r) {
      if (r !== ROLES.SUPER_ADMIN) ROLE_PERMISSIONS[r].forEach(function (p) { if (all.indexOf(p) === -1) all.push(p); });
    });
    all.push('*');
    return all;
  }
  return list.slice();
}

/**
 * Resolves the session for a bearer token.
 * The real implementation lives on the request context - this wrapper keeps
 * the module usable on its own and falls back to the database.
 */
export async function requireSession_(ctx, token) {
  if (ctx && typeof ctx.requireSession === 'function' && !resolvingSession_) {
    resolvingSession_ = true;
    try {
      return await ctx.requireSession(token);
    } finally {
      resolvingSession_ = false;
    }
  }
  const t = String(token || '');
  if (!t) throw error_('AUTH', 'กรุณาเข้าสู่ระบบก่อนใช้งาน');
  const hash = await sha256_(t);
  const sessions = await readTable(ctx.d1, SHEETS.SESSIONS);
  const session = sessions.filter(function (s) { return String(s.TokenHash || '') === hash; })[0];
  if (!session) throw error_('AUTH', 'เซสชันไม่ถูกต้องหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  const expiresAt = Number(session.ExpiresAt);
  if (!isNaN(expiresAt) && expiresAt < new Date().getTime()) {
    throw error_('AUTH', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  }
  return session;
}

/** Throws unless the session holds the requested permission. */
export async function requirePermission_(ctx, token, permission) {
  if (ctx && typeof ctx.requirePermission === 'function' && !resolvingPermission_) {
    resolvingPermission_ = true;
    try {
      return await ctx.requirePermission(token, permission);
    } finally {
      resolvingPermission_ = false;
    }
  }
  const session = await requireSession_(ctx, token);
  const perms = permissionsFor_(sessionField_(session, 'Role', 'role'));
  if (perms.indexOf('*') === -1 && perms.indexOf(permission) === -1) {
    await logAudit_(ctx, {
      userId: sessionField_(session, 'UserID', 'user_id'),
      username: sessionField_(session, 'Username', 'username'),
      role: sessionField_(session, 'Role', 'role'),
      action: 'ACCESS_DENIED', entity: 'API', details: permission
    });
    throw error_('FORBIDDEN', 'คุณไม่มีสิทธิ์ในการดำเนินการนี้');
  }
  return session;
}

/**
 * Teacher scope: a teacher may only record attendance for classrooms that are
 * assigned to them through Settings ("ClassTeacher.<ClassID>").
 * The value may hold the teacher username or the teacher id.
 */
export async function teacherClassScope_(ctx, session) {
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  // Resolve the teacher record to also match by TeacherID.
  const teachers = await readTable(ctx.d1, SHEETS.TEACHERS);
  const sessionUsername = String(sessionField_(session, 'Username', 'username') || '');
  const teacher = teachers.filter(function (t) {
    return String(t.Username || '').toLowerCase() === sessionUsername.toLowerCase();
  })[0];
  const identifiers = [sessionUsername];
  if (teacher) identifiers.push(String(teacher.TeacherID || ''));

  const scope = [];
  // The username is stored in lower case by the login, while the assignment
  // is typed by an administrator - the comparison ignores the case.
  const ids = identifiers.map(function (v) { return String(v).toLowerCase(); });
  Object.keys(settings).forEach(function (k) {
    if (k.indexOf('ClassTeacher.') !== 0) return;
    const value = String(settings[k] || '').trim().toLowerCase();
    if (!value) return;
    if (ids.indexOf(value) !== -1) scope.push(k.substring('ClassTeacher.'.length));
  });
  return scope;
}

/**
 * Validates that the session may record attendance for the given round/class.
 */
export function assertAttendanceScope_(session, round, classId) {
  // Every member of the staff may check names. The classroom assignment
  // (ClassTeacher) only tells who is the homeroom teacher of a classroom -
  // it does not limit who is allowed to record.
  const allowed = [
    ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER,
    ROLES.ATTENDANCE_OFFICER, ROLES.ANNOUNCEMENT_OFFICER
  ];
  if (allowed.indexOf(sessionField_(session, 'Role', 'role')) !== -1) return true;
  throw error_('FORBIDDEN', 'บทบาทของคุณไม่สามารถบันทึกการเช็คชื่อได้');
}

/* ==========================================================================
 * SECTION 6: USER MANAGEMENT
 * ========================================================================== */

/** Public (safe) representation of a user record. */
export function publicUser_(u) {
  return {
    UserID: u.UserID,
    Username: u.Username,
    FullName: u.FullName,
    Role: u.Role,
    Email: u.Email,
    Phone: u.Phone,
    Status: u.Status,
    // Converted to text - a Date here would make the whole login response
    // arrive at the browser as null.
    LastLoginAt: cellToString_(u.LastLoginAt),
    CreatedAt: cellToString_(u.CreatedAt)
  };
}

/** Lists users (admin only). */
export async function listUsers_(ctx, payload) {
  await requirePermission_(ctx, payload.token, 'user.view');
  let rows = (await readTable(ctx.d1, SHEETS.USERS)).map(publicUser_);
  const q = String(payload.q || '').toLowerCase();
  const role = String(payload.role || '');
  const status = String(payload.status || '');
  if (q) {
    rows = rows.filter(function (r) {
      return [r.Username, r.FullName, r.UserID, r.Email].join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }
  if (role) rows = rows.filter(function (r) { return r.Role === role; });
  if (status) rows = rows.filter(function (r) { return r.Status === status; });
  rows = sortBy_(rows, 'Username');
  return { rows: rows, total: rows.length };
}

/** Creates or updates a user. */
export async function saveUser_(ctx, payload) {
  const session = await requirePermission_(ctx, payload.token, 'user.manage');
  const data = payload.user || {};
  const isNew = !data.UserID;
  const username = requireText_(String(data.Username || '').trim().toLowerCase(), 'ชื่อผู้ใช้', 40);
  const fullName = requireText_(data.FullName, 'ชื่อ-นามสกุล', 120);
  const role = String(data.Role || '').toUpperCase();
  if (!ROLES[role]) throw error_('VALIDATION', 'บทบาทผู้ใช้งานไม่ถูกต้อง');
  const status = String(data.Status || 'ACTIVE').toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';

  const users = await readTable(ctx.d1, SHEETS.USERS);
  const dup = users.filter(function (u) {
    return String(u.Username || '').toLowerCase() === username && u.UserID !== data.UserID;
  })[0];
  if (dup) throw error_('VALIDATION', 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว');

  let userId = data.UserID;
  if (isNew) {
    const pwd = String(data.Password || '');
    const v = validatePassword_(pwd);
    if (!v.ok) throw error_('VALIDATION', v.message);
    userId = nextId_('USR', users.map(function (u) { return u.UserID; }));
    const salt = generateSalt_();
    const record = {
      UserID: userId, Username: username, PasswordHash: await hashPassword_(pwd, salt), Salt: salt,
      FullName: fullName, Role: role, Email: data.Email || '', Phone: data.Phone || '',
      Status: status, LastLoginAt: '', CreatedAt: nowOf_(ctx), UpdatedAt: nowOf_(ctx)
    };
    await upsertRows(ctx.d1, SHEETS.USERS, [record]);
  } else {
    const existing = users.filter(function (u) { return idEq_(u.UserID, userId); })[0];
    if (!existing) throw error_('VALIDATION', 'ไม่พบผู้ใช้งานที่ต้องการแก้ไข');
    const record = {
      UserID: userId, Username: username, PasswordHash: existing.PasswordHash, Salt: existing.Salt,
      FullName: fullName, Role: role, Email: data.Email || '', Phone: data.Phone || '',
      Status: status, LastLoginAt: existing.LastLoginAt, CreatedAt: existing.CreatedAt, UpdatedAt: nowOf_(ctx)
    };
    if (data.Password) {
      const v = validatePassword_(String(data.Password));
      if (!v.ok) throw error_('VALIDATION', v.message);
      record.Salt = generateSalt_();
      record.PasswordHash = await hashPassword_(String(data.Password), record.Salt);
    }
    await upsertRows(ctx.d1, SHEETS.USERS, [record]);
  }
  await logAudit_(ctx, {
    userId: sessionField_(session, 'UserID', 'user_id'),
    username: sessionField_(session, 'Username', 'username'),
    role: sessionField_(session, 'Role', 'role'),
    action: isNew ? 'CREATE' : 'UPDATE', entity: 'Users', entityId: userId, details: username
  });
  await bumpDataVersion_(ctx);
  return { ok: true, UserID: userId };
}

/** Deletes a user (cannot delete yourself or the last super admin). */
export async function deleteUser_(ctx, payload) {
  const session = await requirePermission_(ctx, payload.token, 'user.manage');
  const id = requireText_(payload.UserID, 'รหัสผู้ใช้งาน');
  const sessionUserId = String(sessionField_(session, 'UserID', 'user_id') || '');
  if (id === sessionUserId) throw error_('VALIDATION', 'ไม่สามารถลบบัญชีของตัวเองได้');
  const users = await readTable(ctx.d1, SHEETS.USERS);
  const target = users.filter(function (u) { return idEq_(u.UserID, id); })[0];
  if (!target) throw error_('VALIDATION', 'ไม่พบผู้ใช้งาน');
  if (target.Role === ROLES.SUPER_ADMIN) {
    const admins = users.filter(function (u) { return u.Role === ROLES.SUPER_ADMIN; });
    if (admins.length <= 1) throw error_('VALIDATION', 'ต้องมีผู้ดูแลระบบสูงสุดอย่างน้อย 1 บัญชี');
  }
  await deleteRowsByKey(ctx.d1, SHEETS.USERS, 'UserID', [id]);
  // remove sessions of the deleted user
  const sessions = await readTable(ctx.d1, SHEETS.SESSIONS);
  const dead = sessions.filter(function (s) { return idEq_(s.UserID, id); })
    .map(function (s) { return s.SessionID; });
  if (dead.length) await deleteRowsByKey(ctx.d1, SHEETS.SESSIONS, 'SessionID', dead);
  await logAudit_(ctx, {
    userId: sessionUserId,
    username: sessionField_(session, 'Username', 'username'),
    role: sessionField_(session, 'Role', 'role'),
    action: 'DELETE', entity: 'Users', entityId: id, details: target.Username
  });
  await bumpDataVersion_(ctx);
  return { ok: true };
}

/* ==========================================================================
 * SECTION 15b: SETTINGS & LOOKUP
 * ========================================================================== */

/** Reads the application settings. */
export async function getSettings_(ctx, payload) {
  await requirePermission_(ctx, payload.token, 'settings.view');
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  return {
    settings: settings,
    monitor: await readKeyValue(ctx.d1, SHEETS.MONITOR),
    roles: Object.keys(ROLES).map(function (k) { return { key: k, label: roleLabel_(k) }; }),
    leaveTypes: LEAVE_TYPES.map(function (k) { return { key: k, label: leaveTypeLabel_(k) }; }),
    animations: ANIMATIONS.map(function (k) { return { key: k, label: animationLabel_(k) }; }),
    classTypes: [
      { key: 'RELIGIOUS', label: 'ห้องเรียนวิชาศาสนา' },
      { key: 'GENERAL', label: 'ห้องเรียนวิชาสามัญ' },
      { key: 'HOMEROOM', label: 'ห้องประจำชั้น' }
    ]
  };
}

/** Thai label of a role. */
export function roleLabel_(role) {
  const map = {
    SUPER_ADMIN: 'ผู้ดูแลระบบสูงสุด', ADMIN: 'ผู้ดูแลระบบ', TEACHER: 'ครู',
    ATTENDANCE_OFFICER: 'เจ้าหน้าที่เช็คชื่อ', ANNOUNCEMENT_OFFICER: 'เจ้าหน้าที่ประกาศ',
    MONITOR: 'จอมอนิเตอร์'
  };
  return map[role] || role;
}

/** Thai label of a leave type. */
export function leaveTypeLabel_(type) {
  const map = {
    SICK: 'ลาป่วย', PERSONAL: 'ลากิจ', REST: 'ลาพักผ่อน',
    MATERNITY: 'ลาคลอด', OTHER: 'ลาประเภทอื่น ๆ'
  };
  return map[type] || type;
}

/** Thai label of an animation. */
export function animationLabel_(a) {
  const map = {
    MARQUEE: 'Marquee Text (ข้อความวิ่ง)', FLOATING: 'Floating Text (ตัวอักษรลอย)',
    FADE_LETTER: 'Fade In Letter (เฟดอินทีละตัว)', WORD_POPUP: 'Word Popup (ป๊อปอัปทีละคำ)',
    TYPEWRITER: 'Typewriter (พิมพ์ดีด)', FADE_IN: 'Fade In (ค่อย ๆ ปรากฏ)'
  };
  return map[a] || a;
}

/**
 * Returns the classroom system that round 1 follows.
 * The administrator decides in the settings.
 */
export function round1RoomType_(settings) {
  const v = String((settings || {}).Round1RoomType || 'RELIGIOUS').trim().toUpperCase();
  return v === 'GENERAL' ? 'GENERAL' : 'RELIGIOUS';
}

/**
 * True for the general classroom that means 'no general subject'.
 * That room is only a place holder - it never appears in the check list.
 */
export function isNoStudyClass_(room) {
  if (!room) return false;
  const type = String(room.ClassType || '').trim().toUpperCase();
  if (type !== 'GENERAL') return false;
  const name = String(room.ClassName || '').trim();
  const grade = String(room.GradeLevel || '').trim();
  return name === 'ไม่เรียน' || grade === 'ไม่มี';
}

/** Grade levels of the religious classrooms (falls back to the normal list). */
export function religiousGradeLevels_(settings) {
  const religious = String((settings || {}).ReligiousGradeLevels || '').split(',')
    .map(function (s) { return s.trim(); }).filter(Boolean);
  if (religious.length) return religious;
  return String((settings || {}).GradeLevels || '').split(',')
    .map(function (s) { return s.trim(); }).filter(Boolean);
}

/** Assigns (or clears) the teacher responsible for a classroom. */
export async function assignClassTeacher_(ctx, payload) {
  const session = await requirePermission_(ctx, payload.token, 'settings.manage');
  const classId = requireText_(payload.ClassID, 'ห้องเรียน');
  const classes = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const room = classes.filter(function (c) { return idEq_(c.ClassID, classId); })[0];
  if (!room) throw error_('VALIDATION', 'ไม่พบห้องเรียนรหัส ' + classId);
  const teacher = String(payload.TeacherUsername || '').trim();
  const key = 'ClassTeacher.' + classId;
  if (!teacher) {
    // Remove the assignment.
    await deleteRowsByKey(ctx.d1, SHEETS.SETTINGS, 'Key', [key]);
  } else {
    await writeKeyValue(ctx.d1, SHEETS.SETTINGS, key, teacher, nowOf_(ctx));
  }
  await logAudit_(ctx, {
    userId: sessionField_(session, 'UserID', 'user_id'),
    username: sessionField_(session, 'Username', 'username'),
    role: sessionField_(session, 'Role', 'role'),
    action: 'ASSIGN_CLASS_TEACHER', entity: 'Settings', entityId: classId, details: teacher || '(ลบการมอบหมาย)'
  });
  await bumpDataVersion_(ctx);
  return { ok: true, settings: await readKeyValue(ctx.d1, SHEETS.SETTINGS) };
}

/** Saves the application settings (admin only). */
export async function saveSettings_(ctx, payload) {
  const session = await requirePermission_(ctx, payload.token, 'settings.manage');
  const data = payload.settings || {};
  const allowed = [
    'SchoolName', 'SchoolLogoUrl', 'AcademicYear', 'Semester', 'GradeLevels',
    'AttendanceRounds', 'SystemColor', 'SessionTimeoutMinutes', 'MonitorAccessKey',
    'ShowDefaultAccounts', 'Round1RoomType', 'SecondaryGradeLevels', 'ReligiousGradeLevels',
    'RoundOwnerHOMEROOM', 'RoundOwnerRELIGIOUS', 'RoundOwnerGENERAL'
  ];
  for (const k of allowed) {
    if (data[k] === undefined) continue;
    let v = data[k];
    if (k === 'SchoolName') v = requireText_(v, 'ชื่อโรงเรียน', 120);
    if (k === 'MonitorAccessKey') {
      v = String(v).trim();
      if (!/^[A-Za-z0-9\-_]{6,64}$/.test(v)) throw error_('VALIDATION', 'รหัสเข้าถึงจอมอนิเตอร์ต้องมี 6-64 ตัวอักษร');
    }
    await writeKeyValue(ctx.d1, SHEETS.SETTINGS, k, String(v), nowOf_(ctx));
  }
  await logAudit_(ctx, {
    userId: sessionField_(session, 'UserID', 'user_id'),
    username: sessionField_(session, 'Username', 'username'),
    role: sessionField_(session, 'Role', 'role'),
    action: 'SETTINGS_SAVE', entity: 'Settings', details: Object.keys(data).join(', ')
  });
  await bumpDataVersion_(ctx);
  return { ok: true, settings: await readKeyValue(ctx.d1, SHEETS.SETTINGS) };
}

/** Lookup data used by every dropdown in the UI. Requires an authenticated user. */
export async function lookupAll_(ctx, payload) {
  await requireSession_(ctx, payload.token);
  const cached = await cacheGet_(ctx, 'lookup', 120);
  const version = await currentDataVersion_(ctx);
  let lookup = cached;
  if (!cached || cached.version !== version) {
    const classes = (await readTable(ctx.d1, SHEETS.CLASSROOMS)).map(plain_);
    const teachers = (await readTable(ctx.d1, SHEETS.TEACHERS)).map(plain_);
    const students = (await readTable(ctx.d1, SHEETS.STUDENTS)).map(plain_);
    const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
    lookup = {
      version: version,
      schoolName: settings.SchoolName || '',
      academicYear: settings.AcademicYear || '',
      semester: settings.Semester || '',
      gradeLevels: String(settings.GradeLevels || '').split(',').map(function (g) { return g.trim(); }).filter(Boolean),
      // The religious classrooms run their own grade levels.
      religiousGradeLevels: religiousGradeLevels_(settings),
      // Which classroom system round 1 follows.
      round1RoomType: round1RoomType_(settings),
      secondaryGradeLevels: String(settings.SecondaryGradeLevels || '').split(',')
        .map(function (g) { return g.trim(); }).filter(Boolean),
      classes: classes.map(function (c) { return Object.assign({}, c, { noStudy: isNoStudyClass_(c) }); }),
      teachers: teachers.map(function (t) {
        return {
          TeacherID: t.TeacherID, name: ((t.FirstName || '') + ' ' + (t.LastName || '')).trim(),
          FirstName: t.FirstName, LastName: t.LastName, Position: t.Position,
          Department: t.Department, EmploymentStatus: t.EmploymentStatus, Username: t.Username
        };
      }),
      students: students.map(function (s) {
        return {
          StudentID: s.StudentID,
          name: ((s.ThaiFirstName || '') + ' ' + (s.ThaiLastName || '')).trim(),
          nameJawi: ((s.JawiFirstName || '') + ' ' + (s.JawiLastName || '')).trim(),
          ThaiFirstName: s.ThaiFirstName, ThaiLastName: s.ThaiLastName,
          JawiFirstName: s.JawiFirstName, JawiLastName: s.JawiLastName,
          GradeLevel: s.GradeLevel, ReligiousClassID: s.ReligiousClassID,
          GeneralClassID: s.GeneralClassID, HomeroomClassID: s.HomeroomClassID,
          StudentStatus: s.StudentStatus
        };
      }),
      leaveTypes: LEAVE_TYPES.map(function (k) { return { key: k, label: leaveTypeLabel_(k) }; }),
      roles: Object.keys(ROLES).map(function (k) { return { key: k, label: roleLabel_(k) }; }),
      animations: ANIMATIONS.map(function (k) { return { key: k, label: animationLabel_(k) }; })
    };
    await cachePut_(ctx, 'lookup', lookup, 300);
  }
  // The lookup payload is safe for any authenticated user.
  return lookup;
}

/* ==========================================================================
 * SECTION 17: AUDIT LOG
 * ========================================================================== */

/**
 * Writes an audit entry. Never throws - auditing must not break a request.
 * The audit log keeps the newest 2,000 entries, exactly like the sheet did.
 */
export async function logAudit_(ctx, entry) {
  try {
    // The router may provide its own audit writer - it is used when present so
    // that only one implementation writes into the table. The guard keeps a
    // router that delegates back to this function from looping.
    if (ctx && typeof ctx.logAudit === 'function' && !writingAudit_) {
      writingAudit_ = true;
      try {
        await ctx.logAudit(entry);
      } finally {
        writingAudit_ = false;
      }
      return;
    }
    const row = [
      crypto.randomUUID(),
      nowOf_(ctx),
      entry.userId || '',
      entry.username || '',
      entry.role || '',
      entry.action || '',
      entry.entity || '',
      entry.entityId || '',
      String(entry.details || '').slice(0, 500)
    ];
    await ctx.d1.prepare(
      'INSERT INTO audit_logs (log_id, timestamp, user_id, username, role, action, entity, entity_id, details) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(...row).run();
    // Trim the log to the newest 2000 entries (the oldest rows are dropped).
    await ctx.d1.prepare(
      'DELETE FROM audit_logs WHERE rowid NOT IN (SELECT rowid FROM audit_logs ORDER BY rowid DESC LIMIT 2000)'
    ).run();
  } catch (err) {
    console.log('audit error: ' + err);
  }
}

/** Lists audit entries (admin only). */
export async function listAudit_(ctx, payload) {
  await requirePermission_(ctx, payload.token, 'audit.view');
  let rows = (await readTable(ctx.d1, SHEETS.AUDIT)).map(plain_);
  const q = String(payload.q || '').toLowerCase();
  if (q) {
    rows = rows.filter(function (r) {
      return [r.Username, r.Action, r.Entity, r.Details].join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }
  rows = rows.slice().reverse();
  const limit = Math.min(Number(payload.limit || 300), APP.MAX_PAGE_ROWS);
  return { rows: rows.slice(0, limit), total: rows.length };
}

/* ==========================================================================
 * DATABASE USAGE
 * ========================================================================== */

/**
 * The usage of the database and the forecast for the coming years.
 * The forecast uses the current data - it shows how many years the school can
 * use the system with the same amount of data.
 */
export async function databaseUsage_(ctx, payload) {
  await requirePermission_(ctx, payload.token, 'settings.view');
  const sheets = [];
  let total = 0;
  for (const key of Object.keys(SHEETS)) {
    const name = SHEETS[key];
    const headers = HEADERS[name] || [];
    const rows = await countRows(ctx.d1, name);
    const cols = Math.max(headers.length, 0);
    const cells = rows * cols;
    total += cells;
    sheets.push({ name: name, rows: rows, columns: cols, cells: cells });
  }
  sheets.sort(function (a, b) { return b.cells - a.cells; });

  // The forecast: the attendance rows of one school day.
  const dayRows = await readRowsByDate(ctx.d1, SHEETS.ATT_DAILY, 'AttendanceDate', todayOf_(ctx), ['DayID']);
  const perDay = dayRows.length || 1;
  const daysPerYear = 200;
  const attendancePerYear = perDay * daysPerYear * 7;
  const leaves = (await readTable(ctx.d1, SHEETS.LEAVES)).length;
  const leavesPerYear = Math.max(20, Math.round(leaves * (daysPerYear / 180)));
  const auditRows = Math.min(2000, (await readTable(ctx.d1, SHEETS.AUDIT)).length);
  const perYear = attendancePerYear + leavesPerYear * 8 + auditRows * 9;
  const limit = 10000000;
  const years = perYear > 0 ? Math.floor((limit - total) / perYear) : 99;

  return {
    sheets: sheets,
    totalCells: total,
    limitCells: limit,
    usedPercent: Math.round(total * 10000 / limit) / 100,
    perYearCells: perYear,
    attendanceRowsPerDay: perDay,
    forecastYears: years,
    forecastText: years >= 90 ? 'มากกว่า 90 ปี' : (years + ' ปี')
  };
}
