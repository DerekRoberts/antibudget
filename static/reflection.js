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

async function loadNetWorth() {
  const res = await fetch("/api/reports/net-worth");
  if (!res.ok) throw new Error("net-worth failed");
  return res.json();
}

async function loadCashflow() {
  const res = await fetch("/api/reports/cashflow");
  if (!res.ok) throw new Error("cashflow failed");
  return res.json();
}

async function loadMonthly(month) {
  const params = month ? `?month=${encodeURIComponent(month)}` : "";
  const res = await fetch(`/api/reports/monthly${params}`);
  if (!res.ok) throw new Error("monthly failed");
  return res.json();
}

function renderCards(netWorth) {
  const root = document.getElementById("summary-cards");
  if (!root) return;
  root.replaceChildren();

  const nw = document.createElement("div");
  nw.className = "card";
  nw.innerHTML = `<h2>Net worth (ledger)</h2>`;
  const val = document.createElement("div");
  val.className = "value";
  if (netWorth.totalCents === null) {
    val.textContent = "—";
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "No ledger balances on accounts yet (OFX LEDGERBAL).";
    nw.appendChild(val);
    nw.appendChild(note);
  } else {
    val.textContent = formatCents(netWorth.totalCents);
    nw.appendChild(val);
  }
  root.appendChild(nw);

  const aom = document.createElement("div");
  aom.className = "card";
  aom.innerHTML = `<h2>Age of Money</h2>`;
  const aomVal = document.createElement("div");
  aomVal.className = "value";
  aomVal.textContent = netWorth.ageOfMoney.available ? "—" : "N/A";
  const aomNote = document.createElement("div");
  aomNote.className = "note";
  aomNote.textContent = netWorth.ageOfMoney.reason;
  aom.appendChild(aomVal);
  aom.appendChild(aomNote);
  root.appendChild(aom);
}

function renderCashflow(rows) {
  const root = document.getElementById("cashflow-chart");
  if (!root) return;
  root.replaceChildren();
  if (!rows.length) {
    root.textContent = "No data yet.";
    return;
  }
  const maxIncome = Math.max(...rows.map((r) => r.incomeCents), 1);
  const maxExpense = Math.max(...rows.map((r) => Math.abs(r.expenseCents)), 1);
  for (const row of rows) {
    const wrap = document.createElement("div");
    wrap.className = "bar-row";
    const monthLabel = document.createElement("span");
    monthLabel.textContent = row.month;
    wrap.appendChild(monthLabel);
    const track = document.createElement("div");
    track.className = "bar-track";
    const incomeBar = document.createElement("div");
    incomeBar.className = "bar-fill";
    incomeBar.style.width = `${(row.incomeCents / maxIncome) * 100}%`;
    incomeBar.title = `Income ${formatCents(row.incomeCents)}`;
    const expenseBar = document.createElement("div");
    expenseBar.className = "bar-fill expense";
    expenseBar.style.width = `${(Math.abs(row.expenseCents) / maxExpense) * 100}%`;
    expenseBar.title = `Expenses ${formatCents(row.expenseCents)}`;
    track.appendChild(incomeBar);
    track.appendChild(expenseBar);
    wrap.appendChild(track);
    const net = document.createElement("span");
    net.className = amountClass(row.netCents);
    net.textContent = formatCents(row.netCents);
    wrap.appendChild(net);
    root.appendChild(wrap);
  }
}

function renderMonthlyTable(rows) {
  const tbody = document.getElementById("monthly-body");
  if (!tbody) return;
  tbody.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement("tr");
    const cat = document.createElement("td");
    cat.textContent = row.categoryName ?? "(uncategorized)";
    const total = document.createElement("td");
    total.className = amountClass(row.totalCents);
    total.textContent = formatCents(row.totalCents);
    const count = document.createElement("td");
    count.textContent = String(row.transactionCount);
    tr.append(cat, total, count);
    tbody.appendChild(tr);
  }
}

/** Lightweight SVG links: Income column → category sinks for negative totals. */
function renderSankey(rows) {
  const svg = document.getElementById("sankey");
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const income = rows
    .filter((r) => r.totalCents > 0)
    .reduce((s, r) => s + r.totalCents, 0);
  const expenses = rows.filter((r) => r.totalCents < 0);
  if (income === 0 && expenses.length === 0) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", "12");
    t.setAttribute("y", "24");
    t.textContent = "No categorized flow for this month.";
    svg.appendChild(t);
    return;
  }

  const ns = "http://www.w3.org/2000/svg";
  const leftX = 20;
  const midX = 180;
  const rightX = 320;
  const top = 20;

  function rect(x, y, w, h, fill) {
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", String(x));
    r.setAttribute("y", String(y));
    r.setAttribute("width", String(w));
    r.setAttribute("height", String(h));
    r.setAttribute("fill", fill);
    r.setAttribute("rx", "3");
    svg.appendChild(r);
    return { x, y, w, h };
  }

  function path(d, opacity) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "#3366cc");
    p.setAttribute("opacity", String(opacity));
    svg.appendChild(p);
  }

  const hasIncome = income > 0;
  const incomeH = hasIncome ? Math.min(120, 40 + income / 5000) : 0;
  if (hasIncome) {
    rect(leftX, top, 36, incomeH, "#0a7a2f");
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", String(leftX));
    label.setAttribute("y", String(top + incomeH + 14));
    label.setAttribute("font-size", "11");
    label.textContent = "Inflow";
    svg.appendChild(label);
  }

  let y = top;
  const step = Math.min(28, Math.max(16, 180 / Math.max(expenses.length, 1)));
  for (const row of expenses) {
    const h = Math.min(step, Math.max(12, Math.abs(row.totalCents) / 800));
    rect(rightX, y, 36, h, "#b00020");
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", String(rightX + 42));
    t.setAttribute("y", String(y + h / 2 + 4));
    t.setAttribute("font-size", "10");
    t.textContent = (row.categoryName ?? "?").slice(0, 18);
    svg.appendChild(t);
    if (hasIncome) {
      const yMid = y + h / 2;
      path(
        `M ${leftX + 36} ${top + incomeH / 2} C ${midX} ${top + incomeH / 2}, ${midX} ${yMid}, ${rightX} ${yMid} L ${rightX} ${y + h} C ${midX} ${y + h}, ${midX} ${top + incomeH / 2}, ${leftX + 36} ${top + incomeH / 2} Z`,
        0.25,
      );
    }
    y += step;
  }
}

async function refreshMonth() {
  const picker = document.getElementById("month-picker");
  const month = picker instanceof HTMLInputElement ? picker.value : "";
  const data = await loadMonthly(month || undefined);
  renderMonthlyTable(data.rows);
  renderSankey(data.rows);
}

async function init() {
  const [netWorth, cashflow] = await Promise.all([loadNetWorth(), loadCashflow()]);
  renderCards(netWorth);
  renderCashflow(cashflow.rows);

  const picker = document.getElementById("month-picker");
  if (picker instanceof HTMLInputElement && cashflow.rows.length) {
    picker.value = cashflow.rows[cashflow.rows.length - 1].month;
  }
  document.getElementById("load-month")?.addEventListener("click", () => {
    refreshMonth().catch((err) => window.alert(String(err)));
  });
  await refreshMonth();
}

init().catch((err) => {
  console.error(err);
  window.alert(String(err));
});
