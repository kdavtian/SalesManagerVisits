# Builds ../KAD_OS_Castrol_Global.pptx: the KAD OS deck for Castrol Global (16:9, 14 slides + appendix, speaker notes on every slide).
# Screens are demo data. Run: python3 build_kados.py   (then export the PDF, see ../README.md)
# Inputs: ../screenshots/*.png (framed phones, from frames.py), icons/*.png (from assets.mjs), kad-wordmark.png.
# Run: python3 build_deck.py
import os
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION
from pptx.enum.dml import MSO_LINE_DASH_STYLE
from PIL import Image
from pptx.oxml.ns import qn

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "..", "screenshots")
ASSETS = os.path.join(HERE, "..", "..", "assets")
ICONS = os.path.join(HERE, "..", "..", "source", "icons")
OUT = os.path.join(HERE, "..", "..", "KAD_OS_Castrol_Global.pptx")

GREEN = RGBColor(0x00, 0x93, 0x43)  # sampled from the official Castrol logo file
GREEN_DARK = RGBColor(0x00, 0x6E, 0x32)
GREEN_TINT = RGBColor(0xE6, 0xF4, 0xEC)
GREEN_MID = RGBColor(0x9E, 0xD3, 0xB3)
RED = RGBColor(0xF0, 0x00, 0x23)  # sampled from the official Castrol logo file
RED_TINT = RGBColor(0xFD, 0xEB, 0xED)
DARK = RGBColor(0x14, 0x1B, 0x24)
GREY = RGBColor(0x5F, 0x66, 0x70)
LIGHT = RGBColor(0xF4, 0xF5, 0xF6)
LINE = RGBColor(0xD9, 0xDE, 0xDB)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
FONT = "Arial"

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]
SW = 13.333


def text(slide, x, y, w, h, content, size=14, bold=False, color=DARK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, spacing=None, line=1.0):
    """content: str, or list of paragraphs; a paragraph is a str or a list of (text, {size,bold,color}) runs."""
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    paras = content if isinstance(content, list) else [content]
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = line
        if spacing is not None and i > 0:
            p.space_before = Pt(spacing)
        runs = para if isinstance(para, list) else [(para, {})]
        for t, st in runs:
            r = p.add_run()
            r.text = t
            f = r.font
            f.name = FONT
            f.size = Pt(st.get("size", size))
            f.bold = st.get("bold", bold)
            f.color.rgb = st.get("color", color)
    return tb


def box(slide, x, y, w, h, fill=None, line=None, radius=0.12, line_w=1.0, dash=False, shape=None):
    shp = slide.shapes.add_shape(shape or (MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE), Inches(x), Inches(y), Inches(w), Inches(h))
    if radius and (shape is None):
        shp.adjustments[0] = min(0.5, radius / min(w, h))
    if fill is None:
        shp.fill.background()
    else:
        shp.fill.solid()
        shp.fill.fore_color.rgb = fill
    if line is None:
        shp.line.fill.background()
    else:
        shp.line.color.rgb = line
        shp.line.width = Pt(line_w)
        if dash:
            shp.line.dash_style = MSO_LINE_DASH_STYLE.DASH
    shp.shadow.inherit = False
    shp.text_frame.text = ""
    return shp


def pic(slide, path, x, y, w=None, h=None):
    if w is None and h is None:
        raise ValueError
    im = Image.open(path)
    ar = im.size[0] / im.size[1]
    if w is None:
        w = h * ar
    if h is None:
        h = w / ar
    slide.shapes.add_picture(path, Inches(x), Inches(y), Inches(w), Inches(h))
    return w, h


def phone(slide, name, x, y, h):
    return pic(slide, os.path.join(SHOTS, name + ".png"), x, y, h=h)


def icon(slide, name, x, y, d, bg=GREEN_TINT, color="g", ratio=0.56):
    if bg is not None:
        c = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(y), Inches(d), Inches(d))
        c.fill.solid()
        c.fill.fore_color.rgb = bg
        c.line.fill.background()
        c.shadow.inherit = False
    s = d * ratio
    slide.shapes.add_picture(os.path.join(ICONS, f"{name}_{color}.png"), Inches(x + (d - s) / 2), Inches(y + (d - s) / 2), Inches(s), Inches(s))


def stripe(slide, x, y, w=0.9):
    box(slide, x, y, w * 0.72, 0.07, fill=GREEN, radius=0)
    box(slide, x + w * 0.72, y, w * 0.28, 0.07, fill=RED, radius=0)


def header(slide, kicker, headline, size=30):
    stripe(slide, 0.6, 0.38)
    text(slide, 0.6, 0.55, 10, 0.3, kicker.upper(), size=12, bold=True, color=GREEN)
    text(slide, 0.6, 0.85, 12.1, 1.0, headline, size=size, bold=True, color=DARK, line=0.95)




def notes(slide, body):
    slide.notes_slide.notes_text_frame.text = body.strip()


def logo_spot(slide, x, y, w, h, on_dark=False):
    col = WHITE if on_dark else GREY
    b = box(slide, x, y, w, h, fill=None, line=col, radius=0.08, line_w=1.25, dash=True)
    text(slide, x, y, w, h, [[("CASTROL LOGO", {"bold": True, "size": 11, "color": col})], [("place official asset here", {"size": 9, "color": col})]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    return b


def new_slide():
    s = prs.slides.add_slide(BLANK)
    bg = s.background.fill
    bg.solid()
    bg.fore_color.rgb = WHITE
    return s


KAD_LOGO = os.path.join(ASSETS, "kad-logo.png")
CASTROL_LOGO = os.path.join(ASSETS, "castrol-logo.png")
_n = [0]


def nxt():
    _n[0] += 1
    return _n[0]


def lockup(slide, x, y, size=28, color=DARK, align=PP_ALIGN.LEFT, w=6.0):
    """The KAD OS lockup: 'KAD OS' with a smaller 'powered by Castrol' line directly under it (text only, no logo artwork)."""
    text(slide, x, y, w, size / 72 * 1.25, "KAD OS", size=size, bold=True, color=color, align=align)
    text(slide, x, y + size / 72 * 1.12, w, size / 72 * 0.6, "powered by Castrol", size=max(7, size * 0.36), color=GREY, align=align)


def footer(slide, n):
    ln = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(0.6), Inches(6.98), Inches(SW - 0.6), Inches(6.98))
    ln.line.color.rgb = LINE
    ln.line.width = Pt(0.75)
    lockup(slide, 0.6, 7.03, size=11, w=2.0)
    text(slide, 2.0, 7.1, 7, 0.25, "The operating system for a modern Castrol distributor", size=9, color=GREY)
    text(slide, SW - 1.6, 7.1, 1.0, 0.25, str(n), size=9, color=GREY, align=PP_ALIGN.RIGHT)


def pending(slide, x, y, w, h, label, size=12):
    box(slide, x, y, w, h, fill=WHITE, line=RED, radius=0.12, line_w=1.25, dash=True)
    text(slide, x + 0.15, y, w - 0.3, h, [[("VERIFIED NUMBER PENDING", {"bold": True, "size": 10, "color": RED})], [(label, {"size": size, "color": DARK})]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, spacing=3)


def demo_tag(slide, x, y, w=1.6):
    text(slide, x, y, w, 0.22, "Demo data", size=9, color=GREY, align=PP_ALIGN.CENTER)


Q_TOUGH = """
Tough questions to expect (answers):
1. "Who approved 'powered by Castrol'?" Nobody yet. It is our proposed co-brand under the showcase partnership, subject to Castrol's brand approval. Until Castrol approves it, we use "KAD OS" alone.
2. "Why should we give you better terms?" Because the terms buy Castrol something measurable: outlet-level coverage and shelf data, a live showcase market and a playbook for other distributors. We propose to tie the terms to KPIs we agree together, such as Castrol presence and full-range share.
3. "Can a rep fake a visit?" A rep can only check in within a set distance of the outlet (300 m by default), with GPS accuracy recorded, a photo and an audit trail that cannot be edited. Wrong outlet locations are detected from repeated GPS evidence.
4. "Does this scale beyond one company?" Each distributor gets its own copy with its own database. A separate demo copy already runs, the system has about 1,200 automated tests, and we ship improvements every week.
5. "What data would Castrol get, and is it legal to share?" Operational data stays with the distributor. Castrol receives aggregated, anonymised reports: coverage, presence, full range and sell-out trends. No customer-level personal data is shared.
"""

# ---------------------------------------------------------------- 1. Title
s = new_slide(); nxt()
box(s, 7.35, 0, SW - 7.35, 7.5, fill=RGBColor(0xF2, 0xF6, 0xF4), radius=0)
pic(s, KAD_LOGO, 0.75, 0.9, h=0.5)
ln = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(3.6), Inches(0.75), Inches(3.6), Inches(1.55)); ln.line.color.rgb = LINE; ln.line.width = Pt(1)
pic(s, CASTROL_LOGO, 4.0, 0.86, h=0.58)
lockup(s, 0.75, 2.35, size=60, w=6.2)
text(s, 0.75, 4.1, 6.2, 1.0, "The operating system for a modern Castrol distributor.", size=22, color=DARK, line=1.05)
box(s, 0.75, 5.3, 1.0, 0.06, fill=GREEN, radius=0)
box(s, 1.75, 5.3, 0.35, 0.06, fill=RED, radius=0)
text(s, 0.75, 5.55, 6.0, 0.4, "KAD Motors, Armenia · November 2026", size=15, color=GREY)
phone(s, "checkin", 7.55, 1.25, 5.3)
phone(s, "assistant", 10.6, 1.25, 5.3)
phone(s, "map", 8.95, 0.75, 6.1)
demo_tag(s, 9.25, 7.0)
notes(s, """
(About 60 seconds.) Good morning, and thank you for your time. I am here on behalf of KAD Motors, Castrol's distributor in Armenia.
In 12 minutes I want to show you three things. First, KAD runs on its own modern, AI-first distributor system: KAD OS. Second, KAD OS measurably grows Castrol's presence and share of shelf. Third, why KAD is the right partner to become Castrol's showcase digital distributor. I will finish with a concrete give-and-get proposal.
A note on the name: "powered by Castrol" is our PROPOSED co-brand under the showcase partnership. It is subject to Castrol's approval and is part of what we ask for today. All app screens in this deck use demo data.
""" + Q_TOUGH)

# ---------------------------------------------------------------- 2. Executive summary
s = new_slide(); n = nxt()
header(s, "Executive summary", "KAD already runs on a complete, AI-first distributor system")
for i, lab in enumerate(["GPS-verified visits per month, before vs after", "Active customers, before vs after", "Castrol presence on audited shelves"]):
    pending(s, 0.6 + i * 4.1, 1.95, 3.9, 1.9, lab)
text(s, 0.6, 4.2, 12.1, 0.9, "Since August 2026 every visit, order, credit decision and payment at KAD runs through one system, with AI that finds problems and drives them to closure.", size=19, color=DARK, line=1.1)
box(s, 0.6, 5.45, 12.13, 1.05, fill=GREEN, radius=0.14)
text(s, 0.95, 5.45, 11.5, 1.05, [[("The ask: ", {"bold": True}), ("make KAD Castrol's showcase digital distributor.", {})]], size=22, color=WHITE, anchor=MSO_ANCHOR.MIDDLE)
footer(s, n)
notes(s, """
(60 seconds.) The short version. Since August 2026, KAD runs its whole commercial operation on one system, KAD OS: every visit is GPS-verified, every order, credit decision and payment is in one place, and an AI layer finds problems and drives them to closure.
[The three numbers on this slide will be filled from our live system before the meeting: visits per month before and after, active customers before and after, and Castrol presence on audited shelves.]
And the ask, in one line: make KAD Castrol's showcase digital distributor. The rest of the deck shows why that is a good decision for Castrol.
""")

# ---------------------------------------------------------------- 3. KAD Motors
s = new_slide(); n = nxt()
header(s, "KAD Motors", "A Castrol distributor that plans to lead Armenia's oil market")
for i, (ic, lab) in enumerate([("store", "Castrol distributor in Armenia"), ("team", "Field, warehouse and finance teams"), ("mapPinCheck", "Customers across Armenia's regions")]):
    x = 0.6 + i * 2.27
    box(s, x, 2.0, 2.1, 2.05, fill=LIGHT)
    icon(s, ic, x + 0.22, 2.22, 0.75)
    text(s, x + 0.22, 3.12, 1.75, 0.9, lab, size=13.5, bold=True)
text(s, 0.6, 4.45, 6.6, 0.3, "WHO WE SERVE", size=12, bold=True, color=GREY)
for i, (ic, lab) in enumerate([("gauge", "Workshops & garages"), ("repeat", "Oil-change points"), ("store", "Auto-parts shops"), ("truck", "Fleets & car dealers")]):
    x = 0.6 + i * 1.7
    icon(s, ic, x + 0.38, 4.9, 0.78)
    text(s, x, 5.78, 1.55, 0.6, lab, size=12.5, align=PP_ALIGN.CENTER)
box(s, 7.65, 2.0, 5.08, 4.5, fill=GREEN, radius=0.18)
text(s, 8.05, 2.3, 4.4, 0.3, "OUR AMBITION", size=12, bold=True, color=WHITE)
text(s, 8.05, 2.65, 4.4, 1.0, "No. 1 in Armenia's oil market", size=26, bold=True, color=WHITE, line=0.95)
for i, d in enumerate(["Volume", "Revenue", "Reputation", "Technology"]):
    x = 8.05 + (i % 2) * 2.2
    y = 3.9 + (i // 2) * 0.68
    box(s, x, y, 2.05, 0.52, fill=GREEN_DARK, radius=0.26)
    icon(s, "checkCircle", x + 0.1, y + 0.08, 0.36, bg=None, color="w", ratio=1.0)
    text(s, x + 0.55, y + 0.1, 1.45, 0.35, d, size=14, bold=True, color=WHITE)
text(s, 8.05, 5.45, 4.4, 0.8, "Technology is how we win the other three.", size=15, bold=True, color=WHITE)
footer(s, n)
notes(s, """
(60 seconds.) KAD Motors is a Castrol distributor in Armenia, with field sales, warehouse and finance teams and customers across the country's regions: workshops and garages, oil-change points, auto-parts shops, fleets and car dealers.
Our ambition is clear: to be No. 1 in Armenia's oil market, in volume, revenue, reputation and technology. We see technology as the lever for the other three, and that is why we built KAD OS.
""")

# ---------------------------------------------------------------- 4. Challenge
s = new_slide(); n = nxt()
header(s, "The distributor challenge", "Most distributors cannot prove what happens in the market")
ch = [("mapWarning", "0", "verified visits", "No proof that field work happens, or where."),
      ("clock", "Late", "orders, credit, stock", "Problems surface weeks after the money is lost."),
      ("eye", "0", "outlets with shelf data", "The brand owner cannot see its own shelf.")]
for i, (ic, big, unit, body) in enumerate(ch):
    x = 0.6 + i * 4.1
    box(s, x, 1.95, 3.9, 3.9, fill=LIGHT)
    icon(s, ic, x + 0.3, 2.25, 0.85, bg=RED_TINT, color="r")
    text(s, x + 0.3, 3.3, 3.4, 0.8, big, size=40, bold=True, color=RED)
    text(s, x + 0.3, 4.1, 3.4, 0.4, unit, size=15, bold=True)
    text(s, x + 0.3, 4.6, 3.3, 0.9, body, size=13.5, color=GREY)
text(s, 0.6, 6.2, 12.1, 0.5, "This was KAD before KAD OS, and it is still the norm for distributors in our region.", size=14, color=GREY)
footer(s, n)
notes(s, """
(60 seconds.) This is the challenge every distributor knows. Before KAD OS we had zero verified visits: no proof that field work happened, or where. Orders, credit and stock were visible late, so problems surfaced weeks after the money was lost. And we had zero outlets with shelf data: the brand owner, Castrol, could not see its own shelf through us.
This is still the norm for distributors in our region. KAD OS was built to remove all three blind spots.
""")

# ---------------------------------------------------------------- 5. Module map
s = new_slide(); n = nxt()
header(s, "One OS, every function", "One system runs every function of a Castrol distributor")
live = [("mapPinCheck", "Field Sales & Visits", "GPS check-in, photo, shelf audit"),
        ("customers", "Customers & Map", "CRM, routes, coverage"),
        ("cart", "Orders & Pricing", "Tier prices, discount rules"),
        ("wallet", "Credit & Collections", "Limits, debt by invoice, tasks"),
        ("target", "Targets & Bonuses", "Plans, points, scorecards"),
        ("chart", "Analytics", "Live dashboards and reports"),
        ("send", "Executive Assistant", "Daily management report"),
        ("sparkles", "AI agents", "AI deputy director, AI analyst"),
        ("link", "Integration API", "Accounting and partner feeds")]
nextm = [("truck", "Delivery & Driver", "Routes, arrival, e-signature"), ("box", "Warehouse", "Picking, packing, live stock")]
for i, (ic, title, body) in enumerate(live + nextm):
    x = 0.6 + (i % 4) * 3.07
    y = 1.9 + (i // 4) * 1.62
    nx = i >= len(live)
    box(s, x, y, 2.92, 1.45, fill=WHITE if nx else GREEN_TINT, line=GREY if nx else None, line_w=1.0, dash=nx)
    icon(s, ic, x + 0.18, y + 0.2, 0.62, bg=LIGHT if nx else WHITE, color="k" if nx else "g")
    text(s, x + 0.95, y + 0.17, 1.9, 0.62, title, size=13.5, bold=True, anchor=MSO_ANCHOR.MIDDLE, line=0.95, color=GREY if nx else DARK)
    text(s, x + 0.18, y + 0.92, 2.65, 0.45, body, size=11, color=GREY)
    if nx:
        box(s, x + 1.55, y - 0.15, 1.27, 0.3, fill=DARK, radius=0.15)
        text(s, x + 1.55, y - 0.15, 1.27, 0.3, "LAUNCHING NEXT", size=8.5, bold=True, color=WHITE, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
x = 0.6 + 3 * 3.07
y = 1.9 + 2 * 1.62
box(s, x, y, 2.92, 1.45, fill=GREEN, radius=0.12)
text(s, x + 0.2, y + 0.12, 2.55, 1.25, [[("LIVE TODAY", {"bold": True, "size": 10})], [("9 modules on one cloud database and one mobile web app", {"bold": True, "size": 13})]], color=WHITE, anchor=MSO_ANCHOR.MIDDLE, spacing=3)
footer(s, n)
notes(s, """
(60 seconds.) This is KAD OS on one page. Nine modules are live today, all on one cloud database and one mobile web app: Field Sales and Visits; Customers and Map; Orders and Pricing; Credit and Collections; Targets and Bonuses; Analytics; the Executive Assistant, which sends management a daily report; AI agents; and an Integration API that connects accounting systems and partner data feeds.
Two modules are launching next: Delivery and Driver, and Warehouse. I will not present them as live; they are the next steps on the same core.
""")

# ---------------------------------------------------------------- 6. A day in KAD OS
s = new_slide(); n = nxt()
header(s, "A day in KAD OS", "From the shop counter to the CEO's phone, in one flow")
day = [("checkin", "09:40", "Rep checks in", "GPS + photo at the outlet"), ("order", "09:52", "Takes the order", "Tier prices, usual basket"),
       ("orders", "09:53", "Manager sees it live", "Approves in one tap"), ("assistant", "19:00", "CEO gets the report", "Sales, cash, debt, risks")]
for i, (shot, t, title, body) in enumerate(day):
    x = 0.75 + i * 3.1
    w, h = phone(s, shot, x, 1.7, 3.95)
    cx = x + w / 2
    box(s, cx - 0.45, 5.75, 0.9, 0.32, fill=GREEN, radius=0.16)
    text(s, cx - 0.45, 5.75, 0.9, 0.32, t, size=11, bold=True, color=WHITE, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(s, cx - 1.4, 6.13, 2.8, 0.32, title, size=14, bold=True, align=PP_ALIGN.CENTER)
    text(s, cx - 1.4, 6.45, 2.8, 0.3, body, size=11, color=GREY, align=PP_ALIGN.CENTER)
    if i < 3:
        a = s.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Inches(x + 2.55), Inches(3.55), Inches(0.42), Inches(0.36))
        a.fill.solid(); a.fill.fore_color.rgb = GREEN; a.line.fill.background()
footer(s, n)
notes(s, """
(60 seconds.) Here is one day in KAD OS, with demo data.
At 09:40 a rep checks in at a shop: the phone confirms the GPS position and the rep adds a photo. At 09:52 the rep takes the order, from the customer's usual basket, at the right tier price. One minute later the sales manager sees the order live and can approve it in one tap. At 19:00 the CEO receives the evening report from the KAD OS Executive Assistant: sales, cash, debt and the risks to watch.
No paper, no phone calls, no re-typing, and no waiting for month-end.
""")

# ---------------------------------------------------------------- 7. Field execution = coverage
s = new_slide(); n = nxt()
header(s, "Field execution = market coverage", "Every verified visit becomes Castrol coverage data")
for name, x, title, body in [("checkin", 1.05, "GPS-verified visit", "Accepted only within 300 m of the outlet."),
                             ("shelf_audit", 5.2, "Shelf audit, every visit", "Castrol present, full range, fake products."),
                             ("map", 9.25, "Customer map", "Every outlet, its visits and its plan.")]:
    if name == "shelf_audit":
        w, h = pic(s, os.path.join(SHOTS, "shelf_audit.png"), x + 0.05, 1.95, h=3.6)
    else:
        w, h = phone(s, name, x, 1.75, 4.0)
    cx = x + w / 2
    text(s, cx - 1.75, 5.82, 3.5, 0.35, title, size=16, bold=True, align=PP_ALIGN.CENTER)
    text(s, cx - 1.75, 6.17, 3.5, 0.5, body, size=12.5, color=GREY, align=PP_ALIGN.CENTER)
footer(s, n)
notes(s, """
(60 seconds.) Field execution is market coverage. Each visit is verified: a rep can only check in within 300 metres of the outlet, a limit management can change, and the visit is stored with its GPS accuracy and a photo.
At each visit the rep records the Castrol shelf: present or not, full range or not, and whether there are fake or parallel-market products. The customer map shows every outlet, when it was last visited and when it is planned next.
For Castrol this means something new: outlet-level evidence of coverage and shelf presence, not just sell-in invoices.
""")

# ---------------------------------------------------------------- 8. Commercial & financial control
s = new_slide(); n = nxt()
header(s, "Commercial & financial control", "Prices, credit and cash follow rules, not memory")
phone(s, "order", 0.55, 1.75, 4.9)
phone(s, "customer", 3.15, 1.75, 4.9)
for i, (ic, title, body) in enumerate([("tag", "Central tier pricing", "Reps never type a price."),
                                       ("checkCircle", "Discount rules", "Over 3% needs approval; below cost, the CEO."),
                                       ("wallet", "Credit limits", "Over the limit, the order waits for approval."),
                                       ("history", "Debt and collections", "Aged per invoice; overdue becomes a task."),
                                       ("target", "Targets and bonuses", "Each rep sees plan, progress and points.")]):
    y = 1.95 + i * 0.95
    icon(s, ic, 6.35, y, 0.7)
    text(s, 7.3, y, 5.4, 0.35, title, size=17, bold=True)
    text(s, 7.3, y + 0.37, 5.4, 0.4, body, size=13, color=GREY)
footer(s, n)
notes(s, """
(60 seconds.) Commercial and financial control is built in. Prices come from central tier price lists; reps never type a price. Discounts up to 3% are automatic, larger ones need management approval, and anything below our cost needs the CEO.
Every customer can have a credit limit; an order over the limit waits for approval. Debt is aged invoice by invoice, and an overdue invoice automatically becomes a collection task for the rep. Each rep sees their own plan, progress and bonus points.
The result is margin protection and cash discipline, enforced by the system rather than by memory.
""")

# ---------------------------------------------------------------- 9. Real-time management
s = new_slide(); n = nxt()
header(s, "Real-time management", "Management sees the business live, every day")
phone(s, "dashboard", 0.55, 1.75, 4.9)
phone(s, "assistant", 3.15, 1.75, 4.9)
for i, (ic, lab) in enumerate([("chart", "Sales vs plan"), ("wallet", "Cash collected"), ("mapPinCheck", "Visits & coverage"),
                               ("layers", "Litres by product line"), ("history", "Debt ageing"), ("team", "Rep scorecards")]):
    x = 6.35 + (i % 2) * 3.2
    y = 1.95 + (i // 2) * 1.0
    box(s, x, y, 3.0, 0.82, fill=LIGHT, radius=0.12)
    icon(s, ic, x + 0.14, y + 0.13, 0.56)
    text(s, x + 0.85, y, 2.1, 0.82, lab, size=14.5, bold=True, anchor=MSO_ANCHOR.MIDDLE)
box(s, 6.35, 5.1, 6.2, 1.4, fill=GREEN, radius=0.14)
icon(s, "send", 6.6, 5.37, 0.85, bg=WHITE)
text(s, 7.7, 5.1, 4.7, 1.4, [[("KAD OS Executive Assistant", {"bold": True, "size": 17})], [("Daily, weekly and monthly reports on the CEO's phone, with the risks to act on.", {"size": 13.5})]], color=WHITE, anchor=MSO_ANCHOR.MIDDLE, spacing=3)
footer(s, n)
notes(s, """
(60 seconds.) Management works in real time. The company dashboard shows sales against plan by channel and by rep, cash collected, visits and coverage, litres by product line, debt ageing and a scorecard for every rep.
On top of that, the KAD OS Executive Assistant sends the CEO a daily, weekly and monthly report on the phone: what we sold, what we collected, what is overdue, which products are running low and which numbers look unusual. Management spends its time on decisions, not on building reports.
""")

# ---------------------------------------------------------------- 10. Results
s = new_slide(); n = nxt()
header(s, "Results", "Results since KAD OS went live")
for i, lab in enumerate(["Verified visits per month: before → after", "Active customers: before → after", "Castrol presence on audited shelves (%)", "Monthly orders and collections trend, in % and USD/EUR"]):
    pending(s, 0.6 + (i % 2) * 6.15, 1.95 + (i // 2) * 2.1, 5.95, 1.85, lab, size=14)
text(s, 0.6, 6.3, 12.1, 0.5, "Numbers come only from KAD OS data (aggregated, no customer detail). Exchange rate to be stated with the figures.", size=12, color=GREY)
footer(s, n)
notes(s, """
(60 seconds.) [To be completed with verified figures from the live system before the meeting: verified visits per month before and after, active customers before and after, Castrol presence on audited shelves, and the monthly order and collection trend in percent and in US dollars or euros, with the exchange rate stated.]
Speaking guidance: give each number with its period, and be precise about cause and effect. KAD OS went live in August 2026, so the "after" period is short; say so openly.
""")

# ---------------------------------------------------------------- 11. AI-first
s = new_slide(); n = nxt()
header(s, "AI-first distributor", "AI finds the problems and drives them to closure")
phone(s, "vaghinak", 0.55, 1.75, 4.9)
phone(s, "vaghinak_rep", 3.15, 1.75, 4.9)
text(s, 6.35, 1.85, 6.3, 0.3, "LIVE TODAY", size=12, bold=True, color=GREEN)
for i, (ic, title, body) in enumerate([("vaghinak", "AI deputy director", "Watches the field day; assigns, chases and escalates tasks"),
                                       ("sparkles", "AI analyst", "Answers management questions from the data, anonymised"),
                                       ("tasks", "Self-closing tasks", "Debt, reorder and data tasks close when the fix lands")]):
    y = 2.25 + i * 0.95
    icon(s, ic, 6.35, y, 0.66)
    text(s, 7.2, y, 5.4, 0.33, title, size=15.5, bold=True)
    text(s, 7.2, y + 0.35, 5.4, 0.4, body, size=12.5, color=GREY)
text(s, 6.35, 5.2, 6.3, 0.3, "NEXT", size=12, bold=True, color=GREY)
box(s, 6.35, 5.55, 6.2, 0.95, fill=WHITE, line=GREY, radius=0.12, line_w=1.0, dash=True)
text(s, 6.6, 5.55, 5.8, 0.95, "Expert AI agents for sales, finance and stock, led by the AI deputy director", size=13.5, color=DARK, anchor=MSO_ANCHOR.MIDDLE)
text(s, 0.55, 6.72, 5.3, 0.22, "Demo data. Left: brief to management. Right: a rep's must-answer question.", size=9, color=GREY)
footer(s, n)
notes(s, """
(60 seconds.) KAD OS is AI-first. Live today: an AI deputy director that watches the field day. It notices late starts, missing visits, a rep stuck in the office or skipping nearby planned shops, overdue debt, slow orders and missing data. It assigns a task to the right person with a deadline, chases it, and escalates to management only when the plan slips. A rep must answer some of its questions before carrying on.
Also live: an AI analyst that answers management questions from the data, with customers and staff replaced by anonymous codes. And tasks close themselves when the fix lands, for example when a payment arrives.
Next: expert AI agents for sales, finance and stock, led by the AI deputy director. That part is not live yet.
""")

# ---------------------------------------------------------------- 12. 3 stages
s = new_slide(); n = nxt()
header(s, "Growing Castrol's share", "Three stages to win the shelf, each tracked by a KPI")
stages = [("STAGE 1", "Presence", "70% of customers carry at least one Castrol product", "KPI: Castrol presence %", GREEN_TINT, DARK, GREY),
          ("STAGE 2", "Full range", "Full Castrol product lines on the shelf", "KPI: full-range %", GREEN_MID, DARK, DARK),
          ("STAGE 3", "Preference", "Customers sell mostly Castrol", "KPI: Castrol-only shelves %", GREEN, WHITE, WHITE)]
for i, (k, title, target, kpi, fill, tc, mc) in enumerate(stages):
    x = 0.6 + i * 2.72
    h = 2.85 + i * 0.75
    y = 6.45 - h
    box(s, x, y, 2.58, h, fill=fill, radius=0.14)
    text(s, x + 0.22, y + 0.22, 2.2, 0.3, k, size=11, bold=True, color=GREEN_DARK if i < 2 else WHITE)
    text(s, x + 0.22, y + 0.5, 2.2, 0.45, title, size=20, bold=True, color=tc)
    text(s, x + 0.22, y + 1.0, 2.15, 1.0, target, size=13.5, bold=True, color=tc)
    text(s, x + 0.22, y + h - 0.7, 2.15, 0.5, kpi, size=11.5, bold=True, color=mc)
w, h = pic(s, os.path.join(SHOTS, "shelf_audit.png"), 9.3, 1.85, h=4.05)
text(s, 9.3 + w / 2 - 1.5, 5.95, 3.0, 0.5, "Recorded at every visit (demo)", size=11.5, color=GREY, align=PP_ALIGN.CENTER)
footer(s, n)
notes(s, """
(60 seconds.) Here is how KAD OS grows Castrol's share, in three stages, each tracked by a KPI.
Stage one, presence: 70% of our customers carry at least one Castrol product. The KPI is Castrol presence, measured outlet by outlet in the shelf audit.
Stage two, full range: complete Castrol product lines on the shelf. The KPI is the full-range share in the same audit.
Stage three, preference: our customers sell mostly Castrol. The KPI is the share of shelves where the audit finds Castrol and no competitor brand.
Because every stage is measured per outlet, per rep and per region, the AI deputy director turns the gaps into tasks.
""")

# ---------------------------------------------------------------- 13. Why not SAP / Salesforce
s = new_slide(); n = nxt()
header(s, "Why not SAP or Salesforce?", "Built for distributor reality, at a fraction of the cost")
rows = [("", "KAD OS", "Generic enterprise suites"),
        ("Built for", "Castrol distribution: visits, shelf, credit, cash", "Any industry, configured by consultants"),
        ("Device", "Mobile-first, any iPhone or Android, from a link", "Desktop-first, app-store installs"),
        ("No signal", "Works offline, sends when back online", "Mostly needs a connection"),
        ("Low-end phones", "Speed budgets tested on a slow phone", "Heavy clients"),
        ("Time to live", "Live in weeks (August 2026), improved weekly", "Long projects with integrators"),
        ("Cost", "No per-user licences; one cloud server", "Per-user licences plus integrator fees")]
tbl = s.shapes.add_table(len(rows), 3, Inches(0.6), Inches(1.9), Inches(12.13), Inches(4.6)).table
for i, wv in enumerate([2.3, 5.2, 4.63]):
    tbl.columns[i].width = Inches(wv)
for r, row in enumerate(rows):
    for c, val in enumerate(row):
        cell = tbl.cell(r, c)
        cell.fill.solid()
        cell.fill.fore_color.rgb = (GREEN if c == 1 else DARK if c == 2 else WHITE) if r == 0 else (GREEN_TINT if c == 1 else (LIGHT if c == 2 else WHITE))
        cell.margin_left = cell.margin_right = Inches(0.15)
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        p = cell.text_frame.paragraphs[0]; p.text = ""
        run = p.add_run(); run.text = val
        run.font.name = FONT; run.font.size = Pt(14 if r == 0 else 13)
        run.font.bold = r == 0 or c == 0 or c == 1
        run.font.color.rgb = WHITE if r == 0 else (GREEN_DARK if c == 1 else (GREY if c == 2 else DARK))
footer(s, n)
notes(s, """
(60 seconds.) A fair question is: why not SAP or Salesforce? Those are strong general systems, but they are built for any industry and configured by consultants. KAD OS is built for the reality of a Castrol distributor: visits, shelf, credit and cash.
It is mobile-first and opens from a link on any phone; it works without signal and sends the data when the phone is back online; it is tested against speed budgets on a slow phone. It went live in weeks, in August 2026, and improves every week. And there are no per-user licences: it runs on one cloud server, at a fraction of the cost of an enterprise rollout.
""")

# ---------------------------------------------------------------- 14. The proposal
s = new_slide(); n = nxt()
header(s, "The proposal", "KAD OS, powered by Castrol: your showcase digital distributor", size=28)
pic(s, CASTROL_LOGO, SW - 0.6 - 0.45 * 594 / 140, 0.22, h=0.45)
cols = [("WHAT KAD GIVES CASTROL", GREEN, WHITE, ["A live showcase market for Castrol's digital distributor model, with site visits and demos",
                                                  "Regular anonymised sell-out, coverage and share-of-shelf reports",
                                                  "A documented playbook and reference case for other distributors",
                                                  "First-in-line testing of Castrol programmes and launches"]),
        ("WHAT KAD ASKS FROM CASTROL", WHITE, DARK, ["Official “Digital Distributor Showcase” status and approval of the “powered by Castrol” co-brand",
                                                    "Improved commercial terms: pricing tier, rebates, credit terms",
                                                    "Co-investment and marketing support for the next KAD OS modules and market activation",
                                                    "Priority supply and access to Castrol product data, training and digital programmes"])]
for i, (title, fill, tc, items) in enumerate(cols):
    x = 0.6 + i * 6.15
    box(s, x, 1.85, 5.98, 4.15, fill=fill, line=None if fill == GREEN else GREEN, line_w=1.5, radius=0.16)
    text(s, x + 0.35, 2.05, 5.3, 0.35, title, size=13, bold=True, color=tc if fill == GREEN else GREEN_DARK)
    for j, it in enumerate(items):
        yy = 2.55 + j * 0.85
        icon(s, "checkCircle", x + 0.35, yy + 0.02, 0.32, bg=None, color="w" if fill == GREEN else "g", ratio=1.0)
        text(s, x + 0.82, yy, 4.95, 0.8, it, size=13.5, color=tc)
box(s, 0.6, 6.15, 12.13, 0.68, fill=DARK, radius=0.12)
text(s, 0.95, 6.15, 11.6, 0.68, [[("Next step: ", {"bold": True}), ("a working session with the relevant Castrol teams within 30 days, to agree scope, KPIs and terms.", {})]], size=14.5, color=WHITE, anchor=MSO_ANCHOR.MIDDLE)
footer(s, n)
notes(s, """
(60 seconds.) Our proposal: KAD OS, powered by Castrol, as your showcase digital distributor.
What KAD gives Castrol: a live showcase market for Castrol's digital distributor model, where Castrol teams can visit and see it working; regular anonymised sell-out, coverage and share-of-shelf reports; a documented playbook and reference case for other distributors; and first-in-line testing of Castrol programmes and launches.
What we ask from Castrol: official Digital Distributor Showcase status and approval of the "powered by Castrol" co-brand; improved commercial terms on pricing tier, rebates and credit terms; co-investment and marketing support for the next KAD OS modules and market activation; and priority supply and access to Castrol product data, training and digital programmes.
Please note: "powered by Castrol" is our PROPOSED co-brand under this partnership and is used only with Castrol's approval. We have deliberately put no figures on the asks; we would like to agree them together, tied to KPIs.
Next step: a working session with the relevant Castrol teams within 30 days, to agree scope, KPIs and terms.
""" + Q_TOUGH)

# ---------------------------------------------------------------- Appendix A1: architecture
s = new_slide(); n = nxt()
header(s, "Appendix · Architecture", "One core system with a secure integration API")
users = [("person", "Field reps"), ("team", "Managers"), ("box", "Warehouse"), ("wallet", "Accounting")]
for i, (ic, lab) in enumerate(users):
    y = 1.95 + i * 1.08
    box(s, 0.6, y, 2.6, 0.9, fill=LIGHT, radius=0.12)
    icon(s, ic, 0.75, y + 0.15, 0.6)
    text(s, 1.5, y, 1.65, 0.9, lab, size=14, bold=True, anchor=MSO_ANCHOR.MIDDLE)
text(s, 0.6, 6.33, 2.6, 0.4, "Mobile web app, any phone or PC", size=11, color=GREY, align=PP_ALIGN.CENTER)
for y in (2.4, 3.48, 4.56, 5.64):
    a = s.shapes.add_shape(MSO_SHAPE.LEFT_RIGHT_ARROW, Inches(3.3), Inches(y - 0.15), Inches(0.75), Inches(0.3))
    a.fill.solid(); a.fill.fore_color.rgb = GREEN_MID; a.line.fill.background()
box(s, 4.15, 1.95, 4.6, 4.3, fill=GREEN, radius=0.18)
text(s, 4.45, 2.15, 4.0, 0.35, "KAD OS CORE", size=13, bold=True, color=WHITE)
for i, lab in enumerate(["Cloud database (PostgreSQL)", "Business rules: prices, credit, roles", "AI agents and AI analyst", "Reports and Executive Assistant", "Offline-ready mobile web app"]):
    y = 2.65 + i * 0.68
    box(s, 4.45, y, 4.0, 0.56, fill=GREEN_DARK, radius=0.1)
    text(s, 4.65, y, 3.7, 0.56, lab, size=13, bold=True, color=WHITE, anchor=MSO_ANCHOR.MIDDLE)
a = s.shapes.add_shape(MSO_SHAPE.LEFT_RIGHT_ARROW, Inches(8.85), Inches(3.95), Inches(0.75), Inches(0.3))
a.fill.solid(); a.fill.fore_color.rgb = GREEN_MID; a.line.fill.background()
box(s, 9.7, 1.95, 3.03, 4.3, fill=WHITE, line=GREEN, radius=0.16, line_w=1.5)
text(s, 9.9, 2.15, 2.7, 0.35, "INTEGRATION API", size=13, bold=True, color=GREEN_DARK)
for i, lab in enumerate(["Accounting systems", "AI accounting integration", "Partner data feeds", "Brand-owner reports (proposed)"]):
    y = 2.65 + i * 0.85
    icon(s, "link", 9.9, y + 0.07, 0.45, bg=GREEN_TINT)
    text(s, 10.45, y, 2.2, 0.62, lab, size=12.5, bold=True, anchor=MSO_ANCHOR.MIDDLE)
footer(s, n)
notes(s, """
For digital and IT colleagues. KAD OS is one core system: a cloud PostgreSQL database with the business rules (prices, credit, roles), the AI agents and analyst, the reports and Executive Assistant, and an offline-ready mobile web app used by field reps, managers, warehouse and accounting on any phone or PC.
Around the core, a secure Integration API connects accounting systems, the AI accounting integration and partner data feeds. Reports to Castrol would use the same API; that part is proposed, not live.
""")

# ---------------------------------------------------------------- Appendix A2: security & data ownership
s = new_slide(); n = nxt()
header(s, "Appendix · Security & data ownership", "Secure by design, and the data stays with the distributor")
for i, (ic, title, body) in enumerate([("person", "Role-based access", "8 roles; every rule enforced on the server; a rep sees only own customers."),
                                       ("lock", "Encrypted transport", "HTTPS only; signed sessions, CSRF protection, rate limits, lockout."),
                                       ("shield", "Data ownership", "Data stays with the distributor; Castrol gets anonymised aggregates."),
                                       ("history", "Audit trail", "Immutable audit logs; order, price and customer change history."),
                                       ("sparkles", "AI privacy", "The AI analyst sees codes, never names, phones or tax IDs."),
                                       ("wifioff", "Offline safety", "Offline work is queued once and never duplicated.")]):
    x = 0.6 + (i % 3) * 4.1
    y = 1.95 + (i // 3) * 2.15
    box(s, x, y, 3.9, 1.95, fill=LIGHT)
    icon(s, ic, x + 0.25, y + 0.28, 0.75)
    text(s, x + 1.2, y + 0.3, 2.55, 0.5, title, size=15.5, bold=True)
    text(s, x + 1.2, y + 0.8, 2.55, 1.05, body, size=12, color=GREY)
text(s, 0.6, 6.4, 12.1, 0.4, "Quality: about 1,200 automated tests run on every change.", size=12.5, color=GREY)
footer(s, n)
notes(s, """
Security and data ownership. Access is role-based, with 8 roles, and every rule is enforced on the server: a rep only ever sees their own customers. All traffic is encrypted over HTTPS, with signed sessions, CSRF protection, rate limits and account lockout. Operational data stays with the distributor; Castrol would receive anonymised aggregates. There is a full audit trail: immutable audit logs and the change history of orders, prices and customers. The AI analyst only sees anonymous codes, never names, phones or tax IDs. Work done offline is queued once and never duplicated. About 1,200 automated tests run on every change.
""")

# ---------------------------------------------------------------- Appendix A3: integration API
s = new_slide(); n = nxt()
header(s, "Appendix · Integration API", "A secure API connects KAD OS to accounting and partners")
for i, (ic, title, body, status) in enumerate([("wallet", "Accounting API", "Invoices and waybills for confirmed orders, with status back to KAD OS. Token per system, stored hashed; test tokens see test orders only.", "LIVE"),
                                               ("database", "Accounting data feed", "Customers, debt, sales, prices, stock and plans flow in from the accounting system every day, matched by ID.", "LIVE"),
                                               ("store", "Customer ordering", "Partner endpoints let customers' own systems order from KAD directly (pilot with one customer).", "PILOT"),
                                               ("chart", "Brand-owner reports", "Anonymised coverage, presence and sell-out reports for Castrol.", "PROPOSED")]):
    y = 1.95 + i * 1.18
    box(s, 0.6, y, 12.13, 1.03, fill=LIGHT, radius=0.12)
    icon(s, ic, 0.8, y + 0.18, 0.66)
    text(s, 1.7, y + 0.12, 3.0, 0.8, title, size=15.5, bold=True, anchor=MSO_ANCHOR.MIDDLE)
    text(s, 4.6, y + 0.08, 6.4, 0.9, body, size=12.5, color=GREY, anchor=MSO_ANCHOR.MIDDLE)
    col = GREEN if status == "LIVE" else (DARK if status == "PILOT" else GREY)
    box(s, 11.35, y + 0.33, 1.2, 0.36, fill=col, radius=0.18)
    text(s, 11.35, y + 0.33, 1.2, 0.36, status, size=10, bold=True, color=WHITE, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
footer(s, n)
notes(s, """
The Integration API. Live: an accounting API that receives confirmed orders and produces invoices and waybills, reporting the status back; each connected system has its own token, stored hashed, and test tokens only see test orders. Live: a daily accounting data feed that brings customers, debt, sales, prices, stock and plans into KAD OS, matched by ID. Pilot: partner endpoints that let a customer's own system order from KAD directly, running with one customer. Proposed: anonymised coverage, presence and sell-out reports for Castrol.
""")

# Flat look in every renderer: drop the theme style reference (LibreOffice draws its shadow even with an empty effect list).
for sl in prs.slides:
    for el in sl.shapes._spTree.iter():
        if el.tag in (qn("p:sp"), qn("p:cxnSp")):
            st = el.find(qn("p:style"))
            if st is not None:
                el.remove(st)
prs.save(OUT)
print("saved", OUT, len(prs.slides._sldIdLst), "slides")
