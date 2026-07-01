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
- **Storage:** `services/db.js` — JSON file at `data/leads.json` locally;
  Upstash Redis (`@upstash/redis`) on Vercel when credentials are present.
  *Note: the live deployment currently uses only the JSON-file backend
  (ephemeral on Vercel). See [Deployment](#3-deployment-vercel) for context.*
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

## 3. Deployment (Vercel)

### What is currently live

The deployed build corresponds to git commit `0091c0f` — **"first draft of the app"**.
It is the only committed revision; all local changes described below are
**uncommitted and not yet deployed**.

**Live characteristics:**

| Area | Deployed behaviour |
|---|---|
| Storage | `services/db.js` writes to `/tmp/leads.json`. Vercel's `/tmp` is ephemeral — wiped on every cold start and **not shared** across concurrent function instances. |
| Data persistence | **None.** Leads are lost on every page refresh that hits a cold start. This is the known bug that prompted the work documented below. |
| Socket.io | Runs inside a single `@vercel/node` serverless function. WebSocket upgrades work for the lifetime of a single invocation; the client-side REST fallback in `dashboard.js` re-hydrates the feed on reconnect. |
| HubSpot sync | Works correctly — async background sync fires after the form POST returns. |
| Auth | None. The dashboard (`/dashboard.html`) and all `/api/*` routes are publicly accessible. |

---

### What was built to fix it (ready to deploy)

During this session the following files were changed to add a persistent
Upstash Redis backend. **The code is complete and sitting in the working
tree — it just needs to be committed and deployed.**

| File | Change |
|---|---|
| `services/db.js` | Converted all exports to `async`. Added a Redis backend (via `@upstash/redis`) that activates when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are present; falls back to the JSON file locally. Dropped the ephemeral `/tmp` path entirely. |
| `routes/leads.js` | Added `await` to all `db.*` calls throughout the route handlers and `syncLeadAsync`. |
| `server.js` | Added `await` to `db.getLeads()` and `db.getAnalytics()` inside the Socket.io `connection` handler. |
| `package.json` | Added `@upstash/redis ^1.38.0`. |

**To deploy the fix:**

1. In the [Vercel dashboard](https://vercel.com/dashboard), go to your
   project → **Storage → Connect Store → Browse Marketplace** and add the
   **Upstash Redis** integration (free Hobby tier is sufficient). Vercel
   injects `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
   automatically.
2. Pull the env vars locally:
   ```bash
   vercel env pull .env
   ```
3. Commit and deploy:
   ```bash
   git add .
   git commit -m "feat: persistent Upstash Redis storage + async db layer"
   vercel deploy --prod
   ```

> **Legacy Vercel KV:** if the project previously used Vercel's
> now-deprecated KV product, its `KV_REST_API_URL` / `KV_REST_API_TOKEN`
> variables are accepted as a fallback — no changes needed.

---

### What could have been done better with more time

These are improvements that were identified but not built due to time constraints.
No code changes are needed to understand the limitations; they are documented here
for whoever picks this up next.

| Area | Current state | Recommended improvement |
|---|---|---|
| **Persistent storage** | Single Redis key holding a full JSON array; re-written on every lead insert or status update | Use individual Redis hash fields per lead (`HSET leads:<id> …`) or migrate to a relational store (Neon Postgres, PlanetScale) for indexed queries and atomic updates |
| **Concurrency** | No locking — two simultaneous POSTs can read the same array, both append, and the second write silently drops the first | Upstash Redis `WATCH`/multi-exec, or row-level locking in a relational DB |
| **Socket.io on serverless** | Works per-invocation but a cold-started function has no memory of previous subscribers | Replace with a managed pub/sub channel ([Pusher](https://pusher.com/), [Ably](https://ably.com/), or Socket.io + Upstash Redis adapter) so broadcasts reach all open tabs regardless of which function instance handles the write |
| **Authentication** | None | Put the dashboard and `/api/*` routes behind your existing SSO or at minimum HTTP Basic Auth via a Vercel middleware edge function |
| **Rate limiting** | None on the form endpoint | Add an edge middleware rate-limiter (Vercel's built-in `@vercel/edge` or Upstash `@upstash/ratelimit`) keyed on IP to prevent lead-spam |
| **HubSpot retry durability** | Failed syncs are retried manually via the dashboard button; a process restart drops in-flight retries | Queue failed sync jobs in Redis (e.g. with Upstash QStash) so retries survive cold starts |
| **Pagination** | `GET /api/leads` returns the full array | Add `?page=` / `?limit=` params and return a cursor so the dashboard doesn't load unbounded data as the list grows |
| **Error observability** | `syncError` message is stored in the lead record and shown as a tooltip | Route errors to a structured logger (Axiom, Logtail) and set up an alert for sustained `hubspotStatus: "failed"` rates |

## 4. What happens on submission

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
services/db.js            Dual-backend store: JSON file (local) / Upstash Redis (deployed)
services/hubspotService.js  HubSpot Contact/Deal upsert + connection check
public/index.html          Client-facing form
public/dashboard.html      Internal ops dashboard
public/css, public/js      Styles and client-side logic for both pages
data/leads.json             Local lead store (created on first run; not used on Vercel)
```

## Notes & known limitations

- **Leads disappear on Vercel refresh** — the live deployment stores data in
  `/tmp`, which is ephemeral. This is the primary known bug. The fix
  (Upstash Redis + async db layer) is built locally but not deployed;
  see [Deployment](#3-deployment-vercel).
- **No authentication** — the dashboard and all API routes are public.
  Put this behind SSO or a VPN before sharing the URL externally.
- **Storage concurrency** — the JSON-file and single-key Redis backends
  both serialise the full leads array on every write. Fine at low volume;
  not suitable under concurrent load.
- **Budget values are representative** — `Under $10k` → $5 000,
  `$10k–$50k` → $30 000, `Greater than $50k` → $75 000. The pipeline-value
  badge is directional, not an exact figure the lead provided.
