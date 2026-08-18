from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


# --- Auth ---


class LoginRequest(BaseModel):
    email: EmailStr
    # "desktop" when the request comes from the Electron app, so the magic link
    # is emailed as a meerato:// deep link that signs in inside the app.
    client: str | None = None


class MagicLinkConsume(BaseModel):
    token: str


class VerifyCodeRequest(BaseModel):
    """Sign in with the code from the email rather than by clicking the link."""

    email: EmailStr
    # Six characters, but the bound is loose so pasted spacing/dashes reach the
    # normalizer in security._normalize_login_code instead of tripping validation.
    code: str = Field(min_length=6, max_length=16)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    email: str
    name: str | None = None
    timezone: str = "UTC"
    api_token: str | None = None
    # New-task defaults (Settings). Null = no preference set.
    default_bucket_id: str | None = None
    default_status: str | None = None


class ProfileUpdate(BaseModel):
    name: str | None = None
    timezone: str | None = None
    # Explicit null clears the preference; omitting the field leaves it alone
    # (update_me works off exclude_unset, so the two are distinguishable).
    default_bucket_id: str | None = None
    default_status: str | None = None


# --- Scheduled status changes ---


class ScheduleCreate(BaseModel):
    date: date
    status: str = "on_list"  # "To be done" by default


class ScheduleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    todo_id: str
    target_status: str
    local_date: str
    scheduled_for: datetime
    applied: bool


# --- Custom statuses ---


class CustomStatusBase(BaseModel):
    label: str = Field(min_length=1, max_length=60)
    color: str = "grey"
    icon: str = "circle"
    position: int = 0


class CustomStatusCreate(CustomStatusBase):
    pass


class CustomStatusUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=60)
    color: str | None = None
    icon: str | None = None
    position: int | None = None


class CustomStatusOut(CustomStatusBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    value: str


# --- External create-task API ---


class ApiTaskCreate(BaseModel):
    """Body for the token-authenticated POST /api/create endpoint."""

    title: str = Field(min_length=1)
    text: str = ""
    # Both fall back to the owner's "New task defaults" (Settings) when omitted —
    # GET /api/create reports what those currently resolve to.
    bucket_id: str | None = None
    status: str | None = None
    # Watchers to add, on top of any parsed out of the title with "@".
    watchers: list[EmailStr] = Field(default_factory=list)
    # Schedule a status change instead of (or as well as) setting one now. Takes
    # precedence over a date phrase parsed out of the title.
    schedule: ScheduleCreate | None = None
    # Interpret the quick-add shorthand (#bucket, @watcher, !status, trailing date
    # phrase) in `title`. Set false to take the title verbatim.
    parse: bool = True


class ApiScheduleCreate(BaseModel):
    """Body for the token-authenticated POST /api/schedule endpoint."""

    todo_id: str
    date: date
    status: str = "on_list"  # "Now" by default


class ApiParsedOut(BaseModel):
    """What POST /api/create made of the title, so a caller can confirm it."""

    title: str
    bucket_name: str | None = None
    status: str | None = None
    scheduled_date: date | None = None
    scheduled_status: str | None = None
    watchers: list[str] = Field(default_factory=list)


# ApiTaskOut is defined with TodoOut below, which it extends.


# --- Recurring tasks (Automation) ---


class RecurringTaskBase(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    text: str = ""
    status: str = "open"
    bucket_id: str
    watcher_email: EmailStr | None = None
    frequency: str  # daily | weekly | monthly | yearly
    day_of_week: int | None = Field(default=None, ge=0, le=6)    # weekly: 0=Mon..6=Sun
    day_of_month: int | None = Field(default=None, ge=1, le=31)  # monthly/yearly
    month_of_year: int | None = Field(default=None, ge=1, le=12)  # yearly
    active: bool = True


class RecurringTaskCreate(RecurringTaskBase):
    pass


class RecurringTaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    text: str | None = None
    status: str | None = None
    bucket_id: str | None = None
    watcher_email: EmailStr | None = None
    frequency: str | None = None
    day_of_week: int | None = Field(default=None, ge=0, le=6)
    day_of_month: int | None = Field(default=None, ge=1, le=31)
    month_of_year: int | None = Field(default=None, ge=1, le=12)
    active: bool | None = None


class RecurringTaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    title: str
    text: str
    status: str
    bucket_id: str
    watcher_email: str | None = None
    frequency: str
    day_of_week: int | None = None
    day_of_month: int | None = None
    month_of_year: int | None = None
    active: bool
    next_run: datetime
    last_run: datetime | None = None
    created_at: datetime


# --- Attachments ---


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    filename: str
    content_type: str | None = None
    size: int
    created_at: datetime


# --- Buckets ---


class BucketBase(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    color: str | None = None
    position: int = 0


class BucketCreate(BucketBase):
    id: str | None = None  # client may supply a UUID (offline creation)


class BucketUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    color: str | None = None
    position: int | None = None


class BucketOut(BucketBase):
    model_config = ConfigDict(from_attributes=True)
    id: str
    archived: bool = False
    deleted: bool
    created_at: datetime
    updated_at: datetime


# --- External create-task API: options ---
# (declared here rather than next to ApiTaskCreate because it embeds BucketOut)


class ApiStatusOut(BaseModel):
    """A status the external API will accept, built-in or user-defined."""

    value: str
    label: str
    builtin: bool


class ApiOptionsOut(BaseModel):
    """Answer to GET /api/create: the values a POST to it may use."""

    statuses: list[ApiStatusOut]
    buckets: list[BucketOut]
    # Where a POST that omits these lands — the caller's "New task defaults".
    default_bucket_id: str | None = None
    default_status: str = "open"


# --- Events / comments ---


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    todo_id: str
    type: str
    body: str
    meta: str | None = None
    actor_email: str | None = None
    deleted: bool
    created_at: datetime
    updated_at: datetime
    attachments: list[AttachmentOut] = []


class CommentCreate(BaseModel):
    id: str | None = None
    body: str = Field(min_length=1)


# --- Watchers ---


class WatcherOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    email: str
    created_at: datetime


class WatcherCreate(BaseModel):
    email: EmailStr


# --- Watching (tasks shared with me, linked by my email) ---


class RequestAccess(BaseModel):
    """A visitor on a shared task asking to view it in the app (sends a magic link)."""

    email: EmailStr


class WatchedTaskOut(BaseModel):
    """A task the current user watches (owned by someone else), for the Watching page."""

    id: str
    title: str
    status: str
    public_token: str
    bucket_name: str
    owner_name: str
    updated_at: datetime


# --- Todos ---


class TodoBase(BaseModel):
    title: str = Field(min_length=1)
    text: str = ""
    status: str = "open"
    position: int = 0
    bucket_id: str
    parent_id: str | None = None


class TodoCreate(TodoBase):
    id: str | None = None
    watcher_email: EmailStr | None = None  # optional watcher set at creation


class TodoUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    text: str | None = None
    status: str | None = None
    position: int | None = None
    bucket_id: str | None = None
    parent_id: str | None = None


class TodoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    bucket_id: str
    parent_id: str | None = None
    title: str
    text: str
    status: str
    position: int
    public_token: str
    deleted: bool
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
    attachments: list[AttachmentOut] = []
    watchers: list[WatcherOut] = []
    # True when the todo has a pending (unapplied) scheduled status change. Set by
    # attach_to_todos on sync pull so the task list can show a calendar indicator.
    has_schedule: bool = False


class ApiTaskOut(TodoOut):
    """POST /api/create's answer. The task's own fields stay at the top level (so
    callers written against the old TodoOut response keep working); ``parsed``
    reports what the quick-add shorthand in the title resolved to."""

    parsed: ApiParsedOut


class ApiTodoOut(TodoOut):
    """One task in GET /api/tasks. Carries the bucket's name alongside its id so
    a script can read the list without a second call to resolve buckets."""

    bucket_name: str | None = None


# --- Sync ---


class SyncMutation(BaseModel):
    """A single offline mutation queued by the client."""

    op_id: str                       # client-unique id for idempotency
    entity: str                      # 'bucket' | 'todo' | 'comment'
    action: str                      # 'create' | 'update' | 'delete'
    id: str                          # entity id (client-generated UUID)
    updated_at: datetime             # client timestamp of the change
    data: dict = {}                  # field payload


class SyncPushRequest(BaseModel):
    mutations: list[SyncMutation] = []


class SyncResult(BaseModel):
    op_id: str
    status: str          # 'applied' | 'skipped' | 'error'
    detail: str | None = None


class SyncPushResponse(BaseModel):
    results: list[SyncResult]
    server_time: datetime


class SyncPullResponse(BaseModel):
    server_time: datetime
    buckets: list[BucketOut]
    todos: list[TodoOut]
    events: list[EventOut]
