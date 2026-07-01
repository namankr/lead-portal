# Lead Distribution Portal

A lightweight lead intake system: a client-facing form, a real-time internal
ops dashboard, and a Node/Express backend that syncs every lead into a
HubSpot CRM sandbox.

```
[Web Form]  --POST /api/leads-->  [Backend Server]
                                        |   \
                                        |    \__(Socket.io, real-time)__> [Dashboard]
                                        |
                                (Private App token)
                                        |
                                        v
                                [HubSpot CRM API]
```

The backend acknowledges the form submission immediately after saving the
lead locally, pushes it onto the dashboard over a websocket, and syncs it
to HubSpot in the background so the client never waits on an external API
call. The dashboard reflects the sync outcome (`syncing` -> `synced` /
`failed`) the moment it happens.

## Stack

- **Server:** Node.js, Express, Socket.io
- **Storage:** a small JSON-file store (`services/db.js`) — deliberately
  dependency-free so the project runs anywhere with just `npm install`,
  no native build toolchain or database server required. Swap in
  Postgres/MySQL there for production use.
- **CRM integration:** `@hubspot/api-client`, HubSpot's official Node SDK
- **Frontend:** plain HTML/CSS/JS, no build step

## 1. Install & run

```bash
npm install
cp .env.example .env   # then fill in HUBSPOT_ACCESS_TOKEN, see below
npm start
```

- Public form: `http://localhost:3000/`
- Ops dashboard: `http://localhost:3000/dashboard.html`

The server runs (and the form/dashboard work) even without a HubSpot
token — leads just sit in `hubspotStatus: "failed"` with a clear reason,
and the router control panel shows "connection unavailable." This means
you can develop and demo the local half independently of HubSpot access.

## 2. HubSpot sandbox setup

This integration authenticates with a **Private App access token** rather
than a full OAuth flow. For a single sandbox portal with one internal
integration, that's the model HubSpot itself recommends: a static bearer
token scoped to exactly the permissions needed, no redirect/consent
screen, no refresh-token handling. If you later need this to connect to
*multiple* HubSpot portals (e.g. distributing this as an app other
customers install), swap `services/hubspotService.js` for an OAuth
2.0 authorization-code flow — the CRM calls themselves don't change,
only how `ACCESS_TOKEN` is obtained.

**Steps, once you have sandbox access:**

1. In the sandbox portal: **Settings -> Integrations -> Private Apps ->
   Create a private app**.
2. Under **Scopes**, grant:
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
   - `crm.objects.deals.read`
   - `crm.objects.deals.write`
3. Copy the generated access token into `.env` as `HUBSPOT_ACCESS_TOKEN`.
4. (Optional, recommended) Create a custom Contact property named
   `estimated_annual_budget` (Settings -> Properties -> Contact properties
   -> Create property, type "Single-line text" or "Dropdown select" with
   the same three options as the form) so the budget bracket is visible
   directly on the Contact record. If you skip this, the sync still
   works — it just retries without that field and stores the budget only
   as the associated Deal's `amount`.
5. Restart the server. The dashboard's router control panel will flip to
   "Connected to HubSpot CRM" once it can reach the API.

## 3. What happens on submission

1. **Validate** — server-side checks mirror the client-side ones (all
   fields required, email format, budget must be one of the three listed
   ranges). Invalid submissions get a `400` with field-level messages and
   never reach the local store or HubSpot.
2. **Store locally** — the lead is written to `data/leads.json` with
   `localStatus: "stored"` and `hubspotStatus: "pending"`.
3. **Broadcast** — a `lead:new` Socket.io event pushes the record to every
   open dashboard tab instantly.
4. **Sync to HubSpot** (async, doesn't block the form's response):
   - Search Contacts by email; update if found, otherwise create — so
     re-submissions from the same person don't create duplicate Contacts.
   - Create a Deal named `"<Company> - <First> <Last>"`, with `amount`
     mapped from the budget bracket (`Under $10k` → 5000, `$10k-$50k` →
     30000, `Greater than $50k` → 75000 — representative midpoint/floor
     values used purely for the pipeline-value badge), associated to the
     Contact.
   - On success: `hubspotStatus: "synced"`, both HubSpot record IDs are
     stored and shown in the feed.
   - On failure: `hubspotStatus: "failed"` with the HubSpot error message
     retained (surfaced as a tooltip on the status chip), and a **Retry**
     button appears in the dashboard row (`POST /api/leads/:id/resync`).
5. A second Socket.io event (`lead:updated`) reflects the final sync
   outcome live, and the analytics badges update in the same tick.

## API reference

| Method | Path                        | Purpose                                  |
|--------|-----------------------------|-------------------------------------------|
| POST   | `/api/leads`                | Submit a new lead                        |
| GET    | `/api/leads`                | List all leads (dashboard initial load)  |
| GET    | `/api/analytics`            | Total leads / pipeline value / sync tallies |
| GET    | `/api/hubspot/status`       | Live HubSpot connectivity check          |
| POST   | `/api/leads/:id/resync`     | Manually retry a failed HubSpot sync     |

## Project layout

```
server.js                 Express + Socket.io entrypoint
routes/leads.js           Ingestion, validation, sync orchestration
services/db.js            JSON-file local store + budget-value mapping
services/hubspotService.js  HubSpot Contact/Deal upsert + connection check
public/index.html          Client-facing form
public/dashboard.html      Internal ops dashboard
public/css, public/js      Styles and client-side logic for both pages
data/leads.json             Local lead store (created on first run)
```

## Notes & things to harden before production

- The JSON-file store has no concurrency control beyond Node's
  single-threaded event loop — fine for a demo/internal tool at low
  volume, not a substitute for a real database under real load.
- No auth on the dashboard or API routes. Put this behind your existing
  SSO/VPN before exposing it beyond localhost.
- The budget-to-dollar-value mapping is a simple representative estimate
  per bracket, not a real amount the client provided — treat the
  "Estimated pipeline value" badge as directional.
