# Document flow and electronic signature: options for the owner to choose (2026-10-26)

Status: **the owner answered on 2026-10-26** (decisions below); building in three releases: 1.427.0 documents foundation, 1.428.0 electronic signature, 1.429.0 AI check. Original text kept for reference. The starting point was:
Files (hy Նյութեր) on every customer card has a Photos part and a Documents part; a photo of the signed order blank taken at a
"Products delivered" check-in is stored and listed under Documents (1.425.0).

## 1. Where documents live (pick one)
- **A. Folders per customer** (Files > Documents): order blanks, payment slips, signed invoices. Simple, what exists now.
- **B. Folders per order**: each order carries its blank, signed blank, slip; the customer's Files shows all of them.
- **C. Accountant inbox**: one page "Documents" with filters (today, rep, type, not yet matched to an order/payment).
- Recommendation: **A + B + C on one data model**: a document belongs to the customer, is linked to the order or payment it proves, and the
  accountant sees all of them in the inbox. File names are made automatically (date + order code + type).

## 2. Who adds documents
- Rep: at check-in (order blank when delivering, payment slip when collecting money) and from the customer's Files > Add document.
- Delivery driver: at the delivery stop (he already has a finger-signature pad that stores a PNG; the new flow would replace it).
- Accountant / management: can view everything, admin can delete or replace. A rep sees only his own customers' documents.

## 3. The photo itself
- Always: shrink to a readable size, stand upright by the camera's orientation flag (done for thumbnails already).
- Add a **Rotate** button on the preview, so a sideways page is fixed before sending (recommended).
- Later, only if photos prove hard to read: automatic page cropping / "scanner" look (a heavier feature).

## 4. Reading the photo and comparing with the order (AI)
- **No AI**: store only (free).
- **AI after upload** (recommended for order blanks of delivered orders): the picture goes to the AI (same AI connection Ask KAD uses,
  `ANTHROPIC_API_KEY` on the droplet) which reads: order number, date, customer, products, quantities, total, whether a customer
  signature / stamp is present, whether the supplier signature is present. The app compares this with the order in the system and flags:
  missing signature, wrong order number, different quantities or total, unreadable photo.
- Alerts: the rep at once ("photo is blurry, retake" / "no customer signature"), the accountant in a daily "documents to review" list,
  Vaghinak asks if a delivered order still has no document after a day.
- Honest limits: the AI can say a signature is **present**, it cannot prove whose it is. Photos are sent to the AI provider. Cost is a few
  cents per photo at most (to be measured on real photos before switching on for everything).

## 5. Storage
- A photo is about 0.3 to 0.5 MB. 100 documents a day is roughly 10 to 15 GB a year on the droplet disk (already in the nightly backup).
- Question: how long must documents be kept (accounting rules)? Default: forever.

## 6. Electronic signature on the phone (questions)
1. Which paper? The app already makes the **delivery-acceptance act** (the order blank PDF with two signature lines). Is that the document the
   customer signs? Then the customer's finger signature goes into the receiver line and the representative's into the supplier line.
2. Whose phone? Recommended first version: the rep's phone is handed to the customer. Later: the customer signs on their own phone through KAD OS.
3. Next to the signature: the receiver's name and position typed in? (Recommended: yes, one line.)
4. The rep signs once (saved on his profile) and it is added automatically afterwards, as you asked. Should the rep tap "confirm" each time
   or is it fully silent? (Recommended: silent, with the profile page showing the saved signature and a "draw again" button.)
5. Legal weight: a finger signature is a "simple" electronic signature. Please check with your lawyer / accountant that your customers' contracts
   accept it. The app will keep signature image, time, place, device and a fingerprint of the PDF so any later change is detectable.
6. Several orders delivered in one visit: one signature for all, one PDF per order (recommended)?
7. Send the signed PDF to the customer (Telegram / WhatsApp / e-mail)? Which channel?
8. No internet at the shop: sign anyway, the PDF is made when the phone is online again (recommended).
9. After the customer signed, lock the order so quantities cannot be changed (recommended).
10. Drivers: use the same flow (replaces the current signature pad)?

## Owner's decisions (2026-10-26)
Documents
1. Folders per customer AND per order AND the accountant inbox, on one data model (`customer_files`).
2. Rep adds documents; sales directors and the CEO can add too (everyone except the warehouse manager). Admin and CEO delete.
3. Rotate button on the preview (and in the viewer); photos are stored upright.
4. AI check comes after the foundation; a **settings switch to turn it on/off, OFF by default**.
5. Keep documents forever (until an automatic archiving system exists).
Electronic signature
1. The delivery-acceptance act is the signed paper. 2. The rep's phone is handed to the customer now (KAD OS later).
3. No receiver name / position field. 4. The rep's own signature is applied silently (no extra click): doing the process = agreeing.
5. Legal check: the owner will do it. 6. One customer signature for all delivered orders of the visit; one PDF per order.
7. No automatic sending; let the rep share it (native share sheet: WhatsApp / Telegram in one tap). 8. Signing works offline; the PDF is made when online.
9. After the customer signed, the order is locked; only admin and CEO may change it. 10. Drivers use the same flow.
