"""Small standalone HTML pages served straight from the backend.

A few flows start from a link in an email and must work without the SPA, such as
confirming an unsubscribe or a sign-in. They share this one template. ``body_html``
is inserted as it is, so callers must ``html.escape`` anything user controlled.
"""

from html import escape

from fastapi.responses import HTMLResponse

from .emailer import APP_NAME


def html_page(title: str, body_html: str, status_code: int = 200) -> HTMLResponse:
    return HTMLResponse(
        f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{APP_NAME} · {escape(title)}</title>
  <style>
    body {{ margin:0; min-height:100vh; display:flex; align-items:center;
            justify-content:center; background:#f4f5f7; color:#1f2328;
            font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",
            Helvetica,Arial,sans-serif; line-height:1.55; }}
    .card {{ background:#fff; border:1px solid #e6e8eb; border-radius:12px;
             box-shadow:0 1px 3px rgba(27,31,36,.06); padding:2rem;
             max-width:440px; width:calc(100% - 2rem); text-align:center; }}
    h1 {{ font-size:1.4rem; margin:0 0 .6rem; }}
    p {{ color:#57606a; margin:0 0 1rem; }}
    .task {{ font-weight:600; color:#1f2328; }}
    button {{ font:inherit; font-weight:600; cursor:pointer; border:none;
              border-radius:8px; padding:.7rem 1.3rem; background:#2185d0;
              color:#fff; }}
    button:hover {{ background:#1a6fb0; }}
    .brand {{ margin-top:1.5rem; color:#8c959f; font-size:.85rem; }}
    .brand a {{ color:#2185d0; text-decoration:none; }}
  </style>
</head>
<body>
  <div class="card">
    {body_html}
    <div class="brand">{APP_NAME} · <a href="https://meerato.com">meerato.com</a></div>
  </div>
</body>
</html>""",
        status_code=status_code,
    )
