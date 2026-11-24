/**
 * ============================================================================
 *  SSMS on Cloudflare - Attendance, statistics and anomalies
 *
 *  Ported 1:1 from v3-compact/Code.gs:
 *    SECTION 10   attendance sheet / save / list / status / delete
 *    SECTION 10b  attendance statistics and leave statistics
 *    SECTION 11   anomaly detection (calculated, never stored)
 *
 *  THE COMPACT SCHEME (v3)
 *  -----------------------
 *  The attendance is not stored per student any more. One row of
 *  `attendance_daily` holds the letters of one classroom / round / day:
 *
 *      P = PRESENT   A = ABSENT   L = LATE   V = LEAVE   '-' = not checked
 *
 *  The order of the letters is the order of the roster (`class_rosters`).
 *  Every read and every write of that data goes through the helpers of
 *  `_lib/roster.js` - this module never touches the table itself.
 *
 *  The response shapes are identical to the original - the browser does not
 *  have to change.
 * ============================================================================
 */

import {
  SHEETS, ROUNDS, ROUND_SHEET, ROUND_CLASS_TYPE,
  ATT_STATUS, THAI_STATUS, Jawi_STATUS, ANOMALY, VERIFICATION,
  LEAVE_TYPES, ROLES, GRADE_GROUPS_GENERAL, GRADE_GROUPS_RELIGIOUS
} from './constants.js';

import { readTable, readKeyValue, upsertRows, readRowsByDateRange } from './db.js';

import {
  error_, normalizeDate_, sortBy_, plain_, dateRange_, daysBefore_,
  idEq_, requireText_, now_
} from './util.js';

import {
  round1RoomType_, isNoStudyClass_, isSecondaryGrade_, studentClassFieldFor_,
  compactStatus_, rosterIdsOf_, currentRoster_, compactDayRows_,
  compactStatusMap_, writeCompactRow_, writeCompactDay_, compactFacts_
} from './roster.js';

import { applyStudentScope_ } from './directory.js';
import { teacherClassScope_, assertAttendanceScope_, leaveTypeLabel_ } from './auth.js';

/* ==========================================================================
 * SECTION 10: ATTENDANCE MANAGEMENT
 * ========================================================================== */

/**
 * The attendance sheet of one classroom, round and day.
 *
 * The list of the students comes from the Students table (exactly like the
 * original), the status of the day comes from the compact sheet.
 */
export async function attendanceSheet_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'attendance.view');
  const round = String(payload.round || '').toUpperCase();
  if (!ROUND_SHEET[round]) throw error_('VALIDATION', 'ประเภทการเช็คชื่อไม่ถูกต้อง');
  const date = normalizeDate_(payload.date) || ctx.today();
  const classes = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);

  let classroom = null;
  if (payload.classId) {
    classroom = classes.filter(function (c) { return idEq_(c.ClassID, payload.classId); })[0];
    if (!classroom) throw error_('VALIDATION', 'ไม่พบห้องเรียนที่เลือก');
    if (round === ROUNDS.RELIGIOUS && classroom.ClassType !== 'RELIGIOUS') {
      throw error_('VALIDATION', 'รอบเช็คชื่อวิชาศาสนาต้องเลือกห้องเรียนศาสนาเท่านั้น');
    }
    if (round === ROUNDS.GENERAL && classroom.ClassType !== 'GENERAL') {
      throw error_('VALIDATION', 'รอบเช็คชื่อวิชาสามัญต้องเลือกห้องเรียนสามัญเท่านั้น');
    }
    // The general room 'ไม่เรียน' is a place holder for the students who only
    // study the religious subject - it is never checked.
    if (isNoStudyClass_(classroom) && (round === ROUNDS.GENERAL ||
        (round === ROUNDS.HOMEROOM && round1RoomType_(settings) === 'GENERAL'))) {
      throw error_('VALIDATION', 'ห้องเรียนนี้ไม่มีการเรียนวิชาสามัญ จึงไม่ต้องเช็คชื่อ');
    }
  }
  const field = studentClassFieldFor_(round, classroom, settings);
  let students = (await readTable(ctx.d1, SHEETS.STUDENTS)).map(plain_);
  // The classroom was chosen by the user - the roster of that classroom is
  // shown completely, no matter which classrooms the teacher is assigned to.
  students = await applyStudentScope_(ctx, students, session, true);
  if (classroom) {
    students = students.filter(function (s) { return String(s[field] || '') === String(classroom.ClassID); });
  }
  students = sortBy_(students, 'StudentID');

  // The status of the day comes from the compact sheet - one row per
  // classroom, round and day.
  const map = {};
  if (classroom) {
    const day = await compactStatusMap_(ctx, date, round, classroom.ClassID);
    Object.keys(day.statuses).forEach(function (id) {
      map[id] = { Status: day.statuses[id], RecordedBy: day.recordedBy, UpdatedAt: '' };
    });
  }

  const rows = students.map(function (s) {
    const rec = map[s.StudentID];
    return {
      StudentID: s.StudentID,
      ThaiFirstName: s.ThaiFirstName,
      ThaiLastName: s.ThaiLastName,
      JawiFirstName: s.JawiFirstName,
      JawiLastName: s.JawiLastName,
      GradeLevel: s.GradeLevel,
      FullNameThai: (s.ThaiFirstName || '') + ' ' + (s.ThaiLastName || ''),
      FullNameJawi: (s.JawiFirstName || '') + ' ' + (s.JawiLastName || ''),
      Status: rec ? String(rec.Status) : '',
      AttendanceID: rec ? attendanceId_(round, date, s.StudentID) : '',
      RecordedBy: rec ? rec.RecordedBy : '',
      UpdatedAt: rec ? plain_(rec).UpdatedAt : ''
    };
  });

  // Round 1 follows the classroom system the administrator chose. When that
  // is the religious system and the class belongs to the secondary level, the
  // roster is shown exactly like the religious round (Jawi names and status).
  const round1Type = round1RoomType_(settings);
  const useJawi = round === ROUNDS.RELIGIOUS ||
    (round === ROUNDS.HOMEROOM && round1Type === 'RELIGIOUS' &&
      isSecondaryGrade_(classroom ? classroom.GradeLevel : '', settings));

  return {
    round: round,
    date: date,
    classId: classroom ? classroom.ClassID : '',
    className: classroom ? classroom.ClassName : '',
    classType: classroom ? classroom.ClassType : '',
    round1RoomType: round1Type,
    useJawi: useJawi,
    statusLabels: useJawi ? Jawi_STATUS : THAI_STATUS,
    rows: rows,
    total: rows.length
  };
}

/**
 * Attendance statistics of a period.
 *
 * The report separates the religious subject from the general subject, sorts
 * the result by grade group and returns the totals of every group plus the
 * grand total. Round 1 belongs to the classroom system the administrator
 * chose, so its records are only used when the subject has no record yet.
 */
export async function attendanceStats_(ctx, payload) {
  await ctx.requirePermission(payload.token, 'attendance.view');
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  const today = ctx.today();
  const single = normalizeDate_(payload.date);
  let from = normalizeDate_(payload.from) || single || today;
  let to = normalizeDate_(payload.to) || single || from;
  if (from > to) { const t = from; from = to; to = t; }
  // The statistics are asked for again and again - the result is reused until
  // something is written. The key is fixed, the period is checked with it.
  const cached = await ctx.cacheGet('attendance_stats', 300);
  if (cached && cached.from === from && cached.to === to) return cached;
  const days = dateRange_(from, to);

  const students = (await readTable(ctx.d1, SHEETS.STUDENTS)).map(plain_)
    .filter(function (s) { return String(s.StudentStatus || 'ACTIVE').toUpperCase() !== 'INACTIVE'; });
  const sMap = {};
  students.forEach(function (s) { sMap[String(s.StudentID)] = s; });

  // The classrooms - they tell the grade level and the special rooms.
  const classMap = {};
  (await readTable(ctx.d1, SHEETS.CLASSROOMS)).map(plain_).forEach(function (c) {
    classMap[String(c.ClassID)] = c;
  });
  // True when the student sits in the general room 'ไม่เรียน'.
  function noStudyStudent_(studentId) {
    const stu = sMap[String(studentId === null || studentId === undefined ? '' : studentId)];
    if (!stu) return false;
    return isNoStudyClass_(classMap[String(stu.GeneralClassID || '').trim()]);
  }

  // Records per subject and day.
  const rec = { religious: {}, general: {} };
  function put(subject, date, studentId, status) {
    if (!date || date < from || date > to) return;
    if (!rec[subject][date]) rec[subject][date] = {};
    if (!rec[subject][date][studentId]) rec[subject][date][studentId] = status;
  }
  // Round 1 belongs to the system the administrator chose.
  const fallback = round1RoomType_(settings) === 'GENERAL' ? 'general' : 'religious';
  // The records of the wanted period come from the compact sheet.
  (await compactFacts_(ctx, from, to)).forEach(function (a) {
    const studentId = String(a.StudentID);
    const status = String(a.Status || '').toUpperCase();
    if (a.AttendanceType === ROUNDS.RELIGIOUS) {
      put('religious', a.Date, studentId, status);
      return;
    }
    if (a.AttendanceType === ROUNDS.GENERAL) {
      // The students of the general room 'ไม่เรียน' do not take part in the
      // general statistics at all.
      if (noStudyStudent_(studentId)) return;
      put('general', a.Date, studentId, status);
      return;
    }
    if (fallback === 'general' && noStudyStudent_(studentId)) return;
    put(fallback, a.Date, studentId, status);
  });
  const roster = { religious: {}, general: {} };
  students.forEach(function (s) {
    const r = String(s.ReligiousClassID || '').trim();
    if (r) { if (!roster.religious[r]) roster.religious[r] = []; roster.religious[r].push(s); }
    const g = String(s.GeneralClassID || '').trim();
    // The general room 'ไม่เรียน' only groups the students who study the
    // religious subject alone - it never appears in the statistics.
    if (g && !isNoStudyClass_(classMap[g])) {
      if (!roster.general[g]) roster.general[g] = [];
      roster.general[g].push(s);
    }
  });

  const subjects = ['religious', 'general'];
  const groups = { religious: GRADE_GROUPS_RELIGIOUS, general: GRADE_GROUPS_GENERAL };

  // --- per day ------------------------------------------------------
  const dayRows = days.map(function (date) {
    const row = { date: date, religious: emptyCounts_(), general: emptyCounts_() };
    subjects.forEach(function (subject) {
      const map = rec[subject][date] || {};
      Object.keys(map).forEach(function (id) {
        addStatus_(row[subject], map[id]);
      });
      // The expected number of students of that day.
      Object.keys(roster[subject]).forEach(function (roomId) {
        row[subject].expected += roster[subject][roomId].length;
      });
      row[subject].missing = Math.max(0, row[subject].expected - row[subject].recorded);
    });
    return row;
  });

  // --- per grade group ----------------------------------------------
  const byGrade = { religious: [], general: [] };
  subjects.forEach(function (subject) {
    const list = groups[subject].slice();
    const found = {};
    Object.keys(roster[subject]).forEach(function (roomId) {
      const members = roster[subject][roomId];
      const room = classMap[roomId] || {};
      const gradeLevel = String(room.GradeLevel || (members[0] ? members[0].GradeLevel : ''));
      const group = gradeGroupOf_(gradeLevel, subject) || 'อื่น ๆ';
      const counter = emptyCounts_();
      counter.group = group;
      counter.classId = roomId;
      counter.className = String(room.ClassName || roomId);
      counter.gradeLevel = gradeLevel;
      // One check per student and per day of the period.
      counter.expected = members.length * days.length;
      members.forEach(function (s) {
        days.forEach(function (date) {
          const map = rec[subject][date] || {};
          const st = map[String(s.StudentID)];
          if (st) addStatus_(counter, st);
        });
      });
      counter.missing = Math.max(0, counter.expected - counter.recorded);
      if (!found[group]) found[group] = { group: group, rows: [], total: emptyCounts_() };
      found[group].rows.push(counter);
      const sub = found[group].total;
      sub.expected += counter.expected;
      sub.present += counter.present;
      sub.absent += counter.absent;
      sub.late += counter.late;
      sub.leave += counter.leave;
      sub.recorded += counter.recorded;
      sub.total += counter.total;
    });
    const ordered = Object.keys(found).map(function (g) { return found[g]; });
    // keep the fixed order first, the unknown groups at the end
    ordered.sort(function (a, b) {
      const ia = list.indexOf(a.group); const ib = list.indexOf(b.group);
      if (ia === -1 && ib === -1) return a.group.localeCompare(b.group, 'th');
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    ordered.forEach(function (g) {
      g.rows.sort(function (a, b) { return String(a.className).localeCompare(String(b.className), 'th'); });
      g.total.missing = Math.max(0, g.total.expected - g.total.recorded);
    });
    byGrade[subject] = ordered;
  });

  const summary = { religious: emptyCounts_(), general: emptyCounts_() };
  subjects.forEach(function (subject) {
    byGrade[subject].forEach(function (g) {
      const r = g.total;
      summary[subject].present += r.present;
      summary[subject].absent += r.absent;
      summary[subject].late += r.late;
      summary[subject].leave += r.leave;
      summary[subject].recorded += r.recorded;
      summary[subject].expected += r.expected;
    });
    summary[subject].missing = Math.max(0, summary[subject].expected - summary[subject].recorded);
    summary[subject].total = summary[subject].present + summary[subject].absent + summary[subject].late + summary[subject].leave;
  });
  const grand = emptyCounts_();
  subjects.forEach(function (subject) {
    grand.present += summary[subject].present;
    grand.absent += summary[subject].absent;
    grand.late += summary[subject].late;
    grand.leave += summary[subject].leave;
    grand.recorded += summary[subject].recorded;
    grand.expected += summary[subject].expected;
  });
  grand.missing = Math.max(0, grand.expected - grand.recorded);
  grand.total = grand.present + grand.absent + grand.late + grand.leave;

  const result = {
    from: from, to: to, days: dayRows, byGrade: byGrade,
    summary: summary, grand: grand,
    gradeGroups: { religious: GRADE_GROUPS_RELIGIOUS, general: GRADE_GROUPS_GENERAL }
  };
  await ctx.cachePut('attendance_stats', result, 300);
  return result;
}

/**
 * Leave statistics of the staff.
 * The period can be a single day or a range; the result contains the totals
 * per day, the totals per leave type and the list of the staff members.
 */
export async function leaveStats_(ctx, payload) {
  await ctx.requirePermission(payload.token, 'leave.view');
  const today = ctx.today();
  const single = normalizeDate_(payload.date);
  let from = normalizeDate_(payload.from) || single || today;
  let to = normalizeDate_(payload.to) || single || from;
  if (from > to) { const t = from; from = to; to = t; }
  const days = dateRange_(from, to);

  const teachers = (await readTable(ctx.d1, SHEETS.TEACHERS)).map(plain_);
  const tMap = {};
  teachers.forEach(function (t) { tMap[String(t.TeacherID)] = t; });

  // The leaves of the period - the table is read with the date index.
  const raw = (from && to)
    ? await readRowsByDateRange(ctx.d1, SHEETS.LEAVES, 'LeaveDate', from, to)
    : await readTable(ctx.d1, SHEETS.LEAVES);
  const rows = raw.map(plain_).filter(function (l) {
    const d = normalizeDate_(l.LeaveDate);
    return d && d >= from && d <= to;
  });

  const byDay = {};
  const byType = {};
  const byTeacher = {};
  LEAVE_TYPES.forEach(function (t) { byType[t] = 0; });
  rows.forEach(function (l) {
    const d = normalizeDate_(l.LeaveDate);
    const type = String(l.LeaveType || 'OTHER').toUpperCase();
    if (!byDay[d]) byDay[d] = { date: d, total: 0, types: {} };
    LEAVE_TYPES.forEach(function (t) { if (!byDay[d].types[t]) byDay[d].types[t] = 0; });
    byDay[d].total++;
    byDay[d].types[type] = (byDay[d].types[type] || 0) + 1;
    byType[type] = (byType[type] || 0) + 1;
    const tid = String(l.TeacherID || '');
    const t = tMap[tid] || {};
    if (!byTeacher[tid]) {
      byTeacher[tid] = {
        teacherId: tid, name: ((t.FirstName || '') + ' ' + (t.LastName || '')).trim(),
        position: t.Position || '', department: t.Department || '', total: 0, types: {}
      };
      LEAVE_TYPES.forEach(function (x) { byTeacher[tid].types[x] = 0; });
    }
    byTeacher[tid].total++;
    byTeacher[tid].types[type] = (byTeacher[tid].types[type] || 0) + 1;
  });

  const dayRows = days.map(function (d) {
    return byDay[d] || { date: d, total: 0, types: {} };
  });
  const teacherRows = Object.keys(byTeacher).map(function (k) { return byTeacher[k]; })
    .sort(function (a, b) { return b.total - a.total; });
  const typeRows = LEAVE_TYPES.map(function (t) {
    return { type: t, label: leaveTypeLabel_(t), count: byType[t] || 0 };
  });

  const result = {
    from: from, to: to, days: dayRows, types: typeRows, teachers: teacherRows,
    total: rows.length, teacherCount: teacherRows.length
  };
  // The leave statistics have their own cache key - the original used the key
  // of the attendance statistics, so a leave report could overwrite the
  // attendance report of the same period.
  await ctx.cachePut('leave_stats', result, 300);
  return result;
}

/** Deterministic attendance id - guarantees idempotent (duplicate safe) saves. */
export function attendanceId_(round, date, studentId) {
  return 'ATT-' + round.substring(0, 3) + '-' + date.replace(/-/g, '') + '-' + studentId;
}

/** Saves attendance records in batch. */
export async function saveAttendance_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'attendance.record');
  const round = String(payload.round || '').toUpperCase();
  if (!ROUND_SHEET[round]) throw error_('VALIDATION', 'ประเภทการเช็คชื่อไม่ถูกต้อง');
  const date = normalizeDate_(payload.date) || ctx.today();
  const classId = requireText_(payload.classId, 'ห้องเรียน');
  assertAttendanceScope_(session, round, classId);

  const classes = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const classroom = classes.filter(function (c) { return idEq_(c.ClassID, classId); })[0];
  if (!classroom) throw error_('VALIDATION', 'ไม่พบห้องเรียน: ' + classId);
  if (round === ROUNDS.RELIGIOUS && classroom.ClassType !== 'RELIGIOUS') {
    throw error_('VALIDATION', 'รอบเช็คชื่อวิชาศาสนาต้องเลือกห้องเรียนศาสนาเท่านั้น');
  }
  if (round === ROUNDS.GENERAL && classroom.ClassType !== 'GENERAL') {
    throw error_('VALIDATION', 'รอบเช็คชื่อวิชาสามัญต้องเลือกห้องเรียนสามัญเท่านั้น');
  }

  const records = payload.records || [];
  if (!records.length) throw error_('VALIDATION', 'ไม่มีข้อมูลให้บันทึก');
  const valid = {};
  Object.keys(ATT_STATUS).forEach(function (k) { valid[k] = true; });

  // The whole day of the classroom is written in one row - the roster of the
  // classroom is stored once in Class_Rosters.
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  const roster = await currentRoster_(ctx, classroom, round, settings);
  const statusMap = {};
  let saved = 0, skipped = 0;
  records.forEach(function (r) {
    const studentId = String(r.StudentID || '').trim();
    const status = String(r.Status || '').trim().toUpperCase();
    if (!studentId) { skipped++; return; }
    if (!valid[status]) { skipped++; return; }
    statusMap[studentId] = status;
    saved++;
  });
  await writeCompactDay_(ctx, date, round, classId, statusMap, roster, session.Username);

  // The anomalies are calculated - they are not stored in a sheet any more.
  const anomalies = await computeAnomaliesForDate_(ctx, date);
  await ctx.logAudit({
    userId: session.UserID, username: session.Username, role: session.Role,
    action: 'ATTENDANCE_SAVE', entity: SHEETS.ATT_DAILY, entityId: round + ' ' + date + ' ' + classId,
    details: 'บันทึก ' + saved + ' รายการ'
  });
  await ctx.bumpDataVersion();
  return { ok: true, saved: saved, skipped: skipped, anomalies: anomalies.length, anomaliesChanged: anomalies };
}

/** Lists attendance records with filters. */
export async function listAttendance_(ctx, payload) {
  await ctx.requirePermission(payload.token, 'attendance.view');
  const round = String(payload.round || '').toUpperCase();
  const students = await readTable(ctx.d1, SHEETS.STUDENTS);
  const classes = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const sMap = {};
  students.forEach(function (s) { sMap[s.StudentID] = plain_(s); });
  const cMap = {};
  classes.forEach(function (c) { cMap[c.ClassID] = c.ClassName; });
  const date = normalizeDate_(payload.date);
  const from = normalizeDate_(payload.from);
  const to = normalizeDate_(payload.to);

  // The history is built from the compact sheet - one row per classroom,
  // round and day.
  let rows = (await compactFacts_(ctx, from, to)).filter(function (a) {
    return !round || a.AttendanceType === round;
  }).map(function (a) {
    const s = sMap[a.StudentID] || {};
    return {
      AttendanceID: attendanceId_(a.AttendanceType, a.Date, a.StudentID),
      StudentID: a.StudentID,
      AttendanceType: a.AttendanceType,
      ClassID: a.ClassID,
      ClassName: cMap[a.ClassID] || a.ClassID,
      AttendanceDate: a.Date,
      Status: a.Status,
      StatusThai: THAI_STATUS[a.Status] || a.Status,
      StatusJawi: Jawi_STATUS[a.Status] || a.Status,
      RecordedBy: a.RecordedBy,
      ThaiFirstName: s.ThaiFirstName || '',
      ThaiLastName: s.ThaiLastName || '',
      JawiFirstName: s.JawiFirstName || '',
      JawiLastName: s.JawiLastName || '',
      GradeLevel: s.GradeLevel || ''
    };
  });
  const classId = String(payload.classId || '');
  const status = String(payload.status || '');
  const grade = String(payload.grade || '');
  if (date) rows = rows.filter(function (r) { return r.AttendanceDate === date; });
  if (from) rows = rows.filter(function (r) { return r.AttendanceDate >= from; });
  if (to) rows = rows.filter(function (r) { return r.AttendanceDate <= to; });
  if (classId) rows = rows.filter(function (r) { return idEq_(r.ClassID, classId); });
  if (status) rows = rows.filter(function (r) { return r.Status === status; });
  if (grade) rows = rows.filter(function (r) { return r.GradeLevel === grade; });
  rows = sortBy_(rows, 'AttendanceDate', true);
  return { rows: rows, total: rows.length };
}

/**
 * Returns the list of attendance rounds that are currently enabled.
 * Falls back to all three rounds when the setting is missing.
 */
export function enabledRounds_(settings) {
  const raw = String((settings || {}).AttendanceRounds || '').toUpperCase();
  const all = [ROUNDS.HOMEROOM, ROUNDS.RELIGIOUS, ROUNDS.GENERAL];
  if (!raw) return all;
  const picked = all.filter(function (r) { return raw.indexOf(r) !== -1; });
  return picked.length ? picked : all;
}

/**
 * Returns the classrooms that belong to a round.
 *
 * Round 2 is checked in the religious classrooms and round 3 in the general
 * classrooms. Round 1 follows the classroom system the administrator chose
 * (religious or general). When the expected classroom type does not exist at
 * all, every classroom is used instead.
 */
export function attendanceStatusClasses_(round, classrooms, settings) {
  let type = ROUND_CLASS_TYPE[round] || 'HOMEROOM';
  if (round === ROUNDS.HOMEROOM) type = round1RoomType_(settings);
  // The general room 'ไม่เรียน' only groups the students who do not take the
  // general subject - it never takes part in the check.
  const usable = classrooms.filter(function (c) {
    return !(type === 'GENERAL' && isNoStudyClass_(c));
  });
  const typed = usable.filter(function (c) { return c.ClassType === type; });
  return typed.length ? typed : usable;
}

/**
 * Daily attendance tracking.
 *
 * Reports, for every classroom and every enabled round, whether the class has
 * already been checked in for the requested date:
 *   DONE    - every student of the class has a status
 *   PARTIAL - only part of the class has a status
 *   PENDING - nothing has been recorded yet
 *
 * The expected roster is resolved exactly like the attendance sheet does, so
 * the tracking page never disagrees with what the teacher sees when checking
 * names.
 */
export async function attendanceStatus_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'attendance.view');
  const date = normalizeDate_(payload.date) || ctx.today();
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  const rounds = enabledRounds_(settings);

  const classrooms = (await readTable(ctx.d1, SHEETS.CLASSROOMS)).map(plain_)
    .filter(function (c) { return String(c.Status || 'ACTIVE').toUpperCase() !== 'INACTIVE'; });
  const students = (await readTable(ctx.d1, SHEETS.STUDENTS)).map(plain_)
    .filter(function (s) { return String(s.StudentStatus || 'ACTIVE').toUpperCase() !== 'INACTIVE'; });

  // A teacher only sees the classrooms that are assigned to them.
  let visible = classrooms;
  if (session.Role === ROLES.TEACHER) {
    const scope = await teacherClassScope_(ctx, session);
    visible = classrooms.filter(function (c) { return scope.indexOf(String(c.ClassID).trim()) !== -1; });
  }

  // Attendance rows of the requested date, grouped by round and classroom.
  const byRound = {};
  rounds.forEach(function (round) { byRound[round] = {}; });
  // The status of the day comes from the compact sheet.
  const dayRows = await compactDayRows_(ctx, date, ['DayID', 'ClassID', 'Round', 'RosterVersion', 'Statuses', 'RecordedBy']);
  for (const row of dayRows) {
    const round = String(row.Round || '');
    if (!byRound[round]) continue;
    const key = String(row.ClassID || '').trim();
    const ids = await rosterIdsOf_(ctx, row.ClassID, row.Round, row.RosterVersion);
    const codes = String(row.Statuses || '');
    const list = byRound[round][key] || [];
    ids.forEach(function (id, i) {
      const status = compactStatus_(codes.charAt(i));
      if (!status) return;
      list.push({
        StudentID: id, ClassID: row.ClassID, Status: status,
        RecordedBy: row.RecordedBy || '', UpdatedAt: ''
      });
    });
    byRound[round][key] = list;
  }

  const result = [];
  rounds.forEach(function (round) {
    const sheetName = ROUND_SHEET[round];
    attendanceStatusClasses_(round, visible, settings).forEach(function (c) {
      const classId = String(c.ClassID || '').trim();
      const field = studentClassFieldFor_(round, c, settings);
      const roster = students.filter(function (s) { return String(s[field] || '').trim() === classId; });
      if (!roster.length) return;            // a room without students is not tracked
      const rosterIds = roster.map(function (s) { return String(s.StudentID); });
      const rows = byRound[round][classId] || [];
      const counts = { PRESENT: 0, ABSENT: 0, LATE: 0, LEAVE: 0 };
      let recorded = 0;
      let lastBy = '';
      let lastAt = '';
      rows.forEach(function (a) {
        if (rosterIds.indexOf(String(a.StudentID)) === -1) return;
        const status = String(a.Status || '').toUpperCase();
        if (!status) return;
        recorded++;
        if (counts[status] === undefined) counts[status] = 0;
        counts[status]++;
        if (!lastAt || String(a.UpdatedAt || '') > lastAt) {
          lastAt = String(a.UpdatedAt || '');
          lastBy = String(a.RecordedBy || '');
        }
      });
      let state = 'PENDING';
      if (recorded > 0 && recorded >= roster.length) state = 'DONE';
      else if (recorded > 0) state = 'PARTIAL';
      result.push({
        round: round,
        sheetName: sheetName,
        classId: classId,
        className: c.ClassName || classId,
        classType: c.ClassType || '',
        gradeLevel: c.GradeLevel || '',
        expected: roster.length,
        recorded: recorded,
        remaining: roster.length - recorded,
        state: state,
        counts: counts,
        recordedBy: lastBy,
        updatedAt: lastAt
      });
    });
  });

  // Summary per round.
  const summary = rounds.map(function (round) {
    const items = result.filter(function (r) { return r.round === round; });
    return {
      round: round,
      classes: items.length,
      done: items.filter(function (r) { return r.state === 'DONE'; }).length,
      partial: items.filter(function (r) { return r.state === 'PARTIAL'; }).length,
      pending: items.filter(function (r) { return r.state === 'PENDING'; }).length
    };
  });

  const pending = result.filter(function (r) { return r.state !== 'DONE'; });
  return {
    date: date,
    rounds: rounds,
    rows: result,
    summary: summary,
    pending: pending,
    totalClasses: result.length,
    doneClasses: result.filter(function (r) { return r.state === 'DONE'; }).length,
    pendingClasses: pending.length
  };
}

/** Deletes attendance records. */
export async function deleteAttendance_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'attendance.delete');
  const ids = payload.AttendanceIDs || (payload.AttendanceID ? [payload.AttendanceID] : []);
  if (!ids.length) throw error_('VALIDATION', 'ไม่ได้ระบุรายการที่ต้องการลบ');
  let deleted = 0;
  // The id of a record carries the day, the round and the student.
  for (const id of ids) {
    const m = /^ATT-(HOM|REL|GEN)-(\d{4})(\d{2})(\d{2})-(.+)$/.exec(String(id));
    if (!m) continue;
    const round = m[1] === 'HOM' ? ROUNDS.HOMEROOM : (m[1] === 'REL' ? ROUNDS.RELIGIOUS : ROUNDS.GENERAL);
    const date = m[2] + '-' + m[3] + '-' + m[4];
    const studentId = m[5];
    // The row of the classroom that holds the student is changed.
    const rows = await compactDayRows_(ctx, date, ['DayID', 'ClassID', 'Round', 'RosterVersion', 'Statuses', 'RecordedBy']);
    for (const row of rows) {
      if (String(row.Round) !== round) continue;
      const ids2 = await rosterIdsOf_(ctx, row.ClassID, row.Round, row.RosterVersion);
      const k = ids2.indexOf(studentId);
      if (k === -1) continue;
      const codes = String(row.Statuses || '').split('');
      if (k >= codes.length || codes[k] === '-') continue;
      codes[k] = '-';
      deleted++;
      await writeCompactRow_(ctx, date, round, row.ClassID, row.RosterVersion, codes.join(''), row.RecordedBy || '');
    }
  }
  await ctx.logAudit({
    userId: session.UserID, username: session.Username, role: session.Role,
    action: 'ATTENDANCE_DELETE', entity: 'Attendance', details: 'ลบ ' + ids.length + ' รายการ'
  });
  await ctx.bumpDataVersion();
  return { ok: true, deleted: ids.length };
}

/* ==========================================================================
 * SECTION 11: ATTENDANCE ANOMALY DETECTION
 * ========================================================================== */

/**
 * Recomputes the anomalies of a single date.
 *
 * Rules derived from the specification:
 *   1. Homeroom PRESENT + Religious ABSENT  -> โดดเรียนวิชาศาสนา
 *   2. Homeroom PRESENT + General ABSENT    -> โดดเรียนวิชาสามัญ
 *   3. A round without any record            -> รอตรวจสอบ (never "absent")
 *   4. The student was on LEAVE              -> ไม่จัดเป็นการโดดเรียน
 *
 * Additional safeguards:
 *   - An absence is only conclusive when another round proves that the
 *     student was actually at school (PRESENT or LATE).
 *   - Only classrooms of the matching type are accepted as evidence.
 *   - Manual verification results are preserved when the anomaly survives.
 */
export async function recomputeAnomalies_(ctx, date) {
  // The anomalies are calculated from the attendance - there is nothing to
  // write any more. The function is kept for the places that call it.
  return (await computeAnomaliesForDate_(ctx, date)).length;
}

/**
 * Builds a deterministic anomaly record.
 *
 * The timestamp comes from now_() - the same value the original wrote into
 * the column, therefore the signature stays identical to the original.
 */
export function buildAnomaly_(studentId, date, anomalyType, attendanceType, classId) {
  return {
    AnomalyID: 'ANO-' + date.replace(/-/g, '') + '-' + studentId + '-' + attendanceType,
    StudentID: studentId,
    AttendanceDate: date,
    AnomalyType: anomalyType,
    AttendanceType: attendanceType,
    ClassID: classId || '',
    VerificationStatus: anomalyType === ANOMALY.VERIFICATION_PENDING ? VERIFICATION.PENDING : VERIFICATION.CONFIRMED,
    DetectedAt: now_()
  };
}

/** Lists anomalies with filters and student details. */
export async function listAnomalies_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'anomaly.view');
  const students = await readTable(ctx.d1, SHEETS.STUDENTS);
  const classes = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const sMap = {};
  students.forEach(function (s) { sMap[s.StudentID] = plain_(s); });
  const cMap = {};
  classes.forEach(function (c) { cMap[c.ClassID] = c; });

  // The anomalies are calculated from the attendance and are not stored.
  const date = normalizeDate_(payload.date);
  const from = normalizeDate_(payload.from);
  const to = normalizeDate_(payload.to);
  const days = date ? [date] : dateRange_(from || daysBefore_(ctx.today(), 60), to || ctx.today());
  let computed = [];
  for (const d of days) computed = computed.concat(await computeAnomaliesForDate_(ctx, d));
  computed = mergeVerifications_(computed, await verificationRows_(ctx));

  let rows = computed.map(function (a) {
    const s = sMap[a.StudentID] || {};
    const c = cMap[a.ClassID] || null;
    return Object.assign({}, a, {
      AttendanceDate: normalizeDate_(a.AttendanceDate),
      ThaiFirstName: s.ThaiFirstName || '',
      ThaiLastName: s.ThaiLastName || '',
      JawiFirstName: s.JawiFirstName || '',
      JawiLastName: s.JawiLastName || '',
      GradeLevel: s.GradeLevel || '',
      ClassName: c ? c.ClassName : (a.ClassID || ''),
      ClassType: c ? c.ClassType : '',
      AnomalyLabel: anomalyLabel_(a.AnomalyType),
      AnomalyLabelJawi: anomalyLabelJawi_(a.AnomalyType)
    });
  });
  // Teachers only see anomalies of students inside their assigned classrooms.
  if (session.Role === ROLES.TEACHER) {
    const scope = await teacherClassScope_(ctx, session);
    rows = rows.filter(function (r) {
      const s = sMap[r.StudentID];
      if (!s) return false;
      return scope.indexOf(s.ReligiousClassID) !== -1 ||
        scope.indexOf(s.GeneralClassID) !== -1 ||
        scope.indexOf(s.HomeroomClassID) !== -1;
    });
  }

  const type = String(payload.anomalyType || '');
  const status = String(payload.verification || '');
  const grade = String(payload.grade || '');
  const classId = String(payload.classId || '');
  if (date) rows = rows.filter(function (r) { return r.AttendanceDate === date; });
  if (from) rows = rows.filter(function (r) { return r.AttendanceDate >= from; });
  if (to) rows = rows.filter(function (r) { return r.AttendanceDate <= to; });
  if (type) rows = rows.filter(function (r) { return r.AnomalyType === type; });
  if (status) rows = rows.filter(function (r) { return r.VerificationStatus === status; });
  if (grade) rows = rows.filter(function (r) { return r.GradeLevel === grade; });
  if (classId) rows = rows.filter(function (r) { return idEq_(r.ClassID, classId); });
  rows = sortBy_(rows, 'AttendanceDate', true);
  return { rows: rows, total: rows.length };
}

/** Thai label of an anomaly type. */
export function anomalyLabel_(type) {
  if (type === ANOMALY.ABSENT_RELIGIOUS) return 'โดดเรียนวิชาศาสนา';
  if (type === ANOMALY.ABSENT_GENERAL) return 'โดดเรียนวิชาสามัญ';
  return 'รอตรวจสอบ';
}

/** Jawi label of an anomaly type. */
export function anomalyLabelJawi_(type) {
  if (type === ANOMALY.ABSENT_RELIGIOUS) return 'غائب في دين';
  if (type === ANOMALY.ABSENT_GENERAL) return 'غائب';
  return 'قيد المراجعة';
}

/** Updates the verification status of an anomaly. */
export async function verifyAnomaly_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'anomaly.verify');
  const id = requireText_(payload.AnomalyID, 'รหัสความผิดปกติ');
  const status = String(payload.VerificationStatus || '').toUpperCase();
  if ([VERIFICATION.PENDING, VERIFICATION.CONFIRMED, VERIFICATION.DISMISSED].indexOf(status) === -1) {
    throw error_('VALIDATION', 'สถานะการตรวจสอบไม่ถูกต้อง');
  }
  // The anomaly is calculated - only the decision of the staff is stored.
  const date = anomalyDateOf_(id);
  if (!date) throw error_('VALIDATION', 'ไม่พบรายการความผิดปกติ');
  const computed = await computeAnomaliesForDate_(ctx, date);
  const target = computed.filter(function (a) { return idEq_(a.AnomalyID, id); })[0];
  if (!target) throw error_('VALIDATION', 'ไม่พบรายการความผิดปกติ');
  await upsertRows(ctx.d1, SHEETS.ANOMALY_VERIFICATIONS, [{
    AnomalyID: target.AnomalyID,
    StudentID: target.StudentID,
    AttendanceDate: normalizeDate_(target.AttendanceDate),
    AnomalyType: target.AnomalyType,
    AttendanceType: target.AttendanceType,
    ClassID: target.ClassID || '',
    VerificationStatus: status,
    VerifiedBy: session.Username,
    VerifiedAt: ctx.now(),
    Note: ''
  }]);
  await ctx.logAudit({
    userId: session.UserID, username: session.Username, role: session.Role,
    action: 'ANOMALY_VERIFY', entity: 'Anomaly_Verifications', entityId: id, details: status
  });
  await ctx.bumpDataVersion();
  return { ok: true };
}

/* ==========================================================================
 * SECTION 10b: ATTENDANCE / LEAVE STATISTICS - the helpers
 * ========================================================================== */

/**
 * Returns the grade group of a grade level.
 * อ. = อนุบาล, ป. = ประถมศึกษา, ม.1-ม.3 = มัธยมศึกษาต้น, ม.4-ม.6 = มัธยมศึกษาปลาย
 * The religious subject counts every secondary level together.
 */
export function gradeGroupOf_(grade, subject) {
  const g = String(grade === null || grade === undefined ? '' : grade).trim();
  if (!g) return '';
  if (/^อ\.?\s*\d*$/.test(g)) return 'อนุบาล';
  if (/^ป\.?\s*\d*$/.test(g)) return 'ประถมศึกษา';
  const m = g.match(/^ม\.?\s*(\d+)/);
  if (m) {
    if (subject === 'religious') return 'มัธยมศึกษา';
    const n = parseInt(m[1], 10);
    return n <= 3 ? 'มัธยมศึกษาต้น' : 'มัธยมศึกษาปลาย';
  }
  return 'อื่น ๆ';
}

/** Empty counter of the four attendance states. */
export function emptyCounts_() {
  return { present: 0, absent: 0, late: 0, leave: 0, recorded: 0, expected: 0, missing: 0, total: 0 };
}

/** Adds one status to a counter. */
export function addStatus_(counter, status) {
  counter.recorded++;
  if (status === 'PRESENT') counter.present++;
  else if (status === 'ABSENT') counter.absent++;
  else if (status === 'LATE') counter.late++;
  else if (status === 'LEAVE') counter.leave++;
  counter.total++;
}

/* ==========================================================================
 * SECTION 11: THE ANOMALY CALCULATION
 * ========================================================================== */

/**
 * The anomalies of one day - calculated from the attendance.
 * The result is the same as before, but nothing is written to a sheet.
 */
export async function computeAnomaliesForDate_(ctx, date) {
  const targetDate = normalizeDate_(date);
  if (!targetDate) return [];
  const classes = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const classMap = {};
  classes.forEach(function (c) { classMap[String(c.ClassID)] = c; });

  const hMap = {}, rMap = {}, gMap = {};
  const rows = await compactDayRows_(ctx, targetDate, ['DayID', 'ClassID', 'Round', 'RosterVersion', 'Statuses']);
  for (const row of rows) {
    const ids = await rosterIdsOf_(ctx, row.ClassID, row.Round, row.RosterVersion);
    const codes = String(row.Statuses || '');
    const map = {};
    ids.forEach(function (id, k) {
      const status = compactStatus_(codes.charAt(k));
      if (status) map[id] = { StudentID: id, ClassID: row.ClassID, Status: status };
    });
    const target = row.Round === ROUNDS.HOMEROOM ? hMap : (row.Round === ROUNDS.RELIGIOUS ? rMap : gMap);
    Object.keys(map).forEach(function (id) { target[id] = map[id]; });
  }

  const studentIds = {};
  Object.keys(hMap).forEach(function (id) { studentIds[id] = true; });
  Object.keys(rMap).forEach(function (id) { studentIds[id] = true; });
  Object.keys(gMap).forEach(function (id) { studentIds[id] = true; });

  function validClass(record, expectedType) {
    if (!record || !record.ClassID) return false;
    const room = classMap[String(record.ClassID)];
    return !!room && room.ClassType === expectedType;
  }
  function isAtSchool(record) {
    return !!record && (record.Status === ATT_STATUS.PRESENT || record.Status === ATT_STATUS.LATE);
  }
  function isLeave(record) {
    return !!record && record.Status === ATT_STATUS.LEAVE;
  }

  const computed = [];
  Object.keys(studentIds).forEach(function (studentId) {
    const h = hMap[studentId];
    const r = rMap[studentId];
    const g = gMap[studentId];
    const pendingRounds = [];

    if (!r) {
      pendingRounds.push(ROUNDS.RELIGIOUS);
    } else if (isLeave(r)) {
      // ลาวิชาศาสนา - ไม่ถือเป็นการโดดเรียน
    } else if (r.Status === ATT_STATUS.ABSENT) {
      const evidence = isAtSchool(h) || isAtSchool(g);
      if (evidence && validClass(r, 'RELIGIOUS')) {
        computed.push(buildAnomaly_(studentId, targetDate, ANOMALY.ABSENT_RELIGIOUS, ROUNDS.RELIGIOUS, r.ClassID));
      }
    }

    if (!g) {
      pendingRounds.push(ROUNDS.GENERAL);
    } else if (isLeave(g)) {
      // ลาวิชาสามัญ - ไม่ถือเป็นการโดดเรียน
    } else if (g.Status === ATT_STATUS.ABSENT) {
      const evidence = isAtSchool(h) || isAtSchool(r);
      if (evidence && validClass(g, 'GENERAL')) {
        computed.push(buildAnomaly_(studentId, targetDate, ANOMALY.ABSENT_GENERAL, ROUNDS.GENERAL, g.ClassID));
      }
    }

    pendingRounds.forEach(function (round) {
      if (!isAtSchool(h) && !isAtSchool(r) && !isAtSchool(g)) return;
      computed.push(buildAnomaly_(studentId, targetDate, ANOMALY.VERIFICATION_PENDING, round, ''));
    });
  });
  return computed;
}

/** The manual decisions of the staff (the anomalies are not stored any more). */
export async function verificationRows_(ctx) {
  return readTable(ctx.d1, SHEETS.ANOMALY_VERIFICATIONS);
}

/** Merges the manual decisions into the calculated anomalies. */
export function mergeVerifications_(anomalies, verifications) {
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

/** The date of an anomaly id (ANO-20261122-S0001-RELIGIOUS). */
export function anomalyDateOf_(anomalyId) {
  const m = /^ANO-(\d{4})(\d{2})(\d{2})-/.exec(String(anomalyId || ''));
  if (!m) return '';
  return m[1] + '-' + m[2] + '-' + m[3];
}
