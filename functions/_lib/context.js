/**
 * ============================================================================
 *  SSMS on Cloudflare - Request context
 * ============================================================================
 *
 *  The context carries everything a handler needs: the database, the cache,
 *  the session helpers and the small utilities that the original code used
 *  as global functions.
 * ============================================================================
 */

import { SHEETS, ROLE_PERMISSIONS, ROLES } from './constants.js';
import {
  error_, jsonSafe_, now_, today_, formatDate_, normalizeDate_, normalizeDateTime_,
  hashPassword_, verifyPassword_, sha256_, generateSalt_, generateAccessKey_,
  generateToken_, sortBy_, plain_, cellToString_, dateRange_, daysBefore_,
  cacheGet_, cachePut_, cacheRemove_, clearAppCache_, packTable_, unpackTable_,
  idEq_, isIdField_, nextId_, requireText_, validatePassword_, escapeHtml_, compact_,
  safeEqual_
} from './util.js';
import {
  readTable, readKeyValue, writeKeyValue, upsertRows, deleteRowsByKey,
  updateCellByKey, countRows, readRowsByDate, readRowsByDateRange
} from './db.js';

export {
  error_, jsonSafe_, now_, today_, formatDate_, normalizeDate_, normalizeDateTime_,
  hashPassword_, verifyPassword_, sha256_, generateSalt_, generateAccessKey_,
  generateToken_, sortBy_, plain_, cellToString_, dateRange_, daysBefore_,
  idEq_, isIdField_, nextId_, requireText_, validatePassword_, escapeHtml_,
  compact_, safeEqual_, packTable_, unpackTable_,
  readTable, readKeyValue, writeKeyValue, upsertRows, deleteRowsByKey,
  updateCellByKey, countRows, readRowsByDate, readRowsByDateRange
};

/**
 * Permissions granted to a role - identical to the original permissionsFor_().
 */
export function permissionsFor_(role) {
  const list = ROLE_PERMISSIONS[role] || [];
  if (list.indexOf('*') !== -1) {
    const all = [];
    Object.keys(ROLE_PERMISSIONS).forEach((r) => {
      if (r !== ROLES.SUPER_ADMIN) {
        ROLE_PERMISSIONS[r].forEach((p) => { if (all.indexOf(p) === -1) all.push(p); });
      }
    });
    all.push('*');
    return all;
  }
  return list.slice();
}

/**
 * Creates the context of one request.
 *
 * @param {Object} env - the bindings of the Pages Function
 * @param {Request} request - the incoming request
 * @param {Cache} cache - the edge cache
 */
export function createContext(env, request, cache) {
  const ctx = {
    d1: env.DB,
    env,
    cache,
    request,
    /** The public address of the web app - used for the monitor link. */
    webAppUrl: publicUrl_(request),
    now: () => now_(),
    today: () => today_(),
    cacheGet: (key, seconds) => cacheGet_(cache, key, seconds),
    cachePut: (key, value, seconds) => cachePut_(cache, key, value, seconds),
    cacheRemove: (key) => cacheRemove_(cache, key),
    clearCache: (keys) => clearAppCache_(cache, keys)
  };

  // --- the database itself (replaces the spreadsheet object) -------------
  // The original code asked the spreadsheet for its id, its name and its
  // address. In D1 the name comes from the binding and the address from the
  // Cloudflare dashboard.
  ctx.db = {
    getId: () => 'd1:ssms',
    getName: () => (env.DB_NAME || 'ssms'),
    getUrl: () => (env.DB_URL || 'd1://ssms')
  };

  // --- metadata (replaces PropertiesService) ---------------------------
  ctx.meta = {
    async get(key) {
      const row = await ctx.d1.prepare('SELECT value FROM app_meta WHERE key = ?')
        .bind(String(key)).first();
      return row ? String(row.value) : '';
    },
    async set(key, value) {
      await ctx.d1.prepare(
        'INSERT INTO app_meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind(String(key), String(value === undefined || value === null ? '' : value)).run();
    }
  };

  // --- audit log -------------------------------------------------------
  ctx.logAudit = async (entry) => {
    const logId = crypto.randomUUID();
    await ctx.d1.prepare(
      'INSERT INTO audit_logs (log_id, timestamp, user_id, username, role, action, entity, entity_id, details) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      logId,
      ctx.now(),
      String(entry.userId || ''),
      String(entry.username || ''),
      String(entry.role || ''),
      String(entry.action || ''),
      String(entry.entity || ''),
      String(entry.entityId || ''),
      String(entry.details || '')
    ).run();
    // The original kept the newest 2,000 entries only.
    await ctx.d1.prepare(
      'DELETE FROM audit_logs WHERE log_id NOT IN (' +
      'SELECT log_id FROM audit_logs ORDER BY timestamp DESC, rowid DESC LIMIT 2000)'
    ).run();
  };

  // --- data version ----------------------------------------------------
  ctx.currentDataVersion = async () => {
    const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
    return parseInt(settings.DataVersion || '1', 10);
  };

  ctx.bumpDataVersion = async () => {
    const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
    const v = parseInt(settings.DataVersion || '1', 10) + 1;
    await writeKeyValue(ctx.d1, SHEETS.SETTINGS, 'DataVersion', String(v), ctx.now());
    await ctx.clearCache([]);
    return v;
  };

  // --- session and permissions ----------------------------------------
  ctx.requireSession = async (token) => {
    const t = String(token || '');
    if (!t) throw error_('AUTH', 'กรุณาเข้าสู่ระบบก่อนใช้งาน');
    const hash = await sha256_(t);
    const session = await ctx.d1.prepare(
      'SELECT session_id, user_id, username, role, token_hash, created_at, expires_at, last_seen_at, user_agent ' +
      'FROM sessions WHERE token_hash = ? LIMIT 1'
    ).bind(hash).first();
    if (!session) throw error_('AUTH', 'เซสชันไม่ถูกต้องหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    const expiresAt = Number(session.expires_at);
    if (!isNaN(expiresAt) && expiresAt < Date.now()) {
      throw error_('AUTH', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    }
    return {
      SessionID: session.session_id,
      UserID: session.user_id,
      Username: session.username,
      Role: session.role,
      TokenHash: session.token_hash,
      CreatedAt: session.created_at,
      ExpiresAt: session.expires_at,
      LastSeenAt: session.last_seen_at,
      UserAgent: session.user_agent
    };
  };

  ctx.requirePermission = async (token, permission) => {
    const session = await ctx.requireSession(token);
    const perms = permissionsFor_(session.Role);
    if (perms.indexOf('*') === -1 && perms.indexOf(permission) === -1) {
      await ctx.logAudit({
        userId: session.UserID, username: session.Username, role: session.Role,
        action: 'ACCESS_DENIED', entity: 'API', details: permission
      });
      throw error_('FORBIDDEN', 'คุณไม่มีสิทธิ์ในการดำเนินการนี้');
    }
    return session;
  };

  return ctx;
}

/**
 * The public address of the web app.
 *
 * In Apps Script the deployment url was read from ScriptApp. In Cloudflare the
 * address is the one the browser used - the request itself knows it.
 */
function publicUrl_(request) {
  try {
    const url = new URL(request.url);
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch (err) {
    return '';
  }
}
