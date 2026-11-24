/**
 * ============================================================================
 *  SSMS on Cloudflare - API request handler
 * ============================================================================
 *
 *  The real work of the API lives here. The files in `functions/api/` are
 *  only thin route files that point to this module:
 *
 *      functions/api/index.js      ->  /api
 *      functions/api/[[path]].js  ->  /api/<anything>
 *
 *  Cloudflare Pages routes a request to a Function by the file name, so
 *  both files are needed: the catch-all `[[path]]` matches every path
 *  *below* /api, while `index.js` serves the bare /api address that the
 *  browser uses.
 * ============================================================================
 */

import { createContext, error_ } from './context.js';
import { handleApi } from './routes.js';
import { seedDefaults_, ensureDatabase_ } from './auth.js';

/**
 * Handles one request to the API.
 *
 * @param {Object} context - the Pages Function context
 * @returns {Promise<Response>}
 */
export async function handleApiRequest(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'รูปแบบข้อมูลที่ส่งมาไม่ถูกต้อง' }
    }, 400);
  }

  try {
    const ctx = createContext(env, request, caches.default);

    // The database is prepared on the first request - the tables exist
    // (schema/001_schema.sql) and the default rows are written once.
    await ensureDatabase_(ctx);

    const result = await handleApi(ctx, body.action, body.payload || {});
    return json(result, result.ok ? 200 : 400);
  } catch (err) {
    return json({
      ok: false,
      error: {
        code: (err && err.code) ? err.code : 'SERVER_ERROR',
        message: (err && err.message) ? err.message : String(err)
      }
    }, 500);
  }
}

/**
 * The health check - tells whether the database is reachable.
 * It is the first thing to try when something does not work.
 */
export async function handleHealthRequest(context) {
  const { request, env } = context;
  try {
    const ctx = createContext(env, request, caches.default);
    await ensureDatabase_(ctx);
    const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
    return json({
      ok: true,
      data: {
        app: 'SSMS on Cloudflare',
        database: 'connected',
        users: row ? Number(row.c) || 0 : 0,
        time: new Date().toISOString()
      }
    });
  } catch (err) {
    return json({
      ok: false,
      error: {
        code: 'DATABASE_ERROR',
        message: 'เชื่อมต่อฐานข้อมูล D1 ไม่สำเร็จ: ' + (err && err.message ? err.message : String(err))
      }
    }, 500);
  }
}

/** The response helper - always JSON with the right content type. */
function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
