/* Analytics panel: a personal look at throughput over a rolling time window.
 * Computed entirely from the local mirror (todos + their status-change events),
 * so it works offline like the rest of the app — no server call. Rendered via
 * enterMainPanel("analytics").
 *
 * Three windows (last week / month / year). For the selected one we show:
 *   - Overview KPIs:  new tasks created, tasks completed, median time in "Now".
 *   - Completed by bucket:  how many tasks you finished in each bucket.
 *   - Median time in "Now" by bucket:  the typical time finished tasks sat in the
 *     "Now" (on_list) status before they were done, reconstructed from the
 *     timeline. Median, not mean, so a few long-lingering tasks don't skew it.
 *   - Tasks by status & bucket:  a live snapshot (period-independent) counting how
 *     many current tasks sit in each status, per bucket.
 */
(function () {
  "use strict";

  const App = window.App;
  const { $, esc, STATUS, liveBuckets, liveTodos, asUtc, bucketName, labelOf } = App;

  // Rolling windows in days. "Last week" = the past 7 days, and so on.
  const PERIODS = [
    { days: 7, label: "Last week" },
    { days: 30, label: "Last month" },
    { days: 365, label: "Last year" },
  ];
  let period = 7; // currently selected window (days)

  const DAY_MS = 86400000;
  const ms = (iso) => (iso ? new Date(asUtc(iso)).getTime() : NaN);

  // Median of a numeric array (the "typical" value — robust to a few tasks that
  // lingered in Now for a long time, unlike the mean). NaN for an empty array.
  function median(nums) {
    if (!nums.length) return NaN;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // Human-friendly duration from milliseconds: "3d 4h", "4h 12m", "6m", "<1m".
  function fmtDuration(msVal) {
    if (!isFinite(msVal) || msVal < 0) return "—";
    const mins = Math.round(msVal / 60000);
    if (mins < 1) return "<1m";
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d) return h ? `${d}d ${h}h` : `${d}d`;
    if (h) return m ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
  }

  // A done task ends its timeline at completion; an unfinished one runs to now.
  const endTime = (todo) => (todo.completed_at ? ms(todo.completed_at) : Date.now());

  // Reconstruct how long a todo spent in the "Now" (on_list) status across its
  // whole life. The timeline is: created_at (in some initial status) → a series
  // of status_changed events, each carrying {from, to}. We walk the segments and
  // sum those whose status is on_list; the final open segment ends at completion
  // (done tasks) or now. `changes` is this todo's status_changed events, already
  // sorted ascending, as {at, from, to}. Returns milliseconds.
  function timeInNow(todo, changes) {
    if (!changes.length) {
      // Never changed status: held its current status since creation.
      return todo.status === "on_list" ? endTime(todo) - ms(todo.created_at) : 0;
    }
    let total = 0;
    let segStatus = changes[0].from; // status held from creation to the first change
    let segStart = ms(todo.created_at);
    for (const c of changes) {
      if (segStatus === "on_list") total += c.at - segStart;
      segStatus = c.to;
      segStart = c.at;
    }
    if (segStatus === "on_list") total += endTime(todo) - segStart; // final segment
    return Math.max(0, total);
  }

  // Group every status_changed event by todo, parsed and sorted ascending.
  async function statusChangesByTodo() {
    const byTodo = new Map();
    for (const e of await DB.getAll("events")) {
      if (e.deleted || e.type !== "status_changed" || !e.meta) continue;
      let meta;
      try { meta = JSON.parse(e.meta); } catch (_) { continue; }
      if (!meta || !meta.to) continue;
      const list = byTodo.get(e.todo_id) || [];
      list.push({ at: ms(e.created_at), from: meta.from, to: meta.to });
      byTodo.set(e.todo_id, list);
    }
    for (const list of byTodo.values()) list.sort((a, b) => a.at - b.at);
    return byTodo;
  }

  // Render one "identity → magnitude" bar list. rows: [{label, valueText, value}].
  // Bar width is value / max, so the longest bar fills the track; a floor keeps
  // tiny non-zero values visible. `fill` is the status-colour class.
  function renderBars(rows, fill, emptyMsg) {
    if (!rows.length) return `<div class="an-empty">${esc(emptyMsg)}</div>`;
    const max = Math.max(...rows.map((r) => r.value)) || 1;
    return (
      `<div class="an-bars">` +
      rows
        .map((r) => {
          const pct = Math.max(3, Math.round((r.value / max) * 100));
          return `<div class="an-bar-row">
            <div class="an-bar-label" title="${esc(r.label)}">${esc(r.label)}</div>
            <div class="an-bar-track"><div class="an-bar-fill ${fill}" style="width:${pct}%"></div></div>
            <div class="an-bar-value">${esc(r.valueText)}</div>
          </div>`;
        })
        .join("") +
      `</div>`
    );
  }

  // Current snapshot (period-independent): a bucket × status matrix of how many
  // live tasks sit in each status right now. Columns follow the app's status
  // order (built-ins then custom); any stray status still present in the data
  // gets its own trailing column so no task goes uncounted. Buckets with no
  // tasks are omitted.
  function renderStatusGrid(todos, buckets) {
    const present = new Set(todos.map((t) => t.status));
    const cols = [
      ...STATUS.map((s) => ({ value: s.value, meta: s })),
      ...[...present].filter((v) => !STATUS.some((s) => s.value === v)).map((v) => ({ value: v, meta: null })),
    ];
    const idx = new Map(cols.map((c, i) => [c.value, i]));

    const byBucket = new Map(); // bucket_id -> { counts:number[], total }
    for (const t of todos) {
      const i = idx.get(t.status);
      if (i === undefined) continue;
      let row = byBucket.get(t.bucket_id);
      if (!row) { row = { counts: cols.map(() => 0), total: 0 }; byBucket.set(t.bucket_id, row); }
      row.counts[i]++; row.total++;
    }
    const rows = buckets
      .filter((b) => (byBucket.get(b.id) || {}).total)
      .map((b) => ({ name: b.name, ...byBucket.get(b.id) }));
    if (!rows.length) return `<div class="an-empty">No tasks yet.</div>`;

    const head =
      `<tr><th></th>` +
      cols
        .map((c) => {
          const icon = c.meta ? `<i class="${c.meta.color} ${esc(c.meta.icon)} icon"></i> ` : "";
          return `<th class="an-grid-h">${icon}${esc(labelOf(c.value))}</th>`;
        })
        .join("") +
      `<th class="an-grid-h an-grid-total">Total</th></tr>`;
    const body = rows
      .map(
        (r) =>
          `<tr><td class="an-grid-b" title="${esc(r.name)}">${esc(r.name)}</td>` +
          r.counts.map((n) => `<td class="an-grid-n">${n || '<span class="an-zero">·</span>'}</td>`).join("") +
          `<td class="an-grid-n an-grid-total">${r.total}</td></tr>`
      )
      .join("");
    return `<div class="an-grid-wrap"><table class="ui very basic compact table an-grid">
      <thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  async function render() {
    const cutoff = Date.now() - period * DAY_MS;
    const todos = await liveTodos();
    const buckets = await liveBuckets();
    const changes = await statusChangesByTodo();

    // Overview (this window) + the pool of tasks completed in the window.
    let newCount = 0;
    const completed = [];
    for (const t of todos) {
      if (ms(t.created_at) >= cutoff) newCount++;
      if (t.status === "done" && t.completed_at && ms(t.completed_at) >= cutoff) completed.push(t);
    }

    // Per-bucket: how many finished, and the individual times spent in "Now"
    // (only counting the finished tasks that actually passed through "Now").
    // We keep the raw durations so we can take a median, not a mean.
    const perBucket = new Map(); // bucket_id -> {done, nowTimes: number[]}
    const allNowTimes = [];
    for (const t of completed) {
      const b = perBucket.get(t.bucket_id) || { done: 0, nowTimes: [] };
      b.done++;
      const inNow = timeInNow(t, changes.get(t.id) || []);
      if (inNow > 0) {
        b.nowTimes.push(inNow);
        allNowTimes.push(inNow);
      }
      perBucket.set(t.bucket_id, b);
    }

    // Metric 1 — completed by bucket, most first.
    const doneRows = [...perBucket.entries()]
      .filter(([, b]) => b.done > 0)
      .sort((a, b) => b[1].done - a[1].done)
      .map(([id, b]) => ({
        label: bucketName(buckets, id),
        value: b.done,
        valueText: `${b.done} ${b.done === 1 ? "task" : "tasks"}`,
      }));

    // Metric 2 — typical (median) time in "Now" by bucket, longest first.
    const nowRows = [...perBucket.entries()]
      .filter(([, b]) => b.nowTimes.length > 0)
      .map(([id, b]) => ({ id, med: median(b.nowTimes), n: b.nowTimes.length }))
      .sort((a, b) => b.med - a.med)
      .map((r) => ({
        label: bucketName(buckets, r.id),
        value: r.med,
        valueText: `${fmtDuration(r.med)} · ${r.n} ${r.n === 1 ? "task" : "tasks"}`,
      }));

    const medNow = median(allNowTimes);

    // Lifetime totals (period-independent), for context.
    const lifetimeDone = todos.filter((t) => t.status === "done").length;
    const lifetimeOpen = todos.length - lifetimeDone;

    const label = (PERIODS.find((p) => p.days === period) || {}).label || "";
    $("#analytics-body").html(`
      <div class="an-kpis">
        <div class="an-kpi">
          <div class="an-kpi-value">${newCount}</div>
          <div class="an-kpi-label">New tasks</div>
        </div>
        <div class="an-kpi">
          <div class="an-kpi-value">${completed.length}</div>
          <div class="an-kpi-label">Completed</div>
        </div>
        <div class="an-kpi">
          <div class="an-kpi-value">${esc(allNowTimes.length ? fmtDuration(medNow) : "—")}</div>
          <div class="an-kpi-label">Median time in Now</div>
        </div>
      </div>

      <h4 class="ui horizontal divider header"><i class="check circle icon"></i> Completed by bucket</h4>
      ${renderBars(doneRows, "an-fill-done", `No tasks completed in the ${label.toLowerCase()}.`)}

      <h4 class="ui horizontal divider header"><i class="hourglass half icon"></i> Median time in Now by bucket</h4>
      <p class="an-note">The typical (median) time finished tasks sat in the <em>Now</em> status before you completed them — a few tasks that lingered won't skew it.</p>
      ${renderBars(nowRows, "an-fill-now", "None of the completed tasks passed through Now.")}

      <h4 class="ui horizontal divider header"><i class="tasks icon"></i> Tasks by status &amp; bucket</h4>
      <p class="an-note">Where every task stands right now — a live snapshot, not limited to the window above.</p>
      ${renderStatusGrid(todos, buckets)}

      <h4 class="ui horizontal divider header"><i class="database icon"></i> All time</h4>
      <div class="an-kpis">
        <div class="an-kpi">
          <div class="an-kpi-value">${todos.length}</div>
          <div class="an-kpi-label">Tasks total</div>
        </div>
        <div class="an-kpi">
          <div class="an-kpi-value">${lifetimeDone}</div>
          <div class="an-kpi-label">Done</div>
        </div>
        <div class="an-kpi">
          <div class="an-kpi-value">${lifetimeOpen}</div>
          <div class="an-kpi-label">Still open</div>
        </div>
      </div>
    `);
  }

  function setPeriod(days) {
    period = Number(days) || 7;
    $("#analytics-periods .item").removeClass("active");
    $(`#analytics-periods .item[data-period="${period}"]`).addClass("active");
    render();
  }

  async function showAnalytics() {
    App.enterMainPanel("analytics");
    await render();
  }

  Object.assign(App, { showAnalytics, setAnalyticsPeriod: setPeriod });
})();
