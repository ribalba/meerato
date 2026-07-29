"""SQLAlchemy ORM models.

Design notes
------------
* Primary keys for sync-able entities (Bucket, Todo, Event) are client-generatable
  UUID strings. This lets the offline client create rows locally with a stable id and
  replay them to the server without a remap step.
* Every sync-able row carries ``updated_at`` (server-stamped on write). Conflict
  resolution on sync is last-write-wins on that timestamp.
* Soft deletes (``deleted`` flag) so that a delete made on one device can propagate to
  others instead of silently resurrecting on the next push.
"""

from datetime import datetime, timezone
from enum import Enum

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    # Naive UTC. SQLite does not preserve tzinfo, so we keep everything naive-UTC
    # internally and normalize any tz-aware input at the boundaries (see sync._norm).
    return datetime.now(timezone.utc).replace(tzinfo=None)


class TodoStatus(str, Enum):
    open = "open"          # backlog
    on_list = "on_list"    # "on the todo list" — to be done fairly soon
    blocked = "blocked"    # cannot proceed
    done = "done"


# Human-readable labels, shared by the REST and sync paths for timeline messages.
STATUS_LABELS = {
    TodoStatus.open.value: "Backlog",
    TodoStatus.on_list.value: "Now",
    TodoStatus.blocked.value: "Blocked",
    TodoStatus.done.value: "Done",
}

# Values a user-defined status may not reuse: the four built-ins (which always
# exist, in code) plus the "all" sidebar view. See CustomStatus.
RESERVED_STATUS_VALUES = set(STATUS_LABELS) | {"all"}


# --- Auth -----------------------------------------------------------------


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    name: Mapped[str | None] = mapped_column(String(200))
    # IANA timezone (e.g. "Europe/Berlin"); determines when scheduled changes fire.
    timezone: Mapped[str] = mapped_column(String(64), default="UTC", nullable=False)
    # Secret token for the external "create task" API (POST /api/create?token=…).
    # Null until the user first opens the API page; rotatable.
    api_token: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    # "New task defaults" from Settings: where a task lands when the caller names
    # neither a bucket nor a status. Held server-side (rather than only in the
    # browser's local meta) so the external API honours the same preference the
    # app does. Null means "no preference" — first open bucket / Backlog. Kept as
    # a plain column, not a FK: buckets.owner_id already points back here, and a
    # second edge would make the two tables mutually dependent at create_all time.
    # A stale id (bucket since deleted or archived) falls back instead of failing.
    default_bucket_id: Mapped[str | None] = mapped_column(String(36))
    default_status: Mapped[str | None] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class LoginToken(Base):
    """Magic link token emailed to a user, valid until it expires.

    Reusable within its TTL so that mobile mail clients / link prefetchers
    that hit the link before the user does don't invalidate it.
    """

    __tablename__ = "login_tokens"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    # Retained for backwards compatibility; no longer enforced (see consume_login_token).
    used: Mapped[bool] = mapped_column(Boolean, default=False)
    # Optional todo the login is scoped to (watcher invite flow) for redirect after login.
    redirect_todo_id: Mapped[str | None] = mapped_column(String(36))


class LoginCode(Base):
    """Short alphanumeric sign-in code, emailed alongside the magic link.

    The link cannot always complete sign-in: a ``meerato://`` deep link only reaches
    the desktop app if the OS has the protocol handler registered, which is not a
    given on Linux. Typing the code into the app window always works.

    Kept in its own table rather than as columns on LoginToken because the deploy
    story is ``create_all``-only (see database.init_db): a new table appears on an
    existing database, new columns would not.

    One live code per email — requesting another replaces it. Only the HMAC of the
    code is stored, and the row is deleted on first successful use or after
    ``login_code_max_attempts`` wrong guesses. That attempt budget, rather than the
    length, is what keeps a 6-character secret out of reach of a guessing attack.
    """

    __tablename__ = "login_codes"

    email: Mapped[str] = mapped_column(String(320), primary_key=True)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class RateLimit(Base):
    """Fixed-window request counter — one row per ``(action:subject)`` key — used to
    throttle the sign-in endpoints (code issuance and code submission, keyed by email).

    Its own table for the same ``create_all``-only deploy reason as LoginCode. Rows are
    reused per key and never grow in number faster than distinct emails seen; like
    login_tokens they are not garbage-collected, which is fine at this scale.
    """

    __tablename__ = "rate_limits"

    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    window_start: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class Session(Base):
    __tablename__ = "sessions"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# --- Core domain ----------------------------------------------------------


class Bucket(Base):
    __tablename__ = "buckets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    color: Mapped[str | None] = mapped_column(String(20))
    # BigInteger: the client orders with `Date.now()` (~1.7e12), which overflows
    # a 32-bit Postgres integer.
    position: Mapped[int] = mapped_column(BigInteger, default=0)
    archived: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    todos: Mapped[list["Todo"]] = relationship(back_populates="bucket")


class Todo(Base):
    __tablename__ = "todos"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    bucket_id: Mapped[str] = mapped_column(ForeignKey("buckets.id"), index=True, nullable=False)
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("todos.id"), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)

    title: Mapped[str] = mapped_column(String(500), nullable=False)
    text: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default=TodoStatus.open.value, index=True)
    # BigInteger: see Bucket.position — the client orders with `Date.now()`.
    position: Mapped[int] = mapped_column(BigInteger, default=0)

    # Shareable read-only link token.
    public_token: Mapped[str] = mapped_column(String(40), unique=True, index=True, nullable=False)

    deleted: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)

    bucket: Mapped["Bucket"] = relationship(back_populates="todos")
    children: Mapped[list["Todo"]] = relationship(
        backref="parent", remote_side=[id], uselist=True, viewonly=True
    )
    events: Mapped[list["Event"]] = relationship(back_populates="todo")
    watchers: Mapped[list["Watcher"]] = relationship(back_populates="todo")


class EventType(str, Enum):
    created = "created"
    comment = "comment"
    status_changed = "status_changed"
    edited = "edited"
    file_added = "file_added"
    watcher_added = "watcher_added"
    file_removed = "file_removed"
    moved = "moved"
    scheduled = "scheduled"


class Event(Base):
    """A single entry on a todo's timeline. Comments are events of type 'comment'."""

    __tablename__ = "events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    todo_id: Mapped[str] = mapped_column(ForeignKey("todos.id"), index=True, nullable=False)
    type: Mapped[str] = mapped_column(String(30), nullable=False)
    # Markdown body for comments; human-readable description for system events.
    body: Mapped[str] = mapped_column(Text, default="")
    # Structured payload for system events (old/new status, etc.) as JSON text.
    meta: Mapped[str | None] = mapped_column(Text)
    actor_email: Mapped[str | None] = mapped_column(String(320))

    deleted: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    todo: Mapped["Todo"] = relationship(back_populates="events")


class Watcher(Base):
    __tablename__ = "watchers"
    __table_args__ = (UniqueConstraint("todo_id", "email", name="uq_watcher"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    todo_id: Mapped[str] = mapped_column(ForeignKey("todos.id"), index=True, nullable=False)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    # Unguessable token for the one-click email unsubscribe link.
    unsubscribe_token: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    todo: Mapped["Todo"] = relationship(back_populates="watchers")


class Attachment(Base):
    """A file attached to either a todo or a comment/event."""

    __tablename__ = "attachments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    # owner_type is 'todo' or 'event'.
    owner_type: Mapped[str] = mapped_column(String(10), nullable=False)
    owner_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    stored_name: Mapped[str] = mapped_column(String(80), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(200))
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ScheduledStatusChange(Base):
    """A future status change for a todo, applied by the background scheduler when
    ``scheduled_for`` (stored naive-UTC, computed from the user's timezone) is reached."""

    __tablename__ = "scheduled_status_changes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    todo_id: Mapped[str] = mapped_column(ForeignKey("todos.id"), index=True, nullable=False)
    target_status: Mapped[str] = mapped_column(String(20), nullable=False)
    local_date: Mapped[str] = mapped_column(String(10), nullable=False)  # YYYY-MM-DD, for display
    scheduled_for: Mapped[datetime] = mapped_column(DateTime, index=True, nullable=False)
    applied: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class CustomStatus(Base):
    """A user-defined status, additive to the four built-in statuses.

    Owner-scoped. The built-ins (open/on_list/blocked/done) live in code and
    always exist; these rows extend the list. ``value`` is a slug generated from
    the label, unique per owner, and never collides with a built-in or the "all"
    view (see RESERVED_STATUS_VALUES). Fetched by the client at boot via
    ``GET /api/statuses`` to build its full status list.

    Not part of offline sync: statuses are edited online (like recurring tasks);
    the client caches the last-fetched list so it can still render known ones
    while offline.
    """

    __tablename__ = "custom_statuses"
    __table_args__ = (UniqueConstraint("owner_id", "value", name="uq_custom_status"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    value: Mapped[str] = mapped_column(String(30), nullable=False)
    label: Mapped[str] = mapped_column(String(60), nullable=False)
    color: Mapped[str] = mapped_column(String(20), default="grey")
    icon: Mapped[str] = mapped_column(String(40), default="circle")
    # BigInteger: the client orders with `Date.now()` (see Bucket.position).
    position: Mapped[int] = mapped_column(BigInteger, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class RepeatFreq(str, Enum):
    daily = "daily"      # every day
    weekly = "weekly"    # on a chosen weekday
    monthly = "monthly"  # on a chosen day of the month
    yearly = "yearly"    # on a chosen month + day


# Human-readable labels for the recurrence cadence.
FREQ_LABELS = {
    RepeatFreq.daily.value: "Every day",
    RepeatFreq.weekly.value: "Once a week",
    RepeatFreq.monthly.value: "Once a month",
    RepeatFreq.yearly.value: "Once a year",
}


class RecurringTask(Base):
    """A template that the background scheduler turns into a real ``Todo`` on a
    recurring cadence. Owner-scoped and managed online (not part of offline sync);
    only the tasks it spawns sync to clients.

    ``next_run`` is stored naive-UTC (computed from the cadence in the owner's
    timezone). When it passes, the scheduler creates a todo and advances it.
    """

    __tablename__ = "recurring_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)

    # Template for each created task.
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    text: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default=TodoStatus.open.value)
    bucket_id: Mapped[str] = mapped_column(ForeignKey("buckets.id"), index=True, nullable=False)
    watcher_email: Mapped[str | None] = mapped_column(String(320))

    # Cadence. Only the column relevant to ``frequency`` is used:
    #   weekly  -> day_of_week (0=Monday .. 6=Sunday)
    #   monthly -> day_of_month (1..31, clamped to the month's length)
    #   yearly  -> month_of_year (1..12) + day_of_month
    frequency: Mapped[str] = mapped_column(String(10), nullable=False)
    day_of_week: Mapped[int | None] = mapped_column(Integer)
    day_of_month: Mapped[int | None] = mapped_column(Integer)
    month_of_year: Mapped[int | None] = mapped_column(Integer)

    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    next_run: Mapped[datetime] = mapped_column(DateTime, index=True, nullable=False)
    last_run: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
