#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ตัวช่วยตรวจสอบความถูกต้องของการพอร์ต (ไม่ต้องมี Node.js)

ใช้ตรวจว่า:
  1. ไฟล์ JS ทุกไฟล์ parse ผ่าน (balanced braces / วงเล็บ / quotes)
  2. ทุก action ใน API_ROUTES มี handler ที่ export มาจริง
  3. ทุกชื่อฟังก์ชันที่เรียกใช้ มีการนิยามไว้ (ไม่มี typo)
  4. ค่าคงที่ (constants) ตรงกับต้นฉบับ Code.gs ทุกตัว

วิธีใช้:  python tools/verify.py
"""

import os
import re
import sys
import json
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FUNCS = os.path.join(ROOT, 'functions')
ORIG = os.path.join(os.path.dirname(ROOT), 'v3-compact', 'Code.gs')

GREEN, RED, YELLOW, RESET = '\033[92m', '\033[91m', '\033[93m', '\033[0m'
errors = []
warnings = []


def err(msg):
    errors.append(msg)
    print(f'{RED}ERROR{RESET} {msg}')


def warn(msg):
    warnings.append(msg)
    print(f'{YELLOW}WARN {RESET} {msg}')


def ok(msg):
    print(f'{GREEN}OK{RESET}   {msg}')


# ---------------------------------------------------------------------------
# 1. Balanced syntax check
# ---------------------------------------------------------------------------
def strip_code(src):
    """Remove strings, template literals, regexes and comments."""
    out = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        two = src[i:i + 2]
        if two == '//':
            j = src.find('\n', i)
            i = n if j == -1 else j
            continue
        if two == '/*':
            j = src.find('*/', i + 2)
            i = n if j == -1 else j + 2
            continue
        if c in '\'"`':
            quote = c
            i += 1
            while i < n:
                if src[i] == '\\':
                    i += 2
                    continue
                if src[i] == quote:
                    i += 1
                    break
                i += 1
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def check_balance(path):
    src = open(path, encoding='utf-8').read()
    code = strip_code(src)
    pairs = {')': '(', ']': '[', '}': '{'}
    stack = []
    line = 1
    for ch in code:
        if ch == '\n':
            line += 1
        elif ch in '([{':
            stack.append((ch, line))
        elif ch in ')]}':
            if not stack:
                err(f'{rel(path)}: unmatched closing "{ch}" at line {line}')
                return
            op, ol = stack.pop()
            if op != pairs[ch]:
                err(f'{rel(path)}: mismatched "{op}" (line {ol}) closed by "{ch}" (line {line})')
                return
    if stack:
        op, ol = stack[-1]
        err(f'{rel(path)}: unclosed "{op}" opened at line {ol}')
        return
    ok(f'{rel(path)} - brackets balanced')


def rel(path):
    return os.path.relpath(path, ROOT).replace('\\', '/')


# ---------------------------------------------------------------------------
# 2. Collect exported / defined names
# ---------------------------------------------------------------------------
def collect_js_files():
    files = []
    for base, _dirs, names in os.walk(FUNCS):
        for nm in names:
            if nm.endswith('.js'):
                files.append(os.path.join(base, nm))
    return sorted(files)


DEF_RE = re.compile(
    r'(?:export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)'
    r'|export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)'
    r'|export\s*\{([^}]*)\}'
    r'|(?:^|\s)function\s+([A-Za-z_$][\w$]*)'
    r'|(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)',
    re.M)


def defined_names(path):
    src = open(path, encoding='utf-8').read()
    names = set()
    for m in DEF_RE.finditer(src):
        for g in m.groups():
            if not g:
                continue
            for part in g.split(','):
                part = part.strip()
                if not part:
                    continue
                if ' as ' in part:
                    part = part.split(' as ')[-1].strip()
                if re.fullmatch(r'[A-Za-z_$][\w$]*', part):
                    names.add(part)
    return names


# ---------------------------------------------------------------------------
# 3. Compare the constants with the original
# ---------------------------------------------------------------------------
def parse_orig_const_arrays():
    """Reads the array constants from the original Code.gs."""
    src = open(ORIG, encoding='utf-8').read()
    out = {}
    for name in ['ROLE_PERMISSIONS', 'ID_FIELDS', 'ANIMATIONS', 'MONITOR_TEMPLATES',
                 'LEAVE_TYPES', 'CLASS_TYPES', 'GRADE_GROUPS_GENERAL',
                 'GRADE_GROUPS_RELIGIOUS', 'COMPACT_CODE_', 'Jawi_STATUS', 'THAI_STATUS']:
        m = re.search(r'(?:const|var)\s+' + re.escape(name) + r'\s*=\s*(\{[^;]*?\}|\[[^;]*?\])\s*;',
                      src, re.S)
        if not m:
            continue
        raw = m.group(1)
        # normalise to a comparable form
        raw = re.sub(r'//.*', '', raw)
        raw = re.sub(r'\s+', ' ', raw)
        raw = raw.replace("'", '"')
        try:
            out[name] = json.loads(raw)
        except Exception:
            # single quotes inside / trailing commas
            items = re.findall(r"'([^']*)'", raw)
            out[name] = items
    return out


def parse_new_const_arrays():
    path = os.path.join(FUNCS, '_lib', 'constants.js')
    src = open(path, encoding='utf-8').read()
    out = {}
    for name in ['ROLE_PERMISSIONS', 'ID_FIELDS', 'ANIMATIONS', 'MONITOR_TEMPLATES',
                 'LEAVE_TYPES', 'CLASS_TYPES', 'GRADE_GROUPS_GENERAL',
                 'GRADE_GROUPS_RELIGIOUS', 'COMPACT_CODE_', 'Jawi_STATUS', 'THAI_STATUS']:
        m = re.search(r'export\s+const\s+' + re.escape(name) + r'\s*=\s*(\{[^;]*?\}|\[[^;]*?\])\s*;',
                      src, re.S)
        if not m:
            continue
        raw = re.sub(r'//.*', '', m.group(1))
        raw = re.sub(r'\s+', ' ', raw)
        raw = raw.replace("'", '"')
        try:
            out[name] = json.loads(raw)
        except Exception:
            out[name] = re.findall(r"'([^']*)'", raw)
    return out


def check_constants():
    if not os.path.exists(ORIG):
        warn('original Code.gs not found - skipping the constant comparison')
        return
    a = parse_orig_const_arrays()
    b = parse_new_const_arrays()
    for name in sorted(set(a) | set(b)):
        if name not in a:
            warn(f'constant {name} only exists in the new version')
            continue
        if name not in b:
            err(f'constant {name} is missing in the new version')
            continue
        if a[name] != b[name]:
            err(f'constant {name} differs:\n    original: {a[name]}\n    new     : {b[name]}')
        else:
            ok(f'constant {name} identical')


# ---------------------------------------------------------------------------
# 4. API routes
# ---------------------------------------------------------------------------
def check_routes():
    path = os.path.join(FUNCS, '_lib', 'routes.js')
    if not os.path.exists(path):
        err('functions/_lib/routes.js is missing')
        return
    src = open(path, encoding='utf-8').read()
    orig = open(ORIG, encoding='utf-8').read()

    def routes_of(text, pattern):
        m = re.search(pattern, text, re.S)
        if not m:
            return set()
        return set(re.findall(r"'([a-zA-Z][\w.]*)'\s*:", m.group(1)))

    orig_routes = routes_of(orig, r'API_ROUTES\s*=\s*\{(.*?)\n\};')
    new_routes = routes_of(src, r'(?:export const API_ROUTES|const API_ROUTES)\s*=\s*\{(.*?)\n\};')
    if not orig_routes:
        err('could not read the original API_ROUTES')
        return
    missing = orig_routes - new_routes
    extra = new_routes - orig_routes
    if missing:
        err(f'{len(missing)} actions are missing: {sorted(missing)}')
    if extra:
        warn(f'{len(extra)} extra actions: {sorted(extra)}')
    if not missing and not extra:
        ok(f'all {len(orig_routes)} API actions are present')


# ---------------------------------------------------------------------------
# 5. Undefined function calls
# ---------------------------------------------------------------------------
BUILTIN = set('''
Array Boolean Date Error JSON Math Number Object Promise String RegExp Map Set
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent
require console crypto textEncoder TextDecoder URL URLSearchParams Intl
globalThis structuredClone
'''.split())

RESERVED = set('''
if else for while do return break continue function const let var class new
typeof instanceof in of switch case default throw try catch finally
delete void yield await async import export from as get set static extends
super this
'''.split())


def check_calls():
    all_defined = set()
    files = collect_js_files()
    for f in files:
        all_defined |= defined_names(f)
    # names available through the imports of every file
    imported = set()
    for f in files:
        src = open(f, encoding='utf-8').read()
        for m in re.finditer(r'import\s*\{([^}]*)\}\s*from', src):
            for part in m.group(1).split(','):
                part = part.strip()
                if ' as ' in part:
                    part = part.split(' as ')[-1].strip()
                if part:
                    imported.add(part)
    known = all_defined | imported | BUILTIN | RESERVED

    missing = {}
    for f in files:
        src = open(f, encoding='utf-8').read()
        code = strip_code(src)
        for m in re.finditer(r'(?<![\w$.\'"])([a-zA-Z_$][\w$]*)\s*\(', code):
            name = m.group(1)
            if name in known:
                continue
            # local method call (this.x() / obj.x()) - already excluded by lookbehind
            line = code[:m.start()].count('\n') + 1
            missing.setdefault(name, []).append(f'{rel(f)}:{line}')

    if missing:
        for name, places in sorted(missing.items()):
            err(f'unknown function "{name}" called at {", ".join(places[:4])}')
    else:
        ok('every called function is defined')


# ---------------------------------------------------------------------------
# 6. Frontend check
# ---------------------------------------------------------------------------
def check_frontend():
    idx = os.path.join(ROOT, 'public', 'index.html')
    if not os.path.exists(idx):
        err('public/index.html is missing')
        return
    src = open(idx, encoding='utf-8').read()
    if 'google.script.run' in src:
        err('public/index.html still contains google.script.run')
    else:
        ok('frontend no longer uses google.script.run')

    # every action the frontend calls must exist in the routes
    routes_path = os.path.join(FUNCS, '_lib', 'routes.js')
    if os.path.exists(routes_path):
        rsrc = open(routes_path, encoding='utf-8').read()
        defined = set(re.findall(r"'([a-zA-Z][\w.]*)'\s*:", rsrc))
        used = set(re.findall(r"apiCall\(\s*'([\w.]+)'", src))
        missing = used - defined
        if missing:
            err(f'the frontend calls unknown actions: {sorted(missing)}')
        else:
            ok(f'the frontend calls {len(used)} actions - all of them exist')


def main():
    print('=' * 70)
    print('  SSMS Cloudflare - verification')
    print('=' * 70)
    print()
    files = collect_js_files()
    print(f'--- {len(files)} JavaScript files ---')
    for f in files:
        check_balance(f)
    print()
    print('--- constants ---')
    check_constants()
    print()
    print('--- api routes ---')
    check_routes()
    print()
    print('--- function calls ---')
    check_calls()
    print()
    print('--- frontend ---')
    check_frontend()
    print()
    print('=' * 70)
    if errors:
        print(f'{RED}{len(errors)} error(s){RESET}, {len(warnings)} warning(s)')
        return 1
    print(f'{GREEN}all checks passed{RESET}' + (f', {len(warnings)} warning(s)' if warnings else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
