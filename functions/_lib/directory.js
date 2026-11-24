/**
 * ============================================================================
 *  SSMS on Cloudflare - Directory (students, teachers, classrooms, subjects)
 * ============================================================================
 *
 *  Ported 1:1 from v3-compact/Code.gs (SECTION 7, 8 and 9).
 *
 *  The Google Sheet is replaced by D1:
 *    readTableBySheet_(ss.getSheetByName(X))  ->  await readTable(ctx.d1, X)
 *    upsertRows_(ss, X, records)               ->  await upsertRows(ctx.d1, X, records)
 *    deleteRowsByKey_(ss, X, key, keys)        ->  await deleteRowsByKey(ctx.d1, X, key, keys)
 *    readSettingsMap_(ss)                      ->  await readKeyValue(ctx.d1, SHEETS.SETTINGS)
 *    now_() / today_()                         ->  ctx.now() / ctx.today()
 *    requirePermission_(token, perm)           ->  await ctx.requirePermission(token, perm)
 *    logAudit_({...})                          ->  await ctx.logAudit({...})
 *    bumpDataVersion_(ss)                      ->  await ctx.bumpDataVersion()
 *
 *  Every Thai message, every field name and every order is identical to the
 *  original so that the browser does not have to change.
 * ============================================================================
 */

import { SHEETS, ROLES, CLASS_TYPES } from './constants.js';
import { readTable, readKeyValue, upsertRows, deleteRowsByKey } from './db.js';
import {
  hashPassword_, generateSalt_, idEq_, sortBy_, requireText_,
  validatePassword_, nextId_, error_
} from './util.js';

/* ==========================================================================
 * Local helpers (the original utility functions of Code.gs, SECTION 19/20)
 * ========================================================================== */

/** Creates a structured error object - identical to error_() of Code.gs. */

/**
 * Compares two identifiers as trimmed text.
 * A school may use a purely numeric student id - the database then stores it
 * as text, so a strict comparison would fail.
 */

/** Sorts an array of objects by a key (string compare, null safe). */

/** Validates a required string field. */

/** Validates a password policy. */

/** Random salt - the same shape as generateSalt_() of Code.gs. */

/** Generates a sequential-ish identifier with a prefix. */

/* ==========================================================================
 * SECTION 7: STUDENT MANAGEMENT
 * ========================================================================== */

/** Maps an incoming student payload onto the Students sheet columns. */
export function mapStudent_(ctx, src, existing) {
  const rec = existing || {};
  return {
    StudentID: String(src.StudentID || rec.StudentID || '').trim(),
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
    NationalID: String(src.NationalID || rec.NationalID || '').trim(),
    BirthDate: String(src.BirthDate || rec.BirthDate || '').trim(),
    CreatedAt: rec.CreatedAt || ctx.now(),
    UpdatedAt: ctx.now()
  };
}

/**
 * Normalises a student status value.
 * The สช. export writes the status in Thai ("กำลังศึกษาอยู่"), the system
 * stores the English code.
 */
export function normalizeStudentStatus_(value) {
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

/** Lists students with filters. */
export async function listStudents_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'student.view');
  const classes = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  let rows = await readTable(ctx.d1, SHEETS.STUDENTS);
  rows = await applyStudentScope_(ctx, rows, session);

  const q = String(payload.q || '').trim().toLowerCase();
  const grade = String(payload.grade || '');
  const religious = String(payload.religiousClass || '');
  const general = String(payload.generalClass || '');
  const homeroom = String(payload.homeroomClass || '');
  const status = String(payload.status || '');
  const academicYear = String(payload.academicYear || '');

  if (q) {
    rows = rows.filter(function (r) {
      return [r.StudentID, r.ThaiFirstName, r.ThaiLastName, r.JawiFirstName, r.JawiLastName]
        .join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }
  if (grade) rows = rows.filter(function (r) { return r.GradeLevel === grade; });
  if (religious) rows = rows.filter(function (r) { return idEq_(r.ReligiousClassID, religious); });
  if (general) rows = rows.filter(function (r) { return idEq_(r.GeneralClassID, general); });
  if (homeroom) rows = rows.filter(function (r) { return idEq_(r.HomeroomClassID, homeroom); });
  if (status) rows = rows.filter(function (r) { return r.StudentStatus === status; });
  if (academicYear) rows = rows.filter(function (r) { return r.AcademicYear === academicYear; });

  rows = sortBy_(rows, 'StudentID');
  const enriched = rows.map(function (r) {
    return Object.assign({}, r, {
      ReligiousClassName: classNameOf_(classes, r.ReligiousClassID),
      GeneralClassName: classNameOf_(classes, r.GeneralClassID),
      HomeroomClassName: classNameOf_(classes, r.HomeroomClassID),
      FullNameThai: (r.ThaiFirstName || '') + ' ' + (r.ThaiLastName || ''),
      FullNameJawi: (r.JawiFirstName || '') + ' ' + (r.JawiLastName || '')
    });
  });
  return { rows: enriched, total: enriched.length };
}

/**
 * Teacher scope: a teacher may only record attendance for classrooms that are
 * assigned to them through Settings ("ClassTeacher.<ClassID>").
 * The value may hold the teacher username or the teacher id.
 */
export async function teacherClassScope_(ctx, session) {
  const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
  // Resolve the teacher record to also match by TeacherID.
  const teachers = await readTable(ctx.d1, SHEETS.TEACHERS);
  const teacher = teachers.filter(function (t) {
    return String(t.Username || '').toLowerCase() === String(session.Username || '').toLowerCase();
  })[0];
  const identifiers = [String(session.Username || '')];
  if (teacher) identifiers.push(String(teacher.TeacherID || ''));

  const scope = [];
  // The username is stored in lower case by the login, while the assignment
  // is typed by an administrator - the comparison ignores the case.
  const ids = identifiers.map(function (v) { return String(v).toLowerCase(); });
  Object.keys(settings).forEach(function (k) {
    if (k.indexOf('ClassTeacher.') !== 0) return;
    const value = String(settings[k] || '').trim().toLowerCase();
    if (!value) return;
    if (ids.indexOf(value) !== -1) scope.push(k.substring('ClassTeacher.'.length));
  });
  return scope;
}

/**
 * Restricts the student list to the classrooms a teacher is assigned to.
 * @param {boolean} skipScope - true when the classroom was chosen explicitly
 *        (the attendance sheet then shows the full roster of that classroom).
 */
export async function applyStudentScope_(ctx, rows, session, skipScope) {
  if (skipScope) return rows;
  if (session.Role !== ROLES.TEACHER) return rows;
  const scope = await teacherClassScope_(ctx, session);
  if (!scope.length) return [];
  return rows.filter(function (r) {
    return scope.indexOf(r.ReligiousClassID) !== -1 ||
      scope.indexOf(r.GeneralClassID) !== -1 ||
      scope.indexOf(r.HomeroomClassID) !== -1;
  });
}

/** Returns a single student with full details. */
export async function getStudent_(ctx, payload) {
  await ctx.requirePermission(payload.token, 'student.view');
  const id = requireText_(payload.StudentID, 'รหัสนักเรียน');
  const classes = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const students = await readTable(ctx.d1, SHEETS.STUDENTS);
  const s = students.filter(function (r) { return idEq_(r.StudentID, id); })[0];
  if (!s) throw error_('VALIDATION', 'ไม่พบข้อมูลนักเรียนรหัส ' + id);
  const attendance = [];
  // The round is the name of the sheet - the table does not store it.
  const rounds = [
    [SHEETS.ATT_HOMEROOM, 'HOMEROOM'],
    [SHEETS.ATT_RELIGIOUS, 'RELIGIOUS'],
    [SHEETS.ATT_GENERAL, 'GENERAL']
  ];
  for (const entry of rounds) {
    const sheetName = entry[0];
    const round = entry[1];
    const rows = await readTable(ctx.d1, sheetName);
    rows.forEach(function (a) {
      if (idEq_(a.StudentID, id)) {
        attendance.push({
          AttendanceID: a.AttendanceID, AttendanceType: a.AttendanceType || round, ClassID: a.ClassID,
          AttendanceDate: a.AttendanceDate, Status: a.Status, RecordedBy: a.RecordedBy
        });
      }
    });
  }
  return {
    student: Object.assign({}, s, {
      ReligiousClassName: classNameOf_(classes, s.ReligiousClassID),
      GeneralClassName: classNameOf_(classes, s.GeneralClassID),
      HomeroomClassName: classNameOf_(classes, s.HomeroomClassID)
    }),
    attendance: sortBy_(attendance, 'AttendanceDate', true)
  };
}

/** Creates or updates a student. */
export async function saveStudent_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'student.manage');
  const src = payload.student || {};
  const students = await readTable(ctx.d1, SHEETS.STUDENTS);
  const existing = students.filter(function (s) { return idEq_(s.StudentID, src.StudentID); })[0];

  if (!existing) {
    requireText_(src.StudentID, 'รหัสนักเรียน', 30);
    requireText_(src.ThaiFirstName, 'ชื่อ (ภาษาไทย)', 60);
    requireText_(src.ThaiLastName, 'นามสกุล (ภาษาไทย)', 60);
    requireText_(src.GradeLevel, 'ระดับชั้น', 20);
  }
  const rec = mapStudent_(ctx, src, existing);
  rec.StudentID = requireText_(rec.StudentID, 'รหัสนักเรียน', 30);
  if (!existing) {
    rec.ThaiFirstName = requireText_(rec.ThaiFirstName, 'ชื่อ (ภาษาไทย)', 60);
    rec.ThaiLastName = requireText_(rec.ThaiLastName, 'นามสกุล (ภาษาไทย)', 60);
    rec.GradeLevel = requireText_(rec.GradeLevel, 'ระดับชั้น', 20);
    const dup = students.filter(function (s) { return idEq_(s.StudentID, rec.StudentID); })[0];
    if (dup) throw error_('VALIDATION', 'รหัสนักเรียน ' + rec.StudentID + ' มีอยู่แล้วในระบบ');
  }
  // Validate classroom references and their types.
  await assertClassType_(ctx, rec.ReligiousClassID, 'RELIGIOUS');
  await assertClassType_(ctx, rec.GeneralClassID, 'GENERAL');
  await assertClassType_(ctx, rec.HomeroomClassID, 'HOMEROOM');
  // The religious and the general classrooms are two independent systems, so
  // they do not influence each other.
  if (!rec.AcademicYear) {
    const settings = await readKeyValue(ctx.d1, SHEETS.SETTINGS);
    rec.AcademicYear = settings.AcademicYear || '';
  }
  await upsertRows(ctx.d1, SHEETS.STUDENTS, [rec]);
  await ctx.logAudit({
    userId: session.UserID, username: session.Username, role: session.Role,
    action: existing ? 'UPDATE' : 'CREATE', entity: 'Students', entityId: rec.StudentID,
    details: rec.ThaiFirstName + ' ' + rec.ThaiLastName
  });
  await ctx.bumpDataVersion();
  return { ok: true, StudentID: rec.StudentID };
}

/** Deletes a student (blocked when attendance history exists). */
export async function deleteStudent_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'student.manage');
  const id = requireText_(payload.StudentID, 'รหัสนักเรียน');
  const students = await readTable(ctx.d1, SHEETS.STUDENTS);
  const target = students.filter(function (s) { return idEq_(s.StudentID, id); })[0];
  if (!target) throw error_('VALIDATION', 'ไม่พบนักเรียนรหัส ' + id);
  const attSheets = [SHEETS.ATT_HOMEROOM, SHEETS.ATT_RELIGIOUS, SHEETS.ATT_GENERAL];
  let hasAttendance = false;
  for (const sheetName of attSheets) {
    const rows = await readTable(ctx.d1, sheetName);
    if (rows.some(function (a) { return idEq_(a.StudentID, id); })) { hasAttendance = true; break; }
  }
  if (hasAttendance) {
    throw error_('VALIDATION', 'ไม่สามารถลบนักเรียนที่มีประวัติการเช็คชื่อได้ กรุณาตั้งสถานะเป็น "ไม่ศึกษาต่อ" แทน');
  }
  await deleteRowsByKey(ctx.d1, SHEETS.STUDENTS, 'StudentID', [id]);
  // The anomalies of the student belong to the student - they go away with it.
  await deleteRowsByKey(ctx.d1, SHEETS.ATT_ANOMALIES, 'StudentID', [id]);
  await ctx.logAudit({
    userId: session.UserID, username: session.Username, role: session.Role,
    action: 'DELETE', entity: 'Students', entityId: id, details: id
  });
  await ctx.bumpDataVersion();
  return { ok: true };
}

/** Exports students (server side filtering, client renders the workbook). */
export async function exportStudents_(ctx, payload) {
  await ctx.requirePermission(payload.token, 'student.export');
  const list = await listStudents_(ctx, payload);
  const headers = ['StudentID', 'ThaiFirstName', 'ThaiLastName', 'JawiFirstName', 'JawiLastName',
    'GradeLevel', 'ReligiousClassID', 'ReligiousClassName', 'GeneralClassID', 'GeneralClassName',
    'HomeroomClassID', 'HomeroomClassName', 'StudentStatus', 'AcademicYear', 'NationalID', 'BirthDate'];
  const rows = list.rows.map(function (r) { return headers.map(function (h) { return r[h] === undefined ? '' : r[h]; }); });
  return { headers: headers, rows: rows, filename: 'students_' + ctx.today() };
}

/* ==========================================================================
 * SECTION 8: TEACHER MANAGEMENT
 * ========================================================================== */

/**
 * Creates or updates the login account of a staff member.
 *
 * Staff and user accounts are one and the same: a staff record with a user
 * name can sign in to the system, and the role decides what the person may
 * do. The account is created when it does not exist yet and updated
 * afterwards - the password is only changed when a new one is given.
 *
 * @return {Object} { created:boolean, updated:boolean, userId:string }
 */
export async function syncTeacherAccount_(ctx, teacher, password) {
  const username = String(teacher.Username || '').trim().toLowerCase();
  if (!username) return { created: false, updated: false, userId: '' };

  const users = await readTable(ctx.d1, SHEETS.USERS);
  const user = users.filter(function (u) {
    return String(u.Username || '').trim().toLowerCase() === username;
  })[0];

  const role = ROLES[teacher.Role] ? teacher.Role : ROLES.TEACHER;
  const fullName = ((teacher.FirstName || '') + ' ' + (teacher.LastName || '')).trim();
  const status = String(teacher.EmploymentStatus || 'ACTIVE').toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';

  if (!user) {
    const pwd = String(password || '');
    if (!pwd) throw error_('VALIDATION', 'ต้องกำหนดรหัสผ่านสำหรับบัญชีใหม่ของ ' + fullName);
    const v = validatePassword_(pwd);
    if (!v.ok) throw error_('VALIDATION', v.message);
    const salt = generateSalt_();
    const userId = nextId_('USR', users.map(function (u) { return u.UserID; }));
    await upsertRows(ctx.d1, SHEETS.USERS, [{
      UserID: userId, Username: username, PasswordHash: await hashPassword_(pwd, salt), Salt: salt,
      FullName: fullName, Role: role, Email: '', Phone: '',
      Status: status, LastLoginAt: '', CreatedAt: ctx.now(), UpdatedAt: ctx.now()
    }]);
    return { created: true, updated: false, userId: userId };
  }

  const record = {
    UserID: user.UserID, Username: username, PasswordHash: user.PasswordHash, Salt: user.Salt,
    FullName: fullName, Role: role, Email: user.Email || '', Phone: user.Phone || '',
    Status: status, LastLoginAt: user.LastLoginAt, CreatedAt: user.CreatedAt, UpdatedAt: ctx.now()
  };
  if (password) {
    const v = validatePassword_(String(password));
    if (!v.ok) throw error_('VALIDATION', v.message);
    record.Salt = generateSalt_();
    record.PasswordHash = await hashPassword_(String(password), record.Salt);
  }
  await upsertRows(ctx.d1, SHEETS.USERS, [record]);
  return { created: false, updated: true, userId: String(user.UserID) };
}

/** Lists teachers / staff. */
export async function listTeachers_(ctx, payload) {
  await ctx.requirePermission(payload.token, 'teacher.view');
  let rows = await readTable(ctx.d1, SHEETS.TEACHERS);
  const q = String(payload.q || '').toLowerCase();
  const position = String(payload.position || '');
  const department = String(payload.department || '');
  const status = String(payload.status || '');
  if (q) {
    rows = rows.filter(function (r) {
      return [r.TeacherID, r.FirstName, r.LastName, r.Username].join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }
  if (position) rows = rows.filter(function (r) { return r.Position === position; });
  if (department) rows = rows.filter(function (r) { return r.Department === department; });
  if (status) rows = rows.filter(function (r) { return r.EmploymentStatus === status; });
  rows = sortBy_(rows, 'TeacherID');
  // The login account of every staff member (staff and accounts are the same).
  const accounts = {};
  const users = await readTable(ctx.d1, SHEETS.USERS);
  users.forEach(function (u) {
    accounts[String(u.Username || '').trim().toLowerCase()] = u;
  });
  rows = rows.map(function (r) {
    const acc = accounts[String(r.Username || '').trim().toLowerCase()];
    return Object.assign({}, r, {
      HasAccount: !!acc,
      AccountStatus: acc ? String(acc.Status || 'ACTIVE') : '',
      AccountRole: acc ? String(acc.Role || '') : ''
    });
  });
  return { rows: rows, total: rows.length };
}

/** Creates or updates a teacher. */
export async function saveTeacher_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'teacher.manage');
  const src = payload.teacher || {};
  const teachers = await readTable(ctx.d1, SHEETS.TEACHERS);
  const id = String(src.TeacherID || '').trim();
  const existing = id ? teachers.filter(function (t) { return idEq_(t.TeacherID, id); })[0] : null;
  if (!existing) {
    requireText_(src.TeacherID, 'รหัสครู', 30);
    requireText_(src.FirstName, 'ชื่อ', 60);
    requireText_(src.LastName, 'นามสกุล', 60);
    const dup = teachers.filter(function (t) { return idEq_(t.TeacherID, src.TeacherID); })[0];
    if (dup) throw error_('VALIDATION', 'รหัสครูนี้มีอยู่แล้วในระบบ');
  }
  const rec = {
    TeacherID: String(src.TeacherID || '').trim(),
    FirstName: String(src.FirstName || '').trim(),
    LastName: String(src.LastName || '').trim(),
    Position: String(src.Position || '').trim(),
    Department: String(src.Department || '').trim(),
    EmploymentStatus: String(src.EmploymentStatus || 'ACTIVE').trim().toUpperCase(),
    Username: String(src.Username || '').trim().toLowerCase(),
    Role: String(src.Role || ROLES.TEACHER).trim().toUpperCase(),
    AcademicYear: String(src.AcademicYear || '').trim(),
    CreatedAt: existing ? existing.CreatedAt : ctx.now(),
    UpdatedAt: ctx.now()
  };
  if (!existing) {
    rec.TeacherID = requireText_(rec.TeacherID, 'รหัสครู', 30);
    rec.FirstName = requireText_(rec.FirstName, 'ชื่อ', 60);
    rec.LastName = requireText_(rec.LastName, 'นามสกุล', 60);
  }
  await upsertRows(ctx.d1, SHEETS.TEACHERS, [rec]);
  // Staff and login accounts are the same - the account is created or updated
  // together with the staff record.
  const account = await syncTeacherAccount_(ctx, rec, src.Password);
  await ctx.logAudit({
    userId: session.UserID, username: session.Username, role: session.Role,
    action: existing ? 'UPDATE' : 'CREATE', entity: 'Teachers', entityId: rec.TeacherID,
    details: rec.FirstName + ' ' + rec.LastName +
      (account.created ? ' (สร้างบัญชีผู้ใช้)' : (account.updated ? ' (อัปเดตบัญชีผู้ใช้)' : ''))
  });
  await ctx.bumpDataVersion();
  return {
    ok: true, TeacherID: rec.TeacherID,
    accountCreated: account.created, accountUpdated: account.updated, UserID: account.userId
  };
}

/** Deletes a teacher (blocked when leave history exists). */
export async function deleteTeacher_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'teacher.manage');
  const id = requireText_(payload.TeacherID, 'รหัสครู');
  const teachers = await readTable(ctx.d1, SHEETS.TEACHERS);
  const target = teachers.filter(function (t) { return idEq_(t.TeacherID, id); })[0];
  if (!target) throw error_('VALIDATION', 'ไม่พบข้อมูลครูรหัส ' + id);
  const leaves = await readTable(ctx.d1, SHEETS.LEAVES);
  if (leaves.some(function (l) { return idEq_(l.TeacherID, id); })) {
    throw error_('VALIDATION', 'ไม่สามารถลบครูที่มีประวัติการลาได้');
  }
  await deleteRowsByKey(ctx.d1, SHEETS.TEACHERS, 'TeacherID', [id]);
  // The login account of the staff member is deactivated, not deleted, so
  // that the audit log stays readable.
  const username = String(target.Username || '').trim().toLowerCase();
  if (username) {
    const users = await readTable(ctx.d1, SHEETS.USERS);
    const acc = users.filter(function (u) {
      return String(u.Username || '').trim().toLowerCase() === username;
    })[0];
    if (acc) {
      await upsertRows(ctx.d1, SHEETS.USERS, [Object.assign({}, acc, {
        Status: 'INACTIVE', UpdatedAt: ctx.now()
      })]);
    }
  }
  await ctx.logAudit({
    userId: session.UserID, username: session.Username, role: session.Role,
    action: 'DELETE', entity: 'Teachers', entityId: id, details: id
  });
  await ctx.bumpDataVersion();
  return { ok: true };
}

/** Exports teachers. */
export async function exportTeachers_(ctx, payload) {
  await ctx.requirePermission(payload.token, 'teacher.export');
  const list = await listTeachers_(ctx, payload);
  const headers = ['TeacherID', 'FirstName', 'LastName', 'Position', 'Department',
    'EmploymentStatus', 'Username', 'Role', 'AcademicYear'];
  const rows = list.rows.map(function (r) { return headers.map(function (h) { return r[h] === undefined ? '' : r[h]; }); });
  return { headers: headers, rows: rows, filename: 'teachers_' + ctx.today() };
}

/* ==========================================================================
 * SECTION 9: CLASSROOM MANAGEMENT (Classrooms + Subjects)
 * ========================================================================== */

/** Returns the display name of a classroom. */
export function classNameOf_(classes, classId) {
  if (!classId) return '';
  const c = classes.filter(function (x) { return idEq_(x.ClassID, classId); })[0];
  return c ? c.ClassName : '';
}

/** Validates that a classroom id exists and matches the expected type. */
async function assertClassType_(ctx, classId, expectedType) {
  if (!classId) return '';
  const rooms = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const room = rooms.filter(function (c) { return idEq_(c.ClassID, classId); })[0];
  if (!room) throw error_('VALIDATION', 'ไม่พบห้องเรียน: ' + classId);
  if (expectedType && room.ClassType !== expectedType) {
    throw error_('VALIDATION', 'ห้องเรียน ' + classId + ' ไม่ใช่ห้องเรียนประเภท ' + expectedType);
  }
  return classId;
}

/** Lists classrooms filtered by type / grade / status. */
export async function listClassrooms_(ctx, payload) {
  await ctx.requirePermission(payload.token, 'classroom.view');
  let rows = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const type = String(payload.classType || '');
  const grade = String(payload.grade || '');
  const status = String(payload.status || '');
  const q = String(payload.q || '').toLowerCase();
  if (type) rows = rows.filter(function (r) { return r.ClassType === type; });
  if (grade) rows = rows.filter(function (r) { return r.GradeLevel === grade; });
  if (status) rows = rows.filter(function (r) { return r.Status === status; });
  if (q) rows = rows.filter(function (r) { return [r.ClassID, r.ClassName].join(' ').toLowerCase().indexOf(q) !== -1; });
  rows = sortBy_(rows, 'ClassID');
  const counts = { studentCount: {} };
  const students = await readTable(ctx.d1, SHEETS.STUDENTS);
  students.forEach(function (s) {
    ['ReligiousClassID', 'GeneralClassID', 'HomeroomClassID'].forEach(function (f) {
      if (s[f]) counts.studentCount[s[f]] = (counts.studentCount[s[f]] || 0) + 1;
    });
  });
  rows = rows.map(function (r) { return Object.assign({}, r, { StudentCount: counts.studentCount[r.ClassID] || 0 }); });
  return { rows: rows, total: rows.length };
}

/** Creates or updates a classroom. */
export async function saveClassroom_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'classroom.manage');
  const src = payload.classroom || {};
  const rooms = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const id = String(src.ClassID || '').trim();
  const existing = id ? rooms.filter(function (c) { return idEq_(c.ClassID, id); })[0] : null;
  const type = String(src.ClassType || '').trim().toUpperCase();
  if (CLASS_TYPES.indexOf(type) === -1) throw error_('VALIDATION', 'ประเภทห้องเรียนไม่ถูกต้อง');
  if (!existing) {
    requireText_(src.ClassID, 'รหัสห้องเรียน', 30);
    requireText_(src.ClassName, 'ชื่อห้องเรียน', 80);
    const dup = rooms.filter(function (c) { return idEq_(c.ClassID, src.ClassID); })[0];
    if (dup) throw error_('VALIDATION', 'รหัสห้องเรียนนี้มีอยู่แล้ว');
    const dupName = rooms.filter(function (c) {
      return c.ClassType === type && String(c.ClassName || '').trim().toLowerCase() === String(src.ClassName || '').trim().toLowerCase();
    })[0];
    if (dupName) throw error_('VALIDATION', 'มีห้องเรียนประเภทนี้ชื่อ "' + src.ClassName + '" อยู่แล้ว');
  }
  const rec = {
    ClassID: String(src.ClassID || '').trim(),
    ClassName: String(src.ClassName || '').trim(),
    ClassType: type,
    GradeLevel: String(src.GradeLevel || '').trim(),
    Status: String(src.Status || 'ACTIVE').trim().toUpperCase(),
    CreatedAt: existing ? existing.CreatedAt : ctx.now(),
    UpdatedAt: ctx.now()
  };
  if (!existing) {
    rec.ClassID = requireText_(rec.ClassID, 'รหัสห้องเรียน', 30);
    rec.ClassName = requireText_(rec.ClassName, 'ชื่อห้องเรียน', 80);
  }
  await upsertRows(ctx.d1, SHEETS.CLASSROOMS, [rec]);
  await ctx.logAudit({
    userId: session.UserID, username: session.Username, role: session.Role,
    action: existing ? 'UPDATE' : 'CREATE', entity: 'Classrooms', entityId: rec.ClassID,
    details: rec.ClassName + ' (' + rec.ClassType + ')'
  });
  await ctx.bumpDataVersion();
  return { ok: true, ClassID: rec.ClassID };
}

/** Deletes a classroom. Refuses to delete when it is referenced. */
export async function deleteClassroom_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'classroom.manage');
  const id = requireText_(payload.ClassID, 'รหัสห้องเรียน');
  const rooms = await readTable(ctx.d1, SHEETS.CLASSROOMS);
  const target = rooms.filter(function (c) { return idEq_(c.ClassID, id); })[0];
  if (!target) throw error_('VALIDATION', 'ไม่พบห้องเรียนรหัส ' + id);

  const students = await readTable(ctx.d1, SHEETS.STUDENTS);
  const used = students.filter(function (s) {
    return idEq_(s.ReligiousClassID, id) || idEq_(s.GeneralClassID, id) || idEq_(s.HomeroomClassID, id);
  });
  if (used.length) {
    throw error_('VALIDATION', 'ห้องเรียนนี้มีนักเรียนลงทะเบียนอยู่ ' + used.length + ' คน กรุณาย้ายนักเรียนออกก่อน');
  }
  const attSheets = [SHEETS.ATT_HOMEROOM, SHEETS.ATT_RELIGIOUS, SHEETS.ATT_GENERAL];
  let attCount = 0;
  for (const sh of attSheets) {
    const rows = await readTable(ctx.d1, sh);
    attCount += rows.filter(function (a) { return idEq_(a.ClassID, id); }).length;
  }
  if (attCount) {
    throw error_('VALIDATION', 'ห้องเรียนนี้มีประวัติการเช็คชื่ออยู่ ' + attCount + ' รายการ กรุณาปิดใช้งานห้องเรียนแทนการลบ');
  }
  await deleteRowsByKey(ctx.d1, SHEETS.CLASSROOMS, 'ClassID', [id]);
  await ctx.logAudit({
    userId: session.UserID, username: session.Username, role: session.Role,
    action: 'DELETE', entity: 'Classrooms', entityId: id, details: target.ClassName
  });
  await ctx.bumpDataVersion();
  return { ok: true };
}

/** Lists subjects. */
export async function listSubjects_(ctx, payload) {
  await ctx.requirePermission(payload.token, 'subject.view');
  let rows = await readTable(ctx.d1, SHEETS.SUBJECTS);
  const type = String(payload.subjectType || '');
  const grade = String(payload.grade || '');
  if (type) rows = rows.filter(function (r) { return r.SubjectType === type; });
  if (grade) rows = rows.filter(function (r) { return r.GradeLevel === grade; });
  return { rows: sortBy_(rows, 'SubjectID'), total: rows.length };
}

/** Creates or updates a subject. */
export async function saveSubject_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'subject.manage');
  const src = payload.subject || {};
  const subjects = await readTable(ctx.d1, SHEETS.SUBJECTS);
  const id = String(src.SubjectID || '').trim();
  const existing = id ? subjects.filter(function (s) { return idEq_(s.SubjectID, id); })[0] : null;
  if (!existing) requireText_(src.SubjectID, 'รหัสวิชา', 30);
  const rec = {
    SubjectID: String(src.SubjectID || '').trim(),
    SubjectName: String(src.SubjectName || '').trim(),
    SubjectType: String(src.SubjectType || 'RELIGIOUS').trim().toUpperCase(),
    GradeLevel: String(src.GradeLevel || '').trim(),
    TeacherID: String(src.TeacherID || '').trim(),
    Status: String(src.Status || 'ACTIVE').trim().toUpperCase(),
    CreatedAt: existing ? existing.CreatedAt : ctx.now(),
    UpdatedAt: ctx.now()
  };
  await upsertRows(ctx.d1, SHEETS.SUBJECTS, [rec]);
  await ctx.logAudit({
    userId: session.UserID, username: session.Username, role: session.Role,
    action: existing ? 'UPDATE' : 'CREATE', entity: 'Subjects', entityId: rec.SubjectID, details: rec.SubjectName
  });
  return { ok: true, SubjectID: rec.SubjectID };
}

/** Deletes a subject. */
export async function deleteSubject_(ctx, payload) {
  const session = await ctx.requirePermission(payload.token, 'subject.manage');
  const id = requireText_(payload.SubjectID, 'รหัสวิชา');
  await deleteRowsByKey(ctx.d1, SHEETS.SUBJECTS, 'SubjectID', [id]);
  await ctx.logAudit({
    userId: session.UserID, username: session.Username, role: session.Role,
    action: 'DELETE', entity: 'Subjects', entityId: id, details: id
  });
  return { ok: true };
}
