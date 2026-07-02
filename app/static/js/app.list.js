/* Task list & sidebar: the top-level re-render, the status-views menu, the bucket
 * rail, the task tree (filters + search results), and bucket create/archive/duplicate. */
(function () {
  "use strict";

  const App = window.App;
  const {
    $, esc, state, toast, errText, STATUS,
    liveBuckets, liveTodos, bucketName, labelOf, viewMeta, getViewOrder,
    parseSearch, searchMatch, unreadByTask, updateBellBadge, refreshEmailSuggestions,
  } = App;

  async function renderAll() {
    const buckets = await liveBuckets();
    await renderViews(); // reflects the active status filter / Watching highlight
    renderRail(buckets);
    await renderList(buckets);
    App.updatePendingBadge();
    updateBellBadge();
    refreshEmailSuggestions();
  }

  // Status filter menu, rendered in the user's saved order (see Settings).
  async function renderViews() {
    const order = await getViewOrder();
    const items = order.map((v) => {
      const m = viewMeta(v);
      // No status is highlighted while the Watching view or a panel is active.
      const active = !state.watching && !state.panel && state.statusFilter === v ? "active" : "";
      return `<a class="item status-link ${active}" data-status="${v}"><i class="${m.icon} icon"></i> ${m.label}</a>`;
    });
    $("#views-menu").html(items.join(""));
    $("#watching-btn").toggleClass("active", state.watching);
    $("#automation-btn").toggleClass("active", state.panel === "automation");
    $("#api-btn").toggleClass("active", state.panel === "api");
    $("#settings-btn").toggleClass("active", state.panel === "settings");
  }

  // ===================== Bucket rail =====================

  function bucketRowHtml(b) {
    const active = !state.watching && state.bucketFilter === b.id;
    return `
      <div class="bucket-row ${active ? "active" : ""} ${b.archived ? "archived" : ""}" data-id="${b.id}">
        <div class="ui top left pointing dropdown bucket-menu" data-id="${b.id}" title="Bucket actions">
          <i class="ellipsis vertical icon"></i>
          <div class="menu">
            <div class="item act-rename"><i class="edit icon"></i> Rename</div>
            <div class="item act-duplicate"><i class="copy icon"></i> Duplicate</div>
            <div class="item act-archive"><i class="archive icon"></i> ${b.archived ? "Unarchive" : "Archive"}</div>
          </div>
        </div>
        <a class="bucket-name bucket-link" data-bucket="${b.id}" title="${esc(b.name)}">${esc(b.name)}</a>
      </div>`;
  }

  function renderRail(buckets) {
    const visible = buckets.filter((b) => state.showArchived || !b.archived);
    const hasArchived = buckets.some((b) => b.archived);
    const allActive = !state.watching && state.bucketFilter === "all" ? "active" : "";
    let html = `<a class="item bucket-link bucket-all ${allActive}" data-bucket="all"><i class="folder open icon"></i> All buckets</a>`;
    html += visible.map(bucketRowHtml).join("");
    if (hasArchived) {
      html += `<a id="toggle-archived">${state.showArchived ? "Hide archived" : "Show archived"}</a>`;
    }
    $("#buckets-menu").html(html);

    // Each bucket's kebab menu.
    $("#buckets-menu .bucket-menu").dropdown({ action: "hide" });
    $("#buckets-menu .act-rename").on("click", function () {
      openBucketModal($(this).closest(".bucket-row").data("id"));
    });
    $("#buckets-menu .act-duplicate").on("click", function () {
      duplicateBucket($(this).closest(".bucket-row").data("id"));
    });
    $("#buckets-menu .act-archive").on("click", function () {
      toggleArchiveBucket($(this).closest(".bucket-row").data("id"));
    });
    $("#toggle-archived").on("click", () => {
      state.showArchived = !state.showArchived;
      renderAll();
    });
  }

  // ===================== Task tree =====================

  async function renderList(buckets) {
    // A main-pane panel (Automation / API) is open: it owns the content area,
    // so leave the task-list chrome hidden and don't render tasks underneath.
    if (state.panel) return;
    // Watching view: tasks shared with me (fetched online), shown in the main pane.
    if (state.watching) {
      $("#quick-add").hide();
      await App.renderWatchingList();
      return;
    }
    if (!state.search.active) $("#quick-add").show();

    const all = await liveTodos();
    const unread = await unreadByTask();
    const sortTasks = (arr) =>
      arr.slice().sort(
        (a, b) =>
          (a.status === "done") - (b.status === "done") ||
          (a.position || 0) - (b.position || 0) ||
          new Date(App.asUtc(a.created_at)) - new Date(App.asUtc(b.created_at))
      );

    const searching = state.search.active;
    let roots, opts;
    if (searching) {
      // Search ignores the sidebar filters and scans every task (archived too),
      // showing a flat result list with full status + bucket context.
      const parsed = state.search.parsed || parseSearch("");
      roots = parsed.regexError ? [] : all.filter((t) => searchMatch(t, parsed, buckets));
      opts = { tree: false, scopeIds: null, showPill: true, showBucket: true };
    } else {
      // Combine the independent bucket + status filters.
      const bf = state.bucketFilter; // 'all' | bucketId
      const sf = state.statusFilter; // 'all' | status
      const archivedBucketIds = new Set(buckets.filter((b) => b.archived).map((b) => b.id));
      // When no specific bucket is chosen, hide archived buckets' tasks.
      const inBucket = (t) => (bf === "all" ? !archivedBucketIds.has(t.bucket_id) : t.bucket_id === bf);
      const inStatus = (t) => (sf === "all" ? true : t.status === sf);
      const match = (t) => inBucket(t) && inStatus(t);

      // Always render a tree: a matched task nests under its parent if the parent also
      // matches, otherwise it becomes a root. This keeps the hierarchy in every view.
      const matchedIds = new Set(all.filter(match).map((t) => t.id));
      roots = all.filter((t) => match(t) && (!t.parent_id || !matchedIds.has(t.parent_id)));
      opts = {
        tree: true,
        scopeIds: matchedIds,
        showPill: sf === "all", // statuses are mixed only when not filtered
        showBucket: bf === "all",
      };
    }

    const childrenOf = (pid) => {
      let kids = all.filter((t) => t.parent_id === pid);
      if (opts.scopeIds) kids = kids.filter((t) => opts.scopeIds.has(t.id));
      return sortTasks(kids);
    };
    function nodeHtml(t) {
      const done = t.status === "done";
      const pill = opts.showPill
        ? `<span class="ui basic label status-pill card-action" data-focus="status" title="Change status">${labelOf(t.status)}</span>`
        : "";
      const bucketLabel = opts.showBucket
        ? `<span class="ui basic label bucket-pill card-action" data-focus="bucket" title="Move to bucket">${esc(bucketName(buckets, t.bucket_id))}</span>`
        : "";
      const bell = unread[t.id]
        ? `<i class="bell icon card-bell" title="New comment"></i>`
        : "";
      // Borderless light-grey hints: an eye when the task has a watcher, a
      // calendar when a status change is scheduled.
      const eye = t.watchers && t.watchers.length
        ? `<i class="eye icon card-hint card-action" data-focus="watchers" title="Watchers"></i>`
        : "";
      const cal = t.has_schedule
        ? `<i class="calendar alternate outline icon card-hint card-action" data-focus="schedule" title="Scheduled status change"></i>`
        : "";
      // Thin divider between the status/bucket labels and the hint icons, only when
      // both sides are actually present.
      const sep = (pill || bucketLabel) && (eye || cal) ? `<span class="pill-sep">|</span>` : "";
      const childHtml = opts.tree ? childrenOf(t.id).map(nodeHtml).join("") : "";
      // In tree mode every node carries a drag handle and an (always-present, maybe
      // empty) children container so it can be reordered or have tasks dropped into
      // it to become subtasks. See app.dnd.js.
      const handle = opts.tree
        ? `<i class="grip lines vertical icon drag-handle" title="Drag to reorder or nest"></i>`
        : "";
      const children = opts.tree ? `<div class="todo-children" data-parent="${t.id}">${childHtml}</div>` : "";
      return `
        <div class="todo-node" data-id="${t.id}">
          <div class="ui fluid card todo-card" data-id="${t.id}" style="${done ? "opacity:.65" : ""}">
            <div class="content">
              <div class="todo-row">
                ${handle}
                <input type="checkbox" class="todo-check" data-id="${t.id}" ${done ? "checked" : ""} title="Mark done" />
                <div class="todo-main">
                  <div class="header" style="${done ? "text-decoration:line-through" : ""}">${bell}${esc(t.title)}</div>
                </div>
                <div class="todo-pills">${pill}${bucketLabel}${sep}${eye}${cal}</div>
              </div>
            </div>
          </div>
          ${children}
        </div>`;
    }

    const sortedRoots = sortTasks(roots);
    if (sortedRoots.length === 0) {
      const msg = !searching
        ? "No tasks left"
        : state.search.parsed && state.search.parsed.regexError
        ? '<i class="exclamation triangle icon"></i> Invalid regular expression.'
        : '<i class="search icon"></i> No tasks match your search.';
      $("#empty-state .ui.icon.header").html(msg);
      // Show the meerkat only for the genuine "nothing to do" state, not for
      // empty search results or regex errors.
      $("#empty-state-img").toggle(!searching);
    }
    $("#empty-state").toggle(sortedRoots.length === 0);
    $("#todo-list").html(sortedRoots.map(nodeHtml).join(""));

    // Checkbox toggles done without opening the detail pane.
    $("#todo-list .todo-check")
      .on("click", (e) => e.stopPropagation())
      .on("change", async function (e) {
        e.stopPropagation();
        await Sync.mutate("todo", "update", $(this).data("id"), {
          status: this.checked ? "done" : "open",
        });
      });
    // Clicking a status/bucket label or a watcher/schedule icon opens the task and
    // jumps straight to that control instead of the plain detail view.
    $("#todo-list .card-action").on("click", function (e) {
      e.stopPropagation();
      App.openTodo($(this).closest(".todo-card").data("id"), $(this).data("focus"));
    });
    $("#todo-list .todo-card").on("click", function () {
      App.openTodo($(this).data("id"));
    });
    // A plain click on the drag handle must not open the detail pane.
    $("#todo-list .drag-handle").on("click", (e) => e.stopPropagation());
    // Keep the open task highlighted across re-renders.
    if (state.currentTodoId) {
      $(`#todo-list .todo-card[data-id="${state.currentTodoId}"]`).addClass("selected");
    }

    // Enable (or tear down) drag-to-reorder / drag-to-nest. Only meaningful in the
    // hierarchical tree view — search results are a flat, filter-agnostic list.
    if (App.initTaskDnd) App.initTaskDnd(opts.tree && !searching);
  }

  // ===================== Buckets =====================

  // Create a new bucket, or rename an existing one when bucketId is given.
  async function openBucketModal(bucketId) {
    const bucket = bucketId ? await DB.get("buckets", bucketId) : null;
    $("#bucket-modal-title").text(bucket ? "Rename bucket" : "New bucket");
    $("#bucket-name").val(bucket ? bucket.name : "");
    // Pressing Enter in the name field submits the form; intercept it so it
    // approves the modal instead of triggering the browser's default submit
    // (which would blur the modal and refocus the main window).
    $("#bucket-form").off("submit.bucket").on("submit.bucket", (e) => {
      e.preventDefault();
      $("#bucket-modal .approve.button").click();
    });
    $("#bucket-modal")
      .modal({
        onApprove: async () => {
          const name = $("#bucket-name").val().trim();
          if (!name) return false;
          if (bucket) {
            await Sync.mutate("bucket", "update", bucket.id, { name });
            toast("Bucket renamed");
          } else {
            await Sync.mutate("bucket", "create", null, { name, position: Date.now() });
            toast("Bucket created");
          }
        },
      })
      .modal("show");
  }

  // Archive/unarchive and duplicate are heavier server-side operations (cascading
  // task changes / cloning), so they go through the REST API and require a connection.
  async function toggleArchiveBucket(bucketId) {
    const bucket = await DB.get("buckets", bucketId);
    if (!navigator.onLine) return toast("Connect to archive buckets", "warning");
    const action = bucket && bucket.archived ? "unarchive" : "archive";
    try {
      await API.post(`/api/buckets/${bucketId}/${action}`);
      if (action === "archive" && state.bucketFilter === bucketId) state.bucketFilter = "all";
      await Sync.pull();
      toast(action === "archive" ? "Bucket archived" : "Bucket unarchived");
    } catch (e) { toast(errText(e), "error"); }
  }

  async function duplicateBucket(bucketId) {
    if (!navigator.onLine) return toast("Connect to duplicate buckets", "warning");
    try {
      await API.post(`/api/buckets/${bucketId}/duplicate`);
      await Sync.pull();
      toast("Bucket duplicated");
    } catch (e) { toast(errText(e), "error"); }
  }

  Object.assign(App, { renderAll, renderViews, renderList, openBucketModal });
})();
