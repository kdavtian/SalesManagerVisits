# Speaker notes for the "teams" edition (Castrol sales & marketing teams and their team leads), v2 (owner, 2026-11-10).
# One entry per slide of the talk (18) and the backup section (7). Each starts with its time cue and key message.
# The same text is the word-for-word script (teams_script.py prints it as a PDF). About 125 spoken words a minute.

MAIN_NOTES = [
# 1 Title
"""[0:00 - 1:45]  KEY MESSAGE: one app runs a whole Castrol distributor, and shows the brand what happens in the field.
Good morning, and thank you for having us. I am from KAD Motors, the Castrol distributor in Armenia.
Let me start with a question. (Pause.) Raise your hand if you have ever asked a distributor: in which shops is our product on the shelf today? (Wait.) And how long did you wait for the answer?
Today I want to show you KAD OS, the app our own team built to run the distributor: every visit, every order, every payment and every delivery. And I will show it through your eyes, as sales and marketing people: what it tells the brand about the field. Everything you see is the real app, with demo data. We keep ten minutes for your questions at the end.""",

# 2 Eleven problems
"""[1:45 - 5:15]  KEY MESSAGE: eleven everyday problems, and one app that answers all of them. Everything else today is detail.
Here are eleven problems that every distributor and every brand team knows. On the left of each card the problem in red, under it our answer in green.
(Top row.) Was the field really visited? Today a visit report says yes, but nobody can prove it. In KAD OS a visit is a GPS check-in with a photo, refused beyond 300 metres. What is on the shelf? The rep checks the Castrol shelf at every visit. Where is fake product sold? Fake product is flagged, field by field.
(Second row.) Which competitors are in the shop? The rep ticks the brands he sees, at every visit. Which shops do not buy Castrol yet? They are in the app as potential customers, with the reason, a level and the litres we expect. Orders by phone, or on paper with a pen? Now the order is in the app, with fixed prices, the discounts and offers applied automatically; and if the rep needs a bigger discount, the request goes straight to the manager.
(Third row.) Reports that take days? There is a live dashboard, plus daily, weekly and monthly reports, to the sales head, the CEO or anyone who needs them. Problems found too late? An AI agent checks everything, one by one, and finds them. Tasks lost in calls and chats? Tasks live in the app: the manager reviews each visit, sees everything the rep wrote and added, and sets a task for any customer; the AI agent creates and follows tasks too.
(Last row.) How much does this customer owe? The rep sees the debt in the app; no more calls to accounting or finance before collecting cash. And do our offers reach the shop? That is our next step, the customer app.
Eleven questions, one app. Now let me show you how it works.""",

# 3 A to Z (v6 slide 6)
"""[5:15 - 7:30]  KEY MESSAGE: everyone works in the same app, so one order flows from the shelf to the evening report without paper or calls.
KAD OS is one app for everyone in the distributor: sales reps, the sales director, the warehouse, the driver, the accountant and management. It opens from a link on the phones they already have, with no app store, and it works without signal.
Here is one day, from A to Z, with demo data. At 09:40 the rep checks in at a shop, with GPS and a photo, and records the shelf. At 09:52 he takes the order from the customer's usual basket, at the right price list. Before noon the warehouse picks it, ticking each line, and presses Packed. In the afternoon the driver follows the optimised route, and the customer signs on the phone. At 19:00 management gets the evening report: sales, cash, debt and risks.
No paper, no phone calls, and nobody types anything twice. Because everyone works in one system, the data about each customer is complete: the visit, the shelf, the order, the payment and the delivery are connected. Let us go through it, starting with the visit.""",

# 4 Check-in
"""[7:30 - 10:00]  KEY MESSAGE: a visit only counts when the rep is really there, and every visit brings back shelf data.
Chapter one: every visit is real. (Point to the progress bar top right: five chapters.)
The rep opens the customer and taps Check In. The phone finds the GPS position at once. The check-in is accepted only within 300 metres, and the real distance and the GPS accuracy are saved with it. So a visit report from the office or from the car is not possible.
Then he chooses what happened: an order, a payment, an assortment check, a delivery or a revisit. (Middle phone.)
Then comes the part that matters most for you: the shelf. Is Castrol available, is the full range there, is there fake product? And he ticks the competitor brands he sees. (Right phone: the competitor list.)
A short note and a photo, in high resolution for price tags, and he submits, even without signal. If he took an order, the order screen opens next. The whole visit takes less than a minute, and that is why reps really do it at every visit.
For a team lead the point is this: you no longer manage the team by asking where they were. You can see it, and you spend your time on what they found.""",

# 5 Visits that cannot be faked
"""[10:00 - 12:00]  KEY MESSAGE: proven visits and field-level shelf data the brand never had.
Two details make the data trustworthy.
On the left the rep is 6 kilometres from the customer: the app blocks the check-in. If the pin on the map is wrong, it offers to check the map, and repeated GPS evidence from real visits shows management which customers have a wrong pin, so it gets fixed. The start and the end of each visit are recorded too, so we know how long the rep stayed.
On the right is the Castrol shelf check: available, full range, fake product, field by field.
This is something the brand never had: not an audit of 50 shops once a year, but every customer at every visit, with the date, the place and the rep. Management sees all of it in the visit history. That is chapter one: every visit is real.""",

# 6 Customers & filters
"""[12:00 - 14:00]  KEY MESSAGE: every customer, including the ones that do not buy yet, on one map, and any target list in a minute.
Chapter two, the most important one for this room: the brand sees every field.
Every customer is on the map. A pin shows the type and the visit status, and one tap shows the debt, the last order and the last visit. And not only the shops that buy from us: also the potential customers, with a level, the reason they do not buy yet, for example a price mismatch or a contract with a competitor, and the litres a month we expect. (Right phone.)
When a rep finds a new shop, he adds it straight from the map where he stands; the region and the rep are filled in automatically.
And the filters: channel, rep, region and district, visit status, and, most useful for you, the shelf. All shops with fake product. All shops without Castrol. (Middle phone: regions open into districts.)
So when a campaign needs a target list, it takes one minute, not two weeks.""",

# 7 Customer card
"""[14:00 - 16:00]  KEY MESSAGE: before a rep walks in, he knows the whole story of the customer in ten seconds.
The customer card puts everything about one customer on one screen.
At the top the profile: address, phone, channel, rep, how often to visit, the payment term and the credit limit. Then the money at a glance: sales this month, the debt with its due date, and the last payment. The dates that matter: last order, last visit, next planned visit.
Lower down, the products at this shop from the latest shelf check: Castrol on the shelf, the full range, the competitors seen. Then the visit history, and one-tap actions: check in, new task, new order, navigate.
And every tile opens its detail. Tap Last order (right phone) and the whole order opens, with every line and a Reorder button.
Before a rep walks in, he knows what they buy, what is on their shelf and what they owe.""",

# 8 What the field data gives Castrol
"""[16:00 - 18:30]  KEY MESSAGE: the same field data answers the questions sales and marketing teams ask every month.
So what does all this give Castrol's sales and marketing teams? Six things.
One, distribution gaps: the shops without Castrol on the shelf, by region and district. That is your list for a distribution drive.
Two, fake product hotspots: every field where fake product was seen, with the visit date and the photo. Evidence for action, not a rumour.
Three, competitor presence: which brands each shop carries, recorded at every visit, not once a year.
Four, the customers to win next: potential customers with their level, the reason, and the litres we expect.
Five, order rhythm: each customer's usual basket and how often it orders. When a customer stops ordering, it becomes a task, as you will see in chapter four.
And six, campaign follow-up: the shelf before and after a campaign, field by field.
Think back to my first question: in which shops is our product on the shelf? With KAD OS the answer takes a minute, and a month later the shelf checks show which shops now carry it. That is the difference between hoping and knowing.""",

# 9 Orders
"""[18:30 - 20:45]  KEY MESSAGE: no more orders by phone or paper; prices, offers and discount rules are applied automatically.
Chapter three: orders and money.
Before, orders came by phone, or on paper with a pen, and the price depended on who wrote it. Now the order is in the app.
The rep starts a new order, the customer's usual basket, or a repeat of a past order. The products this customer buys often come first, with brand chips, search and the stock shown.
The prices for this customer's level and the offers are applied automatically, and a discount up to 3 percent too. If the rep needs more, he sends the request in the app and it goes straight to the manager to approve. A price below our cost can only be approved by the CEO.
After saving, everyone sees the status live: submitted, confirmed, packed, delivered. And the order form is ready at once: the rep prints it, the customer signs, and the rep uploads a photo of the signed copy.
For the brand it means one thing: the agreed price list and the offers are really applied in the field.""",

# 10 Debt & cash
"""[20:45 - 22:30]  KEY MESSAGE: the rep sees the debt himself, so cash collection no longer waits for accounting.
Debt and cash. Before, a rep who wanted to collect money first called accounting or finance: how much does this customer owe? Now he sees it in the app, per customer and per invoice, with the due dates. Overdue invoices are red.
An overdue invoice automatically becomes a collection task for the rep's next visit. The rep records the date the customer promises to pay; if the promise is broken, the sales director is told.
Payments are recorded on the phone during the visit (right phone) and followed until the cash reaches the accountant. And an order over the customer's credit limit waits for approval.
For you this matters because a distributor with healthy credit keeps buying Castrol, and reps who do not wait for accounting spend their time selling.""",

# 11 Tasks & AI agent
"""[22:30 - 24:45]  KEY MESSAGE: every problem found in the field becomes a task, created by a manager or by the AI agent, and followed to the end.
Chapter four: AI and reports.
First, tasks. After each visit the manager can open it and see everything the rep wrote, ticked and photographed. Based on that he sets a task in one tap, for any customer and any rep, with a deadline. (Left phone: the rep's task list.)
Second, the AI agent. In the app we call him Vaghinak. He checks everything, one by one: every visit, every order, every payment, every day. He creates tasks himself, gives them to the right person with a deadline, and closes them when the data shows they are done, for example when the payment arrives.
(Middle phone.) Management gets messages like: "Rep B started 41 minutes late, the third time this week; Rep C stopped after 4 of 9 planned visits." (Right phone.) And the rep gets: "Nice work today. There are two planned shops 200 metres from your last stop. Will you drop in before you leave the area?"
Formal with management, friendly with the reps. Think of him as a team lead who never forgets to follow up.""",

# 12 How the AI agent decides (v6 slide 26)
"""[24:45 - 27:00]  KEY MESSAGE: watch, notice, assign, check, escalate.
How does the agent decide? Five steps. He watches the data all day. He notices when something differs from the usual pattern of a customer or a rep. He assigns a task to the right person, with a deadline. He checks the data to see whether it was done, and closes the task himself. And he tells management only when it keeps slipping.
Three examples. A customer usually orders every two weeks, and this time no order came: the rep gets a task to visit and remind the customer, and it closes when the next order arrives. For the brand, that is a lost order saved.
A customer pays every week, and this week there is no payment: a collection task, which closes by itself when the rep records the money on the customer card.
And the team starts the day at the office: when someone arrives late, the agent asks for the reason, and after the third time management is told.""",

# 13 Human approvals (v6 slide 27)
"""[27:00 - 28:15]  KEY MESSAGE: the system and the AI do the work, but people decide the things that matter.
Because AI can make mistakes, people approve every decision that matters. Discounts above 3 percent: management. A price below our cost: only the CEO. Over the credit limit: the sales director or the accountant. New orders: the sales director. Invoices: the chief accountant approves and signs. Cash: the accountant confirms what arrived. Changes reps make to customer data: management reviews them.
And the AI agent itself started in test mode: management read what it would say and tuned it before switching it on.""",

# 14 Reports
"""[28:15 - 30:00]  KEY MESSAGE: the numbers come to management by themselves: live, daily, weekly and monthly.
And the reports. Nobody prepares them; they are written from the work the team does in the app.
(Left phone.) Every evening the Executive Assistant sends a short report: sales and volume today and month to date against plan, cash collected and overdue debt, the products about to run out, and any number far from normal. At the end of each week and month it sends a longer summary.
(Middle phone.) The live dashboard: sales against plan, by rep and by channel. (Right phone.) And the full reports: money and debt, sales and litres by product line, the team and the stock.
They go to whoever needs them: the sales head, the CEO, the team leads. Each person sees their own scope: a rep sees only his own customers.""",

# 15 Adoption
"""[30:00 - 32:00]  KEY MESSAGE: adoption is a people project: make the app save time, make results visible, and reward the habit.
Last chapter, and the question every team lead asks: how do you get a whole team to use it?
Honestly, this was the hardest part. A new app means new habits, and at the start not every visit was logged.
We did two things. A bonus system: reps earn points for visits, collected payments, delivered orders, attendance and small challenges. And a monthly contest: the rep with the most check-ins in the month wins a fixed bonus. The leaderboard and each rep's progress are visible to everyone, live. We still run it today; it pushes the team to log all their work, and the reps simply work more actively.
Three lessons for the team leads here: start with what saves the rep time, like the usual basket and the debt on the card, not with control; make results visible every day; and reward the habit you want until it is normal.""",

# 16 Built and adopted (v6 slide 30)
"""[32:00 - 33:00]  KEY MESSAGE: three months to the first live version, the whole team in the fourth.
How long did it take? We started in May 2026. The first version was live three months later, in August. In September, the fourth month, the whole field team was working in the app. And by the sixth month we had the complete system you saw today, improved every week with what the team asked for.""",

# 17 Next: customer app (v6 slide 32)
"""[33:00 - 34:30]  KEY MESSAGE: next, the customers themselves join KAD OS, and Castrol's offers reach the shop directly.
What comes next answers the last of the eleven questions: do our offers reach the shop?
We are opening KAD OS to our customers, so the workshops can work with us directly. They will order online at any time at their own prices, see offers and discounts on their own dashboard, follow every order and see their balance, and get a notification when an order is placed and when a payment arrives.
Today we still send customers updates by hand; with the customer app that disappears. For Castrol it means a direct channel for promotions to every shop. Imagine launching an offer and seeing in the same week which workshops opened it and ordered.""",

# 18 Takeaways + thank you
"""[34:30 - 35:00, then questions until 45:00]  KEY MESSAGE: repeat the three takeaways slowly, then open the questions.
If you remember three things: one, every visit is real, verified by GPS, with a shelf check. Two, the brand sees every field: shelf, fake product, competitors, potential customers and order rhythm. Three, the team stays on plan, with tasks and an AI agent, and the whole team adopted it within four months.
Thank you. We are happy to take your questions.
(Presenter: repeat each question before answering; keep answers under a minute; backup slides B1 to B7 follow this slide. Stop at 45:00 and offer to continue one to one.)""",
]

BACKUP_NOTES = [
# B1 Home screen (v6 5)
"""BACKUP (home screen). The home screen as management sees it: 1, notifications and the menu; 2, this week's progress, visited, remaining and overdue customers; 3, quick actions, each tile opens a module; 4, the bottom bar with Home, Activity, the map in the centre, Customers and Orders. Each role sees its own home: a rep starts with today's tasks, the warehouse with what to pack, the driver with the next stop.""",
# B2 Accounting & invoicing (v6 18)
"""BACKUP (accounting and invoicing). The rep chooses invoice or cash while making the order; the sales director approves; for an invoice, the invoice is created through the connected local invoicing system and the chief accountant approves and signs; for cash, the delivery document is created and the driver is notified to download and print it. Signed copies come back as photos. Customer updates are still sent by hand today; the customer app will show them automatically.""",
# B3 Warehouse (v6 20)
"""BACKUP (warehouse). The warehouse home shows orders to pack, the oldest waiting and what is late. One card per order: tick each line while picking, then Packed. A pick list by product across all orders, with short stock in red, and a Problem button. A daily blind stock count, each product once a month, and a reorder list with days of stock left.""",
# B4 Delivery (v6 22)
"""BACKUP (delivery and driver). Packed orders become a route in one tap, in the shortest order. The driver sees the next stop first, with Navigate and Call. Arrival is detected; management chooses whether that does nothing, offers a one-tap Delivered, or marks it delivered automatically. The customer signs on the phone, cash collected is recorded, a failed delivery keeps its reason, and the order turns Delivered for everyone.""",
# B5 Routes & fuel (v6 15)
"""BACKUP (routes and fuel allowance). Each rep has a weekly route plan, built automatically: the rep's customers spread over the week, nearby shops on the same day. The fuel allowance is calculated from the real day: the check-ins in time order and the road distance between them; a check-in far from its customer is left out; home legs are added outside Yerevan; city and highway kilometres use different consumption; unusual days are flagged and management can correct them.""",
# B6 AI & automation (v6 28)
"""BACKUP (AI analyst and automatic calculations). Management can ask the AI analyst a question in plain words and get an answer with numbers; customers and staff are hidden behind codes, it is read-only and every question is logged. Calculated automatically: landing cost, true cost at each discount, debt age, suggested credit limit, usual basket and order rhythm, days of stock and reorder list, delivery route, working hours and scorecards, fuel allowance.""",
# B7 Built for field work (v6 29)
"""BACKUP (built for field work). Any phone or PC from a link, no app store; works offline and sends later; fast on cheap phones (tested on a slow phone); role-based access; encrypted connection, protected logins and an audit trail; our data stays in our own cloud system.""",
]
