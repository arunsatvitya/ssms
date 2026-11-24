#!/usr/bin/env bash
# หาและแก้ "await หาย" ในโค้ดที่พอร์ตมา
# รัน:  bash tools/fix-await.sh
set -u
cd "$(dirname "$0")/.." || exit 1

# ฟังก์ชันที่คืน Promise และต้องมี await
ASYNC_FUNCS="ctx\.requirePermission|ctx\.requireSession|ctx\.logAudit|ctx\.bumpDataVersion|ctx\.currentDataVersion|ctx\.cacheGet|ctx\.cachePut|ctx\.cacheRemove|ctx\.clearCache|readTable|readKeyValue|writeKeyValue|upsertRows|deleteRowsByKey|updateCellByKey|countRows|readRowsByDate|readRowsByDateRange|hashPassword_|verifyPassword_|sha256_|requirePermission\(|requireSession\("

for f in functions/_lib/*.js functions/api/*.js; do
  [ -f "$f" ] || continue
  echo "=== $f ==="
  # หาแถวที่เรียกฟังก์ชัน async โดยไม่มี await และไม่ได้อยู่หลัง return
  grep -nE "($ASYNC_FUNCS)" "$f" \
    | grep -vE "await " \
    | grep -vE "^\s*[0-9]+:\s*(//|\*|/\*)" \
    | grep -vE "(async )?function " \
    | grep -vE "return " \
    | grep -vE "^\s*[0-9]+:\s*(export )?(async )?function" \
    || echo "  (ไม่พบ)"
done
