/* Smart quick-add: the quick-add box understands trailing modifiers:
 *   #Bucket name        → file under an existing bucket
 *   @who@example.com    → add a watcher
 *   !status             → set the status (e.g. !now, !done, !backlog, !blocked)
 *   <date phrase> (end) → start in Backlog, schedule a move to "Now" on that date
 * Anything that doesn't resolve (bad email, unknown bucket, unknown status) is left in the title. */
(function () {
  "use strict";

  const App = window.App;
  const { $, state, toast, errText, liveBuckets, isValidEmail, labelOf, esc, STATUS, STATUS_ALIASES } = App;

  // Resolve the bucket/status a new task should land in, given the current view.
  // Mirrors quickAdd's logic (sans the parsed #bucket / status overrides).
  async function currentTarget() {
    if ((await liveBuckets()).length === 0) {
      await Sync.mutate("bucket", "create", null, { name: "Work", position: Date.now() });
    }
    const bucketId =
      (state.bucketFilter !== "all" ? state.bucketFilter : null) || (await App.getDefaultBucket());
    const status =
      state.statusFilter !== "all" ? state.statusFilter : await App.getDefaultStatus();
    return { bucketId, status };
  }

  // Create one task per line, preserving the pasted order via increasing position.
  async function addTasksForLines(lines) {
    const { bucketId, status } = await currentTarget();
    if (!bucketId) return toast("Create a bucket first", "warning");
    let pos = Date.now();
    for (const title of lines) {
      await Sync.mutate("todo", "create", null, {
        title, text: "", bucket_id: bucketId, status, position: pos++,
      });
    }
    $("#quick-add-input").val("");
    toast(`Added ${lines.length} tasks`);
  }

  function insertAtCursor(input, text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const v = input.value;
    input.value = v.slice(0, start) + text + v.slice(end);
    const pos = start + text.length;
    input.setSelectionRange(pos, pos);
    input.focus();
  }

  // Intercept a multi-line paste: offer to split it into one task per line.
  // Yes → create a task for each non-empty line; No → paste the joined text
  // (newlines collapsed to spaces) into the box as usual.
  async function quickAddPaste(e) {
    const clip = (e.originalEvent || e).clipboardData;
    if (!clip) return;
    const text = clip.getData("text");
    if (!text || !/\r|\n/.test(text)) return; // single line: let the browser paste it
    const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return; // only one real line: nothing to split
    e.preventDefault();
    if (confirm(`This looks like ${lines.length} lines. Create a separate task for each line?`)) {
      await addTasksForLines(lines);
    } else {
      insertAtCursor(e.target, lines.join(" "));
    }
  }

  const WEEKDAY_NUM = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  };
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const isoLocal = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // Next occurrence of weekday `target` (0=Sun..6=Sat), strictly in the future.
  function nextWeekday(target) {
    const d = startOfToday();
    let diff = (target - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return addDays(d, diff);
  }
  // Add n months to today, clamping the day to the target month's length.
  function addMonthsClamped(n) {
    const d = startOfToday();
    const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    t.setDate(Math.min(d.getDate(), last));
    return t;
  }
  function parseIsoDate(str) {
    const [y, mo, da] = str.split("-").map(Number);
    const d = new Date(y, mo - 1, da);
    return d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === da ? d : null;
  }

  // If `s` ends with a recognized date phrase, return {start, date}; else null.
  function matchTrailingDate(s) {
    const today = startOfToday();
    const wd = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
    const tests = [
      [/\btomorrow\s*$/i, () => addDays(today, 1)],
      [/\bnext week\s*$/i, () => nextWeekday(1)], // weeks start on Monday
      [/\bnext month\s*$/i, () => new Date(today.getFullYear(), today.getMonth() + 1, 1)],
      [/\bnext year\s*$/i, () => new Date(today.getFullYear() + 1, 0, 1)],
      [new RegExp(`\\bnext ${wd}\\s*$`, "i"), (m) => nextWeekday(WEEKDAY_NUM[m[1].toLowerCase()])],
      [/\bin (\d{1,3}) days?\s*$/i, (m) => addDays(today, parseInt(m[1], 10))],
      [/\bin (\d{1,3}) weeks?\s*$/i, (m) => addDays(today, parseInt(m[1], 10) * 7)],
      [/\bin (\d{1,2}) months?\s*$/i, (m) => addMonthsClamped(parseInt(m[1], 10))],
      [/\bon (\d{4}-\d{2}-\d{2})\s*$/i, (m) => parseIsoDate(m[1])],
      [new RegExp(`\\b(?:on |this )?${wd}\\s*$`, "i"), (m) => nextWeekday(WEEKDAY_NUM[m[1].toLowerCase()])],
    ];
    for (const [re, fn] of tests) {
      const m = re.exec(s);
      if (m) {
        const date = fn(m);
        if (date && !isNaN(date)) return { start: m.index, date };
      }
    }
    return null;
  }

  // Find a `#bucketname` anywhere in `s` that matches an existing (non-archived)
  // bucket. Longest name wins so "#Side project" beats a "#Side" bucket.
  function extractBucket(s, buckets) {
    const names = buckets.slice().sort((a, b) => b.name.length - a.name.length);
    const hashes = /#/g;
    let m;
    while ((m = hashes.exec(s))) {
      const after = s.slice(m.index + 1);
      const lower = after.toLowerCase();
      for (const b of names) {
        const nm = (b.name || "").toLowerCase();
        if (nm && lower.startsWith(nm)) {
          const endCh = after.charAt(b.name.length);
          if (endCh === "" || /\s/.test(endCh)) {
            const newStr = (s.slice(0, m.index) + after.slice(b.name.length)).replace(/\s{2,}/g, " ").trim();
            return { id: b.id, name: b.name, newStr };
          }
        }
      }
    }
    return null;
  }

  // Map every spelling of a status to its internal value: the aliases used by
  // search (backlog/todo/…) plus each status's display label ("now", "done", …).
  function statusAliasMap() {
    const map = { ...STATUS_ALIASES };
    for (const st of STATUS) map[st.label.toLowerCase()] = st.value;
    return map;
  }

  // Find a `!status` token anywhere in `s` (e.g. !now, !done, !backlog). Returns
  // {status, newStr} with the token removed, or null if none resolves.
  function extractStatus(s) {
    const map = statusAliasMap();
    const re = /!([a-z_]+)/gi;
    let m;
    while ((m = re.exec(s))) {
      const value = map[m[1].toLowerCase()];
      if (value) {
        const newStr = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ").trim();
        return { status: value, newStr };
      }
    }
    return null;
  }

  function parseQuickAdd(raw, buckets) {
    let s = raw.trim();
    const watchers = [];
    // 1. Watchers (anywhere). The marker '@' precedes an email (which has its own '@').
    s = s.replace(/@\s*([^\s@]+@[^\s@]+\.[^\s@]+)/g, (full, email) => {
      if (isValidEmail(email)) { watchers.push(email.toLowerCase()); return " "; }
      return full; // invalid → leave it in the title
    });
    // 2. Bucket (anywhere, must be an existing bucket).
    let bucketId = null, bucketName_ = null;
    const bx = extractBucket(s, buckets);
    if (bx) { bucketId = bx.id; bucketName_ = bx.name; s = bx.newStr; }
    // 3. Status (anywhere, must resolve to a known status).
    let status = null;
    const sx = extractStatus(s);
    if (sx) { status = sx.status; s = sx.newStr; }
    // 4. Date (trailing only).
    let scheduleDate = null;
    const dm = matchTrailingDate(s);
    if (dm) { scheduleDate = dm.date; s = s.slice(0, dm.start); }
    s = s.replace(/\s{2,}/g, " ").trim();
    return { title: s, bucketId, bucketName: bucketName_, watchers, status, scheduleDate };
  }

  async function quickAdd() {
    const raw = $("#quick-add-input").val().trim();
    if (!raw) return;
    if ((await liveBuckets()).length === 0) {
      await Sync.mutate("bucket", "create", null, { name: "Work", position: Date.now() });
    }
    const buckets = await liveBuckets();
    let parsed = parseQuickAdd(raw, buckets.filter((b) => !b.archived));
    // If parsing consumed everything (e.g. only "#Work next week"), keep the raw text.
    if (!parsed.title) parsed = { title: raw, bucketId: null, bucketName: null, watchers: [], status: null, scheduleDate: null };

    // A bucket/status filter wins (so the task shows in the current view); the parsed
    // #bucket overrides the bucket filter. A scheduled date forces Backlog → Now later.
    const bucketId =
      parsed.bucketId || (state.bucketFilter !== "all" ? state.bucketFilter : null) || (await App.getDefaultBucket());
    if (!bucketId) return toast("Create a bucket first", "warning");
    // An explicit `!status` wins. Otherwise a scheduled date starts in Backlog
    // (it gets moved to "Now" on the day), else fall back to the filter/default.
    const status =
      parsed.status ||
      (parsed.scheduleDate
        ? "open"
        : state.statusFilter !== "all" ? state.statusFilter : await App.getDefaultStatus());

    const id = await Sync.mutate("todo", "create", null, {
      title: parsed.title, text: "", bucket_id: bucketId, status, position: Date.now(),
    });
    $("#quick-add-input").val("");

    // Scheduling and watchers go through the REST API (online-only), so they need
    // the task to exist server-side first.
    const online = navigator.onLine;
    let pushed = false;
    if (parsed.scheduleDate || parsed.watchers.length) {
      if (online) {
        // Wait for the queued task-create to actually reach the server before we
        // POST against it — Sync.mutate's flush is fire-and-forget, so a plain
        // Sync.flush() here would no-op while that push is still in flight.
        pushed = await flushAndWait();
        if (!pushed) {
          toast("Couldn't reach the server — schedule and watchers weren't applied.", "error");
        } else {
          try {
            if (parsed.scheduleDate) {
              await API.post(`/api/todos/${id}/schedules`, {
                date: isoLocal(parsed.scheduleDate), status: "on_list",
              });
            }
          } catch (e) { toast(`Couldn't schedule: ${errText(e)}`, "error"); }
          for (const email of parsed.watchers) {
            try { await API.post(`/api/todos/${id}/watchers`, { email }); }
            catch (e) { toast(`Couldn't add watcher ${email}: ${errText(e)}`, "error"); }
          }
          await Sync.pull();
        }
      } else {
        toast("Task created. Connect to apply the schedule and watchers.", "warning");
      }
    }

    await App.openTodo(id);

    // Summarize what the syntax set up.
    const bits = [];
    if (parsed.bucketId) bits.push(`in ${esc(parsed.bucketName)}`);
    if (parsed.status) bits.push(labelOf(parsed.status));
    if (pushed && parsed.scheduleDate) bits.push(`${labelOf("on_list")} on ${parsed.scheduleDate.toLocaleDateString()}`);
    if (pushed && parsed.watchers.length) bits.push(`watching ${parsed.watchers.join(", ")}`);
    if (bits.length) toast("Task added — " + bits.join(" · "));
  }

  // Flush the mutation queue and wait until it's drained (the new task has reached
  // the server). Returns false if it doesn't drain within the timeout. Counts only
  // sendable ops: a parked one is never going out on its own, so waiting on it would
  // burn the whole timeout and report a server problem that isn't there.
  async function flushAndWait(timeoutMs = 6000) {
    const start = Date.now();
    await Sync.flush();
    while ((await Sync.readyCount()) > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 150));
      await Sync.flush();
    }
    return (await Sync.readyCount()) === 0;
  }

  Object.assign(App, { quickAdd, quickAddPaste });
})();
