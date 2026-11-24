/**
 * ============================================================================
 *  SSMS on Cloudflare - Worker entry point
 * ============================================================================
 *
 *  Cloudflare เปลี่ยนแนวทางตั้งแต่เมษายาคม 2025 ให้โปรเจกต์ใหม่ทั้งหมดเป็น
 *  **Workers with Static Assets** แทน Pages (Pages ยังใช้ได้ แต่ไม่ใช่ทางหลักอีกต่อไป)
 *
 *  ดังนั้นคำสั่ง deploy คือ `npx wrangler deploy` ซึ่ง Cloudflare เรียกให้อัตโนมัติ
 *  เมื่อเชื่อมโปรเจกต์กับ Git
 *
 *  หน้าที่ของไฟล์นี้:
 *    - เส้นทาง /api และ /api/*  -> ส่งต่อให้โค้ด API
 *    - อื่นๆ (หน้าเว็บ, CSS, รูป) -> เสิร์ฟจาก public/ ผ่าน ASSETS binding
 *
 *  ข้อดีของวิธีนี้: ไฟล์ static ถูกเสิร์ฟจาก edge ของ Cloudflare ฟรีและไม่จำกัด
 *  ส่วนโค้ด Worker ทำงานเฉพาะเส้นทาง /api เท่านั้น
 * ============================================================================
 */

import { handleApiRequest, handleHealthRequest } from './lib/handler.js';

export default {
  /**
   * ตัวจัดการ request ของ Worker
   *
   * @param {Request} request - คำขอที่เข้ามา
   * @param {Object} env - bindings (DB, ASSETS, ...)
   * @param {Object} ctx - context ของ Worker
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- เส้นทางของ API ทั้งหมด ------------------------------------
    if (path === '/api' || path === '/api/' || path.startsWith('/api/')) {
      const context = { request, env, params: {}, waitUntil: ctx && ctx.waitUntil };
      if (path.endsWith('/health')) {
        return handleHealthRequest(context);
      }
      return handleApiRequest(context);
    }

    // --- ไฟล์ static (หน้าเว็บ, CSS, รูป) -----------------------------
    // ไฟล์เหล่านี้ฟรีและไม่จำกัด ไม่กินโควตาของ Workers
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('ไม่พบไฟล์ที่ต้องการ', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
};
