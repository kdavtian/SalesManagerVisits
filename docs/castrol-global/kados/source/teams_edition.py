# "Teams" edition of the KAD OS deck: the app presented to Castrol's sales and marketing teams and their team leads.
# 45 minutes = 35 minutes of talk + 10 minutes of questions.
# v2 (owner, 2026-11-10): agenda slide removed; the opening slide lists 11 problems and their answers; "field" instead of
# "outlet"; no video slides (the flows are shown as screens); duplicate slides merged so the talk is 18 slides
# (about 2 minutes each) plus 7 backup slides; a "Why it matters for Castrol" line on every feature slide.
#   DECK_EDITION=teams python3 build_kados.py   ->  ../../KAD_OS_Castrol_Teams.pptx
# Runs inside build_kados.py (exec'd into its namespace) after all v6 slides exist.

V6 = {i + 1: s for i, s in enumerate(prs.slides)}   # the 33 v6 slides, 1-based, in v6 order

CHAPTERS = ["Every visit is real", "The brand sees every field", "Orders and money", "AI and reports", "Adoption and next"]


def chapter_tag(sl, k):
    """Top-right chapter name with a 5-step progress bar, so the room always knows where the talk is."""
    text(sl, SW - 6.1, 0.24, 5.5, 0.25, f"{k}/5 · {CHAPTERS[k - 1].upper()}", size=10, bold=True, color=GREEN_DARK, align=PP_ALIGN.RIGHT)
    for j in range(5):
        box(sl, SW - 0.6 - (5 - j) * 0.42 + 0.04, 0.52, 0.36, 0.06, fill=GREEN if j < k else LINE, radius=0)


def why(sl, msg, y=6.33):
    box(sl, 0.6, y, SW - 1.2, 0.52, fill=GREEN_TINT, radius=0.1)
    text(sl, 0.85, y, SW - 1.7, 0.52, [[("Why it matters for Castrol:  ", {"bold": True, "color": GREEN_DARK}), (msg, {})]], size=13, anchor=MSO_ANCHOR.MIDDLE)


def feature(k, kicker, headline, phones, steps, msg, caps, phone_h=4.25):
    s = new_slide(); n = nxt()
    header(s, kicker, headline)
    chapter_tag(s, k)
    gap = phone_h * 0.487 + 0.14
    for i, name in enumerate(phones):
        x = 0.45 + i * gap
        if name == "shelf_audit":
            pic(s, os.path.join(SHOTS, "shelf_audit.png"), x, 2.05, w=gap - 0.1)
        else:
            phone(s, name, x, 1.68, phone_h)
        text(s, x, 1.68 + phone_h - 0.03, gap - 0.14, 0.3, caps[i], size=10.5, bold=True, color=GREEN_DARK, align=PP_ALIGN.CENTER)
    right = 0.45 + len(phones) * gap + 0.25
    steps_list(s, right, 1.78, SW - 0.6 - right, 4.45, steps)
    why(s, msg)
    footer(s, n)
    return s


S = {}

# ---------------------------------------------------------------- 2. eleven questions, one app
s = new_slide(); n = nxt()
header(s, "The blind spot", "11 everyday problems, and how KAD OS answers each one")
cells = [("mapWarning", "Was the field really visited?", "GPS check-in with a photo; refused beyond 300 m"),
         ("eye", "What is on the shelf?", "A Castrol shelf check at every visit"),
         ("warning", "Where is fake product sold?", "Fake product flagged, field by field"),
         ("store", "Which competitors are in the shop?", "Competitor brands recorded at every visit"),
         ("target", "Which shops don't buy Castrol?", "Potential customers with level, reason and expected litres"),
         ("phone", "Orders by phone, or on paper", "In the app: fixed prices, automatic discounts and offers; a bigger discount goes to the manager"),
         ("clock", "Reports that take days", "Live dashboard, plus daily, weekly and monthly reports to the sales head, CEO or anyone"),
         ("sparkles", "Problems found too late", "An AI agent checks everything, one by one, and finds the problems"),
         ("tasks", "Tasks lost in calls and chats", "Tasks in the app: the manager reviews each visit and sets tasks; the AI agent creates and follows them too"),
         ("wallet", "\"How much does this shop owe?\"", "Debt visible in the app: no call to accounting before collecting cash"),
         ("send", "Do our offers reach the shop?", "Next: offers on the customer's own dashboard")]
for i, (ic, prob, sol) in enumerate(cells):
    col, row = i % 3, i // 3
    x, y = 0.6 + col * 4.07, 1.72 + row * 1.29
    box(s, x, y, 3.95, 1.17, fill=LIGHT)
    icon(s, ic, x + 0.15, y + 0.2, 0.55, bg=RED_TINT, color="r")
    text(s, x + 0.82, y + 0.12, 3.03, 0.32, prob, size=12.5, bold=True, color=RED)
    text(s, x + 0.82, y + 0.45, 3.03, 0.7, sol, size=11, bold=True, color=GREEN_DARK, line=1.0)
x, y = 0.6 + 2 * 4.07, 1.72 + 3 * 1.29
box(s, x, y, 3.95, 1.17, fill=GREEN)
text(s, x + 0.25, y, 3.5, 1.17, [[("11 questions.", {})], [("One app.", {})]], size=22, bold=True, color=WHITE, anchor=MSO_ANCHOR.MIDDLE)
footer(s, n)
S["blind"] = s

# ---------------------------------------------------------------- chapter 1
S["checkin"] = feature(1, "Check-in", "A visit in under a minute, with the shelf on record", ["checkin", "checkin_outcome", "competitors"],
    [("Open the customer, tap Check In", "The phone finds the GPS position at once"),
     ("Location verified", "Accepted only within 300 m; the distance and accuracy are saved"),
     ("Choose what happened", "Order, payment, assortment check, delivery, revisit"),
     ("Record the shelf", "Castrol available, full range or fake; competitors seen"),
     ("Note and photo", "High resolution for price tags"),
     ("Submit, even offline", "With an order, the order screen opens next")],
    "every visit brings back shelf, fake-product and competitor data, field by field.",
    ["Location verified", "Visit outcome", "Competitors"])

S["proof"] = feature(1, "Check-in", "Visits that cannot be faked", ["checkin_far", "shelf_audit"],
    [("Too far? Refused", "6 km away, the app blocks the check-in and offers \"Wrong pin? See the map\""),
     ("Wrong pins are found", "Repeated GPS evidence shows customers whose map pin is wrong"),
     ("Visit length", "The start and end of each visit are recorded"),
     ("Castrol shelf check", "Available, full range or fake product, field by field"),
     ("Management sees it", "Visit history per customer and per rep, with time and place")],
    "the visit reports you receive are proven, not written from the office.",
    ["Too far: refused", "Shelf check"])

# ---------------------------------------------------------------- chapter 2
S["customers"] = feature(2, "Customers & filters", "Every customer on one map, found in seconds", ["map", "filter_region", "potential_card"],
    [("Every customer on the map", "Pins show type and visit status; one tap shows debt, last order, last visit"),
     ("Potential customers too", "Shops that do not buy yet, with level, reason and expected litres"),
     ("New customer from the map", "Added where the rep stands; region and rep filled in"),
     ("Filters for everything", "Channel, rep, region, district, visit status"),
     ("Filter by the shelf", "For example: shops with fake product, or without Castrol")],
    "a target list for any campaign in one minute: region, shelf, potential.",
    ["Map", "Region filter", "Potential customer"])

S["card"] = feature(2, "Customer card", "The whole story of one customer, on one screen", ["customer", "customer_more", "last_order"],
    [("Profile", "Address, phone, channel, rep, visit frequency, payment term, credit limit"),
     ("Money at a glance", "Sales this month, debt with its due date, last payment"),
     ("Dates that matter", "Last order, last visit, next planned visit"),
     ("Products at this shop", "Castrol on the shelf, full range, competitors seen"),
     ("One tap to the detail", "Last order with every line and Reorder; visit history; new task")],
    "the rep walks in knowing the customer: what they buy, what is on the shelf, what they owe.",
    ["Top of the card", "Scrolled down", "Last order"])

S["data"] = feature(2, "Field intelligence", "What the field data gives Castrol sales & marketing", ["map_popup", "competitors"],
    [("Distribution gaps", "Shops without Castrol on the shelf, by region and district"),
     ("Fake product hotspots", "Every field where fake product was seen, with the visit date and photo"),
     ("Competitor presence", "Which brands each shop carries, recorded at every visit"),
     ("Customers to win next", "Potential customers with level, reason and expected litres a month"),
     ("Order rhythm", "Each customer's usual basket and how often it orders; a gap becomes a task"),
     ("Campaign follow-up", "Shelf checks before and after a campaign, field by field")],
    "you stop asking the distributor for a report and start working from live field data.",
    ["Map pin", "Competitors on the shelf"])

# ---------------------------------------------------------------- chapter 3
S["orders"] = feature(3, "Orders", "Orders in a few taps, at the right price", ["order", "order_sheet", "order_saved"],
    [("Start the way you want", "New order, the usual basket, or repeat a past order"),
     ("Pick products", "Frequent products first; brand chips, search, stock shown"),
     ("Prices and offers applied", "Customer-level prices; discounts up to 3% automatic"),
     ("Bigger discount? Ask in the app", "The request goes straight to the manager to approve"),
     ("Live status", "Submitted, confirmed, packed, delivered; everyone sees it"),
     ("Print, sign, photo", "The order form is ready at once; the signed copy is uploaded")],
    "the agreed price list and the offers are really applied in the field.",
    ["Pick products", "Review", "Saved: print"])

S["debt"] = feature(3, "Debt & cash", "Debt in the app: no call to accounting", ["debt_sheet", "payment_add"],
    [("Debt visible to the rep", "Per customer and per invoice, with due dates; red when overdue"),
     ("No call to finance", "The rep sees the amount to collect before the visit"),
     ("Collection task", "Overdue debt becomes a task for the next visit"),
     ("Promise date", "A broken promise goes to the sales director"),
     ("Payment at the visit", "Recorded on the phone, followed until it reaches the accountant"),
     ("Credit limit", "Over the limit, the order waits for approval")],
    "healthy credit keeps the distributor buying, and reps spend their time selling.",
    ["Payments received", "Record a payment"])

# ---------------------------------------------------------------- chapter 4
S["ai"] = feature(4, "Tasks & AI agent", "Tasks in the app, created by managers and by AI", ["tasks", "vaghinak", "vaghinak_rep"],
    [("Manager reviews the visit", "Sees everything the rep wrote, ticked and photographed"),
     ("Sets a task in one tap", "For any customer, any rep, with a deadline"),
     ("The AI agent checks everything", "Every visit, order and payment, one by one, every day"),
     ("It creates and follows tasks", "Right person, deadline; closes by itself when done"),
     ("Management hears what slips", "Formal with management, friendly with reps")],
    "every problem found in the field becomes a task, and every task is followed to the end.",
    ["Tasks", "AI agent: management", "AI agent: rep"])

S["reports"] = feature(4, "Reports", "The numbers come to you: live, daily, weekly, monthly", ["assistant", "dashboard", "reports"],
    [("Live dashboard", "Sales against plan, by rep and by channel"),
     ("Evening report", "Sales, volume, cash, debt and stock risks, every day"),
     ("Weekly and monthly", "Longer summaries at the end of each period"),
     ("To anyone who needs it", "Sales head, CEO, team leads; each sees their own scope"),
     ("Unusual numbers flagged", "Anything far from normal is pointed out")],
    "nobody prepares the report: it is written from the work the team does in the app.",
    ["Evening report", "Dashboard", "Reports"])

# ---------------------------------------------------------------- chapter 5
S["adoption"] = feature(5, "Adoption", "How we got the whole team to use it", ["bonuses", "team_progress"],
    [("The hardest part", "New habits: at first not every visit was logged"),
     ("A bonus system", "Points for visits, payments, deliveries, attendance and challenges"),
     ("A monthly contest", "Most check-ins in the month wins a fixed bonus"),
     ("Visible to everyone", "Leaderboard and progress by rep, updated live"),
     ("Still running today", "Everything is logged, and the team works more actively")],
    "complete field data only comes when the whole team uses the app every day.",
    ["Bonuses and leaderboard", "Progress by rep"])

# ---------------------------------------------------------------- 18. takeaways + thank you
s = new_slide(); n = nxt()
pic(s, KAD_LOGO, 0.75, 0.75, h=0.45)
ln = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(3.3), Inches(0.6), Inches(3.3), Inches(1.35)); ln.line.color.rgb = LINE; ln.line.width = Pt(1)
pic(s, CASTROL_LOGO, 3.65, 0.7, h=0.52)
lockup(s, 0.75, 2.2, size=48, w=5.5)
text(s, 0.75, 3.75, 5.3, 1.0, "The operating system for a modern Castrol distributor.", size=19, line=1.05)
text(s, 0.75, 5.0, 5.3, 0.6, "Thank you. Questions?", size=28, bold=True, color=GREEN)
three = [("mapPinCheck", "Every visit is real", "GPS-verified check-ins with a shelf check, competitors and a photo."),
         ("eye", "The brand sees every field", "Shelf, fake product, competitors, potential customers and order rhythm."),
         ("sparkles", "The team stays on plan", "Tasks and an AI agent; the whole team was in the app by month 4.")]
text(s, 6.75, 0.8, 6.0, 0.3, "THREE THINGS TO REMEMBER", size=12, bold=True, color=GREEN)
for i, (ic, t, b) in enumerate(three):
    y = 1.3 + i * 1.82
    box(s, 6.75, y, 6.0, 1.62, fill=GREEN if i == 1 else LIGHT)
    icon(s, ic, 7.0, y + 0.42, 0.78, bg=WHITE if i == 1 else GREEN_TINT)
    text(s, 8.05, y + 0.25, 4.5, 0.45, f"{i + 1}. {t}", size=19, bold=True, color=WHITE if i == 1 else DARK)
    text(s, 8.05, y + 0.78, 4.5, 0.75, b, size=13.5, color=WHITE if i == 1 else GREY, line=1.05)
footer(s, n)
S["end"] = s

# chapter tags on the reused v6 slides of the talk
for sl, k in ((V6[26], 4), (V6[27], 4), (V6[30], 5), (V6[32], 5)):
    chapter_tag(sl, k)

# ---------------------------------------------------------------- running order
MAIN = [V6[1], S["blind"], V6[6],
        S["checkin"], S["proof"],
        S["customers"], S["card"], S["data"],
        S["orders"], S["debt"],
        S["ai"], V6[26], V6[27], S["reports"],
        S["adoption"], V6[30], V6[32], S["end"]]
BACKUP = [V6[5], V6[18], V6[20], V6[22], V6[15], V6[28], V6[29]]
keep = MAIN + BACKUP

# drop every other slide (the v6 originals that were merged, and all video slides), then re-order
lst = prs.slides._sldIdLst
keep_order = [sl.slide_id for sl in keep]          # read the ids before the list is changed
keep_ids = set(keep_order)
for el in list(lst):
    if int(el.get("id")) not in keep_ids:
        prs.part.drop_rel(el.get(qn("r:id")))
        lst.remove(el)
els = {int(el.get("id")): el for el in lst}
for el in list(lst):
    lst.remove(el)
for sid in keep_order:
    lst.append(els[sid])

for sl in BACKUP:
    box(sl, SW - 1.75, 0.22, 1.15, 0.32, fill=LIGHT, radius=0.16)
    text(sl, SW - 1.75, 0.22, 1.15, 0.32, "BACKUP", size=10, bold=True, color=GREY, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)


def set_number(sl, label):
    for sh in sl.shapes:
        if sh.has_text_frame and abs(sh.top - Inches(7.1)) < Inches(0.02) and sh.left > Inches(SW - 2) and sh.text_frame.text.strip().isdigit():
            sh.text_frame.paragraphs[0].runs[0].text = label
            return


for i, sl in enumerate(MAIN, 1):
    set_number(sl, str(i))
for i, sl in enumerate(BACKUP, 1):
    set_number(sl, f"B{i}")

# title slide subtitle for this audience
for sh in V6[1].shapes:
    if sh.has_text_frame and sh.text_frame.text.startswith("The app, feature by feature"):
        sh.text_frame.paragraphs[0].runs[0].text = "For Castrol sales & marketing teams · KAD Motors, Armenia · November 2026"

# owner: say "field", never "outlet" (all slide text)
FIELD = [("outlet by outlet", "field by field"), ("Outlet by outlet", "Field by field"), ("outlets", "fields"), ("Outlets", "Fields"), ("outlet", "field"), ("Outlet", "Field")]
for sl in keep:
    for sh in sl.shapes:
        if sh.has_text_frame:
            for p in sh.text_frame.paragraphs:
                for r in p.runs:
                    for a, b in FIELD:
                        r.text = r.text.replace(a, b)

# speaker notes (timed)
exec(open(os.path.join(HERE, "teams_notes.py"), encoding="utf-8").read(), globals())
assert len(MAIN_NOTES) == len(MAIN) and len(BACKUP_NOTES) == len(BACKUP)
for sl, body in zip(MAIN, MAIN_NOTES):
    notes(sl, body)
for sl, body in zip(BACKUP, BACKUP_NOTES):
    notes(sl, body)

OUT = os.path.join(HERE, "..", "..", "KAD_OS_Castrol_Teams.pptx")
