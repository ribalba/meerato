"""External task API.

Token-authenticated endpoints so other tools (cron, shortcuts, curl) can drop a
task into a user's account — or read their tasks back out — without a session
cookie. The token (see the "API" page in the app) is passed as the ``token``
query parameter and identifies the owner; created tasks sync to the user's
devices on the next pull.

Titles understand the same quick-add shorthand as the in-app box (``#bucket``,
``@watcher``, ``!status``, a trailing date phrase like "next week") — see
``app/quickadd.py``. Relative dates resolve against the owner's timezone.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session as DBSession

from ..database import get_db
from ..models import (
    STATUS_LABELS,
    Bucket,
    CustomStatus,
    EventType,
    ScheduledStatusChange,
    Todo,
)
from ..quickadd import ParsedTask, local_today, parse_quick_add, status_alias_map
from ..schemas import (
    ApiOptionsOut,
    ApiParsedOut,
    ApiScheduleCreate,
    ApiStatusOut,
    ApiTaskCreate,
    ApiTaskOut,
    ApiTodoOut,
    ScheduleOut,
    TodoOut,
)
from ..security import get_user_by_api_token, new_id
from ..services import (
    add_watcher as add_watcher_svc,
    attach_to_todo,
    attach_to_todos,
    record_event,
    status_label,
    touch,
    valid_status,
)
from ..timeutil import start_of_day_utc

router = APIRouter(prefix="/api", tags=["external"])


def _authenticate(db: DBSession, token: str):
    user = get_user_by_api_token(db, token)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid API token")
    return user


def _open_buckets(db: DBSession, owner_id: str):
    """The caller's usable buckets, in the same order POST /create picks from."""
    return (
        db.query(Bucket)
        .filter(Bucket.owner_id == owner_id, Bucket.deleted.is_(False), Bucket.archived.is_(False))
        .order_by(Bucket.position, Bucket.created_at)
        .all()
    )


def _custom_statuses(db: DBSession, owner_id: str):
    return (
        db.query(CustomStatus)
        .filter(CustomStatus.owner_id == owner_id)
        .order_by(CustomStatus.position, CustomStatus.created_at)
        .all()
    )


def _schedule_change(db: DBSession, user, todo: Todo, on_date, status: str) -> ScheduledStatusChange:
    """Queue a status change for ``todo``, firing at local midnight on ``on_date``."""
    valid_status(db, user.id, status)
    sched = ScheduledStatusChange(
        id=new_id(),
        todo_id=todo.id,
        target_status=status,
        local_date=on_date.isoformat(),
        # Fire at the start of the chosen day in the user's timezone, stored naive-UTC.
        scheduled_for=start_of_day_utc(on_date, user.timezone),
    )
    db.add(sched)
    record_event(
        db, todo, EventType.scheduled,
        body=f"Scheduled status → {status_label(db, user.id, status)} on {on_date.isoformat()} (API)",
        actor_email=user.email,
    )
    return sched


@router.get("/create", response_model=ApiOptionsOut)
def api_create_options(
    token: str = Query(..., description="Your API token (see the API page in the app)"),
    db: DBSession = Depends(get_db),
):
    """Discovery for the create endpoint: the statuses and buckets a POST may use.

    Lets a script fetch the valid ``status`` and ``bucket_id`` values instead of
    hard-coding them. ``default_bucket_id`` is the bucket a POST without a
    ``bucket_id`` would land in.
    """
    user = _authenticate(db, token)

    statuses = [
        ApiStatusOut(value=value, label=label, builtin=True)
        for value, label in STATUS_LABELS.items()
    ]
    statuses += [
        ApiStatusOut(value=cs.value, label=cs.label, builtin=False)
        for cs in _custom_statuses(db, user.id)
    ]

    buckets = _open_buckets(db, user.id)
    return ApiOptionsOut(
        statuses=statuses,
        buckets=buckets,
        default_bucket_id=buckets[0].id if buckets else None,
    )


@router.post("/create", response_model=ApiTaskOut, status_code=201)
def api_create_todo(
    payload: ApiTaskCreate,
    token: str = Query(..., description="Your API token (see the API page in the app)"),
    db: DBSession = Depends(get_db),
):
    """Create a task, interpreting the quick-add shorthand in ``title``.

    Explicit fields win over anything parsed out of the title, so a script can
    pass ``bucket_id``/``status`` and still let users write free-form titles.
    """
    user = _authenticate(db, token)

    buckets = _open_buckets(db, user.id)
    if payload.parse:
        parsed = parse_quick_add(
            payload.title,
            buckets,
            status_alias_map(_custom_statuses(db, user.id)),
            local_today(user.timezone),
        )
    else:
        parsed = ParsedTask(title=payload.title.strip())

    # An explicit body field always wins over the parsed one.
    status = payload.status if "status" in payload.model_fields_set else (parsed.status or payload.status)
    valid_status(db, user.id, status)

    # Pick the target bucket: the one supplied (must be the caller's), else a
    # parsed #bucket, else their first non-archived bucket.
    bucket_id = payload.bucket_id or parsed.bucket_id
    if bucket_id:
        bucket = db.get(Bucket, bucket_id)
        if bucket is None or bucket.deleted or bucket.owner_id != user.id:
            raise HTTPException(status_code=404, detail="Bucket not found")
    else:
        bucket = buckets[0] if buckets else None
        if bucket is None:
            raise HTTPException(status_code=400, detail="No bucket to add the task to")

    todo = Todo(
        id=new_id(),
        bucket_id=bucket.id,
        owner_id=user.id,
        title=parsed.title,
        text=payload.text or "",
        status=status,
        position=0,
        public_token=new_id().replace("-", ""),
    )
    db.add(todo)
    record_event(db, todo, EventType.created, body="Created task (API)", actor_email=user.email)

    # ScheduledStatusChange carries a bare FK to todos.id with no ORM relationship
    # back to Todo, so the unit of work has no dependency edge telling it to insert
    # the task first: it would order the schedule's INSERT ahead of the task's and
    # trip the foreign key. Flush the task now so the row exists to point at.
    db.flush()

    # An explicit `schedule` beats a date phrase in the title; a date phrase with
    # no explicit status starts the task in Backlog and moves it to "Now" that day.
    sched_date = payload.schedule.date if payload.schedule else parsed.schedule_date
    sched_status = payload.schedule.status if payload.schedule else "on_list"
    if sched_date:
        _schedule_change(db, user, todo, sched_date, sched_status)
        if not payload.schedule and "status" not in payload.model_fields_set and not parsed.status:
            todo.status = "open"

    watchers = list(parsed.watchers)
    for email in payload.watchers:
        if email.lower() not in watchers:
            watchers.append(email.lower())
    for email in watchers:
        add_watcher_svc(db, todo, email, actor=user)  # None when already watching

    db.commit()
    db.refresh(todo)
    attach_to_todo(db, todo)
    todo.has_schedule = bool(sched_date)
    return ApiTaskOut(
        **TodoOut.model_validate(todo).model_dump(),
        parsed=ApiParsedOut(
            title=todo.title,
            bucket_name=bucket.name,
            status=todo.status,
            scheduled_date=sched_date,
            scheduled_status=sched_status if sched_date else None,
            watchers=watchers,
        ),
    )


# --- Reading tasks --------------------------------------------------------


@router.get("/tasks", response_model=list[ApiTodoOut])
def api_list_todos(
    token: str = Query(..., description="Your API token (see the API page in the app)"),
    bucket_id: str | None = Query(None, description="Only tasks in this bucket"),
    status: str | None = Query(None, description="Only tasks with this status"),
    db: DBSession = Depends(get_db),
):
    """Every task you own, as JSON, in the app's display order.

    Deleted tasks are left out; tasks in archived buckets are not, so the list
    matches what a full sync would hand a device. Optional ``bucket_id`` and
    ``status`` narrow it down — both accept the values GET /api/create reports.
    """
    user = _authenticate(db, token)

    q = db.query(Todo).filter(Todo.owner_id == user.id, Todo.deleted.is_(False))
    if bucket_id:
        bucket = db.get(Bucket, bucket_id)
        if bucket is None or bucket.deleted or bucket.owner_id != user.id:
            raise HTTPException(status_code=404, detail="Bucket not found")
        q = q.filter(Todo.bucket_id == bucket_id)
    if status:
        valid_status(db, user.id, status)
        q = q.filter(Todo.status == status)

    todos = q.order_by(Todo.position, Todo.created_at).all()
    attach_to_todos(db, todos)  # attachments + the has_schedule flag

    names = {b.id: b.name for b in db.query(Bucket).filter(Bucket.owner_id == user.id)}
    for todo in todos:
        todo.bucket_name = names.get(todo.bucket_id)
    return todos


# --- Scheduled status changes --------------------------------------------


def _owned_todo(db: DBSession, todo_id: str, user) -> Todo:
    todo = db.get(Todo, todo_id)
    if todo is None or todo.deleted or todo.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Task not found")
    return todo


@router.get("/schedule", response_model=list[ScheduleOut])
def api_list_schedules(
    todo_id: str = Query(..., description="The task to list pending status changes for"),
    token: str = Query(..., description="Your API token (see the API page in the app)"),
    db: DBSession = Depends(get_db),
):
    """Pending (not yet applied) status changes for a task."""
    user = _authenticate(db, token)
    _owned_todo(db, todo_id, user)
    return (
        db.query(ScheduledStatusChange)
        .filter(ScheduledStatusChange.todo_id == todo_id, ScheduledStatusChange.applied.is_(False))
        .order_by(ScheduledStatusChange.scheduled_for)
        .all()
    )


@router.post("/schedule", response_model=ScheduleOut, status_code=201)
def api_create_schedule(
    payload: ApiScheduleCreate,
    token: str = Query(..., description="Your API token (see the API page in the app)"),
    db: DBSession = Depends(get_db),
):
    """Schedule a status change on an existing task.

    Fires at the start of ``date`` in your timezone. A task may hold several
    pending changes; they apply in date order.
    """
    user = _authenticate(db, token)
    todo = _owned_todo(db, payload.todo_id, user)
    sched = _schedule_change(db, user, todo, payload.date, payload.status)
    touch(todo)
    db.commit()
    db.refresh(sched)
    return sched


@router.delete("/schedule/{schedule_id}")
def api_cancel_schedule(
    schedule_id: str,
    token: str = Query(..., description="Your API token (see the API page in the app)"),
    db: DBSession = Depends(get_db),
):
    """Cancel a pending status change."""
    user = _authenticate(db, token)
    sched = db.get(ScheduledStatusChange, schedule_id)
    if sched is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    todo = _owned_todo(db, sched.todo_id, user)
    db.delete(sched)
    touch(todo)  # bump updated_at so the cleared schedule syncs to the task list
    db.commit()
    return {"ok": True}
