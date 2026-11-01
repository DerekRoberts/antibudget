/** @typedef {{ canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null }} HistoryStatus */

/**
 * @param {HTMLElement} container
 */
export function mountHistoryControls(container) {
  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.id = "history-undo";
  undoBtn.textContent = "Undo";
  undoBtn.title = "Undo last change (Ctrl+Z)";

  const redoBtn = document.createElement("button");
  redoBtn.type = "button";
  redoBtn.id = "history-redo";
  redoBtn.textContent = "Redo";
  redoBtn.title = "Redo (Ctrl+Shift+Z or Ctrl+Y)";

  const hint = document.createElement("span");
  hint.className = "status history-hint";
  hint.id = "history-hint";

  container.classList.add("history-controls");
  container.append(undoBtn, redoBtn, hint);

  /** @type {HistoryStatus | null} */
  let lastStatus = null;

  async function refreshStatus() {
    const res = await fetch("/api/history/status");
    if (!res.ok) {
      return;
    }
    /** @type {HistoryStatus} */
    const status = await res.json();
    lastStatus = status;
    undoBtn.disabled = !status.canUndo;
    redoBtn.disabled = !status.canRedo;
    const parts = [];
    if (status.canUndo && status.undoLabel) {
      parts.push(`Undo: ${status.undoLabel}`);
    }
    if (status.canRedo && status.redoLabel) {
      parts.push(`Redo: ${status.redoLabel}`);
    }
    hint.textContent = parts.join(" · ");
  }

  async function postMutation(path) {
    const res = await fetch(path, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      window.alert(err.error ?? "History action failed");
      return null;
    }
    return /** @type {{ applied: boolean; kind: string | null; status: HistoryStatus }} */ (
      await res.json()
    );
  }

  async function runUndo() {
    const result = await postMutation("/api/history/undo");
    if (!result?.applied) {
      return;
    }
    await refreshStatus();
    window.dispatchEvent(
      new CustomEvent("antibudget:history-changed", { detail: { action: "undo", kind: result.kind } }),
    );
  }

  async function runRedo() {
    const result = await postMutation("/api/history/redo");
    if (!result?.applied) {
      return;
    }
    await refreshStatus();
    window.dispatchEvent(
      new CustomEvent("antibudget:history-changed", { detail: { action: "redo", kind: result.kind } }),
    );
  }

  undoBtn.addEventListener("click", () => {
    void runUndo();
  });
  redoBtn.addEventListener("click", () => {
    void runRedo();
  });

  window.addEventListener("keydown", (ev) => {
    if (!(ev.target instanceof HTMLElement)) {
      return;
    }
    const tag = ev.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ev.target.isContentEditable) {
      return;
    }
    const mod = ev.metaKey || ev.ctrlKey;
    if (!mod) {
      return;
    }
    const key = ev.key.toLowerCase();
    if (key === "z" && !ev.shiftKey) {
      ev.preventDefault();
      void runUndo();
      return;
    }
    if ((key === "z" && ev.shiftKey) || key === "y") {
      ev.preventDefault();
      void runRedo();
    }
  });

  window.addEventListener("antibudget:ingested", () => {
    void refreshStatus();
  });

  window.addEventListener("antibudget:history-changed", () => {
    void refreshStatus();
  });

  void refreshStatus();

  return {
    refreshStatus,
    getStatus: () => lastStatus,
  };
}
