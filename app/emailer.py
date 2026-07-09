"""Email delivery.

If ``smtp_host`` is configured the message is sent via SMTP; otherwise it is printed
to the console so the app is fully usable in development without an email provider.
"""

import smtplib
import textwrap
from email.message import EmailMessage
from email.utils import formataddr

from .config import get_settings

settings = get_settings()

APP_NAME = "meerato"
SIGNATURE = f"—\n{APP_NAME} · https://meerato.com"


def _compose(subject: str, body: str) -> tuple[str, str]:
    """Brand the subject with the app name and append the meerato signature."""
    full_subject = f"{APP_NAME} · {subject}"
    full_body = f"{textwrap.dedent(body).strip()}\n\n{SIGNATURE}"
    return full_subject, full_body


def send_email(to: str, subject: str, body: str) -> None:
    subject, body = _compose(subject, body)

    if not settings.smtp_host:
        _print_to_console(to, subject, body)
        return

    msg = EmailMessage()
    msg["From"] = formataddr((APP_NAME, settings.email_from))
    msg["To"] = to
    msg["Subject"] = subject
    # Disable Brevo/Sendinblue (Mailin) open and click tracking on a per-email basis.
    msg["X-Mailin-Track"] = "false"
    msg["X-Mailin-Track-Clicks"] = "false"
    msg["X-Mailin-Track-Opens"] = "false"
    msg.set_content(body)

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as smtp:
            if settings.smtp_use_tls:
                smtp.starttls()
            if settings.smtp_user:
                smtp.login(settings.smtp_user, settings.smtp_password)
            smtp.send_message(msg)
    except Exception as exc:  # noqa: BLE001 - never let email failure break a request
        print(f"[emailer] SMTP send failed ({exc!r}); falling back to console:")
        _print_to_console(to, subject, body)


def _print_to_console(to: str, subject: str, body: str) -> None:
    banner = "=" * 70
    print(
        f"\n{banner}\n[EMAIL] From: {APP_NAME} <{settings.email_from}>\nTo: {to}\n"
        f"Subject: {subject}\n{'-' * 70}\n{body}\n{banner}\n",
        flush=True,
    )


def send_login_link(to: str, link: str, code: str) -> None:
    """Email both ways to sign in: the magic link, and the code to type in by hand.

    The code is the fallback for when the link can't do the job — most often the
    desktop app on Linux, where nothing has claimed the ``meerato://`` scheme.
    """
    send_email(
        to,
        "Your sign-in link",
        f"""
        Hi,

        Click the link below to sign in to {APP_NAME}:

        {link}

        Or enter this code on the sign-in screen:

            {code}

        Both expire in {settings.login_token_ttl_minutes} minutes.

        If you didn't request this, you can ignore this email.
        """,
    )


def send_watcher_invite(
    to: str,
    todo_title: str,
    task_link: str,
    adder_name: str,
    unsubscribe_link: str,
) -> None:
    send_email(
        to,
        f'{adder_name} added you as a watcher: "{todo_title}"',
        f"""
        Hi,

        {adder_name} added you as a watcher on the task "{todo_title}".

        What is {APP_NAME}? It's a shared to-do app that organizes tasks around
        the different parts of your life. Being a watcher means you'll get a short
        email whenever this task changes (a new status, a comment, or a file),
        so you stay in the loop without anyone having to chase you. You can also
        open the task to read its full history and add comments yourself, no
        account or password required:

        {task_link}

        Don't want to be kept in the loop? You can opt out of all updates for
        this task at any time, no sign-in needed:

        {unsubscribe_link}
        """,
    )


def send_access_link(to: str, todo_title: str, login_link: str) -> None:
    """A visitor asked to open a shared task in the app: email them a sign-in link.

    Signing in (or creating an account) lands them on the task, which is then kept
    in their "Watching" list so they can find it again.
    """
    send_email(
        to,
        f'Open "{todo_title}" in {APP_NAME}',
        f"""
        Hi,

        Here's your link to open the task "{todo_title}" in {APP_NAME}.

        {APP_NAME} is a shared to-do app that organizes tasks around the different
        parts of your life. Click below to sign in (or create your free account);
        the task will be waiting for you, and you'll find it any time under
        "Watching" in the sidebar:

        {login_link}

        This link expires in {settings.login_token_ttl_minutes} minutes and can
        only be used once. If you didn't request this, you can ignore this email.
        """,
    )


def send_watcher_update(
    to: str, todo_title: str, summary: str, link: str, unsubscribe_link: str | None = None
) -> None:
    # The owner has no watcher record (and so no unsubscribe token); they always
    # get task updates, so the opt-out paragraph is simply omitted for them.
    opt_out = (
        f"""

        Don't want these emails? Opt out of all updates for this task:
        {unsubscribe_link}"""
        if unsubscribe_link
        else ""
    )
    send_email(
        to,
        f'Update on: "{todo_title}"',
        f"""
        Hi,

        There's an update on the task "{todo_title}" in {APP_NAME}:

        {summary}

        View it here:
        {link}{opt_out}
        """,
    )
