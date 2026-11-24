# คู่มือติดตั้ง SSMS บน Cloudflare (สำหรับมือใหม่)

> ระบบ **School Smart Monitor & Management System (SSMS)**
> เวอร์ชั่น 4 — ย้ายจาก Google Apps Script + Google Sheets มาอยู่บน
> **Cloudflare Pages + Pages Functions + D1**

คู่มือนี้เขียนสำหรับคนที่ **เพิ่งเริ่มใช้ Cloudflare** จึงอธิบายทุกขั้นตอน
แบบกดตามได้เลย ไม่ต้องใช้ terminal ในขั้นตอนหลัก

---

## สารบัญ

1. [ภาพรวม — ระบบนี้คืออะไร](#1-ภาพรวม--ระบบนี้คืออะไร)
2. [สิ่งที่ต้องมีก่อน](#2-สิ่งที่ต้องมีก่อน)
3. [ติดตั้งแบบไม่ต้องใช้ Terminal (แนะนำ)](#3-ติดตั้งแบบไม่ต้องใช้-terminal-แนะนำ)
4. [ติดตั้งแบบใช้ Wrangler (ทางเลือก)](#4-ติดตั้งแบบใช้-wrangler-ทางเลือก)
5. [ย้ายข้อมูลเดิมจาก Google Sheets มายัง D1](#5-ย้ายข้อมูลเดิมจาก-google-sheets-มายัง-d1)
6. [เปิดใช้งานจอมอนิเตอร์](#6-เปิดใช้งานจอมอนิเตอร์)
7. [ตั้งค่าโดเมนของคุณเอง](#7-ตั้งค่าโดเมนของคุณเอง)
8. [แก้ปัญหาที่พบบ่อย](#8-แก้ปัญหาที่พบบ่อย)
9. [ข้อจำกัดของแผนฟรี](#9-ข้อจำกัดของแผนฟรี)

---

## 1. ภาพรวม — ระบบนี้คืออะไร

ระบบเดิมเป็นเว็บที่ทำงานบน **Google Apps Script** และเก็บข้อมูลใน
**Google Sheets** เวอร์ชันนี้เปลี่ยนแค่ "ที่อยู่ของเซิร์ฟเวอร์" แต่หน้าตาและ
การทำงานเหมือนเดิมทุกอย่าง

| ส่วน | เดิม (Google) | ใหม่ (Cloudflare) |
|---|---|---|
| หน้าเว็บ | Apps Script Web App | **Cloudflare Pages** (ไฟล์ HTML จากโฟลเดอร์ `public/`) |
| เซิร์ฟเวอร์ API | Apps Script `doPost()` | **Pages Functions** (โฟลเดอร์ `functions/`) |
| ฐานข้อมูล | Google Sheets (18 ชีต) | **Cloudflare D1** (SQLite, 18 ตาราง) |
| ค่าใช้จ่าย | ฟรี (ตามโควตาของ Google) | **ฟรี** (ตามโควตาของ Cloudflare) |

```
ผู้ใช้งาน (เบราว์เวอร์ / จอมอนิเตอร์)
        │
        │  index.html  (หน้าเดียวเหมือนเดิมทุกประการ)
        ▼
┌──────────────────────────────────────────────┐
│  Cloudflare Pages  (ssms.pages.dev)          │
│                                               │
│   /            → index.html (หน้าเว็บ)       │
│   /api         → Pages Function (ตัวรับคำสั่ง)│
│                                               │
│   ┌─────────────────────────────────────────┐ │
│   │  functions/_lib/*.js                    │ │
│   │   auth · directory · roster             │ │
│   │   attendance · reports · migrate        │ │
│   │   db · util · context · routes          │ │
│   └───────────────┬─────────────────────────┘ │
└───────────────────┼──────────────────────────┘
                    │  SQL
┌───────────────────▼──────────────────────────┐
│  Cloudflare D1  (ฐานข้อมูล SQLite)           │
│   users · students · teachers · classrooms    │
│   subjects · attendance_* · class_rosters     │
│   teacher_leaves · announcements · settings   │
│   monitor_settings · audit_logs · sessions    │
└──────────────────────────────────────────────┘
```

---

## 2. สิ่งที่ต้องมีก่อน

- [ ] บัญชี **Cloudflare** (ฟรี) — [dash.cloudflare.com](https://dash.cloudflare.com)
- [ ] บัญชี **GitHub** (ฟรี) — [github.com](https://github.com) *(ต้องการสำหรับวิธีติดตั้งแบบไม่ใช้ Terminal)*
- [ ] เบราว์เวอร์ (Chrome / Edge / Firefox รุ่นปัจจุบัน)
- [ ] (ถ้าต้องการย้ายข้อมูล) ระบบเดิมบน Google Apps Script ที่ยังใช้งานอยู่

> 💡 **ทำไมต้องใช้ GitHub?**
> Pages ต้องการ "ที่เก็บโค้ด" เพื่อ deploy อัตโนมัติ วิธีนี้คือการดันโค้ดขึ้น
> GitHub แล้วเชื่อมกับ Cloudflare — แก้โค้ดแล้ว push ก็ขึ้นเว็บใหม่เองอัตโนมัติ

---

## 3. ติดตั้งแบบไม่ต้องใช้ Terminal (แนะนำ)

ทำตาม 6 ขั้นตอนนี้ ใช้เวลาประมาณ **20-30 นาที**

### ขั้นตอนที่ 1 — อัปโหลดโค้ดขึ้น GitHub

1. เปิด [github.com/new](https://github.com/new)
2. ตั้งชื่า repository เช่น `ssms` (ต้องเป็นชื่อสากล เช่น `ssms-school`)
3. เลือก **Private** (แนะนำ) หรือ Public
4. กด **Create repository**
5. กดไฟล์ลิงก์ **"uploading an existing file"**
6. เปิดโฟลเดอร์ `v4-cloudflare` บนเครื่องคุณ แล้วลากทั้งโฟลเดอร์ลงในหน้าเว็บ
   - ถ้าลากโฟลเดอร์ไม่ได้ ให้กด **choose your files** แล้วเลือกไฟล์ทีละโฟลเดอร์
     (ทำซ้ำจนครบทุกโฟลเดอร์: `functions`, `public`, `schema`, `tools`, `docs`)
7. กด **Commit changes**

> ตรวจสอบว่าไฟล์ `public/index.html` และ `functions/api/[[path]].js` อยู่ในรากของ repository

### ขั้นตอนที่ 2 — สร้างฐานข้อมูล D1

1. เปิด [dash.cloudflare.com](https://dash.cloudflare.com) → เลือกบัญชีของคุณ
2. ทางเมนูด้านซ้าย กด **Storage & Databases** → **D1 SQL Database**
3. กด **Create database**
4. ตั้งชื่อ `ssms` → กด **Create**
5. **คัดลอก Database ID** ไว้ (จะต้องใช้ตอนสร้าง Pages)

### ขั้นตอนที่ 3 — สร้างตารางในฐานข้อมูล

1. ยังอยู่ในหน้า D1 เดิม กดแท็บ **Console**
2. เปิดไฟล์ `schema/001_schema.sql` จากโฟลเดอร์ในเครื่องของคุณ
3. คัดลอก **ทั้งไฟล์** แล้ววางลงในช่อง Console
4. กด **Execute**

> ⏱️ รอสักครู่ แล้วตารางทั้ง 18 ตารางจะถูกสร้าง
> ตรวจสอบได้ว่าสำเร็จโดยกดดูรายการตารางในแท็บ **Tables**

### ขั้นตอนที่ 4 — สร้างโปรเจกต์ Pages

1. ทางเมนูด้านซ้าย กด **Compute (Workers)** → **Workers & Pages**
2. กด **Create application** → เลือก **Pages** → กด **Get started**
3. เลือก **Connect to Git** แล้วเลือกบัญชี GitHub ของคุณ
4. เลือก repository ที่อัปโหลดไว้ → กด **Select repository**
5. ตั้งค่า Build:
   | ช่อง | ค่า |
   |---|---|
   | **Framework preset** | `None` |
   | **Build command** | `exit 0` |
   | **Build output directory** | `public` |
   | **Root directory** | *(ดูหมายเหตุด้านล่าง)* |

   > **ทำไม build command เป็น `exit 0`?**
   > เว็บนี้ไม่ต้อง "build" อะไรเลย (เป็น HTML ธรรมดา) และ Cloudflare จะ
   > **compile โฟลเดอร์ `functions/` ให้เองโดยอัตโนมัติ** เมื่อใช้ Git integration
   > (ตามคำแนะนำทางการของ Cloudflare: *"Cloudflare recommends using `exit 0`
   > as your Build command to access features such as Pages Functions"*)
   >
   > ❌ **อย่าใช้** `npx wrangler pages deploy public` เป็น build command
   > คำสั่งนั้นเป็นวิธีของ *Direct Upload* และจะล้มเหลวด้วย
   > `Authentication error [code: 10000]` เพราะ build environment ไม่มี
   > API Token ที่มีสิทธิ์ Pages:Edit

   > **Root directory**
   > โฟลเดอร์ `functions/` ต้องอยู่ที่ **รากของ repository** (ไม่ใช่ซ่อนอยู่ใน
   > subfolder) เพราะ Cloudflare มองหาโฟลเดอร์นี้ที่รากเสมอ
   > - ถ้าคุณอัปโหลด **เนื้อหา** ของ `v4-cloudflare/` ไว้ที่ราก repository
   >   (มี `public/` และ `functions/` อยู่ระดับเดียวกัน) → **เว้น Root directory ว่าง**
   > - ถ้าคุณอัปโหลดทั้งโฟลเดอร์ `v4-cloudflare/` ไว้ใน repository → ตั้ง
   >   **Root directory** = `v4-cloudflare`

6. กด **Save and Deploy**
7. รอสัก 2-5 นาที จนขึ้นข้อความว่า **Deployment successful**
8. จะได้ที่อยู่เว็บ เช่น `https://ssms-school.pages.dev` — **จดไว้**


> 💡 **ทำไมมีไฟล์ `public/_routes.json`?**
> ไฟล์นี้บอก Cloudflare ว่า "เรียก Function เฉพาะเส้นทาง `/api` เท่านั้น"
> ที่เหลือ (หน้าเว็บ, CSS, รูป) เป็น static asset ซึ่ง **ฟรีและไม่จำกัด**
> ถ้าไม่มีไฟล์นี้ ทุก request (รวมที่เปิดหน้าเว็บ) จะไปเรียก Function
> และกินโควตา 100,000 request/วันของ Workers ไปเปล่าๆ

### ขั้นตอนที่ 5 — ผูกฐานข้อมูล D1 กับโปรเจกต์

1. กลับไปที่หน้า **Workers & Pages** → คลิกโปรเจกต์ `ssms` ของคุณ
2. ไปที่แท็บ **Settings** → **Bindings** → กด **Add** → **D1 database**
3. ตั้งค่า:
   | ช่อง | ค่า |
   |---|---|
   | **Variable name** | `DB` (ต้องเป็น `DB` เป๊ะ ๆ) |
   | **D1 database** | เลือก `ssms` ที่สร้างไว้ |
4. กด **Save and deploy**

### ขั้นตอนที่ 6 — ตั้งคีย์นำเข้าข้อมูล (สำคัญมาก)

คีย์นี้คือ "กุญแจ" ที่ใช้ย้ายข้อมูลเข้าระบบ — ถ้าไม่ตั้ง ใครก็ตามย้ายข้อมูลเข้าได้

1. ที่หน้าโปรเจกต์ → แท็บ **Settings** → **Environment variables**
2. กด **Add** → ตั้งค่า:
   | ช่อง | ค่า |
   |---|---|
   | **Variable name** | `IMPORT_KEY` |
   | **Value** | รหัสผ่านที่คุณคิดเอง เช่น `Ssm-2026-@x7Kp` |
   | **Type** | `Secret` (ถ้าเลือกได้) |
3. กด **Save and deploy**
4. **จดค่านี้ไว้** — ต้องใช้ตอนย้ายข้อมูล

### ขั้นตอนที่ 7 — ทดสอบว่าติดตั้งสำเร็จ

เปิดในเบราว์เวอร์:

```
https://ssms-school.pages.dev/api/health
```

จะเห็นผลลัพธ์แบบนี้ (ถ้าได้ แปลว่าทุกอย่างเชื่อมต่อถูกต้อง):

```json
{
  "ok": true,
  "data": {
    "app": "SSMS on Cloudflare",
    "database": "connected",
    "users": 2
  }
}
```

จากนั้นเปิด `https://ssms-school.pages.dev` จะเห็นหน้าเข้าสู่ระบบ

**บัญชีเริ่มต้น (เปลี่ยนทันที!):**

| ชื่อผู้ใช้ | รหัสผ่าน | บทบาท |
|---|---|---|
| `admin` | `admin123` | Super Admin (สิทธิ์สูงสุด) |
| `admin` | `admin123` | Admin |

> 🔐 **เข้าแล้วเปลี่ยนรหัสผ่านทันที** ที่หน้า *ตั้งค่าระบบ → เปลี่ยนรหัสผ่าน*

---

## 4. ติดตั้งแบบใช้ Wrangler (ทางเลือก)

วิธีนี้ควบคุมได้ละเอียดกว่า แต่ต้องมี Node.js ในเครื่อง

### 4.1 ติดตั้ง Node.js

1. ดาวน์โหลดจาก [nodejs.org](https://nodejs.org) (เลือกเวอร์ชัน **LTS**)
2. ติดตั้งแล้วเปิด PowerShell ใหม่ พิมพ์:
   ```powershell
   node -v
   ```
   ถ้าเห็นเลขเวอร์ชัน แปลว่าสำเร็จ

### 4.2 ติดตั้งและ deploy

```powershell
cd "D:\ปอเนาะปายอ\แจ้งขึ้นจอ Minimax\v4-cloudflare"

# เข้าสู่ระบบ Cloudflare (เปิดเบราว์เวอร์ขึ้นมายืนยันตัวตน)
npx wrangler login

# สร้างฐานข้อมูล D1 (ถ้ายังไม่ได้สร้างในขั้นตอนที่ 2)
npx wrangler d1 create ssms
#    -> จะได้ database_id กลับมา ให้จดไว้

# สร้างตารางทั้งหมด
npx wrangler d1 execute ssms --file=./schema/001_schema.sql --remote

# ตั้งค่าคีย์นำเข้าข้อมูล
npx wrangler pages secret put IMPORT_KEY
#    -> พิมพ์รหัสที่คุณตั้งเอง แล้วกด Enter

# deploy
npx wrangler pages deploy public
```

### 4.3 ผูกฐานข้อมูล D1 (เฉพาะวิธีใช้ Wrangler)

วิธีนี้ต้องมีไฟล์ `wrangler.toml` ที่รากโปรเจกต์ เพื่อบอกว่า D1 ตัวไหนถูกใช้
มีตัวอย่างเตรียมไว้ใน `docs/wrangler.example.toml` — คัดลอกมาแล้วแก้ `database_id`

```powershell
copy docs\wrangler.example.toml wrangler.toml
# แก้ database_id ในไฟล์ wrangler.toml ให้เป็นของคุณ แล้ว deploy อีกครั้ง
npx wrangler pages deploy public
```

> 💡 ถ้าใช้วิธีของขั้นตอนที่ 3 (Git integration) **ไม่ต้องมีไฟล์นี้**
> เพราะจะผูกฐานข้อมูลผ่านหน้า Settings ในหน้าเว็บ Cloudflare แทน

---

## 5. ย้ายข้อมูลเดิมจาก Google Sheets มายัง D1

ถ้าระบบเดิมของคุณยังมีข้อมูลอยู่ (นักเรียน ครู การเข้าเรียน ประกาศ)
ให้ทำตามขั้นตอนนี้เพื่อย้ายข้อมูลมาทั้งหมด

### 5.1 ส่งออกข้อมูลจากระบบเดิม

1. เปิด [script.google.com](https://script.google.com) → เปิดโปรเจกต์เดิมของ SSMS
2. กด **+** ข้าง Files → **Script** → ตั้งชื่อ `ExportData`
3. เปิดไฟล์ `tools/migrate/export-from-sheets.gs` จากเครื่องคุณ
   แล้วคัดลอกทั้งไฟล์มาวาง (ทับไฟล์ว่าง)
4. แก้ 2 บรรทัดบนสุดของไฟล์ให้ถูกต้อง:
   ```javascript
   var SSMS_API_URL = 'https://ssms-school.pages.dev';   // ที่อยู่เว็บของคุณ
   var SSMS_API_KEY = 'Ssm-2026-@x7Kp';                   // คีย์ที่ตั้งในขั้นตอนที่ 6
   ```
5. กด **Save** (💾) แล้วกด **Run** ที่ฟังก์ชัน **exportSheetsJson**
6. Google จะขออนุญาต (ครั้งแรก) — กด **Review permissions** → เลือกบัญชี
   → **Advanced** → **Go to ExportData (unsafe)** → **Allow**
7. เมื่อเสร็จ จะเปิดหน้าจอพร้อมลิงก์ดาวน์โหลดไฟล์ `.json` — **ดาวน์โหลดไว้**

> 💡 **ทางเลือกที่เร็วกว่า:** ถ้ามีไฟล์ JSON อยู่แล้ว ให้ข้ามขั้นตอนนี้แล้วไปที่ 5.2

### 5.2 นำเข้าข้อมูลเข้า D1

**วิธีที่ 1 — ผ่าน API โดยตรง (แนะนำ)**

เปิด PowerShell ในโฟลเดอร์ที่มีไฟล์ JSON แล้วรัน
(แก้ URL และ KEY ให้เป็นของคุณ):

```powershell
$body = Get-Content .\ssms_export_20261124_180000.json -Raw | ConvertFrom-Json
$payload = @{
  action  = "database.importLegacy"
  payload = @{
    key  = "Ssm-2026-@x7Kp"
    data = $body
  }
} | ConvertTo-Json -Depth 20

Invoke-RestMethod -Uri "https://ssms-school.pages.dev/api" `
  -Method Post -ContentType "application/json" -Body $payload
```

ผลลัพธ์จะเป็น JSON ที่บอกว่านำเข้ากี่แถว ของแต่ละตาราง

**วิธีที่ 2 — ผ่านหน้าเว็บ**

1. เข้าสู่ระบบเว็บใหม่
2. ไปที่หน้า **ตั้งค่าระบบ** → หัวข้อ **ฐานข้อมูล**
3. กด **นำเข้าข้อมูลจากระบบเดิม** → อัปโหลดไฟล์ `.json`
4. พิมพ์คีย์นำเข้าข้อมูล → กด **นำเข้า**

> 💡 ข้อมูลการเข้าเรียนรูปแบบเก่า (ชีต `Attendance_Homeroom` / `Religious` /
> `General` ที่เก็บทีละนักเรียน) จะถูก**แปลงเป็นรูปแบบบีบอัดให้อัตโนมัติ**
> ระบบเดิมใช้รูปแบบบีบอัดอยู่แล้ว จึงไม่ต้องทำอะไรเพิ่ม

### 5.3 ตรวจสอบผล

- เข้าสู่ระบบ → ดูจำนวนนักเรียนในเมนู **ข้อมูลพื้นฐาน → นักเรียน**
- ตรวจสอบว่าหน้า **เช็คชื่อ** และ **จอมอนิเตอร์** แสดงข้อมูลของวันที่ย้ายมา
- ตรวจสอบ **สถิติการเข้าเรียน** ว่าตัวเลขตรงกับระบบเดิม

> 🔑 **รหัสผ่านเดิมใช้ได้ต่อ** เพราะวิธีเข้ารหัสถูกทำให้เหมือนเดิมทุกประการ

---

## 6. เปิดใช้งานจอมอนิเตอร์

จอมอนิเตอร์คือหน้าจอแสดงข้อมูลของวันนี้ (นักเรียนขาดเรียน ครูลา ประกาศ)
ที่ติดตั้งบนจอใหญ่ในห้องเรียน

1. เข้าสู่ระบบด้วยบัญชี Super Admin → หน้า **ตั้งค่าระบบ**
2. หาเมนู **จอมอนิเตอร์** → จะเห็น **ลิงก์จอมอนิเตอร์** พร้อมรหัสเข้าถึง
   เช่น `https://ssms-school.pages.dev/?view=monitor&key=MON-XXXXXXXXXXXX`
3. **คัดลอกลิงก์นี้** ไปเปิดบนจอมอนิเตอร์ (Chromecast / Android TV / คอมพิวเตอร์)
4. จอจะแสดงข้อมูลอัตโนมัติและรีเฟรชทุก 10 วินาที
5. ปรับเทมเพลต ความเร็ว จำนวนรายการ ได้ที่หน้าเดียวกัน

> 💡 เปิดแบบเต็มจอ: กด `F11` (Windows) หรือ `Cmd + Ctrl + F` (macOS)

---

## 7. ตั้งค่าโดเมนของคุณเอง

ถ้าคุณมีโดเมนอยู่แล้ว (เช่น `school.ac.th`) สามารถชี้มาที่เว็บนี้ได้

1. โปรเจกต์ Pages → แท็บ **Custom domains**
2. กด **Set up a custom domain**
3. พิมพ์โดเมน เช่น `ssms.school.ac.th` → กด **Continue**
4. Cloudflare จะสร้าง DNS record ให้อัตโนมัติ (ถ้าโดเมนอยู่ใน Cloudflare)
5. รอสัก 5-10 นาทีให้ SSL certificate ออก

> ถ้าลิงก์จอมอนิเตอร์ชี้ไปที่โดเมนเดิม ให้เข้าไปที่หน้าตั้งค่าแล้วกด
> **บันทึกอีกครั้ง** เพื่อให้ URL ใหม่ถูกใช้

---

## 8. แก้ปัญหาที่พบบ่อย

### ❌ หน้าเว็บขึ้น "Error 1101 Worker threw exception"

**สาเหตุ:** โค้ดมี error

**แก้:**
1. Pages → โปรเจกต์ของคุณ → แท็บ **Deployments**
2. คลิก deployment ล่าสุด → **View build** / **Runtime logs**
3. ดูข้อความ error ที่ขึ้น
4. แก้โค้ดใน GitHub → push → Cloudflare deploy ใหม่เอง

### ❌ หน้าเว็บขึ้น "D1_ERROR" หรือ "database not found"

**สาเหตุ:** ยังไม่ได้ผูกฐานข้อมูล

**แก้:** Pages → Settings → Bindings → เพิ่ม D1 database
ชื่อตัวแปรต้องเป็น **`DB`** (พิมพ์ใหถูกตัว ไม่มีช่องว่าง)

### ❌ เรียก API แล้วได้ `DATABASE_ERROR: no such table: users`

**สาเหตุ:** ยังไม่ได้สร้างตาราง

**แก้:** D1 → `ssms` → แท็บ **Console** → วางเนื้อหาไฟล์
`schema/001_schema.sql` → กด **Execute**

### ❌ Deploy ล้มเหลว — "Authentication error [code: 10000]"

**อาการ** (จากหน้า Deployments):
```
✘ [ERROR] A request to the Cloudflare API (/accounts/xxx/pages/projects/ssms) failed.
  Authentication error [code: 10000]
  📎 It looks like you are authenticating Wrangler via a custom API token set in an environment variable.
```

**สาเหตุ:** ตั้ง **Build command** เป็น `npx wrangler pages deploy public`
คำสั่งนี้เป็นวิธีของ *Direct Upload* ไม่ใช่ Git integration — ตัว build
environment ของ Cloudflare ไม่มี API Token ที่มีสิทธิ์ Pages:Edit จึงถูกปฏิเสธ

**แก้:** เปลี่ยน Build command เป็น `exit 0` แล้ว deploy ใหม่

| ช่อง | ค่าที่ถูกต้อง |
|---|---|
| Framework preset | `None` |
| **Build command** | **`exit 0`** |
| Build output directory | `public` |

> เมื่อใช้ `exit 0` Cloudflare จะ compile โฟลเดอร์ `functions/` ให้เองโดยอัตโนมัติ
> ไม่ต้องเรียก wrangler เอง

**ถ้ายังไม่ได้** แปลว่ามีอีกเรื่องหนึ่ง — ให้ตรวจ:
1. **Root directory** ตรงกับโครงสร้าง repository ไหม
   (ดูหัวข้อ 3 ขั้นตอนที่ 4)
2. โฟลเดอร์ `functions/` อยู่ที่ราก repository หรือไม่
   (ถ้าซ่อนอยู่ใน subfolder Cloudflare จะมองไม่เจอ → API จะไม่ทำงาน)

### ❌ เข้าสู่ระบบไม่ได้ — "ไม่พบผู้ใช้งานนี้ในระบบ"
**สาเหตุ:** ฐานข้อมูลยังไม่มีบัญชีเริ่มต้น (มักเกิดเมื่อยังไม่ได้สร้างตาราง)

**แก้:** เปิด `https://ssms-school.pages.dev/api/health`
- ถ้า `users` เป็น `0` ให้ลองเปิดหน้าเว็บหลัก 1 ครั้ง (ระบบจะสร้างบัญชีเริ่มต้นให้อัตโนมัติ)
- ถ้ายังไม่ได้ ให้รันใน D1 Console:
  ```sql
  INSERT INTO users (user_id, username, password_hash, salt, full_name, role, status, created_at, updated_at)
  VALUES ('USR-0001', 'admin', 'ดูค่าด้านล่าง', 'salt123', 'ผู้ดูแลระบบ', 'SUPER_ADMIN', 'ACTIVE', '', '');
  ```
  แล้วใช้หน้า *เปลี่ยนรหัสผ่าน* เพื่อตั้งรหัสใหม่

### ❌ หน้าจอมอนิเตอร์ขึ้น "ไม่สามารถโหลดข้อมูลได้"

**สาเหตุ:** รหัสเข้าถึงไม่ตรง หรือ browser บล็อกการเรียก API

**แก้:**
1. ตรวจสอบว่าลิงก์มี `?view=monitor&key=...` ครบ
2. ดูว่า `/api/health` ใช้งานได้
3. ลองเปิดลิงก์ในหน้าต่างปกติ (ไม่ใช่โหมดเต็มจอ) ดูว่ามี error อะไรใน console

### ❌ ข้อมูลเข้าเรียนเก่าไม่ปรากฏ

**สาเหตุ:** ข้อมูลรูปแบบเก่า (ทีละนักเรียน) ยังไม่ถูกแปลง

**แก้:** ระบบแปลงให้อัตโนมัติตอนนำเข้า ถ้ายังไม่ครบ ให้นำเข้าไฟล์ JSON อีกครั้ง
(ระบบจะข้ามแถวที่มีอยู่แล้ว ไม่เขียนทับ)

### ✅ ตรวจสอบว่าทุกอย่างทำงาน

```powershell
# ตรวจสอบ API
curl https://ssms-school.pages.dev/api/health

# ตรวจสอบตารางในฐานข้อมูล
npx wrangler d1 execute ssms --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

---

## 9. ข้อจำกัดของแผนฟรี

แผนฟรีของ Cloudflare มีข้อจำกัดที่ควรทราบ:

| ทรัพยากร | โควตาฟรี | หมายเหตุ |
|---|---|---|
| **D1 — rows read** | 5,000,000 / วัน | ระบบมี cache อัตโนมัติ (ชีตที่ไม่เปลี่ยนบ่อย + หน้าจอมอนิเตอร์ 120 วินาที) |
| **D1 — rows written** | 100,000 / วัน | เพียงพอมากสำหรับโรงเรียนหนึ่งแห่ง |
| **D1 — ขนาดฐานข้อมูล** | 500 MB | เพียงพอมาก |
| **Pages — จำนวน request** | ไม่จำกัด | เว็บ static ฟรี |
| **Workers — request** | 100,000 / วัน | API ทุกครั้งที่หน้าเว็บเรียก |
| **Workers — CPU time** | 10 ms / request | ระบบนี้ทำงานเสร็จในเวลาไม่กี่มิลลิวินาที |

**ข้อควรระวัง:** จอมอนิเตอร์ที่เปิดหลายจอพร้อมกันจะสร้าง request ประมาณ
1 ครั้งทุก 10 วินาทีต่อจอ (≈8,640 request/วัน/จอ) หากมีหลายจอควรเพิ่ม
`PollIntervalSeconds` ในหน้าตั้งค่าจอมอนิเตอร์ (ค่าต่ำสุด 5 วินาที)

---

## โครงสร้างไฟล์ในโฟลเดอร์นี้

```
v4-cloudflare/
├── public/
│   ├── index.html              หน้าเว็บ (เหมือนเดิมทุกประการ)
│   └── _routes.json            กำกับว่า request ไหนต้องผ่าน Function
│
├── functions/                  Pages Functions
│   ├── api/
│   │   ├── index.js            ตัวรับ POST /api
│   │   └── [[path]].js         ตัวรับ /api/* (รวม /api/health)
│   └── _lib/
│       ├── constants.js        ค่าคงที่ทั้งหมด (เหมือนเดิม)
│       ├── util.js             Utilities/CacheService ของ Apps Script
│       ├── db.js               ชั้นเชื่อมต่อฐานข้อมูล D1
│       ├── context.js          สิ่งที่ทุก handler ใช้
│       ├── handler.js          ตัวรับ request จริง
│       ├── routes.js           ตารางเส้นทาง API
│       ├── auth.js             เข้าสู่ระบบ ผู้ใช้ ตั้งค่า Audit
│       ├── directory.js        นักเรียน ครู ห้องเรียน วิชา
│       ├── roster.js           รายชื่อนักเรียนในห้อง (ข้อมูลแบบบีบอัด)
│       ├── attendance.js       เช็คชื่อ สถิติ โดดเรียน
│       ├── leaves.js           การลาครู
│       ├── reports.js          ประกาศ จอมอนิเตอร์ แดชบอร์ด รายงาน Excel
│       └── migrate.js          นำเข้าข้อมูลจากระบบเดิม
│
├── schema/
│   └── 001_schema.sql         โครงสร้างตารางทั้ง 18 ตาราง
│
├── tools/
│   ├── migrate/
│   │   └── export-from-sheets.gs   สคริปต์ส่งออกข้อมูลจาก Google Sheets
│   ├── verify.ps1               ตรวจสอบความถูกต้องของโค้ด (ใช้ได้ทันที)
│   ├── check-schema.ps1         ตรวจว่าคอลัมน์ในโค้ดตรงกับฐานข้อมูล
│   ├── patch_frontend.py        สร้าง frontend จากต้นฉบับ
│   └── verify.py / fix-await.sh  รุ่นสำรองสำหรับเครื่องที่มี Python / bash
│
├── docs/
│   ├── PORTING-CONTRACT.md     สัญญาการพอร์ต (สำหรับผู้พัฒนา)
│   └── wrangler.example.toml   ตัวอย่างไฟล์ตั้งค่า Wrangler (สำหรับวิธีข้อ 4)
│
└── README.md                   คู่มือนี้
```

### ตรวจสอบโค้ดก่อน deploy

```powershell
# ตรวจวงเล็บ, action ที่ครบ, ฟังก์ชันที่หาย, ค่าคงที่ และข้อความภาษาไทย
powershell -ExecutionPolicy Bypass -File tools\verify.ps1

# ตรวจว่าคอลัมน์ในโค้ดตรงกับตารางในฐานข้อมูล
powershell -ExecutionPolicy Bypass -File tools\check-schema.ps1
```

ผลที่คาดหวัง: **ผ่านทั้งหมด** ทุกครั้ง

---

## หากต้องการความช่วยเหลือเพิ่มเติม

| ปัญหา | ตรวจสอบที่ |
|---|---|
| API ไม่ตอบ | `https://your-site.pages.dev/api/health` |
| ดู log การทำงาน | Pages → โปรเจกต์ → **Deployments** → deployment ล่าสุด → **Runtime logs** |
| ดูข้อมูลในฐานข้อมูล | D1 → `ssms` → **Console** |
| ดูว่าโค้ด deploy สำเร็จไหม | Pages → **Deployments** → ดูสถานะล่าสุด |
| แก้โค้ดแล้วขึ้นเว็บใหม่ | แก้ใน GitHub → **Commit changes** (รอ deploy 2-5 นาที) |
