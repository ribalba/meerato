/* Local-first sync engine. Exposed as window.Sync.
 *
 * Every change goes through Sync.mutate(): it (1) writes optimistically to
 * IndexedDB, (2) appends a mutation to the queue, (3) best-effort flushes to the
 * server. flush() pushes the queue then pulls server deltas. Conflicts resolve
 * last-write-wins on updated_at (enforced server-side). */
(function () {
  const listeners = new Set();
  let flushing = false;

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  const STORE_FOR = { bucket: "buckets", todo: "todos", comment: "events" };

  /* A change the server *refuses* — bad data, not a bad connection — will be refused
   * again on every retry. Left alone, the 30s catch-up loop resends it forever: the
   * pending badge never clears and nothing ever says why. After this many rejections
   * the op is parked instead, and the UI offers to retry or discard it. */
  const MAX_PUSH_ATTEMPTS = 3;

  function emit() {
    listeners.forEach((fn) => {
      try { fn(); } catch (e) { console.error(e); }
    });
  }

  async function localApply(entity, action, id, data) {
    const store = STORE_FOR[entity];
    if (action === "delete") {
      const existing = await DB.get(store, id);
      if (existing) await DB.put(store, { ...existing, deleted: true });
      return;
    }
    const existing = (await DB.get(store, id)) || { id };
    await DB.put(store, { ...existing, ...data, id });
  }

  /* Make a change locally + queue it for the server. Returns the entity id. */
  async function mutate(entity, action, id, data) {
    id = id || uuid();
    const updated_at = new Date().toISOString();
    await localApply(entity, action, id, { ...data, updated_at });
    await DB.enqueue({
      op_id: uuid(),
      entity,
      action,
      id,
      updated_at,
      data: data || {},
    });
    emit();
    flush(); // fire and forget
    return id;
  }

  /* Push the queue, then pull server deltas. Never throws — it reports instead, so
   * a caller can tell "everything is up to date" from "the server refused something":
   *   ok      reached the server at all (false = offline or the request failed)
   *   synced  ops the server accepted this round
   *   parked  ops now set aside after too many rejections (queue-wide, not this round)
   *   detail  the server's reason for the most recent rejection, if there was one
   *   busy    a flush was already in flight, so this call did nothing */
  async function flush() {
    if (flushing) return { ok: true, busy: true, synced: 0, parked: await blockedCount(), detail: null };
    if (!navigator.onLine) return { ok: false, busy: false, synced: 0, parked: await blockedCount(), detail: null };
    flushing = true;
    let synced = 0;
    let detail = null;
    try {
      const ready = (await DB.queued()).filter((m) => !m.blocked);
      if (ready.length) {
        const mutations = ready.map(({ op_id, entity, action, id, updated_at, data }) => ({
          op_id, entity, action, id, updated_at, data,
        }));
        const resp = await API.post("/api/sync/push", { mutations });
        for (const r of resp.results) {
          if (r.status !== "error") {
            await DB.dequeue(r.op_id);
            synced += 1;
            continue;
          }
          detail = r.detail || "The server rejected this change.";
          await recordRejection(r.op_id, detail);
        }
      }
      await pull();
      emit();
      return { ok: true, busy: false, synced, parked: await blockedCount(), detail };
    } catch (e) {
      // Offline or server error: leave the queue intact and try again later. This is
      // the transport failing, not the server refusing a particular change, so it
      // costs no op its attempt budget.
      console.debug("flush deferred:", e);
      emit();
      return { ok: false, busy: false, synced, parked: await blockedCount(), detail: null };
    } finally {
      flushing = false;
    }
  }

  /* Count a rejection against an op and park it once it has used up its attempts.
   * A parked op stays in the queue but is never sent again until the user retries
   * it — see MAX_PUSH_ATTEMPTS. */
  async function recordRejection(op_id, detail) {
    const row = await DB.get("queue", op_id);
    if (!row) return;
    const attempts = (row.attempts || 0) + 1;
    await DB.put("queue", { ...row, attempts, last_error: detail, blocked: attempts >= MAX_PUSH_ATTEMPTS });
  }

  const blockedOps = async () => (await DB.queued()).filter((m) => m.blocked);
  const blockedCount = async () => (await blockedOps()).length;

  /* Un-park everything and try again — for a rejection that was fixable outside the
   * data itself (a server-side limit that has since been raised, a permission granted). */
  async function retryBlocked() {
    for (const m of await blockedOps()) {
      await DB.put("queue", { ...m, blocked: false, attempts: 0, last_error: null });
    }
    emit();
    return flush();
  }

  /* Stop trying to send the parked ops. This is not an undo: the local mirror keeps
   * whatever they wrote, so the change lives on this device until a full resync
   * replaces it with the server's version. */
  async function discardBlocked() {
    for (const m of await blockedOps()) await DB.dequeue(m.op_id);
    emit();
  }

  async function pull() {
    const since = await DB.getMeta("last_sync", null);
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    const data = await API.get(`/api/sync/pull${qs}`);
    const changed = data.buckets.length || data.todos.length || data.events.length;
    if (data.buckets.length) await DB.bulkPut("buckets", data.buckets);
    if (data.todos.length) await DB.bulkPut("todos", data.todos);
    if (data.events.length) await DB.bulkPut("events", data.events);
    await DB.setMeta("last_sync", data.server_time);
    // Notify the UI so views re-render after a standalone pull (e.g. adding a
    // watcher or uploading a file, which bypass the local mutation queue).
    if (changed) emit();
  }

  async function fullResync() {
    await DB.setMeta("last_sync", null);
    await DB.clear("buckets");
    await DB.clear("todos");
    await DB.clear("events");
    await flush();
  }

  const Sync = {
    uuid,
    mutate,
    flush,
    pull,
    fullResync,
    retryBlocked,
    discardBlocked,
    blockedOps,
    blockedCount,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    pendingCount: async () => (await DB.queued()).length,
    // Ops still worth sending. Callers waiting for the queue to drain want this
    // rather than pendingCount, which a parked op would hold above zero forever.
    readyCount: async () => (await DB.queued()).filter((m) => !m.blocked).length,
    start() {
      window.addEventListener("online", () => { emit(); flush(); });
      window.addEventListener("offline", emit);
      setInterval(() => flush(), 30000); // periodic catch-up
    },
  };

  window.Sync = Sync;
})();
