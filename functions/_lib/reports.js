/**
 * ============================================================================
 *  SSMS on Cloudflare - Announcements, Monitor, Dashboard, Reports, Excel I/O
 * ============================================================================
 *
 *  Ported 1:1 from the original Google Apps Script backend (Code.gs):
 *    SECTION 13 - ANNOUNCEMENT MANAGEMENT
 *    SECTION 14 - MONITOR MANAGEMENT
 *    SECTION 15 - DASHBOARD & REPORTS
 *    SECTION 16 - EXCEL IMPORT & EXPORT
 *
 *  The data layer is the D1 shim of `_lib/db.js`; the context object (`ctx`)
 *  carries the cache, the clock and the session helpers - see
 *  docs/PORTING-CONTRACT.md.
 *
 *  IMPORTANT - the monitor is the most used part of the application: every
 *  wall display polls `monitor.data` every few seconds. The whole payload is
 *  therefore kept in the cache for 120 seconds, exactly like the original did.
 * ============================================================================
 */

import { APP, SHEETS, ROUNDS, ATT_STATUS, ANIMATIONS, ANOMALY, VERIFICATION,
         ROLES, LEAVE_TYPES, MONITOR_TEMPLATES } from './constants.js';
import { readTable, readKeyValue, writeKeyValue, upsertRows, deleteRowsByKey,
         readRowsByDate } from './db.js';
import { error_, permissionsFor_ } from './context.js';
import { normalizeDate_, idEq_, plain_, sortBy_, requireText_, safeEqual_,
         nextId_, daysBefore_ as daysBeforeBase_ } from './util.js';

/* The modules that are written in parallel are imported as a namespace: a
 * missing export must not break the whole API at link time. */
import * as auth from './auth.js';
import * as directory from './directory.js';
import * as roster from './roster.js';
import * as attendance from './attendance.js';

/* ========================================================================== *
 *  SMALL HELPERS - identical to the original Code.gs
 * ========================================================================== */

/**
 * Resolves the session of a bearer token.
 * The context carries the helper (PORTING-CONTRACT §5); the auth module is
 * used as a fallback.
 */
async function requireSession(ctx, token) {
  if (ctx && typeof ctx.requireSession === 'function') return await ctx.requireSession(token);
  if (auth && typeof auth.requireSession_ === 'function') return await auth.requireSession_(ctx, token);
  throw error_('AUTH', 'กรุณาเข้าสู่ระบบก่อนใช้งาน');
}

/**
 * Throws unless the session holds the requested permission.
 * Returns the session.
 */
async function requirePermission(ctx, token, permission) {
  if (ctx && typeof ctx.requirePermission === 'function') return await ctx.requirePermission(token, permission);
  if (auth && typeof auth.requirePermission_ === 'function') return await auth.requirePermission_(ctx, token, permission);
  return await requireSession(ctx, token);
}

/** Checks whether the session holds a permission. */
function can_(session, permission) {
  const perms = permissionsFor_(session && session.Role);
  return perms.indexOf('*') !== -1 || perms.indexOf(permission) !== -1;
}

/** Writes an audit entry - best effort, never breaks the request. */
async function logAudit(ctx, entry) {
  try {
    if (ctx && typeof ctx.logAudit === 'function') { await ctx.logAudit(entry); return; }
    if (auth && typeof auth.logAudit_ === 'function') {
      if (auth.logAudit_.length >= 2) await auth.logAudit_(ctx, entry);
      else await auth.logAudit_(entry);
    }
  } catch (err) {
    /* the audit log must never break the operation */
  }
}

/** Reads a value from the cache - missing cache means "no value". */
async function cacheGet(ctx, key, seconds) {
  if (!ctx || typeof ctx.cacheGet !== 'function') return null;
  try { return await ctx.cacheGet(key, seconds); } catch (err) { return null; }
}

/** Writes a value into the cache - best effort. */
async function cachePut(ctx, key, value, seconds) {
  if (!ctx || typeof ctx.cachePut !== 'function') return;
  try { await ctx.cachePut(key, value, seconds); } catch (err) { /* ignore */ }
}

/** Increments the global data version (the monitor polls it). */
async function bumpDataVersion(ctx) {
  if (ctx && typeof ctx.bumpDataVersion === 'function') { await ctx.bumpDataVersion(); return; }
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  const v = parseInt(settings.DataVersion || '1', 10) + 1;
  await writeKeyValue(ctx.d1, SHEETS.SETTINGS, 'DataVersion', String(v), ctx.now());
}

/** The current data version. */
async function currentDataVersion(ctx) {
  if (ctx && typeof ctx.currentDataVersion === 'function') return await ctx.currentDataVersion();
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  return parseInt(settings.DataVersion || '1', 10);
}

/** The date n days before the given date. */
export function daysBefore_(date, n) {
  const base = normalizeDate_(date);
  if (!base) return '';
  return daysBeforeBase_(base, n);
}

/** Thai label of an anomaly type. */
export function anomalyLabel_(type) {
  if (type === ANOMALY.ABSENT_RELIGIOUS) return 'โดดเรียนวิชาศาสนา';
  if (type === ANOMALY.ABSENT_GENERAL) return 'โดดเรียนวิชาสามัญ';
  return 'รอตรวจสอบ';
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

/* ========================================================================== *
 *  SECTION 13: ANNOUNCEMENT MANAGEMENT
 * ========================================================================== */

/** Lists announcements (management view). */
export async function listAnnouncements_(ctx, payload) {
  await requirePermission(ctx, payload.token, 'announcement.view');
  let rows = (await readTable(ctx.d1, SHEETS.ANNOUNCEMENTS)).map(plain_);
  const status = String(payload.status || '');
  const q = String(payload.q || '').toLowerCase();
  const scope = String(payload.scope || 'ALL');
  if (status) rows = rows.filter(function (a) { return a.Status === status; });
  if (q) rows = rows.filter(function (a) {
    return [a.Title, a.Content].join(' ').toLowerCase().indexOf(q) !== -1;
  });
  if (scope === 'ACTIVE') {
    const t = ctx.today();
    rows = rows.filter(function (a) {
      return a.Status === 'PUBLISHED' &&
        (!a.StartDate || a.StartDate <= t) && (!a.EndDate || a.EndDate >= t);
    });
  }
  rows = sortBy_(rows, 'StartDate', true);
  return { rows: rows, total: rows.length };
}

/** Creates or updates an announcement. */
export async function saveAnnouncement_(ctx, payload) {
  const session = await requirePermission(ctx, payload.token, 'announcement.create');
  const src = payload.announcement || {};
  const items = await readTable(ctx.d1, SHEETS.ANNOUNCEMENTS);
  const id = String(src.AnnouncementID || '').trim();
  const existing = id ? items.filter(function (a) { return idEq_(a.AnnouncementID, id); })[0] : null;

  const canEdit = existing
    ? (session.Role === ROLES.SUPER_ADMIN || session.Role === ROLES.ADMIN ||
      existing.CreatedBy === session.Username || can_(session, 'announcement.edit'))
    : true;
  if (!canEdit) throw error_('FORBIDDEN', 'คุณไม่มีสิทธิ์แก้ไขประกาศนี้');

  const title = requireText_(src.Title, 'หัวข้อประกาศ', 200);
  const content = requireText_(src.Content, 'เนื้อหาประกาศ', 2000);
  const startDate = normalizeDate_(src.StartDate) || ctx.today();
  const endDate = normalizeDate_(src.EndDate) || startDate;
  if (endDate < startDate) throw error_('VALIDATION', 'วันที่สิ้นสุดต้องไม่น้อยกว่าวันที่เริ่มแสดง');
  const animation = String(src.AnimationType || 'MARQUEE').toUpperCase();
  if (ANIMATIONS.indexOf(animation) === -1) throw error_('VALIDATION', 'รูปแบบ Animation ไม่ถูกต้อง');
  const fontSize = Math.min(Math.max(parseInt(src.FontSize || '48', 10) || 48, 16), 200);
  const speed = Math.min(Math.max(parseInt(src.AnimationSpeed || '50', 10) || 50, 1), 100);
  let status = String(src.Status || 'DRAFT').toUpperCase();
  if (status === 'PUBLISHED' && !can_(session, 'announcement.publish')) status = 'DRAFT';
  if (['DRAFT', 'PUBLISHED', 'DISABLED'].indexOf(status) === -1) status = 'DRAFT';

  const rec = {
    AnnouncementID: existing ? existing.AnnouncementID : nextId_('ANN', items.map(function (a) { return a.AnnouncementID; })),
    Title: title,
    Content: content,
    StartDate: startDate,
    EndDate: endDate,
    Priority: parseInt(src.Priority || '2', 10) || 2,
    AnimationType: animation,
    TextColor: /^#[0-9a-fA-F]{6}$/.test(String(src.TextColor || '')) ? src.TextColor : '#ffffff',
    BackgroundColor: /^#[0-9a-fA-F]{6}$/.test(String(src.BackgroundColor || '')) ? src.BackgroundColor : '#4361ee',
    FontSize: fontSize,
    AnimationSpeed: speed,
    Status: status,
    CreatedBy: existing ? existing.CreatedBy : session.Username,
    CreatedAt: existing ? existing.CreatedAt : ctx.now(),
    UpdatedAt: ctx.now()
  };
  await upsertRows(ctx.d1, SHEETS.ANNOUNCEMENTS, [rec]);
  await logAudit(ctx, {
    userId: session.UserID, username: session.Username, role: session.Role,
    action: existing ? 'ANNOUNCEMENT_UPDATE' : 'ANNOUNCEMENT_CREATE', entity: 'Announcements',
    entityId: rec.AnnouncementID, details: title
  });
  await bumpDataVersion(ctx);
  return { ok: true, AnnouncementID: rec.AnnouncementID, Status: rec.Status };
}

/** Deletes an announcement. */
export async function deleteAnnouncement_(ctx, payload) {
  const session = await requirePermission(ctx, payload.token, 'announcement.delete');
  const id = requireText_(payload.AnnouncementID, 'รหัสประกาศ');
  await deleteRowsByKey(ctx.d1, SHEETS.ANNOUNCEMENTS, 'AnnouncementID', [id]);
  await logAudit(ctx, {
    userId: session.UserID, username: session.Username, role: session.Role,
    action: 'ANNOUNCEMENT_DELETE', entity: 'Announcements', entityId: id, details: id
  });
  await bumpDataVersion(ctx);
  return { ok: true };
}

/* ========================================================================== *
 *  SECTION 14: MONITOR MANAGEMENT
 * ========================================================================== */

/**
 * Validates the read-only monitor access.
 * Either the shared access key (for wall displays without an account) or an
 * authenticated session that is allowed to view the monitor is accepted.
 */
export async function assertMonitorAccess_(ctx, payload) {
  const provided = String(payload.monitorKey || payload.key || '');
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  const expected = String(settings.MonitorAccessKey || '');
  if (expected && provided && safeEqual_(expected, provided)) return true;

  // Fallback: an authenticated user with monitor rights.
  try {
    const session = await requireSession(ctx, payload.token);
    const perms = permissionsFor_(session.Role);
    if (perms.indexOf('*') !== -1 || perms.indexOf('monitor.view') !== -1) return true;
  } catch (err) {
    /* not authenticated - fall through */
  }
  throw error_('FORBIDDEN', 'รหัสเข้าถึงจอมอนิเตอร์ไม่ถูกต้อง');
}

/** Returns the current data version (cheap polling endpoint). */
export async function monitorVersion_(ctx, payload) {
  await assertMonitorAccess_(ctx, payload);
  return { version: await currentDataVersion(ctx), now: ctx.now() };
}

/**
 * Returns the data rendered by the smart monitor.
 *
 * The monitor asks for the same data every few seconds - the answer is
 * reused until something is written (120 seconds, like the original).
 */
export async function monitorData_(ctx, payload) {
  await assertMonitorAccess_(ctx, payload);
  // The monitor asks for the same data every few seconds - the answer is
  // reused until something is written.
  const cached = await cacheGet(ctx, 'monitor_payload', 120);
  if (cached) { cached.serverTime = ctx.now(); return cached; }
  const date = ctx.today();
  const monitor = await readKeyValue(ctx.d1, SHEETS.MONITOR);
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);

  const students = await readTable(ctx.d1, SHEETS.STUDENTS);
  const sMap = {};
  students.forEach(function (s) { sMap[s.StudentID] = plain_(s); });
  const classes = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const cMap = {};
  classes.forEach(function (c) { cMap[c.ClassID] = c; });

  // --- Module 1: absenteeism of today only -------------------------------
  const anomalies = await readAnomaliesOfDate_(ctx, date);
  const absenceRows = [];
  const pendingRows = [];
  anomalies.forEach(function (a) {
    if (normalizeDate_(a.AttendanceDate) !== date) return;
    if (a.VerificationStatus === VERIFICATION.DISMISSED) return;
    const s = sMap[a.StudentID] || {};
    const c = cMap[a.ClassID] || null;
    const row = {
      key: a.AnomalyID,
      studentId: a.StudentID,
      name: (s.ThaiFirstName || '') + ' ' + (s.ThaiLastName || ''),
      nameJawi: (s.JawiFirstName || '') + ' ' + (s.JawiLastName || ''),
      grade: s.GradeLevel || '',
      className: c ? c.ClassName : (a.ClassID || ''),
      classId: a.ClassID || '',
      classType: c ? c.ClassType : '',
      anomalyType: a.AnomalyType,
      anomalyLabel: anomalyLabel_(a.AnomalyType),
      verificationStatus: a.VerificationStatus,
      detectedAt: a.DetectedAt
    };
    if (a.AnomalyType === ANOMALY.VERIFICATION_PENDING) pendingRows.push(row);
    else absenceRows.push(row);
  });
  absenceRows.sort(function (x, y) { return String(x.name).localeCompare(String(y.name), 'th'); });
  pendingRows.sort(function (x, y) { return String(x.name).localeCompare(String(y.name), 'th'); });

  // --- Module 2: teacher leaves of today only ----------------------------
  const teachers = await readTable(ctx.d1, SHEETS.TEACHERS);
  const tMap = {};
  teachers.forEach(function (t) { tMap[t.TeacherID] = plain_(t); });
  const leaveRows = [];
  const leaveSource = await readRowsByDate(ctx.d1, SHEETS.LEAVES, 'LeaveDate', date,
    ['LeaveID', 'TeacherID', 'LeaveDate', 'LeaveType', 'Note']);
  leaveSource.forEach(function (l) {
    if (normalizeDate_(l.LeaveDate) !== date) return;
    const t = tMap[l.TeacherID] || {};
    leaveRows.push({
      key: l.LeaveID,
      teacherId: l.TeacherID,
      name: ((t.FirstName || '') + ' ' + (t.LastName || '')).trim(),
      position: t.Position || '',
      department: t.Department || '',
      leaveType: l.LeaveType,
      leaveTypeLabel: leaveTypeLabel_(l.LeaveType),
      note: l.Note || ''
    });
  });
  leaveRows.sort(function (x, y) { return String(x.name).localeCompare(String(y.name), 'th'); });

  // --- Module 3: announcements currently valid ----------------------------
  const annRows = [];
  (await readTable(ctx.d1, SHEETS.ANNOUNCEMENTS)).forEach(function (a) {
    if (String(a.Status || '').toUpperCase() !== 'PUBLISHED') return;
    if (a.StartDate && a.StartDate > date) return;
    if (a.EndDate && a.EndDate < date) return;
    annRows.push({
      key: a.AnnouncementID,
      title: a.Title,
      content: a.Content,
      priority: a.Priority,
      animationType: a.AnimationType,
      textColor: a.TextColor,
      backgroundColor: a.BackgroundColor,
      fontSize: a.FontSize,
      animationSpeed: a.AnimationSpeed
    });
  });
  annRows.sort(function (x, y) { return Number(y.priority) - Number(x.priority); });

  const result = {
    version: await currentDataVersion(ctx),
    serverTime: ctx.now(),
    date: date,
    schoolName: settings.SchoolName || '',
    logoUrl: settings.SchoolLogoUrl || '',
    academicYear: settings.AcademicYear || '',
    semester: settings.Semester || '',
    monitor: {
      title: monitor.Title || 'ระบบจอมอนิเตอร์',
      template: monitor.Template || 'midnight',
      rotationAttendanceSeconds: parseInt(monitor.RotationAttendanceSeconds || '30', 10),
      rotationLeaveSeconds: parseInt(monitor.RotationLeaveSeconds || '20', 10),
      rotationAnnouncementSeconds: parseInt(monitor.RotationAnnouncementSeconds || '25', 10),
      showAttendance: String(monitor.ShowAttendance || 'true') === 'true',
      showLeaves: String(monitor.ShowLeaves || 'true') === 'true',
      showAnnouncements: String(monitor.ShowAnnouncements || 'true') === 'true',
      showPendingAnomalies: String(monitor.ShowPendingAnomalies || 'true') === 'true',
      pollIntervalSeconds: parseInt(monitor.PollIntervalSeconds || '10', 10),
      itemsPerPage: parseInt(monitor.ItemsPerPage || '0', 10),
      absenceCardColumns: Math.min(Math.max(parseInt(monitor.AbsenceCardColumns || '2', 10) || 2, 1), 3),
      leaveCardColumns: Math.min(Math.max(parseInt(monitor.LeaveCardColumns || '2', 10) || 2, 1), 3),
      leaveItemsPerPage: Math.max(parseInt(monitor.LeaveItemsPerPage || '0', 10) || 0, 0),
      leaveFontSize: Math.max(parseInt(monitor.LeaveFontSize || '0', 10) || 0, 0),
      footerText: monitor.FooterText || ''
    },
    absences: absenceRows,
    pending: pendingRows,
    leaves: leaveRows,
    announcements: annRows
  };
  await cachePut(ctx, 'monitor_payload', result, 120);
  return result;
}

/** Reads the monitor settings (management view). */
export async function getMonitorSettings_(ctx, payload) {
  await requirePermission(ctx, payload.token, 'monitor.config');
  return { settings: await readKeyValue(ctx.d1, SHEETS.MONITOR), dataVersion: await currentDataVersion(ctx) };
}

/** Saves the monitor settings. */
export async function saveMonitorSettings_(ctx, payload) {
  const session = await requirePermission(ctx, payload.token, 'monitor.config');
  const data = payload.settings || {};
  const allowed = [
    'Title', 'Template', 'RotationAttendanceSeconds', 'RotationLeaveSeconds', 'RotationAnnouncementSeconds',
    'ShowAttendance', 'ShowLeaves', 'ShowAnnouncements', 'ShowPendingAnomalies',
    'PollIntervalSeconds', 'DefaultAnimationType', 'DefaultFontSize', 'DefaultTextColor',
    'DefaultBackgroundColor', 'DefaultAnimationSpeed', 'ItemsPerPage', 'FooterText',
    'LeaveCardColumns', 'LeaveItemsPerPage', 'LeaveFontSize', 'AbsenceCardColumns'
  ];
  for (const k of allowed) {
    if (data[k] === undefined) continue;
    let v = data[k];
    if (k === 'Template') {
      v = String(v).trim().toLowerCase();
      if (MONITOR_TEMPLATES.indexOf(v) === -1) throw error_('VALIDATION', 'เทมเพลตจอมอนิเตอร์ไม่ถูกต้อง');
    }
    if (k === 'RotationAttendanceSeconds' || k === 'RotationLeaveSeconds' || k === 'RotationAnnouncementSeconds') {
      v = Math.min(Math.max(parseInt(v, 10) || 10, 5), 600);
    }
    if (k === 'PollIntervalSeconds') v = Math.min(Math.max(parseInt(v, 10) || 10, 5), 300);
    if (k === 'DefaultFontSize') v = Math.min(Math.max(parseInt(v, 10) || 48, 16), 200);
    if (k === 'DefaultAnimationSpeed') v = Math.min(Math.max(parseInt(v, 10) || 50, 1), 100);
    if (k === 'ItemsPerPage') v = Math.max(parseInt(v, 10) || 0, 0);
    if (k === 'LeaveCardColumns') v = Math.min(Math.max(parseInt(v, 10) || 2, 1), 3);
    if (k === 'AbsenceCardColumns') v = Math.min(Math.max(parseInt(v, 10) || 2, 1), 3);
    if (k === 'LeaveItemsPerPage') v = Math.max(parseInt(v, 10) || 0, 0);
    if (k === 'LeaveFontSize') v = Math.min(Math.max(parseInt(v, 10) || 0, 0), 120);
    if (k === 'DefaultAnimationType' && ANIMATIONS.indexOf(String(v).toUpperCase()) !== -1) {
      v = String(v).toUpperCase();
    }
    await writeKeyValue(ctx.d1, SHEETS.MONITOR, k, String(v), ctx.now());
  }
  await logAudit(ctx, {
    userId: session.UserID, username: session.Username, role: session.Role,
    action: 'MONITOR_SETTINGS_SAVE', entity: 'Monitor_Settings', details: Object.keys(data).join(', ')
  });
  await bumpDataVersion(ctx);
  return { ok: true, settings: await readKeyValue(ctx.d1, SHEETS.MONITOR) };
}

/* ========================================================================== *
 *  SECTION 15: DASHBOARD & REPORTS
 * ========================================================================== */

/**
 * Builds the aggregation helper for reports.
 *
 * Only the columns that are really needed are read. When a period is given,
 * only the rows of that period are read - the attendance sheets grow with
 * every day of the school year.
 */
export async function attendanceFacts_(ctx, from, to) {
  // The facts are built from the compact sheet - one row per classroom,
  // round and day.
  return await roster.compactFacts_(ctx, from, to);
}

/**
 * The anomalies of one day.
 *
 * The anomalies are calculated from the attendance (they are not stored any
 * more) and the manual decisions of the staff are merged into them - exactly
 * like the anomaly list of the management screen does it.
 */
export async function readAnomaliesOfDate_(ctx, date) {
  const target = normalizeDate_(date);
  if (!target) return [];
  const key = 'ano_' + target;
  // The same lifetime as the monitor payload - a correction of the attendance
  // must not stay invisible on the wall display for a long time.
  const hit = await cacheGet(ctx, key, 120);
  if (hit !== null && hit !== undefined) return hit;
  const computed = await attendance.computeAnomaliesForDate_(ctx, target);
  const verifications = (attendance && typeof attendance.verificationRows_ === 'function')
    ? await attendance.verificationRows_(ctx)
    : await readTable(ctx.d1, SHEETS.ANOMALY_VERIFICATIONS);
  const rows = (attendance && typeof attendance.mergeVerifications_ === 'function')
    ? attendance.mergeVerifications_(computed, verifications)
    : mergeVerifications_(computed, verifications);
  await cachePut(ctx, key, rows, 120);
  return rows;
}

/** Merges the manual decisions into the calculated anomalies. */
function mergeVerifications_(anomalies, verifications) {
  const byId = {};
  (verifications || []).forEach(function (v) { byId[String(v.AnomalyID)] = v; });
  (anomalies || []).forEach(function (a) {
    const v = byId[String(a.AnomalyID)];
    if (!v) return;
    a.VerificationStatus = v.VerificationStatus || a.VerificationStatus;
    a.VerifiedBy = v.VerifiedBy || '';
    a.VerifiedAt = v.VerifiedAt || '';
    a.Note = v.Note || '';
    a.DetectedAt = a.DetectedAt || v.VerifiedAt || '';
  });
  return anomalies;
}

/**
 * Dashboard statistics for the current day.
 *
 * The charts of the last 30 days are calculated here as well - the browser
 * therefore needs one single call instead of five.
 */
export async function dashboardStats_(ctx, payload) {
  await requirePermission(ctx, payload.token, 'dashboard.view');
  const date = normalizeDate_(payload.date) || ctx.today();
  const from = normalizeDate_(payload.from) || daysBefore_(date, 30);
  const to = normalizeDate_(payload.to) || date;
  // The dashboard is opened again and again - the result is reused until
  // something is written. The key is fixed, the period is checked with it.
  const cached = await cacheGet(ctx, 'dashboard_stats', 300);
  if (cached && cached.date === date && cached.from === from && cached.to === to) return cached;
  const students = await readTable(ctx.d1, SHEETS.STUDENTS);
  const teachers = await readTable(ctx.d1, SHEETS.TEACHERS);
  // One read for the whole period - the cards use the day of today, the
  // charts use the whole period.
  const period = await attendanceFacts_(ctx, from, to);
  const facts = period.filter(function (f) { return f.Date === date; });
  const anomalies = await readAnomaliesOfDate_(ctx, date);
  const leaves = (await readTable(ctx.d1, SHEETS.LEAVES))
    .filter(function (l) { return normalizeDate_(l.LeaveDate) === date; });

  const uniqueStudentsAbsent = {};
  const uniqueStudentsLate = {};
  facts.forEach(function (f) {
    if (f.Status === ATT_STATUS.ABSENT) uniqueStudentsAbsent[f.StudentID] = true;
    if (f.Status === ATT_STATUS.LATE) uniqueStudentsLate[f.StudentID] = true;
  });

  const result = {
    date: date,
    from: from,
    to: to,
    totalStudents: students.length,
    totalTeachers: teachers.length,
    activeTeachers: teachers.filter(function (t) { return t.EmploymentStatus === 'ACTIVE'; }).length,
    absentToday: Object.keys(uniqueStudentsAbsent).length,
    lateToday: Object.keys(uniqueStudentsLate).length,
    absentEvents: facts.filter(function (f) { return f.Status === ATT_STATUS.ABSENT; }).length,
    lateEvents: facts.filter(function (f) { return f.Status === ATT_STATUS.LATE; }).length,
    anomaliesToday: anomalies.length,
    confirmedAnomalies: anomalies.filter(function (a) { return a.VerificationStatus === VERIFICATION.CONFIRMED; }).length,
    pendingAnomalies: anomalies.filter(function (a) { return a.VerificationStatus === VERIFICATION.PENDING; }).length,
    teachersOnLeaveToday: leaves.length,
    attendanceEventsToday: facts.length,
    byRound: {
      HOMEROOM: facts.filter(function (f) { return f.AttendanceType === ROUNDS.HOMEROOM; }).length,
      RELIGIOUS: facts.filter(function (f) { return f.AttendanceType === ROUNDS.RELIGIOUS; }).length,
      GENERAL: facts.filter(function (f) { return f.AttendanceType === ROUNDS.GENERAL; }).length
    },
    recentAnomalies: anomalies.slice(-10).reverse().map(function (a) { return plain_(a); }),
    charts: {
      daily: chartDaily_(period),
      type: chartType_(period),
      grade: chartGrade_(period),
      religiousGeneral: chartRelGen_(period)
    }
  };
  await cachePut(ctx, 'dashboard_stats', result, 300);
  return result;
}

/** Chart data: the absences per day. */
export function chartDaily_(rows) {
  const days = {}, daysLate = {}, daysPresent = {};
  (rows || []).forEach(function (f) {
    days[f.Date] = (days[f.Date] || 0) + (f.Status === ATT_STATUS.ABSENT ? 1 : 0);
    daysLate[f.Date] = (daysLate[f.Date] || 0) + (f.Status === ATT_STATUS.LATE ? 1 : 0);
    daysPresent[f.Date] = (daysPresent[f.Date] || 0) + (f.Status === ATT_STATUS.PRESENT ? 1 : 0);
  });
  const labels = Object.keys(days).sort();
  return {
    type: 'daily',
    labels: labels,
    datasets: [
      { label: 'ขาดเรียน', data: labels.map(function (d) { return days[d] || 0; }), color: '#ef4444' },
      { label: 'มาสาย', data: labels.map(function (d) { return daysLate[d] || 0; }), color: '#f59e0b' },
      { label: 'มาเรียน', data: labels.map(function (d) { return daysPresent[d] || 0; }), color: '#10b981' }
    ]
  };
}

/** Chart data: the share of the attendance types. */
export function chartType_(rows) {
  const t = { ABSENT: 0, LATE: 0, PRESENT: 0, LEAVE: 0 };
  (rows || []).forEach(function (f) { if (t[f.Status] !== undefined) t[f.Status]++; });
  return {
    type: 'type',
    labels: ['มาเรียน', 'ขาดเรียน', 'มาสาย', 'ลา'],
    datasets: [{ label: 'จำนวนรายการ', data: [t.PRESENT, t.ABSENT, t.LATE, t.LEAVE], color: '#ec4899' }]
  };
}

/** Chart data: the absences per grade level. */
export function chartGrade_(rows) {
  const absent = (rows || []).filter(function (f) { return f.Status === ATT_STATUS.ABSENT; });
  const g = {};
  absent.forEach(function (f) { g[f.GradeLevel || 'ไม่ระบุ'] = (g[f.GradeLevel || 'ไม่ระบุ'] || 0) + 1; });
  const labels = Object.keys(g).sort();
  return { type: 'grade', labels: labels, datasets: [{ label: 'ขาดเรียนรายระดับชั้น', data: labels.map(function (k) { return g[k]; }), color: '#3b82f6' }] };
}

/** Chart data: religious / general / homeroom comparison. */
export function chartRelGen_(rows) {
  const absent = (rows || []).filter(function (f) { return f.Status === ATT_STATUS.ABSENT; });
  const rel = absent.filter(function (f) { return f.AttendanceType === ROUNDS.RELIGIOUS; }).length;
  const gen = absent.filter(function (f) { return f.AttendanceType === ROUNDS.GENERAL; }).length;
  const hom = absent.filter(function (f) { return f.AttendanceType === ROUNDS.HOMEROOM; }).length;
  return {
    type: 'religiousGeneral',
    labels: ['วิชาศาสนา', 'วิชาสามัญ', 'เช็คชื่อในแถว'],
    datasets: [{ label: 'จำนวนครั้งที่ขาดเรียน', data: [rel, gen, hom], color: '#f97316' }]
  };
}

/**
 * Report data for the chart engine.
 * type: daily | monthly | grade | type | leaveStats | leaveTypes | trend | religiousGeneral
 */
export async function reportData_(ctx, payload) {
  await requirePermission(ctx, payload.token, 'reports.view');
  const from = normalizeDate_(payload.from);
  const to = normalizeDate_(payload.to);
  const grade = String(payload.grade || '');
  const classId = String(payload.classId || '');
  const round = String(payload.round || '');

  // Only the rows of the wanted period are read from the attendance sheets.
  let rows = await attendanceFacts_(ctx, from, to);
  if (grade) rows = rows.filter(function (f) { return f.GradeLevel === grade; });
  if (classId) rows = rows.filter(function (f) { return idEq_(f.ClassID, classId); });
  if (round) rows = rows.filter(function (f) { return f.AttendanceType === round; });

  const type = String(payload.type || 'daily');
  const absent = rows.filter(function (f) { return f.Status === ATT_STATUS.ABSENT; });
  const late = rows.filter(function (f) { return f.Status === ATT_STATUS.LATE; });

  if (type === 'daily') return chartDaily_(rows);
  if (type === 'monthly') {
    const months = {};
    absent.forEach(function (f) {
      const m = String(f.Date).substring(0, 7);
      months[m] = (months[m] || 0) + 1;
    });
    const labels = Object.keys(months).sort();
    return { type: type, labels: labels, datasets: [{ label: 'ขาดเรียนรายเดือน', data: labels.map(function (m) { return months[m]; }), color: '#8b5cf6' }] };
  }
  if (type === 'grade') return chartGrade_(rows);
  if (type === 'type') return chartType_(rows);
  if (type === 'leaveStats' || type === 'leaveTypes') {
    const leaves = (await readTable(ctx.d1, SHEETS.LEAVES)).map(plain_);
    const filtered = leaves.filter(function (l) {
      const d = normalizeDate_(l.LeaveDate);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
    const byType = {};
    filtered.forEach(function (l) { byType[l.LeaveType] = (byType[l.LeaveType] || 0) + 1; });
    const byMonth = {};
    filtered.forEach(function (l) {
      const m = String(normalizeDate_(l.LeaveDate)).substring(0, 7);
      byMonth[m] = (byMonth[m] || 0) + 1;
    });
    const typeLabels = LEAVE_TYPES.map(function (k) { return leaveTypeLabel_(k); });
    const typeData = LEAVE_TYPES.map(function (k) { return byType[k] || 0; });
    const monthLabels = Object.keys(byMonth).sort();
    return {
      type: type,
      labels: type === 'leaveTypes' ? typeLabels : monthLabels,
      datasets: [{
        label: type === 'leaveTypes' ? 'จำนวนการลาแยกประเภท' : 'จำนวนการลารายเดือน',
        data: type === 'leaveTypes' ? typeData : monthLabels.map(function (m) { return byMonth[m]; }),
        color: '#0ea5e9'
      }],
      leaveTypes: typeLabels.map(function (l, i) { return { label: l, value: typeData[i] }; }),
      leaveMonths: monthLabels.map(function (m) { return { label: m, value: byMonth[m] }; })
    };
  }
  if (type === 'trend') {
    const days = {}, leaveDays = {};
    absent.forEach(function (f) { days[f.Date] = (days[f.Date] || 0) + 1; });
    (await readTable(ctx.d1, SHEETS.LEAVES)).forEach(function (l) {
      const d = normalizeDate_(l.LeaveDate);
      if (from && d < from) return;
      if (to && d > to) return;
      leaveDays[d] = (leaveDays[d] || 0) + 1;
    });
    const labels = Array.from(new Set(Object.keys(days).concat(Object.keys(leaveDays)))).sort();
    return {
      type: type,
      labels: labels,
      datasets: [
        { label: 'แนวโน้มการขาดเรียน', data: labels.map(function (d) { return days[d] || 0; }), color: '#ef4444' },
        { label: 'แนวโน้มการลา', data: labels.map(function (d) { return leaveDays[d] || 0; }), color: '#6366f1' }
      ]
    };
  }
  if (type === 'religiousGeneral') return chartRelGen_(rows);
  throw error_('VALIDATION', 'ประเภทรายงานไม่ถูกต้อง');
}

/* ========================================================================== *
 *  SECTION 16: EXCEL IMPORT & EXPORT
 * ========================================================================== */

/** Column aliases accepted by the importer. */
const IMPORT_ALIASES = {
  StudentID: ['StudentID', 'student_id', 'รหัสนักเรียน', 'รหัส', 'ID'],
  ThaiFirstName: ['ThaiFirstName', 'Thai_First_Name', 'first_name_th', 'ชื่อ (ภาษาไทย)', 'ชื่อภาษาไทย', 'ชื่อ'],
  ThaiLastName: ['ThaiLastName', 'Thai_Last_Name', 'last_name_th', 'นามสกุล (ภาษาไทย)', 'นามสกุลภาษาไทย', 'นามสกุล', 'สกุล'],
  JawiFirstName: ['JawiFirstName', 'Jawi_First_Name', 'first_name_jawi', 'ชื่อ (ภาษามลายู)', 'ชื่อภาษามลายู', 'ชื่อยาวี'],
  JawiLastName: ['JawiLastName', 'Jawi_Last_Name', 'last_name_jawi', 'นามสกุล (ภาษามลายู)', 'นามสกุลภาษามลายู', 'นามสกุลยาวี'],
  GradeLevel: ['GradeLevel', 'grade', 'grade_level', 'ระดับชั้น', 'ชั้น'],
  ReligiousClassID: ['ReligiousClassID', 'religious_class', 'ห้องเรียนศาสนา', 'ห้องศาสนา'],
  GeneralClassID: ['GeneralClassID', 'general_class', 'ห้องเรียนสามัญ', 'ห้องสามัญ'],
  HomeroomClassID: ['HomeroomClassID', 'homeroom_class', 'ห้องประจำชั้น', 'ห้องประจำชั้น'],
  StudentStatus: ['StudentStatus', 'status', 'สถานะ'],
  AcademicYear: ['AcademicYear', 'academic_year', 'ปีการศึกษา'],
  TeacherID: ['TeacherID', 'teacher_id', 'รหัสครู', 'รหัสบุคลากร'],
  FirstName: ['FirstName', 'first_name', 'ชื่อ'],
  LastName: ['LastName', 'last_name', 'นามสกุล'],
  Position: ['Position', 'position', 'ตำแหน่ง'],
  Department: ['Department', 'department', 'ฝ่ายงาน', 'แผนก'],
  EmploymentStatus: ['EmploymentStatus', 'employment_status', 'สถานะการจ้างงาน'],
  Username: ['Username', 'username', 'ชื่อผู้ใช้'],
  Role: ['Role', 'role', 'บทบาท'],
  ClassID: ['ClassID', 'class_id', 'รหัสห้องเรียน'],
  ClassName: ['ClassName', 'class_name', 'ชื่อห้องเรียน'],
  ClassType: ['ClassType', 'class_type', 'ประเภทห้องเรียน'],
  SubjectID: ['SubjectID', 'subject_id', 'รหัสวิชา'],
  SubjectName: ['SubjectName', 'subject_name', 'ชื่อวิชา'],
  SubjectType: ['SubjectType', 'subject_type', 'ประเภทวิชา'],
  // Columns of the student list exported by the สช. system.
  NationalID: ['NationalID', 'national_id', 'id_card', 'เลขประจำตัวประชาชน', 'เลขบัตรประชาชน', 'บัตรประชาชน'],
  BirthDate: ['BirthDate', 'birth_date', 'birthdate', 'dob', 'ว.ด.ป. เกิด', 'วันเดือนปีเกิด', 'วันเกิด', 'วดปเกิด'],
  TitlePrefix: ['TitlePrefix', 'title_prefix', 'คำนำหน้าชื่อ', 'คำนำหน้า'],
  RecordedAt: ['RecordedAt', 'recorded_at', 'วันที่บันทึก']
};

/** Field groups used by the importer. */
const IMPORT_FIELDS = {
  students: ['StudentID', 'ThaiFirstName', 'ThaiLastName', 'TitlePrefix', 'JawiFirstName', 'JawiLastName',
    'NationalID', 'BirthDate', 'GradeLevel', 'ReligiousClassID', 'GeneralClassID', 'HomeroomClassID',
    'StudentStatus', 'AcademicYear'],
  teachers: ['TeacherID', 'FirstName', 'LastName', 'Position', 'Department',
    'EmploymentStatus', 'Username', 'Role', 'AcademicYear'],
  classrooms: ['ClassID', 'ClassName', 'ClassType', 'GradeLevel']
};

/**
 * Labels and requirements of the import fields.
 * The client reads this list through the "import.fields" route so that the
 * mapping screen can never drift away from the importer.
 */
const IMPORT_FIELD_META = {
  StudentID: { label: 'รหัสนักเรียน', required: true },
  ThaiFirstName: { label: 'ชื่อ (ภาษาไทย)', required: true },
  ThaiLastName: { label: 'นามสกุล (ภาษาไทย)', required: true },
  TitlePrefix: { label: 'คำนำหน้าชื่อ (รวมกับชื่อภาษาไทย)' },
  JawiFirstName: { label: 'ชื่อ (ภาษามลายูยาวี)' },
  JawiLastName: { label: 'นามสกุล (ภาษามลายูยาวี)' },
  NationalID: { label: 'เลขประจำตัวประชาชน' },
  BirthDate: { label: 'วันเดือนปีเกิด' },
  GradeLevel: { label: 'ระดับชั้น', required: true },
  ReligiousClassID: { label: 'ห้องเรียนศาสนา' },
  GeneralClassID: { label: 'ห้องเรียนสามัญ' },
  HomeroomClassID: { label: 'ห้องประจำชั้น' },
  StudentStatus: { label: 'สถานะนักเรียน' },
  AcademicYear: { label: 'ปีการศึกษา' },
  TeacherID: { label: 'รหัสครู', required: true },
  FirstName: { label: 'ชื่อ (ภาษาไทย)', required: true },
  LastName: { label: 'นามสกุล (ภาษาไทย)', required: true },
  Position: { label: 'ตำแหน่ง' },
  Department: { label: 'ฝ่ายงาน' },
  EmploymentStatus: { label: 'สถานะการจ้างงาน' },
  Username: { label: 'ชื่อผู้ใช้' },
  Role: { label: 'บทบาท' },
  ClassID: { label: 'รหัสห้องเรียน', required: true },
  ClassName: { label: 'ชื่อห้องเรียน', required: true },
  ClassType: { label: 'ประเภทห้องเรียน' }
};

/** Resolves a worksheet header to a canonical field name. */
export function canonicalField_(header, allowedFields) {
  const h = String(header || '').trim();
  const lower = h.toLowerCase();
  const keys = allowedFields && allowedFields.length ? allowedFields : Object.keys(IMPORT_ALIASES);
  for (let i = 0; i < keys.length; i++) {
    const list = IMPORT_ALIASES[keys[i]] || [];
    for (let j = 0; j < list.length; j++) {
      if (list[j].toLowerCase() === lower) return keys[i];
    }
  }
  return null;
}

/**
 * Builds a column map from the raw worksheet headers.
 *
 * Two modes are supported:
 *   1. payload.map - { canonicalField: columnIndex }. The mapping was done
 *      interactively in the browser, so it is used verbatim.
 *   2. payload.columns - the names of the selected columns. The canonical
 *      field is detected from the header name (used by the simple mode).
 *
 * Returns { map:{canonicalField:columnIndex}, canonical:[canonicalField...] }
 */
export function buildColumnMap_(headers, selected, fieldGroup, explicitMap) {
  const allowed = IMPORT_FIELDS[fieldGroup] || null;
  const map = {};
  const canonical = [];

  // Mode 1 - the mapping the user made in the mapping screen.
  if (explicitMap && typeof explicitMap === 'object') {
    Object.keys(explicitMap).forEach(function (field) {
      if (allowed && allowed.indexOf(field) === -1) return;
      const idx = parseInt(explicitMap[field], 10);
      if (isNaN(idx) || idx < 0 || idx >= headers.length) return;
      if (map[field] === undefined) {
        map[field] = idx;
        canonical.push(field);
      }
    });
    if (canonical.length) return { map: map, canonical: canonical };
  }

  // Mode 2 - automatic detection from the header names.
  const sel = (selected && selected.length) ? selected : headers;
  sel.forEach(function (raw) {
    const field = canonicalField_(raw, allowed);
    if (!field) return;
    const idx = headers.indexOf(raw);
    if (idx === -1) return;
    if (map[field] === undefined) {
      map[field] = idx;
      canonical.push(field);
    }
  });
  return { map: map, canonical: canonical };
}

/**
 * Returns the importable fields of a data set together with their labels.
 * The client uses this list to build the column mapping screen.
 */
export async function importFields_(ctx, payload) {
  await requirePermission(ctx, payload.token, payload.type === 'teachers' ? 'teacher.import' : 'student.import');
  const group = String(payload.type || 'students');
  const fields = (IMPORT_FIELDS[group] || IMPORT_FIELDS.students).map(function (key) {
    const meta = IMPORT_FIELD_META[key] || { label: key, required: false };
    return {
      key: key,
      label: meta.label,
      required: !!meta.required,
      aliases: (IMPORT_ALIASES[key] || []).slice()
    };
  });
  return { type: group, fields: fields };
}

/**
 * Imports students from a client side parsed workbook.
 * payload: { headers:[...], columns:[selected raw headers], rows:[[value,...]] }
 */
export async function importStudents_(ctx, payload) {
  const session = await requirePermission(ctx, payload.token, 'student.import');
  const headers = payload.headers || [];
  const rows = payload.rows || [];
  if (!headers.length) throw error_('VALIDATION', 'ไม่พบหัวตารางของไฟล์ที่นำเข้า');
  if (!rows.length) throw error_('VALIDATION', 'ไม่พบข้อมูลในไฟล์');
  if (rows.length > APP.MAX_IMPORT_ROWS) {
    throw error_('VALIDATION', 'จำนวนแถวสูงสุดที่นำเข้าได้คือ ' + APP.MAX_IMPORT_ROWS + ' แถว');
  }
  const cm = buildColumnMap_(headers, payload.columns, 'students', payload.map);
  if (cm.canonical.indexOf('StudentID') === -1) throw error_('VALIDATION', 'ต้องเลือกคอลัมน์รหัสนักเรียน (StudentID)');

  const students = await readTable(ctx.d1, SHEETS.STUDENTS);
  const index = {};
  students.forEach(function (s) { index[String(s.StudentID)] = s; });
  const classes = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  const academicYear = settings.AcademicYear || '';

  const toInsert = [], toUpdate = [], unchanged = [], errors = [], duplicates = [];
  const seen = {};

  rows.forEach(function (row, idx) {
    const obj = {};
    cm.canonical.forEach(function (field) { obj[field] = row[cm.map[field]]; });
    const sid = String(obj.StudentID === undefined || obj.StudentID === null ? '' : obj.StudentID).trim();
    // The row number of the original sheet is reported back to the user.
    const lineNo = (payload.rowNumbers && payload.rowNumbers[idx]) ? payload.rowNumbers[idx] : (idx + 2);
    if (!sid) { errors.push({ row: lineNo, message: 'ไม่มีรหัสนักเรียน' }); return; }
    if (seen[sid]) { duplicates.push({ row: lineNo, message: 'รหัส ' + sid + ' ซ้ำภายในไฟล์' }); return; }
    seen[sid] = true;

    const existing = index[sid];

    // The target record starts from the existing row (so unselected columns are
    // preserved) and only the selected columns are overwritten.
    const rec = existing ? plain_(existing) : newStudentRecord_(ctx, obj);
    cm.canonical.forEach(function (field) {
      if (field === 'StudentID' || field === 'TitlePrefix') return;
      let v = obj[field];
      if (v === undefined || v === null) v = '';
      rec[field] = String(v).trim();
    });
    rec.StudentID = sid;

    // The title prefix of the สช. file ("เด็กชาย" / "เด็กหญิง") belongs to the
    // first name - it is merged so that no information is lost.
    if (cm.canonical.indexOf('TitlePrefix') !== -1) {
      const prefix = String(obj.TitlePrefix === undefined || obj.TitlePrefix === null ? '' : obj.TitlePrefix).trim();
      if (prefix && rec.ThaiFirstName && rec.ThaiFirstName.indexOf(prefix) !== 0) {
        rec.ThaiFirstName = prefix + ' ' + rec.ThaiFirstName;
      }
    }
    // The grade level of the สช. file is written as "อ.1/1" - only the part in
    // front of the slash is the grade.
    if (rec.GradeLevel && String(rec.GradeLevel).indexOf('/') !== -1) {
      rec.GradeLevel = String(rec.GradeLevel).split('/')[0].trim();
    }
    // Status values of the สช. file are in Thai.
    rec.StudentStatus = normalizeStudentStatus(rec.StudentStatus);

    // Required fields are validated against the merged record.
    if (!rec.ThaiFirstName) { errors.push({ row: lineNo, message: 'ไม่มีชื่อภาษาไทยสำหรับรหัส ' + sid }); return; }
    if (!rec.GradeLevel) { errors.push({ row: lineNo, message: 'ไม่มีระดับชั้นสำหรับรหัส ' + sid }); return; }

    // Class resolution: accept ClassID or the classroom name (type checked).
    let classError = '';
    if (cm.canonical.indexOf('ReligiousClassID') !== -1) {
      const resolved = resolveClass_(classes, rec.ReligiousClassID, 'RELIGIOUS');
      if (resolved.error) classError = 'ห้องศาสนา: ' + resolved.error;
      else rec.ReligiousClassID = resolved.ClassID;
    }
    if (!classError && cm.canonical.indexOf('GeneralClassID') !== -1) {
      const resolved = resolveClass_(classes, rec.GeneralClassID, 'GENERAL');
      if (resolved.error) classError = 'ห้องสามัญ: ' + resolved.error;
      else rec.GeneralClassID = resolved.ClassID;
    }
    if (!classError && cm.canonical.indexOf('HomeroomClassID') !== -1) {
      const resolved = resolveClass_(classes, rec.HomeroomClassID, 'HOMEROOM');
      if (resolved.error) classError = 'ห้องประจำชั้น: ' + resolved.error;
      else rec.HomeroomClassID = resolved.ClassID;
    }
    if (classError) { errors.push({ row: lineNo, message: 'รหัส ' + sid + ' - ' + classError }); return; }
    // The religious and the general classrooms are two independent systems.

    if (!existing) {
      if (!rec.AcademicYear) rec.AcademicYear = academicYear;
      rec.CreatedAt = ctx.now();
      rec.UpdatedAt = ctx.now();
      toInsert.push(rec);
      return;
    }

    // Incremental update - only the selected columns are compared and written.
    let changed = false;
    cm.canonical.forEach(function (c) {
      if (c === 'StudentID' || c === 'TitlePrefix') return;
      const nv = rec[c] === undefined || rec[c] === null ? '' : String(rec[c]).trim();
      const ov = existing[c] === undefined || existing[c] === null ? '' : String(existing[c]).trim();
      if (nv !== ov) changed = true;
    });
    if (!changed) { unchanged.push(sid); return; }
    const merged = plain_(existing);
    cm.canonical.forEach(function (c) {
      if (c === 'StudentID' || c === 'TitlePrefix') return;
      merged[c] = rec[c];
    });
    merged.StudentID = sid;
    merged.CreatedAt = existing.CreatedAt;
    merged.UpdatedAt = ctx.now();
    toUpdate.push(merged);
  });

  if (toInsert.length) await upsertRows(ctx.d1, SHEETS.STUDENTS, toInsert);
  if (toUpdate.length) await upsertRows(ctx.d1, SHEETS.STUDENTS, toUpdate);
  await logAudit(ctx, {
    userId: session.UserID, username: session.Username, role: session.Role,
    action: 'STUDENT_IMPORT', entity: 'Students',
    details: 'เพิ่ม ' + toInsert.length + ' / อัปเดต ' + toUpdate.length + ' / ข้อผิดพลาด ' + errors.length
  });
  await bumpDataVersion(ctx);
  return {
    ok: true,
    inserted: toInsert.length,
    updated: toUpdate.length,
    unchanged: unchanged.length,
    errors: errors.length,
    duplicates: duplicates.length,
    errorList: errors.slice(0, 50),
    duplicateList: duplicates.slice(0, 50)
  };
}

/**
 * Resolves a classroom reference (id or name) with a strict type check.
 * Ambiguous names across types are rejected.
 */
export function resolveClass_(classes, value, expectedType) {
  const v = String(value === undefined || value === null ? '' : value).trim();
  if (!v) return { ClassID: '' };
  const byId = (classes || []).filter(function (c) { return idEq_(c.ClassID, v); })[0];
  if (byId) {
    if (byId.ClassType !== expectedType) {
      return { error: 'ห้อง "' + byId.ClassName + '" เป็นห้องประเภท ' + byId.ClassType + ' ไม่ใช่ ' + expectedType };
    }
    return { ClassID: byId.ClassID };
  }
  const byName = (classes || []).filter(function (c) {
    return String(c.ClassName || '').trim().toLowerCase() === v.toLowerCase();
  });
  if (!byName.length) return { error: 'ไม่พบห้องเรียน "' + v + '"' };
  const typed = byName.filter(function (c) { return c.ClassType === expectedType; });
  if (!typed.length) {
    return { error: 'ห้อง "' + v + '" ไม่ใช่ห้องประเภท ' + expectedType };
  }
  if (typed.length > 1) {
    return { error: 'พบห้องเรียนชื่อ "' + v + '" หลายห้องในประเภทนี้ กรุณาใช้รหัสห้องเรียนแทน' };
  }
  return { ClassID: typed[0].ClassID };
}

/** Imports teachers from a client side parsed workbook. */
export async function importTeachers_(ctx, payload) {
  const session = await requirePermission(ctx, payload.token, 'teacher.import');
  const headers = payload.headers || [];
  const rows = payload.rows || [];
  if (!headers.length) throw error_('VALIDATION', 'ไม่พบหัวตารางของไฟล์ที่นำเข้า');
  if (!rows.length) throw error_('VALIDATION', 'ไม่พบข้อมูลในไฟล์');
  const cm = buildColumnMap_(headers, payload.columns, 'teachers', payload.map);
  if (cm.canonical.indexOf('TeacherID') === -1) throw error_('VALIDATION', 'ต้องเลือกคอลัมน์รหัสครู (TeacherID)');

  const teachers = await readTable(ctx.d1, SHEETS.TEACHERS);
  const index = {};
  teachers.forEach(function (t) { index[String(t.TeacherID)] = t; });
  const toInsert = [], toUpdate = [], unchanged = [], errors = [], duplicates = [];
  const seen = {};

  rows.forEach(function (row, idx) {
    const obj = {};
    cm.canonical.forEach(function (field) { obj[field] = row[cm.map[field]]; });
    const tid = String(obj.TeacherID === undefined || obj.TeacherID === null ? '' : obj.TeacherID).trim();
    const lineNo = (payload.rowNumbers && payload.rowNumbers[idx]) ? payload.rowNumbers[idx] : (idx + 2);
    if (!tid) { errors.push({ row: lineNo, message: 'ไม่มีรหัสครู' }); return; }
    if (seen[tid]) { duplicates.push({ row: lineNo, message: 'รหัส ' + tid + ' ซ้ำภายในไฟล์' }); return; }
    seen[tid] = true;
    const existing = index[tid];

    // Start from the existing row so unselected columns are preserved.
    const rec = existing ? plain_(existing) : {
      TeacherID: tid, FirstName: '', LastName: '', Position: '', Department: '',
      EmploymentStatus: 'ACTIVE', Username: '', Role: ROLES.TEACHER, AcademicYear: '',
      CreatedAt: ctx.now(), UpdatedAt: ctx.now()
    };
    cm.canonical.forEach(function (field) {
      if (field === 'TeacherID') return;
      let v = obj[field];
      if (v === undefined || v === null) v = '';
      rec[field] = String(v).trim();
    });
    rec.TeacherID = tid;

    if (!rec.FirstName || !rec.LastName) {
      errors.push({ row: lineNo, message: 'รหัส ' + tid + ' - ข้อมูลชื่อไม่ครบ' }); return;
    }
    if (!existing) {
      if (!rec.UpdatedAt) rec.UpdatedAt = ctx.now();
      toInsert.push(rec);
      return;
    }
    let changed = false;
    cm.canonical.forEach(function (c) {
      if (c === 'TeacherID') return;
      const nv = rec[c] === undefined || rec[c] === null ? '' : String(rec[c]).trim();
      const ov = existing[c] === undefined || existing[c] === null ? '' : String(existing[c]).trim();
      if (nv !== ov) changed = true;
    });
    if (!changed) { unchanged.push(tid); return; }
    const merged = plain_(existing);
    cm.canonical.forEach(function (c) { if (c !== 'TeacherID') merged[c] = rec[c]; });
    merged.TeacherID = tid;
    merged.CreatedAt = existing.CreatedAt;
    merged.UpdatedAt = ctx.now();
    toUpdate.push(merged);
  });

  if (toInsert.length) await upsertRows(ctx.d1, SHEETS.TEACHERS, toInsert);
  if (toUpdate.length) await upsertRows(ctx.d1, SHEETS.TEACHERS, toUpdate);
  await logAudit(ctx, {
    userId: session.UserID, username: session.Username, role: session.Role,
    action: 'TEACHER_IMPORT', entity: 'Teachers',
    details: 'เพิ่ม ' + toInsert.length + ' / อัปเดต ' + toUpdate.length + ' / ข้อผิดพลาด ' + errors.length
  });
  await bumpDataVersion(ctx);
  return {
    ok: true,
    inserted: toInsert.length, updated: toUpdate.length, unchanged: unchanged.length,
    errors: errors.length, duplicates: duplicates.length,
    errorList: errors.slice(0, 50), duplicateList: duplicates.slice(0, 50)
  };
}

/* ========================================================================== *
 *  PRIVATE HELPERS OF THE IMPORTER
 * ========================================================================== */

/**
 * The base record of a new student.
 *
 * The mapping itself belongs to the directory module; the fallback below is
 * the original mapping of Code.gs and guarantees that the import works even
 * when the directory module is not available yet.
 */
function newStudentRecord_(ctx, src) {
  if (directory && typeof directory.mapStudent_ === 'function') {
    try {
      const mapped = directory.mapStudent_.length >= 3
        ? directory.mapStudent_(ctx, src, null)
        : directory.mapStudent_(src, null);
      if (mapped && typeof mapped === 'object' && mapped.ThaiFirstName !== undefined) return mapped;
    } catch (err) {
      /* the fallback below is used instead */
    }
  }
  return {
    StudentID: String(src.StudentID || '').trim(),
    ThaiFirstName: String(src.ThaiFirstName || '').trim(),
    ThaiLastName: String(src.ThaiLastName || '').trim(),
    JawiFirstName: String(src.JawiFirstName || '').trim(),
    JawiLastName: String(src.JawiLastName || '').trim(),
    GradeLevel: String(src.GradeLevel || '').trim(),
    ReligiousClassID: String(src.ReligiousClassID || '').trim(),
    GeneralClassID: String(src.GeneralClassID || '').trim(),
    HomeroomClassID: String(src.HomeroomClassID || '').trim(),
    StudentStatus: String(src.StudentStatus || 'ACTIVE').trim().toUpperCase(),
    AcademicYear: String(src.AcademicYear || '').trim(),
    NationalID: String(src.NationalID || '').trim(),
    BirthDate: String(src.BirthDate || '').trim(),
    CreatedAt: ctx.now(),
    UpdatedAt: ctx.now()
  };
}

/** Normalises a student status value (the สช. file writes it in Thai). */
function normalizeStudentStatus(value) {
  if (directory && typeof directory.normalizeStudentStatus_ === 'function') {
    try { return directory.normalizeStudentStatus_(value); } catch (err) { /* fallback below */ }
  }
  const v = String(value === undefined || value === null ? '' : value).trim();
  if (!v) return 'ACTIVE';
  const upper = v.toUpperCase();
  if (upper === 'ACTIVE' || upper === 'INACTIVE' || upper === 'GRADUATED') return upper;
  const map = {
    'กำลังศึกษาอยู่': 'ACTIVE',
    'กำลังศึกษา': 'ACTIVE',
    'อยู่ในระบบ': 'ACTIVE',
    'ปกติ': 'ACTIVE',
    'จบการศึกษา': 'GRADUATED',
    'จบการศึกษาแล้ว': 'GRADUATED',
    'สำเร็จการศึกษา': 'GRADUATED',
    'พักการเรียน': 'INACTIVE',
    'ลาสักษา': 'INACTIVE',
    'ไม่ใช้งาน': 'INACTIVE',
    'เลิกศึกษา': 'INACTIVE',
    'ย้ายโรงเรียน': 'INACTIVE'
  };
  if (map[v]) return map[v];
  for (const k in map) {
    if (map[k] === upper) return map[k];
  }
  return 'ACTIVE';
}
