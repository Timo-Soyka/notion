#!/usr/bin/env python3
# Ersetzt unsichtbare Sonderzeichen in JS-Dateien durch lesbare \u-Escapes.
# Hintergrund: Beim Erzeugen der Dateien werden \uXXXX-Folgen manchmal zu echten
# (unsichtbaren) Zeichen – im Code sind sie dann kaum noch zu erkennen.
import sys, pathlib
CODES = [0xFEFF, 0x00A0, 0x200B, 0x2028, 0x2029, 0x2060, 0xFFFC]
root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
for p in list(root.rglob('*.js')) + list(root.rglob('*.mjs')):
    if 'vendor' in p.parts:
        continue
    s = p.read_text(encoding='utf-8')
    out = []
    for ch in s:
        o = ord(ch)
        if o in CODES or (o < 32 and ch not in '\t\n\r'):
            out.append('\\u%04X' % o)
        else:
            out.append(ch)
    t = ''.join(out)
    if t != s:
        p.write_text(t, encoding='utf-8')
        print('fixed', p)
