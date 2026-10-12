"""Authentication: email magic links + opaque session tokens stored in a cookie."""

import hashlib
import hmac
import secrets
import uuid
from datetime import timedelta

from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DBSession

from .config import get_settings
from .database import get_db
from .models import Bucket, LoginCode, LoginToken, RateLimit, Session, User, utcnow

DEFAULT_BUCKETS = ("Work", "Private")

settings = get_settings()
SESSION_COOKIE = "todo_session"

# Digits and letters, minus the pairs that get confused when a code is read off one
# screen and typed into another: 0/O, 1/I/L. 31**6 ≈ 887 million combinations.
LOGIN_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
LOGIN_CODE_LENGTH = 6


def new_id() -> str:
    return str(uuid.uuid4())


def new_token() -> str:
    return secrets.token_urlsafe(32)


def new_api_token() -> str:
    """Secret for the external create-task API. URL-safe, ~32 chars (fits VARCHAR(64))."""
    return secrets.token_urlsafe(24)


def get_user_by_api_token(db: DBSession, token: str | None) -> User | None:
    if not token:
        return None
    return db.query(User).filter(User.api_token == token).one_or_none()


def get_or_create_user(db: DBSession, email: str) -> User:
    email = email.strip().lower()
    user = db.query(User).filter(User.email == email).one_or_none()
    if user is None:
        user = User(id=new_id(), email=email)
        db.add(user)
        db.flush()
        # Seed a brand-new account with its default buckets.
        for position, name in enumerate(DEFAULT_BUCKETS):
            db.add(Bucket(id=new_id(), owner_id=user.id, name=name, position=position))
        db.flush()
    return user


def create_login_token(db: DBSession, email: str, redirect_todo_id: str | None = None) -> str:
    token = new_token()
    db.add(
        LoginToken(
            token=token,
            email=email.strip().lower(),
            expires_at=utcnow() + timedelta(minutes=settings.login_token_ttl_minutes),
            redirect_todo_id=redirect_todo_id,
        )
    )
    db.commit()
    return token


def peek_login_token(db: DBSession, token: str) -> LoginToken | None:
    """Return the magic-link token if it can still sign in, without spending it.

    Opening the link only shows a confirmation page built from this. Mail clients and
    link scanners fetch links before the user does, so a GET must never burn it.
    """
    lt = db.query(LoginToken).filter(LoginToken.token == token).one_or_none()
    if lt is None or lt.used or lt.expires_at < utcnow():
        return None
    return lt


def consume_login_token(db: DBSession, token: str) -> tuple[User, str | None]:
    """Spend a magic-link token and return its user and the todo to open, if any.

    Single use, so a link that leaks (forwarded mail, browser history, proxy logs)
    cannot sign anyone in after the owner has used it. The row is locked for the
    check-and-mark so two concurrent submits cannot both get a session.
    """
    lt = db.query(LoginToken).filter(LoginToken.token == token).with_for_update().one_or_none()
    if lt is None or lt.used or lt.expires_at < utcnow():
        raise HTTPException(status_code=400, detail="Invalid or expired login link")
    lt.used = True
    user = get_or_create_user(db, lt.email)
    db.commit()
    return user, lt.redirect_todo_id


def _normalize_login_code(code: str) -> str:
    """Uppercase and strip the spaces/dashes people add when copying a code by hand."""
    return "".join(ch for ch in code.upper() if ch.isalnum())


def _hash_login_code(code: str) -> str:
    return hmac.new(
        settings.secret_key.encode(), _normalize_login_code(code).encode(), hashlib.sha256
    ).hexdigest()


def create_login_code(db: DBSession, email: str) -> str:
    """Issue a sign-in code, replacing any code previously issued to this email."""
    email = email.strip().lower()
    code = "".join(secrets.choice(LOGIN_CODE_ALPHABET) for _ in range(LOGIN_CODE_LENGTH))
    db.merge(
        LoginCode(
            email=email,
            code_hash=_hash_login_code(code),
            expires_at=utcnow() + timedelta(minutes=settings.login_token_ttl_minutes),
            attempts=0,
        )
    )
    db.commit()
    return code


def consume_login_code(db: DBSession, email: str, code: str) -> User:
    """Validate a sign-in code and burn it. Raises 400 on anything but a clean hit.

    Unlike the magic link, the code is single-use: it is short enough that guessing is
    worth attempting, so every path out of here that isn't success either counts
    against the attempt budget or destroys the row.
    """
    email = email.strip().lower()
    invalid = HTTPException(status_code=400, detail="Invalid or expired code")

    # SELECT ... FOR UPDATE. The attempt counter below is the only thing standing
    # between a 6-character code and a brute-force, so the read-check-increment has to
    # be atomic: without this lock, N guesses arriving at once all read the same
    # `attempts` and all write back the same +1, and the cap never advances (verified
    # to leak ~all of N under load on Postgres). Locking the row serializes concurrent
    # guesses so each one truly costs one attempt. SQLite ignores FOR UPDATE but
    # serializes writers with its database-level lock, so it is safe there too.
    row = db.query(LoginCode).filter(LoginCode.email == email).with_for_update().one_or_none()
    if row is None:
        raise invalid

    if row.expires_at < utcnow():
        db.delete(row)
        db.commit()
        raise invalid

    if not hmac.compare_digest(row.code_hash, _hash_login_code(code)):
        row.attempts += 1
        spent = row.attempts >= settings.login_code_max_attempts
        if spent:
            db.delete(row)
        db.commit()
        if spent:
            raise HTTPException(
                status_code=400, detail="Too many incorrect codes. Request a new one."
            )
        raise invalid

    db.delete(row)
    user = get_or_create_user(db, email)
    db.commit()
    return user


def _rate_hit(db: DBSession, key: str, limit: int, window_seconds: int) -> bool:
    """Count one request against a fixed window. Returns True if it is within the limit.

    Locks the counter row for the read-increment (same reasoning as consume_login_code:
    an unlocked counter under-counts under load, which for a throttle means it lets
    bursts through). The only unlocked step is creating the row the first time a key is
    seen; two requests racing that both insert, one hits the unique-key violation and
    retries into the locked path.
    """
    now = utcnow()
    row = db.query(RateLimit).filter(RateLimit.key == key).with_for_update().one_or_none()

    if row is None:
        db.add(RateLimit(key=key, window_start=now, count=1))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return _rate_hit(db, key, limit, window_seconds)
        return 1 <= limit

    if (now - row.window_start).total_seconds() >= window_seconds:
        row.window_start = now
        row.count = 1
        db.commit()
        return 1 <= limit

    row.count += 1
    within = row.count <= limit
    db.commit()
    return within


def enforce_login_rate(db: DBSession, email: str) -> None:
    """Throttle sign-in code issuance for an email. Raises 429 when the window is spent."""
    key = "login:" + email.strip().lower()
    window = settings.login_rate_window_minutes * 60
    if not _rate_hit(db, key, settings.login_rate_max, window):
        raise HTTPException(
            status_code=429,
            detail="Too many sign-in requests for this email. Please wait a few minutes.",
        )


def enforce_verify_rate(db: DBSession, email: str) -> None:
    """Throttle sign-in code submissions for an email. Raises 429 when spent."""
    key = "verify:" + email.strip().lower()
    window = settings.login_rate_window_minutes * 60
    if not _rate_hit(db, key, settings.verify_rate_max, window):
        raise HTTPException(
            status_code=429,
            detail="Too many attempts. Please wait a few minutes and request a new code.",
        )


def create_session(db: DBSession, user: User) -> str:
    token = new_token()
    db.add(
        Session(
            token=token,
            user_id=user.id,
            expires_at=utcnow() + timedelta(minutes=settings.session_ttl_minutes),
        )
    )
    db.commit()
    return token


def get_current_user(
    db: DBSession = Depends(get_db),
    todo_session: str | None = Cookie(default=None),
) -> User:
    user = _user_from_session(db, todo_session)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
        )
    return user


def get_optional_user(
    db: DBSession = Depends(get_db),
    todo_session: str | None = Cookie(default=None),
) -> User | None:
    return _user_from_session(db, todo_session)


def _user_from_session(db: DBSession, token: str | None) -> User | None:
    if not token:
        return None
    sess = db.query(Session).filter(Session.token == token).one_or_none()
    if sess is None or sess.expires_at < utcnow():
        return None
    return db.get(User, sess.user_id)
