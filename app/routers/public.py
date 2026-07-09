from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DBSession

from ..config import get_settings
from ..database import get_db
from ..emailer import send_access_link
from ..models import Attachment, Event, EventType, Todo
from ..schemas import AttachmentOut, EventOut, RequestAccess, TodoOut
from ..security import create_login_token, enforce_login_rate, get_current_user, new_id
from ..services import (
    attach_to_event,
    attach_to_events,
    attach_to_todo,
    attach_to_todos,
    ensure_watcher,
    get_public_todo,
    import_shared_todo,
    notify_watchers,
    record_event,
    store_upload,
    touch,
)

router = APIRouter(prefix="/api/public", tags=["public"])
settings = get_settings()


class PublicTodoView(BaseModel):
    todo: TodoOut
    subtodos: list[TodoOut]
    timeline: list[EventOut]


class PublicComment(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1)


@router.get("/{token}", response_model=PublicTodoView)
def public_todo(token: str, db: DBSession = Depends(get_db)):
    todo = get_public_todo(db, token)

    attach_to_todo(db, todo)
    todo.watchers = []  # do not leak watcher emails on a public page

    subtodos = (
        db.query(Todo)
        .filter(Todo.parent_id == todo.id, Todo.deleted.is_(False))
        .order_by(Todo.position, Todo.created_at)
        .all()
    )
    attach_to_todos(db, subtodos)
    for st in subtodos:
        st.watchers = []

    timeline = (
        db.query(Event)
        .filter(Event.todo_id == todo.id, Event.deleted.is_(False))
        .order_by(Event.created_at)
        .all()
    )
    attach_to_events(db, timeline)

    return PublicTodoView(todo=todo, subtodos=subtodos, timeline=timeline)


@router.post("/{token}/comments", response_model=EventOut, status_code=201)
def public_comment(token: str, payload: PublicComment, db: DBSession = Depends(get_db)):
    """Let anyone with the share link comment, identified by a name (no sign-in)."""
    todo = get_public_todo(db, token)

    # Mark guest commenters distinctly from authenticated users.
    display = f"{payload.name.strip()} (guest)"
    event = record_event(db, todo, EventType.comment, body=payload.body, actor_email=display)
    touch(todo)
    notify_watchers(db, todo, f"{display} commented via the public link.")
    db.commit()
    db.refresh(event)
    return attach_to_event(db, event)


@router.post("/{token}/request-access")
def request_access(token: str, payload: RequestAccess, db: DBSession = Depends(get_db)) -> dict:
    """A visitor on a shared task wants to view it in the app.

    We record them as a watcher (so the task shows up under "Watching" once they
    sign in) and email them a one-time magic link scoped to the task.
    """
    todo = get_public_todo(db, token)

    # Shares the per-email code-issuance budget with /api/auth/login: this path also
    # emails a sign-in link to an arbitrary address, so it is the same email-bomb vector.
    enforce_login_rate(db, payload.email)

    ensure_watcher(db, todo, payload.email)
    db.commit()

    link_token = create_login_token(db, payload.email, redirect_todo_id=todo.id)
    link = f"{settings.base_url}/api/auth/callback?token={link_token}"
    send_access_link(payload.email, todo.title, link)
    return {"ok": True, "message": "Check your email for a link to open this task."}


@router.post("/{token}/import", response_model=TodoOut, status_code=201)
def import_task(
    token: str, db: DBSession = Depends(get_db), user=Depends(get_current_user)
) -> Todo:
    """Copy a shared task into the signed-in user's own account (an independent todo)."""
    src = get_public_todo(db, token)

    todo = import_shared_todo(db, src, user)
    db.commit()
    db.refresh(todo)
    return attach_to_todo(db, todo)


@router.post("/{token}/attachments", response_model=AttachmentOut, status_code=201)
async def public_attach(
    token: str,
    owner_type: str = Query("todo"),  # 'todo' or 'event'
    owner_id: str | None = Query(default=None),
    file: UploadFile = File(...),
    db: DBSession = Depends(get_db),
):
    """Let anyone with the share link attach a file to the task or one of its comments."""
    todo = get_public_todo(db, token)

    if owner_type == "todo":
        target_id = todo.id
    elif owner_type == "event":
        event = db.get(Event, owner_id)
        if event is None or event.todo_id != todo.id:
            raise HTTPException(status_code=404, detail="Comment not found")
        target_id = event.id
    else:
        raise HTTPException(status_code=422, detail="owner_type must be 'todo' or 'event'")

    data = await file.read()
    stored_name = store_upload(file.filename, data)

    attachment = Attachment(
        id=new_id(), owner_type=owner_type, owner_id=target_id,
        filename=file.filename or stored_name, stored_name=stored_name,
        content_type=file.content_type, size=len(data),
    )
    db.add(attachment)
    if owner_type == "todo":
        record_event(db, todo, EventType.file_added, body=f"Attached {attachment.filename}")
        touch(todo)
    notify_watchers(db, todo, "A file was attached via the public link.")
    db.commit()
    db.refresh(attachment)
    return attachment
