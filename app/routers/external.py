"""External create-task API.

A single token-authenticated endpoint so other tools (cron, shortcuts, curl) can
drop a task into a user's account without a session cookie. The token (see the
"API" page in the app) is passed as the ``token`` query parameter and identifies
the owner; the created task syncs to the user's devices on the next pull.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session as DBSession

from ..database import get_db
from ..models import STATUS_LABELS, Bucket, CustomStatus, EventType, Todo
from ..schemas import ApiOptionsOut, ApiStatusOut, ApiTaskCreate, TodoOut
from ..security import get_user_by_api_token, new_id
from ..services import attach_to_todo, record_event, valid_status

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
        for cs in db.query(CustomStatus)
        .filter(CustomStatus.owner_id == user.id)
        .order_by(CustomStatus.position, CustomStatus.created_at)
        .all()
    ]

    buckets = _open_buckets(db, user.id)
    return ApiOptionsOut(
        statuses=statuses,
        buckets=buckets,
        default_bucket_id=buckets[0].id if buckets else None,
    )


@router.post("/create", response_model=TodoOut, status_code=201)
def api_create_todo(
    payload: ApiTaskCreate,
    token: str = Query(..., description="Your API token (see the API page in the app)"),
    db: DBSession = Depends(get_db),
):
    user = _authenticate(db, token)

    valid_status(db, user.id, payload.status)

    # Pick the target bucket: the one supplied (must be the caller's), else their
    # first non-archived bucket.
    if payload.bucket_id:
        bucket = db.get(Bucket, payload.bucket_id)
        if bucket is None or bucket.deleted or bucket.owner_id != user.id:
            raise HTTPException(status_code=404, detail="Bucket not found")
    else:
        buckets = _open_buckets(db, user.id)
        bucket = buckets[0] if buckets else None
        if bucket is None:
            raise HTTPException(status_code=400, detail="No bucket to add the task to")

    todo = Todo(
        id=new_id(),
        bucket_id=bucket.id,
        owner_id=user.id,
        title=payload.title,
        text=payload.text or "",
        status=payload.status,
        position=0,
        public_token=new_id().replace("-", ""),
    )
    db.add(todo)
    record_event(db, todo, EventType.created, body="Created task (API)", actor_email=user.email)
    db.commit()
    db.refresh(todo)
    return attach_to_todo(db, todo)
