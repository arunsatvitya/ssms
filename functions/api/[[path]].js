/**
 * ============================================================================
 *  SSMS on Cloudflare - Pages Function entry point
 * ============================================================================
 *
 *  Routes:
 *    POST /api   -> the API router (action + payload)
 *    GET  /api/health -> a small status endpoint for the installation check
 * ============================================================================
 */

import { createContext, error_ } from './_lib/context.js';
import { handleApi } from './_lib/routes.js';
import { seedDefaults_, ensureDatabase_ } from './_lib/auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const ctx = createContext(env, request, caches.default);

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

export async function onRequestGet(context) {
  const { request, env } = context;
  const path = new URL(request.url).pathname;

  if (path.endsWith('/health')) {
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

  return json({ ok: false, error: { code: 'NOT_FOUND', message: 'ไม่พบเส้นทางที่เรียก' } }, 404);
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
