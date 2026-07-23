/* Meerato desktop shell.
 *
 * A thin Electron wrapper around a hosted Meerato instance: it loads the web app
 * in a native window, keeps the login session in its own persistent store, opens
 * outbound links in the system browser, and completes magic-link sign-in inside
 * the app via a `meerato://` deep link (see handleDeepLink).
 *
 * Point it at your instance with the MEERATO_URL env var:
 *   MEERATO_URL=https://app.example.com npm start
 */
const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("path");

// The hosted instance this app wraps. Defaults to the hosted Meerato instance.
const APP_URL = (process.env.MEERATO_URL || "https://meerato.com").replace(/\/+$/, "");
const APP_ORIGIN = new URL(APP_URL).origin;
const PROTOCOL = "meerato";

let mainWindow = null;

// Linux shells match a window to its installed icon by name, not by the `icon`
// option below: X11 compares WM_CLASS (taken from the app name) and Wayland the
// app_id (taken from the executable, or --class) against StartupWMClass in
// meerato.desktop. Packaged builds name the executable "meerato" so they line up;
// `npm start` runs the `electron` binary, hence the --class in that script.
app.setName("Meerato");

function isInternal(targetUrl) {
  try {
    return new URL(targetUrl).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 480,
    minHeight: 560,
    backgroundColor: "#f4f5f7",
    title: "Meerato",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      // Loading a remote origin: keep the page sandboxed from Node.
      contextIsolation: true,
      nodeIntegration: false,
      // A named partition persists cookies/session across restarts, so sign-in
      // sticks. This store is separate from the user's system browser.
      partition: "persist:meerato",
    },
  });

  loadApp();

  // target=_blank / window.open → system browser, never a child Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // In-page navigation to any non-app origin → system browser.
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!isInternal(url) && !url.startsWith(`${PROTOCOL}://`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // If the instance is unreachable, show a small retry screen instead of a blank
  // window. (Ignore the aborted-load code that fires on normal redirects.)
  mainWindow.webContents.on("did-fail-load", (_e, errorCode, _desc, validatedURL) => {
    if (errorCode === -3 || !isInternal(validatedURL || APP_URL)) return;
    mainWindow.loadURL(errorPage());
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

function loadApp() {
  // Open the dedicated sign-in page rather than the marketing landing at "/".
  // If a session already exists, that page redirects straight into the app.
  mainWindow.loadURL(`${APP_URL}/login`);
}

function errorPage() {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <style>
      body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f5f7;color:#1f2328}
      .card{text-align:center;max-width:420px;padding:2rem}
      h1{font-size:1.3rem;margin:0 0 .5rem}p{color:#57606a}
      button{font:inherit;font-weight:600;cursor:pointer;border:none;border-radius:8px;
        padding:.7rem 1.3rem;background:#2185d0;color:#fff;margin-top:1rem}
      code{background:#eef0f2;padding:.1rem .35rem;border-radius:4px}
    </style></head><body><div class="card">
      <h1>Can't reach Meerato</h1>
      <p>Couldn't connect to <code>${APP_ORIGIN}</code>. Check your connection and try again.</p>
      <button onclick="location.href='${APP_URL}'">Retry</button>
    </div></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

// --- Magic-link deep linking -------------------------------------------------
// The login email (when sent to the desktop client) links to
//   meerato://login?token=<token>
// The OS routes that here; we finish sign-in by loading the normal callback URL
// inside this window, so the session cookie is set in THIS app, not the browser.
function handleDeepLink(deepLink) {
  if (!deepLink || !deepLink.startsWith(`${PROTOCOL}://`)) return;
  let token;
  try {
    token = new URL(deepLink).searchParams.get("token");
  } catch {
    return;
  }
  if (!token || !mainWindow) return;
  mainWindow.loadURL(`${APP_URL}/api/auth/callback?token=${encodeURIComponent(token)}`);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: () => mainWindow && loadApp() },
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Single-instance: a second launch (e.g. a deep-link open on Windows/Linux)
// forwards its argv to the running instance instead of starting a new app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (link) handleDeepLink(link);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // macOS delivers deep links via open-url (may arrive before the window exists).
  app.on("open-url", (e, url) => {
    e.preventDefault();
    if (mainWindow) handleDeepLink(url);
    else app.whenReady().then(() => handleDeepLink(url));
  });

  app.whenReady().then(() => {
    // Register meerato:// as belonging to this app.
    if (process.defaultApp && process.argv.length >= 2) {
      // `electron .` during development: point the scheme at this script.
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
    buildMenu();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
