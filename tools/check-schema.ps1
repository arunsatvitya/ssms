#!/usr/bin/env pwsh
<#
.SYNOPSIS
    ตรวจว่าคอลัมน์ใน constants.js (TABLES) ตรงกับ schema/001_schema.sql

.DESCRIPTION
    ทุกครั้งที่มีการเปลี่ยนโครงสร้างฐานข้อมูล ต้องรันสคริปต์นี้
    เพื่อยืนยันว่าชื่อคอลัมน์ที่โค้ดใช้จริงตรงกับที่สร้างไว้ในฐานข้อมูล

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\check-schema.ps1
#>

$Root = Split-Path -Parent $PSScriptRoot
$SchemaPath = Join-Path $Root 'schema\001_schema.sql'
$ConstPath = Join-Path $Root 'src\lib\constants.js'

$errors = @()

# --- อ่าน schema -------------------------------------------------------
$schema = [System.IO.File]::ReadAllText($SchemaPath)
$tables = @{}
foreach ($m in [regex]::Matches($schema, 'CREATE TABLE IF NOT EXISTS (\w+)\s*\((.*?)\n\);', 'Singleline')) {
    $name = $m.Groups[1].Value
    $body = $m.Groups[2].Value
    $cols = @()
    foreach ($line in ($body -split "`n")) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('--')) { continue }
        if ($t -match '^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT)\b') { continue }
        if ($t -match '^(\w+)\s+[A-Z]') { $cols += $Matches[1] }
    }
    $tables[$name] = $cols
}

# --- อ่าน constants.js -------------------------------------------------
$const = [System.IO.File]::ReadAllText($ConstPath)
$block = [regex]::Match($const, 'export const TABLES = \{(.*?)\n\};', 'Singleline')
if (-not $block.Success) {
    Write-Host "ERROR ไม่พบ TABLES ใน constants.js" -ForegroundColor Red
    exit 1
}

$declared = @{}
foreach ($m in [regex]::Matches($block.Groups[1].Value, "table:\s*'(\w+)'")) {
    $declared[$m.Groups[1].Value] = $true
}

Write-Host '--- ตารางใน schema ---'
foreach ($t in ($tables.Keys | Sort-Object)) {
    $status = if ($declared.ContainsKey($t)) { 'OK  ' } else { 'WARN' }
    if (-not $declared.ContainsKey($t)) {
        Write-Host "  $status ตาราง '$t' ยังไม่ได้ประกาศใน TABLES" -ForegroundColor Yellow
    } else {
        Write-Host "  $status $t ($($tables[$t].Count) คอลัมน์)" -ForegroundColor Green
    }
}

Write-Host ''
Write-Host '--- คอลัมน์ ---'
foreach ($m in [regex]::Matches($block.Groups[1].Value, "table:\s*'(\w+)'[^}]*?columns:\s*\[([^\]]*)\]", 'Singleline')) {
    $table = $m.Groups[1].Value
    $cols = [regex]::Matches($m.Groups[2].Value, "'(\w+)'") | ForEach-Object { $_.Groups[1].Value }
    if (-not $tables.ContainsKey($table)) {
        $errors += "ตาราง '$table' ไม่มีใน schema"
        Write-Host "  ERROR ตาราง '$table' ไม่มีใน schema" -ForegroundColor Red
        continue
    }
    $missing = $cols | Where-Object { $tables[$table] -notcontains $_ }
    $extra = $tables[$table] | Where-Object { $cols -notcontains $_ }
    if ($missing) {
        $errors += "ตาราง '$table' - คอลัมน์ที่ยังไม่มีใน schema: $($missing -join ', ')"
        Write-Host "  ERROR $table - ขาดคอลัมน์: $($missing -join ', ')" -ForegroundColor Red
    }
    if ($extra) {
        Write-Host "  WARN $table - คอลัมน์ใน schema ที่ไม่ได้ใช้: $($extra -join ', ')" -ForegroundColor Yellow
    }
    if (-not $missing) {
        Write-Host "  OK   $table - คอลัมน์ตรงกันครบ ($($cols.Count))" -ForegroundColor Green
    }
}

Write-Host ''
if ($errors.Count -gt 0) {
    Write-Host "$($errors.Count) ข้อผิดพลาด" -ForegroundColor Red
    $errors | ForEach-Object { Write-Host "  - $_" }
    exit 1
}
Write-Host 'schema ตรงกับโค้ดทุกตาราง' -ForegroundColor Green
