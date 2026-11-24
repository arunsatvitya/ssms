/**
 * ============================================================================
 *  SSMS on Cloudflare - API router
 * ============================================================================
 *
 *  The route table is identical to the original API_ROUTES - the same action
 *  names, the same handlers. The browser does not have to change at all
 *  except for the way it reaches the server.
 * ============================================================================
 */

import * as auth from './auth.js';
import * as directory from './directory.js';
import * as roster from './roster.js';
import * as attendance from './attendance.js';
import * as reports from './reports.js';
import * as migrate from './migrate.js';
import * as leaves from './leaves.js';
import { jsonSafe_ } from './util.js';

/**
 * Route table - action name -> handler.
 * Every action performs its own authorization check.
 */
export const API_ROUTES = {
  'system.info': (ctx, p) => auth.systemInfo_(ctx, p),
  'system.publicInfo': (ctx, p) => auth.systemPublicInfo_(ctx, p),
  'system.webAppUrl': (ctx, p) => auth.systemWebAppUrl_(ctx, p),
  'system.setup': (ctx, p) => auth.systemSetup_(ctx, p),

  'auth.login': (ctx, p) => auth.login_(ctx, p),
  'auth.logout': (ctx, p) => auth.logout_(ctx, p),
  'auth.me': (ctx, p) => auth.me_(ctx, p),
  'auth.changePassword': (ctx, p) => auth.changePassword_(ctx, p),

  'users.list': (ctx, p) => auth.listUsers_(ctx, p),
  'users.save': (ctx, p) => auth.saveUser_(ctx, p),
  'users.delete': (ctx, p) => auth.deleteUser_(ctx, p),

  'students.list': (ctx, p) => directory.listStudents_(ctx, p),
  'students.get': (ctx, p) => directory.getStudent_(ctx, p),
  'students.save': (ctx, p) => directory.saveStudent_(ctx, p),
  'students.delete': (ctx, p) => directory.deleteStudent_(ctx, p),
  'students.import': (ctx, p) => reports.importStudents_(ctx, p),
  'students.export': (ctx, p) => directory.exportStudents_(ctx, p),

  'teachers.list': (ctx, p) => directory.listTeachers_(ctx, p),
  'teachers.save': (ctx, p) => directory.saveTeacher_(ctx, p),
  'teachers.delete': (ctx, p) => directory.deleteTeacher_(ctx, p),
  'teachers.import': (ctx, p) => reports.importTeachers_(ctx, p),
  'teachers.export': (ctx, p) => directory.exportTeachers_(ctx, p),

  'classrooms.list': (ctx, p) => directory.listClassrooms_(ctx, p),
  'classrooms.save': (ctx, p) => directory.saveClassroom_(ctx, p),
  'classrooms.delete': (ctx, p) => directory.deleteClassroom_(ctx, p),
  'subjects.list': (ctx, p) => directory.listSubjects_(ctx, p),
  'subjects.save': (ctx, p) => directory.saveSubject_(ctx, p),
  'subjects.delete': (ctx, p) => directory.deleteSubject_(ctx, p),

  'attendance.get': (ctx, p) => attendance.attendanceSheet_(ctx, p),
  'attendance.save': (ctx, p) => attendance.saveAttendance_(ctx, p),
  'attendance.list': (ctx, p) => attendance.listAttendance_(ctx, p),
  'attendance.status': (ctx, p) => attendance.attendanceStatus_(ctx, p),
  'attendance.stats': (ctx, p) => attendance.attendanceStats_(ctx, p),
  'leaves.stats': (ctx, p) => attendance.leaveStats_(ctx, p),
  'attendance.delete': (ctx, p) => attendance.deleteAttendance_(ctx, p),
  'database.usage': (ctx, p) => auth.databaseUsage_(ctx, p),
  'database.migrate': (ctx, p) => migrate.migrateLegacyAttendance_(ctx, p),

  'database.importLegacy': (ctx, p) => migrate.importLegacyData_(ctx, p),
  'anomalies.list': (ctx, p) => attendance.listAnomalies_(ctx, p),
  'anomalies.verify': (ctx, p) => attendance.verifyAnomaly_(ctx, p),

  'leaves.list': (ctx, p) => leaves.listLeaves_(ctx, p),
  'leaves.save': (ctx, p) => leaves.saveLeave_(ctx, p),
  'leaves.delete': (ctx, p) => leaves.deleteLeave_(ctx, p),

  'announcements.list': (ctx, p) => reports.listAnnouncements_(ctx, p),
  'announcements.save': (ctx, p) => reports.saveAnnouncement_(ctx, p),
  'announcements.delete': (ctx, p) => reports.deleteAnnouncement_(ctx, p),

  'monitor.data': (ctx, p) => reports.monitorData_(ctx, p),
  'monitor.version': (ctx, p) => reports.monitorVersion_(ctx, p),
  'monitor.settings.get': (ctx, p) => reports.getMonitorSettings_(ctx, p),
  'monitor.settings.save': (ctx, p) => reports.saveMonitorSettings_(ctx, p),

  'dashboard.stats': (ctx, p) => reports.dashboardStats_(ctx, p),
  'reports.data': (ctx, p) => reports.reportData_(ctx, p),

  'settings.get': (ctx, p) => auth.getSettings_(ctx, p),
  'settings.save': (ctx, p) => auth.saveSettings_(ctx, p),
  'settings.assignClassTeacher': (ctx, p) => auth.assignClassTeacher_(ctx, p),

  'audit.list': (ctx, p) => auth.listAudit_(ctx, p),

  'lookup.all': (ctx, p) => auth.lookupAll_(ctx, p),

  'import.fields': (ctx, p) => reports.importFields_(ctx, p)
};

/**
 * Handles one API call.
 *
 * @param {Object} ctx - the request context
 * @param {string} action - the action name
 * @param {Object} payload - the payload of the request
 * @returns {Promise<Object>} - { ok, data } or { ok:false, error }
 */
export async function handleApi(ctx, action, payload) {
  const started = Date.now();
  try {
    if (!action) throw new Error('ไม่ได้ระบุการกระทำ (action is required)');
    const handler = API_ROUTES[action];
    if (!handler) {
      throw new Error('ไม่พบฟังก์ชันที่ร้องขอ: ' + action);
    }
    const data = await handler(ctx, payload || {});
    // Every response is made JSON-safe before it leaves the server.
    const result = {
      ok: true,
      data: jsonSafe_(data),
      elapsedMs: Date.now() - started
    };
    return result;
  } catch (err) {
    return {
      ok: false,
      error: {
        code: (err && err.code) ? err.code : 'SERVER_ERROR',
        message: (err && err.message) ? err.message : String(err),
        stack: (err && err.stack) ? String(err.stack).split('\n').slice(0, 4).join('\n') : ''
      },
      elapsedMs: Date.now() - started
    };
  }
}

