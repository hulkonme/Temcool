# Temcool

A real, working disposable email website. Open the page, get a live address, and watch mail land — no sign-up, no build step. Optionally backed by PostgreSQL so inboxes survive restarts and multiple instances.

![stack](https://img.shields.io/badge/Node.js-18%2B-5eead4) ![db](https://img.shields.io/badge/PostgreSQL-13%2B-818cf8)

## What it does

- Generates a live temporary address the second the page loads
- Receives real email through the [mail.tm](https://mail.tm) network
- Auto-refreshes the inbox every 8 seconds, with new-mail notifications
- Lets visitors pick a custom name and domain
- Renders HTML mail in a locked-down sandboxed iframe, with remote images blocked by default
- Downloads attachments, deletes messages, deletes the whole inbox
- 60-minute inbox timer with one-click extend
- QR code for the address, so you can open it on another device
- Dark / light theme, responsive layout, keyboard shortcuts

## Quick start

Requires Node.js 18 or newer.

```bash
cd temcool
npm install
npm start
```

Open <http://localhost:3000>. Without a database the server keeps sessions in memory, which is fine for trying it out.

## PostgreSQL

Temcool persists sessions, the sliding-window rate limit and an inbox event log in PostgreSQL. The schema is applied automatically on startup, so there is no migration step.

1. Create a database:

   ```bash
   createdb temcool
   ```

2. Point the app at it:

   ```bash
   cp .env.example .env      # Windows: copy .env.example .env
   # edit DATABASE_URL if your host, port or credentials differ
   ```

3. Start the server:

   ```bash
   npm start
   ```

   ```
   [temcool] PostgreSQL connected — sessions are persistent.
   [temcool] running at http://localhost:3000 (storage: postgres)
   ```

`DATABASE_URL` uses the standard libpq format:

```
postgres://user:password@localhost:5432/temcool
```

Use the `.env` file locally, or set `DATABASE_URL` in your host's environment. If the variable is set but the database cannot be reached, startup fails with a clear error after a short retry loop. Set `ALLOW_MEMORY_FALLBACK=1` to boot on the in-memory store anyway.

### What is stored

| Table | Purpose |
| --- | --- |
| `sessions` | One row per browser inbox: mail.tm account id, address, generated password, cached access token, expiries, last IP/user agent |
| `inbox_events` | Append-only log of `created`, `extended` and `deleted` events; powers the public counter |
| `rate_limits` | Timestamped creation attempts per IP, shared across instances |

Timestamps the app compares are epoch milliseconds (`BIGINT`); the audit column uses `TIMESTAMPTZ`. Rows are pruned every five minutes: expired sessions, rate-limit hits older than two hours, and events older than 90 days.

Because the session is in the database, the `tc_sid` cookie keeps pointing at the same mailbox after a restart, and any instance behind a load balancer can serve the next request. No sticky sessions needed.

The generated mail.tm password and access token are stored in plaintext because the server needs them to re-authenticate with the mail provider. They belong to throwaway mailboxes only — still, restrict database access like any other secret store.

### Schema

`db/schema.sql` is idempotent (`CREATE TABLE IF NOT EXISTS`) and runs at boot. To apply it manually:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

## How it works

```
browser  ──HTTP──▶  Node server  ──HTTPS──▶  api.mail.tm
   │                    │
   └── static files     └── PostgreSQL (sessions, rate limits, events)
                            or in-memory maps when DATABASE_URL is unset
```

- The browser never talks to mail.tm directly. mail.tm does not send CORS headers, so the Node server proxies `/api/*`.
- On the first visit the server creates a mail.tm account, stores the address + password, and puts an HttpOnly `tc_sid` cookie in the browser.
- All mail endpoints (`/api/messages`, attachments, delete) are authenticated server-side with a short-lived token that is refreshed automatically and cached in the session row.
- Sessions live for six hours; the visible inbox timer is 60 minutes and can be extended.

### API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/inbox` | Current address + expiry + available domains |
| `POST` | `/api/inbox` | Create an inbox (`{ "local": "name", "domain": "..." }`, both optional) |
| `POST` | `/api/inbox/extend` | Reset the 60-minute inbox timer |
| `DELETE` | `/api/inbox` | Delete the account and the session |
| `GET` | `/api/messages` | Inbox list |
| `GET` | `/api/messages/:id` | Full message (`text`, `html`, attachments) |
| `DELETE` | `/api/messages/:id` | Delete one message |
| `GET` | `/api/messages/:id/attachments/:attachmentId` | Download an attachment |
| `GET` | `/api/domains` | Domains currently offered by the provider |
| `GET` | `/api/stats` | Created / active inbox counts (`enabled: false` in memory mode) |
| `GET` | `/healthz` | Health check; includes storage mode and checks the database |

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_URL` | *(unset)* | PostgreSQL connection string; unset runs in memory |
| `PGSSL` | from URL | `1` = TLS without certificate verification (most hosted DBs), `strict` = verify, `0` = disable |
| `PG_POOL_MAX` | `10` | Maximum pooled connections |
| `PG_CONNECT_TIMEOUT_MS` | `8000` | Per-connection timeout; startup retries for about 15 seconds |
| `ALLOW_MEMORY_FALLBACK` | `0` | `1` keeps the app running when the database is down |
| `MAIL_API_BASE` | `https://api.mail.tm` | Compatible mail.tm instance |
| `COOKIE_SECURE` | auto | Set to `1` to force `Secure` cookies behind a TLS proxy |

The session cookie is marked `Secure` automatically when the request arrives with `x-forwarded-proto: https`.

## Deploying

Any host that runs Node and PostgreSQL works: Render, Railway, Fly.io, a VPS, Docker, etc. `render.yaml` provisions both the web service and a database and wires `DATABASE_URL` automatically.

1. Push this folder to a repository.
2. Create a Postgres database and set `DATABASE_URL` (the blueprint does this for you on Render).
3. Build command: `npm ci` — start command: `node server.js`.
4. Put it behind HTTPS so the inbox cookie is sent as `Secure`.

The app reads `.env` if present, but real deployments should set environment variables directly.

## Notes and limits

- Receive-only: Temcool cannot send email.
- The upstream service is rate-limited (roughly 8 requests per second per IP). The frontend polls every 8 seconds per open tab, and the server caches the domain list for 30 minutes.
- Inbox creation is capped at 100 per IP per hour. With PostgreSQL the limit is shared by all instances.
- Don't use a disposable inbox for banking, government services, or anything you need to keep. Anyone with the address can potentially read the inbox.
- Mail content is untrusted: HTML is sanitized, scripts are stripped, the iframe has no `allow-scripts` or `allow-same-origin`, and remote images are replaced with a transparent pixel until the visitor opts in.

## Project layout

```
temcool/
├── server.js          # static server + mail.tm proxy + API routes
├── lib/db.js          # PostgreSQL store (with in-memory fallback)
├── db/schema.sql      # idempotent schema, applied on startup
├── package.json
├── .env.example
└── public/
    ├── index.html     # marketing page + app shell
    ├── styles.css     # theme, layout, components
    ├── app.js         # inbox logic, polling, reader, QR, shortcuts
    └── favicon.svg
```

## License

MIT. Not affiliated with mail.tm.
