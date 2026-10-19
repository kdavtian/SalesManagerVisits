# KAD AI (Ask KAD) - the admin's AI analyst

Home -> **KAD AI** (admin only). The admin asks a question in Armenian or English ("Who owes us the most?", "Which good
customers stopped ordering?", "How are we against the plan by channel?") and gets a short answer with a recommended action.
Code: `server/src/askKad/` (engine, tools, anonymiser, settings), `server/src/routes/askKad.js`, `client/public/js/views/askKad.js`.

## How it works
1. The question goes to our server. Every known customer and staff **name is replaced by a code** (`CUST-<ERP id>`,
   `REP-<user id>`) in the question and in the earlier turns of the chat.
2. The server sends it to a Claude model (default `claude-opus-5-5`, override with `ASK_KAD_MODEL`) together with five
   **read-only data tools**: `sales` (ERP order lines: AMD, liters, orders), `debt`, `lapsed_customers`, `visits`
   (field-rep activity), `plan_vs_actual`. The model decides which to call; each tool is one SQL query that returns codes
   and numbers only. No phone, TIN, address, note or name ever leaves the server.
3. The model adds the numbers up and writes the answer. The server turns the codes back into real names before the admin
   reads it. The AI cannot change anything in the app.

## Money and limits
- Cost is estimated from the token counts of every call and logged in `ask_kad_log` (who, masked question, which tools,
  tokens, USD). The month's total is shown in the "!" popup on the screen.
- **Settings -> Admin -> App configuration**: KAD AI On/Off, and the monthly spending limit in USD (default 20). When the
  month's cost reaches the limit, new questions are refused until it is raised.
- One question at a time per admin; at most 8 data lookups per question.

## Setup on the droplet (once)
The API key lives only on the server. Add one line to `/opt/field-visits/.env` (nobody else sees it; never paste it in chat or
git): `ANTHROPIC_API_KEY=...`, then run the normal deploy (`./deploy/deploy.sh --fast` is enough: no new tables after migration 130).
Without the key the screen says the AI is not connected; the rest of the app is unaffected.

## Known limits (v1)
- Armenian names are inflected ("Արամին"); a name typed with a different ending may not be masked in the question. The data
  tools never carry names, so the only text that can still contain a name is the admin's own typing. The screen shows
  "Names hidden from the AI: N" behind the "!" of every answer.
- Answers are not streamed yet (a "Thinking..." bubble shows while the model works, usually 5-20 seconds).
- Sales are the ERP invoiced truth; orders made in the app but not yet in the ERP are not counted.
- Next candidates: "create a task from this answer" in one tap, Vaghinak phrasing, check-in comment analysis, a daily CEO briefing.
