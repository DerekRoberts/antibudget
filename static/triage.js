function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars}.${String(remainder).padStart(2, "0")}`;
}

function amountClass(cents) {
  return cents < 0 ? "amount-negative" : "amount-positive";
}

/** @type {{ id: number; name: string }[]} */
let categories = [];

async function loadCategories() {
  const res = await fetch("/api/categories");
  if (!res.ok) throw new Error("Failed to load categories");
  const data = await res.json();
  categories = data.categories;
}

function categorySelect(acctId, fitid, selectedName) {
  const select = document.createElement("select");
  select.dataset.acctId = acctId;
  select.dataset.fitid = fitid;
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "(choose)";
  select.appendChild(blank);
  for (const cat of categories) {
    const opt = document.createElement("option");
    opt.value = cat.name;
    opt.textContent = cat.name;
    if (cat.name === selectedName) opt.selected = true;
    select.appendChild(opt);
  }
  const custom = document.createElement("option");
  custom.value = "__new__";
  custom.textContent = "New category…";
  select.appendChild(custom);
  select.addEventListener("change", () => onCategoryChange(select));
  return select;
}

async function onCategoryChange(select) {
  let name = select.value;
  if (name === "__new__") {
    const entered = window.prompt("Category name");
    if (!entered?.trim()) {
      select.value = "";
      return;
    }
    name = entered.trim();
  }
  if (!name) return;

  const body = {
    acctId: select.dataset.acctId,
    fitid: select.dataset.fitid,
    categoryName: name,
  };
  const res = await fetch("/api/transactions/category", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    window.alert(err.error ?? "Update failed");
    select.value = "";
    return;
  }
  const row = select.closest("tr");
  row?.remove();
  updateCount();
  void loadCategories().catch(() => {});
}

function updateCount() {
  const tbody = document.getElementById("triage-body");
  const count = document.getElementById("count");
  const n =
    tbody?.querySelectorAll("tr:not([data-placeholder])").length ?? 0;
  if (count) count.textContent = `${n} uncategorized`;
}

/** @type {number} */
let loadGeneration = 0;

function emptyUncategorizedMessage(payeeFilter, transactionCount) {
  if (payeeFilter) {
    return "No uncategorized transactions match this payee filter.";
  }
  if (transactionCount === 0) {
    return "No transactions yet. Drop .ofx or .qfx exports above to import, then triage here.";
  }
  return "No uncategorized transactions — everything in the ledger is categorized.";
}

async function ledgerTransactionCount() {
  const { fetchLedgerTransactionCount } = await import("/ingest-drop.js");
  return fetchLedgerTransactionCount();
}

async function syncEmptyLedgerDropZone(transactionCount) {
  const wrap = document.getElementById("ingest-drop-wrap");
  if (!wrap) return;
  if (transactionCount === 0) {
    wrap.hidden = false;
    if (!wrap.dataset.mounted) {
      const { mountIngestDropZone } = await import("/ingest-drop.js");
      mountIngestDropZone(wrap, { compact: true });
      wrap.dataset.mounted = "true";
    }
  } else {
    wrap.hidden = true;
  }
}

async function loadTransactions() {
  const generation = ++loadGeneration;
  const filter = document.getElementById("payee-filter");
  const params = new URLSearchParams();
  const q = filter instanceof HTMLInputElement ? filter.value.trim() : "";
  if (q) params.set("payee", q);
  const res = await fetch(`/api/transactions/uncategorized?${params}`);
  if (!res.ok) throw new Error("Failed to load transactions");
  const data = await res.json();
  if (generation !== loadGeneration) {
    return;
  }
  const tbody = document.getElementById("triage-body");
  if (!tbody) return;
  tbody.replaceChildren();
  if (data.transactions.length === 0) {
    const tr = document.createElement("tr");
    tr.dataset.placeholder = "true";
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "status";
    if (q) {
      td.textContent = emptyUncategorizedMessage(q, 0);
    } else {
      const transactionCount = await ledgerTransactionCount();
      if (generation !== loadGeneration) {
        return;
      }
      if (transactionCount !== null) {
        await syncEmptyLedgerDropZone(transactionCount);
      }
      if (generation !== loadGeneration) {
        return;
      }
      td.textContent =
        transactionCount === null
          ? "No uncategorized transactions to show."
          : emptyUncategorizedMessage(null, transactionCount);
    }
    tr.appendChild(td);
    tbody.appendChild(tr);
    updateCount();
    return;
  }
  const wrap = document.getElementById("ingest-drop-wrap");
  if (wrap) wrap.hidden = true;
  for (const tx of data.transactions) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${tx.postedAt.slice(0, 10)}</td>
      <td>${escapeHtml(tx.payee ?? "")}</td>
      <td>${escapeHtml(tx.memo ?? "")}</td>
      <td class="${amountClass(tx.amountCents)}">${formatCents(tx.amountCents)}</td>
    `;
    const td = document.createElement("td");
    td.appendChild(categorySelect(tx.acctId, tx.fitid, null));
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  updateCount();
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function init() {
  await loadCategories();
  await loadTransactions();
  document.getElementById("reload")?.addEventListener("click", () => {
    void loadTransactions();
  });
  document.getElementById("payee-filter")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void loadTransactions();
  });
  window.addEventListener("antibudget:ingested", () => {
    void loadCategories()
      .then(() => loadTransactions())
      .catch((err) => {
        console.error(err);
        window.alert(String(err));
      });
  });
}

init().catch((err) => {
  console.error(err);
  window.alert(String(err));
});
