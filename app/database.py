from collections.abc import Generator

from sqlalchemy import create_engine
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


def init_db() -> None:
    # Import models so they are registered on Base before create_all.
    from . import models  # noqa: F401

    # On a fresh deploy the models define the full schema, so create_all() produces
    # everything in one shot. On an existing one it only fills in tables that are
    # missing entirely — anything that *changed* on a table already on disk (a widened
    # column, say) is handled by the migration list, which runs on every boot.
    Base.metadata.create_all(bind=engine)
    run_migrations(engine)
