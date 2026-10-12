"""One-click email unsubscribe for task watchers.

A watcher's invite/update emails carry a link to ``/unsubscribe/{token}`` where the
token is the watcher's unguessable ``unsubscribe_token``. The GET shows a small
confirmation page (so an email client prefetching the link can't unsubscribe the
recipient by accident); the POST actually stops the watch.
"""

from html import escape

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session as DBSession

from ..database import get_db
from ..models import Watcher
from ..pages import html_page

router = APIRouter(tags=["unsubscribe"])


@router.get("/unsubscribe/{token}", response_class=HTMLResponse)
def unsubscribe_confirm(token: str, db: DBSession = Depends(get_db)) -> HTMLResponse:
    watcher = db.query(Watcher).filter(Watcher.unsubscribe_token == token).one_or_none()
    if watcher is None:
        return html_page(
            "Already unsubscribed",
            "<h1>You're all set</h1><p>You're no longer receiving updates for this task.</p>",
        )
    # The title is written by the task owner and the page runs on the app's origin,
    # so it must be escaped or the owner could run script in the watcher's session.
    title = escape(watcher.todo.title) if watcher.todo else "this task"
    return html_page(
        "Unsubscribe",
        f"""
        <h1>Stop watching this task?</h1>
        <p>You'll no longer get any email updates about
           <span class="task">"{title}"</span>.</p>
        <form method="post" action="/unsubscribe/{escape(watcher.unsubscribe_token)}">
          <button type="submit">Unsubscribe me</button>
        </form>
        """,
    )


@router.post("/unsubscribe/{token}", response_class=HTMLResponse)
def unsubscribe(token: str, db: DBSession = Depends(get_db)) -> HTMLResponse:
    watcher = db.query(Watcher).filter(Watcher.unsubscribe_token == token).one_or_none()
    if watcher is not None:
        db.delete(watcher)
        db.commit()
    return html_page(
        "Unsubscribed",
        "<h1>You've been unsubscribed</h1>"
        "<p>You won't receive any more email updates about this task. "
        "You can close this tab.</p>",
    )
