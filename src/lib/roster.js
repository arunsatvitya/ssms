/**
 * ============================================================================
 *  SSMS on Cloudflare - Rosters and the compact attendance helpers
 * ============================================================================
 *
 *  Ported 1:1 from v3-compact/Code.gs (SECTION 10 helpers + SECTION 17 of the
 *  compact attendance storage).
 *
 *  THE COMPACT SCHEME (v3)
 *  -----------------------
 *  Instead of one sheet row per student the attendance is stored as one row
 *  per day / round / classroom:
 *
 *    attendance_daily
 *      DayID          = 'D-' + date + '-' + round + '-' + classId
 *      AttendanceDate = yyyy-MM-dd
 *      ClassID, Round, RosterVersion
 *      Statuses       = one letter per student, in the order of the roster
 *                       P=PRESENT A=ABSENT L=LATE V=LEAVE '-' = not checked yet
 *      RecordedBy
 *
 *    class_rosters
 *      RosterID, ClassID, Round, Version, StudentIDs (comma separated), CreatedAt
 *
 *  Because the row is addressed by its DayID, the "search the row number in
 *  the sheet" mechanism of the spreadsheet (the __row column) is not needed -
 *  the write is an UPSERT on day_id.
 * ============================================================================
 */

import { SHEETS, HEADERS, TABLES, ROUNDS, ATT_STATUS, COMPACT_CODE_ } from './constants.js';
import { readTable, readRowsByDate, readRowsByDateRange, upsertRows } from './db.js';
import { normalizeDate_, idEq_, error_ } from './util.js';

/* ==========================================================================
 * Local helpers
 * ========================================================================== */

/** Creates a structured error object - identical to error_() of Code.gs. */

/**
 * Compares two identifiers as trimmed text.
 * A numeric classroom id is stored as text, so a strict comparison would fail.
 */

/** Normalises a date string to yyyy-MM-dd. */

/**
 * Maps the rows of a direct D1 query onto the header names of the sheet.
 * The D1 columns are snake_case, the business logic uses the original header
 * names - exactly like readTable() of db.js does it.
 */
function mapD1Rows_(sheetName, results) {
  const headers = HEADERS[sheetName] || [];
  const meta = TABLES[sheetName];
  const out = [];
  (results || []).forEach(function (r) {
    const obj = {};
    headers.forEach(function (h, i) {
      const v = r[meta.columns[i]];
      obj[h] = (v === null || v === undefined) ? '' : String(v);
    });
    out.push(obj);
  });
  return out;
}

/**
 * Memo of the roster lists.
 * The original kept the memo in a global variable - in the Workers runtime a
 * global would survive between requests, therefore the memo lives in a
 * WeakMap that is bound to the request context.
 */
const ROSTER_MEMO_ = new WeakMap();

function memoOf_(ctx) {
  let m = null;
  if (ctx && typeof ctx === 'object') m = ROSTER_MEMO_.get(ctx);
  if (!m) {
    m = {};
    if (ctx && typeof ctx === 'object') ROSTER_MEMO_.set(ctx, m);
  }
  return m;
}

/** Forgets the roster lists of the request - called after every write. */
export function resetRosterMemo_(ctx) {
  if (ctx && typeof ctx === 'object') ROSTER_MEMO_.delete(ctx);
}

/* ==========================================================================
 * SECTION 10: ATTENDANCE MANAGEMENT - the helpers of the compact scheme
 * ========================================================================== */

/**
 * Returns the classroom system that round 1 follows.
 *
 * The school runs two independent systems: the religious classrooms and the
 * general classrooms. Round 1 ("check names in the row") can follow either of
 * them - the administrator decides in the settings.
 */
export function round1RoomType_(settings) {
  const v = String((settings || {}).Round1RoomType || 'RELIGIOUS').trim().toUpperCase();
  return v === 'GENERAL' ? 'GENERAL' : 'RELIGIOUS';
}

/**
 * True for the general classroom that means 'no general subject'.
 *
 * The school registers the students who study the religious subject alone in
 * a general room called 'ไม่เรียน' whose grade level is 'ไม่มี'. That room is
 * only a place holder - it never appears in the check list and never in the
 * statistics of the general subject.
 */
export function isNoStudyClass_(room) {
  if (!room) return false;
  const type = String(room.ClassType || '').trim().toUpperCase();
  if (type !== 'GENERAL') return false;
  const name = String(room.ClassName || '').trim();
  const grade = String(room.GradeLevel || '').trim();
  return name === 'ไม่เรียน' || grade === 'ไม่มี';
}

/**
 * Returns true when the grade level belongs to the secondary level
 * (middleschool). The levels can be listed in the settings; without a list the
 * levels that start with "ม." are treated as secondary.
 */
export function isSecondaryGrade_(grade, settings) {
  const g = String(grade === null || grade === undefined ? '' : grade).trim();
  if (!g) return false;
  const list = String((settings || {}).SecondaryGradeLevels || '').split(',')
    .map(function (s) { return s.trim(); }).filter(Boolean);
  if (list.length) return list.indexOf(g) !== -1;
  if (/มัธยม/.test(g)) return true;
  return /^ม\s*\.?\s*\d/.test(g);
}

/** Grade levels of the religious classrooms (falls back to the normal list). */
export function religiousGradeLevels_(settings) {
  const religious = String((settings || {}).ReligiousGradeLevels || '').split(',')
    .map(function (s) { return s.trim(); }).filter(Boolean);
  if (religious.length) return religious;
  return String((settings || {}).GradeLevels || '').split(',')
    .map(function (s) { return s.trim(); }).filter(Boolean);
}

/** Returns the Students sheet column that holds a classroom reference. */
export function studentClassFieldFor_(round, classroom, settings) {
  if (round === ROUNDS.RELIGIOUS) return 'ReligiousClassID';
  if (round === ROUNDS.GENERAL) return 'GeneralClassID';
  // Round 1 follows the classroom system the administrator chose.
  const type = round1RoomType_(settings);
  if (classroom && classroom.ClassType === type) {
    return type === 'GENERAL' ? 'GeneralClassID' : 'ReligiousClassID';
  }
  return 'HomeroomClassID';
}

/* ==========================================================================
 * SECTION 17: THE COMPACT ATTENDANCE STORAGE
 * ========================================================================== */

/** The key of one row of the compact attendance sheet. */
export function dayKey_(date, round, classId) {
  return 'D-' + date + '-' + round + '-' + classId;
}

/** Turns a status into its letter. */
export function compactCode_(status) {
  return COMPACT_CODE_[String(status || '').trim().toUpperCase()] || '-';
}

/** Turns a letter back into the status (empty when the student is not checked). */
export function compactStatus_(code) {
  const c = String(code || '').trim().toUpperCase();
  if (c === 'P') return ATT_STATUS.PRESENT;
  if (c === 'A') return ATT_STATUS.ABSENT;
  if (c === 'L') return ATT_STATUS.LATE;
  if (c === 'V') return ATT_STATUS.LEAVE;
  return '';
}

/**
 * The students of a classroom in one round (sorted by their id).
 * The order is stable, therefore the letters of the status always belong to
 * the same student.
 */
export async function classStudentIds_(ctx, classroom, round, settings) {
  const field = studentClassFieldFor_(round, classroom, settings);
  const students = await readTable(ctx.d1, SHEETS.STUDENTS);
  const ids = [];
  for (let i = 0; i < students.length; i++) {
    const s = students[i];
    if (idEq_(s[field], classroom.ClassID)) ids.push(String(s.StudentID));
  }
  ids.sort(function (a, b) { return a.localeCompare(b, 'th', { numeric: true }); });
  return ids;
}

/**
 * The roster rows of a classroom in one round.
 * The table has the index idx_rosters_class (class_id, round), so the rows
 * are read with one indexed query instead of the whole table.
 */
export async function rosterRows_(ctx, classId, round) {
  const meta = TABLES[SHEETS.CLASS_ROSTERS];
  const sql = `SELECT ${meta.columns.join(', ')} FROM ${meta.table} WHERE class_id = ? AND round = ?`;
  const res = await ctx.d1.prepare(sql).bind(String(classId), String(round)).all();
  return mapD1Rows_(SHEETS.CLASS_ROSTERS, res.results || []);
}

/** The students of one roster version. */
export async function rosterIdsOf_(ctx, classId, round, version) {
  const key = String(classId) + '|' + String(round) + '|' + String(version);
  const memo = memoOf_(ctx);
  if (memo[key]) return memo[key];
  const rows = await rosterRows_(ctx, classId, round);
  let ids = [];
  rows.forEach(function (r) {
    if (String(r.Version) === String(version)) {
      ids = String(r.StudentIDs || '').split(',').filter(Boolean);
    }
  });
  memo[key] = ids;
  return ids;
}

/**
 * The roster of a classroom - the newest version.
 * A new version is written when the students of the classroom have changed.
 */
export async function currentRoster_(ctx, classroom, round, settings) {
  const ids = await classStudentIds_(ctx, classroom, round, settings);
  const rows = await rosterRows_(ctx, classroom.ClassID, round);
  let latest = null;
  rows.forEach(function (r) {
    if (!latest || Number(r.Version) > Number(latest.Version)) latest = r;
  });
  const wanted = ids.join(',');
  if (latest && String(latest.StudentIDs || '') === wanted) {
    return { version: Number(latest.Version), ids: ids };
  }
  const version = latest ? Number(latest.Version) + 1 : 1;
  await upsertRows(ctx.d1, SHEETS.CLASS_ROSTERS, [{
    RosterID: 'ROS-' + classroom.ClassID + '-' + round + '-' + version,
    ClassID: classroom.ClassID,
    Round: round,
    Version: String(version),
    StudentIDs: wanted,
    CreatedAt: ctx.now()
  }]);
  resetRosterMemo_(ctx);
  return { version: version, ids: ids };
}

/** The rows of the compact attendance sheet of one day. */
export async function compactDayRows_(ctx, date, cols) {
  return compactRowsOfDate_(ctx, date, cols || null);
}

/**
 * The rows of one day.
 * The spreadsheet read the tail of the sheet - the database reads the rows of
 * the date directly through the index of the date column.
 */
export async function compactRowsOfDate_(ctx, date, cols) {
  const target = normalizeDate_(date);
  if (!target) return readTable(ctx.d1, SHEETS.ATT_DAILY, cols);
  return readRowsByDate(ctx.d1, SHEETS.ATT_DAILY, 'AttendanceDate', target, cols);
}

/**
 * The rows of a period - the date column is read once and afterwards the
 * whole period is read with one call.
 */
export async function compactRowsInPeriod_(ctx, from, to, cols) {
  const f = normalizeDate_(from);
  const t = normalizeDate_(to);
  if (!f || !t) return readTable(ctx.d1, SHEETS.ATT_DAILY, cols);
  return readRowsByDateRange(ctx.d1, SHEETS.ATT_DAILY, 'AttendanceDate', f, t, cols);
}

/**
 * The status of every student of one classroom, round and day.
 * @return {Object} { statuses: studentId -> status, recordedBy: string }
 */
export async function compactStatusMap_(ctx, date, round, classId) {
  const rows = await compactDayRows_(ctx, date, ['DayID', 'ClassID', 'Round', 'RosterVersion', 'Statuses', 'RecordedBy']);
  const out = { statuses: {}, recordedBy: '' };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (String(row.Round) !== String(round)) continue;
    if (!idEq_(row.ClassID, classId)) continue;
    const ids = await rosterIdsOf_(ctx, row.ClassID, row.Round, row.RosterVersion);
    const codes = String(row.Statuses || '');
    ids.forEach(function (id, k) {
      const status = compactStatus_(codes.charAt(k));
      if (status) out.statuses[id] = status;
    });
    if (!out.recordedBy) out.recordedBy = row.RecordedBy || '';
  }
  return out;
}

/**
 * Writes one row of the compact attendance sheet.
 * The row is addressed by its DayID - the write is an UPSERT, therefore the
 * row does not have to be searched in the sheet first.
 */
export async function writeCompactRow_(ctx, date, round, classId, version, codes, username) {
  const meta = TABLES[SHEETS.ATT_DAILY];
  // The table of the compact attendance always exists - the original threw
  // here when the sheet was missing.
  if (!meta) throw error_('SERVER_ERROR', 'ไม่พบชีตข้อมูลการเข้าเรียน');
  const cols = meta.columns;
  const sql = `INSERT INTO ${meta.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
    `ON CONFLICT(${meta.key}) DO UPDATE SET ${cols.filter((c) => c !== meta.key).map((c) => `${c} = excluded.${c}`).join(', ')}`;
  const values = {
    day_id: dayKey_(date, round, classId),
    attendance_date: String(date === undefined || date === null ? '' : date),
    class_id: String(classId === undefined || classId === null ? '' : classId),
    round: String(round === undefined || round === null ? '' : round),
    roster_version: String(version === undefined || version === null ? '' : version),
    statuses: String(codes === undefined || codes === null ? '' : codes),
    recorded_by: String(username || '')
  };
  await ctx.d1.prepare(sql).bind(...cols.map((c) => values[c])).run();
  resetRosterMemo_(ctx);
}

/**
 * Writes the status of one classroom, round and day.
 * The roster of the day is kept, only the letters of the students change.
 */
export async function writeCompactDay_(ctx, date, round, classId, statusMap, roster, username) {
  const key = dayKey_(date, round, classId);
  // The row of the day is addressed by its DayID.
  const rows = await compactDayRows_(ctx, date, ['DayID', 'RosterVersion', 'Statuses']);
  let current = null;
  rows.forEach(function (r) {
    if (String(r.DayID) === key) current = r;
  });
  // The status of the students that are not in the roster any more is kept
  // as long as the student is still part of the class.
  const ids = roster.ids;
  const version = roster.version;
  const map = {};
  if (current) {
    const oldIds = await rosterIdsOf_(ctx, classId, round, current.RosterVersion);
    const oldCodes = String(current.Statuses || '');
    oldIds.forEach(function (id, k) {
      const status = compactStatus_(oldCodes.charAt(k));
      if (status) map[id] = status;
    });
  }
  Object.keys(statusMap || {}).forEach(function (id) {
    if (statusMap[id]) map[id] = statusMap[id];
  });
  const codes = ids.map(function (id) { return compactCode_(map[id]); }).join('');
  await writeCompactRow_(ctx, date, round, classId, version, codes, username);
}

/**
 * The attendance facts of a period - the same shape as before, but built from
 * the compact rows.
 */
export async function compactFacts_(ctx, from, to) {
  const students = await readTable(ctx.d1, SHEETS.STUDENTS);
  const sMap = {};
  students.forEach(function (s) { sMap[String(s.StudentID)] = s; });
  const classes = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const cMap = {};
  classes.forEach(function (c) { cMap[String(c.ClassID)] = c; });
  const cols = ['DayID', 'AttendanceDate', 'ClassID', 'Round', 'RosterVersion', 'Statuses', 'RecordedBy'];
  const rows = (from && to)
    ? await compactRowsInPeriod_(ctx, from, to, cols)
    : await readTable(ctx.d1, SHEETS.ATT_DAILY, cols);
  const facts = [];
  for (const row of rows) {
    const ids = await rosterIdsOf_(ctx, row.ClassID, row.Round, row.RosterVersion);
    if (!ids.length) continue;
    const room = cMap[String(row.ClassID)] || null;
    const codes = String(row.Statuses || '');
    ids.forEach(function (id, k) {
      const status = compactStatus_(codes.charAt(k));
      if (!status) return;
      const s = sMap[id] || {};
      facts.push({
        StudentID: id,
        AttendanceType: row.Round,
        ClassID: row.ClassID,
        ClassName: room ? room.ClassName : row.ClassID,
        ClassType: room ? room.ClassType : '',
        Date: normalizeDate_(row.AttendanceDate),
        Status: status,
        GradeLevel: s.GradeLevel || '',
        RecordedBy: row.RecordedBy || ''
      });
    });
  }
  return facts;
}
