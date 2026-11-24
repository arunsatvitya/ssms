-- ============================================================================
--  SSMS on Cloudflare D1 - base schema
--  Ported from the Google Sheets structure of the original Apps Script app.
--
--  Every sheet of the spreadsheet becomes a table with the same column names.
--  The first column of a sheet was the primary key in the spreadsheet, so it
--  becomes the PRIMARY KEY here as well.
--
--  All values are stored as TEXT. The Apps Script version read every cell as
--  a string anyway (cellToString_) and identifiers were explicitly formatted
--  as plain text, so leading zeros ("00123") are preserved.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Settings / Monitor_Settings - simple key/value stores
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS monitor_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,
  username      TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  salt          TEXT NOT NULL DEFAULT '',
  full_name     TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT '',
  last_login_at TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- ---------------------------------------------------------------------------
-- Teachers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teachers (
  teacher_id        TEXT PRIMARY KEY,
  first_name        TEXT NOT NULL DEFAULT '',
  last_name         TEXT NOT NULL DEFAULT '',
  position          TEXT NOT NULL DEFAULT '',
  department        TEXT NOT NULL DEFAULT '',
  employment_status TEXT NOT NULL DEFAULT '',
  username          TEXT NOT NULL DEFAULT '',
  role              TEXT NOT NULL DEFAULT '',
  academic_year     TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT '',
  updated_at        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_teachers_username ON teachers(username);

-- ---------------------------------------------------------------------------
-- Students
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
  student_id        TEXT PRIMARY KEY,
  thai_first_name   TEXT NOT NULL DEFAULT '',
  thai_last_name    TEXT NOT NULL DEFAULT '',
  jawi_first_name   TEXT NOT NULL DEFAULT '',
  jawi_last_name    TEXT NOT NULL DEFAULT '',
  grade_level       TEXT NOT NULL DEFAULT '',
  religious_class_id TEXT NOT NULL DEFAULT '',
  general_class_id  TEXT NOT NULL DEFAULT '',
  homeroom_class_id TEXT NOT NULL DEFAULT '',
  student_status    TEXT NOT NULL DEFAULT '',
  academic_year     TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT '',
  updated_at        TEXT NOT NULL DEFAULT '',
  national_id       TEXT NOT NULL DEFAULT '',
  birth_date        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_students_religious ON students(religious_class_id);
CREATE INDEX IF NOT EXISTS idx_students_general  ON students(general_class_id);
CREATE INDEX IF NOT EXISTS idx_students_homeroom  ON students(homeroom_class_id);
CREATE INDEX IF NOT EXISTS idx_students_grade    ON students(grade_level);

-- ---------------------------------------------------------------------------
-- Classrooms / Subjects
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS classrooms (
  class_id    TEXT PRIMARY KEY,
  class_name  TEXT NOT NULL DEFAULT '',
  class_type  TEXT NOT NULL DEFAULT '',
  grade_level TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_classrooms_type ON classrooms(class_type);

CREATE TABLE IF NOT EXISTS subjects (
  subject_id   TEXT PRIMARY KEY,
  subject_name TEXT NOT NULL DEFAULT '',
  subject_type TEXT NOT NULL DEFAULT '',
  grade_level  TEXT NOT NULL DEFAULT '',
  teacher_id   TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Legacy attendance sheets (one table per round, as in the spreadsheet)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_homeroom (
  attendance_id   TEXT PRIMARY KEY,
  student_id      TEXT NOT NULL DEFAULT '',
  attendance_type TEXT NOT NULL DEFAULT '',
  class_id        TEXT NOT NULL DEFAULT '',
  attendance_date TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT '',
  recorded_by     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_att_homeroom_date ON attendance_homeroom(attendance_date);
CREATE INDEX IF NOT EXISTS idx_att_homeroom_student ON attendance_homeroom(student_id);

CREATE TABLE IF NOT EXISTS attendance_religious (
  attendance_id   TEXT PRIMARY KEY,
  student_id      TEXT NOT NULL DEFAULT '',
  attendance_type TEXT NOT NULL DEFAULT '',
  class_id        TEXT NOT NULL DEFAULT '',
  attendance_date TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT '',
  recorded_by     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_att_religious_date ON attendance_religious(attendance_date);
CREATE INDEX IF NOT EXISTS idx_att_religious_student ON attendance_religious(student_id);

CREATE TABLE IF NOT EXISTS attendance_general (
  attendance_id   TEXT PRIMARY KEY,
  student_id      TEXT NOT NULL DEFAULT '',
  attendance_type TEXT NOT NULL DEFAULT '',
  class_id        TEXT NOT NULL DEFAULT '',
  attendance_date TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT '',
  recorded_by     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_att_general_date ON attendance_general(attendance_date);
CREATE INDEX IF NOT EXISTS idx_att_general_student ON attendance_general(student_id);

-- ---------------------------------------------------------------------------
-- Compact attendance - one row per day / round / classroom
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_daily (
  day_id          TEXT PRIMARY KEY,
  attendance_date TEXT NOT NULL DEFAULT '',
  class_id        TEXT NOT NULL DEFAULT '',
  round           TEXT NOT NULL DEFAULT '',
  roster_version  TEXT NOT NULL DEFAULT '',
  statuses        TEXT NOT NULL DEFAULT '',
  recorded_by     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_att_daily_date  ON attendance_daily(attendance_date);
CREATE INDEX IF NOT EXISTS idx_att_daily_class ON attendance_daily(class_id, round);

-- ---------------------------------------------------------------------------
-- Class rosters - the student list of a classroom in one round
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS class_rosters (
  roster_id    TEXT PRIMARY KEY,
  class_id     TEXT NOT NULL DEFAULT '',
  round        TEXT NOT NULL DEFAULT '',
  version      TEXT NOT NULL DEFAULT '',
  student_ids  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_rosters_class ON class_rosters(class_id, round);

-- ---------------------------------------------------------------------------
-- Anomalies / manual verifications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_anomalies (
  anomaly_id         TEXT PRIMARY KEY,
  student_id         TEXT NOT NULL DEFAULT '',
  attendance_date    TEXT NOT NULL DEFAULT '',
  anomaly_type       TEXT NOT NULL DEFAULT '',
  attendance_type    TEXT NOT NULL DEFAULT '',
  class_id           TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT '',
  detected_at        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_anomalies_date ON attendance_anomalies(attendance_date);

CREATE TABLE IF NOT EXISTS anomaly_verifications (
  anomaly_id         TEXT PRIMARY KEY,
  student_id         TEXT NOT NULL DEFAULT '',
  attendance_date    TEXT NOT NULL DEFAULT '',
  anomaly_type       TEXT NOT NULL DEFAULT '',
  attendance_type    TEXT NOT NULL DEFAULT '',
  class_id           TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT '',
  verified_by        TEXT NOT NULL DEFAULT '',
  verified_at        TEXT NOT NULL DEFAULT '',
  note               TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Teacher leaves
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teacher_leaves (
  leave_id    TEXT PRIMARY KEY,
  teacher_id  TEXT NOT NULL DEFAULT '',
  leave_date  TEXT NOT NULL DEFAULT '',
  leave_type  TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_leaves_date ON teacher_leaves(leave_date);
CREATE INDEX IF NOT EXISTS idx_leaves_teacher ON teacher_leaves(teacher_id);

-- ---------------------------------------------------------------------------
-- Announcements
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS announcements (
  announcement_id  TEXT PRIMARY KEY,
  title            TEXT NOT NULL DEFAULT '',
  content          TEXT NOT NULL DEFAULT '',
  start_date       TEXT NOT NULL DEFAULT '',
  end_date         TEXT NOT NULL DEFAULT '',
  priority         TEXT NOT NULL DEFAULT '',
  animation_type   TEXT NOT NULL DEFAULT '',
  text_color       TEXT NOT NULL DEFAULT '',
  background_color TEXT NOT NULL DEFAULT '',
  font_size        TEXT NOT NULL DEFAULT '',
  animation_speed  TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT '',
  created_by       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT '',
  updated_at       TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Sessions / audit log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL DEFAULT '',
  username    TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT '',
  token_hash  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT '',
  expires_at  TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  log_id    TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT '',
  user_id   TEXT NOT NULL DEFAULT '',
  username  TEXT NOT NULL DEFAULT '',
  role      TEXT NOT NULL DEFAULT '',
  action    TEXT NOT NULL DEFAULT '',
  entity    TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  details   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);

-- ---------------------------------------------------------------------------
-- Schema bookkeeping - replaces PropertiesService of Apps Script
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
