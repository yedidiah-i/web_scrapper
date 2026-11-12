# Scrappy Gateway

A focused workspace and metered API for Scrappy web extraction.

The app is a Next.js 16 (App Router) front end over a SQLite ledger. It talks
to two backing services:

- **Rust core worker** — queues and runs extraction jobs.
- **Python processor** — turns the fetched pages into structured payloads.

---

## Pages

| Route      | Access        | What it is                                             |
| ---------- | ------------- | ------------------------------------------------------ |
| `/`        | public        | Landing page: hero, features, pricing, signup entry     |
| `/signup`  | public        | Create an account (Hobby plan)                          |
| `/login`   | public        | Sign in                                                 |
| `/dashboard`| session       | Playground, API keys, usage analytics                   |
| `/account` | session       | Name, password, active sessions                        |
| `/admin`   | admin role    | Account management: plans, roles, password resets      |
| `/api/health` | public     | Ledger and service health                               |

`/dashboard`, `/account` and `/admin` are protected by `proxy.ts`. A visitor
without a session cookie is redirected to `/login` before any page renders,
and every route handler re-checks the session server-side.

---

## Getting started

```bash
npm install
npm run seed      # provisions the admin account
npm run dev       # http://localhost:3000
```

### The admin account

`npm run seed` provisions local administrator metadata for
**futureksmeyedidiah@gmail.com** on the Enterprise plan and issues an API key.
It does not create a Supabase Auth user or set a password. Sign up in Scrappy
with that verified email and choose a private, unique password; the verified
identity is linked to the administrator record automatically.

The seed script uses a random local-only password hash, never prints a login
password, and only shows the newly issued API key once. Re-running the seed
keeps existing account credentials and issues a fresh API key.

To also seed a non-admin demo account:

```bash
SEED_DEMO=1 npm run seed
```

---

## Environment

Supabase Auth is supplied by the connected project integration. The remaining service settings have development defaults.

| Variable                | Default                                   | Purpose                          |
| ----------------------- | ----------------------------------------- | -------------------------------- |
| `ENGINE_URL`            | `http://127.0.0.1:58080`                  | Rust core worker                 |
| `PROCESSOR_URL`         | `http://127.0.0.1:58082`                  | Python data processor            |
| `GATEWAY_DB_PATH`       | `./data/gateway.db`                       | SQLite ledger                    |
| `SESSION_SECRET`        | `local-dev-secret-change-me-in-production`| Session signing secret           |
| `SESSION_TTL_MS`        | `604800000` (7 days)                      | Session lifetime                 |
| `MAX_URLS_PER_REQUEST`  | `100`                                     | URL cap per extraction request   |
| `JOB_TIMEOUT_MS`        | `60000`                                   | Engine + processor wait limit    |
| `CREDITS_PER_URL`       | `1`                                       | Credits charged per good URL     |
| `ADMIN_EMAIL`           | `futureksmeyedidiah@gmail.com`            | Seed: administrator email        |
| `ADMIN_NAME`            | `Scrappy Admin`                           | Seed: administrator display name |
| `NEXT_PUBLIC_SUPABASE_URL` | provided by Supabase integration         | Auth endpoint                     |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | provided by Supabase integration    | Public auth key                   |
| `SUPABASE_SERVICE_ROLE_KEY` | provided by Supabase integration        | Server-only admin password reset |
| `ADMIN_TIER`            | `enterprise`                              | Seed: admin plan                 |
| `SEED_DEMO`             | *(off)*                                   | Seed: also create a demo account |

Supabase Auth supplies sign-in, verified email confirmation, and credential storage. The connected integration provides `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`; keep the service-role key server-only. In production, set a unique `SESSION_SECRET` or the app derives its session-signing secret from the service-role key.

---

## API

### Extraction

```bash
curl -X POST http://localhost:3000/api/v1/extract \
  -H "Authorization: Bearer sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com"],"target":"tables"}'
```

Targets: `auto`, `text`, `tables`, `images`, `links`, `metadata`, `prices`.

Requests are metered: credits, rate limit and concurrency come from the
account's plan. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`
and `X-Credits-Remaining`.

### Dashboard API

| Endpoint                    | Method   | Purpose                          |
| --------------------------- | -------- | -------------------------------- |
| `/api/auth/register`        | `POST`   | Create an account                |
| `/api/auth/login`           | `POST`   | Start a session                  |
| `/api/auth/logout`          | `POST`   | End the session                  |
| `/api/auth/session`         | `GET`    | The signed-in account            |
| `/api/account/profile`      | `PATCH`  | Change name or password          |
| `/api/account/sessions`     | `GET`    | List sessions                    |
| `/api/account/sessions`     | `DELETE` | Sign out other devices           |
| `/api/keys`                 | `GET`    | List API keys (masked)           |
| `/api/keys`                 | `POST`   | Create an API key                |
| `/api/keys/{id}`            | `POST`   | Rotate a key                     |
| `/api/keys/{id}`            | `DELETE` | Revoke a key                     |
| `/api/playground`           | `POST`   | Run an extraction from the panel |
| `/api/stats`                | `GET`    | Usage, credits, service health   |
| `/api/admin/users`          | `GET`    | List all accounts (admin)        |
| `/api/admin/users/{id}`     | `PATCH`  | Plan, role, password, keys       |
| `/api/health`               | `GET`    | Ledger and service health        |

---

## Plans

| Plan         | Credits/month | Req/min | Concurrent |
| ------------ | ------------- | ------- | ---------- |
| Hobby        | 5,000         | 30      | 2          |
| Professional | 25,000        | 120     | 8          |
| Enterprise   | 150,000       | 600     | 32         |

Signup starts on Hobby. Admins can move an account between plans from
`/admin`; the limits are mirrored onto the user row so a plan change applies
without a deploy.

---

## Layout

```
app/
  page.tsx                  landing page
  signup/ login/            auth pages
  dashboard/ account/ admin/ authenticated pages
  api/                      route handlers
  components/               playground, key manager, charts
db/schema.sql               ledger schema (shared with the seed script)
lib/
  auth.ts                   password hashing, API keys, sessions
  users.ts                  account CRUD, validation
  db.ts                     connection + migrations
  engine.ts extract.ts      Rust core and Python processor clients
  pricing.ts ratelimit.ts   tiers, credits, limits
  session.ts                request auth helpers
proxy.ts                    route protection
scripts/seed.mjs            provisions the admin account
```

## Scripts

```bash
npm run dev        # dev server
npm run build      # production build
npm run start      # serve the build
npm run seed       # provision the admin account
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run verify     # end-to-end checks against a running dev server
```

The ledger is created on first run and migrated in place, so upgrading does
not require dropping the database.

## Testing

Two suites cover the parts that are easy to break silently:

```bash
# Gateway: pages, route protection, signup, admin, account, health.
# Needs the dev server running.
cd gateway-dashboard && npm run verify

# Processor: extraction targets, price parsing, mixed attribute shapes.
cd data-processor && .\venv\Scripts\python.exe test_extractor.py
```

Both are safe to run repeatedly; the gateway suite creates and removes its own
throwaway accounts.
