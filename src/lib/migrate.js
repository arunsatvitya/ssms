/**
 * ============================================================================
 *  SSMS on Cloudflare - การย้ายข้อมูลจาก Google Sheets เข้า D1
 * ============================================================================
 *
 *  รับข้อมูลที่ส่งออกจากระบบเดิม (tools/migrate/export-from-sheets.gs)
 *  แล้วเขียนลงตารางของ D1 ตามชื่อชีตเดิม
 *
 *  ข้อมูลการเข้าเรียนของ v3 เก็บแบบบีบอัดในชีต Attendance_Daily
 *  (หนึ่งแถว = หนึ่งวัน/หนึ่งรอบ/หนึ่งห้อง) - ชีตนี้ถูกย้ายตรงๆ
 *  ส่วนชีต Attendance_Homeroom / Religious / General (รูปแบบเก่า)
 *  จะถูกแปลงเป็นรูปแบบบีบอัดให้อัตโนมัติ
 * ============================================================================
 */

import { SHEETS, HEADERS, ROUNDS, ROUND_SHEET } from './constants.js';
import { readTable, upsertRows } from './db.js';
import { error_, now_ } from './util.js';

/** ขีดจำกัดของคำขอนำเข้า - ป้องกันไม่ให้ request ใหญ่เกินไป */
const MAX_IMPORT_ROWS = 3000;

/**
 * คีย์สำหรับยืนยันตัวตนของการนำเข้าข้อมูล
 *
 * อ่านจากตัวแปรแวดล้อม IMPORT_KEY ของ Pages (กำหนดในหน้าตั้งค่าโปรเจกต์)
 * ถ้าไม่ได้ตั้งไว้ ใช้ค่าเริ่มต้น - ผู้ดูแลระบบควรเปลี่ยนทันทีหลังติดตั้ง
 */
function importKey_(ctx) {
  const configured = ctx.env && ctx.env.IMPORT_KEY ? String(ctx.env.IMPORT_KEY) : '';
  return configured || 'SSMS-IMPORT-KEY-2026';
}

/**
 * นำเข้าข้อมูลจากระบบเดิม
 *
 * @param {Object} ctx
 * @param {Object} payload - { key, data: { sheets: { Name: { headers, rows } } } }
 */
export async function importLegacyData_(ctx, payload) {
  const key = String((payload && payload.key) || '');
  if (!key || key !== importKey_(ctx)) {
    throw error_('FORBIDDEN', 'คีย์นำเข้าข้อมูลไม่ถูกต้อง');
  }
  const data = (payload && payload.data) || {};
  const sheets = data.sheets || data;
  if (!sheets || typeof sheets !== 'object') {
    throw error_('VALIDATION', 'รูปแบบข้อมูลที่นำเข้าไม่ถูกต้อง');
  }

  const report = {};
  const order = [
    SHEETS.SETTINGS,
    SHEETS.MONITOR,
    SHEETS.USERS,
    SHEETS.TEACHERS,
    SHEETS.CLASSROOMS,
    SHEETS.SUBJECTS,
    SHEETS.STUDENTS,
    SHEETS.CLASS_ROSTERS,
    SHEETS.ATT_DAILY,
    SHEETS.ATT_HOMEROOM,
    SHEETS.ATT_RELIGIOUS,
    SHEETS.ATT_GENERAL,
    SHEETS.LEAVES,
    SHEETS.ANNOUNCEMENTS,
    SHEETS.ANOMALY_VERIFICATIONS
  ];

  for (const name of order) {
    const block = sheets[name];
    if (!block) continue;
    const rows = Array.isArray(block.rows) ? block.rows : [];
    if (!rows.length) {
      report[name] = { imported: 0 };
      continue;
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      // แบ่งเป็นชุดละไม่เกิน 3000 แถว
      let done = 0;
      for (let i = 0; i < rows.length; i += MAX_IMPORT_ROWS) {
        const chunk = rows.slice(i, i + MAX_IMPORT_ROWS);
        await upsertRows(ctx.d1, name, chunk);
        done += chunk.length;
      }
      report[name] = { imported: done, chunked: true };
      continue;
    }
    await upsertRows(ctx.d1, name, rows);
    report[name] = { imported: rows.length };
  }

  // ถ้ามีข้อมูลการเข้าเรียนรูปแบบเก่า ให้แปลงเป็นรูปแบบบีบอัด
  const legacy = await convertLegacyAttendance_(ctx, sheets);
  if (legacy) report.legacyConverted = legacy;

  // ล้าง cache เพราะข้อมูลเปลี่ยนทั้งหมด
  await ctx.clearCache([]);
  await ctx.logAudit({
    action: 'IMPORT_LEGACY',
    entity: 'Database',
    details: Object.keys(report).map((k) => k + ':' + (report[k].imported || 0)).join(', ')
  });

  return { ok: true, report: report };
}

/**
 * แปลงข้อมูลการเข้าเรียนรูปแบบเก่า (ทีละนักเรียน) เป็นรูปแบบบีบอัด
 *
 * @returns {Promise<Object|null>} - สรุปจำนวนแถวที่แปลง หรือ null ถ้าไม่มีข้อมูลเก่า
 */
async function convertLegacyAttendance_(ctx, sheets) {
  const legacyNames = [SHEETS.ATT_HOMEROOM, SHEETS.ATT_RELIGIOUS, SHEETS.ATT_GENERAL];
  let hasLegacy = false;
  legacyNames.forEach((n) => {
    const b = sheets[n];
    if (b && Array.isArray(b.rows) && b.rows.length) hasLegacy = true;
  });
  if (!hasLegacy) return null;

  // ตรวจสอบก่อนว่ามีข้อมูลรูปแบบบีบอัดอยู่แล้วหรือไม่
  const existingCompact = await readTable(ctx.d1, SHEETS.ATT_DAILY);
  const existingKeys = {};
  existingCompact.forEach((r) => { existingKeys[String(r.DayID)] = true; });

  // รวมข้อมูลเก่าเป็นกลุ่มของ วัน/รอบ/ห้อง
  const groups = {};
  legacyNames.forEach((name) => {
    const block = sheets[name];
    if (!block || !Array.isArray(block.rows)) return;
    const round = ROUND_SHEET[name] === SHEETS.ATT_HOMEROOM ? ROUNDS.HOMEROOM
      : (ROUND_SHEET[name] === SHEETS.ATT_RELIGIOUS ? ROUNDS.RELIGIOUS : ROUNDS.GENERAL);
    block.rows.forEach((a) => {
      const date = String(a.AttendanceDate || '').slice(0, 10);
      const classId = String(a.ClassID || '').trim();
      if (!date || !classId) return;
      const gk = date + '|' + round + '|' + classId;
      if (!groups[gk]) groups[gk] = { date: date, round: round, classId: classId, map: {} };
      const status = String(a.Status || '').trim().toUpperCase();
      if (status) groups[gk].map[String(a.StudentID)] = status;
    });
  });

  // ต้องรู้รายชื่อนักเรียนของแต่ละห้องก่อน จึงจะเขียนเป็นรหัสตัวอักษรได้
  const students = await readTable(ctx.d1, SHEETS.STUDENTS);
  const classrooms = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const classMap = {};
  classrooms.forEach((c) => { classMap[String(c.ClassID)] = c; });

  // เวอร์ชันของ roster เดิม (ถ้ามี) จะถูกใช้ต่อ ไม่ต้องสร้างใหม่
  const rosters = await readTable(ctx.d1, SHEETS.CLASS_ROSTERS);
  const rosterByKey = {};
  rosters.forEach((r) => {
    const k = String(r.ClassID) + '|' + String(r.Round);
    const cur = rosterByKey[k];
    if (!cur || Number(r.Version) > Number(cur.Version)) rosterByKey[k] = r;
  });

  const compactRows = [];
  let converted = 0;

  Object.keys(groups).forEach((gk) => {
    const g = groups[gk];
    const dayId = 'D-' + g.date + '-' + g.round + '-' + g.classId;
    if (existingKeys[dayId]) return;          // มีข้อมูลรูปแบบบีบอัดอยู่แล้ว

    // รายชื่อนักเรียนของห้องนี้ในรอบนี้
    const room = classMap[g.classId] || {};
    const field = g.round === ROUNDS.RELIGIOUS ? 'ReligiousClassID'
      : (g.round === ROUNDS.GENERAL ? 'GeneralClassID' : 'HomeroomClassID');
    const ids = students
      .filter((s) => String(s[field] || '').trim() === String(g.classId))
      .map((s) => String(s.StudentID))
      .sort(function (a, b) { return a.localeCompare(b, 'th', { numeric: true }); });

    if (!ids.length) return;                    // ห้องที่ไม่มีนักเรียนในระบบใหม่

    // ใช้ roster เดิมถ้ามี ไม่ต้องมี
    const rk = String(g.classId) + '|' + String(g.round);
    const existingRoster = rosterByKey[rk];
    let version = '1';
    let rosterIds = ids;
    if (existingRoster) {
      version = String(existingRoster.Version || '1');
      const stored = String(existingRoster.StudentIDs || '').split(',').filter(Boolean);
      if (stored.length) rosterIds = stored;
    }

    const codes = rosterIds.map(function (id) {
      const st = String(g.map[id] || '').toUpperCase();
      if (st === 'PRESENT') return 'P';
      if (st === 'ABSENT') return 'A';
      if (st === 'LATE') return 'L';
      if (st === 'LEAVE') return 'V';
      return '-';
    }).join('');

    if (codes.replace(/-/g, '') === '') return;   // ไม่มีสถานะจริงเลย

    compactRows.push({
      DayID: dayId,
      AttendanceDate: g.date,
      ClassID: g.classId,
      Round: g.round,
      RosterVersion: version,
      Statuses: codes,
      RecordedBy: ''
    });
    converted++;
  });

  if (compactRows.length) {
    await upsertRows(ctx.d1, SHEETS.ATT_DAILY, compactRows);
  }

  // สร้าง roster ให้ตรงกับรายชื่อที่ใช้คำนวณ
  const rosterRows = [];
  Object.keys(groups).forEach((gk) => {
    const g = groups[gk];
    const rk = String(g.classId) + '|' + String(g.round);
    if (rosterByKey[rk]) return;                // มี roster เดิมแล้ว
    const room = classMap[g.classId] || {};
    const field = g.round === ROUNDS.RELIGIOUS ? 'ReligiousClassID'
      : (g.round === ROUNDS.GENERAL ? 'GeneralClassID' : 'HomeroomClassID');
    const ids = students
      .filter((s) => String(s[field] || '').trim() === String(g.classId))
      .map((s) => String(s.StudentID))
      .sort(function (a, b) { return a.localeCompare(b, 'th', { numeric: true }); });
    if (!ids.length) return;
    rosterRows.push({
      RosterID: 'ROS-' + g.classId + '-' + g.round + '-1',
      ClassID: g.classId,
      Round: g.round,
      Version: '1',
      StudentIDs: ids.join(','),
      CreatedAt: now_()
    });
  });
  if (rosterRows.length) {
    await upsertRows(ctx.d1, SHEETS.CLASS_ROSTERS, rosterRows);
  }

  return { groups: converted, rosters: rosterRows.length };
}

/**
 * ย้ายข้อมูลการเข้าเรียนที่ยังอยู่ในรูปแบบเก่า (ทีละนักเรียน) ไปเป็นรูปแบบบีบอัด
 *
 * นี่คือฟังก์ชันที่ปุ่ม "ย้ายข้อมูล" ในหน้าตั้งค่าระบบเรียกใช้
 * ข้อมูลถูกอ่านจากตารางเก่าในฐานข้อมูล แล้วเขียนกลับเป็นรูปแบบใหม่
 * แถวที่มีอยู่แล้วจะไม่ถูกเขียนทับ (เหมือนต้นฉบับ)
 *
 * @param {Object} ctx
 * @param {Object} payload
 * @returns {Promise<Object>} - สรุปผลการย้ายข้อมูล
 */
export async function migrateLegacyAttendance_(ctx, payload) {
  await ctx.requirePermission(payload.token, 'settings.manage');

  // อ่านข้อมูลเก่าจากฐานข้อมูล
  const sheets = {};
  const legacyNames = [SHEETS.ATT_HOMEROOM, SHEETS.ATT_RELIGIOUS, SHEETS.ATT_GENERAL];
  let legacyCount = 0;
  for (const name of legacyNames) {
    const rows = await readTable(ctx.d1, name);
    legacyCount += rows.length;
    sheets[name] = { headers: HEADERS[name] || [], rows: rows };
  }

  if (!legacyCount) {
    return { days: 0, skipped: 0, verifications: 0, message: 'ไม่มีข้อมูลรูปแบบเก่าที่ต้องย้าย' };
  }

  const before = await readTable(ctx.d1, SHEETS.ATT_DAILY);
  const result = await convertLegacyAttendance_(ctx, sheets);
  const after = await readTable(ctx.d1, SHEETS.ATT_DAILY);

  const verifications = await readTable(ctx.d1, SHEETS.ANOMALY_VERIFICATIONS);
  await ctx.logAudit({
    action: 'MIGRATE_LEGACY_ATTENDANCE',
    entity: 'Attendance',
    details: 'ย้าย ' + (result ? result.groups : 0) + ' กลุ่มข้อมูล'
  });

  return {
    days: after.length - before.length,
    skipped: before.length,
    verifications: verifications.length,
    groups: result ? result.groups : 0,
    rosters: result ? result.rosters : 0
  };
}