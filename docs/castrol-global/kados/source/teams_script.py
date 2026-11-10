# Builds the printable speaker script for the "teams" edition: ../../KAD_OS_Castrol_Teams_Script.pdf
#   python3 teams_script.py STILLS_PDF      (STILLS_PDF = the NO_VIDEO teams deck exported to PDF; used for thumbnails)
# The words are the speaker notes in teams_notes.py, so the deck and the script never drift apart.
import base64, glob, os, re, subprocess, sys, tempfile, html

HERE = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(HERE, "teams_notes.py"), encoding="utf-8").read())
stills = sys.argv[1]
tmp = tempfile.mkdtemp()
subprocess.run(["pdftoppm", "-r", "30", "-jpeg", stills, os.path.join(tmp, "t")], check=True)
thumbs = sorted(glob.glob(os.path.join(tmp, "t-*.jpg")))
assert len(thumbs) == len(MAIN_NOTES) + len(BACKUP_NOTES), len(thumbs)
b64 = lambda p: "data:image/jpeg;base64," + base64.b64encode(open(p, "rb").read()).decode()

TITLES = ["Title", "11 problems, one app", "A day from A to Z", "Check-in", "Visits that cannot be faked",
          "Customers & filters", "Customer card", "What the field data gives Castrol", "Orders", "Debt & cash",
          "Tasks & AI agent", "How the AI agent decides", "Human approvals", "Reports", "Adoption",
          "Built and adopted", "Next: the customer app", "Takeaways, thank you, questions"]
B_TITLES = ["Home screen", "Accounting & invoicing", "Warehouse", "Delivery & driver", "Routes & fuel allowance",
            "AI analyst & calculations", "Built for field work"]
assert len(TITLES) == len(MAIN_NOTES) and len(B_TITLES) == len(BACKUP_NOTES)

QA = [
    ("Can a rep fake a visit?",
     "No. A check-in is accepted only within 300 metres of the customer; the real distance and the GPS accuracy are saved; the start and end of the visit are recorded; and repeated GPS evidence shows customers whose map pin is wrong. (Slide 5.)"),
    ("How reliable is the shelf data?",
     "It is recorded by the rep at every visit, with a photo, and management sees it in the visit history per customer and per rep. Because it is collected at every visit and not once a year, a wrong entry stands out quickly."),
    ("What happens without internet?",
     "The app keeps working. Visits, orders and stock counts wait on the phone and are sent when the signal comes back. (Backup B7.)"),
    ("How did you get the reps to use it?",
     "A bonus system with points for the work done in the app, and a monthly contest: the rep with the most check-ins wins a fixed bonus. And the reps helped design it, so it saves them time. (Slide 15.)"),
    ("What if the AI makes a mistake?",
     "People approve every decision that matters: discounts, prices below cost, credit, invoices and cash. The AI agent started in test mode and was switched on only after management tuned it. (Slide 13.)"),
    ("Does it connect to accounting or ERP systems?",
     "Yes. It has an integration API, and it is connected to our local invoicing system, so invoices are created without typing them again. (Backup B2.)"),
    ("Where is the data, and who can see it?",
     "In our own cloud system, over an encrypted connection, with protected logins and an audit trail. Each person sees only what their role allows; the AI analyst sees customers and staff only as codes. (Backup B7, B6.)"),
    ("Which languages does it support?",
     "Armenian and English today."),
    ("How long did it take?",
     "Three months to the first live version (May to August 2026), the whole field team in the app in the fourth month, and the complete system by the sixth month. (Slide 16.)"),
    ("Can other distributors use KAD OS?  [owner to confirm the answer]",
     "Suggested: it was built for our own business, and we are open to discussing it with Castrol. Please do not promise dates or prices on stage."),
    ("Can Castrol receive the field data (shelf, fake product, competitors)?  [owner to confirm the answer]",
     "Suggested: today the data serves our own team; how to share field-level data with Castrol is something we would like to agree together."),
    ("What did it cost?  [owner to confirm the answer]",
     "Suggested: it was built by our own team; we prefer to discuss the details separately."),
]

CHECK = [
    "Open KAD_OS_Castrol_Teams.pptx on the presenting laptop and click through all 18 slides once; there are no videos to start.",
    "Use Presenter View, so the timed notes are on your screen and the audience sees only the slides.",
    "Keep the PDF on a USB stick as a fallback.",
    "Watch the time cue at the top of each note. If you are more than 2 minutes late, shorten slide 12 (How the AI agent decides) to the first example and slide 13 (Approvals) to one sentence: that saves about 2 minutes.",
    "Backup slides B1 to B7 follow slide 18. Jump to one by typing its number in slideshow mode (B1 = 19, B2 = 20, ... B7 = 25, then Enter).",
    "Optional: have the app open with the demo login for a live answer during the questions.",
]


def notes_html(body):
    lines = body.strip().split("\n")
    out = []
    first = lines[0]
    m = re.match(r"\[([^\]]+)\]\s*(KEY MESSAGE:\s*)?(.*)", first)
    t, key = (m.group(1), m.group(3)) if m else ("", first)
    head = f'<div class="t">{html.escape(t)}</div>' if t else ""
    if m and m.group(2):
        head += f'<div class="k">Key message: {html.escape(key)}</div>'
        rest = lines[1:]
    else:
        rest = ([key] if key else []) + lines[1:]
    for l in rest:
        out.append(f"<p>{html.escape(l)}</p>")
    return head, "".join(out), t


rows, pages = [], []
for i, (title, body) in enumerate(zip(TITLES, MAIN_NOTES), 1):
    head, paras, t = notes_html(body)
    words = len(re.findall(r"\w+", body)) - 6
    rows.append(f"<tr><td>{i}</td><td>{html.escape(title)}</td><td>{html.escape(t)}</td><td class='r'>{words}</td></tr>")
    pages.append(f'<section><img src="{b64(thumbs[i - 1])}"><div><h3>{i}. {html.escape(title)}</h3>{head}{paras}</div></section>')
bpages = []
for j, (title, body) in enumerate(zip(B_TITLES, BACKUP_NOTES), 1):
    txt = re.sub(r"^BACKUP \([^)]*\)\.\s*", "", body.strip())
    bpages.append(f'<section class="b"><img src="{b64(thumbs[len(MAIN_NOTES) + j - 1])}"><div><h3>B{j}. {html.escape(title)}</h3><p>{html.escape(txt)}</p></div></section>')
qa = "".join(f"<div class='qa'><b>{html.escape(q)}</b><p>{html.escape(a)}</p></div>" for q, a in QA)
check = "".join(f"<li>{html.escape(c)}</li>" for c in CHECK)

doc = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>KAD OS speaker script</title><style>
@page{{size:A4;margin:14mm 14mm 16mm}}
*{{box-sizing:border-box}}body{{font-family:Arial,"Liberation Sans",sans-serif;color:#141B24;font-size:10.5pt;line-height:1.45;margin:0}}
h1{{font-size:24pt;margin:0}}h2{{font-size:15pt;color:#006E32;margin:16px 0 8px;border-bottom:2px solid #009343;padding-bottom:3px}}
h3{{font-size:12pt;margin:0 0 3px}}.sub{{color:#5F6670;margin:2px 0 12px}}.bar{{height:4px;width:80px;background:linear-gradient(90deg,#009343 72%,#F00023 72%);margin:0 0 10px}}
table{{border-collapse:collapse;width:100%;font-size:9.5pt}}td,th{{border-bottom:1px solid #D9DEDB;padding:3px 6px;text-align:left}}th{{background:#E6F4EC}}.r{{text-align:right}}
section{{display:flex;gap:12px;padding:9px 0;border-bottom:1px solid #D9DEDB;break-inside:avoid}}section img{{width:150px;height:auto;border:1px solid #D9DEDB;flex:none;align-self:flex-start}}
section p{{margin:0 0 5px}}.t{{display:inline-block;background:#009343;color:#fff;font-weight:700;font-size:9pt;border-radius:8px;padding:1px 8px;margin-bottom:3px}}
.k{{font-weight:700;color:#006E32;margin:2px 0 5px}}section.b img{{width:110px}}section.b{{font-size:9.5pt}}
.qa{{break-inside:avoid;margin:0 0 8px}}.qa p{{margin:2px 0 0}}ul{{margin:4px 0;padding-left:18px}}.pb{{break-before:page}}
.note{{background:#F4F5F6;border-radius:6px;padding:8px 10px;font-size:9.5pt}}
</style></head><body>
<div class="bar"></div><h1>KAD OS: speaker script</h1>
<div class="sub">For Castrol sales &amp; marketing teams and their team leads · 45 minutes = 35 min talk + 10 min questions · Demo data only</div>
<div class="note"><b>How to use this script.</b> Every slide has a time cue, one key message and the words to say (about 125 words a minute, with pauses). The same text is in the speaker notes of KAD_OS_Castrol_Teams.pptx. Words in brackets are actions, not speech. Slides 1 to 18 are the talk; B1 to B7 are backup slides for questions.</div>
<h2>Timing plan</h2>
<table><tr><th>#</th><th>Slide</th><th>Time</th><th class="r">Words</th></tr>{''.join(rows)}</table>
<h2>On the day</h2><ul>{check}</ul>
<h2 class="pb">The script</h2>{''.join(pages)}
<h2 class="pb">Likely questions and suggested answers</h2>{qa}
<h2 class="pb">Backup slides (only when a question needs them)</h2>{''.join(bpages)}
</body></html>"""
out_html = os.path.join(tmp, "script.html")
open(out_html, "w", encoding="utf-8").write(doc)
pw = os.path.join(HERE, "..", "..", "..", "..", "server", "node_modules", "playwright", "index.mjs")
js = f"""const {{ chromium }} = await import({pw!r}); const b = await chromium.launch(); const p = await b.newPage();
await p.goto("file://{out_html}"); await p.pdf({{ path: {os.path.join(HERE, '..', '..', 'KAD_OS_Castrol_Teams_Script.pdf')!r}, format: "A4", printBackground: true,
displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#5F6670">KAD OS speaker script · page <span class=pageNumber></span> of <span class=totalPages></span></div>',
margin: {{ top: "14mm", bottom: "16mm", left: "14mm", right: "14mm" }} }}); await b.close();"""
open(os.path.join(tmp, "p.mjs"), "w").write(js)
subprocess.run(["node", os.path.join(tmp, "p.mjs")], check=True)
print("saved KAD_OS_Castrol_Teams_Script.pdf")
