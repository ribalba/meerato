# meerkat

**meerkat** is the open-source project behind **[meerato](https://meerato.com)** — the
hosted service (provided by RebelProject UG, contact@meerato.com).

A little todo tool that enables true collaboration: offline-capable todos with
buckets, nested subtasks, a per-task activity timeline, comments, file
attachments, email watchers, and shareable public links.

- **Backend:** FastAPI + SQLAlchemy, PostgreSQL.
- **Frontend:** [Fomantic UI](https://fomantic-ui.com/) single-page app, responsive
  (works on mobile), installable as a PWA.
- **Offline:** local-first via IndexedDB + a mutation queue that replays to the
  server on reconnect (last-write-wins conflict resolution).
- **Auth:** passwordless — enter your email, get a magic sign-in link.

## Features

| Requirement | Where |
|---|---|
| Todos with sub-todos | `parent_id` on `Todo`; subtasks managed in the task modal |
| Title, description, and N files per task | `Todo.title` / `Todo.text` + `Attachment` (owner_type `todo`) |
| "To be done" (do soon) & "Blocked" states | `TodoStatus` (`open`, `on_list`, `blocked`, `done`) + sidebar views |
| Multiple buckets | `Bucket`; each todo belongs to one bucket |
| Activity stream + comments on one timeline | `Event` (comments are `type=comment`; status changes, edits, etc. are system events) |
| Markdown comments with N files | comment body rendered as Markdown; `Attachment` (owner_type `event`) |
| Watchers (email) + invite email with link | `Watcher`; invite sends a magic link scoped to the task |
| Watchers can comment after signing in | watcher access enforced in `services.get_owned_todo` |
| Passwordless email auth | `/api/auth/login` → magic link → `/api/auth/callback` |
| Offline + sync | `/api/sync/push` & `/api/sync/pull`, IndexedDB mirror, service worker |
| Mobile friendly | responsive CSS, collapsible sidebar, floating add button |
| Public shareable link + share button | `Todo.public_token`, `/t/{token}` page, `/api/public/{token}` API |

## Quick start

The easiest way to run everything (app + PostgreSQL) is Docker Compose:

```bash
docker compose up --build
```

Or run the app directly against your own PostgreSQL:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
# point DATABASE_URL at your Postgres (see .env.example), then:
DATABASE_URL=postgresql+psycopg2://meerato:meerato@localhost:5432/meerato \
  .venv/bin/uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8086 (Docker Compose) or http://localhost:8000 (running
uvicorn directly).

### Development with Docker Compose

For live-reload inside Docker, run with the dev overlay. It bind-mounts the source
and restarts uvicorn on every edit:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

The dev container runs on **port 8087** (http://localhost:8087) so it can sit
alongside a production stack (port 8086) without a clash.

1. Enter your email and submit. **In dev mode the sign-in link is printed to the
   terminal** (no SMTP configured) — copy the `…/api/auth/callback?token=…` URL
   into your browser.
2. Create a bucket, then a task. Set a watcher email when creating a task and the
   watcher gets an invite link (also printed to the console in dev mode).
3. Use the **Share link** button in a task to copy its public URL.

### Configuration

Copy `.env.example` to `.env` to override defaults (base URL, secret key, database,
and SMTP). With `SMTP_HOST` set, login/watcher/update emails are sent for real;
otherwise they print to the console.

## How offline sync works

The browser keeps a full local mirror of your buckets, todos, and timeline in
IndexedDB. Every change is applied locally first, appended to a mutation queue, and
flushed to the server when online:

- **Push** (`POST /api/sync/push`): the queue is replayed; each mutation carries a
  client timestamp and the server resolves conflicts last-write-wins. Each mutation
  is applied in its own savepoint, so one bad mutation never aborts the batch.
- **Pull** (`GET /api/sync/pull?since=…`): returns everything changed since the last
  sync, including soft-deleted rows so deletes propagate across devices.

Creating/editing tasks, buckets, subtasks, and comments all work offline. Actions
that inherently need the network — sending watcher invites and uploading files —
are disabled while offline.

## Project layout

```
app/
  main.py            app wiring, static + SPA + share routes
  config.py          settings (env-overridable)
  database.py        engine/session, init_db
  migrations.py      schema changes applied automatically on startup
  models.py          SQLAlchemy models
  schemas.py         Pydantic request/response models
  security.py        magic-link auth + sessions
  emailer.py         console/SMTP email delivery
  services.py        timeline events, watcher notify, attachments, access checks
  routers/           auth, buckets, todos, files, sync, public
  static/            Fomantic UI SPA, service worker, IndexedDB + sync client
```

## API tour

- `POST /api/auth/login` `{email}` → emails a magic link
- `GET  /api/auth/callback?token=…` → sets session cookie, redirects into the app
- `GET/POST/PATCH/DELETE /api/buckets[/{id}]`
- `GET/POST/PATCH/DELETE /api/todos[/{id}]` (+ `?bucket_id=`, `?status=`)
- `GET /api/todos/{id}/events`, `POST /api/todos/{id}/comments`
- `GET/POST/DELETE /api/todos/{id}/watchers`
- `POST /api/attachments?owner_type=todo|event&owner_id=…` (multipart)
- `GET /api/attachments/{id}[?token=public_token]`
- `POST /api/sync/push`, `GET /api/sync/pull?since=…`
- `GET /api/public/{public_token}` → read-only shared view (no watcher emails leaked)

Token-authenticated (`?token=…`, see the API page in the app) so scripts, cron and
shortcuts can reach an account without a session cookie:

- `GET  /api/create` → the statuses and buckets a create may use
- `POST /api/create` → create a task; the title understands the same shorthand as the
  quick-add box — `#bucket`, `@watcher@example.com`, `!status` and a trailing date phrase
  ("next week", "in 3 days", "on 2026-08-01"). Parsed by `app/quickadd.py` against the
  owner's timezone; send `parse: false` for a literal title.
- `GET  /api/tasks[?bucket_id=…&status=…]` → every task you own as JSON (deleted ones
  left out), each with its `bucket_name` alongside `bucket_id`
- `GET/POST /api/schedule`, `DELETE /api/schedule/{id}` → scheduled status changes on an
  existing task (applied at local midnight by the background scheduler)

Interactive API docs are at `/docs`.
