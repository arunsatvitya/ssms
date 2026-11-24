# สัญญา Data Layer สำหรับการพอร์ต (PORTING CONTRACT)

ไฟล์นี้เป็น "กฎการพอร์ต" ที่ทุกโมดูลต้องยึด — อ่านก่อนเริ่มเขียนโค้ด

## 1. ไฟล์ต้นทาง

- ต้นฉบับ: `../v3-compact/Code.gs` (Apps Script, 5,400 บรรทัด, ฟังก์ชันแบบ sync)
- เป้าหมาย: `src/lib/*.js` (Cloudflare Worker, ES modules, **async**)

## 2. กฎเหล็ก 3 ข้อ

1. **คงพฤติกรรมเดิม 100%** — logic, ข้อความภาษาไทย, ลำดับ, ค่าคงที่ ห้ามเปลี่ยน
   ถ้าไม่แน่ใจว่าเดิมทำอย่างไร ให้เปิด Code.gs อ่านซ้ำ
2. **ห้ามแตะ Google Apps Script services** — มีแทนครบแล้วใน `_lib/util.js`:
   - `Utilities.computeHmacSha256Signature` → `hmacSha256_(value, key)` (async)
   - `Utilities.computeDigest(SHA_256, ...)` → `sha256_(value)` (async)
   - `Utilities.getUuid()` → `crypto.randomUUID()`
   - `Utilities.formatDate(d, TZ, 'yyyy-MM-dd')` → `formatDate_(d, 'yyyy-MM-dd')`
   - `CacheService` → `cacheGet_/cachePut_/cacheRemove_/clearAppCache_` (async, ใช้ `ctx.cache`)
   - `LockService` → ไม่มีใน Workers (D1 เขียนแบบ transaction แล้ว) — ใช้ `ctx.lock` ได้
   - `PropertiesService` → `ctx.meta.get/set` (ตาราง `app_meta`)
   - `ScriptApp.getService().getUrl()` → `ctx.webAppUrl`
3. **ห้ามอ่าน/เขียน Sheet ตรงๆ** — ใช้ helper ใน `_lib/db.js` เท่านั้น

## 3. Data Layer API (`_lib/db.js`)

```js
import { readTable, readKeyValue, writeKeyValue, upsertRows,
         deleteRowsByKey, updateCellByKey, countRows, readRowsByDate,
         readRowsByDateRange } from './db.js';

await readTable(ctx.d1, SHEETS.STUDENTS)              // → [{StudentID:'...', ...}]
await readTable(ctx.d1, SHEETS.STUDENTS, ['StudentID','ThaiFirstName'])  // เฉพาะคอลัมน์
await readKeyValue(ctx.d1, SHEETS.SETTINGS)            // → { SchoolName:'...', ... }
await writeKeyValue(ctx.d1, SHEETS.SETTINGS, 'Key', 'Value', ctx.now())
await upsertRows(ctx.d1, SHEETS.USERS, [{UserID:'USR-1', ...}])   // upsert ด้วย key คอลัมน์แรก
await deleteRowsByKey(ctx.d1, SHEETS.STUDENTS, 'StudentID', ['1001'])
await updateCellByKey(ctx.d1, SHEETS.USERS, 'UserID', 'USR-1', 'PasswordHash', 'xxx')
await readRowsByDate(ctx.d1, SHEETS.LEAVES, 'LeaveDate', '2026-11-24', ['LeaveID'])
await readRowsByDateRange(ctx.d1, SHEETS.LEAVES, 'LeaveDate', '2026-11-01', '2026-11-24')
await countRows(ctx.d1, SHEETS.STUDENTS)
```

**ข้อสำคัญ:** `readTable` คืนค่า object ที่ key เป็น **ชื่อคอลัมน์ตาม HEADERS** (เช่น `StudentID`, `ThaiFirstName`)
ไม่ใช่ชื่อคอลัมน์ใน D1 (`student_id`, `thai_first_name`) — ชั้น `db.js` แปลงให้แล้ว

## 4. Context object (`ctx`)

ทุก handler ได้รับ `ctx` ที่มี:

| ฟิลด์ | ความหมาย |
|---|---|
| `ctx.d1` | D1 binding |
| `ctx.cache` | `caches.default` |
| `ctx.env` | bindings/environment |
| `ctx.now()` | timestamp ปัจจุบัน (string) |
| `ctx.today()` | วันนี้ (string `yyyy-mm-dd`) |
| `ctx.webAppUrl` | URL ของเว็บ (ใช้ทำลิงก์จอมอนิเตอร์) |
| `ctx.request` | the incoming Request |

## 5. รูปแบบ handler

```js
export async function listStudents_(ctx, payload) {
  const session = ctx.requirePermission(payload.token, 'student.view');
  const rows = await readTable(ctx.d1, SHEETS.STUDENTS);
  // ... logic เดิม ...
  return { rows, total: rows.length };
}
```

- handler **ต้อง async**
- คืนค่าเป็น **object ข้อมูลตรงๆ** (ไม่ห่อ `{ok,data}`) — router จะห่อให้
- `ctx.requireSession(token)` / `ctx.requirePermission(token, perm)` ใช้แทน `requireSession_()` / `requirePermission_()`
- error ใช้ `throw error_('CODE', 'ข้อความ')` — โค้ดเดิมใช้ `SERVER_ERROR`, `VALIDATION`, `AUTH`, `FORBIDDEN`

## 6. การเปลี่ยนแปลงที่ต้องทำกับโค้ดเดิม

### 6.1 `const ss = openSs_();` → ไม่ต้องมี
ลบบรรทัดนี้ทิ้ง แล้วแทน `ss.getSheetByName(X)` ด้วย `SHEETS.X` ในการเรียก helper

### 6.2 `readTableBySheet_(ss.getSheetByName(X))` → `await readTable(ctx.d1, X)`
- โค้ดเดิมคืน object ที่มี `__row` ด้วย — ไม่ต้องใช้ ตัดออกได้
- `readTableFast_(ss, X, cols)` → `await readTable(ctx.d1, X, cols)`
- `readTableCached_(ss, X)` → `await readTable(ctx.d1, X)` (cache จัดการที่ชั้น ctx)

### 6.3 `readSettingsMap_(ss)` → `await readKeyValue(ctx.d1, SHEETS.SETTINGS)`
### 6.4 `readMonitorMap_(ss)` → `await readKeyValue(ctx.d1, SHEETS.MONITOR)`
### 6.5 `writeSetting_(ss, NAME, k, v)` → `await writeKeyValue(ctx.d1, NAME, k, v, ctx.now())`
### 6.6 `upsertRows_(ss, X, records)` → `await upsertRows(ctx.d1, X, records)`
### 6.7 `deleteRowsByKey_(ss, X, keyField, keys)` → `await deleteRowsByKey(ctx.d1, X, keyField, keys)`
### 6.8 `updateCellByKey_(ss, X, keyCol, keyVal, col, val)` → `await updateCellByKey(ctx.d1, X, keyCol, keyVal, col, val)`
### 6.9 `now_()` → `ctx.now()`, `today_()` → `ctx.today()`
### 6.10 `hashPassword_(pwd, salt)` → `await hashPassword_(pwd, salt)` (ต้อง await!)
### 6.11 `verifyPassword_(pwd, salt, hash)` → `await verifyPassword_(...)`
### 6.12 `sha256_(v)` → `await sha256_(v)`
### 6.13 `cacheGet_('k', 300)` → `await ctx.cacheGet('k', 300)`
### 6.14 `cachePut_('k', v, 300)` → `await ctx.cachePut('k', v, 300)`
### 6.15 `logAudit_({...})` → `await ctx.logAudit({...})`
### 6.16 `bumpDataVersion_(ss)` → `await ctx.bumpDataVersion()`
### 6.17 `currentDataVersion_(ss)` → `await ctx.currentDataVersion()`

### 6.18 `Utilities.computeHmacSha256Signature(a, b)` → `await hmacSha256_(a, b)`
### 6.19 `Utilities.getUuid()` → `crypto.randomUUID()`
### 6.20 `Utilities.formatDate(d, TZ, fmt)` → `formatDate_(d, fmt)`

## 7. Compact attendance (สำคัญมาก — v3 เขียนข้อมูลแบบบีบอัด)

ระบบเก็บการเข้าเรียนในตาราง `attendance_daily` (หนึ่งแถว = หนึ่งวัน/หนึ่งรอบ/หนึ่งห้อง)
แทนที่จะเก็บทีละนักเรียน

- `SHEETS.ATT_DAILY` → ตาราง `attendance_daily`
- `DayID` = `'D-' + date + '-' + round + '-' + classId` (ดู `dayKey_()`)
- `Statuses` = สตริงตัวอักษร ตัวละ 1 นักเรียน ตามลำดับ `StudentIDs` ของ roster
  - `P`=PRESENT `A`=ABSENT `L`=LATE `V`=LEAVE `-`=ยังไม่เช็ค
- roster เก็บใน `class_rosters` (`StudentIDs` = รหัสคั่นด้วย `,`)

ถ้าโค้ดเดิมอ่าน/เขียนชีต Attendance_Homeroom/Religious/General โดยตรง
ให้เปลี่ยนไปใช้ `attendance_daily` + `class_rosters` ตามตรรกะเดิม

## 8. สิ่งที่ห้ามเปลี่ยน

- ข้อความภาษาไทยทั้งหมด (error message, label, คำแนะนำ) — copy มาเป๊ะ
- ชื่อ action ใน API_ROUTES
- โครงสร้าง response ที่ client ใช้ (field names)
- ตรรกะ permission / role
- สูตรสถิติและการจัดกลุ่มชั้น

## 9. Style

- ES module, `export function` / `export async function`
- `const`/`let`, ไม่ใช้ `var`
- comment ภาษาไทย/อังกฤษได้ ให้อธิบาย "ทำไม" ไม่ใช่ "ทำอะไร"
- ห้ามใช้ `SpreadsheetApp`, `Utilities`, `CacheService`, `LockService`, `PropertiesService`, `ScriptApp`, `Session`
