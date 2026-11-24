/**
 * ============================================================================
 *  SSMS on Cloudflare - Shared constants
 *  Ported 1:1 from the Google Apps Script version (Code.gs, SECTION 1).
 *
 *  Every value here is identical to the original so that the behaviour of the
 *  ported application does not change.
 * ============================================================================
 */

/** Application identity and runtime configuration. */
export const APP = {
  NAME: 'School Smart Monitor & Management System',
  SHORT_NAME: 'SSMS',
  VERSION: '4.0.0-cloudflare',
  /** Session lifetime (seconds). Default 8 hours. */
  SESSION_TTL_SECONDS: 8 * 60 * 60,
  /** Salted HMAC-SHA256 iteration count used for password hashing. */
  HASH_ITERATIONS: 1000,
  /** Prefix of a password hash - allows detecting legacy hashes on upgrade. */
  HASH_PREFIX: 'pbkdf2-sha256$',
  /** All business timestamps are stored in this timezone. */
  TIMEZONE: 'Asia/Bangkok',
  /** Seed credentials created on first run (must be changed by Super Admin). */
  DEFAULT_ADMIN_USERNAME: 'admin',
  DEFAULT_ADMIN_PASSWORD: 'admin123',
  /** Max rows accepted by a single Excel import request. */
  MAX_IMPORT_ROWS: 3000,
  /** Max rows returned to the client in a single list API. */
  MAX_PAGE_ROWS: 2000,
  /** Schema version of the D1 structure. */
  SCHEMA_VERSION: '5'
};

/** Sheet names - identical to the original spreadsheet. */
export const SHEETS = {
  SETTINGS: 'Settings',
  USERS: 'Users',
  TEACHERS: 'Teachers',
  STUDENTS: 'Students',
  CLASSROOMS: 'Classrooms',
  SUBJECTS: 'Subjects',
  ATT_HOMEROOM: 'Attendance_Homeroom',
  ATT_RELIGIOUS: 'Attendance_Religious',
  ATT_GENERAL: 'Attendance_General',
  ATT_ANOMALIES: 'Attendance_Anomalies',
  ATT_DAILY: 'Attendance_Daily',
  CLASS_ROSTERS: 'Class_Rosters',
  ANOMALY_VERIFICATIONS: 'Anomaly_Verifications',
  LEAVES: 'Teacher_Leaves',
  ANNOUNCEMENTS: 'Announcements',
  MONITOR: 'Monitor_Settings',
  AUDIT: 'Audit_Logs',
  SESSIONS: 'Sessions'
};

/**
 * Column headers of every sheet (index 0 is always the primary key column).
 * The order is identical to the original - the import/export of Excel files
 * depends on it.
 */
export const HEADERS = {
  [SHEETS.SETTINGS]: ['Key', 'Value', 'UpdatedAt'],
  [SHEETS.USERS]: ['UserID', 'Username', 'PasswordHash', 'Salt', 'FullName', 'Role', 'Email', 'Phone', 'Status', 'LastLoginAt', 'CreatedAt', 'UpdatedAt'],
  [SHEETS.TEACHERS]: ['TeacherID', 'FirstName', 'LastName', 'Position', 'Department', 'EmploymentStatus', 'Username', 'Role', 'AcademicYear', 'CreatedAt', 'UpdatedAt'],
  [SHEETS.STUDENTS]: ['StudentID', 'ThaiFirstName', 'ThaiLastName', 'JawiFirstName', 'JawiLastName', 'GradeLevel', 'ReligiousClassID', 'GeneralClassID', 'HomeroomClassID', 'StudentStatus', 'AcademicYear', 'CreatedAt', 'UpdatedAt', 'NationalID', 'BirthDate'],
  [SHEETS.CLASSROOMS]: ['ClassID', 'ClassName', 'ClassType', 'GradeLevel', 'Status', 'CreatedAt', 'UpdatedAt'],
  [SHEETS.SUBJECTS]: ['SubjectID', 'SubjectName', 'SubjectType', 'GradeLevel', 'TeacherID', 'Status', 'CreatedAt', 'UpdatedAt'],
  [SHEETS.ATT_HOMEROOM]: ['AttendanceID', 'StudentID', 'AttendanceType', 'ClassID', 'AttendanceDate', 'Status', 'RecordedBy', 'CreatedAt', 'UpdatedAt'],
  [SHEETS.ATT_RELIGIOUS]: ['AttendanceID', 'StudentID', 'AttendanceType', 'ClassID', 'AttendanceDate', 'Status', 'RecordedBy', 'CreatedAt', 'UpdatedAt'],
  [SHEETS.ATT_GENERAL]: ['AttendanceID', 'StudentID', 'AttendanceType', 'ClassID', 'AttendanceDate', 'Status', 'RecordedBy', 'CreatedAt', 'UpdatedAt'],
  [SHEETS.ATT_ANOMALIES]: ['AnomalyID', 'StudentID', 'AttendanceDate', 'AnomalyType', 'AttendanceType', 'ClassID', 'VerificationStatus', 'DetectedAt'],
  [SHEETS.ATT_DAILY]: ['DayID', 'AttendanceDate', 'ClassID', 'Round', 'RosterVersion', 'Statuses', 'RecordedBy'],
  [SHEETS.CLASS_ROSTERS]: ['RosterID', 'ClassID', 'Round', 'Version', 'StudentIDs', 'CreatedAt'],
  [SHEETS.ANOMALY_VERIFICATIONS]: ['AnomalyID', 'StudentID', 'AttendanceDate', 'AnomalyType', 'AttendanceType', 'ClassID', 'VerificationStatus', 'VerifiedBy', 'VerifiedAt', 'Note'],
  [SHEETS.LEAVES]: ['LeaveID', 'TeacherID', 'LeaveDate', 'LeaveType', 'Note', 'RecordedBy', 'CreatedAt', 'UpdatedAt'],
  [SHEETS.ANNOUNCEMENTS]: ['AnnouncementID', 'Title', 'Content', 'StartDate', 'EndDate', 'Priority', 'AnimationType', 'TextColor', 'BackgroundColor', 'FontSize', 'AnimationSpeed', 'Status', 'CreatedBy', 'CreatedAt', 'UpdatedAt'],
  [SHEETS.MONITOR]: ['Key', 'Value', 'UpdatedAt'],
  [SHEETS.AUDIT]: ['LogID', 'Timestamp', 'UserID', 'Username', 'Role', 'Action', 'Entity', 'EntityID', 'Details'],
  [SHEETS.SESSIONS]: ['SessionID', 'UserID', 'Username', 'Role', 'TokenHash', 'CreatedAt', 'ExpiresAt', 'LastSeenAt', 'UserAgent']
};

/**
 * Mapping of a sheet name to its D1 table and column names.
 *
 * The D1 tables use snake_case column names, the business logic keeps using
 * the original header names. This table is the single place where the two
 * worlds meet - the shim translates in both directions.
 *
 * `key` is the primary key column (index 0 of the header list).
 */
export const TABLES = {
  [SHEETS.SETTINGS]: { table: 'settings', key: 'key', columns: ['key', 'value', 'updated_at'] },
  [SHEETS.USERS]: {
    table: 'users', key: 'user_id',
    columns: ['user_id', 'username', 'password_hash', 'salt', 'full_name', 'role', 'email', 'phone', 'status', 'last_login_at', 'created_at', 'updated_at']
  },
  [SHEETS.TEACHERS]: {
    table: 'teachers', key: 'teacher_id',
    columns: ['teacher_id', 'first_name', 'last_name', 'position', 'department', 'employment_status', 'username', 'role', 'academic_year', 'created_at', 'updated_at']
  },
  [SHEETS.STUDENTS]: {
    table: 'students', key: 'student_id',
    columns: ['student_id', 'thai_first_name', 'thai_last_name', 'jawi_first_name', 'jawi_last_name', 'grade_level', 'religious_class_id', 'general_class_id', 'homeroom_class_id', 'student_status', 'academic_year', 'created_at', 'updated_at', 'national_id', 'birth_date']
  },
  [SHEETS.CLASSROOMS]: {
    table: 'classrooms', key: 'class_id',
    columns: ['class_id', 'class_name', 'class_type', 'grade_level', 'status', 'created_at', 'updated_at']
  },
  [SHEETS.SUBJECTS]: {
    table: 'subjects', key: 'subject_id',
    columns: ['subject_id', 'subject_name', 'subject_type', 'grade_level', 'teacher_id', 'status', 'created_at', 'updated_at']
  },
  [SHEETS.ATT_HOMEROOM]: {
    table: 'attendance_homeroom', key: 'attendance_id',
    columns: ['attendance_id', 'student_id', 'attendance_type', 'class_id', 'attendance_date', 'status', 'recorded_by', 'created_at', 'updated_at']
  },
  [SHEETS.ATT_RELIGIOUS]: {
    table: 'attendance_religious', key: 'attendance_id',
    columns: ['attendance_id', 'student_id', 'attendance_type', 'class_id', 'attendance_date', 'status', 'recorded_by', 'created_at', 'updated_at']
  },
  [SHEETS.ATT_GENERAL]: {
    table: 'attendance_general', key: 'attendance_id',
    columns: ['attendance_id', 'student_id', 'attendance_type', 'class_id', 'attendance_date', 'status', 'recorded_by', 'created_at', 'updated_at']
  },
  [SHEETS.ATT_ANOMALIES]: {
    table: 'attendance_anomalies', key: 'anomaly_id',
    columns: ['anomaly_id', 'student_id', 'attendance_date', 'anomaly_type', 'attendance_type', 'class_id', 'verification_status', 'detected_at']
  },
  [SHEETS.ATT_DAILY]: {
    table: 'attendance_daily', key: 'day_id',
    columns: ['day_id', 'attendance_date', 'class_id', 'round', 'roster_version', 'statuses', 'recorded_by']
  },
  [SHEETS.CLASS_ROSTERS]: {
    table: 'class_rosters', key: 'roster_id',
    columns: ['roster_id', 'class_id', 'round', 'version', 'student_ids', 'created_at']
  },
  [SHEETS.ANOMALY_VERIFICATIONS]: {
    table: 'anomaly_verifications', key: 'anomaly_id',
    columns: ['anomaly_id', 'student_id', 'attendance_date', 'anomaly_type', 'attendance_type', 'class_id', 'verification_status', 'verified_by', 'verified_at', 'note']
  },
  [SHEETS.LEAVES]: {
    table: 'teacher_leaves', key: 'leave_id',
    columns: ['leave_id', 'teacher_id', 'leave_date', 'leave_type', 'note', 'recorded_by', 'created_at', 'updated_at']
  },
  [SHEETS.ANNOUNCEMENTS]: {
    table: 'announcements', key: 'announcement_id',
    columns: ['announcement_id', 'title', 'content', 'start_date', 'end_date', 'priority', 'animation_type', 'text_color', 'background_color', 'font_size', 'animation_speed', 'status', 'created_by', 'created_at', 'updated_at']
  },
  [SHEETS.MONITOR]: { table: 'monitor_settings', key: 'key', columns: ['key', 'value', 'updated_at'] },
  [SHEETS.AUDIT]: {
    table: 'audit_logs', key: 'log_id',
    columns: ['log_id', 'timestamp', 'user_id', 'username', 'role', 'action', 'entity', 'entity_id', 'details']
  },
  [SHEETS.SESSIONS]: {
    table: 'sessions', key: 'session_id',
    columns: ['session_id', 'user_id', 'username', 'role', 'token_hash', 'created_at', 'expires_at', 'last_seen_at', 'user_agent']
  }
};

/** Attendance rounds. */
export const ROUNDS = {
  HOMEROOM: 'HOMEROOM',
  RELIGIOUS: 'RELIGIOUS',
  GENERAL: 'GENERAL'
};

export const ROUND_SHEET = {
  HOMEROOM: SHEETS.ATT_HOMEROOM,
  RELIGIOUS: SHEETS.ATT_RELIGIOUS,
  GENERAL: SHEETS.ATT_GENERAL
};

/** Which classroom type is used by each round. */
export const ROUND_CLASS_TYPE = {
  HOMEROOM: 'HOMEROOM',
  RELIGIOUS: 'RELIGIOUS',
  GENERAL: 'GENERAL'
};

/** Classroom types. */
export const CLASS_TYPES = ['RELIGIOUS', 'GENERAL', 'HOMEROOM'];

/** Attendance status codes (stored in the database). */
export const ATT_STATUS = {
  PRESENT: 'PRESENT',   // มาเรียน  / حاضر
  ABSENT: 'ABSENT',     // ขาดเรียน / غائب
  LATE: 'LATE',         // มาสาย  / ليوات
  LEAVE: 'LEAVE'        // ลา       / چوتي
};

/** Jawi labels mandated by the specification for the religious round. */
export const Jawi_STATUS = {
  PRESENT: 'حاضر',
  ABSENT: 'غائب',
  LATE: 'ليوات',
  LEAVE: 'چوتي'
};

/** Thai labels for every attendance status. */
export const THAI_STATUS = {
  PRESENT: 'มาเรียน',
  ABSENT: 'ขาดเรียน',
  LATE: 'มาสาย',
  LEAVE: 'ลา'
};

/** Leave types. */
export const LEAVE_TYPES = ['SICK', 'PERSONAL', 'REST', 'MATERNITY', 'OTHER'];

/** Anomaly types / verification status. */
export const ANOMALY = {
  ABSENT_RELIGIOUS: 'ABSENT_RELIGIOUS',
  ABSENT_GENERAL: 'ABSENT_GENERAL',
  VERIFICATION_PENDING: 'VERIFICATION_PENDING'
};

export const VERIFICATION = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  DISMISSED: 'DISMISSED'
};

/** Announcement animation types. */
export const ANIMATIONS = ['MARQUEE', 'FLOATING', 'FADE_LETTER', 'WORD_POPUP', 'TYPEWRITER', 'FADE_IN'];

/** Available visual templates for the smart monitor. */
export const MONITOR_TEMPLATES = [
  'midnight',  // มืด - น้ำเงินเข้ม
  'aurora',    // มืด - เขียว/ฟ้าเรืองแสง
  'sunrise',   // สว่าง - ครีมอุ่น
  'cloud',     // สว่าง - สะอาดเรียบ
  'royal',     // ทางการ - ม่วงทอง
  'candy',     // หวาน - พาสเทล
  'minimal',   // โมโน - ขาวดำ
  'emerald'    // ทางการ - เขียวเข้ม
];

/** User roles. */
export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  TEACHER: 'TEACHER',
  ATTENDANCE_OFFICER: 'ATTENDANCE_OFFICER',
  ANNOUNCEMENT_OFFICER: 'ANNOUNCEMENT_OFFICER',
  MONITOR: 'MONITOR'
};

/**
 * Permission matrix. Every API action is checked against this map on the
 * server side - hiding buttons on the client is never sufficient.
 */
export const ROLE_PERMISSIONS = {
  SUPER_ADMIN: ['*'],
  ADMIN: [
    'user.view',
    'student.view', 'student.manage', 'student.import', 'student.export',
    'teacher.view', 'teacher.manage', 'teacher.import', 'teacher.export',
    'classroom.view', 'classroom.manage', 'subject.view', 'subject.manage',
    'attendance.view', 'attendance.record', 'attendance.edit', 'attendance.delete',
    'anomaly.view', 'anomaly.verify',
    'leave.view', 'leave.manage',
    'announcement.view', 'announcement.create', 'announcement.edit', 'announcement.publish', 'announcement.delete',
    'monitor.view', 'monitor.config',
    'dashboard.view', 'reports.view', 'reports.export',
    'settings.view', 'settings.manage', 'audit.view'
  ],
  TEACHER: [
    'student.view', 'teacher.view', 'classroom.view', 'subject.view',
    'attendance.view', 'attendance.record',
    'anomaly.view',
    'leave.view', 'leave.self',
    'announcement.view',
    'monitor.view',
    'dashboard.view'
  ],
  ATTENDANCE_OFFICER: [
    'attendance.view', 'attendance.record', 'attendance.edit',
    'anomaly.view', 'anomaly.verify',
    'dashboard.view'
  ],
  ANNOUNCEMENT_OFFICER: [
    'attendance.view', 'attendance.record', 'attendance.edit',
    'anomaly.view', 'anomaly.verify',
    'announcement.view', 'announcement.create', 'announcement.edit',
    'dashboard.view'
  ],
  MONITOR: ['monitor.view', 'announcement.view', 'dashboard.view']
};

/**
 * Identifier columns - always stored and compared as text.
 * A student id such as "00123" must never become the number 123.
 */
export const ID_FIELDS = [
  'StudentID', 'TeacherID', 'ClassID', 'LeaveID', 'AnomalyID', 'AttendanceID',
  'UserID', 'AnnouncementID', 'SubjectID', 'SessionID', 'LogID', 'NationalID'
];

/** The letter of every status in the compact field. */
export const COMPACT_CODE_ = { PRESENT: 'P', ABSENT: 'A', LATE: 'L', LEAVE: 'V' };

/** Grade groups of the general subject. */
export const GRADE_GROUPS_GENERAL = ['อนุบาล', 'ประถมศึกษา', 'มัธยมศึกษาต้น', 'มัธยมศึกษาปลาย'];

/** Grade groups of the religious subject - all secondary levels count together. */
export const GRADE_GROUPS_RELIGIOUS = ['อนุบาล', 'ประถมศึกษา', 'มัธยมศึกษา'];

/** The round of every attendance sheet - the name of the sheet is the type. */
export const SHEET_ROUND_ = {
  'Attendance_Homeroom': 'HOMEROOM',
  'Attendance_Religious': 'RELIGIOUS',
  'Attendance_General': 'GENERAL'
};

/**
 * Tables that change rarely - their content is kept in the cache.
 * Identical to the original CACHEABLE_TABLES.
 */
export const CACHEABLE_TABLES = {
  'Students': true, 'Classrooms': true, 'Teachers': true, 'Subjects': true,
  'Users': true, 'Settings': true, 'Monitor_Settings': true, 'Announcements': true
};

/** Maximum size of one cache value (the cache API allows 100 KB). */
export const CACHE_LIMIT_ = 90000;
