# "Teams" edition of the KAD OS deck (owner, 2026-11-10): the same app, presented to Castrol's sales and marketing
# teams and their team leads. 45 minutes = 35 minutes of talk + 10 minutes of questions.
# Built from the v6 deck (build_kados.py) by adding a few slides, re-ordering everything into five timed chapters,
# rewriting the speaker notes for this audience and moving the detail slides to a backup section.
#   DECK_EDITION=teams python3 build_kados.py   ->  ../../KAD_OS_Castrol_Teams.pptx
# Runs inside build_kados.py (exec'd into its namespace) after all v6 slides exist.

ORIG = list(prs.slides)                      # the 33 v6 slides, in v6 order (1-based below)
V6 = {i + 1: s for i, s in enumerate(ORIG)}

CHAPTERS = [
    (1, "Every visit is real", "Do we really know what happens at the outlet?", "7:00 - 12:45"),
    (2, "The brand sees every outlet", "What is on the shelf, and where can Castrol grow?", "12:45 - 20:00"),
    (3, "Orders and money under control", "Right price, right credit, every time", "20:00 - 25:00"),
    (4, "AI keeps the team on plan", "Who tells the team what to do next?", "25:00 - 30:30"),
    (5, "Adoption and what comes next", "How do you get a whole team to use it?", "30:30 - 35:00"),
]
NEW = {}

# ---------------------------------------------------------------- agenda
s = new_slide(); n = nxt()
header(s, "Today", "Five chapters in 35 minutes, then your questions")
rows = [("0:00", "Opening", "What the brand cannot see today, and what KAD OS is")] + \
       [(t.split(" - ")[0], f"{k}. {title}", q) for k, title, q, t in CHAPTERS] + \
       [("35:00", "Questions", "Ten minutes for your questions; we can also show the app live")]
for i, (t, title, q) in enumerate(rows):
    y = 1.85 + i * 0.68
    chap = 1 <= i <= 5
    box(s, 0.6, y, 1.05, 0.46, fill=GREEN if chap else LIGHT, radius=0.23)
    text(s, 0.6, y, 1.05, 0.46, t, size=13, bold=True, color=WHITE if chap else DARK, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(s, 1.9, y - 0.02, 3.9, 0.5, title, size=16, bold=True, anchor=MSO_ANCHOR.MIDDLE)
    text(s, 5.8, y - 0.02, 4.0, 0.5, q, size=12.5, color=GREY, anchor=MSO_ANCHOR.MIDDLE)
phone(s, "home_ceo", 10.25, 1.55, 5.2)
footer(s, n)
NEW["agenda"] = s

# ---------------------------------------------------------------- the brand's blind spot
s = new_slide(); n = nxt()
header(s, "The brand's blind spot", "What Castrol's sales and marketing teams cannot see today")
pairs = [("mapWarning", "Was the outlet really visited?", "GPS check-in with a photo; refused beyond 300 m"),
         ("eye", "What is on the shelf?", "A Castrol shelf check at every visit"),
         ("warning", "Where is fake product sold?", "Fake product flagged, outlet by outlet"),
         ("store", "Which competitors are in the shop?", "Competitor brands recorded at every visit"),
         ("target", "Which shops do not buy Castrol yet?", "Potential outlets with level, reason and expected litres"),
         ("send", "Do our offers reach the shop?", "Next: offers on the customer's own dashboard")]
for i, (ic, prob, sol) in enumerate(pairs):
    col, row = i % 2, i // 2
    x = 0.6 + col * 6.15
    y = 1.9 + row * 1.6
    box(s, x, y, 5.98, 1.42, fill=LIGHT)
    icon(s, ic, x + 0.22, y + 0.33, 0.75, bg=RED_TINT, color="r")
    text(s, x + 1.2, y + 0.22, 4.6, 0.4, prob, size=15.5, bold=True, color=RED)
    icon(s, "checkCircle", x + 1.2, y + 0.78, 0.3, bg=None, color="g", ratio=1.0)
    text(s, x + 1.6, y + 0.72, 4.25, 0.5, sol, size=14, bold=True, color=GREEN_DARK)
footer(s, n)
NEW["blind"] = s

# ---------------------------------------------------------------- what the outlet data gives Castrol
NEW["outlet"] = steps_slide(
    "The brand sees every outlet", "What the outlet data gives Castrol sales & marketing",
    ["competitors", "potential_card"],
    [("Distribution gaps", "Filter the outlets without Castrol on the shelf, by region and district"),
     ("Fake product hotspots", "Every outlet where fake product was seen, with the visit date and photo"),
     ("Competitor presence", "Which brands each outlet carries, recorded at every visit"),
     ("Outlets to win next", "Potential outlets with level, reason and expected litres per month"),
     ("Order rhythm", "Each outlet's usual basket and how often it orders; a gap becomes a task"),
     ("Campaign follow-up", "Shelf checks before and after a campaign, outlet by outlet")],
    "", caps=["Competitors on the shelf", "Potential customer"])

# ---------------------------------------------------------------- chapter dividers
def divider(k, title, q, t):
    s = new_slide(); n = nxt()
    box(s, 0, 0, 4.3, 7.5, fill=GREEN, radius=0)
    text(s, 0.6, 1.9, 3.3, 2.4, str(k), size=170, bold=True, color=WHITE)
    text(s, 0.6, 5.55, 3.3, 0.4, f"CHAPTER {k} OF 5", size=13, bold=True, color=WHITE)
    stripe(s, 4.95, 2.35, w=1.2)
    text(s, 4.95, 2.6, 7.8, 1.4, title, size=40, bold=True, line=0.95)
    text(s, 4.95, 4.05, 7.8, 0.9, q, size=22, color=GREY)
    box(s, 4.95, 5.25, 2.1, 0.46, fill=GREEN_TINT, radius=0.23)
    text(s, 4.95, 5.25, 2.1, 0.46, t, size=13, bold=True, color=GREEN_DARK, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(s, SW - 1.6, 7.1, 1.0, 0.25, str(n), size=9, color=GREY, align=PP_ALIGN.RIGHT)   # page number only: no footer over the band
    return s


for k, title, q, t in CHAPTERS:
    NEW[f"d{k}"] = divider(k, title, q, t)

# ---------------------------------------------------------------- three things to remember
s = new_slide(); n = nxt()
header(s, "To remember", "Three things to take away")
three = [("mapPinCheck", "Every visit is real", "GPS-verified check-ins with a shelf check, competitors and a photo, at every outlet."),
         ("eye", "The brand sees every outlet", "Shelf, fake product, competitors, potential and order rhythm, outlet by outlet."),
         ("sparkles", "The team stays on plan", "An AI agent gives and checks the tasks, and the whole team was in the app by month 4.")]
for i, (ic, t, b) in enumerate(three):
    x = 0.6 + i * 4.1
    box(s, x, 1.95, 3.9, 4.3, fill=GREEN if i == 1 else LIGHT)
    icon(s, ic, x + 0.35, 2.3, 0.95, bg=WHITE if i == 1 else GREEN_TINT)
    text(s, x + 0.35, 3.4, 3.3, 0.6, f"{i + 1}", size=40, bold=True, color=WHITE if i == 1 else GREEN)
    text(s, x + 0.35, 4.15, 3.3, 0.9, t, size=21, bold=True, color=WHITE if i == 1 else DARK, anchor=MSO_ANCHOR.BOTTOM)
    text(s, x + 0.35, 5.15, 3.3, 1.0, b, size=14, color=WHITE if i == 1 else GREY, line=1.1)
footer(s, n)
NEW["three"] = s

# ---------------------------------------------------------------- backup divider
s = new_slide(); n = nxt()
box(s, 0, 0, 4.3, 7.5, fill=LIGHT, radius=0)
text(s, 0.6, 2.6, 3.3, 1.2, "B", size=120, bold=True, color=GREEN)
stripe(s, 4.95, 2.35, w=1.2)
text(s, 4.95, 2.6, 7.8, 1.0, "Backup slides", size=40, bold=True)
text(s, 4.95, 3.6, 7.8, 1.4, "Open these only when a question needs them: the home screen, warehouse, delivery, accounting, routes and fuel, security and more.", size=20, color=GREY, line=1.1)
footer(s, n)
NEW["backup"] = s

# ---------------------------------------------------------------- running order
MAIN = [V6[1], NEW["agenda"], NEW["blind"], V6[2], V6[6],
        NEW["d1"], V6[12], V6[14], V6[13],
        NEW["d2"], V6[7], V6[8], V6[9], NEW["outlet"],
        NEW["d3"], V6[16], V6[17], V6[19], V6[27],
        NEW["d4"], V6[25], V6[26], V6[24], V6[23],
        NEW["d5"], V6[31], V6[30], V6[32], NEW["three"], V6[33]]
BACKUP = [V6[5], V6[4], V6[3], V6[10], V6[11], V6[15], V6[18], V6[20], V6[21], V6[22], V6[28], V6[29]]
ORDER = MAIN + [NEW["backup"]] + BACKUP
assert len(ORDER) == len(prs.slides) and len(set(map(id, ORDER))) == len(ORDER)

# chapter tag (top right) on the content slides of each chapter
CH_OF = {}
ch = 0
for sl in MAIN:
    for k in range(1, 6):
        if sl is NEW[f"d{k}"]:
            ch = k
    if sl is NEW["three"] or sl is V6[33]:
        ch = 0
    CH_OF[id(sl)] = ch
for sl in MAIN:
    k = CH_OF[id(sl)]
    if k and not any(sl is NEW[f"d{j}"] for j in range(1, 6)):
        text(sl, SW - 6.1, 0.3, 5.5, 0.25, f"CHAPTER {k} · {CHAPTERS[k - 1][1].upper()}", size=10, bold=True, color=GREY, align=PP_ALIGN.RIGHT)
for sl in BACKUP:
    box(sl, SW - 1.75, 0.27, 1.15, 0.32, fill=LIGHT, radius=0.16)
    text(sl, SW - 1.75, 0.27, 1.15, 0.32, "BACKUP", size=10, bold=True, color=GREY, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)

# re-order the slide list
lst = prs.slides._sldIdLst
els = [next(el for el in lst if int(el.get("id")) == s.slide_id) for s in ORDER]
for el in list(lst):
    lst.remove(el)
for el in els:
    lst.append(el)

# page numbers: main 1..30, backup B1..B12 (the footer number is the small right-aligned text at y = 7.1 in)
def set_number(sl, label):
    for sh in sl.shapes:
        if sh.has_text_frame and abs(sh.top - Inches(7.1)) < Inches(0.02) and sh.left > Inches(SW - 2) and sh.text_frame.text.strip().isdigit():
            sh.text_frame.paragraphs[0].runs[0].text = label
            return True
    return False


for i, sl in enumerate(MAIN, 1):
    set_number(sl, str(i))
for i, sl in enumerate(BACKUP, 1):
    set_number(sl, f"B{i}")
set_number(NEW["backup"], "B")

# title slide subtitle for this audience
for sh in V6[1].shapes:
    if sh.has_text_frame and sh.text_frame.text.startswith("The app, feature by feature"):
        sh.text_frame.paragraphs[0].runs[0].text = "For Castrol sales & marketing teams · KAD Motors, Armenia · November 2026"

# ---------------------------------------------------------------- speaker notes (timed; ~125 words a minute)
exec(open(os.path.join(HERE, "teams_notes.py"), encoding="utf-8").read(), globals())
for sl, body in zip(MAIN, MAIN_NOTES):
    notes(sl, body)
for sl, body in zip(BACKUP, BACKUP_NOTES):
    notes(sl, body)
notes(NEW["backup"], "Backup section. Do not present these slides; open one only when a question needs it.")

OUT = os.path.join(HERE, "..", "..", "KAD_OS_Castrol_Teams.pptx")
TEAMS_MAIN, TEAMS_BACKUP = MAIN, BACKUP
