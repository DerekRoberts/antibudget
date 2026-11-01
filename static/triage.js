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
    return;
  }
  await loadCategories();
  const row = select.closest("tr");
  row?.remove();
  updateCount();
}

function updateCount() {
  const tbody = document.getElementById("triage-body");
  const count = document.getElementById("count");
  const n = tbody?.querySelectorAll("tr").length ?? 0;
  if (count) count.textContent = `${n} uncategorized`;
}

async function loadTransactions() {
  const filter = document.getElementById("payee-filter");
  const params = new URLSearchParams();
  const q = filter instanceof HTMLInputElement ? filter.value.trim() : "";
  if (q) params.set("payee", q);
  const res = await fetch(`/api/transactions/uncategorized?${params}`);
  if (!res.ok) throw new Error("Failed to load transactions");
  const data = await res.json();
  const tbody = document.getElementById("triage-body");
  if (!tbody) return;
  tbody.replaceChildren();
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
}

init().catch((err) => {
  console.error(err);
  window.alert(String(err));
});
