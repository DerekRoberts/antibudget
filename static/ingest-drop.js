/**
 * Drag-and-drop OFX/QFX upload. Dispatches `antibudget:ingested` on success.
 * @param {HTMLElement} root
 * @param {{ compact?: boolean }} [options]
 */
export function mountIngestDropZone(root, options = {}) {
  const zone = document.createElement("div");
  zone.className = options.compact ? "drop-zone drop-zone-compact" : "drop-zone";
  zone.tabIndex = 0;
  zone.setAttribute("role", "button");
  zone.setAttribute("aria-label", "Drop OFX or QFX bank export files to import");

  const label = document.createElement("p");
  label.className = "drop-zone-label";
  label.textContent = options.compact
    ? "Drop .ofx / .qfx files here to import"
    : "Drop bank .ofx or .qfx exports here (multiple files OK)";
  zone.appendChild(label);

  const status = document.createElement("p");
  status.className = "status drop-zone-status";
  status.hidden = true;
  zone.appendChild(status);

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".ofx,.qfx,application/x-ofx,application/vnd.intu.qfx";
  input.multiple = true;
  input.hidden = true;
  zone.appendChild(input);

  let busy = false;

  function setStatus(text, isError) {
    status.hidden = !text;
    status.textContent = text;
    status.classList.toggle("drop-zone-error", Boolean(isError));
  }

  async function uploadFiles(fileList) {
    if (busy || !fileList?.length) {
      return;
    }
    const files = [...fileList].filter((f) => /\.(ofx|qfx)$/i.test(f.name));
    if (files.length === 0) {
      setStatus("Only .ofx and .qfx files are accepted.", true);
      return;
    }
    if (files.length !== fileList.length) {
      setStatus("Some files were skipped (only .ofx / .qfx are imported).", true);
    } else {
      setStatus("Importing…", false);
    }
    busy = true;
    zone.classList.add("drop-zone-busy");
    try {
      const form = new FormData();
      for (const file of files) {
        form.append("files", file, file.name);
      }
      const res = await fetch("/api/ingest/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(data.error ?? "Import failed", true);
        return;
      }
      const inserted = data.transactionsInserted ?? 0;
      const skipped = data.transactionsSkipped ?? 0;
      const processed = data.filesProcessed ?? 0;
      setStatus(
        `Imported ${processed} file(s): ${inserted} new transaction(s), ${skipped} duplicate(s).`,
        false,
      );
      window.dispatchEvent(new CustomEvent("antibudget:ingested", { detail: data }));
    } catch (err) {
      setStatus(String(err), true);
    } finally {
      busy = false;
      zone.classList.remove("drop-zone-busy");
    }
  }

  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => {
    void uploadFiles(input.files);
    input.value = "";
  });

  for (const eventName of ["dragenter", "dragover"]) {
    zone.addEventListener(eventName, (ev) => {
      ev.preventDefault();
      zone.classList.add("drop-zone-active");
    });
  }
  zone.addEventListener("dragleave", (ev) => {
    if (ev.target === zone) {
      zone.classList.remove("drop-zone-active");
    }
  });
  zone.addEventListener("drop", (ev) => {
    ev.preventDefault();
    zone.classList.remove("drop-zone-active");
    void uploadFiles(ev.dataTransfer?.files);
  });

  root.replaceChildren(zone);
  return zone;
}

export async function fetchLedgerTransactionCount() {
  try {
    const res = await fetch("/api/ledger/meta");
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return typeof data.transactionCount === "number" ? data.transactionCount : null;
  } catch {
    return null;
  }
}
