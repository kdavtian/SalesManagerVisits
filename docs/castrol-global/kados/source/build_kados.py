# Builds ../../KAD_OS_Castrol_Global.pptx: KAD OS explained feature by feature - what it is, how it works step by step, screens and
# embedded demo videos (notes on every slide). Includes the owner's v4 edits of 2026-11-02.
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




VIDEOS = os.path.join(HERE, "..", "videos")
NO_VIDEO = os.environ.get("NO_VIDEO") == "1"   # the PDF export is built from a copy with stills instead of videos
FW, FH = 750.0, 1539.0          # framed phone image size (px)
SX, SY, SW_, SH_ = 82.5, 157.5, 585.0, 1266.0   # screenshot area inside the framed image (px)


def spot(slide, px, py, ph, xpt, ypt, n):
    """A numbered marker on a framed phone at (xpt, ypt) in app points (390 x 844 screen)."""
    k = ph / FH
    d = 0.36
    cx, cy = px + (SX + xpt * 1.5) * k, py + (SY + ypt * 1.5) * k
    c = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(cx - d / 2), Inches(cy - d / 2), Inches(d), Inches(d))
    c.fill.solid(); c.fill.fore_color.rgb = RED; c.line.color.rgb = WHITE; c.line.width = Pt(1.5)
    text(slide, cx - d / 2, cy - d / 2, d, d, str(n), size=11, bold=True, color=WHITE, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)


def steps_list(slide, x, y, w, total_h, steps, size_t=15, size_b=12):
    if len(steps) >= 6:
        size_t, size_b = 14, 11
    step = total_h / len(steps)
    for i, (title, body) in enumerate(steps):
        yy = y + i * step
        c = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x), Inches(yy), Inches(0.42), Inches(0.42))
        c.fill.solid(); c.fill.fore_color.rgb = GREEN; c.line.fill.background()
        text(slide, x, yy, 0.42, 0.42, str(i + 1), size=13, bold=True, color=WHITE, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
        text(slide, x + 0.6, yy - 0.03, w - 0.6, 0.35, title, size=size_t, bold=True)
        text(slide, x + 0.6, yy + 0.32, w - 0.6, step - 0.35, body, size=size_b, color=GREY)


def steps_slide(kicker, headline, phones, steps, talk, phone_h=4.85, caps=None):
    s = new_slide(); n = nxt()
    header(s, kicker, headline)
    gap = phone_h * 0.487 + 0.14
    for i, name in enumerate(phones):
        x = 0.45 + i * gap
        if name == "shelf_audit":
            pic(s, os.path.join(SHOTS, "shelf_audit.png"), x, 2.3, w=gap - 0.1)
        else:
            phone(s, name, x, 1.75, phone_h)
        if caps:
            text(s, x, 1.75 + phone_h - 0.02, gap - 0.14, 0.3, caps[i], size=10.5, bold=True, color=GREEN_DARK, align=PP_ALIGN.CENTER)
    right = 0.45 + len(phones) * gap + 0.2
    steps_list(s, right, 1.85, SW - 0.6 - right, 5.0, steps)
    footer(s, n)
    notes(s, talk)
    return s


def video_slide(kicker, headline, video, steps, talk):
    s = new_slide(); n = nxt()
    header(s, kicker, headline)
    ph = 5.05
    px, py = 1.0, 1.7
    pw, _ = pic(s, os.path.join(SHOTS, f"video_{video}.png"), px, py, h=ph)
    k = ph / FH
    if not NO_VIDEO:
      s.shapes.add_movie(os.path.join(VIDEOS, f"{video}.mp4"), Inches(px + SX * k), Inches(py + SY * k), Inches(SW_ * k), Inches(SH_ * k),
                       poster_frame_image=os.path.join(VIDEOS, f"{video}.jpg"), mime_type="video/mp4")
    box(s, 4.25, 1.95, 1.55, 0.42, fill=RED, radius=0.21)
    if NO_VIDEO:
        pic(s, os.path.join(VIDEOS, f"{video}.jpg"), px + SX * k, py + SY * k, w=SW_ * k)
    text(s, 4.25, 1.95, 1.55, 0.42, "▶  DEMO VIDEO", size=11, bold=True, color=WHITE, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(s, 4.25, 2.5, 8.4, 0.4, "What you see in the video", size=15, bold=True)
    steps_list(s, 4.25, 3.05, 8.4, 3.4, steps, size_t=14, size_b=11.5)
    text(s, 4.25, 6.5, 8.4, 0.3, "In this PDF: a still. The video plays in the PowerPoint version; the files are in kados/videos/." if NO_VIDEO else "Click the phone to play (PowerPoint). The video files are also in kados/videos/.", size=10, color=GREY)
    footer(s, n)
    notes(s, talk)


# ================================================================ 1. Title
s = new_slide(); nxt()
box(s, 7.35, 0, SW - 7.35, 7.5, fill=RGBColor(0xF2, 0xF6, 0xF4), radius=0)
pic(s, KAD_LOGO, 0.75, 0.9, h=0.5)
ln = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(3.6), Inches(0.75), Inches(3.6), Inches(1.55)); ln.line.color.rgb = LINE; ln.line.width = Pt(1)
pic(s, CASTROL_LOGO, 4.0, 0.86, h=0.58)
lockup(s, 0.75, 2.35, size=60, w=6.2)
text(s, 0.75, 4.1, 6.2, 1.0, "The operating system for a modern Castrol distributor.", size=22, line=1.05)
box(s, 0.75, 5.3, 1.0, 0.06, fill=GREEN, radius=0)
box(s, 1.75, 5.3, 0.35, 0.06, fill=RED, radius=0)
text(s, 0.75, 5.55, 6.0, 0.4, "The app, feature by feature · KAD Motors, Armenia · November 2026", size=15, color=GREY)
phone(s, "checkin", 7.55, 1.25, 5.3)
phone(s, "assistant", 10.6, 1.25, 5.3)
phone(s, "home_ceo", 8.95, 0.75, 6.1)
demo_tag(s, 9.25, 7.0)
notes(s, """
Thank you for your time. This presentation introduces KAD OS, the app our team built to run the daily work of a Castrol distributor in Armenia.
So we will go feature by feature: what each part does, how it works step by step, the real screens, and short demo videos.
All screens use demo data.
""")

# ================================================================ 3. What is KAD OS (owner's v4 version: no green bar)
s = new_slide(); n = nxt()
header(s, "What is KAD OS?", "One app for everyone in a Castrol distributor")
text(s, 0.6, 1.75, 12.1, 0.9, "Field sales, customers, orders, credit, cash, warehouse, delivery, the team and management reports in one system, with AI that keeps everyone on plan.", size=18, line=1.1)
roles = [("person", "Sales reps", "Visit, check in, take orders and payments"),
         ("target", "Sales director", "Plans routes, approves prices and credit"),
         ("box", "Warehouse", "Packs confirmed orders, counts stock"),
         ("truck", "Driver", "Delivers on an optimised route; customer signs"),
         ("wallet", "Accountant", "Invoices, payments and cash"),
         ("chart", "CEO", "Live dashboards and an evening report")]
for i, (ic, title, body) in enumerate(roles):
    x = 0.6 + i * 2.04
    box(s, x, 2.95, 1.9, 2.75, fill=LIGHT)
    icon(s, ic, x + 0.55, 3.15, 0.8)
    text(s, x + 0.1, 4.08, 1.7, 0.4, title, size=14.5, bold=True, align=PP_ALIGN.CENTER)
    text(s, x + 0.12, 4.48, 1.66, 1.1, body, size=11.5, color=GREY, align=PP_ALIGN.CENTER)
footer(s, n)
notes(s, """
KAD OS is one app for everyone in a distributor. Sales reps visit customers, check in, take orders and collect payments. The sales director plans routes and approves prices and credit. The warehouse packs confirmed orders and counts stock. The driver delivers on an optimised route and the customer signs on the phone. The accountant handles invoices, payments and cash. And the CEO sees live dashboards and gets an evening report.
Everyone opens it from a link on the phone or PC they already have, with no app store, and it keeps working without signal.
""")

# ================================================================ 4. Problems it solves (owner's v4 wording)
s = new_slide(); n = nxt()
header(s, "Problems it solves", "Six everyday problems, and how KAD OS solves each one")
pairs = [("mapWarning", "Visits hard to monitor", "GPS check-in with a photo at the field"),
         ("phone", "Orders by phone", "Orders in the app at fixed price lists"),
         ("wallet", "Overdue debt found late", "Debt per invoice and automatic collection tasks"),
         ("eye", "No view of the shelf", "A Castrol shelf check at every visit"),
         ("clock", "Reports that take days", "Live dashboards and daily evening reports"),
         ("warning", "Problems noticed too late", "An AI agent gives and chases tasks")]
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
notes(s, """
Six everyday problems of a distributor, and the answer we gave to each. Visits that are hard to monitor become GPS check-ins with a photo. Orders by phone become orders in the app at fixed price lists. Overdue debt found late becomes debt per invoice with automatic collection tasks. No view of the shelf becomes a Castrol shelf check at every visit. Reports that take days become live dashboards and daily evening reports. And problems noticed too late are picked up by an AI agent that gives and chases tasks.
""")

# ================================================================ 5. How it works
s = new_slide(); n = nxt()
header(s, "How it works", "How KAD OS works, in four simple steps")
steps4 = [("smartphone", "1. The team works in the app", "Visits, orders, payments, packing and deliveries are recorded where they happen"),
          ("checkCircle", "2. KAD OS checks the rules", "Prices, discounts, credit and stock, at once"),
          ("sparkles", "3. AI spots problems", "Gives a task to the right person, with a deadline"),
          ("chart", "4. Management sees it live", "Dashboards, reports and an evening summary")]
for i, (ic, title, body) in enumerate(steps4):
    x = 0.6 + i * 3.1
    hi = i in (1, 2)
    box(s, x, 1.95, 2.85, 2.9, fill=GREEN if hi else LIGHT)
    icon(s, ic, x + 0.25, 2.2, 0.8, bg=WHITE if hi else GREEN_TINT)
    text(s, x + 0.25, 3.15, 2.45, 0.7, title, size=15.5, bold=True, color=WHITE if hi else DARK, line=0.95)
    text(s, x + 0.25, 3.85, 2.45, 0.95, body, size=12.5, color=WHITE if hi else GREY)
    if i < 3:
        a = s.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Inches(x + 2.88), Inches(3.2), Inches(0.2), Inches(0.36))
        a.fill.solid(); a.fill.fore_color.rgb = GREEN_MID; a.line.fill.background()
box(s, 0.6, 5.2, 12.13, 1.45, fill=WHITE, line=GREEN, radius=0.14, line_w=1.25)
icon(s, "database", 0.85, 5.5, 0.85)
text(s, 1.95, 5.27, 10.6, 1.3, [[("One cloud system. ", {"bold": True}), ("Customers, products, orders, money, stock and tasks live in one secure database. The accounting system is connected through the integration API, so nobody types anything twice.", {})]], size=14, anchor=MSO_ANCHOR.MIDDLE)
footer(s, n)
notes(s, """
Four simple steps. One: the team works in the app, so visits, orders, payments, packing and deliveries are recorded where they happen. Two: KAD OS checks the rules at once: prices, discounts, credit and stock. Three: AI spots problems and gives a task to the right person, with a deadline. Four: management sees everything live.
Underneath there is one cloud system with one secure database, and the accounting system is connected through an integration API, so nobody types anything twice.
""")

# ================================================================ 6. The home screen (annotated)
s = new_slide(); n = nxt()
header(s, "The home screen", "One home screen: every part one tap away")
ph = 5.25; px, py = 0.7, 1.6
phone(s, "home_ceo", px, py, ph)
for (xpt, ypt, k) in [(300, 58, 1), (360, 150, 2), (360, 296, 3), (195, 770, 4)]:
    spot(s, px, py, ph, xpt, ypt, k)
legend = [("Notifications and menu", "Approvals, alerts and settings, top right"),
          ("This week's progress", "Visited today, remaining and overdue customers"),
          ("Quick actions", "Each tile opens a module (list on the right)"),
          ("Bottom bar", "Home, Activity, Map in the centre, Customers, Orders")]
for i, (t1, t2) in enumerate(legend):
    y = 1.85 + i * 1.12
    c = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(3.75), Inches(y), Inches(0.42), Inches(0.42))
    c.fill.solid(); c.fill.fore_color.rgb = RED; c.line.fill.background()
    text(s, 3.75, y, 0.42, 0.42, str(i + 1), size=13, bold=True, color=WHITE, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(s, 4.3, y - 0.03, 3.3, 0.35, t1, size=15, bold=True)
    text(s, 4.3, y + 0.33, 3.3, 0.7, t2, size=12, color=GREY)
box(s, 7.85, 1.75, 4.88, 4.95, fill=LIGHT)
text(s, 8.1, 1.9, 4.5, 0.3, "QUICK ACTIONS", size=12, bold=True, color=GREY)
tiles = [("mapPinCheck", "Check in", "start a visit"), ("tasks", "Tasks", "today's to-dos"), ("sparkles", "AI agent", "messages and questions"),
         ("customers", "Add new customer", "from the map"), ("payment", "Payments & expenses", "cash and receipts"), ("wallet", "Debt balances", "who owes what"),
         ("dashboard", "Dashboard", "sales vs plan"), ("target", "Team performance", "per rep"), ("chart", "Reports", "all reports"),
         ("box", "Warehouse app", "pack and stock"), ("truck", "Driver app", "routes and delivery"), ("clipboardCheck", "Stock count", "daily counting")]
for i, (ic, t1, t2) in enumerate(tiles):
    col, row = i % 2, i // 2
    x = 8.1 + col * 2.33
    y = 2.3 + row * 0.7
    icon(s, ic, x, y + 0.05, 0.42)
    text(s, x + 0.5, y, 1.8, 0.3, t1, size=11.5, bold=True)
    text(s, x + 0.5, y + 0.27, 1.8, 0.3, t2, size=10, color=GREY)
footer(s, n)
notes(s, """
This is the home screen, here as the CEO sees it. Number one, top right: notifications and the menu, where approvals, alerts and settings live. Number two: this week's progress, how many customers were visited today, how many remain and how many are overdue. Number three: the quick actions; every tile opens a module, from check-in and tasks to the warehouse and driver apps. Number four: the bottom bar with Home, Activity, the map in the centre, Customers and Orders.
Each role sees its own home: a rep starts the day with today's tasks, the warehouse with what to pack, the driver with the next stop.
""")

# ================================================================ 7. A day in KAD OS
s = new_slide(); n = nxt()
header(s, "A day in KAD OS", "The entire process from A to Z, in one flow")
day = [("checkin", "09:40", "Rep checks in", "GPS + photo at the customer"), ("order", "09:52", "Takes the order", "Right prices, usual basket"),
       ("wh_pack", "11:30", "Warehouse packs", "Tick lines, press Packed"), ("driver_home", "15:10", "Driver delivers", "Next stop, customer signs"),
       ("assistant", "19:00", "Reporting", "Sales, cash, debt, risks")]
for i, (shot_, t, title, body) in enumerate(day):
    x = 0.55 + i * 2.5
    w, h = phone(s, shot_, x, 1.75, 3.85)
    cx = x + w / 2
    box(s, cx - 0.45, 5.68, 0.9, 0.32, fill=GREEN, radius=0.16)
    text(s, cx - 0.45, 5.68, 0.9, 0.32, t, size=11, bold=True, color=WHITE, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    text(s, cx - 1.2, 6.06, 2.4, 0.32, title, size=13.5, bold=True, align=PP_ALIGN.CENTER)
    text(s, cx - 1.2, 6.38, 2.4, 0.3, body, size=10.5, color=GREY, align=PP_ALIGN.CENTER)
    if i < 4:
        a = s.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Inches(x + 2.02), Inches(3.5), Inches(0.36), Inches(0.32))
        a.fill.solid(); a.fill.fore_color.rgb = GREEN; a.line.fill.background()
footer(s, n)
notes(s, """
One day in KAD OS, with demo data. At 09:40 a rep checks in at a shop with GPS and a photo. At 09:52 the order is taken from the customer's usual basket at the right prices. Before noon the warehouse ticks the lines while picking and presses Packed. In the afternoon the driver follows the optimised route, and the customer signs on the driver's phone. At 19:00 the CEO gets the evening report. No paper, no calls, no re-typing.
""")

# ================================================================ CUSTOMERS
steps_slide("Customers & map", "Existing and potential customers, on one map", ["map", "customers"],
    [("Every customer on the map", "Pins show the type and visit status; tap a pin for debt, last order and last visit"),
     ("Existing and potential customers", "We add shops that do not buy yet, with a potential level and reasons"),
     ("New customer from the map", "The rep adds the shop where he stands; region and rep are filled in automatically"),
     ("Search everything", "Name, ID, phone, address or social profile in one search box"),
     ("Visit plans", "Each customer has a visit frequency; overdue customers are flagged")],
    """
All customers are on the map and in one list: not only the shops that already buy from us, but also potential customers, the shops we want to win. A pin shows the customer type and visit status, and one tap shows debt, last order and last visit.
A rep adds a new customer directly from the map, where he stands; the region and the responsible rep are filled in automatically. One search box finds a customer by name, ID, phone, address or social profile. Every customer has a visit frequency, and customers not visited on time are flagged.
""", caps=["Map", "Customer list"])

steps_slide("Customers & map", "Advanced filters find the right customers in seconds", ["filter_assignment", "filter_region", "potential_card"],
    [("By channel and rep", "Pick sales channels and reps in one tree"),
     ("By region and district", "Every region opens into its districts"),
     ("By products on the shelf", "For example: shops with fake product, or without Castrol"),
     ("By potential", "Level, reason, follow-up date and expected volume"),
     ("By visit status", "Visited, overdue or never visited, with counts")],
    """
Filters are where the app saves the most time. Customers can be filtered by sales channel and rep in one tree, by region and district, by the products found on their shelf (for example shops with fake product or without Castrol), by potential level and reason, and by visit status.
For a potential customer we record the potential level, the reasons (for example price mismatch or a competitor contract), the expected volume in litres per month and the next follow-up date, so reps know exactly who to win next.
""", phone_h=4.4, caps=["Channel & rep", "Region", "Potential customer"])

steps_slide("Customer card", "Everything about a customer, on one screen", ["customer", "customer_more"],
    [("Profile", "Address, phone, channel, rep, visit frequency, payment term, credit limit"),
     ("Money at a glance", "Sales this month and outstanding debt, with a due-date chip and last payment"),
     ("Dates that matter", "Last order and last visit; next planned visit"),
     ("Products at this shop", "Castrol on the shelf, full range, competitors seen"),
     ("Visit history and actions", "Check in, new task, new order, navigate, files")],
    """
The customer card puts everything about a customer on one screen. The profile: address, phone, sales channel and rep, how often to visit, payment term and credit limit. Money at a glance: sales this month, and outstanding debt with a chip showing when it is due and the date of the last payment. The dates that matter: last order, last visit and next planned visit.
Lower down: the products at this shop from the latest shelf check, the visit history, and one-tap actions: check in, new task, new order, navigate, and files.
""", caps=["Top of the card", "Scrolled down"])

steps_slide("Customer card", "One tap opens the full detail", ["last_order", "debt_sheet", "map_popup"],
    [("Tap Last order", "The full order opens: every product, quantity and amount, with Reorder"),
     ("Tap Outstanding debt", "Every payment received, and a one-page debt statement for the customer"),
     ("Tap a pin on the map", "Debt, last order, last visit and Check In, without leaving the map"),
     ("Long-press New order", "Order the usual basket or repeat any past order")],
    """
Every tile on the card opens its detail. Tap Last order and the whole order opens: every product, quantity and amount, with a Reorder button. Tap Outstanding debt and you see every payment received, and you can produce a one-page debt statement for the customer. On the map, tapping a pin shows the same key facts and a Check In button without leaving the map. And a long press on New order offers the usual basket or a repeat of any past order.
""", phone_h=4.4, caps=["Last order", "Payments received", "Map pin"])

video_slide("Customer card", "Demo: from the customer list to the full picture", "customer",
    [("Search", "Type part of the name; the list filters as you type"),
     ("Open the card", "Profile, money, dates, products at this shop"),
     ("Last order", "Tap the tile: the full order list opens"),
     ("Payments", "Tap the debt tile: payments received and debt statement")],
    "This short video shows the customer card in action: searching for a customer, opening the card, opening the last order with all its lines, and the payments received behind the debt tile.")

# ================================================================ CHECK-IN
steps_slide("Check-in", "Check-in, step by step", ["checkin", "checkin_outcome", "competitors"],
    [("Open the customer, tap Check In", "The phone finds the GPS position at once"),
     ("Location verified", "Accepted only within 300 m of the customer; the distance and accuracy are saved"),
     ("Choose what happened", "Order placed, payment collected, assortment check, delivery, revisit"),
     ("Record the shelf", "Castrol: available, full range, fake; competitors seen"),
     ("Note and photo", "A short note and a photo; high resolution for price tags"),
     ("Submit", "Works without signal; with Order placed, the order screen opens next")],
    """
Check-in step by step. The rep opens the customer and taps Check In; the phone finds the GPS position at once. The check-in is accepted only within 300 metres of the customer, and the real distance and GPS accuracy are saved with it. The rep chooses what happened: order placed, payment collected, assortment check, products delivered or a revisit. He records the shelf: Castrol available, full range or fake, and which competitors he saw. He adds a short note and a photo, in high resolution if he needs to capture price tags, and submits. It works without signal, and if an order was placed, the order screen opens next.
""", phone_h=4.4, caps=["Location verified", "Visit outcome", "Competitors"])

steps_slide("Check-in", "Visits that cannot be faked, and shelf data for the brand", ["checkin_far", "shelf_audit"],
    [("Too far? Refused", "6 km away, the app blocks the check-in and offers \"Wrong pin? See the map\""),
     ("Wrong pins are found", "Repeated GPS evidence shows customers whose map pin is wrong"),
     ("Visit length", "Start and end of each visit are recorded"),
     ("Castrol shelf check", "Available, full range or fake product, outlet by outlet"),
     ("Management sees it", "Visit history per customer and per rep, with time and place")],
    """
Why visits cannot be faked. If a rep is too far from the customer, here 6 kilometres, the app refuses the check-in and offers to check the map in case the customer's pin is wrong. Repeated GPS evidence from real visits reveals customers whose pin is in the wrong place, so management can fix it. The start and end of each visit are recorded.
And the shelf check gives the brand something it never had: outlet by outlet, whether Castrol is available, whether the full range is there, and whether there is fake product. Management sees all of it in the visit history, per customer and per rep.
""", caps=["Too far: refused", "Shelf check"])

video_slide("Check-in", "Demo: a complete check-in", "checkin",
    [("Open the customer", "Tap Check In: location verified in seconds"),
     ("Visit outcome", "Order placed and assortment check"),
     ("Competitors on the shelf", "Tick the brands seen"),
     ("Note and submit", "Then the order menu opens: new, usual or repeat")],
    "This video shows a complete check-in: the location is verified, the rep selects the visit outcome, ticks the competitor brands on the shelf, writes a note and submits. Because an order was placed, the order menu opens straight away.")

# ================================================================ ROUTES & FUEL (new, owner 2026-11-02)
steps_slide("Routes & fuel", "Weekly routes for every rep, and a fair fuel allowance", ["route_plan", "fuel", "fuel_how"],
    [("Weekly route plan", "Built automatically: each rep's customers spread over the week, nearby shops on the same day"),
     ("The real route of the day", "The day's check-ins in time order; the road distance between them is added up"),
     ("Only real visits count", "A check-in far from its customer is left out; check-ins at one place count once"),
     ("Home legs outside Yerevan", "If the day starts or ends outside the city, the way from and back home is added"),
     ("City and highway", "Km inside the city at the rep's city consumption, the rest at the lower highway rate"),
     ("Amount", "Litres x the month's fuel price; unusual days are flagged and management can correct them")],
    """
Our sales reps drive their own cars, so we pay a fuel allowance, and KAD OS calculates it from the work they really did.
First, every rep has a weekly route plan, built automatically: the rep's customers are spread over the working days, with nearby shops on the same day.
For the allowance, the app takes the rep's check-ins of each day in time order and adds up the road distance between them. A check-in made far from its customer is left out, and several check-ins at the same place count once. If the day starts or ends outside Yerevan, the way from home and back home is added.
Kilometres inside the city are paid at the rep's city consumption, the rest at the lower highway consumption, and the litres are multiplied by that month's fuel price. Days that look unusual, for example a very long leg, are flagged, and management can correct a day by hand.
""", phone_h=4.4, caps=["Weekly route plan", "Fuel allowance", "How it is calculated"])

# ================================================================ ORDERS
steps_slide("Orders", "An order in a few taps, at the right price", ["order", "order_sheet", "order_saved"],
    [("Start the way you want", "New order, the customer's usual basket, or repeat a past order"),
     ("Pick products", "Frequent products first; brand chips and search; stock shown"),
     ("Review the order", "Payment method, due days, discount and down payment"),
     ("Rules are checked", "Customer-level prices, discount approval, credit limit, price floor"),
     ("Live status", "Submitted, confirmed, packed, delivered; everyone sees it"),
     ("Print, sign, photo", "The order form is ready at once: print it, the customer signs, the rep uploads a photo of it")],
    """
Orders in a few taps. The rep starts a new order, the customer's usual basket, or a repeat of any past order. Products the customer buys often come first, with brand chips and search, and the available stock is shown. In the review sheet the rep sets the payment method, due days, discount and down payment.
KAD OS checks the rules: prices by customer level (Bronze, Silver, Gold), discounts up to 3% automatic and more only with approval, the customer's credit limit, and a price floor that only the CEO can override. After saving, everyone sees the status live: submitted, confirmed, packed, delivered, and the delivery form can be printed for the customer to sign.
The paperwork is created automatically too: as soon as the order is saved, the order form is ready, so the rep just taps Print. When the customer signs it, at delivery or when paying, the rep takes a photo of the signed copy and uploads it to the app, so the signed document is always attached to the order.
""", phone_h=4.4, caps=["Pick products", "Review", "Saved: print"])

video_slide("Orders", "Demo: an order from start to saved", "order",
    [("Choose products", "Tap Castrol, then Add; adjust quantities"),
     ("Review", "View order: lines, payment method, due days"),
     ("Invoice or cash", "One tap sets the payment method"),
     ("Save", "Order saved: print or share the order form")],
    "This video shows an order from start to finish: choosing products, reviewing the order with its payment terms, choosing invoice and saving. The saved order can be printed or shared at once.")

# ================================================================ ACCOUNTING & INVOICING (new, owner 2026-11-02)
steps_slide("Accounting & invoicing", "Invoices and delivery documents are created by themselves", ["order_accounting", "payment_add"],
    [("Rep chooses the payment", "Invoice or cash, while making the order"),
     ("Sales director approves", "One tap confirms the order"),
     ("Invoice: created automatically", "Our invoicing system is connected; the chief accountant only approves and signs"),
     ("Cash: delivery document ready", "The driver cannot load goods without it; he gets a notification to download and print"),
     ("Signed copies come back", "Customer signs on paper or on the phone; the rep uploads the photo"),
     ("Customer updates", "Today we send them by hand; the customer app will show them automatically")],
    """
Accounting and invoicing are automatic. While making the order, the rep chooses how the customer pays: by invoice or in cash. The sales director approves the order with one tap.
If it is an invoice, the invoice is created automatically, because KAD OS is connected to our local invoicing system; the chief accountant only has to approve and sign it.
If it is cash, the products cannot leave the warehouse without proper documents, so the delivery document is also created automatically, and the driver gets a notification that he can download and print it.
Signatures come back into the app: when the goods are delivered or a payment is received, the customer signs, on paper or directly on the phone, and the rep uploads the photo.
Today we still send customers updates about their orders and payments by hand. Once the customer app is live, this step disappears: customers will see their orders and payments on their own dashboard.
""", caps=["Accounting document", "Payment: sign or photo"])

# ================================================================ CREDIT & CASH
steps_slide("Credit, debt & cash", "Credit and cash under control, without chasing", ["debt_sheet", "tasks"],
    [("Credit limit per customer", "Over the limit, the order waits for approval"),
     ("Debt per invoice", "Every unpaid invoice with its due date; red when overdue"),
     ("Collection task", "Overdue debt becomes a task for the rep's next visit"),
     ("Promise date", "The rep records when the customer will pay; a broken promise goes to the sales director"),
     ("Payment at the visit", "Recorded on the phone and tracked until it reaches the accountant"),
     ("Debt statement", "A one-page downloadable PDF for the customer")],
    """
Credit and cash. Every customer can have a credit limit; an order over the limit waits for approval. Debt is tracked invoice by invoice with its due date, and turns red when overdue. An overdue invoice automatically becomes a collection task for the rep's next visit. The rep records the date the customer promises to pay; if the promise is broken, the sales director is told. Payments are recorded on the phone at the visit and tracked until the cash reaches the accountant. And the customer can get a one-page downloadable debt statement.
""", caps=["Payments received", "Tasks"])

# ================================================================ WAREHOUSE (live)
steps_slide("Warehouse", "The warehouse packs from the phone", ["wh_home", "wh_pack", "stock_count"],
    [("What to do now", "Home shows orders to pack, the oldest waiting, and what is late"),
     ("Pick and pack", "One card per order: tick each line while picking, then Packed"),
     ("By product", "One pick list across all orders; short stock in red"),
     ("Problem button", "A missing product is reported, not hidden"),
     ("Daily stock count", "Every product counted once a month, a few each day, blind"),
     ("Reorder list", "Days of stock left and what to buy")],
    """
The warehouse works from the phone too. The warehouse home shows what to do now: how many orders to pack, the oldest waiting, and anything late. Packing is one card per order: the warehouse ticks each line while picking and presses Packed; there is also a pick list by product across all orders, with short stock in red, and a Problem button when something is missing.
Stock is counted every day: each product once a month, a few each day, counted blind, so management sees real differences. And the app shows days of stock left and a ready reorder list.
""", phone_h=4.4, caps=["Warehouse home", "Pack", "Stock count"])

video_slide("Warehouse", "Demo: packing an order", "pack",
    [("Warehouse home", "Orders to pack and the oldest waiting"),
     ("Start packing", "One card per order"),
     ("Tick the lines", "While picking from the shelf"),
     ("Packed", "The order moves to Packed and waits for the driver")],
    "This video shows packing: from the warehouse home to the pack screen, ticking each line while picking, and pressing Packed, after which the order waits for the driver.")

# ================================================================ DELIVERY (live)
steps_slide("Delivery & driver", "Deliveries on an optimised route, signed on the phone", ["driver_home", "route"],
    [("Route in one tap", "Packed orders become a route in the shortest order"),
     ("Next stop first", "Navigate and Call buttons; later stops below"),
     ("Arrival detected", "When the driver reaches the customer: off, one-tap Delivered, or automatic"),
     ("Customer signs", "Signature on the phone; cash collected is recorded"),
     ("Failed delivery", "A reason is recorded and the order goes back to the plan"),
     ("Everyone sees it", "The order turns Delivered for the rep and the office")],
    """
Delivery works the same way. Packed orders become a route in one tap, ordered to drive the shortest way. The driver's home shows the next stop first, with Navigate and Call buttons and the later stops below. When the driver reaches the customer, the app detects the arrival; management chooses whether that does nothing, offers a one-tap Delivered button, or marks the order delivered automatically.
The customer signs on the driver's phone, and any cash collected is recorded. If a delivery fails, the reason is recorded. And the order turns Delivered for the rep and the office at once.
""", caps=["Driver home", "Route"])

# ================================================================ MANAGEMENT
steps_slide("Management", "Management sees the business live", ["dashboard", "reports"],
    [("Live dashboard", "Sales against plan, by rep and channel"),
     ("Targets and bonuses", "Each rep sees plan, progress and points"),
     ("Team scorecards", "Visits, orders and payments per rep, each week"),
     ("Reports", "Money and debt, sales and litres, team, stock"),
     ("Right data for each role", "A rep sees only own customers")],
    """
Management sees the business live. The dashboard shows sales against plan by rep and by channel. Every rep sees their own targets, progress and bonus points, and management gets a weekly scorecard per rep. Reports cover money and debt, sales and litres by product line, the team and stock. And each person sees only what their role needs: a rep sees only their own customers.
""", caps=["Dashboard", "Reports"])

steps_slide("Executive Assistant", "A daily report sent directly to management", ["assistant"],
    [("Sales and volume", "Today and month to date, against plan"),
     ("Cash and debt", "Collected today, overdue, oldest debts"),
     ("Stock risks", "Products about to run out"),
     ("Unusual numbers", "Anything far from normal is flagged"),
     ("Weekly and monthly", "Longer summaries at the end of each period")],
    """
The KAD OS Executive Assistant sends the CEO a report every evening: sales and volume today and month to date against plan, cash collected and overdue debt, products about to run out, and any number that is far from normal. At the end of each week and month it sends a longer summary.
""", caps=["Evening report"])

# ================================================================ AI agent (owner's v4 naming)
steps_slide("AI Agent", "An AI agent keeps everyone on plan", ["vaghinak", "vaghinak_rep"],
    [("Watches the working day", "Late starts, missed visits, long office stays"),
     ("Keeps visits on route", "Reminds reps about planned shops nearby"),
     ("Chases money", "Overdue debt, down payments, broken promises"),
     ("Gives and closes tasks", "Right person, deadline; closes itself when done"),
     ("Asks and escalates", "Some questions must be answered; management hears only what slips")],
    """
This is our AI agent; in the app we call him Vaghinak. He watches the working day: late starts, missed visits and long stays in the office. He reminds reps about planned shops nearby, chases overdue debt, down payments and broken promises, and gives each task to the right person with a deadline. Tasks close themselves when the problem is solved, for example when the payment arrives. Some of his questions must be answered before the rep carries on, and management only hears about what slips. He speaks to each person in their own tone, formal with management and friendly with reps.
""", caps=["Management view", "Rep view"])

# ================================================================ AI agent: how it works (new, owner 2026-11-02)
s = new_slide(); n = nxt()
header(s, "AI Agent", "How the AI agent decides, assigns and checks")
loop = [("eye", "Watches", "Orders, payments, visits and check-ins, all day"),
        ("sparkles", "Notices", "Something differs from the customer's or rep's usual pattern"),
        ("tasks", "Assigns", "A task to the right person, with a deadline"),
        ("checkCircle", "Checks", "Closes the task by itself when the data shows it is done"),
        ("warning", "Escalates", "Tells management only when it keeps slipping")]
for i, (ic, title, body) in enumerate(loop):
    x = 0.6 + i * 2.45
    box(s, x, 1.8, 2.28, 1.55, fill=GREEN if i in (2, 3) else LIGHT, radius=0.12)
    icon(s, ic, x + 0.15, 1.95, 0.55, bg=WHITE if i in (2, 3) else GREEN_TINT)
    text(s, x + 0.8, 1.97, 1.4, 0.45, title, size=15, bold=True, color=WHITE if i in (2, 3) else DARK, anchor=MSO_ANCHOR.MIDDLE)
    text(s, x + 0.15, 2.58, 2.0, 0.75, body, size=11, color=WHITE if i in (2, 3) else GREY)
ex = [("cart", "Customer stopped ordering", "A customer usually orders every 2 weeks. This time no order came.",
       "Task for the rep: go and remind the customer.", "Closes when the next order arrives."),
      ("wallet", "Weekly payment missed", "A customer pays every week. This week there is no payment.",
       "Task for the rep: collect the payment.", "Closes by itself when the rep records the money on the customer card; no double work in Tasks."),
      ("clock", "Late arrival at the office", "The team starts at the office and checks in there. Arrival is late.",
       "The agent notifies the rep and asks for the reason.", "After the 3rd time, management is notified automatically.")]
for i, (ic, title, when, then, close) in enumerate(ex):
    x = 0.6 + i * 4.1
    y = 3.6
    box(s, x, y, 3.9, 3.15, fill=WHITE, line=GREEN, radius=0.14, line_w=1.25)
    icon(s, ic, x + 0.22, y + 0.2, 0.6)
    text(s, x + 0.95, y + 0.2, 2.85, 0.6, title, size=15, bold=True, anchor=MSO_ANCHOR.MIDDLE, line=0.95)
    text(s, x + 0.25, y + 0.95, 3.45, 2.15, [[("Notices: ", {"bold": True, "color": DARK}), (when, {})], [("Does: ", {"bold": True, "color": DARK}), (then, {})], [("Checks: ", {"bold": True, "color": GREEN_DARK}), (close, {})]], size=11.5, color=GREY, spacing=5)
footer(s, n)
notes(s, """
How does the AI agent decide what to do? It watches all the data the app collects: orders, payments, visits and check-ins. It learns each customer's and each rep's usual pattern, and when something differs from that pattern, it gives a task to the right person with a deadline. Then it checks the data to see whether the task was done, and closes the task by itself. Management only hears about it when the problem keeps slipping.
Three examples. A customer usually orders every two weeks, and this time no order came: the agent creates a task for the rep to visit and remind the customer, and the task closes when the next order arrives.
A customer pays every week, and this week there is no payment: the agent creates a task to collect it. When the rep collects the money and records it on the customer card, the task closes by itself, so nobody has to open Tasks and tick it as done.
And the team starts the day at the office and checks in there. When the agent sees a late arrival, it sends the rep a notification and asks for the reason; after the third time, it notifies management automatically.
""")

# ================================================================ Human approvals (new, owner 2026-11-02)
s = new_slide(); n = nxt()
header(s, "Human approvals", "Automation does the work; people approve")
phone(s, "order_approval", 0.55, 1.75, 4.9)
text(s, 0.55, 6.72, 2.4, 0.25, "Order waiting for approval (demo)", size=9, color=GREY)
apps = [("tag", "Discounts above 3%", "Management approves"),
        ("warning", "Price below our cost", "Only the CEO approves"),
        ("wallet", "Over the credit limit", "Sales director or accountant approves"),
        ("cart", "New orders", "The sales director confirms"),
        ("sheet", "Invoices", "The chief accountant approves and signs"),
        ("payment", "Cash and payments", "The accountant confirms what was received"),
        ("customers", "Customer data changes by reps", "Management reviews them"),
        ("sparkles", "The AI agent itself", "Starts in test mode; management tunes it, then switches it on")]
for i, (ic, title, body) in enumerate(apps):
    x = 3.35 + (i % 2) * 4.7
    y = 1.8 + (i // 2) * 1.2
    box(s, x, y, 4.5, 1.05, fill=LIGHT, radius=0.12)
    icon(s, ic, x + 0.15, y + 0.22, 0.6)
    text(s, x + 0.9, y + 0.12, 3.5, 0.4, title, size=14, bold=True)
    text(s, x + 0.9, y + 0.52, 3.5, 0.45, body, size=11.5, color=GREY)
footer(s, n)
notes(s, """
The system and the AI agent can make mistakes, so we keep people in charge of the key decisions. The automation prepares everything; a person approves.
Discounts above 3% need management approval, and any price below our cost needs the CEO. An order over the customer's credit limit waits for the sales director or the accountant. New orders are confirmed by the sales director. Every invoice is approved and signed by the chief accountant. Cash and payments are confirmed by the accountant when they are received. Changes that reps make to customer data are reviewed by management. And the AI agent itself started in test mode: management saw what it would say, tuned its rules, and only then switched it on.
""")

# ================================================================ AI & automation
s = new_slide(); n = nxt()
header(s, "AI and automation", "AI and automatic calculations do the routine work")
box(s, 0.6, 1.95, 5.2, 4.8, fill=GREEN, radius=0.16)
icon(s, "sparkles", 0.95, 2.25, 0.85, bg=WHITE)
text(s, 2.0, 2.3, 3.6, 0.8, "AI analyst: ask your data", size=20, bold=True, color=WHITE, anchor=MSO_ANCHOR.MIDDLE)
text(s, 0.95, 3.35, 4.6, 0.9, "Management asks a question in plain words and gets an answer with numbers:", size=13.5, color=WHITE)
box(s, 0.95, 4.25, 4.5, 0.9, fill=GREEN_DARK, radius=0.1)
text(s, 1.15, 4.25, 4.1, 0.9, "“Which customers bought less EDGE this quarter, and who is their rep?”", size=12.5, bold=True, color=WHITE, anchor=MSO_ANCHOR.MIDDLE)
text(s, 0.95, 5.4, 4.6, 1.2, ["Customers and staff are hidden behind codes", "Read-only, every question logged"], size=12, color=WHITE, spacing=4)
text(s, 6.2, 1.95, 6.5, 0.3, "CALCULATED AUTOMATICALLY", size=12, bold=True, color=GREY)
for i, c in enumerate(["Landing cost of every product", "True cost at the selling price, for each discount", "Debt age of every invoice", "Suggested credit limit per customer",
                       "Each customer's usual basket and order rhythm", "Days of stock left and what to reorder", "Optimised delivery route", "Rep working hours and weekly scorecards", "Fuel allowance from the real GPS route"]):
    y = 2.4 + i * 0.47
    icon(s, "checkCircle", 6.2, y + 0.03, 0.32, bg=None, color="g", ratio=1.0)
    text(s, 6.67, y, 6.0, 0.42, c, size=13.5)
footer(s, n)
notes(s, """
Besides the AI agent, KAD OS has an AI analyst: management asks a question in plain words and gets an answer with numbers. Customers and staff are hidden behind codes, and every question is logged.
Many calculations happen automatically: the landing cost of every product, the true cost at the selling price for each discount, the age of every invoice, a suggested credit limit, each customer's usual basket and order rhythm, days of stock left and what to reorder, the optimised delivery route, rep working hours and scorecards, and the fuel allowance from the real GPS route.
""")

# ================================================================ Built for field work
s = new_slide(); n = nxt()
header(s, "Built for real field work", "Works on any phone, fast, offline and secure")
for i, (ic, title, body) in enumerate([("smartphone", "Any phone or PC", "Opens from a link; no app store"),
                                       ("wifioff", "Works offline", "Visits, orders and counts wait on the phone and send later"),
                                       ("gauge", "Fast on cheap phones", "Speed is tested on a slow phone"),
                                       ("person", "Role-based access", "Everyone sees only what their role allows"),
                                       ("lock", "Secure", "Encrypted connection, protected logins, audit trail"),
                                       ("shield", "Data stays with us", "Our data lives in a cloud system")]):
    x = 0.6 + (i % 3) * 4.1
    y = 1.95 + (i // 3) * 2.2
    box(s, x, y, 3.9, 2.0, fill=LIGHT)
    icon(s, ic, x + 0.25, y + 0.3, 0.78)
    text(s, x + 1.2, y + 0.32, 2.55, 0.45, title, size=16, bold=True)
    text(s, x + 1.2, y + 0.85, 2.55, 1.05, body, size=13, color=GREY)
footer(s, n)
notes(s, """
KAD OS is built for real field work. It opens from a link on any phone or PC. It works offline: visits, orders and stock counts wait on the phone and are sent later. It is fast even on cheap phones; we test its speed on a slow phone. Everyone sees only what their role allows. The connection is encrypted, logins are protected, and every key change is kept in an audit trail. And our data stays in our own cloud system.
""")

# ================================================================ Built and adopted (owner's v4 numbers)
s = new_slide(); n = nxt()
header(s, "Built and adopted", "Live in 3 months, used by the whole team in the 4th month")
for i, (num, lab, sub) in enumerate([("3 months", "from first line of code to the first live version", "May → August 2026"),
                                     ("4th month", "the whole field team working in the app", "September 2026"),
                                     ("6th month", "to the complete system shown today", "763 improvements, delivered every week")]):
    x = 0.6 + i * 4.1
    box(s, x, 1.95, 3.9, 2.6, fill=GREEN if i == 1 else LIGHT)
    text(s, x + 0.3, 2.15, 3.4, 0.9, num, size=44, bold=True, color=WHITE if i == 1 else GREEN)
    text(s, x + 0.3, 3.1, 3.4, 0.7, lab, size=15, bold=True, color=WHITE if i == 1 else DARK)
    text(s, x + 0.3, 3.85, 3.4, 0.6, sub, size=12, color=WHITE if i == 1 else GREY)
pts = [("May 2026", "Work starts"), ("Aug", "First version live"), ("September", "Whole field team in the app"), ("Today", "Complete system, weekly updates")]
ln = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(1.8), Inches(5.35), Inches(11.5), Inches(5.35)); ln.line.color.rgb = GREEN_MID; ln.line.width = Pt(3)
for i, (d, lab) in enumerate(pts):
    cx = 1.8 + i * (9.7 / 3)
    c = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(cx - 0.14), Inches(5.21), Inches(0.28), Inches(0.28))
    c.fill.solid(); c.fill.fore_color.rgb = GREEN; c.line.fill.background()
    text(s, cx - 1.4, 5.6, 2.8, 0.35, d, size=14, bold=True, align=PP_ALIGN.CENTER)
    text(s, cx - 1.4, 5.95, 2.8, 0.5, lab, size=12, color=GREY, align=PP_ALIGN.CENTER)
footer(s, n)
notes(s, """
How long did it take? Our team started in May 2026, and the first version was live three months later, in August. In September, the fourth month, the whole field team was working in the app. By the sixth month we reached the complete system you have seen today, with 763 improvements delivered every week based on what the team asked for.
It was adopted so quickly because our own people designed it: reps, the sales director, warehouse, accounting and management told us exactly what they needed.
""")

# ================================================================ Adoption (new, owner 2026-11-02)
steps_slide("Adoption", "How we got the whole team to use it", ["bonuses", "team_progress"],
    [("The hardest part", "A new app means new habits; at first not every visit was logged"),
     ("A bonus system", "Points for visits, collected payments, delivered orders, attendance and challenges"),
     ("A monthly contest", "The rep with the most check-ins in the month wins a fixed bonus"),
     ("Visible to everyone", "Leaderboard and progress by rep, updated live"),
     ("Still running today", "Everything is logged in the app, and the team works more actively")],
    """
Getting the whole team to work in the app is one of the hardest parts. A new app means new habits, and at first not every visit was logged.
We solved it with a bonus system and a contest. Reps earn points for their work in the app: visits, collected payments, delivered orders, attendance and challenges. And every month the rep with the most check-ins wins a fixed bonus. The leaderboard and the progress by rep are visible to everyone and update live.
We are still running the contest. It pushes the team to log all their work in the app, and it also benefits the company, because the reps work more actively.
""", caps=["Bonuses and leaderboard", "Progress by rep"])

# ================================================================ Next: customer app
s = new_slide(); n = nxt()
header(s, "Coming next", "Next: KAD OS for our customers")
text(s, 0.6, 1.75, 12.1, 0.6, "We are opening the app to our customers, so IWS can work with us directly.", size=17)
for i, (ic, title, body) in enumerate([("cart", "Online orders", "Order any time, at the customer's own prices"),
                                       ("tag", "Offers and discounts", "Promotions shown on the customer's dashboard"),
                                       ("history", "Orders and balance", "Every order, its status, and the current balance"),
                                       ("send", "Notifications", "Automatic, when an order is placed and when a payment arrives, cash or bank")]):
    x = 0.6 + i * 3.08
    box(s, x, 2.6, 2.9, 3.4, fill=WHITE, line=GREY, radius=0.14, line_w=1.0, dash=True)
    icon(s, ic, x + 0.3, 2.9, 0.9)
    text(s, x + 0.3, 4.0, 2.4, 0.5, title, size=17, bold=True)
    text(s, x + 0.3, 4.55, 2.35, 1.3, body, size=13, color=GREY)
box(s, 0.6, 6.2, 12.13, 0.55, fill=GREEN_TINT, radius=0.1)
text(s, 0.9, 6.2, 11.6, 0.55, [[("Why it matters: ", {"bold": True, "color": GREEN_DARK}), ("no more manual updates to customers, fewer calls and errors, faster payments, and more frequent Castrol orders.", {})]], size=13.5, anchor=MSO_ANCHOR.MIDDLE)
footer(s, n)
notes(s, """
What comes next: we are opening KAD OS to our customers. Shops and garages will order online at their own prices, see offers and discounts on their dashboard, follow their orders and see their balance. They will get a notification automatically when an order is placed and when a payment arrives, whether they paid in cash or by bank transfer.
Today we still send customers updates about their orders and payments by hand; with the customer app this disappears, because they see everything on their own dashboard. For a distributor this means fewer calls and errors and faster payments; for Castrol, customers who order more often.
""")

# ================================================================ Thank you
s = new_slide(); n = nxt()
pic(s, KAD_LOGO, 0.75, 0.9, h=0.5)
ln = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(3.6), Inches(0.75), Inches(3.6), Inches(1.55)); ln.line.color.rgb = LINE; ln.line.width = Pt(1)
pic(s, CASTROL_LOGO, 4.0, 0.86, h=0.58)
lockup(s, 0.75, 2.4, size=54, w=8)
text(s, 0.75, 4.05, 9, 0.6, "The operating system for a modern Castrol distributor.", size=22)
text(s, 0.75, 5.0, 9, 0.6, "Thank you. Questions?", size=26, bold=True, color=GREEN)
footer(s, n)
notes(s, """
Thank you. To sum up: KAD OS is one app for the whole distributor, from the first visit to the delivered and paid order; it checks every visit, order, price and payment; an AI agent keeps everyone on plan; and management sees everything live. We are happy to answer questions or show any part of the app live.
""")

# Flat look in every renderer: drop the theme style reference (LibreOffice draws its shadow even with an empty effect list).
for sl in prs.slides:
    for el in sl.shapes._spTree.iter():
        if el.tag in (qn("p:sp"), qn("p:cxnSp")):
            st = el.find(qn("p:style"))
            if st is not None:
                el.remove(st)
OUT = os.environ.get("DECK_OUT", OUT)
prs.save(OUT)
print("saved", OUT, len(prs.slides._sldIdLst), "slides")
