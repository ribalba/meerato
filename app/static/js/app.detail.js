/* Task detail pane: open/close, the rendered detail view, its event wiring
 * (status/bucket/title/description/subtasks/watchers/schedules/comments), the
 * activity-feed entry renderer, subtask cascades, and file uploads (with progress). */
(function () {
  "use strict";

  const App = window.App;
  const {
    $, esc, state, toast, errText, STATUS,
    liveBuckets, liveTodos, asUtc, labelOf, displayActor, fmtDate, EVENT_ICON,
    isValidEmail, initEmailSearch, markCommentsSeen, updateBellBadge,
  } = App;

  // Briefly highlight a button row so a click on a card's status/bucket pill
  // lands the eye on the row that answers it.
  function flashPicker(sel) {
    const $row = $(sel);
    if (!$row.length) return;
    $row[0].scrollIntoView({ block: "nearest" });
    $row.removeClass("flash");
    void $row[0].offsetWidth; // restart the animation if it is already running
    $row.addClass("flash");
    setTimeout(() => $row.removeClass("flash"), 1200);
  }

  // `focus` optionally jumps straight to a control after the pane renders:
  // 'status' | 'bucket' flash that button row, 'watchers' | 'schedule' expand that panel.
  async function openTodo(id, focus) {
    state.currentTodoId = id;
    state.editingDescription = false;
    // Pre-set the popovers so the requested one renders expanded (and the others closed).
    state.watchersOpen = focus === "watchers";
    state.scheduleOpen = focus === "schedule";
    $("body").addClass("detail-open");
    App.applyDetailWidth();
    await refreshOpenTodo();
    // Opening a task marks its comments as read (clears the bell).
    await markCommentsSeen(id);
    $(`#todo-list .todo-card[data-id="${id}"] .card-bell`).remove();
    updateBellBadge();
    // Highlight the open task in the list.
    $("#todo-list .todo-card").removeClass("selected");
    $(`#todo-list .todo-card[data-id="${id}"]`).addClass("selected");
    // Surface the requested control. The status/bucket rows are always visible, so
    // just flash them; the schedule panel needs its list fetched just like its own
    // toggle does.
    if (focus === "status") flashPicker("#d-status-picker");
    else if (focus === "bucket") flashPicker("#d-bucket-picker");
    else if (focus === "schedule") loadSchedules(id);
  }

  function closeDetail() {
    state.currentTodoId = null;
    state.currentWatchToken = null;
    state.editingDescription = false;
    $("body").removeClass("detail-open");
    $("#todo-list .todo-card").removeClass("selected");
  }

  function closePopovers() {
    state.watchersOpen = false;
    state.scheduleOpen = false;
    $("#d-watchers-panel, #d-schedule-panel").hide();
  }

  async function refreshOpenTodo() {
    const id = state.currentTodoId;
    // A background sync must not re-render the pane while the description is being
    // edited — that would recreate the textarea and drop the user's focus/edit.
    if (state.editingDescription) return;
    const todo = await DB.get("todos", id);
    if (!todo || todo.deleted) {
      closeDetail();
      return;
    }
    const buckets = await liveBuckets();
    const all = await liveTodos();
    const subtodos = all.filter((t) => t.parent_id === id);
    const events = (await DB.getAll("events"))
      .filter((e) => e.todo_id === id && !e.deleted)
      .sort((a, b) => new Date(asUtc(a.created_at)) - new Date(asUtc(b.created_at)));

    // Replacing the pane's DOM would silently steal focus (and any half-typed
    // text) from the "Add a subtask" field — e.g. when a background sync lands
    // while the user is typing the next subtask. Capture and restore it.
    const subEl = document.getElementById("d-sub-title");
    const subFocused = subEl && document.activeElement === subEl;
    const subVal = subFocused ? subEl.value : "";
    const subCaret = subFocused ? subEl.selectionStart : 0;

    $("#detail-body").html(detailHtml(todo, buckets, subtodos, events));
    initDetail(todo, buckets);

    if (subFocused) {
      const el = document.getElementById("d-sub-title");
      if (el) {
        el.value = subVal;
        el.focus();
        el.setSelectionRange(subCaret, subCaret);
      }
    }
  }

  // Status and bucket as one-click button rows (no dropdown to open first) —
  // the current value is the highlighted button. Subtasks live in their parent's
  // bucket, so their bucket row is shown but disabled.
  function pickerHtml(todo, buckets, bName) {
    const isSub = !!todo.parent_id;
    const statusBtns = STATUS.map((o) => {
      const sel = o.value === todo.status;
      return `<button class="ui tiny button picker-btn ${sel ? `${o.color} active` : "basic"}"
              data-value="${o.value}" title="${sel ? "Current status" : `Set status to ${esc(labelOf(o.value))}`}">
        <i class="${o.icon} icon"></i>${esc(labelOf(o.value))}</button>`;
    }).join("");
    const bucketBtns = buckets.map((b) => {
      const sel = b.id === todo.bucket_id;
      return `<button class="ui tiny button picker-btn ${sel ? "blue active" : "basic"}${isSub ? " disabled" : ""}"
              data-value="${b.id}" ${isSub ? "disabled" : ""}
              title="${isSub ? `Bucket: ${esc(bName)} (inherited from parent task)` : sel ? "Current bucket" : `Move to ${esc(b.name)}`}">
        <i class="folder${b.archived ? " outline" : ""} icon"></i>${esc(b.name)}</button>`;
    }).join("");

    return `
      <div class="detail-picker">
        <div class="picker-row" id="d-status-picker">
          <span class="picker-label">Status</span>
          <div class="picker-btns">${statusBtns}</div>
        </div>
        <div class="picker-row" id="d-bucket-picker">
          <span class="picker-label">Bucket</span>
          <div class="picker-btns">${bucketBtns || "<span style='color:#aaa'>No buckets yet.</span>"}</div>
        </div>
      </div>`;
  }

  function detailHtml(todo, buckets, subtodos, events) {
    const shareReady = !!todo.public_token;
    const att = todo.attachments || [];
    const watchers = todo.watchers || [];

    const bName = (buckets.find((b) => b.id === todo.bucket_id) || {}).name || "Bucket";
    const online = navigator.onLine;

    return `
      <div class="detail-top">
        <div class="detail-controls">
          <button class="ui basic icon button${watchers.length ? " is-set" : ""}" id="d-watchers-btn"
                  title="Watchers${watchers.length ? ` (${watchers.length})` : ""}">
            <i class="eye icon"></i>
          </button>
          <button class="ui basic icon button${todo.has_schedule ? " is-set" : ""}" id="d-schedule-btn" title="Schedule a status change" ${online ? "" : "disabled"}>
            <i class="calendar alternate outline icon"></i>
          </button>
          <button class="ui basic ${shareReady ? "" : "disabled"} icon button" id="d-share" title="Copy share link">
            <i class="share alternate icon"></i>
          </button>
          <button class="ui basic icon button" id="d-file-btn" title="Attach a file" ${online ? "" : "disabled"}>
            <i class="upload icon"></i>
          </button>
          <button class="ui basic icon button" id="d-delete" title="Delete task"><i class="trash icon"></i></button>

          <div id="d-watchers-panel" class="detail-popover" style="display:${state.watchersOpen ? "block" : "none"}">
            <div class="detail-popover-title"><i class="eye icon"></i> Watchers</div>
            <div id="d-watchers">
              ${watchers.map((w) => `<span class="ui label">${esc(w.email)}<i class="delete icon d-rm-watcher" data-id="${w.id}"></i></span>`).join("") || "<span style='color:#aaa'>No watchers yet.</span>"}
            </div>
            <div class="ui fluid search email-search" style="margin-top:.6rem">
              <div class="ui fluid input">
                <input class="prompt" type="email" id="d-watcher-email" autocomplete="off" placeholder="Add watcher email…" ${online ? "" : "disabled"} />
              </div>
              <div class="results"></div>
            </div>
            <button class="ui primary button" id="d-add-watcher" style="display:none;margin-top:.5rem">
              <i class="paper plane icon"></i> Invite
            </button>
            ${online ? "" : "<div style='color:#999;font-size:.85em;margin-top:.4rem'>Connect to invite watchers.</div>"}
          </div>

          <div id="d-schedule-panel" class="detail-popover" style="display:${state.scheduleOpen ? "block" : "none"}">
            <div class="detail-popover-title"><i class="calendar alternate outline icon"></i> Schedule a status change</div>
            <div id="d-schedules"><div style="color:#aaa">Loading…</div></div>
            <div class="ui form" style="margin-top:.6rem">
              <div class="field">
                <label>On date</label>
                <input type="date" id="d-schedule-date" ${online ? "" : "disabled"} />
              </div>
              <div class="field">
                <label>Set status to</label>
                <select id="d-schedule-status" ${online ? "" : "disabled"}>
                  ${STATUS.map((o) => `<option value="${o.value}" ${o.value === "on_list" ? "selected" : ""}>${labelOf(o.value)}</option>`).join("")}
                </select>
              </div>
              <button class="ui primary fluid button" id="d-schedule-add" ${online ? "" : "disabled"}>
                <i class="calendar plus outline icon"></i> Schedule
              </button>
            </div>
          </div>
        </div>
        ${pickerHtml(todo, buckets, bName)}
        <input type="text" id="d-title" class="detail-title-input" value="${esc(todo.title)}" />
      </div>
      <input type="file" id="d-file" multiple style="display:none" ${online ? "" : "disabled"} />

      <h4 class="ui horizontal divider header"><i class="align left icon"></i> Description</h4>
      <div class="ui form">
        <div id="d-text-preview" class="markdown d-text-preview${(todo.text || "").trim() ? "" : " empty"}" title="Click to edit">${(todo.text || "").trim() ? MD.render(todo.text) : "Markdown supported… (click to edit)"}</div>
        <textarea id="d-text" rows="4" placeholder="Markdown supported…" style="display:none">${esc(todo.text || "")}</textarea>
      </div>

      <h4 class="ui horizontal divider header"><i class="sitemap icon"></i> Subtasks</h4>
      <div id="d-subtodos">
        ${subtodos
          .map(
            (st) => `
          <div class="subtodo-item" data-id="${st.id}">
            <div class="ui checkbox">
              <input type="checkbox" ${st.status === "done" ? "checked" : ""} class="d-sub-check" data-id="${st.id}" />
              <label style="${st.status === "done" ? "text-decoration:line-through" : ""}">${esc(st.title)}
                <a class="d-sub-open" data-id="${st.id}" style="font-size:.8em">(open)</a></label>
            </div>
          </div>`
          )
          .join("") || "<div style='color:#aaa'>No subtasks.</div>"}
        <div class="ui action input fluid" style="margin-top:.6rem">
          <input type="text" id="d-sub-title" placeholder="Add a subtask…" />
          <button class="ui button" id="d-add-sub">Add</button>
        </div>
      </div>

      ${att.length ? `
      <h4 class="ui horizontal divider header"><i class="paperclip icon"></i> Files</h4>
      <div id="d-attachments">
        ${att.map((a) => `<span class="ui label">
          <a href="/api/attachments/${a.id}" target="_blank"><i class="file icon"></i>${esc(a.filename)}</a>
          <i class="delete icon d-rm-file" data-id="${a.id}" title="Remove file"></i>
        </span>`).join("")}
      </div>` : ""}

      <h4 class="ui horizontal divider header"><i class="comments icon"></i> Activity</h4>
      <div class="ui feed" id="d-timeline">
        ${events.map((e) => eventHtml(e)).join("") || "<div style='color:#aaa'>No activity yet.</div>"}
      </div>
      <div class="ui form" style="margin-top:1rem">
        <div class="field">
          <textarea id="d-comment" rows="2" placeholder="Add a comment (markdown)…"></textarea>
        </div>
        <input type="file" id="d-comment-file" style="display:none" />
        <button class="ui icon button" id="d-comment-file-btn" title="Attach a file"><i class="upload icon"></i></button>
        <button class="ui primary button" id="d-add-comment">Comment</button>
        <span id="d-comment-file-name" style="color:#888;font-size:.85em;margin-left:.4rem"></span>
      </div>
    `;
  }

  function attachmentChip(a) {
    return `<a class="ui label" href="/api/attachments/${a.id}" target="_blank">
      <i class="file icon"></i>${esc(a.filename)}</a>`;
  }

  // A single entry rendered in Fomantic's "feed" view, with a date.
  function eventHtml(e) {
    const isComment = e.type === "comment";
    const who = displayActor(e.actor_email);
    const body = isComment ? MD.render(e.body) : esc(e.body);
    const att = (e.attachments || []).map(attachmentChip).join(" ");
    const icon = EVENT_ICON[e.type] || "circle";
    return `
      <div class="event">
        <div class="label"><i class="${icon} icon"></i></div>
        <div class="content">
          <div class="summary">
            <span class="user">${esc(who)}</span>
            <div class="date">${fmtDate(e.created_at)}</div>
          </div>
          <div class="extra text markdown">${body}</div>
          ${att ? `<div class="meta">${att}</div>` : ""}
        </div>
      </div>`;
  }

  // Apply the same change to every descendant subtask (depth-first), skipping any
  // that already match so we don't queue redundant mutations or log no-op events.
  async function cascadeToSubtasks(rootId, changes) {
    const all = await liveTodos();
    const childrenOf = (pid) => all.filter((t) => t.parent_id === pid);
    const queue = [...childrenOf(rootId)];
    while (queue.length) {
      const t = queue.shift();
      if (Object.keys(changes).some((k) => t[k] !== changes[k])) {
        await Sync.mutate("todo", "update", t.id, changes);
      }
      queue.push(...childrenOf(t.id));
    }
  }

  function initDetail(todo, buckets) {
    const id = todo.id;

    // Status & bucket are one-click button rows: a click on a button that isn't
    // already the current value applies it straight away. Both changes cascade to
    // every subtask: status keeps a tree in sync, and a bucket move takes the whole
    // subtree along (subtasks live in the parent's bucket).
    $("#d-status-picker .picker-btn").on("click", async function () {
      const value = this.dataset.value;
      if (!value || value === todo.status) return;
      await Sync.mutate("todo", "update", id, { status: value });
      await cascadeToSubtasks(id, { status: value });
    });
    $("#d-bucket-picker .picker-btn").on("click", async function () {
      const value = this.dataset.value;
      if (!value || value === todo.bucket_id) return;
      await Sync.mutate("todo", "update", id, { bucket_id: value });
      await cascadeToSubtasks(id, { bucket_id: value });
    });

    // Watchers panel toggle (state persists across re-renders).
    $("#d-watchers-btn").on("click", () => {
      const open = !state.watchersOpen;
      closePopovers();
      state.watchersOpen = open;
      $("#d-watchers-panel").toggle(open);
    });

    // Schedule a future status change.
    $("#d-schedule-btn").on("click", () => {
      const open = !state.scheduleOpen;
      closePopovers();
      state.scheduleOpen = open;
      $("#d-schedule-panel").toggle(open);
      if (open) loadSchedules(id);
    });
    if (state.scheduleOpen) loadSchedules(id);
    $("#d-schedule-add").on("click", async () => {
      const date = $("#d-schedule-date").val();
      const status = $("#d-schedule-status").val();
      if (!date) return toast("Pick a date", "warning");
      try {
        await API.post(`/api/todos/${id}/schedules`, { date, status });
        $("#d-schedule-date").val("");
        await loadSchedules(id);
        await Sync.pull(); // surface the new "scheduled" timeline event
        toast("Status change scheduled");
      } catch (e) { toast(errText(e), "error"); }
    });

    // Title (save on change if different)
    $("#d-title").on("change", async function () {
      const v = $(this).val().trim();
      if (v && v !== todo.title) await Sync.mutate("todo", "update", id, { title: v });
    });

    // Description is shown as rendered markdown; clicking swaps in the raw-source
    // textarea, and blurring saves (if changed) and swaps the rendered view back.
    const $text = $("#d-text");
    const $preview = $("#d-text-preview");
    const renderPreview = (raw) => {
      const trimmed = (raw || "").trim();
      $preview
        .html(trimmed ? MD.render(raw) : "Markdown supported… (click to edit)")
        .toggleClass("empty", !trimmed)
        .show();
      $text.hide();
    };
    $preview.on("click", () => {
      state.editingDescription = true;
      $preview.hide();
      $text.show().focus();
      // Place the cursor at the end of the source.
      const el = $text[0];
      el.setSelectionRange(el.value.length, el.value.length);
    });
    $text.on("blur", async function () {
      state.editingDescription = false;
      const v = $(this).val();
      if (v !== (todo.text || "")) {
        await Sync.mutate("todo", "update", id, { text: v });
        todo.text = v;
        toast("Description saved");
      }
      renderPreview(v);
    });

    $("#d-delete").on("click", async () => {
      await Sync.mutate("todo", "delete", id, {});
      closeDetail();
      toast("Task deleted");
    });

    $("#d-share").on("click", () => {
      if (!todo.public_token) return toast("Sync first to get a share link", "warning");
      const url = `${location.origin}/t/${todo.public_token}`;
      navigator.clipboard?.writeText(url).then(
        () => toast("Share link copied"),
        () => prompt("Copy this share link:", url)
      );
    });

    // Subtasks
    $("#d-add-sub").on("click", addSub);
    $("#d-sub-title").on("keydown", (e) => { if (e.key === "Enter") addSub(); });
    async function addSub() {
      const title = $("#d-sub-title").val().trim();
      if (!title) return;
      await Sync.mutate("todo", "create", null, {
        title, bucket_id: todo.bucket_id, parent_id: id, status: "open", position: Date.now(),
      });
      // Refocus so several subtasks can be typed in a row (the Add button click
      // moved focus to itself); refreshOpenTodo keeps it across the re-render.
      $("#d-sub-title").val("").trigger("focus");
    }
    $(".d-sub-check").on("change", async function () {
      const sid = $(this).data("id");
      await Sync.mutate("todo", "update", sid, { status: this.checked ? "done" : "open" });
    });
    $(".d-sub-open").on("click", function () { openTodo($(this).data("id")); });

    // Watchers (online-only: triggers an email). The Invite button only appears
    // once the input holds a valid email address.
    const watcherInput = $("#d-watcher-email");
    const inviteBtn = $("#d-add-watcher");
    const updateInvite = () => inviteBtn.toggle(isValidEmail(watcherInput.val().trim()));
    watcherInput.on("input", updateInvite);
    initEmailSearch("#d-watcher-email", updateInvite);

    const addWatcher = async () => {
      const email = watcherInput.val().trim();
      if (!isValidEmail(email)) return;
      try {
        await API.post(`/api/todos/${id}/watchers`, { email });
        watcherInput.val("");
        updateInvite();
        await Sync.pull();
        toast("Watcher invited");
      } catch (e) { toast(errText(e), "error"); }
    };
    inviteBtn.on("click", addWatcher);
    watcherInput.on("keydown", (e) => { if (e.key === "Enter") addWatcher(); });

    $(".d-rm-watcher").on("click", async function () {
      try {
        await API.del(`/api/todos/${id}/watchers/${$(this).data("id")}`);
        await Sync.pull();
      } catch (e) {
        if (e && e.status === 404) {
          // Local cache is out of date (e.g. the server was reset). Rebuild from server.
          await Sync.fullResync();
          toast("Your data was out of date — refreshed from the server");
        } else {
          toast(errText(e), "error");
        }
      }
    });

    // Todo file upload (online-only): icon button opens the hidden file picker.
    // Files can also be dropped onto the detail pane (see setupDetailDropzone).
    $("#d-file-btn").on("click", () => $("#d-file").trigger("click"));
    $("#d-file").on("change", async function () {
      await uploadFilesToTodo(id, this.files);
      this.value = ""; // allow re-picking the same file
    });
    $(".d-rm-file").on("click", async function () {
      try {
        await API.del(`/api/attachments/${$(this).data("id")}`);
        await Sync.pull();
        toast("File removed");
      } catch (e) { toast(errText(e), "error"); }
    });

    // Comment file picker: same icon-button pattern as the Files section.
    $("#d-comment-file-btn").on("click", () => $("#d-comment-file").trigger("click"));
    $("#d-comment-file").on("change", function () {
      $("#d-comment-file-name").text(this.files[0] ? this.files[0].name : "");
    });

    // Comment (+ optional file). A file on its own is a valid post — the comment
    // body may be empty when someone only wants to attach a file.
    $("#d-add-comment").on("click", async () => {
      const body = $("#d-comment").val().trim();
      const file = $("#d-comment-file")[0].files[0];
      if (!body && !file) return;
      const commentId = Sync.uuid();
      // Include actor_email locally so my own comment isn't flagged as "unread".
      await Sync.mutate("comment", "create", commentId, { todo_id: id, body, actor_email: state.user.email });
      $("#d-comment").val("");
      if (file && navigator.onLine) {
        try {
          await Sync.flush(); // ensure the event exists server-side first
          await uploadFile("event", commentId, file);
          await Sync.pull();
        } catch (e) { toast("Comment saved; file upload failed (offline?)", "warning"); }
      } else if (file) {
        toast("Comment saved; attach files when back online", "warning");
      }
      $("#d-comment-file").val("");
      $("#d-comment-file-name").text("");
    });
  }

  async function uploadFile(ownerType, ownerId, file) {
    const fd = new FormData();
    fd.append("file", file);
    return API.upload(`/api/attachments?owner_type=${ownerType}&owner_id=${ownerId}`, fd);
  }

  // Upload via XHR (not fetch) so we get byte-level progress for large files.
  // Throws {status, detail} to match the API wrapper's error shape.
  function uploadFileWithProgress(ownerType, ownerId, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/attachments?owner_type=${ownerType}&owner_id=${ownerId}`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (onProgress) onProgress(e.lengthComputable ? e.loaded / e.total : null);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          let data = null;
          try { data = JSON.parse(xhr.responseText); } catch (_) { /* no body */ }
          resolve(data);
        } else {
          let detail = xhr.statusText;
          try { detail = JSON.parse(xhr.responseText).detail || detail; } catch (_) { /* ignore */ }
          reject({ status: xhr.status, detail });
        }
      };
      xhr.onerror = () => reject({ status: 0, detail: "Network error during upload" });
      const fd = new FormData();
      fd.append("file", file);
      xhr.send(fd);
    });
  }

  // Update the upload overlay. frac is 0..1, or null for an indeterminate state.
  function setUploadProgress(label, frac) {
    $("#du-label").text(label);
    const fill = $("#du-bar-fill");
    if (frac == null) {
      $("#du-pct").text("");
      fill.addClass("indeterminate").css("width", "100%");
    } else {
      const pct = Math.round(frac * 100);
      $("#du-pct").text(pct + "%");
      fill.removeClass("indeterminate").css("width", pct + "%");
    }
  }

  // Attach one or more files to a todo (used by the picker and drag-and-drop),
  // showing a progress overlay on the detail pane. Online-only.
  async function uploadFilesToTodo(todoId, files) {
    files = Array.from(files || []);
    if (!files.length) return;
    if (!navigator.onLine) return toast("Connect to upload files", "warning");

    const pane = document.getElementById("detail-pane");
    pane.classList.add("uploading");
    let ok = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const tag = files.length > 1 ? ` (${i + 1}/${files.length})` : "";
        setUploadProgress(`Uploading ${f.name}${tag}`, 0);
        try {
          await uploadFileWithProgress("todo", todoId, f, (frac) =>
            setUploadProgress(`Uploading ${f.name}${tag}`, frac)
          );
          // Bytes are sent; the server is still saving. Show a finishing state.
          setUploadProgress(`Finishing ${f.name}${tag}`, null);
          ok++;
        } catch (e) {
          toast(`Couldn't upload ${f.name}: ${errText(e)}`, "error");
        }
      }
    } finally {
      pane.classList.remove("uploading");
    }
    if (ok) {
      // A watched task isn't part of local sync, so re-fetch its read-only view to
      // show the new file; owned tasks refresh via the normal pull + re-render.
      if (state.currentWatchToken) {
        await App.openWatchedDetail(state.currentWatchToken, state.currentTodoId);
      } else {
        await Sync.pull();
      }
      toast(ok === 1 ? "File attached" : `${ok} files attached`);
    }
  }

  // List pending scheduled status changes for a todo, with a cancel control each.
  async function loadSchedules(id) {
    const el = $("#d-schedules");
    if (!el.length) return;
    try {
      const list = await API.get(`/api/todos/${id}/schedules`);
      el.html(
        list.length
          ? list
              .map((s) => `<div class="ui label" style="margin:0 .3rem .3rem 0">
                <i class="calendar alternate outline icon"></i> ${esc(s.local_date)} → ${labelOf(s.target_status)}
                <i class="delete icon d-rm-schedule" data-id="${s.id}" title="Cancel"></i></div>`)
              .join("")
          : "<div style='color:#aaa'>No scheduled changes.</div>"
      );
      $("#d-schedules .d-rm-schedule").on("click", async function () {
        try {
          await API.del(`/api/todos/${id}/schedules/${$(this).data("id")}`);
          await loadSchedules(id);
          await Sync.pull(); // refresh has_schedule so the button highlight clears
        } catch (e) { toast(errText(e), "error"); }
      });
    } catch (e) {
      el.html("<div style='color:#db2828'>Couldn't load schedules.</div>");
    }
  }

  Object.assign(App, {
    openTodo, closeDetail, closePopovers, refreshOpenTodo, eventHtml, uploadFilesToTodo,
  });
})();
