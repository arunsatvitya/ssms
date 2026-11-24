/**
 * ============================================================================
 *  SSMS on Cloudflare - Teacher leave management
 * ============================================================================
 *
 *  Ported 1:1 from the Google Apps Script version (Code.gs, SECTION 12).
 *  The leave records live in the `teacher_leaves` table.
 * ============================================================================
 */

import { SHEETS, LEAVE_TYPES } from './constants.js';
import { readTable, upsertRows, deleteRowsByKey } from './db.js';
import {
  requireText_, idEq_, sortBy_, plain_, normalizeDate_
} from './util.js';

/**
 * Lists teacher leaves.
 *
 * @param {Object} ctx
 * @param {Object} payload - { date, from, to, leaveType, q }
 */
export async function listLeaves_(ctx, payload) {
  await ctx.requirePermission(payload.token, 'leave.view');
  const teachers = await readTable(ctx.d1, SHEETS.TEACHERS);
  const tMap = {};
  teachers.forEach(function (t) { tMap[t.TeacherID] = plain_(t); });

  let rows = (await readTable(ctx.d1, SHEETS.LEAVES,
    ['LeaveID', 'TeacherID', 'LeaveDate', 'LeaveType', 'Note', 'RecordedBy']))
    .map(plain_)
    .map(function (l) {
      const t = tMap[l.TeacherID] || {};
      return Object.assign({}, l, {
        LeaveDate: normalizeDate_(l.LeaveDate),
        TeacherFirstName: t.FirstName || '',
        TeacherLastName: t.LastName || '',
        TeacherName: ((t.FirstName || '') + ' ' + (t.LastName || '')).trim(),
        Position: t.Position || '',
        Department: t.Department || '',
        LeaveTypeLabel: leaveTypeLabel_(l.LeaveType)
      });
    });

  const date = normalizeDate_(payload.date);
  const from = normalizeDate_(payload.from);
  const to = normalizeDate_(payload.to);
  const type = String(payload.leaveType || '');
  const q = String(payload.q || '').toLowerCase();

  if (date) rows = rows.filter(function (r) { return r.LeaveDate === date; });
  if (from) rows = rows.filter(function (r) { return r.LeaveDate >= from; });
  if (to) rows = rows.filter(function (r) { return r.LeaveDate <= to; });
  if (type) rows = rows.filter(function (r) { return r.LeaveType === type; });
  if (q) {
    rows = rows.filter(function (r) {
      return [r.TeacherID, r.TeacherName, r.Note].join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }
  rows = sortBy_(rows, 'LeaveDate', true);
  return { rows: rows, total: rows.length };
}

/**
 * Thai label of a leave type.
 */
export function leaveTypeLabel_(type) {
  const map = {
    SICK: 'ลาป่วย', PERSONAL: 'ลากิจ', REST: 'ลาพักผ่อน',
    MATERNITY: 'ลาคลอด', OTHER: 'ลาประเภทอื่น ๆ'
  };
  return map[type] || type;
}

/**
 * Creates or updates one or many leave records.
 *
 * @param {Object} ctx
 * @param {Object} payload - { leaves: [...] } or { leave: {...} }
 */
export async function saveLeave_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'leave.manage');
  const items = (payload.leaves && payload.leaves.length) ? payload.leaves : [payload.leave];
  const teachers = await readTable(ctx.d1, SHEETS.TEACHERS);
  const tMap = {};
  teachers.forEach(function (t) { tMap[t.TeacherID] = t; });
  const existing = await readTable(ctx.d1, SHEETS.LEAVES);

  const out = [];
  const errors = [];
  let dup = 0;
  const batchSeen = {};

  items.forEach(function (item) {
    const teacherId = String((item && item.TeacherID) || '').trim();
    const date = normalizeDate_(item && item.LeaveDate);
    const type = String((item && item.LeaveType) || '').trim().toUpperCase();
    if (!tMap[teacherId]) { errors.push('ไม่พบครูรหัส ' + teacherId); return; }
    if (!date) { errors.push('วันที่ลาไม่ถูกต้องสำหรับครู ' + teacherId); return; }
    if (LEAVE_TYPES.indexOf(type) === -1) { errors.push('ประเภทการลาไม่ถูกต้อง'); return; }
    const already = existing.filter(function (l) {
      return idEq_(l.TeacherID, teacherId) && normalizeDate_(l.LeaveDate) === date && l.LeaveType === type;
    })[0];
    const batchKey = teacherId + '|' + date + '|' + type;
    if (already || batchSeen[batchKey]) { dup++; return; }
    batchSeen[batchKey] = true;
    out.push({
      LeaveID: 'LV-' + date.replace(/-/g, '') + '-' + teacherId + '-' + type,
      TeacherID: teacherId,
      LeaveDate: date,
      LeaveType: type,
      Note: String((item && item.Note) || '').trim().slice(0, 200),
      RecordedBy: session.Username,
      CreatedAt: ctx.now(),
      UpdatedAt: ctx.now()
    });
  });

  if (out.length) await upsertRows(ctx.d1, SHEETS.LEAVES, out);

  await ctx.logAudit({
    userId: session.UserID, username: session.Username, role: session.Role,
    action: 'LEAVE_SAVE', entity: 'Teacher_Leaves',
    details: 'บันทึก ' + out.length + ' รายการ' + (dup ? ' (ซ้ำ ' + dup + ')' : '')
  });
  await ctx.bumpDataVersion();
  return { ok: true, saved: out.length, duplicated: dup, errors: errors };
}

/**
 * Deletes a leave record.
 */
export async function deleteLeave_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'leave.manage');
  const id = requireText_(payload.LeaveID, 'รหัสการลา');
  await deleteRowsByKey(ctx.d1, SHEETS.LEAVES, 'LeaveID', [id]);
  await ctx.logAudit({
    userId: session.UserID, username: session.Username, role: session.Role,
    action: 'LEAVE_DELETE', entity: 'Teacher_Leaves', entityId: id, details: id
  });
  await ctx.bumpDataVersion();
  return { ok: true };
}
