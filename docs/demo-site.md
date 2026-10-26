# Demo site

A second, **completely separate** copy of the app with made-up data. Give a visitor a login with CEO permissions and they can try everything without ever touching the company's real database.

## What is separate (nothing is shared with the real system)
| | Real app | Demo |
|---|---|---|
| Database | `db` container, real data | its own `demo` Postgres container, own volume, own random password |
| Containers / network | project `field-visits` | project `fvdemo` (`docker-compose.demo.yml`) |
| Secrets | `.env` | `.env.demo` (made by `deploy/demo.sh`, never the real `.env`) |
| Address | the real domain | its own (sub)domain, e.g. `demo.yourcompany.com` -> `127.0.0.1:3100` |
| Excel sync, Telegram, web push, AI key, Platform sync, KAD OS link | on | **all off**: none of those settings are passed to the demo, so nothing can go out |
| Data | real | made up (customers, prices, orders, debt, people) |

The demo looks different where nobody can miss it: it installs / appears as **"KAD Demo"** with a purple status bar, and it asks search engines not to index it. `demo-site.mjs` refuses to run unless `DEMO_MODE=1` (set only in the demo compose file), and `seed` refuses any database that holds a user whose e-mail does not end in `@kad.demo`.

## What the demo contains
`seed` fills an empty demo database with: a CEO (`ceo@kad.demo`), three sales reps (Aram, Artak, Lilit: channels SM YVN, SM Davtashen, SM Shirak, each with its own map colour), 16 products with made-up prices and costs, about 60 customers around Yerevan and Gyumri (gold / silver / bronze, potential customers with levels and reasons, competitors, every category, visited today / overdue / never visited), 100+ check-ins, about 90 orders in all statuses (some waiting for confirmation), payments (a few waiting for approval), tasks, debt with real aging invoices, and four months of sales and plan per channel. Everything is deterministic: the demo looks the same every time.

## One-time setup (on the server, from the repo checkout)
1. **The address.** The demo needs HTTPS so phones can install it. The real app already lives on an `sslip.io` address (`fieldvisits.164.92.171.41.sslip.io`: the service turns any name in front of the server's IP into that IP, so there is **nothing to set up at a DNS provider**). The demo uses the same kind: **`kadostest.164.92.171.41.sslip.io`** (owner, 2026-10-26: no DuckDNS). If the owner later gets a domain of their own: add one A record (host `demo`, value = the server's IP) and use that name in step 3 instead.
2. **Start the demo:**
   ```bash
   cd /opt/field-visits
   git pull
   ./deploy/demo.sh up
   ```
   The first run builds the image (a few minutes), makes `.env.demo` with random secrets, migrates and fills the demo, and prints the CEO password **once**.
3. **Web address + HTTPS certificate:**
   ```bash
   sudo ./deploy/demo.sh domain kadostest.164.92.171.41.sslip.io
   ```
   It writes the nginx file (`deploy/nginx-demo.conf` is the template), asks Let's Encrypt for a free certificate and reloads nginx. The real app's nginx file is not touched.

Memory: the demo adds one Postgres and one Node container (roughly 300-400 MB). Check `free -m` before you start it on the same droplet; a separate small droplet works exactly the same (copy the repo there and run the same commands), and is the strictest isolation.

## Day to day
```bash
./deploy/demo.sh user gevorg            # a CEO login for a visitor: gevorg@kad.demo, random password printed once
./deploy/demo.sh user anna accountant   # another role if you want the visitor to see a different view
./deploy/demo.sh users                  # who has a login, who signed in
./deploy/demo.sh remove-user gevorg     # take it away
./deploy/demo.sh update                 # new version of the app (keeps the data and the logins)
./deploy/demo.sh reset                  # wipe everything the visitors did and start from fresh demo data (all visitor logins are removed)
./deploy/demo.sh status
```
The visitor opens the demo address and signs in with `gevorg@kad.demo` and the password you give them. Roles you can pass: `ceo` (default), `admin`, `operations_director`, `sales_director`, `sales_manager`, `warehouse_manager`, `delivery_manager`, `accountant`.

No automatic reset (owner, 2026-10-26): run `./deploy/demo.sh reset` yourself when you want a clean demo (it also removes every visitor login).

## Notes
- A visitor with CEO permissions can change anything **inside the demo** (settings, users, orders, prices). That is the point; `reset` undoes it. Nothing they do can reach the real app.
- The login rate limiter still applies (10 sign-ins per 15 minutes per IP address); a group testing from one office network may hit it. Wait, or restart the demo app container.
- Maps still load OpenStreetMap tiles from the internet (the only outside traffic, the same as the real app).
- To remove everything: `./deploy/demo.sh destroy` (and delete the nginx file and the DNS record).
