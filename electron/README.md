# Meerato desktop (Electron)

A thin native wrapper around a hosted Meerato instance. It loads the web app in a
desktop window, keeps its own persistent login session (separate from your
browser), opens external links in the system browser, and completes magic-link
sign-in inside the app via a `meerato://` deep link.

This is a **shell around a running server** — it does not bundle the backend.
Point it at your deployed instance (or a local dev server).

## Develop / run

```bash
cd electron
npm install
MEERATO_URL=https://your-instance.example.com npm start
# or, against a local backend:
MEERATO_URL=http://localhost:8000 npm start   # default if unset
```

## Build installers

```bash
npm run dist     # full installers for the current OS, into electron/dist/
npm run pack     # unpacked app (faster, for local testing)
```

On Linux, `make distinstall` builds the AppImage and wires it into the desktop
so KDE and GNOME can find and launch it: it symlinks the AppImage to
`~/.local/bin/meerato`, copies the icons into the hicolor theme, writes
`~/.local/share/applications/meerato.desktop`, and registers the app as the
handler for `meerato://` links (needed for desktop sign-in). Because it is a
symlink, a later `make dist` updates the installed app in place. Override the
baked-in URL with `make distinstall MEERATO_URL=http://localhost:8000`, install
system-wide with `sudo make distinstall PREFIX=/usr/local`, and undo it all with
`make distuninstall`.

electron-builder reads the app icon from `build/icon.png`. For polished
production builds, add platform-native icons (`build/icon.icns` for macOS,
`build/icon.ico` for Windows); a single 512×512 PNG works otherwise.

The hosted URL is read from `MEERATO_URL` at launch. To bake a fixed URL into a
distributed build, set a default in `main.js` (the `APP_URL` constant) instead of
relying on the env var.

## How sign-in works

Meerato authenticates with an emailed one-time link. In a desktop window the
normal `https://…/api/auth/callback` link would open your **system browser**, so
the session cookie would land there instead of in the app. To avoid that:

1. When you request a link from the desktop app, the frontend sends
   `client: "desktop"` (it detects Electron from the user agent).
2. The backend then emails a `meerato://login?token=…` deep link instead of the
   web link (see `app/routers/auth.py`).
3. Clicking it launches/focuses this app, which finishes sign-in by loading the
   real callback URL **inside the app window** — so the cookie is stored here.

Requirements / limits:

- The desktop app must be **installed on the same machine** where you open the
  email for the deep link to route to it. (Read the email on your phone and the
  link won't find the desktop app.) On dev (`electron .`) the OS still needs to
  associate the `meerato://` scheme with the app; this is most reliable from a
  packaged build.
- The web app is unaffected: web users never send `client: "desktop"`, so they
  keep getting the normal `https` link.

## Custom URL scheme

The app registers the `meerato://` scheme (declared in `package.json` under
`build.protocols` for installers, and at runtime via
`app.setAsDefaultProtocolClient`). Only `meerato://…?token=…` links are acted on,
and only to drive the auth callback.
