#!/usr/bin/env python3
"""Builds the user-guide HTML (one per language) from content.py.

Usage:  python3 build.py [out_dir]     (default: ./build)
Then:   node render.mjs                (HTML -> PDF with the repo's Playwright)

Fonts: set GUIDE_FONT_DIR to a folder with Noto Sans (latin + armenian)
woff2 files, e.g. from `npm i @fontsource/noto-sans @fontsource/noto-sans-armenian`
(node_modules/@fontsource/*/files). See README.md.
"""
import html
import os
import sys
from pathlib import Path

from content import SECTIONS, UI, VERSION

HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "build"
FONT_DIR = Path(os.environ.get("GUIDE_FONT_DIR", HERE / "fonts"))
SCREENS = HERE / "screens"

CSS = """
@font-face{font-family:GuideSans;font-weight:400;src:url('%(f)s/noto-sans-latin-400-normal.woff2')}
@font-face{font-family:GuideSans;font-weight:700;src:url('%(f)s/noto-sans-latin-700-normal.woff2')}
@font-face{font-family:GuideSans;font-weight:400;unicode-range:U+0530-058F,U+FB13-FB17;src:url('%(f)s/noto-sans-armenian-armenian-400-normal.woff2')}
@font-face{font-family:GuideSans;font-weight:700;unicode-range:U+0530-058F,U+FB13-FB17;src:url('%(f)s/noto-sans-armenian-armenian-700-normal.woff2')}
@page{size:148mm 210mm;margin:14mm 12mm 16mm}
@page:first{margin:0}
*{box-sizing:border-box}
html{font-family:GuideSans,'Noto Sans','DejaVu Sans',sans-serif;color:#1d2433;font-size:9.6pt;line-height:1.5}
h1,h2,h3{margin:0}
.cover{display:flex;flex-direction:column;justify-content:center;page-break-after:always;
  background:linear-gradient(160deg,#0b3b8f 0%%,#1a6bff 100%%);color:#fff;padding:24mm 16mm;height:209.6mm;width:148.1mm}
.cover .app{font-size:10pt;letter-spacing:.06em;opacity:.85;margin-bottom:10mm}
.cover h1{font-size:30pt;line-height:1.15;margin-bottom:5mm}
.cover .sub{font-size:15pt;opacity:.95;margin-bottom:14mm}
.cover .ver{font-size:9.5pt;opacity:.8}
.cover .demo{margin-top:6mm;font-size:8.5pt;opacity:.7}
.toc{page-break-after:always}
.toc h2{font-size:17pt;margin-bottom:6mm;color:#0b3b8f}
.toc ol{list-style:none;padding:0;margin:0}
.toc li{padding:1.5mm 0;border-bottom:.3mm solid #e4e8f0;font-size:10pt}
section{margin-bottom:6mm}
section.break{page-break-before:always}
section>*{orphans:3;widows:3}
h2.sec{font-size:15pt;color:#0b3b8f;border-bottom:.6mm solid #1a6bff;padding-bottom:1.5mm;margin-bottom:3.5mm;page-break-after:avoid}
h3{font-size:10.8pt;margin:4mm 0 1.5mm;color:#1d2433;page-break-after:avoid}
p{margin:0 0 2.6mm}
ul,ol{margin:0 0 3mm;padding-left:5mm}
li{margin-bottom:1.3mm}
.body::after{content:'';display:block;clear:both}
figure{float:right;margin:0 0 3mm 5mm;width:38mm;page-break-inside:avoid}
figure img{width:100%%;border:.3mm solid #cdd5e4;border-radius:3mm;display:block}
figcaption{font-size:7.6pt;color:#667089;text-align:center;margin-top:1mm}
.box{border-radius:2mm;padding:2.2mm 3mm;margin:0 0 3mm;font-size:9pt;page-break-inside:avoid}
.tip{background:#eaf7ee;border-left:1.2mm solid #2e9e55}
.note{background:#fff4df;border-left:1.2mm solid #e0900b}
.box b{display:block;margin-bottom:.5mm}
table{width:100%%;border-collapse:collapse;margin:0 0 3mm;font-size:8.8pt;page-break-inside:avoid}
th{background:#0b3b8f;color:#fff;text-align:left;padding:1.6mm 2mm}
td{border-bottom:.3mm solid #dde3ee;padding:1.6mm 2mm;vertical-align:top}
td:first-child{font-weight:700;width:34%%}
tr:nth-child(even) td{background:#f6f8fc}
""" % {"f": FONT_DIR.resolve().as_posix()}


def esc(s):
    return html.escape(s, quote=False)


def block(kind, val, ui):
    if kind == "p":
        return f"<p>{esc(val)}</p>"
    if kind == "h":
        return f"<h3>{esc(val)}</h3>"
    if kind == "ul":
        return "<ul>" + "".join(f"<li>{esc(i)}</li>" for i in val) + "</ul>"
    if kind == "ol":
        return "<ol>" + "".join(f"<li>{esc(i)}</li>" for i in val) + "</ol>"
    if kind in ("tip", "note"):
        return f'<div class="box {kind}"><b>{esc(ui[kind])}</b>{esc(val)}</div>'
    if kind == "table":
        head, *rows = val
        th = "".join(f"<th>{esc(c)}</th>" for c in head)
        tr = "".join("<tr>" + "".join(f"<td>{esc(c)}</td>" for c in r) + "</tr>" for r in rows)
        return f"<table><tr>{th}</tr>{tr}</table>"
    raise ValueError(kind)


def build(lang):
    ui = UI[lang]
    secs = SECTIONS[lang]
    toc = "".join(f"<li>{esc(s['title'])}</li>" for s in secs)
    body = []
    for s in secs:
        fig = ""
        if s.get("img"):
            src = (SCREENS / f"{s['img']}.jpg").resolve().as_posix()
            fig = f'<figure><img src="file://{src}"><figcaption>{esc(s.get("cap", ""))}</figcaption></figure>'
        inner = "".join(block(k, v, ui) for k, v in s["blocks"])
        body.append(
            f'<section id="{s["id"]}"><h2 class="sec">{esc(s["title"])}</h2>'
            f'<div class="body">{fig}{inner}</div></section>'
        )
    doc = f"""<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><title>{esc(ui['cover_title'])}</title>
<style>{CSS}</style></head><body>
<div class="cover"><div class="app">{esc(ui['cover_app'])}</div><h1>{esc(ui['cover_title'])}</h1>
<div class="sub">{esc(ui['cover_sub'])}</div><div class="ver">{esc(ui['cover_ver'].format(v=VERSION))}</div>
<div class="demo">{esc(ui['demo'])}</div></div>
<div class="toc"><h2>{esc(ui['toc'])}</h2><ol>{toc}</ol></div>
{''.join(body)}
</body></html>"""
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"guide-{lang}.html").write_text(doc, encoding="utf-8")
    print("wrote", OUT / f"guide-{lang}.html")


for lang in ("hy", "en"):
    build(lang)
