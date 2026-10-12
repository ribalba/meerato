# meerato threat model

## What this is

This repository holds meerkat, a collaborative todo web app. It is the code behind the
hosted, multi-tenant service meerato at <https://meerato.com>, where many unrelated
people keep their task lists in one shared database. Anyone can create an account by
entering an email address. Self-hosters run the same code with Docker Compose.

- The backend is Python (FastAPI, SQLAlchemy, PostgreSQL) under `app/`.
- The frontend is a plain JavaScript single-page app under `app/static/` with no build
  step. It mirrors the account into IndexedDB and syncs through `POST /api/sync/push`
  and `GET /api/sync/pull`.
- `electron/` is a thin desktop wrapper that loads the hosted site.

## Who the attacker is

Treat every HTTP request as attacker controlled. The attacker is usually one of these:

1. **An anonymous visitor** with no account. They reach `/api/auth/*` (login, code
   verification, magic-link callback), `/unsubscribe/{token}`, `/t/{token}`,
   `/api/public/{token}/*` and the static files.
2. **A signed-in user of the hosted service** who wants another account's data. This
   is the most important attacker. Every route under `/api/` that takes the session
   cookie must confine the caller to their own buckets, tasks, statuses, schedules,
   recurring tasks and attachments, plus the tasks they watch.
3. **A holder of an API token** (`?token=` on `/api/create`, `/api/tasks` and
   `/api/schedule`, implemented in `app/routers/external.py`). The token must confine
   them to its owner's account.
4. **A holder of a task's share link** (`public_token`). The next section says what
   that link is meant to grant.
5. **A task owner attacking their watchers, or the reverse.** Titles, descriptions,
   comments, guest names and file names written by one person are shown in other
   people's browsers, in emails and on server-rendered pages such as the unsubscribe
   page.

Untrusted data that deserves the closest look:

- Text rendered as HTML. Comments and descriptions go through `marked` and the small
  sanitiser in `app/static/js/markdown.js`. Server-rendered HTML lives in
  `app/routers/unsubscribe.py`. Emails are built in `app/emailer.py`.
- Uploaded files in `app/routers/files.py`, `app/routers/public.py` and `store_upload`
  in `app/services.py`. The name, content type and body are all attacker chosen.
- Sync mutations in `app/routers/sync.py`. The client supplies entity ids, parent ids,
  bucket ids and timestamps.
- The quick-add parser in `app/quickadd.py` and the date handling in
  `app/recurrence.py`, `app/timeutil.py` and `app/scheduler.py`.
- Email addresses supplied for login, watchers and access requests.

## Intended behaviour, please do not report

- **The share link is a capability.** Whoever has a task's `public_token` may read
  that task, its subtasks, its timeline and its attachments. They may comment as a
  guest under any name, attach files, and use `request-access` to add their own email
  as a watcher. Do report ways to get any of this without the token, for a different
  task, or beyond these rights.
- **Watchers can edit the task they watch** (`get_owned_todo` in `app/services.py`).
  Do report watchers reaching other tasks or any of the owner's other data.
- The API token travels in the query string. This is documented and accepted.
- `/docs` and `/openapi.json` are public on purpose.
- The secrets and passwords in `.env.example`, `docker-compose.yml` and
  `app/config.py` are development defaults that deployments override.
- Login rate limits are per email address. Volumetric denial of service from many
  addresses or IPs is out of scope.

## Priorities

Most important first:

1. Authentication and sessions in `app/security.py` and `app/routers/auth.py`. That
   covers magic links, the 6-character sign-in codes with their attempt and rate
   limits, session cookies and API tokens.
2. Cross-account authorisation in every router under `app/routers/`. `sync.py` and
   `files.py` deserve the closest look.
3. Stored XSS on the app origin. Script running there can call the API with the
   victim's cookie, which amounts to account takeover.
4. File handling on the server, such as path traversal, overwriting files, or serving
   an upload so that the browser executes it.
5. Email content and headers.
6. Background jobs in `app/scheduler.py` acting on the wrong account's data.

The Electron wrapper (`electron/main.js`) is lower priority and can only be reviewed
statically, because Electron is not installed in the image. Third-party libraries
loaded from the CDN (jQuery, Fomantic UI, marked, SortableJS) and the Umami analytics
script are out of scope, unless meerato uses them in an exploitable way.
`app/static/img/` is out of scope.

## How to exercise the code

PostgreSQL 18 and every Python dependency are installed, and there is no network.

- `.oss-scanner/start.sh` starts the database and the server on
  `http://127.0.0.1:8000` and logs to `/tmp/meerato.log`. `.oss-scanner/start.sh --stop`
  stops both.
- To sign in, send `POST /api/auth/login` with `{"email": "alice@example.com"}`. No
  SMTP server is configured, so the magic link and the sign-in code are printed to
  `/tmp/meerato.log`. Opening the link (a GET) only shows a confirmation page. The
  token is spent by POSTing it as a form field, for example
  `curl -c cookies.txt -d token=... http://127.0.0.1:8000/api/auth/callback`, which
  yields a `todo_session` cookie. `POST /api/auth/verify-code` with the email and the
  code works too. Always use `127.0.0.1`, not `localhost`, because the cookie is bound
  to the host. Create a second account the same way to test cross-account access.
- `pytest` and `httpx` are installed, so a reproducer can also be a Python script that
  uses `fastapi.testclient.TestClient` on `app.main.app` with the same database.
- `node .oss-scanner/render-markdown.js < payload.md` renders Markdown the way the
  frontend does (marked 12.0.2 plus `app/static/js/markdown.js`, under jsdom) and
  prints the HTML that would be inserted into the page. jsdom parses close to a real
  browser but not exactly like one, so say so when a payload depends on parser quirks.
- There is no automated test suite. `ruff check app` is the lint, but the installed
  ruff has a wider default rule set than the project was written for, so compare
  against the unpatched tree rather than expecting zero findings.
- `README.md` has an API tour and `AGENTS.md` describes the code layout.

## Severity

meerato is multi-tenant, so cross-account impact drives the rating.

- **Critical.** Remote code execution, SQL injection, arbitrary file read or write on
  the server, or taking over any account without the victim doing anything (for
  example forging a session, bypassing the sign-in code, or using someone else's
  login token).
- **High.** Reading or changing another account's tasks, comments, attachments,
  watchers or API token. Stored XSS that runs on the app origin in another user's
  session, including through the share page or the unsubscribe page. Account takeover
  that needs a single click from the victim. A guessable `public_token`,
  `unsubscribe_token`, login token or session token.
- **Medium.** CSRF that changes state, open redirects, email header or content
  injection that lets an attacker send convincing mail from the service, bypassing
  the login rate limits, leaking watcher email addresses to share-link holders, or a
  single request that exhausts server memory or disk.
- **Low.** XSS that only fires for the attacker themselves, missing hardening
  headers, and information leaks without security impact.

Please do not rate denial of service above Medium.

## Reports and patches

- Write one report per root cause. If one missing escape causes several sinks, list
  them all in that report.
- Include a reproducer that runs against `.oss-scanner/start.sh`, as a curl sequence
  or a short Python script, and state the expected and the actual result.
- Patches should be minimal unified diffs against `main`. Keep the existing style
  (type annotations, short comments only where the reason is not obvious) and do not
  add new `ruff check app` findings. A change to an existing column also needs a guarded
  migration in `app/migrations.py`, as `AGENTS.md` describes.
