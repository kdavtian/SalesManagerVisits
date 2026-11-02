# Builds ../../KAD_OS_Castrol_Global.pptx: a simple introduction to KAD OS - what it is, how it works, every function (17 slides, notes on every slide).
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




def feature_slide(kicker, headline, phones, rows, talk, shelf=False):
    s = new_slide(); n = nxt()
    header(s, kicker, headline)
    for i, name in enumerate(phones):
        if name == "shelf_audit":
            pic(s, os.path.join(SHOTS, "shelf_audit.png"), 0.45 + i * 2.6, 2.0, h=3.55)
        else:
            phone(s, name, 0.55 + i * 2.6, 1.75, 4.9)
    demo_tag(s, 0.55, 6.68, 5.2)
    step = 4.75 / len(rows)
    for i, (ic, title, body) in enumerate(rows):
        y = 1.9 + i * step
        icon(s, ic, 6.35, y, 0.66)
        text(s, 7.2, y - 0.02, 5.5, 0.35, title, size=16, bold=True)
        text(s, 7.2, y + 0.34, 5.5, 0.4, body, size=12.5, color=GREY)
    footer(s, n)
    notes(s, talk)
    return s


# ---------------------------------------------------------------- 1. Title
s = new_slide(); nxt()
box(s, 7.35, 0, SW - 7.35, 7.5, fill=RGBColor(0xF2, 0xF6, 0xF4), radius=0)
pic(s, KAD_LOGO, 0.75, 0.9, h=0.5)
ln = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(3.6), Inches(0.75), Inches(3.6), Inches(1.55)); ln.line.color.rgb = LINE; ln.line.width = Pt(1)
pic(s, CASTROL_LOGO, 4.0, 0.86, h=0.58)
lockup(s, 0.75, 2.35, size=60, w=6.2)
text(s, 0.75, 4.1, 6.2, 1.0, "The operating system for a modern Castrol distributor.", size=22, line=1.05)
box(s, 0.75, 5.3, 1.0, 0.06, fill=GREEN, radius=0)
box(s, 1.75, 5.3, 0.35, 0.06, fill=RED, radius=0)
text(s, 0.75, 5.55, 6.0, 0.4, "Introducing the app · KAD Motors, Armenia · November 2026", size=15, color=GREY)
phone(s, "checkin", 7.55, 1.25, 5.3)
phone(s, "assistant", 10.6, 1.25, 5.3)
phone(s, "map", 8.95, 0.75, 6.1)
demo_tag(s, 9.25, 7.0)
notes(s, """
Thank you for your time. Today I want to introduce KAD OS, the app our team built to run the daily work of a Castrol distributor. I will show what it is, how it works, every function, and the problems it solves. The screens use demo data.
"Powered by Castrol" is our proposed co-brand; we would use it only with Castrol's approval.
""")

# ---------------------------------------------------------------- 2. What is KAD OS
s = new_slide(); n = nxt()
header(s, "What is KAD OS?", "One app for everyone in a Castrol distributor")
text(s, 0.6, 1.75, 12.1, 0.9, "Field sales, customers, orders, credit, cash, the team and management reports in one system, with AI that keeps everyone on plan.", size=18, color=DARK, line=1.1)
roles = [("person", "Sales reps", "Visit, check in, take orders and payments"),
         ("target", "Sales director", "Plans routes, approves prices and credit"),
         ("box", "Warehouse", "Sees confirmed orders to pack and ship"),
         ("wallet", "Accountant", "Invoices, payments and cash"),
         ("chart", "CEO", "Live dashboards and an evening report")]
for i, (ic, title, body) in enumerate(roles):
    x = 0.6 + i * 2.45
    box(s, x, 2.95, 2.28, 2.55, fill=LIGHT)
    icon(s, ic, x + 0.72, 3.15, 0.84)
    text(s, x + 0.12, 4.1, 2.04, 0.4, title, size=15, bold=True, align=PP_ALIGN.CENTER)
    text(s, x + 0.15, 4.5, 1.98, 0.9, body, size=12, color=GREY, align=PP_ALIGN.CENTER)
box(s, 0.6, 5.8, 12.13, 0.85, fill=GREEN, radius=0.14)
icon(s, "smartphone", 0.85, 5.92, 0.6, bg=WHITE)
text(s, 1.65, 5.8, 10.9, 0.85, "Opens from a link on any iPhone, Android phone or PC. No app store. Works without signal.", size=16, bold=True, color=WHITE, anchor=MSO_ANCHOR.MIDDLE)
footer(s, n)
notes(s, """
KAD OS is one app for everyone in a distributor. Sales reps use it to visit customers, check in, take orders and collect payments. The sales director plans routes and approves prices and credit. The warehouse sees which confirmed orders to pack and ship. The accountant handles invoices, payments and cash. And the CEO sees live dashboards and gets an evening report.
Everyone opens it from a link on the phone or PC they already have. There is no app store and no installation project, and it keeps working without signal.
""")

# ---------------------------------------------------------------- 3. Problems it solves
s = new_slide(); n = nxt()
header(s, "Problems it solves", "Six everyday problems, and how KAD OS solves each one")
pairs = [("mapWarning", "Visits nobody can check", "GPS check-in with a photo at the outlet"),
         ("phone", "Orders by phone, wrong prices", "Orders in the app at fixed price lists"),
         ("wallet", "Overdue debt found too late", "Debt per invoice and automatic collection tasks"),
         ("eye", "No view of the shelf", "A Castrol shelf check at every visit"),
         ("clock", "Reports that take days", "Live dashboards and an evening report"),
         ("warning", "Problems noticed too late", "An AI deputy director gives and chases tasks")]
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
These are six everyday problems of a distributor, and the answer KAD OS gives to each.
Visits nobody can check: now every visit is a GPS check-in with a photo. Orders by phone with wrong prices: orders are made in the app at fixed price lists. Overdue debt found too late: debt is tracked per invoice and becomes a collection task automatically. No view of the shelf: reps record a Castrol shelf check at every visit. Reports that take days: dashboards are live and management gets an evening report. Problems noticed too late: an AI deputy director gives tasks to the right person and chases them.
""")

# ---------------------------------------------------------------- 4. How it works
s = new_slide(); n = nxt()
header(s, "How it works", "How KAD OS works, in four simple steps")
steps = [("smartphone", "1. The team works in the app", "Visits, orders and payments are recorded where they happen"),
         ("checkCircle", "2. KAD OS checks the rules", "Prices, discounts, credit and stock, at once"),
         ("sparkles", "3. AI spots problems", "Gives a task to the right person, with a deadline"),
         ("chart", "4. Management sees it live", "Dashboards, reports and an evening summary")]
for i, (ic, title, body) in enumerate(steps):
    x = 0.6 + i * 3.1
    box(s, x, 1.95, 2.85, 2.9, fill=GREEN if i == 1 or i == 2 else LIGHT)
    hi = i in (1, 2)
    icon(s, ic, x + 0.25, 2.2, 0.8, bg=WHITE if hi else GREEN_TINT)
    text(s, x + 0.25, 3.15, 2.45, 0.7, title, size=15.5, bold=True, color=WHITE if hi else DARK, line=0.95)
    text(s, x + 0.25, 3.85, 2.45, 0.9, body, size=12.5, color=WHITE if hi else GREY)
    if i < 3:
        a = s.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Inches(x + 2.88), Inches(3.2), Inches(0.2), Inches(0.36))
        a.fill.solid(); a.fill.fore_color.rgb = GREEN_MID; a.line.fill.background()
box(s, 0.6, 5.2, 12.13, 1.45, fill=WHITE, line=GREEN, radius=0.14, line_w=1.25)
icon(s, "database", 0.85, 5.5, 0.85)
text(s, 1.95, 5.27, 10.6, 1.3, [[("One cloud system. ", {"bold": True}), ("Customers, products, orders, money and tasks live in one secure database. The accounting system is connected through the integration API, so nobody types anything twice.", {})]], size=14, anchor=MSO_ANCHOR.MIDDLE)
footer(s, n)
notes(s, """
How does it work? Four simple steps.
One: the team works in the app, so visits, orders and payments are recorded where they happen, at the customer. Two: KAD OS checks the rules at once: prices, discounts, credit and stock. Three: AI spots problems and gives a task to the right person, with a deadline. Four: management sees everything live, in dashboards, reports and an evening summary.
Underneath there is one cloud system: customers, products, orders, money and tasks in one secure database, and the accounting system is connected through an integration API, so nobody types anything twice.
""")

# ---------------------------------------------------------------- 5. A day in KAD OS
s = new_slide(); n = nxt()
header(s, "A day in KAD OS", "From the shop counter to the CEO's phone, in one flow")
day = [("checkin", "09:40", "Rep checks in", "GPS + photo at the outlet"), ("order", "09:52", "Takes the order", "Right prices, usual basket"),
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
Here is one day in KAD OS, with demo data. At 09:40 a rep checks in at a shop: the phone confirms the location and the rep adds a photo. At 09:52 the rep takes the order from the customer's usual basket, at the right prices. One minute later the manager sees the order live and approves it in one tap. At 19:00 the CEO gets the evening report: sales, cash, debt and the risks to watch.
""")

# ---------------------------------------------------------------- 6-11 feature slides
feature_slide("Visits in the field", "Every visit is checked and recorded", ["checkin", "shelf_audit"],
    [("mapPinCheck", "GPS check-in", "Only within 300 m of the outlet (set by management)"),
     ("camera", "Photo proof", "A photo and the visit outcome are saved"),
     ("eye", "Shelf check", "Castrol on the shelf, full range, fake products, competitors"),
     ("tasks", "Open tasks at the visit", "The rep sees what to do at this customer"),
     ("wifioff", "Works without signal", "The visit is saved and sent later")],
    """
Visits in the field are the heart of the app. A rep can check in only near the outlet, within 300 metres by default, a limit management can change. A photo and the visit outcome are saved: order, payment, delivery or assortment check.
At each visit the rep records the shelf: whether Castrol is there, whether the full range is there, and whether there are fake products or competitor brands. The rep also sees the open tasks for this customer. Without signal, the visit is saved on the phone and sent later.
""")

feature_slide("Customers & map", "Every customer, on a map, with everything about them", ["map", "customers"],
    [("map", "Customer map", "Every outlet, coloured by visit status"),
     ("customers", "Customer card", "Contacts, orders, debt, visits, tasks"),
     ("calendar", "Visit plans and routes", "Weekly routes for every rep, planned automatically"),
     ("mapPinCheck", "New customers from the map", "Add a shop where you stand"),
     ("warning", "Overdue visits", "Customers not visited on time are flagged")],
    """
All customers are on a map, coloured by visit status, and in a searchable list. The customer card shows contacts, orders, debt, visits and open tasks in one place.
Each rep gets weekly visit routes, planned automatically and balanced across the week. A rep can add a new customer directly from the map, where they stand. Customers that were not visited on time are flagged, so nobody is forgotten.
""")

feature_slide("Orders", "Orders in a few taps, at the right price", ["order", "orders"],
    [("cart", "Fast ordering", "Usual basket, repeat last order, search"),
     ("tag", "Price lists by customer level", "Bronze, Silver, Gold; reps never type prices"),
     ("checkCircle", "Discount rules", "Over 3% needs approval; below cost, the CEO"),
     ("send", "Live order status", "Draft, submitted, confirmed, packed, delivered"),
     ("folder", "Printable order form", "A delivery act for the customer to sign")],
    """
Ordering takes a few taps: start from the customer's usual basket, repeat the last order, or search. Prices come from price lists by customer level, Bronze, Silver or Gold, and reps never type prices.
Discount rules are built in: up to 3% is automatic, more needs approval, and anything below our cost needs the CEO. Everyone sees the order's status live, from draft to delivered, and the app prints the delivery form the customer signs.
""")

feature_slide("Credit, debt & cash", "Credit and cash under control, without chasing", ["customer", "tasks"],
    [("wallet", "Credit limits", "Over the limit, the order waits for approval"),
     ("history", "Debt per invoice", "Every unpaid invoice with its due date"),
     ("tasks", "Collection tasks", "Overdue debt becomes a task with a promise date"),
     ("payment", "Payments at the visit", "Recorded and tracked to the accountant"),
     ("sheet", "Debt statement", "A one-page PDF for the customer")],
    """
Every customer can have a credit limit; an order over the limit waits for approval. Debt is tracked invoice by invoice, each with its due date.
When an invoice is overdue, the rep automatically gets a collection task, and can record the customer's promise date; a broken promise goes to the sales director. Payments are recorded at the visit and tracked until they reach the accountant, and the app produces a one-page debt statement for the customer.
""")

feature_slide("Management", "Management sees the business live", ["dashboard", "reports"],
    [("chart", "Live dashboard", "Sales against plan, by rep and channel"),
     ("target", "Targets and bonuses", "Each rep sees plan, progress and points"),
     ("team", "Team scorecards", "Visits, orders and payments per rep, each week"),
     ("layers", "Reports", "Money and debt, sales and litres, team, stock"),
     ("person", "Right data for each role", "A rep sees only own customers")],
    """
Management sees the business live. The dashboard shows sales against plan by rep and by channel. Every rep sees their own targets, progress and bonus points, and management gets a weekly scorecard per rep.
Reports cover money and debt, sales and litres by product line, the team, and stock. And each person sees only what their role needs: a rep sees only their own customers.
""")

feature_slide("Executive Assistant", "An evening report on the CEO's phone, every day", ["assistant"],
    [("chart", "Sales and volume", "Today and month to date, against plan"),
     ("wallet", "Cash and debt", "Collected today, overdue, oldest debts"),
     ("box", "Stock risks", "Products about to run out"),
     ("warning", "Unusual numbers", "Anything far from normal is flagged"),
     ("calendar", "Weekly and monthly", "Longer summaries at the end of each period")],
    """
The KAD OS Executive Assistant sends the CEO a report every evening. It covers sales and volume, today and month to date against plan; cash collected and overdue debt; products about to run out; and any number that is far from normal. At the end of each week and month it sends a longer summary.
""")

# ---------------------------------------------------------------- 12. AI deputy director
feature_slide("AI deputy director", "An AI deputy director keeps everyone on plan", ["vaghinak", "vaghinak_rep"],
    [("clock", "Watches the working day", "Late starts, missed visits, long office stays"),
     ("route", "Keeps visits on route", "Reminds reps about planned shops nearby"),
     ("wallet", "Chases money", "Overdue debt, down payments, broken promises"),
     ("tasks", "Gives and closes tasks", "Right person, deadline; closes when done"),
     ("warning", "Escalates only what slips", "Management hears only what needs them")],
    """
This is our AI deputy director. He watches the working day: late starts, missed visits and long stays in the office. He reminds reps about planned shops nearby, chases overdue debt, down payments and broken promises, and gives each task to the right person with a deadline. Tasks close themselves when the problem is solved, for example when the payment arrives.
Management only hears about what slips. Some of his questions to reps must be answered before they carry on, as on the right-hand screen. He speaks to each person in their own tone, formal with management and friendly with reps.
""")

# ---------------------------------------------------------------- 13. AI analyst & automation
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
                       "Each customer's usual basket and order rhythm", "Days of stock left and what to reorder", "Rep working hours and weekly scorecards", "Fuel allowance from the real GPS route"]):
    y = 2.4 + i * 0.52
    icon(s, "checkCircle", 6.2, y + 0.03, 0.32, bg=None, color="g", ratio=1.0)
    text(s, 6.67, y, 6.0, 0.42, c, size=13.5)
footer(s, n)
notes(s, """
Beyond the AI deputy director, KAD OS has an AI analyst: management asks a question in plain words, for example which customers bought less EDGE this quarter and who their rep is, and gets an answer with numbers. Customers and staff are hidden behind codes, and every question is logged.
And many calculations happen automatically: the landing cost of every product, the true cost at the selling price for each discount, the age of every invoice, a suggested credit limit for each customer, each customer's usual basket and order rhythm, days of stock left and what to reorder, rep working hours and scorecards, and the fuel allowance from the real GPS route.
""")

# ---------------------------------------------------------------- 14. Any phone, secure
s = new_slide(); n = nxt()
header(s, "Built for real field work", "Works on any phone, fast, offline and secure")
for i, (ic, title, body) in enumerate([("smartphone", "Any phone or PC", "Opens from a link; no app store"),
                                       ("wifioff", "Works offline", "Visits and orders wait on the phone and send later"),
                                       ("gauge", "Fast on cheap phones", "Speed is tested on a slow phone"),
                                       ("person", "Role-based access", "Everyone sees only what their role allows"),
                                       ("lock", "Secure", "Encrypted connection, protected logins, audit trail"),
                                       ("shield", "Data stays with us", "Our data lives in our own cloud system")]):
    x = 0.6 + (i % 3) * 4.1
    y = 1.95 + (i // 3) * 2.2
    box(s, x, y, 3.9, 2.0, fill=LIGHT)
    icon(s, ic, x + 0.25, y + 0.3, 0.78)
    text(s, x + 1.2, y + 0.32, 2.55, 0.45, title, size=16, bold=True)
    text(s, x + 1.2, y + 0.85, 2.55, 1.05, body, size=13, color=GREY)
footer(s, n)
notes(s, """
KAD OS is built for real field work. It opens from a link on any phone or PC. It works offline: visits and orders wait on the phone and are sent later. It is fast even on cheap phones; we test its speed on a slow phone. Everyone sees only what their role allows. The connection is encrypted, logins are protected, and every key change is kept in an audit trail. And our data stays in our own cloud system.
""")

# ---------------------------------------------------------------- 15. Built fast, adopted fast
s = new_slide(); n = nxt()
header(s, "Built and adopted", "Live in 2 days, adopted in the first month")
for i, (num, lab, sub) in enumerate([("2 days", "from first line of code to the first live version", "22 Aug → 24 Aug 2026"),
                                     ("1st month", "the whole field team working in the app", "September 2026, the first full month after launch"),
                                     ("10 weeks", "to the complete system shown today", "763 improvements, delivered every week")]):
    x = 0.6 + i * 4.1
    box(s, x, 1.95, 3.9, 2.6, fill=GREEN if i == 1 else LIGHT)
    text(s, x + 0.3, 2.15, 3.4, 0.9, num, size=44, bold=True, color=WHITE if i == 1 else GREEN)
    text(s, x + 0.3, 3.1, 3.4, 0.7, lab, size=15, bold=True, color=WHITE if i == 1 else DARK)
    text(s, x + 0.3, 3.85, 3.4, 0.6, sub, size=12, color=WHITE if i == 1 else GREY)
pts = [("22 Aug", "Work starts"), ("24 Aug", "First version live"), ("September", "Whole field team in the app"), ("Today", "Complete system, weekly updates")]
ln = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(1.8), Inches(5.35), Inches(11.5), Inches(5.35)); ln.line.color.rgb = GREEN_MID; ln.line.width = Pt(3)
for i, (d, lab) in enumerate(pts):
    cx = 1.8 + i * (9.7 / 3)
    c = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(cx - 0.14), Inches(5.21), Inches(0.28), Inches(0.28))
    c.fill.solid(); c.fill.fore_color.rgb = GREEN; c.line.fill.background()
    text(s, cx - 1.4, 5.6, 2.8, 0.35, d, size=14, bold=True, align=PP_ALIGN.CENTER)
    text(s, cx - 1.4, 5.95, 2.8, 0.5, lab, size=12, color=GREY, align=PP_ALIGN.CENTER)
footer(s, n)
notes(s, """
How long did it take? Our team started building on 22 August 2026, and the first version was live two days later, on 24 August. The whole field team was working in the app in September, the first full month after launch. In ten weeks we reached the complete system you have just seen, with 763 improvements, delivered every week based on what the team asked for.
The reason it was adopted so quickly is that our own people designed it: reps, the sales director, warehouse, accounting and management told us exactly what they needed.
""")

# ---------------------------------------------------------------- 16. Coming next
s = new_slide(); n = nxt()
header(s, "Coming next", "Next: delivery, warehouse and more AI")
for i, (ic, title, items) in enumerate([("truck", "Delivery & Driver", ["Delivery routes for drivers", "Arrival detected automatically", "Customer signs on the phone"]),
                                        ("box", "Warehouse", ["Picking and packing in the app", "Live stock behind every order", "Stock counts, even offline"]),
                                        ("sparkles", "AI expert agents", ["Sales, finance and stock specialists", "Led by the AI deputy director", "Each finds, assigns and checks"])]):
    x = 0.6 + i * 4.1
    box(s, x, 1.95, 3.9, 4.1, fill=WHITE, line=GREY, radius=0.14, line_w=1.0, dash=True)
    box(s, x + 2.3, 1.8, 1.45, 0.32, fill=DARK, radius=0.16)
    text(s, x + 2.3, 1.8, 1.45, 0.32, "LAUNCHING NEXT", size=9, bold=True, color=WHITE, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    icon(s, ic, x + 0.3, 2.3, 0.95)
    text(s, x + 0.3, 3.45, 3.4, 0.45, title, size=20, bold=True)
    for j, it in enumerate(items):
        yy = 4.1 + j * 0.55
        icon(s, "checkCircle", x + 0.3, yy + 0.02, 0.3, bg=None, color="g", ratio=1.0)
        text(s, x + 0.75, yy, 3.0, 0.5, it, size=13.5)
footer(s, n)
notes(s, """
What comes next. Delivery and Driver: delivery routes for drivers, automatic detection when the driver arrives, and the customer signs on the phone. Warehouse: picking and packing in the app, live stock behind every order, and stock counts even without signal. And more AI: expert agents for sales, finance and stock, led by the AI deputy director. These are not live yet; we build them on the same core, in small weekly steps.
""")

# ---------------------------------------------------------------- 17. Thank you
s = new_slide(); n = nxt()
pic(s, KAD_LOGO, 0.75, 0.9, h=0.5)
ln = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(3.6), Inches(0.75), Inches(3.6), Inches(1.55)); ln.line.color.rgb = LINE; ln.line.width = Pt(1)
pic(s, CASTROL_LOGO, 4.0, 0.86, h=0.58)
lockup(s, 0.75, 2.4, size=54, w=8)
text(s, 0.75, 4.05, 9, 0.6, "The operating system for a modern Castrol distributor.", size=22)
text(s, 0.75, 5.0, 9, 0.6, "Thank you. Questions?", size=26, bold=True, color=GREEN)
footer(s, n)
notes(s, """
Thank you. To sum up: KAD OS is one app for the whole distributor team; it checks every visit, order, price and payment; an AI deputy director keeps everyone on plan; and management sees everything live. Our team built it in weeks and adopted it in the first month. I am happy to answer questions or show the app live.
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
