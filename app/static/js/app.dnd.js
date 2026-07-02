/* Drag-and-drop for the task tree.
 *
 * Two gestures, one mechanism:
 *   - Reorder: drag a task within its sibling list to change its `position`.
 *   - Nest / move subtask: drop a task into another task's indent zone to set its
 *     `parent_id` (a subtask here is just a task whose parent_id points at another).
 *
 * The root list (#todo-list) and every .todo-children container are made into
 * SortableJS lists sharing one group, so a node can move within a level or across
 * levels. Dragging a node carries its whole subtree with it (the descendants live
 * inside the moved DOM element), which also makes it impossible to drop a node into
 * its own descendant.
 *
 * On drop we compute a single new position from the DOM neighbours (their midpoint,
 * so a reorder is normally one mutation) plus a parent_id when the parent changed,
 * and push it through the offline-capable Sync queue. The subsequent re-render
 * (Sync.onChange) reconciles the DOM from IndexedDB and we re-init the lists. */
(function () {
  "use strict";

  const App = window.App;

  // Spacing between generated positions. Large so midpoint inserts keep integer
  // room for a very long time; the renumber() fallback covers the rare exhaustion.
  const STEP = 1 << 20; // 1,048,576

  let instances = [];

  function destroy() {
    instances.forEach((s) => {
      try { s.destroy(); } catch (e) { /* already gone */ }
    });
    instances = [];
  }

  // The parent_id a container represents. #todo-list (the root list) has no
  // data-parent, so its tasks are top-level (parent_id = null).
  function parentOf(container) {
    const p = container && container.getAttribute("data-parent");
    return p || null;
  }

  function initTaskDnd(enabled) {
    destroy();
    if (!enabled || typeof window.Sortable === "undefined") return;
    const root = document.getElementById("todo-list");
    if (!root) return;

    const containers = [root, ...root.querySelectorAll(".todo-children")];
    containers.forEach((c) => {
      instances.push(
        window.Sortable.create(c, {
          group: "tasks",
          handle: ".drag-handle",
          draggable: ".todo-node",
          animation: 150,
          fallbackOnBody: true,
          swapThreshold: 0.65,
          // Let a task drop into an empty .todo-children zone (create a subtask)
          // even though that zone is only a couple of pixels tall.
          emptyInsertThreshold: 14,
          ghostClass: "todo-drag-ghost",
          chosenClass: "todo-drag-chosen",
          onStart: () => root.classList.add("dnd-active"),
          onEnd: onEnd,
        })
      );
    });
  }

  async function onEnd(evt) {
    const root = document.getElementById("todo-list");
    if (root) root.classList.remove("dnd-active");

    const node = evt.item;
    const id = node.getAttribute("data-id");
    if (!id) return;
    // Dropped exactly where it started — nothing to persist.
    if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;

    const newParent = parentOf(evt.to);
    // Guard against ever making a node its own ancestor. SortableJS shouldn't allow
    // it (the target lives inside the moved element), but never corrupt the tree.
    if (newParent === id || node.contains(evt.to)) return;

    const todos = await App.liveTodos();
    const byId = new Map(todos.map((t) => [t.id, t]));
    const moved = byId.get(id);
    if (!moved) return;

    const siblingPos = (sib) => {
      if (!sib || !sib.classList || !sib.classList.contains("todo-node")) return null;
      const t = byId.get(sib.getAttribute("data-id"));
      return t ? (t.position || 0) : null;
    };
    const prevPos = siblingPos(node.previousElementSibling);
    const nextPos = siblingPos(node.nextElementSibling);

    let position;
    if (prevPos != null && nextPos != null) {
      // No integer room between neighbours: rewrite the whole group evenly.
      if (nextPos - prevPos <= 1) return renumber(evt.to, byId);
      position = Math.floor((prevPos + nextPos) / 2);
    } else if (nextPos != null) {
      position = nextPos - STEP; // dropped at the top
    } else if (prevPos != null) {
      position = prevPos + STEP; // dropped at the bottom
    } else {
      position = STEP; // now the only task in this list
    }

    const data = { position };
    if ((moved.parent_id || null) !== newParent) data.parent_id = newParent;
    if (data.position === (moved.position || 0) && !("parent_id" in data)) return;

    await Sync.mutate("todo", "update", id, data);
  }

  // Fallback for the rare case where neighbours leave no integer gap: reassign
  // evenly spaced positions to the target group and push one mutation per change.
  async function renumber(container, byId) {
    const parent = parentOf(container);
    const nodes = [...container.children].filter(
      (n) => n.classList && n.classList.contains("todo-node")
    );
    let pos = STEP;
    for (const n of nodes) {
      const tid = n.getAttribute("data-id");
      const t = byId.get(tid);
      const data = {};
      if (t && (t.position || 0) !== pos) data.position = pos;
      if (t && (t.parent_id || null) !== parent) data.parent_id = parent;
      if (Object.keys(data).length) await Sync.mutate("todo", "update", tid, data);
      pos += STEP;
    }
  }

  Object.assign(App, { initTaskDnd, destroyTaskDnd: destroy });
})();
