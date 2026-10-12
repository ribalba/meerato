# Build image for Anthropic's OSS Scanner (https://red.anthropic.com/oss-scanner/).
#
# The scanner builds this with network access, then audits the finished image with
# no network at all. Everything the app needs at runtime is therefore installed
# here, including a local PostgreSQL so findings can be reproduced against a live
# server (see .oss-scanner/start.sh and .oss-scanner/threat_model.md).
#
# Build it locally from the repository root with
#   docker build -f .oss-scanner/Dockerfile -t meerato-oss-scanner .

# Debian based like the production image, so the scanner's own tool layer (apt)
# works unchanged.
FROM python:3.13-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# PostgreSQL 18 from the PGDG repository to match docker-compose.yml. Node.js is
# only there to exercise app/static/js/markdown.js offline (see below).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git procps postgresql-common nodejs npm \
    && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
    && apt-get install -y --no-install-recommends postgresql-18 \
    && rm -rf /var/lib/apt/lists/*

COPY . /src
WORKDIR /src

RUN pip install -r requirements.txt \
    && pip install pytest httpx ruff

# The browser loads marked from a CDN, which is unreachable during the scan. Fetch
# the same version (see app/static/index.html) plus jsdom so the Markdown sanitiser
# can be run under Node without a browser.
RUN npm install --prefix /opt/meerato-js --no-audit --no-fund marked@12.0.2 jsdom@24.1.3

# Database and settings the app expects. SMTP stays unset, so sign-in links and
# codes are printed to the server log instead of being mailed.
ENV DATABASE_URL=postgresql+psycopg2://meerato:meerato@127.0.0.1:5432/meerato \
    BASE_URL=http://127.0.0.1:8000 \
    SECRET_KEY=oss-scanner-local-only \
    UPLOAD_DIR=/tmp/meerato-uploads

RUN pg_ctlcluster 18 main start \
    && runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
        -c "CREATE ROLE meerato LOGIN PASSWORD 'meerato'" \
        -c "CREATE DATABASE meerato OWNER meerato" \
    && pg_ctlcluster 18 main stop

# Smoke test. The repository has no test suite, so boot the app once (which also
# creates the schema). A failure only warns, matching the scanner's template.
RUN bash .oss-scanner/start.sh && bash .oss-scanner/start.sh --stop \
    || echo "WARNING: the app did not come up, see /tmp/meerato.log"
