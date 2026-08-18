from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session as DBSession

from ..database import get_db
from ..models import (
    Bucket,
    Event,
    EventType,
    ScheduledStatusChange,
    Todo,
    Watcher,
)
from ..schemas import (
    CommentCreate,
    EventOut,
    ScheduleCreate,
    ScheduleOut,
    TodoCreate,
    TodoOut,
    TodoUpdate,
    WatcherCreate,
    WatcherOut,
)
from ..security import get_current_user, new_id
from ..services import (
    add_watcher as add_watcher_svc,  # aliased: the route handler below is also `add_watcher`
    attach_to_event,
    attach_to_events,
    attach_to_todo,
    attach_to_todos,
    display_name,
    get_owned_todo,
    log_todo_changes,
    move_now_to_backlog_for_schedule,
    notify_watchers,
    record_event,
    snapshot,
    status_label,
    touch,
    valid_status,
)
from ..timeutil import start_of_day_utc

router = APIRouter(prefix="/api/todos", tags=["todos"])


@router.get("", response_model=list[TodoOut])
def list_todos(
    bucket_id: str | None = None,
    status: str | None = None,
    db: DBSession = Depends(get_db),
    user=Depends(get_current_user),
):
    q = db.query(Todo).filter(Todo.owner_id == user.id, Todo.deleted.is_(False))
    if bucket_id:
        q = q.filter(Todo.bucket_id == bucket_id)
    if status:
        q = q.filter(Todo.status == status)
    todos = q.order_by(Todo.position, Todo.created_at).all()
    attach_to_todos(db, todos)
    return todos


@router.post("", response_model=TodoOut, status_code=201)
def create_todo(payload: TodoCreate, db: DBSession = Depends(get_db), user=Depends(get_current_user)):
    bucket = db.get(Bucket, payload.bucket_id)
    if bucket is None or bucket.deleted or bucket.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Bucket not found")
    if payload.parent_id:
        parent = db.get(Todo, payload.parent_id)
        if parent is None or parent.deleted or parent.owner_id != user.id:
            raise HTTPException(status_code=404, detail="Parent todo not found")

    todo = Todo(
        id=payload.id or new_id(),
        bucket_id=payload.bucket_id,
        parent_id=payload.parent_id,
        owner_id=user.id,
        title=payload.title,
        text=payload.text,
        status=valid_status(db, user.id, payload.status),
        position=payload.position,
        public_token=new_id().replace("-", ""),
    )
    db.add(todo)
    record_event(db, todo, EventType.created, body="Created task", actor_email=user.email)
    if payload.watcher_email:
        add_watcher_svc(db, todo, payload.watcher_email, actor=user)
    db.commit()
    db.refresh(todo)
    return attach_to_todo(db, todo)


@router.get("/{todo_id}", response_model=TodoOut)
def get_todo(todo_id: str, db: DBSession = Depends(get_db), user=Depends(get_current_user)):
    todo = get_owned_todo(db, todo_id, user)
    return attach_to_todo(db, todo)


@router.patch("/{todo_id}", response_model=TodoOut)
def update_todo(
    todo_id: str, payload: TodoUpdate, db: DBSession = Depends(get_db), user=Depends(get_current_user)
):
    todo = get_owned_todo(db, todo_id, user)
    changes = payload.model_dump(exclude_unset=True)
    if "status" in changes:
        valid_status(db, user.id, changes["status"])

    # Snapshot, apply, then log every change + notify watchers (shared with the sync path).
    before = snapshot(todo)
    for field, value in changes.items():
        setattr(todo, field, value)
    log_todo_changes(db, todo, before, user)

    touch(todo)
    db.commit()
    db.refresh(todo)
    return attach_to_todo(db, todo)


@router.delete("/{todo_id}")
def delete_todo(todo_id: str, db: DBSession = Depends(get_db), user=Depends(get_current_user)):
    todo = get_owned_todo(db, todo_id, user)
    if todo.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Only the owner can delete")
    todo.deleted = True
    touch(todo)
    # Cascade soft-delete to subtodos.
    for child in db.query(Todo).filter(Todo.parent_id == todo_id, Todo.deleted.is_(False)).all():
        child.deleted = True
        touch(child)
    db.commit()
    return {"ok": True}


# --- Timeline / comments ---


@router.get("/{todo_id}/events", response_model=list[EventOut])
def list_events(todo_id: str, db: DBSession = Depends(get_db), user=Depends(get_current_user)):
    get_owned_todo(db, todo_id, user)
    events = (
        db.query(Event)
        .filter(Event.todo_id == todo_id, Event.deleted.is_(False))
        .order_by(Event.created_at)
        .all()
    )
    attach_to_events(db, events)
    return events


@router.post("/{todo_id}/comments", response_model=EventOut, status_code=201)
def add_comment(
    todo_id: str, payload: CommentCreate, db: DBSession = Depends(get_db), user=Depends(get_current_user)
):
    todo = get_owned_todo(db, todo_id, user)
    event = record_event(
        db,
        todo,
        EventType.comment,
        body=payload.body,
        actor_email=user.email,
        event_id=payload.id or None,
    )
    touch(todo)
    notify_watchers(db, todo, f"{display_name(user)} commented.", exclude_email=user.email)
    db.commit()
    db.refresh(event)
    return attach_to_event(db, event)


# --- Watchers ---


@router.get("/{todo_id}/watchers", response_model=list[WatcherOut])
def list_watchers(todo_id: str, db: DBSession = Depends(get_db), user=Depends(get_current_user)):
    get_owned_todo(db, todo_id, user)
    return db.query(Watcher).filter(Watcher.todo_id == todo_id).all()


@router.post("/{todo_id}/watchers", response_model=WatcherOut, status_code=201)
def add_watcher(
    todo_id: str, payload: WatcherCreate, db: DBSession = Depends(get_db), user=Depends(get_current_user)
):
    todo = get_owned_todo(db, todo_id, user)
    watcher = add_watcher_svc(db, todo, payload.email, actor=user)
    if watcher is None:
        raise HTTPException(status_code=409, detail="Already a watcher")
    touch(todo)
    db.commit()
    db.refresh(watcher)
    return watcher


@router.delete("/{todo_id}/watchers/{watcher_id}")
def remove_watcher(
    todo_id: str, watcher_id: str, db: DBSession = Depends(get_db), user=Depends(get_current_user)
):
    todo = get_owned_todo(db, todo_id, user)
    watcher = db.get(Watcher, watcher_id)
    if watcher is None or watcher.todo_id != todo_id:
        raise HTTPException(status_code=404, detail="Watcher not found")
    db.delete(watcher)
    touch(todo)  # bump updated_at so the change is picked up by the next sync pull
    db.commit()
    return {"ok": True}


# --- Scheduled status changes ---


@router.get("/{todo_id}/schedules", response_model=list[ScheduleOut])
def list_schedules(todo_id: str, db: DBSession = Depends(get_db), user=Depends(get_current_user)):
    get_owned_todo(db, todo_id, user)
    return (
        db.query(ScheduledStatusChange)
        .filter(ScheduledStatusChange.todo_id == todo_id, ScheduledStatusChange.applied.is_(False))
        .order_by(ScheduledStatusChange.scheduled_for)
        .all()
    )


@router.post("/{todo_id}/schedules", response_model=ScheduleOut, status_code=201)
def create_schedule(
    todo_id: str, payload: ScheduleCreate, db: DBSession = Depends(get_db), user=Depends(get_current_user)
):
    todo = get_owned_todo(db, todo_id, user)
    valid_status(db, user.id, payload.status)
    # Fire at the start of the chosen day in the user's timezone, stored as naive UTC.
    run_at = start_of_day_utc(payload.date, user.timezone)

    sched = ScheduledStatusChange(
        id=new_id(),
        todo_id=todo_id,
        target_status=payload.status,
        local_date=payload.date.isoformat(),
        scheduled_for=run_at,
    )
    db.add(sched)
    record_event(
        db, todo, EventType.scheduled,
        body=f"Scheduled status → {status_label(db, user.id, payload.status)} on {payload.date.isoformat()}",
        actor_email=user.email,
    )
    move_now_to_backlog_for_schedule(db, todo, user)
    touch(todo)
    db.commit()
    db.refresh(sched)
    return sched


@router.delete("/{todo_id}/schedules/{schedule_id}")
def cancel_schedule(
    todo_id: str, schedule_id: str, db: DBSession = Depends(get_db), user=Depends(get_current_user)
):
    todo = get_owned_todo(db, todo_id, user)
    sched = db.get(ScheduledStatusChange, schedule_id)
    if sched is None or sched.todo_id != todo_id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    db.delete(sched)
    touch(todo)  # bump updated_at so the cleared schedule syncs to the task list
    db.commit()
    return {"ok": True}
