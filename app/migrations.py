"""Incremental schema migrations, applied automatically on startup.

``Base.metadata.create_all`` (see :func:`database.init_db`) only ever *creates
missing tables*. It never touches a table that already exists, so a changed
column type reaches a fresh deploy and silently skips every existing one. That
gap is what this module closes: a short, ordered list of migrations, each run
once per database and recorded in ``schema_migrations``.

Migrations are also written to be idempotent on their own — they inspect the
live schema and no-op if it already matches. The bookkeeping table saves the
work on later boots; the guards mean a database whose schema was fixed by hand
(or created fresh by ``create_all``) still ends up in the right state.

Adding one: write a ``_verb_noun(conn) -> bool`` function that returns whether
it changed anything, then append it to :data:`MIGRATIONS` with the next id.
Never edit or reorder an id that has shipped.
"""

import logging
from collections.abc import Callable

from sqlalchemy import Connection, Engine, text

logger = logging.getLogger("uvicorn.error")

# Arbitrary but fixed: every process that migrates this database takes the same
# advisory lock, so replicas (or a reloader's workers) booting together apply the
# list one at a time instead of racing on the same ALTER.
_LOCK_KEY = 8_314_207_001


def _column_type(conn: Connection, table: str, column: str) -> str | None:
    """The live ``data_type`` of a column, or None if the table/column is absent."""
    return conn.execute(
        text(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_name = :table AND column_name = :column"
        ),
        {"table": table, "column": column},
    ).scalar()


def _todo_title_to_text(conn: Connection) -> bool:
    """Widen ``todos.title`` from ``varchar(500)`` to unbounded ``text``.

    A long title (e.g. a multi-line paste joined into one task) was accepted by
    the client and queued, then rejected forever by the column limit — the
    mutation stuck in the offline queue with no way to drain it. Postgres treats
    ``varchar(n) -> text`` as metadata-only, so this does not rewrite the table.
    """
    if _column_type(conn, "todos", "title") != "character varying":
        return False
    conn.execute(text("ALTER TABLE todos ALTER COLUMN title TYPE text"))
    return True


MIGRATIONS: list[tuple[str, Callable[[Connection], bool]]] = [
    ("0001_todo_title_to_text", _todo_title_to_text),
]


def run_migrations(engine: Engine) -> None:
    """Apply every migration this database has not seen yet.

    All of them run in one transaction: Postgres DDL is transactional, so a
    failure half-way leaves the schema exactly as it was rather than partly
    migrated. A failure here propagates and aborts startup — booting the app
    against a schema it cannot use would only fail later, less legibly.
    """
    if engine.dialect.name != "postgresql":
        # The migrations are Postgres DDL, and the SQLite path is a dev-only
        # convenience that always starts from a fresh create_all().
        return

    with engine.begin() as conn:
        # Lock first, before reading or creating anything: two processes running
        # `CREATE TABLE IF NOT EXISTS` concurrently can collide. Released on commit.
        conn.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _LOCK_KEY})
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "  id text PRIMARY KEY,"
                "  applied_at timestamptz NOT NULL DEFAULT now()"
                ")"
            )
        )
        applied = {row[0] for row in conn.execute(text("SELECT id FROM schema_migrations"))}

        for migration_id, migrate in MIGRATIONS:
            if migration_id in applied:
                continue
            changed = migrate(conn)
            conn.execute(
                text("INSERT INTO schema_migrations (id) VALUES (:id)"), {"id": migration_id}
            )
            logger.info(
                "migration %s %s", migration_id, "applied" if changed else "skipped (already current)"
            )
