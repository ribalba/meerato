"""Cross-cutting helpers shared by routers: timeline events, watcher notifications,
attachment loading, and access control."""

import json
import os

from fastapi import HTTPException
from sqlalchemy.orm import Session as DBSession

from .config import get_settings
from .emailer import send_watcher_invite, send_watcher_update
from .models import (
    STATUS_LABELS,
    Attachment,
    Bucket,
    CustomStatus,
    Event,
    EventType,
    ScheduledStatusChange,
    Todo,
    TodoStatus,
    User,
    Watcher,
    utcnow,
)
from .security import new_id, new_token

settings = get_settings()

# Fields whose change is logged to the timeline and notified to watchers.
TRACKED_FIELDS = ("title", "text", "status", "bucket_id", "parent_id")


# --- Timeline ---


def record_event(
    db: DBSession,
    todo: Todo,
    type_: EventType,
    body: str = "",
    actor_email: str | None = None,
    meta: dict | None = None,
    event_id: str | None = None,
) -> Event:
    event = Event(
        id=event_id or new_id(),
        todo_id=todo.id,
        type=type_.value,
        body=body,
        meta=json.dumps(meta) if meta else None,
        actor_email=actor_email,
    )
    db.add(event)
    return event


def snapshot(todo: Todo) -> dict:
    """Capture the tracked fields before a mutation so changes can be diffed."""
    return {f: getattr(todo, f) for f in TRACKED_FIELDS}


def display_name(user) -> str:
    """Friendly name for emails/messages: the chosen name, else the email's local part."""
    if user is None:
        return "Someone"
    return (user.name or "").strip() or user.email.split("@")[0]


def log_todo_changes(db: DBSession, todo: Todo, before: dict, actor) -> None:
    """Record timeline events for every change to a todo and notify watchers once.

    Used by both the REST and sync paths so a change is logged + emailed no matter
    how it arrived. ``before`` is a snapshot() taken prior to applying the change;
    ``actor`` is the User who made it (used for the timeline + email wording).
    """
    actor_email = actor.email if actor else None
    name = display_name(actor)
    summary: list[str] = []

    if todo.status != before["status"]:
        old_l = status_label(db, todo.owner_id, before["status"])
        new_l = status_label(db, todo.owner_id, todo.status)
        record_event(
            db, todo, EventType.status_changed,
            body=f"Status: {old_l} → {new_l}", actor_email=actor_email,
            meta={"from": before["status"], "to": todo.status},
        )
        todo.completed_at = utcnow() if todo.status == TodoStatus.done.value else None
        summary.append(f"changed the status to {new_l}")

    if todo.title != before["title"]:
        record_event(
            db, todo, EventType.edited,
            body=f'Renamed: "{before["title"]}" → "{todo.title}"', actor_email=actor_email,
            meta={"from_title": before["title"], "to_title": todo.title},
        )
        summary.append(f'changed the title to "{todo.title}"')

    if todo.text != before["text"]:
        record_event(db, todo, EventType.edited, body="Edited description", actor_email=actor_email)
        summary.append("edited the description")

    if todo.bucket_id != before["bucket_id"] or todo.parent_id != before["parent_id"]:
        record_event(db, todo, EventType.moved, body="Moved task", actor_email=actor_email)
        summary.append("moved the task")

    if summary:
        msg = f"{name} " + " and ".join(summary) + "."
        notify_watchers(db, todo, msg, exclude_email=actor_email)


def move_now_to_backlog_for_schedule(db: DBSession, todo: Todo, actor) -> None:
    """Move a scheduled task out of Now until its pending status change applies."""
    if todo.status != TodoStatus.on_list.value:
        return
    before = snapshot(todo)
    todo.status = TodoStatus.open.value
    log_todo_changes(db, todo, before, actor)


# --- Watchers ---


def add_watcher(db: DBSession, todo: Todo, email: str, actor: User | None) -> Watcher | None:
    """Add a watcher to a todo (idempotent) and email them a scoped magic link.

    Returns the new Watcher, or None if the email already watches the todo. Shared
    by the todos router and the recurring-task scheduler. ``actor`` is the user who
    added the watcher (named in the invite email).
    """
    email = email.strip().lower()
    existing = (
        db.query(Watcher).filter(Watcher.todo_id == todo.id, Watcher.email == email).first()
    )
    if existing:
        return None
    actor_email = actor.email if actor else None
    watcher = Watcher(
        id=new_id(), todo_id=todo.id, email=email, unsubscribe_token=new_token()
    )
    db.add(watcher)
    record_event(
        db, todo, EventType.watcher_added, body=f"Added watcher {email}", actor_email=actor_email
    )
    # Email the watcher an invite pointing at the public task page. This is a
    # read/comment view that needs no account, so we deliberately do not send a
    # magic login link (which would silently create an account on click).
    link = f"{settings.base_url}/t/{todo.public_token}"
    unsubscribe_link = f"{settings.base_url}/unsubscribe/{watcher.unsubscribe_token}"
    send_watcher_invite(
        email, todo.title, link, adder_name=display_name(actor), unsubscribe_link=unsubscribe_link
    )
    return watcher


def ensure_watcher(db: DBSession, todo: Todo, email: str) -> Watcher:
    """Make sure ``email`` watches ``todo`` (idempotent), without sending an invite.

    Used by the public "View in the app" flow: the visitor self-subscribes, which
    records that they were looking at the task so it shows up in their Watching list
    once they sign in. The email is linked by address, not user id.
    """
    email = email.strip().lower()
    watcher = (
        db.query(Watcher).filter(Watcher.todo_id == todo.id, Watcher.email == email).first()
    )
    if watcher is None:
        watcher = Watcher(
            id=new_id(), todo_id=todo.id, email=email, unsubscribe_token=new_token()
        )
        db.add(watcher)
    return watcher


def import_shared_todo(db: DBSession, src: Todo, user: User) -> Todo:
    """Copy a shared/watched task into ``user``'s own account as a new top-level todo.

    Copies the title, description and status into the user's first non-archived
    bucket (creating an "Imported" bucket if they have none). Subtasks are not
    copied. The new task is fully owned and editable by the user.
    """
    bucket = (
        db.query(Bucket)
        .filter(Bucket.owner_id == user.id, Bucket.deleted.is_(False), Bucket.archived.is_(False))
        .order_by(Bucket.position)
        .first()
    )
    if bucket is None:
        bucket = Bucket(id=new_id(), owner_id=user.id, name="Imported", position=0)
        db.add(bucket)
        db.flush()

    position = int(utcnow().timestamp() * 1000)
    todo = Todo(
        id=new_id(),
        owner_id=user.id,
        bucket_id=bucket.id,
        title=src.title,
        text=src.text or "",
        status=src.status,
        position=position,
        public_token=new_id().replace("-", ""),
    )
    db.add(todo)
    record_event(
        db, todo, EventType.created, body="Imported from a shared task", actor_email=user.email
    )
    return todo


def notify_watchers(db: DBSession, todo: Todo, summary: str, exclude_email: str | None = None) -> None:
    link = f"{settings.base_url}/t/{todo.public_token}"
    excluded = exclude_email.lower() if exclude_email else None
    notified: set[str] = set()
    watchers = db.query(Watcher).filter(Watcher.todo_id == todo.id).all()
    for w in watchers:
        if excluded and w.email.lower() == excluded:
            continue
        # Backfill a token for watchers created before unsubscribe links existed.
        if not w.unsubscribe_token:
            w.unsubscribe_token = new_token()
        unsubscribe_link = f"{settings.base_url}/unsubscribe/{w.unsubscribe_token}"
        send_watcher_update(w.email, todo.title, summary, link, unsubscribe_link)
        notified.add(w.email.lower())

    # The owner isn't a watcher of their own task, so notify them too when someone
    # else (a watcher) makes a change — otherwise the owner never hears about it.
    owner = db.get(User, todo.owner_id)
    if owner and owner.email.lower() not in notified and owner.email.lower() != excluded:
        send_watcher_update(owner.email, todo.title, summary, link)


# --- Attachments ---


def load_attachments(db: DBSession, owner_type: str, owner_ids: list[str]) -> dict[str, list[Attachment]]:
    if not owner_ids:
        return {}
    rows = (
        db.query(Attachment)
        .filter(Attachment.owner_type == owner_type, Attachment.owner_id.in_(owner_ids))
        .all()
    )
    out: dict[str, list[Attachment]] = {}
    for r in rows:
        out.setdefault(r.owner_id, []).append(r)
    return out


def attach_to_todo(db: DBSession, todo: Todo) -> Todo:
    todo.attachments = load_attachments(db, "todo", [todo.id]).get(todo.id, [])
    return todo


def attach_to_todos(db: DBSession, todos: list[Todo]) -> list[Todo]:
    ids = [t.id for t in todos]
    mapping = load_attachments(db, "todo", ids)
    scheduled = {
        todo_id
        for (todo_id,) in db.query(ScheduledStatusChange.todo_id)
        .filter(
            ScheduledStatusChange.todo_id.in_(ids),
            ScheduledStatusChange.applied.is_(False),
        )
        .distinct()
    } if ids else set()
    for t in todos:
        t.attachments = mapping.get(t.id, [])
        t.has_schedule = t.id in scheduled
    return todos


def attach_to_event(db: DBSession, event: Event) -> Event:
    event.attachments = load_attachments(db, "event", [event.id]).get(event.id, [])
    return event


def attach_to_events(db: DBSession, events: list[Event]) -> list[Event]:
    mapping = load_attachments(db, "event", [e.id for e in events])
    for e in events:
        e.attachments = mapping.get(e.id, [])
    return events


# --- Validation & lookups (shared across routers) ---


def _custom_status(db: DBSession, owner_id: str, value: str) -> CustomStatus | None:
    return (
        db.query(CustomStatus)
        .filter(CustomStatus.owner_id == owner_id, CustomStatus.value == value)
        .first()
    )


def valid_status(db: DBSession, owner_id: str, value: str) -> str:
    """Return ``value`` if it is a built-in or one of ``owner_id``'s custom
    statuses, else raise 422."""
    if value in STATUS_LABELS:
        return value
    if _custom_status(db, owner_id, value) is None:
        raise HTTPException(status_code=422, detail=f"Invalid status: {value}")
    return value


def status_exists(db: DBSession, owner_id: str, value: str) -> bool:
    """Whether ``value`` is usable as a status for ``owner_id``. The non-raising
    counterpart to :func:`valid_status`, for callers that fall back to a default
    instead of erroring (e.g. a stored preference naming a since-deleted status)."""
    return value in STATUS_LABELS or _custom_status(db, owner_id, value) is not None


def status_label(db: DBSession, owner_id: str, value: str) -> str:
    """Human-readable label for a status value (built-in or custom). Falls back
    to the raw value if it is unknown (e.g. a since-deleted custom status)."""
    if value in STATUS_LABELS:
        return STATUS_LABELS[value]
    cs = _custom_status(db, owner_id, value)
    return cs.label if cs else value


def get_owned_bucket(db: DBSession, bucket_id: str, user: User) -> Bucket:
    """Fetch a non-deleted bucket owned by ``user``, else raise 404."""
    bucket = db.get(Bucket, bucket_id)
    if bucket is None or bucket.deleted or bucket.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Bucket not found")
    return bucket


def get_public_todo(db: DBSession, token: str) -> Todo:
    """Resolve a live todo by its public share token, else raise 404."""
    todo = (
        db.query(Todo)
        .filter(Todo.public_token == token, Todo.deleted.is_(False))
        .one_or_none()
    )
    if todo is None:
        raise HTTPException(status_code=404, detail="This shared task does not exist")
    return todo


# --- Uploads ---


def store_upload(filename: str | None, data: bytes) -> str:
    """Validate the size of an uploaded file and write it to the upload dir under a
    random name. Returns the stored name; raises 413 if it exceeds the size limit."""
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="File too large")
    ext = os.path.splitext(filename or "")[1][:16]
    stored_name = f"{new_id()}{ext}"
    (settings.upload_dir / stored_name).write_bytes(data)
    return stored_name


# --- Access control ---


def get_owned_todo(db: DBSession, todo_id: str, user: User) -> Todo:
    """Fetch a todo the user may edit (owner or watcher)."""
    todo = db.get(Todo, todo_id)
    if todo is None or todo.deleted:
        raise HTTPException(status_code=404, detail="Todo not found")
    if todo.owner_id == user.id:
        return todo
    is_watcher = (
        db.query(Watcher)
        .filter(Watcher.todo_id == todo_id, Watcher.email == user.email)
        .first()
        is not None
    )
    if not is_watcher:
        raise HTTPException(status_code=403, detail="Not allowed")
    return todo


def touch(obj) -> None:
    obj.updated_at = utcnow()
