from html import escape
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Form, HTTPException, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session as DBSession

from ..config import get_settings
from ..database import get_db
from ..emailer import send_login_link
from ..pages import html_page
from ..schemas import LoginRequest, ProfileUpdate, UserOut, VerifyCodeRequest
from ..services import get_owned_bucket, valid_status
from ..security import (
    SESSION_COOKIE,
    consume_login_code,
    consume_login_token,
    create_login_code,
    create_login_token,
    create_session,
    enforce_login_rate,
    enforce_verify_rate,
    get_current_user,
    new_api_token,
    peek_login_token,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])
settings = get_settings()


def _set_session_cookie(response: Response, session_token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        session_token,
        max_age=settings.session_ttl_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.base_url.startswith("https"),
    )


@router.post("/login")
def request_login(payload: LoginRequest, db: DBSession = Depends(get_db)) -> dict:
    """Email a magic sign-in link and a short sign-in code for the same account.

    Two ways in, because the link alone isn't always enough. The desktop (Electron)
    app sends ``client="desktop"`` so the link is a ``meerato://`` deep link that
    completes sign-in inside the app window rather than the user's web browser (where
    the session cookie would otherwise land) — but that hands off through the OS, and
    on Linux nothing may have claimed the scheme. The code, typed into the window the
    user already has open, always works. See ``verify_login_code``.
    """
    enforce_login_rate(db, payload.email)
    token = create_login_token(db, payload.email)
    code = create_login_code(db, payload.email)
    if payload.client == "desktop":
        link = f"meerato://login?token={token}"
    else:
        link = f"{settings.base_url}/api/auth/callback?token={token}"
    send_login_link(payload.email, link, code)
    return {"ok": True, "message": "Check your email for a sign-in link and code."}


@router.post("/verify-code")
def verify_login_code(
    payload: VerifyCodeRequest, response: Response, db: DBSession = Depends(get_db)
) -> dict:
    """Consume an emailed sign-in code and establish a session cookie.

    The link's equivalent (``login_callback``) redirects; this returns the target so
    the sign-in page can navigate itself, keeping the whole exchange same-origin fetch.
    """
    enforce_verify_rate(db, payload.email)
    user = consume_login_code(db, payload.email, payload.code)
    _set_session_cookie(response, create_session(db, user))
    return {"ok": True, "redirect": "/"}


def _link_expired_page() -> HTMLResponse:
    return html_page(
        "Link expired",
        "<h1>This sign-in link no longer works</h1>"
        "<p>It has expired or was already used. "
        '<a href="/">Request a new one</a> to sign in.</p>',
        status_code=400,
    )


@router.get("/callback", response_class=HTMLResponse)
def login_callback_confirm(token: str, db: DBSession = Depends(get_db)) -> HTMLResponse:
    """Landing page of the emailed magic link. It only asks for a click.

    Links are single use, and mail clients or link scanners often fetch them before
    the user does. So the GET leaves the token alone and the button POSTs it to
    ``login_callback``, which spends it.
    """
    lt = peek_login_token(db, token)
    if lt is None:
        return _link_expired_page()
    resp = html_page(
        "Sign in",
        f"""
        <h1>Sign in to meerato</h1>
        <p>Continue as <span class="task">{escape(lt.email)}</span>.</p>
        <form method="post" action="/api/auth/callback">
          <input type="hidden" name="token" value="{escape(lt.token)}" />
          <button type="submit" autofocus>Sign in</button>
        </form>
        """,
    )
    # The page carries a live token, keep it out of caches.
    resp.headers["Cache-Control"] = "no-store"
    return resp


@router.post("/callback")
def login_callback(token: str = Form(...), db: DBSession = Depends(get_db)) -> Response:
    """Consume a magic link, establish a session cookie, and redirect into the app."""
    try:
        user, redirect_todo_id = consume_login_token(db, token)
    except HTTPException:
        return _link_expired_page()
    session_token = create_session(db, user)

    target = "/"
    if redirect_todo_id:
        target = f"/?todo={redirect_todo_id}"
    resp = RedirectResponse(url=target, status_code=303)
    _set_session_cookie(resp, session_token)
    return resp


@router.get("/me", response_model=UserOut)
def me(user=Depends(get_current_user)) -> UserOut:
    return user


@router.patch("/me", response_model=UserOut)
def update_me(
    payload: ProfileUpdate, db: DBSession = Depends(get_db), user=Depends(get_current_user)
) -> UserOut:
    data = payload.model_dump(exclude_unset=True)
    if "timezone" in data:
        try:
            ZoneInfo(data["timezone"])
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(status_code=422, detail="Unknown timezone")
        user.timezone = data["timezone"]
    if "name" in data:
        user.name = (data["name"] or "").strip() or None
    # New-task defaults. Validated on the way in so a bad id can never be stored,
    # but the read side (external._default_bucket) still falls back rather than
    # erroring, since a bucket can be archived or deleted after being chosen here.
    if "default_bucket_id" in data:
        bucket_id = data["default_bucket_id"] or None
        if bucket_id is not None:
            get_owned_bucket(db, bucket_id, user)
        user.default_bucket_id = bucket_id
    if "default_status" in data:
        status = (data["default_status"] or "").strip() or None
        if status is not None:
            valid_status(db, user.id, status)
        user.default_status = status
    db.commit()
    db.refresh(user)
    return user


@router.post("/api-token", response_model=UserOut)
def ensure_api_token(
    db: DBSession = Depends(get_db), user=Depends(get_current_user)
) -> UserOut:
    """Create the user's external-API token if they don't have one yet."""
    if not user.api_token:
        user.api_token = new_api_token()
        db.commit()
        db.refresh(user)
    return user


@router.post("/api-token/rotate", response_model=UserOut)
def rotate_api_token(
    db: DBSession = Depends(get_db), user=Depends(get_current_user)
) -> UserOut:
    """Replace the API token (invalidates the old one)."""
    user.api_token = new_api_token()
    db.commit()
    db.refresh(user)
    return user


@router.post("/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}
