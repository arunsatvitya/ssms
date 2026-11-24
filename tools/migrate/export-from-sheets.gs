/**
 * ============================================================================
 *  SSMS - ย้ายข้อมูลจาก Google Sheets ไปยัง Cloudflare D1
 * ============================================================================
 *
 *  วิธีใช้ (ไม่ต้องมี Node.js บนเครื่อง):
 *
 *  1) เปิด Google Apps Script ของระบบเดิม (โค้ด Code.gs เดิม)
 *     แล้ววางไฟล์นี้เพิ่มเข้าไป (ไฟล์ > ใหม่ > โค้ด Apps Script)
 *
 *  2) แก้ค่า 3 บรรทัดด้านล่างให้ถูกต้อง:
 *        - SSMS_API_URL   : ที่อยู่ของเว็บบน Cloudflare เช่น https://ssms.pages.dev
 *        - SSMS_API_KEY   : คีย์สำหรับยืนยันตัวตน (ตั้งค่าในหน้าตั้งค่าระบบ)
 *
 *  3) กด Run ฟังก์ชัน exportSheetsJson()
 *     -> ไฟล์ JSON จะถูกสร้างขึ้น (ไฟล์ของฉัน) ให้ดาวน์โหลด
 *
 *  4) เปิดหน้าเว็บของระบบใหม่ -> หน้า "นำเข้าข้อมูล" -> อัปโหลดไฟล์ JSON
 *     หรือเรียก API ตรง:
 *        POST {SSMS_API_URL}/api
 *        { "action": "database.importLegacy", "payload": { "key": "...", "data": { ... } } }
 *
 *  หมายเหตุสำคัญ:
 *    - ข้อมูลการเข้าเรียนของ v3 เก็บแบบบีบอัดในชีต Attendance_Daily
 *      ตัวส่งจะส่งทั้งชีต Attendance_Daily และ Class_Rosters มาด้วย
 *    - หากมีข้อมูลในชีต Attendance_Homeroom / Religious / General
 *      ระบบจะแปลงเป็นรูปแบบบีบอัดให้อัตโนมัติ
 * ============================================================================
 */

/** ที่อยู่ของเว็บบน Cloudflare (ไม่ต้องมี / ต่อท้าย) */
var SSMS_API_URL = 'https://ssms.pages.dev';

/** คีย์สำหรับยืนยันตัวตนของการย้ายข้อมูล - ต้องตั้งในหน้าตั้งค่าระบบ */
var SSMS_API_KEY = 'SSMS-IMPORT-KEY-2026';

/** ชีตที่ต้องส่งไปด้วย (เรียงตามลำดับความสำคัญ) */
var SHEET_ORDER = [
  'Settings',
  'Monitor_Settings',
  'Users',
  'Teachers',
  'Students',
  'Classrooms',
  'Subjects',
  'Class_Rosters',
  'Attendance_Daily',
  'Attendance_Homeroom',
  'Attendance_Religious',
  'Attendance_General',
  'Teacher_Leaves',
  'Announcements',
  'Anomaly_Verifications'
];

/**
 * อ่านข้อมูลทุกชีตออกมาเป็น JSON
 */
function exportSheetsJson() {
  var ss = openMasterSpreadsheet_();
  var result = { exportedAt: new Date().toISOString(), sheets: {} };
  var missing = [];

  SHEET_ORDER.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) { missing.push(name); return; }
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 1 || lastCol < 1) { missing.push(name); return; }

    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
      return String(h || '').trim();
    });
    var rows = [];
    if (lastRow >= 2) {
      var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      values.forEach(function (row) {
        var empty = true;
        for (var i = 0; i < row.length; i++) {
          if (row[i] !== '' && row[i] !== null && row[i] !== undefined) { empty = false; break; }
        }
        if (empty) return;
        var obj = {};
        headers.forEach(function (h, j) {
          var v = row[j];
          obj[h] = (v === undefined || v === null) ? '' : String(v);
        });
        rows.push(obj);
      });
    }
    result.sheets[name] = { headers: headers, rows: rows };
  });

  var json = JSON.stringify(result, null, 2);
  var fileName = 'ssms_export_' +
    Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmmss') + '.json';

  // แสดงผลในหน้าจอด้วย (มีข้อจำกัดความยาว) และบันทึกเป็นไฟล์
  var totalRows = 0;
  Object.keys(result.sheets).forEach(function (k) { totalRows += result.sheets[k].rows.length; });

  // สร้างไฟล์ใน Google Drive เพื่อให้ดาวน์โหลดได้
  var folder = DriveApp.getRootFolder();
  var file = folder.createFile(Utilities.newBlob(json, 'application/json', fileName));
  file.setDescription('SSMS export - ' + totalRows + ' rows');

  console.log('ส่งออกข้อมูล ' + totalRows + ' แถว รวม ' + Object.keys(result.sheets).length + ' ชีต');
  console.log('ไฟล์: ' + fileName);
  if (missing.length) console.log('ไม่พบชีต (ข้ามไป): ' + missing.join(', '));

  try {
    // เปิดไฟล์ที่สร้างให้ผู้ใช้ดาวน์โหลดได้ทันที
    var url = file.getUrl();
    var html = HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif;font-size:15px">' +
      'ส่งออกข้อมูลเรียบร้อย (<b>' + totalRows + '</b> แถว)<br>' +
      'ดาวน์โหลดไฟล์: <a href="' + url + '" target="_blank">' + fileName + '</a>' +
      '</p>');
    return html.getContent();
  } catch (err) {
    return 'ส่งออกข้อมูลเรียบร้อย ' + totalRows + ' แถว (ไฟล์: ' + fileName + ')';
  }
}

/**
 * ส่งข้อมูลเข้า Cloudflare D1 ตรงๆ (ไม่ต้องดาวน์โหลดไฟล์)
 *
 * ใช้เมื่อตั้งค่า SSMS_API_URL และ SSMS_API_KEY แล้ว
 */
function pushToCloudflare() {
  var ss = openMasterSpreadsheet_();
  var data = { sheets: {} };

  SHEET_ORDER.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return;
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
      return String(h || '').trim();
    });
    var rows = [];
    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, lastCol).getValues().forEach(function (row) {
        var empty = true;
        for (var i = 0; i < row.length; i++) {
          if (row[i] !== '' && row[i] !== null && row[i] !== undefined) { empty = false; break; }
        }
        if (empty) return;
        var obj = {};
        headers.forEach(function (h, j) {
          var v = row[j];
          obj[h] = (v === undefined || v === null) ? '' : String(v);
        });
        rows.push(obj);
      });
    }
    data.sheets[name] = { headers: headers, rows: rows };
  });

  var url = SSMS_API_URL.replace(/\/+$/, '') + '/api';
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      action: 'database.importLegacy',
      payload: { key: SSMS_API_KEY, data: data }
    }),
    muteHttpExceptions: true
  });

  var body = response.getContentText();
  console.log('สถานะ: ' + response.getResponseCode());
  console.log('ผลลัพธ์: ' + body);
  return body;
}

/**
 * เปิดสเปรดชีตหลักของระบบเดิม
 */
function openMasterSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SSMS_SPREADSHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (err) { /* ลองใหม่ด้านล่าง */ }
  }
  // ถ้าหาไม่พบ ให้เปิดจากชื่อ
  var files = DriveApp.getFilesByName('SSMS_School_Smart_Monitor');
  if (files.hasNext()) {
    return SpreadsheetApp.openById(files.next().getId());
  }
  throw new Error('ไม่พบสเปรดชีตของระบบ - กรุณาตรวจสอบ SSMS_SPREADSHEET_ID');
}
