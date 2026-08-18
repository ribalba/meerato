/* App foundation: the shared namespace, central state, helpers, data accessors,
 * search parsing, watcher-email autocomplete, unread-comment tracking and view
 * labels. Loaded first; every other app.*.js file builds on window.App.
 *
 * Architecture (build-free, like db.js/api.js/sync.js):
 *   - This file creates `window.App` and exports the foundation onto it.
 *   - Feature files destructure the foundation at load time (safe — core loads
 *     first) and call across features late-bound via `App.fn()` (resolved when
 *     the handler actually runs, by which point every file has loaded).
 *   - Reads are local-first (IndexedDB via DB); writes go through Sync.mutate
 *     (offline-safe) or the REST API for connectivity-dependent actions.
 */
(function () {
  "use strict";

  const App = (window.App = window.App || {});
  const $ = window.jQuery;

  // The four built-in statuses. They always exist (defined here and on the
  // server) and can't be removed; users add custom statuses on top of them.
  const BUILTIN_STATUS = [
    { value: "open", label: "Backlog", color: "grey", icon: "clipboard list" },
    { value: "on_list", label: "Now", color: "blue", icon: "hourglass half" },
    { value: "blocked", label: "Blocked", color: "red", icon: "ban" },
    { value: "done", label: "Done", color: "green", icon: "check circle" },
  ];
  const BUILTIN_VALUES = new Set(BUILTIN_STATUS.map((s) => s.value));
  // The live status list = built-ins followed by the user's custom statuses
  // (loaded at boot via loadStatuses). It is mutated IN PLACE by
  // setCustomStatuses so the many modules that destructured this array at load
  // time keep referencing the current list.
  const STATUS = BUILTIN_STATUS.map((s) => ({ ...s }));
  const statusOf = (v) => STATUS.find((s) => s.value === v) || STATUS[0];
  const isBuiltinStatus = (v) => BUILTIN_VALUES.has(v);
  const customStatuses = () => STATUS.filter((s) => s.custom);

  // Rebuild STATUS in place: built-ins first, then the given custom statuses.
  function setCustomStatuses(list) {
    const customs = (list || []).map((c) => ({
      value: c.value,
      label: c.label,
      color: c.color || "grey",
      icon: c.icon || "circle",
      id: c.id,
      custom: true,
    }));
    STATUS.splice(0, STATUS.length, ...BUILTIN_STATUS.map((s) => ({ ...s })), ...customs);
  }

  // Fetch the user's custom statuses and merge them into STATUS. Falls back to
  // the last cached list when offline so known statuses still render.
  async function loadStatuses() {
    let list = (await DB.getMeta("custom_statuses", [])) || [];
    try {
      list = await API.get("/api/statuses");
      await DB.setMeta("custom_statuses", list);
    } catch (e) {
      /* offline or request failed: use the cached list */
    }
    setCustomStatuses(list);
  }

  const state = {
    user: null,
    // Independent filters that combine: show tasks matching both.
    bucketFilter: "all", // 'all' | '<bucketId>'
    statusFilter: "all", // 'all' | 'open' | 'on_list' | 'blocked' | 'done'
    currentTodoId: null,
    currentWatchToken: null, // set when the open detail is a read-only watched task
    watching: false, // sidebar "Watching" view active (tasks shared with me)
    panel: null, // main-pane panel: null | 'analytics' | 'automation' | 'api' | 'settings'
    watchersOpen: false, // detail pane: is the watchers panel expanded
    scheduleOpen: false, // detail pane: is the schedule panel expanded
    showArchived: false, // sidebar: reveal archived buckets
    showSubtasks: true, // task list: nest subtasks under their (visible) parents
    search: { active: false, parsed: null }, // task search overlay (see parseSearch)
  };

  // Icon shown on each activity-feed entry, by event type.
  const EVENT_ICON = {
    created: "plus",
    comment: "comment outline",
    status_changed: "exchange",
    edited: "pencil",
    moved: "arrows alternate",
    watcher_added: "eye",
    file_added: "paperclip",
    file_removed: "trash alternate",
    scheduled: "calendar alternate outline",
  };

  const esc = (s) =>
    (s || "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  // Server timestamps are naive UTC; tag them as UTC before parsing.
  const asUtc = (iso) =>
    iso && !/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso + "Z" : iso;
  const fmtDate = (iso) => {
    if (!iso) return "";
    return new Date(asUtc(iso)).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  };
  const toast = (message, cls) =>
    $("body").toast({ message, class: cls || "", position: "bottom right", displayTime: 3000 });
  const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  // How to label who did something in the activity feed: "You" for the current user,
  // the chosen name for guest commenters, otherwise the name part of their email.
  const displayActor = (email) => {
    if (!email) return "system";
    if (state.user && email.toLowerCase() === state.user.email.toLowerCase()) return "You";
    if (/\(guest\)\s*$/.test(email)) return email.replace(/\s*\(guest\)\s*$/, "");
    const at = email.indexOf("@");
    return at > 0 ? email.slice(0, at) : email;
  };
  // API errors may carry a string detail or a Pydantic validation array; coerce to text.
  const errText = (e) =>
    typeof e?.detail === "string" ? e.detail : "That doesn't look like a valid email.";

  function copyText(text, okMsg) {
    if (!text) return;
    (navigator.clipboard?.writeText(text) || Promise.reject()).then(
      () => toast(okMsg),
      () => prompt("Copy this:", text)
    );
  }

  // --- Data accessors (local-first) ---
  const liveBuckets = async () =>
    (await DB.getAll("buckets")).filter((b) => !b.deleted).sort((a, b) => (a.position || 0) - (b.position || 0));
  const liveTodos = async () => (await DB.getAll("todos")).filter((t) => !t.deleted);
  const bucketName = (buckets, id) => (buckets.find((b) => b.id === id) || {}).name || "—";

  // --- Task search ---
  // Aliases so `status:backlog`/`status:todo` map to the internal status values.
  const STATUS_ALIASES = {
    backlog: "open", open: "open",
    on_list: "on_list", onlist: "on_list", todo: "on_list",
    blocked: "blocked", done: "done",
  };

  // Parse a query into `key:value` filters (status/bucket) plus a free-text regex.
  // Unknown keys are left in the text so e.g. a stray "http://" still searches.
  function parseSearch(query) {
    const filters = { status: [], bucket: [] };
    const tokenRe = /(\w+):("[^"]*"|\S+)/g;
    const text = (query || "")
      .replace(tokenRe, (m, key, val) => {
        const k = key.toLowerCase();
        const v = val.replace(/^"|"$/g, "").toLowerCase();
        if (k === "status") return filters.status.push(v), "";
        if (k === "bucket") return filters.bucket.push(v), "";
        return m; // unknown key: keep it as searchable text
      })
      .trim();

    let regex = null;
    let regexError = false;
    if (text) {
      try { regex = new RegExp(text, "i"); }
      catch (e) { regexError = true; }
    }
    return { filters, regex, regexError, empty: !text && !filters.status.length && !filters.bucket.length };
  }

  const statusMatches = (token, todoStatus) =>
    STATUS_ALIASES[token]
      ? todoStatus === STATUS_ALIASES[token]
      : statusOf(todoStatus).label.toLowerCase().includes(token) || todoStatus.includes(token);

  // Does a todo satisfy every part of the parsed query? (filters AND text)
  function searchMatch(t, parsed, buckets) {
    const { filters, regex } = parsed;
    if (filters.status.length && !filters.status.some((tok) => statusMatches(tok, t.status))) return false;
    if (filters.bucket.length) {
      const name = bucketName(buckets, t.bucket_id).toLowerCase();
      if (!filters.bucket.some((tok) => name.includes(tok))) return false;
    }
    if (regex && !regex.test(`${t.title || ""}\n${t.text || ""}`)) return false;
    return true;
  }

  // --- Watcher-email autocomplete ---
  // Rank every email ever used as a watcher by how many tasks it watches (most
  // used first). Feeds the Fomantic UI search dropdowns behind the watcher inputs.
  let emailSuggestions = [];
  async function refreshEmailSuggestions(todos) {
    todos = todos || (await liveTodos());
    const counts = new Map();
    for (const t of todos) {
      for (const w of t.watchers || []) {
        const e = (w.email || "").trim().toLowerCase();
        if (e) counts.set(e, (counts.get(e) || 0) + 1);
      }
    }
    emailSuggestions = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([email]) => email);
  }

  // Turn a watcher-email <input> (wrapped in `.ui.fluid.search`) into a Fomantic
  // search box whose results dropdown spans the full width of the text box.
  function initEmailSearch(selector, onPick) {
    const $search = $(selector).closest(".ui.search");
    if (!$search.length) return;
    $search.search({
      source: emailSuggestions.map((e) => ({ title: e })),
      searchFields: ["title"],
      fullTextSearch: true,
      maxResults: 8,
      minCharacters: 1,
      // After Fomantic fills the input with the picked email, let dependent UI
      // (e.g. the Invite button) react to the new value.
      onSelect: () => { if (onPick) setTimeout(onPick, 0); },
    });
  }

  // --- Unread comment tracking (a comment from someone else you haven't seen) ---
  const isUnreadComment = (e, me, seen) =>
    e.type === "comment" && !e.deleted &&
    (e.actor_email || "").toLowerCase() !== me &&
    !seen.has(e.id);

  async function unreadByTask() {
    const me = (state.user?.email || "").toLowerCase();
    const seen = new Set((await DB.getMeta("seen_comments", [])) || []);
    const map = {};
    for (const e of await DB.getAll("events")) {
      if (isUnreadComment(e, me, seen)) map[e.todo_id] = (map[e.todo_id] || 0) + 1;
    }
    return map;
  }

  async function markCommentsSeen(todoId /* optional: all if omitted */) {
    const events = await DB.getAll("events");
    const ids = events
      .filter((e) => e.type === "comment" && (!todoId || e.todo_id === todoId))
      .map((e) => e.id);
    const seen = new Set((await DB.getMeta("seen_comments", [])) || []);
    ids.forEach((i) => seen.add(i));
    await DB.setMeta("seen_comments", [...seen]);
  }

  // On first run, treat all existing comments as already seen so only new ones notify.
  async function initCommentSeen() {
    if (await DB.getMeta("comments_initialized", false)) return;
    await markCommentsSeen();
    await DB.setMeta("comments_initialized", true);
  }

  async function updateBellBadge() {
    const n = Object.keys(await unreadByTask()).length;
    $("#notif-badge").text(n).toggle(n > 0);
  }

  async function openNotifList() {
    const unread = await unreadByTask();
    const todos = await liveTodos();
    const buckets = await liveBuckets();
    const ids = Object.keys(unread);
    $("#notif-list").html(
      ids.length
        ? ids
            .map((id) => {
              const t = todos.find((x) => x.id === id);
              if (!t) return "";
              return `<div class="notif-item" data-id="${id}">
                <i class="bell icon card-bell"></i> <strong>${esc(t.title)}</strong>
                <span style="color:#999">· ${esc(bucketName(buckets, t.bucket_id))} · ${unread[id]} new</span>
              </div>`;
            })
            .join("")
        : "<div style='color:#aaa'>No new comments.</div>"
    );
    $("#notif-list .notif-item").on("click", function () {
      $("#notif-modal").modal("hide");
      App.openTodo($(this).data("id"));
    });
    $("#notif-modal").modal("show");
  }

  // --- View labels & ordering (the orderable sidebar status views) ---

  // "All tasks" plus one entry per status.
  const ALL_VIEW = { value: "all", label: "All tasks", icon: "inbox", color: "" };
  // User-defined display names for views/statuses (keyed by value), editable in Settings.
  let viewLabels = {};
  const defaultLabel = (v) => (v === "all" ? ALL_VIEW.label : statusOf(v).label);
  const labelOf = (v) => viewLabels[v] || defaultLabel(v);
  const viewMeta = (v) => ({ ...(v === "all" ? ALL_VIEW : statusOf(v)), label: labelOf(v) });

  async function loadLabels() {
    viewLabels = (await DB.getMeta("view_labels", {})) || {};
  }
  async function saveLabel(value, label) {
    const labels = (await DB.getMeta("view_labels", {})) || {};
    const trimmed = (label || "").trim();
    if (!trimmed || trimmed === defaultLabel(value)) delete labels[value];
    else labels[value] = trimmed;
    await DB.setMeta("view_labels", labels);
    viewLabels = labels;
    await App.renderViews();
  }

  async function getViewOrder() {
    const saved = await DB.getMeta("view_order", null);
    // Default order shown to new users ("Now" first, custom statuses last);
    // existing users keep whatever order they've saved. Any custom status not
    // already in the saved order is appended so new ones still appear.
    const customVals = STATUS.filter((s) => s.custom).map((s) => s.value);
    const DEFAULT_ORDER = ["on_list", "all", "open", "blocked", "done", ...customVals];
    const valid = new Set(["all", ...STATUS.map((s) => s.value)]);
    const order = Array.isArray(saved) ? saved.filter((v) => valid.has(v)) : [];
    for (const v of DEFAULT_ORDER) if (!order.includes(v)) order.push(v);
    return order;
  }

  Object.assign(App, {
    $, STATUS, BUILTIN_STATUS, statusOf, isBuiltinStatus, customStatuses,
    setCustomStatuses, loadStatuses, EVENT_ICON, ALL_VIEW, STATUS_ALIASES, state,
    esc, asUtc, fmtDate, toast, isValidEmail, displayActor, errText, copyText,
    liveBuckets, liveTodos, bucketName,
    parseSearch, statusMatches, searchMatch,
    refreshEmailSuggestions, initEmailSearch, getEmailSuggestions: () => emailSuggestions,
    isUnreadComment, unreadByTask, markCommentsSeen, initCommentSeen,
    updateBellBadge, openNotifList,
    defaultLabel, labelOf, viewMeta, loadLabels, saveLabel, getViewOrder,
  });
})();
