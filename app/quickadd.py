"""Server-side quick-add parsing.

A Python port of the client's quick-add syntax (``app/static/js/app.quickadd.js``)
so that tasks submitted through the external API understand the same shorthand:

    #Bucket name        → file under an existing bucket
    @who@example.com    → add a watcher
    !status             → set the status (e.g. !now, !done, !backlog, !blocked)
    <date phrase> (end) → start in Backlog, schedule a move to "Now" on that date

Anything that doesn't resolve (bad email, unknown bucket, unknown status) is left
in the title, matching the client. Dates resolve against *the user's* local today
(their IANA timezone), not the server's, so "next week" means the same thing
whether it is typed into the box or POSTed from a script.
"""

import re
from dataclasses import dataclass, field
from datetime import date as date_cls, datetime, timedelta

from .models import STATUS_LABELS
from .timeutil import tz_or_utc

# Every spelling of a built-in status → its internal value. Mirrors the client's
# STATUS_ALIASES (app.core.js) merged with each status's display label.
STATUS_ALIASES = {
    "backlog": "open", "open": "open",
    "on_list": "on_list", "onlist": "on_list", "todo": "on_list", "now": "on_list",
    "blocked": "blocked", "done": "done",
}

WEEKDAY_NUM = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}
_WD = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday)"

# Roughly RFC-ish; deliberately the same shape the client validates with, so the
# two agree on which "@thing" counts as a watcher and which stays in the title.
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_WATCHER_RE = re.compile(r"@\s*([^\s@]+@[^\s@]+\.[^\s@]+)")
_STATUS_RE = re.compile(r"!([a-z_]+)", re.I)


def status_alias_map(custom_statuses=None) -> dict[str, str]:
    """Alias → status value, covering built-ins and the caller's custom statuses.

    Custom statuses are matched by their slug and by their lowercased label with
    spaces collapsed to underscores, so a "In Review" status answers to
    ``!in_review``.
    """
    out = dict(STATUS_ALIASES)
    for value, label in STATUS_LABELS.items():
        out[label.lower()] = value
    for cs in custom_statuses or []:
        out[cs.value.lower()] = cs.value
        out[(cs.label or "").lower().replace(" ", "_")] = cs.value
    out.pop("", None)
    return out


def _squash(s: str) -> str:
    return re.sub(r"\s{2,}", " ", s).strip()


# --- Date phrases ---------------------------------------------------------


def _next_weekday(today: date_cls, target: int) -> date_cls:
    """Next occurrence of weekday ``target`` (0=Mon..6=Sun), strictly future."""
    diff = (target - today.weekday() + 7) % 7 or 7
    return today + timedelta(days=diff)


def _add_months_clamped(today: date_cls, n: int) -> date_cls:
    """``today`` plus ``n`` months, clamping the day to the target month's length."""
    month_index = today.month - 1 + n
    year = today.year + month_index // 12
    month = month_index % 12 + 1
    # Day before the 1st of the following month = last day of the target month.
    last = (date_cls(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    return date_cls(year, month, min(today.day, last))


def _parse_iso(s: str) -> date_cls | None:
    try:
        return date_cls.fromisoformat(s)
    except ValueError:
        return None


def _date_tests(today: date_cls):
    """(regex, resolver) pairs, in priority order — mirrors matchTrailingDate."""
    return [
        (re.compile(r"\btomorrow\s*$", re.I), lambda m: today + timedelta(days=1)),
        # Weeks start on Monday, so "next week" is the coming Monday.
        (re.compile(r"\bnext week\s*$", re.I), lambda m: _next_weekday(today, 0)),
        (re.compile(r"\bnext month\s*$", re.I),
         lambda m: date_cls(today.year + (today.month == 12), today.month % 12 + 1, 1)),
        (re.compile(r"\bnext year\s*$", re.I), lambda m: date_cls(today.year + 1, 1, 1)),
        (re.compile(rf"\bnext {_WD}\s*$", re.I),
         lambda m: _next_weekday(today, WEEKDAY_NUM[m.group(1).lower()])),
        (re.compile(r"\bin (\d{1,3}) days?\s*$", re.I),
         lambda m: today + timedelta(days=int(m.group(1)))),
        (re.compile(r"\bin (\d{1,3}) weeks?\s*$", re.I),
         lambda m: today + timedelta(weeks=int(m.group(1)))),
        (re.compile(r"\bin (\d{1,2}) months?\s*$", re.I),
         lambda m: _add_months_clamped(today, int(m.group(1)))),
        (re.compile(r"\bon (\d{4}-\d{2}-\d{2})\s*$", re.I), lambda m: _parse_iso(m.group(1))),
        (re.compile(rf"\b(?:on |this )?{_WD}\s*$", re.I),
         lambda m: _next_weekday(today, WEEKDAY_NUM[m.group(1).lower()])),
    ]


def match_trailing_date(s: str, today: date_cls) -> tuple[int, date_cls] | None:
    """If ``s`` ends with a recognized date phrase, return (start_index, date)."""
    for regex, resolve in _date_tests(today):
        m = regex.search(s)
        if m:
            resolved = resolve(m)
            if resolved is not None:
                return m.start(), resolved
    return None


# --- Token extraction -----------------------------------------------------


def extract_bucket(s: str, buckets) -> tuple[str, str, str] | None:
    """Find a ``#bucketname`` matching an existing bucket → (id, name, remainder).

    Longest name wins so "#Side project" beats a "#Side" bucket, and the name must
    be followed by whitespace or end-of-string so "#Sidewalk" doesn't match "Side".
    """
    names = sorted(buckets, key=lambda b: len(b.name or ""), reverse=True)
    for m in re.finditer(r"#", s):
        after = s[m.start() + 1:]
        lower = after.lower()
        for b in names:
            nm = (b.name or "").lower()
            if nm and lower.startswith(nm):
                end_ch = after[len(b.name):len(b.name) + 1]
                if end_ch == "" or end_ch.isspace():
                    return b.id, b.name, _squash(s[: m.start()] + after[len(b.name):])
    return None


def extract_status(s: str, alias_map: dict[str, str]) -> tuple[str, str] | None:
    """Find a ``!status`` token that resolves → (status value, remainder)."""
    for m in _STATUS_RE.finditer(s):
        value = alias_map.get(m.group(1).lower())
        if value:
            return value, _squash(s[: m.start()] + s[m.end():])
    return None


def extract_watchers(s: str) -> tuple[list[str], str]:
    """Pull every ``@email`` out of ``s`` → (emails, remainder)."""
    watchers: list[str] = []

    def repl(m: re.Match) -> str:
        email = m.group(1)
        if _EMAIL_RE.match(email):
            watchers.append(email.lower())
            return " "
        return m.group(0)  # invalid → leave it in the title

    return watchers, _WATCHER_RE.sub(repl, s)


# --- Top level ------------------------------------------------------------


@dataclass
class ParsedTask:
    title: str
    bucket_id: str | None = None
    bucket_name: str | None = None
    status: str | None = None
    schedule_date: date_cls | None = None
    watchers: list[str] = field(default_factory=list)


def local_today(tz_name: str | None) -> date_cls:
    """Today's calendar date in ``tz_name`` — the anchor for relative phrases."""
    return datetime.now(tz_or_utc(tz_name)).date()


def parse_quick_add(raw: str, buckets, alias_map: dict[str, str], today: date_cls) -> ParsedTask:
    """Parse quick-add shorthand out of ``raw``, in the client's four-pass order.

    If the modifiers consume the whole string the raw text is kept as the title,
    so "#Work next week" still produces a task you can find.
    """
    s = (raw or "").strip()

    watchers, s = extract_watchers(s)

    bucket_id = bucket_name = None
    bx = extract_bucket(s, buckets)
    if bx:
        bucket_id, bucket_name, s = bx

    status = None
    sx = extract_status(s, alias_map)
    if sx:
        status, s = sx

    schedule_date = None
    dm = match_trailing_date(s, today)
    if dm:
        start, schedule_date = dm
        s = s[:start]

    title = _squash(s)
    if not title:
        return ParsedTask(title=raw.strip())
    return ParsedTask(
        title=title,
        bucket_id=bucket_id,
        bucket_name=bucket_name,
        status=status,
        schedule_date=schedule_date,
        watchers=watchers,
    )
