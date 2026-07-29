/* App shell: boot/login, the app frame (resizer, dropzone, global event binding),
 * the status/bucket filters, the main-pane panels (Automation/API/Watching),
 * the search overlay, Settings, and new-account defaults. */
(function () {
  "use strict";

  const App = window.App;
  const {
    $, esc, state, toast, errText, parseSearch, STATUS,
    liveBuckets, labelOf, viewMeta, defaultLabel, getViewOrder, saveLabel,
    loadLabels, initCommentSeen, openNotifList, markCommentsSeen,
  } = App;

  // Running inside the Electron desktop shell? Then magic-link sign-in needs a
  // meerato:// deep link so the session lands in the app (see electron/README.md).
  const IS_DESKTOP = /Electron/i.test(navigator.userAgent);

  // ===================== Boot =====================

  // Fade out and remove the initial loading splash once we know what to render.
  function hideLoader() {
    const el = document.getElementById("app-loader");
    if (!el) return;
    el.classList.add("loaded");
    setTimeout(() => el.remove(), 450);
  }

  // ---- Web Share Target ----
  // The OS hands a shared payload to the installed app as query params on "/"
  // (see `share_target` in manifest.webmanifest). iOS Safari doesn't implement
  // the API, so on iPhone the same entry point is driven by a Shortcut instead.
  // Either way the payload arrives here and lands in the quick-add box.
  const SHARE_PARAMS = ["share_title", "share_text", "share_url"];
  const SHARE_KEY = "pending_share";

  // Collapse a shared {title, text, url} into one quick-add line. Apps are
  // inconsistent about which field they fill (some put the link in `text` and
  // leave `url` empty), so drop duplicates and only append the URL if it isn't
  // already in there.
  function sharedQuickAddText(params) {
    const parts = [];
    for (const key of ["share_title", "share_text"]) {
      const v = (params.get(key) || "").trim();
      if (v && !parts.includes(v)) parts.push(v);
    }
    const url = (params.get("share_url") || "").trim();
    if (url && !parts.some((p) => p.includes(url))) parts.push(url);
    // The quick-add box is a single-line input, so flatten any shared newlines.
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  // Stash the payload and strip it from the URL. Signing in reloads to "/", so
  // without this the shared text would be lost whenever the share arrives on a
  // signed-out app.
  function stashSharedText() {
    const params = new URLSearchParams(location.search);
    if (!SHARE_PARAMS.some((p) => params.has(p))) return;
    const text = sharedQuickAddText(params);
    if (text) sessionStorage.setItem(SHARE_KEY, text);
    history.replaceState({}, "", "/");
  }

  // Drop a stashed share into the quick-add box, ready to edit. Deliberately not
  // auto-submitted: the shorthand (#Bucket, !now, a trailing date) is the point of
  // sharing into the box, and the user gets a chance to trim a noisy page title.
  function applySharedText() {
    const shared = sessionStorage.getItem(SHARE_KEY);
    if (!shared) return;
    sessionStorage.removeItem(SHARE_KEY);
    $("#quick-add-input").val(shared).trigger("focus");
    toast("Shared text is in the add box. Edit it, then press Enter.");
  }

  async function boot() {
    // Before the auth check: showLogin() and the post-sign-in reload both discard
    // location.search, so the payload has to be captured first.
    stashSharedText();
    if ("serviceWorker" in navigator) {
      // Register after `load` so installing/precaching never competes with the
      // initial navigation and critical resources — registering during boot lets
      // the worker's install fetches stall first paint.
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      });
    }
    bindConnection();
    try {
      state.user = await API.get("/api/auth/me");
    } catch (e) {
      return showLogin();
    }
    showApp();
  }

  function bindConnection() {
    const upd = () => {
      const on = navigator.onLine;
      $("#sync-now")
        .toggleClass("online", on)
        .toggleClass("offline", !on)
        .attr("title", on ? "Online — click to sync" : "Offline — changes will sync when reconnected");
    };
    window.addEventListener("online", upd);
    window.addEventListener("offline", upd);
    upd();
  }

  // ===================== Login =====================

  function showLogin() {
    hideLoader();
    $("#app").hide();
    $("#login").show();

    // The email the code was last sent to. Both the landing form and the compact
    // header form feed the one code box in the landing login section.
    let codeEmail = "";

    function loginMessage(html, kind) {
      $("#login-message")
        .removeClass("hidden positive negative")
        .addClass("visible " + (kind === "error" ? "negative" : "positive"))
        .html(html);
    }

    // Reveal the code box for `email`. Issuing a code invalidates the previous one,
    // so this doubles as the way out of an expired code or the too-many-guesses lockout.
    async function requestCode(email) {
      await API.post("/api/auth/login", { email, client: IS_DESKTOP ? "desktop" : undefined });
      codeEmail = email;
      $("#code-sent-to").text(email);
      $("#login-form").hide();
      $("#code-form").show();
      $("#login-code").val("").trigger("focus");
    }

    $("#login-form").on("submit", async (e) => {
      e.preventDefault();
      const email = $("#login-email").val().trim();
      if (!email) return;
      try {
        await requestCode(email);
        loginMessage("<i class='check icon'></i> Check your email for a sign-in link and code.");
      } catch (err) {
        loginMessage(esc(err.detail || "Something went wrong."), "error");
      }
    });

    // Compact header login: same flow, but scroll the user down to the code box.
    $("#nav-login-form").on("submit", async (e) => {
      e.preventDefault();
      const email = $("#nav-login-email").val().trim();
      if (!email) return;
      try {
        await requestCode(email);
        $("#nav-login-email").val("");
        document.querySelector(".landing-login-section")
          .scrollIntoView({ behavior: "smooth", block: "center" });
        toast("<i class='check icon'></i> Check your email for a sign-in link and code.", "success");
      } catch (err) {
        toast(err.detail || "Something went wrong.", "error");
      }
    });

    $("#code-form").on("submit", async (e) => {
      e.preventDefault();
      const code = $("#login-code").val().trim();
      if (!code) return;
      try {
        const r = await API.post("/api/auth/verify-code", { email: codeEmail, code });
        // Reload rather than calling showApp(): boot() re-fetches /api/auth/me and
        // runs the same-account check that swaps out any stale local mirror.
        location.replace(r.redirect || "/");
      } catch (err) {
        loginMessage(esc(err.detail || "Something went wrong."), "error");
        $("#login-code").trigger("select");
      }
    });

    $("#resend-code").on("click", async () => {
      try {
        await requestCode(codeEmail);
        loginMessage("<i class='check icon'></i> New code sent. Check your email.");
      } catch (err) {
        loginMessage(esc(err.detail || "Something went wrong."), "error");
      }
    });

    $("#use-other-email").on("click", () => {
      $("#code-form").hide();
      $("#login-form").show();
      $("#login-message").removeClass("visible positive negative").addClass("hidden");
      $("#login-email").val(codeEmail).trigger("focus");
    });

    // A darker-than-default dimmer, so the enlarged shot reads as a lightbox rather
    // than floating over a still-legible page.
    $("#shot-modal").modal({ dimmerSettings: { opacity: 0.88 } });

    // Click (or Enter/Space, since each frame is a button) a screenshot to open it
    // full size. Delegated from the section so it survives showLogin running twice.
    $("#screenshots").off("click.shotzoom").on("click.shotzoom", ".js-shot-zoom", function () {
      const img = this.querySelector("img");
      if (!img) return;
      // currentSrc, so a responsive/lazy swap resolves to what's actually displayed.
      $("#shot-modal-img").attr("src", img.currentSrc || img.src).attr("alt", img.alt);
      $("#shot-modal").modal("show");
    });

    // Clicking the image itself closes too — the dimmer around it already does.
    $("#shot-modal-img").on("click", () => $("#shot-modal").modal("hide"));
  }

  // ===================== App shell =====================

  async function showApp() {
    $("#login").hide();
    $("#app").css("display", "flex");
    // Fade out the splash; the 0.4s fade overlaps the first render below so the
    // app doesn't flash empty before the sidebar and list are populated.
    hideLoader();

    // If a different account than last time is signing in on this browser, wipe the
    // local mirror so we never show another user's data.
    const prevUser = await DB.getMeta("current_user", null);
    if (prevUser && prevUser !== state.user.id) {
      await clearLocalData();
    }
    await DB.setMeta("current_user", state.user.id);

    Sync.start();
    Sync.onChange(onDataChanged);

    // Guess the timezone from the browser the first time (server default is UTC).
    if (state.user && state.user.timezone === "UTC") {
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz && tz !== "UTC") {
          const u = await API.patch("/api/auth/me", { timezone: tz });
          state.user.timezone = u.timezone;
        }
      } catch (e) { /* ignore */ }
    }

    bindShellEvents();
    setupResizer();
    setupDetailDropzone();
    await App.loadStatuses(); // custom statuses extend STATUS before anything renders
    await loadLabels();
    await App.renderViews();

    // First-time: ask for a name (used in watcher emails) and explain why.
    if (state.user && !state.user.name && !localStorage.getItem("name_prompted")) {
      promptForName();
    }

    // Initial sync, then render. If offline, render from whatever is cached.
    try { await Sync.flush(); } catch (e) { /* offline */ }
    await ensureDefaultBuckets();
    await initCommentSeen();

    // With no deep link, default to the first sidebar view (the user's saved
    // order, "Now" by default) rather than leaving the "all" filter unselected.
    const params = new URLSearchParams(location.search);
    if (!params.get("watch") && !params.get("todo") && !params.get("watching")) {
      const order = await getViewOrder();
      if (order.length) state.statusFilter = order[0];
    }

    await App.renderAll();

    // Deep links: /?watch=<public_token> opens the Watching tab with that shared
    // task selected (from the public share page); /?todo=<id> from an invite/access
    // link (may be a task shared with me, not one I own); /?watching=1 to open the
    // Watching page.
    const watchToken = params.get("watch");
    const todoId = params.get("todo");
    if (watchToken) {
      history.replaceState({}, "", "/");
      App.openWatchingTask(watchToken);
    } else if (todoId) {
      history.replaceState({}, "", "/");
      App.openTaskOrWatched(todoId);
    } else if (params.get("watching")) {
      history.replaceState({}, "", "/");
      enterWatching();
    }

    // Last, so the focused quick-add box isn't stolen by a deep-linked task.
    applySharedText();
  }

  // Drag the gutter to resize the list vs. detail columns; width is remembered.
  function applyDetailWidth() {
    const w = parseInt(localStorage.getItem("detail_width") || "", 10);
    if (w) document.getElementById("detail-pane").style.flex = `0 0 ${w}px`;
  }

  function setupResizer() {
    const resizer = document.getElementById("detail-resizer");
    const layout = document.getElementById("layout");
    const pane = document.getElementById("detail-pane");
    let dragging = false;

    const onMove = (e) => {
      if (!dragging) return;
      const rect = layout.getBoundingClientRect();
      const max = rect.width - 360; // keep room for the list
      const w = Math.max(320, Math.min(max, rect.right - e.clientX));
      pane.style.flex = `0 0 ${w}px`;
      localStorage.setItem("detail_width", String(Math.round(w)));
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove("dragging");
      document.body.classList.remove("resizing");
    };
    resizer.addEventListener("mousedown", (e) => {
      dragging = true;
      resizer.classList.add("dragging");
      document.body.classList.add("resizing");
      e.preventDefault();
    });
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", stop);
  }

  // Drag a file anywhere onto the open task's detail pane to attach it. Bound once
  // on the persistent #detail-pane (not in initDetail, which re-renders per task);
  // it reads state.currentTodoId so it always targets the open task.
  function setupDetailDropzone() {
    const pane = document.getElementById("detail-pane");
    if (!pane) return;
    const hasFiles = (e) =>
      e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
    let depth = 0; // dragenter/leave fire per child element; count to avoid flicker

    pane.addEventListener("dragenter", (e) => {
      if (!state.currentTodoId || !hasFiles(e)) return;
      e.preventDefault();
      depth++;
      pane.classList.add("dropping");
    });
    pane.addEventListener("dragover", (e) => {
      if (!state.currentTodoId || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    pane.addEventListener("dragleave", () => {
      if (!depth) return;
      depth = Math.max(0, depth - 1);
      if (!depth) pane.classList.remove("dropping");
    });
    pane.addEventListener("drop", async (e) => {
      depth = 0;
      pane.classList.remove("dropping");
      if (!state.currentTodoId || !hasFiles(e)) return;
      e.preventDefault();
      await App.uploadFilesToTodo(state.currentTodoId, e.dataTransfer.files);
    });
  }

  function bindShellEvents() {
    $("#logout").on("click", async () => {
      try { await Sync.flush(); } catch (e) { /* push pending changes first */ }
      try { await API.post("/api/auth/logout"); } catch (e) { /* ignore */ }
      await clearLocalData();
      location.reload();
    });
    $("#sync-now").on("click", () => Sync.flush().then(() => toast("Synced")));
    $("#settings-btn").on("click", showSettings);
    $("#settings-back").on("click", hideSettings);
    $("#reload-app").on("click", reloadApp);
    $("#notif-btn").on("click", openNotifList);
    $("#settings-terms-link").on("click", () => $("#terms-modal").modal("show"));
    $("#notif-clear").on("click", async () => {
      await markCommentsSeen();
      await App.renderAll();
      $("#notif-modal").modal("hide");
      toast("Marked all as read");
    });
    $("#default-bucket").on("change", function () { DB.setMeta("default_bucket", this.value); });
    $("#default-status").on("change", function () { DB.setMeta("default_status", this.value); });
    $("#tz-select").on("change", async function () {
      try {
        const u = await API.patch("/api/auth/me", { timezone: this.value });
        state.user.timezone = u.timezone;
        toast("Timezone saved");
      } catch (e) { toast(errText(e), "error"); }
    });
    $("#profile-name").on("change", async function () {
      try {
        const u = await API.patch("/api/auth/me", { name: this.value });
        state.user.name = u.name;
        toast("Name saved");
      } catch (e) { toast(errText(e), "error"); }
    });
    $("#new-bucket-btn").on("click", () => App.openBucketModal());
    $("#fab").on("click", () => $("#quick-add-input").focus());
    $("#quick-add-help").on("click", () => $("#syntax-modal").modal("show"));

    // Watching (tasks shared with me): a main-pane view, like the status filters.
    $("#watching-btn").on("click", enterWatching);

    // Analytics (throughput stats): a main-pane panel, like the API view.
    $("#analytics-btn").on("click", () => App.showAnalytics());
    $("#analytics-periods").on("click", ".item", function () {
      App.setAnalyticsPeriod($(this).data("period"));
    });

    // Custom statuses (managed in the Settings panel).
    $("#cs-add").on("click", addCustomStatus);
    $("#cs-label, #cs-icon").on("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addCustomStatus(); }
    });

    // Automation (recurring tasks): a main-pane panel, like the Watching view.
    $("#automation-btn").on("click", () => App.showAutomation());
    $("#rec-frequency").on("change", function () { App.renderRecWhen(this.value, {}); });
    $("#rec-form").on("submit", (e) => App.saveRec(e));
    $("#rec-cancel").on("click", () => App.resetRecForm());

    // API (external create endpoint): a main-pane panel, like the Watching view.
    $("#api-btn").on("click", () => App.showApiPage());
    $("#api-bucket, #api-status").on("change", () => App.updateApiCurl());
    $("#api-rotate").on("click", () => App.rotateApiToken());
    $("#api-copy-endpoint").on("click", () => App.copyText($("#api-endpoint").val(), "Endpoint copied"));
    $("#api-copy-curl").on("click", () => App.copyText(App.apiCurl, "curl command copied"));
    $("#api-copy-get").on("click", () => App.copyText(App.apiGet, "curl command copied"));
    $("#api-copy-tasks").on("click", () => App.copyText(App.apiTasks, "curl command copied"));

    // "How you can use this with software" modal (per-tool reveals).
    $("#api-software-accordion").accordion();
    $("#api-software-btn").on("click", () => $("#api-software-modal").modal("show"));
    $("#api-copy-shell").on("click", () => App.copyText(App.apiShell, "Alias copied"));
    $("#api-copy-alfred").on("click", () => App.copyText(App.apiAlfred, "Script copied"));
    $("#api-copy-ios").on("click", () => App.copyText(App.apiIos, "Endpoint copied"));

    // Permanent quick-add bar (submit with Enter, unless the autocomplete menu
    // is open — then Enter/Tab/arrows drive the menu instead).
    App.initQuickAddAutocomplete();
    $("#quick-add-input").on("keydown", (e) => {
      if (App.qaAutocompleteKeydown(e)) { e.preventDefault(); return; }
      if (e.key === "Enter") App.quickAdd();
    });
    $("#quick-add-input").on("paste", (e) => App.quickAddPaste(e));

    // Task search: toggle from either logo's search icon, live-filter on input.
    $(".js-search-toggle").on("click", toggleSearch);
    $("#search-close").on("click", closeSearch);
    $("#search-help").on("click", () => $("#search-help-modal").modal("show"));
    $("#search-input").on("input", onSearchInput);
    $("#search-input").on("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeSearch(); } });
    // "/" anywhere (outside a field) opens search, like many web apps.
    $(document).on("keydown", (e) => {
      if (e.key !== "/" || state.search.active) return;
      if (/^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable) return;
      if ($("#app").is(":visible")) { e.preventDefault(); openSearch(); }
    });

    // Status and bucket are independent filters that combine.
    $("#views-menu").on("click", ".status-link", function () {
      setStatusFilter(String($(this).data("status")));
    });
    $("#buckets-menu").on("click", ".bucket-link", function () {
      setBucketFilter(String($(this).data("bucket")));
    });

    // Detail pane close (Esc, the mobile back bar, or selecting another task).
    $(document).on("keydown", (e) => { if (e.key === "Escape" && state.currentTodoId) App.closeDetail(); });
    $("#detail-mobile-close").on("click", () => App.closeDetail());

    // Close the watchers/schedule popovers when clicking outside them.
    $(document).on("click", (e) => {
      if (!state.watchersOpen && !state.scheduleOpen) return;
      if ($(e.target).closest("#d-watchers-panel, #d-schedule-panel, #d-watchers-btn, #d-schedule-btn").length) return;
      App.closePopovers();
    });

    // Mobile rail toggle
    $("#rail-toggle").on("click", () => $("body").toggleClass("rail-open"));
    $("#rail-backdrop").on("click", () => $("body").removeClass("rail-open"));
  }

  let renderScheduled = false;
  function onDataChanged() {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(async () => {
      renderScheduled = false;
      await App.renderAll();
      updatePendingBadge();
      // Don't refresh from the local mirror when a read-only watched task is open
      // (it isn't in local data and would close the pane).
      if (state.currentTodoId && !state.currentWatchToken) await App.refreshOpenTodo();
    }, 50);
  }

  async function updatePendingBadge() {
    const n = await Sync.pendingCount();
    $("#pending-badge").text(n).toggle(n > 0);
  }

  function setStatusFilter(value) {
    if (state.search.active) exitSearch(); // picking a filter leaves search mode
    exitMainPanel(); // picking a filter leaves the Automation/API panel
    state.watching = false; // picking a normal filter leaves the Watching view
    state.statusFilter = value;
    $("#views-menu .status-link").removeClass("active");
    $(`#views-menu .status-link[data-status="${value}"]`).addClass("active");
    $("body").removeClass("rail-open");
    App.renderAll();
  }

  function setBucketFilter(value) {
    if (state.search.active) exitSearch(); // picking a filter leaves search mode
    exitMainPanel(); // picking a filter leaves the Automation/API panel
    state.watching = false; // picking a normal filter leaves the Watching view
    state.bucketFilter = value;
    $("body").removeClass("rail-open");
    App.renderAll();
  }

  // The "Watching" sidebar view: tasks shared with me, shown in the main pane.
  function enterWatching() {
    if (state.search.active) exitSearch();
    exitMainPanel(); // leaves the Automation/API panel
    state.watching = true;
    App.closeDetail();
    $("body").removeClass("rail-open");
    App.renderAll();
  }

  // ===================== Main-pane panels (Automation / API / Settings) =========
  // Automation, API and Settings live in the main content area, swapping in for
  // the task list (like the Watching view) rather than opening a separate page.

  // Show one of the main-pane panels, hiding the task-list chrome.
  function enterMainPanel(name) {
    if (state.search.active) exitSearch();
    state.watching = false;
    state.panel = name;
    App.closeDetail();
    $("#quick-add, #search-bar, #todo-list, #empty-state").hide();
    $("#analytics-panel").toggle(name === "analytics");
    $("#automation-panel").toggle(name === "automation");
    $("#api-panel").toggle(name === "api");
    $("#settings-panel").toggle(name === "settings");
    // The panel buttons own the "active" highlight while a panel is open.
    $("#views-menu .status-link, #watching-btn").removeClass("active");
    $("#analytics-btn").toggleClass("active", name === "analytics");
    $("#automation-btn").toggleClass("active", name === "automation");
    $("#api-btn").toggleClass("active", name === "api");
    $("#settings-btn").toggleClass("active", name === "settings");
    $("body").removeClass("rail-open");
  }

  // Leave any open panel and restore the normal task list (callers re-render).
  function exitMainPanel() {
    if (!state.panel) return;
    state.panel = null;
    $("#analytics-panel, #automation-panel, #api-panel, #settings-panel").hide();
    $("#quick-add, #todo-list").show();
    $("#analytics-btn, #automation-btn, #api-btn, #settings-btn").removeClass("active");
  }

  // ===================== Search =====================

  function openSearch() {
    if (state.panel) { exitMainPanel(); App.renderAll(); }
    state.search.active = true;
    state.search.parsed = parseSearch($("#search-input").val());
    // search-mode dims the sidebar filter highlights (they don't apply while
    // searching) and 'active' lights up the trigger icon + its pointer triangle.
    $("body").addClass("search-mode").removeClass("rail-open");
    $(".js-search-toggle").addClass("active");
    $("#search-bar").show();
    $("#quick-add").hide();
    $("#search-input").trigger("focus");
    App.renderAll();
  }

  // Tear down the search UI without re-rendering (callers render themselves).
  function exitSearch() {
    state.search.active = false;
    $("body").removeClass("search-mode");
    $(".js-search-toggle").removeClass("active");
    $("#search-input").val("");
    $(".search-input").removeClass("error");
    $("#search-bar").hide();
    $("#quick-add").show();
  }

  function closeSearch() {
    if (!state.search.active) return;
    exitSearch();
    App.renderAll();
  }

  function toggleSearch() {
    state.search.active ? closeSearch() : openSearch();
  }

  let searchDebounce = null;
  function onSearchInput() {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
      state.search.parsed = parseSearch($("#search-input").val());
      $(".search-input").toggleClass("error", state.search.parsed.regexError);
      await App.renderList(await liveBuckets());
    }, 120);
  }

  // ===================== Settings =====================

  async function renderNewTaskDefaults() {
    const buckets = (await liveBuckets()).filter((b) => !b.archived);
    const curBucket = await getDefaultBucket();
    const curStatus = await getDefaultStatus();
    $("#default-bucket").html(
      buckets
        .map((b) => `<option value="${b.id}" ${b.id === curBucket ? "selected" : ""}>${esc(b.name)}</option>`)
        .join("")
    );
    $("#default-status").html(
      STATUS.map((s) => `<option value="${s.value}" ${s.value === curStatus ? "selected" : ""}>${labelOf(s.value)}</option>`).join("")
    );
  }

  function promptForName() {
    $("#name-modal-input").val("");
    $("#name-modal")
      .modal({
        onShow: () => localStorage.setItem("name_prompted", "1"),
        onApprove: async () => {
          const name = $("#name-modal-input").val().trim();
          if (!name) return;
          try {
            const u = await API.patch("/api/auth/me", { name });
            state.user.name = u.name;
            toast(`Thanks, ${u.name}!`);
          } catch (e) { toast(errText(e), "error"); }
        },
      })
      .modal("show");
  }

  function renderTimezone() {
    let zones = [];
    try { zones = Intl.supportedValuesOf("timeZone"); } catch (e) { /* older browsers */ }
    const current = (state.user && state.user.timezone) || "UTC";
    if (!zones.length) zones = ["UTC", current];
    if (!zones.includes(current)) zones.unshift(current);
    $("#tz-select").html(
      zones.map((z) => `<option value="${esc(z)}" ${z === current ? "selected" : ""}>${esc(z)}</option>`).join("")
    );
  }

  function showSettings() {
    enterMainPanel("settings");
    $("#settings-email").text(state.user.email);
    $("#profile-name").val(state.user.name || "");
    renderCustomStatuses();
    renderViewOrderEditor();
    renderNewTaskDefaults();
    renderTimezone();
  }

  async function hideSettings() {
    exitMainPanel();
    await App.renderAll(); // restore the task list + reflect any new order/statuses
  }

  // Force a fresh download of the app shell/assets. The service worker caches
  // our JS/CSS (and CDN libs), and normally only evicts them when sw.js bumps
  // VERSION — so code changes shipped without a bump can keep serving stale.
  // Clearing the caches and unregistering the worker, then reloading, makes the
  // browser re-fetch everything from the network (the worker re-precaches on the
  // next load). Local task data lives in IndexedDB and is left untouched.
  async function reloadApp() {
    $("#reload-app").addClass("loading disabled");
    try { await Sync.flush(); } catch (e) { /* push pending changes first */ }
    try {
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch (e) { /* best effort — reload regardless */ }
    location.reload();
  }

  // ---- Custom statuses (Settings panel) ----
  // Fomantic UI's named colours, offered in the colour picker.
  const STATUS_COLORS = [
    "grey", "black", "red", "orange", "yellow", "olive", "green",
    "teal", "blue", "violet", "purple", "pink", "brown",
  ];

  function renderCustomStatuses() {
    const customs = App.customStatuses();
    $("#custom-status-list").html(
      customs.length
        ? customs
            .map(
              (s) => `
          <div class="item" data-id="${s.id}">
            <div class="right floated content">
              <button class="ui icon mini button cs-del" title="Delete status"><i class="trash icon"></i></button>
            </div>
            <i class="${s.color} ${esc(s.icon)} icon" style="line-height:1.8"></i>
            <div class="content"><div class="header">${esc(s.label)}</div></div>
          </div>`
            )
            .join("")
        : "<div style='color:#aaa;padding:.4rem 0'>No custom statuses yet.</div>"
    );
    $("#custom-status-list .cs-del").on("click", function () {
      deleteCustomStatus($(this).closest(".item").data("id"));
    });
    // Populate the colour picker once.
    if (!$("#cs-color option").length) {
      $("#cs-color").html(STATUS_COLORS.map((c) => `<option value="${c}">${c}</option>`).join(""));
    }
  }

  async function addCustomStatus() {
    const label = $("#cs-label").val().trim();
    if (!label) return;
    try {
      await API.post("/api/statuses", {
        label,
        color: $("#cs-color").val() || "grey",
        icon: ($("#cs-icon").val() || "").trim() || "circle",
        position: Date.now(),
      });
      $("#cs-label").val("");
      $("#cs-icon").val("");
      await refreshAfterStatusChange();
      toast("Status added");
    } catch (e) {
      toast(errText(e), "error");
    }
  }

  async function deleteCustomStatus(id) {
    try {
      await API.del(`/api/statuses/${id}`);
      await refreshAfterStatusChange();
      toast("Status removed");
    } catch (e) {
      toast(errText(e), "error");
    }
  }

  // Reload statuses and re-render the Settings editors + sidebar. The task list
  // is behind the panel; it re-renders when Settings is closed (hideSettings).
  async function refreshAfterStatusChange() {
    await App.loadStatuses();
    renderCustomStatuses();
    await renderViewOrderEditor();
    renderNewTaskDefaults();
    await App.renderViews();
  }

  async function renderViewOrderEditor() {
    const order = await getViewOrder();
    $("#status-order-list").html(
      order
        .map((v) => {
          const m = viewMeta(v);
          return `
          <div class="item" data-value="${v}">
            <div class="right floated content">
              <button class="ui icon mini button so-up" title="Move up"><i class="arrow up icon"></i></button>
              <button class="ui icon mini button so-down" title="Move down"><i class="arrow down icon"></i></button>
            </div>
            <i class="${m.color} ${m.icon} icon" style="line-height:1.8"></i>
            <div class="content">
              <input type="text" class="view-label-input" data-value="${v}" value="${esc(m.label)}"
                     placeholder="${esc(defaultLabel(v))}" title="Rename this view" />
            </div>
          </div>`;
        })
        .join("")
    );
    $("#status-order-list .so-up").on("click", function () {
      moveView($(this).closest(".item").data("value"), -1);
    });
    $("#status-order-list .so-down").on("click", function () {
      moveView($(this).closest(".item").data("value"), 1);
    });
    $("#status-order-list .view-label-input").on("change", function () {
      saveLabel($(this).data("value"), this.value);
    });
  }

  async function moveView(value, dir) {
    const order = await getViewOrder();
    const i = order.indexOf(String(value));
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    await DB.setMeta("view_order", order);
    await renderViewOrderEditor();
    await App.renderViews();
  }

  // ===================== New-account defaults =====================

  // A new account starts with two default buckets (once — not recreated if the
  // user later deletes them).
  async function ensureDefaultBuckets() {
    if (await DB.getMeta("buckets_initialized", false)) return;
    if ((await liveBuckets()).length === 0) {
      await Sync.mutate("bucket", "create", null, { name: "Work", position: Date.now() });
      await Sync.mutate("bucket", "create", null, { name: "Private", position: Date.now() + 1 });
    }
    await DB.setMeta("buckets_initialized", true);
  }

  // New-task defaults (configurable in Settings), with sensible fallbacks.
  async function getDefaultStatus() {
    const saved = await DB.getMeta("default_status", null);
    return STATUS.some((s) => s.value === saved) ? saved : "open";
  }
  async function getDefaultBucket() {
    const saved = await DB.getMeta("default_bucket", null);
    const buckets = await liveBuckets();
    if (saved && buckets.some((b) => b.id === saved && !b.archived)) return saved;
    return (buckets.find((b) => !b.archived) || buckets[0] || {}).id || null;
  }

  // Wipe the local mirror + per-account state (on logout / account switch).
  async function clearLocalData() {
    await DB.clear("buckets");
    await DB.clear("todos");
    await DB.clear("events");
    await DB.clear("queue");
    await DB.clear("meta");
    try {
      localStorage.removeItem("name_prompted");
      localStorage.removeItem("detail_width");
    } catch (e) { /* ignore */ }
    await loadLabels(); // reset in-memory labels to the now-empty store
  }

  Object.assign(App, {
    boot,
    applyDetailWidth,
    enterMainPanel,
    exitMainPanel,
    enterWatching,
    getDefaultStatus,
    getDefaultBucket,
    updatePendingBadge,
    clearLocalData,
  });
})();
