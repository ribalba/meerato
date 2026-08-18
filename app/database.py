from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings
from .migrations import run_migrations

settings = get_settings()

# check_same_thread=False is required for SQLite when used across FastAPI's threadpool.
connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}

engine = create_engine(settings.database_url, connect_args=connect_args, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Columns added to existing tables after that table's first release. create_all()
# creates missing *tables* but never alters an existing one, and the deployed
# database lives on a persistent volume — so without this, an upgraded stack keeps
# the old table and every query naming a new column fails. All entries must be
# nullable (or defaulted) so adding them needs no backfill; the types are spelled
# in portable SQL that both SQLite and PostgreSQL accept.
_ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "users": {
        "default_bucket_id": "VARCHAR(36)",
        "default_status": "VARCHAR(20)",
    },
}


def _add_missing_columns() -> None:
    """Bring pre-existing tables up to the current model. Idempotent: on a database
    create_all() just built, every column is already there and this does nothing."""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    for table, columns in _ADDED_COLUMNS.items():
        if table not in tables:
            continue
        present = {c["name"] for c in inspector.get_columns(table)}
        missing = {name: sql for name, sql in columns.items() if name not in present}
        if not missing:
            continue
        with engine.begin() as conn:
            for name, sql_type in missing.items():
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}"))


def init_db() -> None:
    # Import models so they are registered on Base before create_all.
    from . import models  # noqa: F401

    # The models define the full schema (including the BigInteger `position`
    # columns), so create_all() produces every table in one shot on a fresh deploy.
    Base.metadata.create_all(bind=engine)
    # Then patch up databases created by an earlier release, which create_all()
    # leaves with their original columns. Two steps, because they answer different
    # questions: _ADDED_COLUMNS is a declarative "these columns must exist" sweep,
    # while migrations.py runs ordered, recorded, one-shot DDL for everything a
    # column list cannot express (changing a type, backfilling, dropping). Columns
    # are added first so a migration can then alter one.
    _add_missing_columns()
    run_migrations(engine)
