#!/usr/bin/env bash
# Start PostgreSQL and the app inside the OSS Scanner image, in the background.
#
#   .oss-scanner/start.sh          start both (idempotent), wait until /healthz answers
#   .oss-scanner/start.sh --stop   stop both
#
# The server listens on http://127.0.0.1:8000 and logs to /tmp/meerato.log. With no
# SMTP configured every email (sign-in links, codes, watcher invites) is printed
# there, which is how a reproducer signs in.
set -euo pipefail

LOG=/tmp/meerato.log
PIDFILE=/tmp/meerato.pid

if [[ "${1:-}" == "--stop" ]]; then
    if [[ -f "$PIDFILE" ]]; then
        kill "$(cat "$PIDFILE")" 2>/dev/null || true
        rm -f "$PIDFILE"
    fi
    pg_ctlcluster 18 main stop 2>/dev/null || true
    exit 0
fi

pg_ctlcluster 18 main status >/dev/null 2>&1 || pg_ctlcluster 18 main start

if ! curl -fsS http://127.0.0.1:8000/healthz >/dev/null 2>&1; then
    cd /src
    nohup uvicorn app.main:app --host 127.0.0.1 --port 8000 >>"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
fi

for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:8000/healthz >/dev/null 2>&1; then
        echo "meerato is up on http://127.0.0.1:8000 (log in $LOG)"
        exit 0
    fi
    sleep 1
done

echo "meerato did not come up within 30s, last log lines follow" >&2
tail -n 50 "$LOG" >&2
exit 1
