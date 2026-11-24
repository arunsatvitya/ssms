#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
แก้ไข frontend ของระบบเดิมให้ใช้กับ Cloudflare Pages Functions

สิ่งที่แก้:
  1. apiCall()   -> ส่ง JSON ไปที่ /api (แทน google.script.run)
  2. monitorUrl()-> ใช้ URL ของเว็บปัจจุบัน (บน Cloudflare ไม่มี iframe ซ้อน)
  3. system info -> ไม่แสดงลิงก์ไปยัง Google Sheets อีกต่อไป

วิธีใช้:  python tools/patch_frontend.py
"""

import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(os.path.dirname(ROOT), 'v3-compact', 'index.html')
DST = os.path.join(ROOT, 'public', 'index.html')

OLD_API = """/**
 * Calls a backend action. Uses google.script.run inside Apps Script and
 * falls back to the Web App POST endpoint when the file is opened directly.
 */
function apiCall(action, payload) {
  const body = Object.assign({}, payload || {});
  if (action !== 'auth.login') {
    body.token = State.token;
  }
  return new Promise(function (resolve, reject) {
    if (typeof google !== 'undefined' && google.script && google.script.run) {
      google.script.run
        .withSuccessHandler(function (res) {
          if (res && res.ok) { resolve(res.data); return; }
          if (res === null || res === undefined) {
            // A null response means the server result could not be transported
            // back to the browser (an unsupported value type such as Date).
            reject(new Error('เซิร์ฟเวอร์ส่งข้อมูลกลับมาไม่สำเร็จ (ข้อมูลอาจมีชนิดที่ไม่รองรับ) กรุณาลองใหม่หรือติดต่อผู้ดูแลระบบ'));
            return;
          }
          reject(new Error((res.error && res.error.message) || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ'));
        })
        .withFailureHandler(function (err) {
          reject(new Error((err && err.message) ? err.message : 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ'));
        })
        .api(action, body);
      return;
    }
    // Standalone fallback (local preview / external hosting)
    fetch(location.origin + location.pathname, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action, payload: body })
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.ok) resolve(res.data);
        else reject(new Error((res && res.error && res.error.message) || 'เกิดข้อผิดพลาด'));
      })
      .catch(function () { reject(new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ')); });
  });
}"""

NEW_API = """/**
 * The address of the API.
 *
 * On Cloudflare the API is a Pages Function that lives under /api of the
 * same domain - so the browser can always use a relative path.
 */
const API_BASE = '/api';

/**
 * Calls a backend action.
 *
 * The server is a Cloudflare Pages Function: the action and the payload are
 * sent as JSON to /api and the answer arrives as real JSON.
 */
function apiCall(action, payload) {
  const body = Object.assign({}, payload || {});
  if (action !== 'auth.login') {
    body.token = State.token;
  }
  return fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: action, payload: body })
  })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (res && res.ok) return res.data;
      throw new Error((res && res.error && res.error.message) || 'เกิดข้อผิดพลาด');
    })
    .catch(function (err) {
      // The message of the server is passed on unchanged - only a broken
      // connection gets a friendlier text.
      if (err && err.message) throw err;
      throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อ');
    });
}"""

OLD_MONITOR = """/**
 * Builds the monitor URL.
 *
 * Inside Apps Script the page is rendered in a nested iframe, so
 * location.href points at an inner sandbox URL that cannot be opened
 * outside. The deployment URL returned by the server (ending in /exec, or
 * /dev while testing) is the address that actually works on a display.
 */
function monitorUrl(key, base) {
  const root = base || State.webAppUrl || '';
  const sep = root.indexOf('?') === -1 ? '?' : '&';
  if (!root) {
    // Fallback for a local preview - the current address is the only one known.
    return location.origin + location.pathname + '?view=monitor' + (key ? '&key=' + encodeURIComponent(key) : '');
  }
  return root + sep + 'view=monitor' + (key ? '&key=' + encodeURIComponent(key) : '');
}"""

NEW_MONITOR = """/**
 * Builds the monitor URL.
 *
 * On Cloudflare the page is served directly from the domain of the project
 * (no nested iframe), so the current address is already the address that
 * works on a wall display. The server can still return another address
 * (for example behind a custom domain) - it is preferred when it is known.
 */
function monitorUrl(key, base) {
  const root = base || State.webAppUrl || '';
  const sep = root.indexOf('?') === -1 ? '?' : '&';
  const query = 'view=monitor' + (key ? '&key=' + encodeURIComponent(key) : '');
  if (!root) {
    // Fallback - the current address is the only one known.
    return location.origin + location.pathname + '?' + query;
  }
  return root + sep + query;
}"""


def patch(text, old, new, label):
    if old not in text:
        print(f'  SKIP  {label} - ไม่พบข้อความต้นฉบับ (อาจถูกแก้ไปแล้ว)')
        return text, False
    if new in text:
        print(f'  SKIP  {label} - แก้ไขแล้ว')
        return text, False
    text = text.replace(old, new, 1)
    print(f'  OK    {label}')
    return text, True


def main():
    if not os.path.exists(SRC):
        print(f'ไม่พบไฟล์ต้นฉบับ: {SRC}')
        return 1

    with io.open(SRC, encoding='utf-8') as f:
        text = f.read()

    print('กำลังแก้ไข frontend:')
    text, a = patch(text, OLD_API, NEW_API, 'apiCall -> /api')
    text, b = patch(text, OLD_MONITOR, NEW_MONITOR, 'monitorUrl -> url ของเว็บ')

    # ปุ่ม "เปิดชีตข้อมูล" ของ Google Sheets ไม่มีความหมายบน Cloudflare แล้ว
    text, c = patch(
        text,
        "$('#sheetInfo').textContent = (info.spreadsheetName || '') + ' · ' + (info.spreadsheetId || '');",
        "$('#sheetInfo').textContent = 'ฐานข้อมูล Cloudflare D1' + (info.databaseName ? ' · ' + info.databaseName : '');",
        'ข้อความฐานข้อมูลในหน้าตั้งค่า'
    )

    os.makedirs(os.path.dirname(DST), exist_ok=True)
    with io.open(DST, 'w', encoding='utf-8', newline='') as f:
        f.write(text)

    print()
    print(f'เขียนไฟล์: {DST}')
    print(f'ขนาด: {len(text):,} ตัวอักษร')
    if 'google.script.run' in text:
        print('คำเตือน: ยังพบ google.script.run ในไฟล์')
        return 1
    print('ไม่พบ google.script.run แล้ว - พร้อมใช้งานบน Cloudflare')
    return 0


if __name__ == '__main__':
    sys.exit(main())
