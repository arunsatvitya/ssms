<#
.SYNOPSIS
    ตัวตรวจสอบความถูกต้องของการพอร์ต SSMS ไป Cloudflare (ไม่ต้องมี Node.js)

.DESCRIPTION
    ตรวจสอบ 4 อย่าง:
      1. วงเล็บ/เครื่องหมายทั้งหมดสมดุล (syntax ของไฟล์ JS)
      2. ทุก action ใน API_ROUTES มี handler ที่ export จริง
      3. ทุกชื่อฟังก์ชันที่ถูกเรียก มีการนิยามไว้
      4. ค่าคงที่ใน constants.js ตรงกับต้นฉบับ Code.gs

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\verify.ps1
#>

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Funcs = Join-Path $Root 'src'
$Orig = Join-Path (Split-Path -Parent $Root) 'v3-compact\Code.gs'

$script:Errors = @()
$script:Warnings = @()

function Write-Err($msg) {
    $script:Errors += $msg
    Write-Host "ERROR $msg" -ForegroundColor Red
}
function Write-Warn($msg) {
    $script:Warnings += $msg
    Write-Host "WARN  $msg" -ForegroundColor Yellow
}
function Write-Ok($msg) {
    Write-Host "OK    $msg" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# ตัด comment และ string ออกจากโค้ด เพื่อนับวงเล็บให้แม่นยำ
# ---------------------------------------------------------------------------
function Remove-Code([string]$src) {
    $sb = New-Object System.Text.StringBuilder
    $i = 0
    $n = $src.Length
    while ($i -lt $n) {
        $c = $src[$i]
        $two = if ($i + 1 -lt $n) { $src.Substring($i, 2) } else { '' }
        if ($two -eq '//') {
            $j = $src.IndexOf("`n", $i)
            if ($j -lt 0) { break }
            $i = $j
            continue
        }
        if ($two -eq '/*') {
            $j = $src.IndexOf('*/', $i + 2)
            if ($j -lt 0) { break }
            # แทนที่ comment ด้วยช่องว่าง แต่เก็บจำนวนบรรทัดไว้ให้ตรง
            $segment = $src.Substring($i, $j + 2 - $i)
            $nl = ($segment -split "`n").Count - 1
            for ($k = 0; $k -lt $nl; $k++) { [void]$sb.Append("`n") }
            $i = $j + 2
            continue
        }
        if ($two -eq '//') {
            $j = $src.IndexOf("`n", $i)
            if ($j -lt 0) { break }
            $i = $j
            continue
        }
        if ($c -eq '/' -and $i + 1 -lt $n) {
            # ตรวจว่าเป็น regex literal หรือไม่ (อักขระก่อนหน้าต้องไม่ใช่ตัวอักษร)
            $prev = if ($i -gt 0) { $src[$i - 1] } else { ' ' }
            $isRegex = -not ($prev -match '[A-Za-z0-9_\)\]''" ]')
            if ($isRegex) {
                $j = $i + 1
                $inClass = $false
                while ($j -lt $n) {
                    if ($src[$j] -eq '\') { $j += 2; continue }
                    if ($src[$j] -eq '[') { $inClass = $true }
                    elseif ($src[$j] -eq ']') { $inClass = $false }
                    elseif ($src[$j] -eq '/' -and -not $inClass) { break }
                    elseif ($src[$j] -eq "`n") { break }
                    $j++
                }
                if ($j -lt $n -and $src[$j] -eq '/') {
                    # regex literal - แทนที่ด้วยช่องว่าง
                    $seg = $src.Substring($i, $j + 1 - $i)
                    $nl = ($seg -split "`n").Count - 1
                    for ($k = 0; $k -lt $nl; $k++) { [void]$sb.Append("`n") }
                    [void]$sb.Append('RE')
                    $i = $j + 1
                    continue
                }
            }
        }
        if ($c -eq '"' -or $c -eq "'" -or $c -eq '`') {
            $quote = $c
            $i++
            while ($i -lt $n) {
                if ($src[$i] -eq '\') { $i += 2; continue }
                if ($src[$i] -eq $quote) { $i++; break }
                # เก็บจำนวนบรรทัดที่อยู่ใน string ไว้ เพื่อให้เลขบรรทัดตรง
                if ($src[$i] -eq "`n") { [void]$sb.Append("`n") }
                $i++
            }
            # แทนที่ string ด้วยช่องว่าง เพื่อไม่ให้วงเล็บข้างในถูกนับ
            [void]$sb.Append('""')
            continue
        }
        [void]$sb.Append($c)
        $i++
    }
    return $sb.ToString()
}
function Get-RelPath([string]$p) {
    return $p.Substring($Root.Length + 1).Replace('\', '/')
}

# ---------------------------------------------------------------------------
# 1. ตรวจวงเล็บ
# ---------------------------------------------------------------------------
function Test-Balance([string]$path) {
    $src = [System.IO.File]::ReadAllText($path)
    $code = Remove-Code $src
    $stack = New-Object System.Collections.ArrayList
    $pairs = @{ ')' = '('; ']' = '['; '}' = '{' }
    $line = 1
    foreach ($ch in $code.ToCharArray()) {
        $c = [string]$ch
        if ($c -eq "`n") { $line++; continue }
        if ($c -eq '(' -or $c -eq '[' -or $c -eq '{') {
            [void]$stack.Add(@($c, $line))
            continue
        }
        if ($c -eq ')' -or $c -eq ']' -or $c -eq '}') {
            if ($stack.Count -eq 0) {
                Write-Err "$(Get-RelPath $path): วงเล็บปิดเกิน (บรรทัด $line)"
                return
            }
            $top = $stack[$stack.Count - 1]
            [void]$stack.RemoveAt($stack.Count - 1)
            if ([string]$top[0] -ne [string]$pairs[$c]) {
                Write-Err "$(Get-RelPath $path): '$($top[0])' (บรรทัด $($top[1])) ถูกปิดด้วย '$c' (บรรทัด $line)"
                return
            }
        }
    }
    if ($stack.Count -gt 0) {
        $top = $stack[$stack.Count - 1]
        Write-Err "$(Get-RelPath $path): ไม่ได้ปิด '$($top[0])' (เปิดบรรทัด $($top[1]))"
        return
    }
    Write-Ok "$(Get-RelPath $path) - วงเล็บสมดุล"
}

# ---------------------------------------------------------------------------
# เก็บชื่อที่ถูก define ในไฟล์ JS
# ---------------------------------------------------------------------------
function Get-DefinedNames([string]$path) {
    $src = [System.IO.File]::ReadAllText($path)
    $names = New-Object System.Collections.ArrayList
    $patterns = @(
        'export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)',
        'export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)',
        'export\s*\{([^}]*)\}',
        '(?:^|\s)function\s+([A-Za-z_$][\w$]*)',
        '(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*='
    )
    foreach ($pat in $patterns) {
        foreach ($m in [regex]::Matches($src, $pat, [System.Text.RegularExpressions.RegexOptions]::Multiline)) {
            for ($gi = 1; $gi -lt $m.Groups.Count; $gi++) {
                $v = $m.Groups[$gi].Value.Trim()
                if ($v -eq '') { continue }
                if ($v -match '\s+as\s+') { $v = ($v -split '\s+as\s+')[-1].Trim() }
                foreach ($part in $v.Split(',')) {
                    $part = $part.Trim()
                    if ($part -match '^[A-Za-z_$][\w$]*$' -and -not $names.Contains($part)) {
                        [void]$names.Add($part)
                    }
                }
            }
        }
    }
    return $names
}

function Get-JsFiles {
    $files = @()
    foreach ($f in Get-ChildItem -Path $Funcs -Recurse -Filter *.js -File) { $files += $f.FullName }
    return $files
}

# ---------------------------------------------------------------------------
# 2. API routes
# ---------------------------------------------------------------------------
function Test-Routes {
    $routePath = Join-Path $Funcs 'lib\routes.js'
    if (-not (Test-Path $routePath)) {
        Write-Err 'ไม่พบ src/lib/routes.js'
        return
    }
    $src = [System.IO.File]::ReadAllText($routePath)

    $origSrc = [System.IO.File]::ReadAllText($Orig)
    $origBlock = [regex]::Match($origSrc, 'API_ROUTES\s*=\s*\{(.*?)\n\};', 'Singleline')
    $newBlock = [regex]::Match($src, 'API_ROUTES\s*=\s*\{(.*?)\n\};', 'Singleline')
    if (-not $origBlock.Success) { Write-Err 'อ่าน API_ROUTES ของต้นฉบับไม่ได้'; return }
    if (-not $newBlock.Success) { Write-Err 'อ่าน API_ROUTES ของไฟล์ใหม่ไม่ได้'; return }

    $origRoutes = [regex]::Matches($origBlock.Groups[1].Value, "'([a-zA-Z][\w.]*)'\s*:") | ForEach-Object { $_.Groups[1].Value }
    $newRoutes = [regex]::Matches($newBlock.Groups[1].Value, "'([a-zA-Z][\w.]*)'\s*:") | ForEach-Object { $_.Groups[1].Value }

    $missing = $origRoutes | Where-Object { $newRoutes -notcontains $_ }
    $extra = $newRoutes | Where-Object { $origRoutes -notcontains $_ }
    if ($missing) { Write-Err "ขาด action $($missing.Count) รายการ: $($missing -join ', ')" }
    if ($extra) { Write-Warn "มี action เพิ่ม $($extra.Count) รายการ: $($extra -join ', ')" }
    if (-not $missing -and -not $extra) {
        Write-Ok "ครบทั้ง $($origRoutes.Count) actions"
    }

    # ตรวจว่า handler ที่อ้างถึงมีอยู่จริงในไฟล์โมดูล
    # รูปแบบ:  'action.name': (ctx, p) => module.function_(ctx, p),
    $defined = New-Object System.Collections.ArrayList
    foreach ($f in Get-JsFiles) {
        foreach ($n in (Get-DefinedNames $f)) { [void]$defined.Add($n) }
    }
    $refs = New-Object System.Collections.ArrayList
    foreach ($m in [regex]::Matches($newBlock.Groups[1].Value, '=>\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(')) {
        $name = $m.Groups[2].Value
        if (-not $refs.Contains($name)) { [void]$refs.Add($name) }
    }
    $badRefs = @()
    foreach ($r in $refs) { if (-not $defined.Contains($r)) { $badRefs += $r } }
    if ($badRefs) {
        Write-Err "route อ้างถึงฟังก์ชันที่ไม่มีอยู่: $($badRefs -join ', ')"
    } else {
        Write-Ok "ทุก handler ใน route มีอยู่จริง ($($refs.Count) ตัว)"
    }
}

# ---------------------------------------------------------------------------
# 3. ฟังก์ชันที่ถูกเรียกแต่ไม่มีการนิยาม
# ---------------------------------------------------------------------------
function Test-Calls {
    $files = Get-JsFiles
    $known = New-Object System.Collections.ArrayList
    foreach ($f in $files) {
        foreach ($n in (Get-DefinedNames $f)) { [void]$known.Add($n) }
        # ชื่อที่ import มา
        $src = [System.IO.File]::ReadAllText($f)
        foreach ($m in [regex]::Matches($src, 'import\s*\{([^}]*)\}\s*from')) {
            foreach ($part in $m.Groups[1].Value.Split(',')) {
                $part = $part.Trim()
                if ($part -match '\s+as\s+') { $part = ($part -split '\s+as\s+')[-1].Trim() }
                if ($part -match '^[A-Za-z_$][\w$]*$' -and -not $known.Contains($part)) {
                    [void]$known.Add($part)
                }
            }
        }
    }
    $builtin = @('Array','Boolean','Date','Error','JSON','Math','Number','Object','Promise','String',
        'RegExp','Map','Set','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent',
        'decodeURIComponent','require','console','crypto','TextEncoder','TextDecoder','URL',
        'URLSearchParams','Intl','globalThis','structuredClone','fetch','Response','Request','Headers',
        'caches','atob','btoa','setTimeout','clearTimeout','queueMicrotask','Blob','FormData',
        'WeakMap','WeakSet','Symbol','Proxy','Reflect','ArrayBuffer','DataView','BigInt',
        'Uint8Array','Uint16Array','Uint32Array','Int8Array','Int16Array','Int32Array',
        'Float32Array','Float64Array','Uint8ClampedArray',
        # คำสั่งของภาษา JavaScript (ไม่ใช่ฟังก์ชัน)
        'if','else','for','while','do','switch','case','default','return','break','continue',
        'function','class','new','delete','void','typeof','instanceof','in','of','try','catch',
        'finally','throw','await','async','yield','import','export','from','as','get','set',
        'static','extends','super','this','constructor','then','constructor')
    foreach ($b in $builtin) { [void]$known.Add($b) }

    # เมธอดของคลาส (this.x(...) หรือ ชื่อที่ถูกเรียกหลังจุด) ถือว่ามีนิยามแล้ว
    $methods = New-Object System.Collections.ArrayList
    foreach ($f in $files) {
        $src = [System.IO.File]::ReadAllText($f)
        foreach ($m in [regex]::Matches($src, '(?:^|\s)(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{')) {
            $n = $m.Groups[1].Value
            if (-not $methods.Contains($n)) { [void]$methods.Add($n) }
        }
    }
    foreach ($m in $methods) { [void]$known.Add($m) }

    $missing = @{}
    foreach ($f in $files) {
        $src = [System.IO.File]::ReadAllText($f)
        $code = Remove-Code $src
        foreach ($m in [regex]::Matches($code, '(?<![\w$.''"])([a-zA-Z_$][\w$]*)\s*\(')) {
            $name = $m.Groups[1].Value
            if ($known.Contains($name)) { continue }
            $line = ($code.Substring(0, $m.Index) -split "`n").Count
            if (-not $missing.ContainsKey($name)) { $missing[$name] = @() }
            $missing[$name] += "$(Get-RelPath $f):$line"
        }
    }
    if ($missing.Count -gt 0) {
        foreach ($name in ($missing.Keys | Sort-Object)) {
            $places = $missing[$name] | Select-Object -First 4
            Write-Err "เรียกฟังก์ชัน '$name' ที่ไม่มีนิยามไว้: $($places -join ', ')"
        }
    } else {
        Write-Ok 'ทุกฟังก์ชันที่ถูกเรียกมีการนิยามไว้'
    }
}

# ---------------------------------------------------------------------------
# 4. ค่าคงที่เทียบกับต้นฉบับ
# ---------------------------------------------------------------------------
function Get-ArrayConst([string]$src, [string]$name) {
    $m = [regex]::Match($src, "(?:const|var|export const)\s+$name\s*=\s*(\{[^;]*?\}|\[[^;]*?\])\s*;", 'Singleline')
    if (-not $m.Success) { return $null }
    $raw = $m.Groups[1].Value
    $raw = [regex]::Replace($raw, '//[^\n]*', '')
    $raw = [regex]::Replace($raw, '\s+', ' ')
    $raw = $raw.Replace("'", '"')
    try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

function Test-Constants {
    if (-not (Test-Path $Orig)) {
        Write-Warn 'ไม่พบ Code.gs ต้นฉบับ - ข้ามการเทียบค่าคงที่'
        return
    }
    $origSrc = [System.IO.File]::ReadAllText($Orig)
    $newSrc = [System.IO.File]::ReadAllText((Join-Path $Funcs 'lib\constants.js'))
    $names = @('ROLE_PERMISSIONS','ID_FIELDS','ANIMATIONS','MONITOR_TEMPLATES','LEAVE_TYPES',
               'CLASS_TYPES','GRADE_GROUPS_GENERAL','GRADE_GROUPS_RELIGIOUS','COMPACT_CODE_',
               'Jawi_STATUS','THAI_STATUS')
    foreach ($name in $names) {
        $a = Get-ArrayConst $origSrc $name
        $b = Get-ArrayConst $newSrc $name
        if ($null -eq $a) { Write-Warn "อ่าน $name ของต้นฉบับไม่ได้"; continue }
        if ($null -eq $b) { Write-Err "ไม่มี $name ใน constants.js"; continue }
        $sa = ($a | ConvertTo-Json -Depth 10 -Compress)
        $sb = ($b | ConvertTo-Json -Depth 10 -Compress)
        if ($sa -eq $sb) { Write-Ok "ค่าคงที่ $name ตรงกัน" }
        else { Write-Err "ค่าคงที่ $name ไม่ตรง`n    ต้นฉบับ: $sa`n    ใหม่    : $sb" }
    }
}

# ---------------------------------------------------------------------------
# 5. ข้อความภาษาไทย - ต้องตรงกับต้นฉบับทุกประการ
# ---------------------------------------------------------------------------
function Get-ThaiStrings([string]$src) {
    $out = New-Object System.Collections.ArrayList
    # จับเฉพาะ string ที่อยู่บนบรรทัดเดียว (ไม่ข้ามเครื่องหมาย quote)
    $rx = [regex]"'([^'\r\n]*[\u0E00-\u0E7F][^'\r\n]*)'"
    foreach ($m in $rx.Matches($src)) {
        $v = $m.Groups[1].Value
        if ($v.Trim() -eq '') { continue }
        if (-not $out.Contains($v)) { [void]$out.Add($v) }
    }
    return $out
}

function Test-ThaiStrings {
    if (-not (Test-Path $Orig)) {
        Write-Warn 'ไม่พบ Code.gs ต้นฉบับ - ข้ามการตรวจข้อความไทย'
        return
    }
    $origThai = Get-ThaiStrings ([System.IO.File]::ReadAllText($Orig))

    # ไฟล์เหล่านี้เป็นของใหม่ทั้งหมด - ข้อความในไฟล์เหล่านี้จึงไม่ต้อง
    # ตรงกับต้นฉบับ (เป็นข้อความของ Cloudflare)
    $newFiles = @('worker.js', 'migrate.js', 'handler.js')

    $unknown = @()
    $total = 0
    foreach ($f in Get-JsFiles) {
        $rel = Get-RelPath $f
        if ($newFiles -contains [System.IO.Path]::GetFileName($f)) { continue }
        foreach ($v in (Get-ThaiStrings ([System.IO.File]::ReadAllText($f)))) {
            $total++
            if (-not $origThai.Contains($v)) { $unknown += "${rel}: $v" }
        }
    }
    if ($unknown.Count -gt 0) {
        foreach ($u in ($unknown | Select-Object -First 10)) { Write-Err "ข้อความไทยใหม่ที่ไม่มีในต้นฉบับ: $u" }
        if ($unknown.Count -gt 10) { Write-Err "  ... อีก $($unknown.Count - 10) รายการ" }
    } else {
        Write-Ok "ข้อความไทยทั้งหมด ($total รายการ) ตรงกับต้นฉบับ"
    }
}

# ---------------------------------------------------------------------------
# 6. frontend
# ---------------------------------------------------------------------------
function Test-Frontend {
    $idx = Join-Path $Root 'public\index.html'
    if (-not (Test-Path $idx)) { Write-Err 'ไม่พบ public/index.html'; return }
    $src = [System.IO.File]::ReadAllText($idx)
    if ($src -match 'google\.script\.run') {
        Write-Err 'frontend ยังมี google.script.run อยู่'
    } else {
        Write-Ok 'frontend ไม่มี google.script.run แล้ว'
    }
    if ($src -notmatch "API_BASE\s*=\s*'/api'") {
        Write-Warn 'ไม่พบการตั้งค่า API_BASE = /api'
    }
    $routePath = Join-Path $Funcs 'lib\routes.js'
    if (Test-Path $routePath) {
        $rsrc = [System.IO.File]::ReadAllText($routePath)
        $defined = [regex]::Matches($rsrc, "'([a-zA-Z][\w.]*)'\s*:") | ForEach-Object { $_.Groups[1].Value }
        $used = [regex]::Matches($src, "apiCall\(\s*'([\w.]+)'") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
        $missing = $used | Where-Object { $defined -notcontains $_ }
        if ($missing) { Write-Err "frontend เรียก action ที่ไม่มี: $($missing -join ', ')" }
        else { Write-Ok "frontend เรียก $($used.Count) actions - มีครบทุกตัว" }
    }
}

# ---------------------------------------------------------------------------
Write-Host ('=' * 70)
Write-Host '  SSMS Cloudflare - ตัวตรวจสอบ'
Write-Host ('=' * 70)
Write-Host ''

$files = Get-JsFiles
Write-Host "--- $($files.Count) ไฟล์ JavaScript ---"
foreach ($f in $files) { Test-Balance $f }
Write-Host ''
Write-Host '--- API routes ---'
Test-Routes
Write-Host ''
Write-Host '--- การเรียกฟังก์ชัน ---'
Test-Calls
Write-Host ''
Write-Host '--- ค่าคงที่ ---'
Test-Constants
Write-Host ''
Write-Host '--- ข้อความภาษาไทย ---'
Test-ThaiStrings
Write-Host ''
Write-Host '--- frontend ---'
Test-Frontend
Write-Host ''
Write-Host ('=' * 70)
if ($script:Errors.Count -gt 0) {
    Write-Host "$($script:Errors.Count) ข้อผิดพลาด, $($script:Warnings.Count) คำเตือน" -ForegroundColor Red
    exit 1
} else {
    $w = if ($script:Warnings.Count -gt 0) { ", $($script:Warnings.Count) คำเตือน" } else { '' }
    Write-Host "ผ่านทั้งหมด$w" -ForegroundColor Green
}
