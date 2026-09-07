const API = {
  status: () => fetch("/api/scan/status").then((r) => r.json()),
  roots: () => fetch("/api/roots").then((r) => r.json()),
  deleteRoot: (root) => fetch(`/api/roots?root=${encodeURIComponent(root)}`, { method: "DELETE" }),
  years: (root) => fetch(`/api/years?root=${encodeURIComponent(root)}`).then((r) => r.json()),
  months: (root, year) => fetch(`/api/months?root=${encodeURIComponent(root)}&year=${year}`).then((r) => r.json()),
  days: (root, year, month) =>
    fetch(`/api/days?root=${encodeURIComponent(root)}&year=${year}&month=${month}`).then((r) => r.json()),
  files: (params) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") qs.set(k, v);
    });
    return fetch(`/api/files?${qs.toString()}`).then((r) => r.json());
  },
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const state = {
  root: null,
  level: "years", // years | months | days
  year: null,
  month: null,
  chart: null,
  currentFiles: [],
  filesQuery: { year: null, month: null, day: null, q: "", sort: "size", order: "desc", page: 1, page_size: 100 },
  filesMeta: { total: 0, total_pages: 1 },
};

// ---------- Persistent collapsible panels ----------

function initCollapsiblePanel(buttonId, contentId, storageKey, label, onExpand) {
  const button = document.getElementById(buttonId);
  const content = document.getElementById(contentId);
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(storageKey) === "collapsed";
  } catch (_) {
    // Controls remain usable when browser storage is unavailable.
  }
  function apply() {
    content.hidden = collapsed;
    button.setAttribute("aria-expanded", String(!collapsed));
    button.textContent = collapsed ? "\u2193" : "\u2191";
    button.setAttribute("aria-label", (collapsed ? "Expand " : "Collapse ") + label);
    button.title = (collapsed ? "Expand " : "Collapse ") + label;
    if (!collapsed && onExpand) requestAnimationFrame(onExpand);
  }
  button.addEventListener("click", () => {
    collapsed = !collapsed;
    try {
      localStorage.setItem(storageKey, collapsed ? "collapsed" : "expanded");
    } catch (_) {
      // Keep the current session usable even if persistence is blocked.
    }
    apply();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey || event.key === null) {
      collapsed = event.newValue === "collapsed";
      apply();
    }
  });
  apply();
}

initCollapsiblePanel("chartToggle", "chartContent", "diskuse.panel.chart", "storage chart",
  () => { if (state.chart) state.chart.resize(); });
initCollapsiblePanel("yearsToggle", "yearsContent", "diskuse.panel.years", "yearly usage");

// ---------- Appearance settings ----------

const settingsDialog = document.getElementById("settingsDialog");
const themeSelect = document.getElementById("themeSelect");
themeSelect.value = window.appTheme.preference;
document.getElementById("settingsBtn").addEventListener("click", () => settingsDialog.showModal());
themeSelect.addEventListener("change", () => {
  const saved = window.appTheme.set(themeSelect.value);
  document.getElementById("themeSaveError").classList.toggle("hidden", saved);
});

function chartColors() {
  const styles = getComputedStyle(document.documentElement);
  const color = (name) => styles.getPropertyValue(name).trim();
  return {
    text: color("--text"), muted: color("--text-muted"),
    accent: color("--accent"), hover: color("--accent-2"), grid: color("--grid"),
  };
}

window.addEventListener("themechange", () => {
  themeSelect.value = window.appTheme.preference;
  if (!state.chart) return;
  const colors = chartColors();
  state.chart.data.datasets[0].backgroundColor = colors.accent;
  state.chart.data.datasets[0].hoverBackgroundColor = colors.hover;
  state.chart.options.plugins.title.color = colors.text;
  for (const axis of Object.values(state.chart.options.scales)) {
    axis.ticks.color = colors.muted;
    axis.grid.color = colors.grid;
  }
  state.chart.update("none");
});

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Root management ----------

async function refreshRoots(selectRoot) {
  const roots = await API.roots();
  const select = document.getElementById("rootSelect");
  select.innerHTML = "";
  if (roots.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No scanned folders yet";
    opt.value = "";
    select.appendChild(opt);
    select.disabled = true;
    state.root = null;
    renderEmpty();
    return;
  }
  select.disabled = false;
  roots.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r.root;
    opt.textContent = `${r.root} (${formatBytes(r.total_size)}, ${r.file_count} files)`;
    select.appendChild(opt);
  });
  const target = selectRoot && roots.some((r) => r.root === selectRoot) ? selectRoot : roots[0].root;
  select.value = target;
  state.root = target;
  resetDrilldown();
  await loadYears();
}

function resetDrilldown() {
  state.level = "years";
  state.year = null;
  state.month = null;
  hideFiles();
  renderYearUsage([]);
}

// ---------- Chart / drilldown ----------

function renderEmpty() {
  renderYearUsage([]);
  hideFiles();
  document.getElementById("emptyState").classList.remove("hidden");
  document.getElementById("summaryCards").innerHTML = "";
  document.getElementById("breadcrumb").innerHTML = "";
  document.getElementById("viewActions").innerHTML = "";
  populateYearJump([]);
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
}

function renderSummary(rows, unitLabel) {
  const totalSize = rows.reduce((s, r) => s + r.total_size, 0);
  const totalFiles = rows.reduce((s, r) => s + r.file_count, 0);
  const busiest = rows.reduce((max, r) => (r.total_size > (max?.total_size ?? -1) ? r : max), null);
  const cards = document.getElementById("summaryCards");
  cards.innerHTML = "";
  const items = [
    { label: "Total Size", value: formatBytes(totalSize) },
    { label: "Total Files", value: totalFiles.toLocaleString() },
    {
      label: `Busiest ${unitLabel}`,
      value: busiest ? `${busiest.__label} · ${formatBytes(busiest.total_size)}` : "—",
      accent: true,
    },
  ];
  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="label">${item.label}</div><div class="value ${item.accent ? "accent" : ""}">${item.value}</div>`;
    cards.appendChild(card);
  });
}

function renderBreadcrumb() {
  const bc = document.getElementById("breadcrumb");
  bc.innerHTML = "";
  const crumbs = [{ label: "All Years", level: "years" }];
  if (state.year) crumbs.push({ label: state.year, level: "months" });
  if (state.month) crumbs.push({ label: MONTH_NAMES[parseInt(state.month, 10) - 1], level: "days" });

  crumbs.forEach((c, idx) => {
    if (idx > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "›";
      bc.appendChild(sep);
    }
    const btn = document.createElement("button");
    btn.textContent = c.label;
    const isCurrent = idx === crumbs.length - 1;
    if (isCurrent) btn.classList.add("current");
    else {
      btn.addEventListener("click", () => {
        if (c.level === "years") resetDrilldown();
        else if (c.level === "months") {
          state.level = "months";
          state.month = null;
        }
        hideFiles();
        renderCurrentLevel();
      });
    }
    bc.appendChild(btn);
  });
}

function renderViewActions() {
  const actions = document.getElementById("viewActions");
  actions.innerHTML = "";
  if (state.level === "days") {
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary";
    btn.textContent = "List all files this month";
    btn.addEventListener("click", () => showFiles(state.year, state.month, null));
    actions.appendChild(btn);
  }
}

function populateYearJump(years) {
  const select = document.getElementById("yearJumpSelect");
  const current = select.value;
  select.innerHTML = '<option value="">Select a year…</option>';
  years.forEach((year) => {
    const opt = document.createElement("option");
    opt.value = year;
    opt.textContent = year;
    select.appendChild(opt);
  });
  select.value = years.includes(current) ? current : "";
  updateYearNavigation();
}

function updateYearNavigation() {
  const select = document.getElementById("yearJumpSelect");
  const index = select.selectedIndex;
  document.getElementById("prevYearBtn").disabled = index <= 1;
  document.getElementById("nextYearBtn").disabled =
    index < 1 || index >= select.options.length - 1;
}

function stepYear(direction) {
  const select = document.getElementById("yearJumpSelect");
  const index = select.selectedIndex + direction;
  if (select.selectedIndex < 1 || index < 1 || index >= select.options.length) return;
  select.selectedIndex = index;
  showFiles(select.value, null, null);
}

function formatYearUsage(bytes) {
  const gb = 1024 ** 3;
  const value = bytes / (bytes >= gb ? gb : 1024 ** 2);
  if (bytes > 0 && value < 0.01) return "<" + (0.01).toLocaleString(undefined, { minimumFractionDigits: 2 }) + " MB";
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    + (bytes >= gb ? " GB" : " MB");
}

function renderYearUsage(rows) {
  const section = document.getElementById("yearUsageSection");
  const container = document.getElementById("yearUsageTables");
  container.replaceChildren();
  section.classList.toggle("hidden", rows.length === 0);
  document.getElementById("yearUsageCount").textContent =
    rows.length + (rows.length === 1 ? " year" : " years");
  // Use at most five balanced groups; extra years go to the first groups.
  const sorted = [...rows].sort((a, b) => Number(a.year) - Number(b.year));
  const groupCount = Math.min(5, Math.ceil(sorted.length / 8));
  const groupSize = groupCount ? Math.floor(sorted.length / groupCount) : 0;
  const remainder = groupCount ? sorted.length % groupCount : 0;
  let start = 0;
  for (let index = 0; index < groupCount; index++) {
    const size = groupSize + (index < remainder ? 1 : 0);
    const group = sorted.slice(start, start + size);
    start += size;
    const table = document.createElement("table");
    table.className = "year-usage-table";
    const caption = table.createCaption();
    caption.className = "sr-only";
    caption.textContent = "Storage by creation year, " + group[0].year + " to " + group[group.length - 1].year;
    const header = table.createTHead().insertRow();
    for (const title of ["Year", "Usage"]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = title;
      header.appendChild(th);
    }
    const body = table.createTBody();
    for (const row of group) {
      const tr = body.insertRow();
      const year = document.createElement("th");
      year.scope = "row";
      const button = document.createElement("button");
      button.className = "year-link";
      button.textContent = row.year;
      button.setAttribute("aria-label", "List files created in " + row.year);
      button.addEventListener("click", () => showFiles(row.year, null, null));
      year.appendChild(button);
      tr.appendChild(year);
      tr.insertCell().textContent = formatYearUsage(row.total_size);
    }
    container.appendChild(table);
  }
}

async function loadYears() {
  document.getElementById("emptyState").classList.add("hidden");
  const root = state.root;
  const rows = await API.years(root);
  if (root !== state.root) return;
  renderYearUsage(rows);
  rows.forEach((r) => (r.__label = r.year));
  populateYearJump(rows.map((r) => r.year));
  if (rows.length === 0) {
    renderEmpty();
    return;
  }
  renderSummary(rows, "Year");
  renderBreadcrumb();
  renderViewActions();
  drawChart(
    rows.map((r) => r.year),
    rows.map((r) => r.total_size),
    rows.map((r) => r.file_count),
    "Data created per year",
    (index) => {
      state.level = "months";
      state.year = rows[index].year;
      state.month = null;
      hideFiles();
      loadMonths();
    }
  );
}

async function loadMonths() {
  const rows = await API.months(state.root, state.year);
  rows.forEach((r) => (r.__label = MONTH_NAMES[parseInt(r.month, 10) - 1]));
  renderSummary(rows, "Month");
  renderBreadcrumb();
  renderViewActions();
  drawChart(
    rows.map((r) => MONTH_NAMES[parseInt(r.month, 10) - 1].slice(0, 3)),
    rows.map((r) => r.total_size),
    rows.map((r) => r.file_count),
    `Data created per month · ${state.year}`,
    (index) => {
      state.level = "days";
      state.month = rows[index].month;
      hideFiles();
      loadDays();
    }
  );
}

async function loadDays() {
  const rows = await API.days(state.root, state.year, state.month);
  rows.forEach((r) => (r.__label = r.date));
  renderSummary(rows, "Day");
  renderBreadcrumb();
  renderViewActions();
  drawChart(
    rows.map((r) => r.date.slice(8, 10)),
    rows.map((r) => r.total_size),
    rows.map((r) => r.file_count),
    `Data created per day · ${MONTH_NAMES[parseInt(state.month, 10) - 1]} ${state.year}`,
    (index) => {
      const day = rows[index].date.slice(8, 10);
      showFiles(state.year, state.month, day);
    }
  );
}

function renderCurrentLevel() {
  if (state.level === "years") loadYears();
  else if (state.level === "months") loadMonths();
  else loadDays();
}

function drawChart(labels, sizes, counts, title, onBarClick) {
  const colors = chartColors();
  document.getElementById("emptyState").classList.add("hidden");
  const ctx = document.getElementById("mainChart").getContext("2d");
  if (state.chart) state.chart.destroy();
  state.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Bytes created",
          data: sizes,
          backgroundColor: colors.accent,
          hoverBackgroundColor: colors.hover,
          borderRadius: 12,
          maxBarThickness: 46,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_evt, elements) => {
        if (elements.length > 0) onBarClick(elements[0].index);
      },
      plugins: {
        legend: { display: false },
        title: { display: true, text: title, color: colors.text, font: { size: 15 } },
        tooltip: {
          callbacks: {
            label: (item) => {
              const idx = item.dataIndex;
              return [`Size: ${formatBytes(sizes[idx])}`, `Files: ${counts[idx]}`];
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: colors.muted }, grid: { color: colors.grid } },
        y: {
          ticks: { color: colors.muted, callback: (v) => formatBytes(v) },
          grid: { color: colors.grid },
        },
      },
    },
  });
  document.getElementById("mainChart").style.cursor = "pointer";
}

// ---------- File listing ----------

async function showFiles(year, month, day) {
  document.getElementById("yearJumpSelect").value = year;
  updateYearNavigation();
  state.filesQuery = { year, month, day, q: "", sort: "size", order: "desc", page: 1, page_size: 100 };
  document.getElementById("fileFilter").value = "";
  document.getElementById("filesSection").classList.remove("hidden");
  await fetchFiles();
  document.getElementById("filesSection").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideFiles() {
  document.getElementById("filesSection").classList.add("hidden");
  state.currentFiles = [];
}

function filesTitleText() {
  const { year, month, day } = state.filesQuery;
  if (day) return `Files created on ${year}-${month}-${day}`;
  if (month) return `Files created in ${MONTH_NAMES[parseInt(month, 10) - 1]} ${year}`;
  return `Files created in ${year}`;
}

async function fetchFiles() {
  const root = state.root;
  const query = JSON.stringify(state.filesQuery);
  const data = await API.files({ root, ...state.filesQuery });
  if (root !== state.root || query !== JSON.stringify(state.filesQuery)) return;
  state.currentFiles = data.files || [];
  state.filesMeta = { total: data.total || 0, total_pages: data.total_pages || 1 };
  document.getElementById("filesTitle").textContent = `${filesTitleText()} (${state.filesMeta.total.toLocaleString()})`;
  renderFilesTable();
  renderPagination();
  updateSortHeaders();
}

function renderFilesTable() {
  const tbody = document.getElementById("filesTbody");
  tbody.innerHTML = state.currentFiles
    .map(
      (f) => `<tr data-path="${escapeHtml(f.path)}">
        <td>${escapeHtml(f.name)}</td>
        <td class="path-cell">${escapeHtml(f.path)}</td>
        <td class="size-cell">${formatBytes(f.size)}</td>
        <td>${escapeHtml(f.created_at)}</td>
      </tr>`
    )
    .join("");
}

function renderPagination() {
  document.getElementById("pageInfo").textContent = `Page ${state.filesQuery.page} of ${state.filesMeta.total_pages}`;
  document.getElementById("prevPageBtn").disabled = state.filesQuery.page <= 1;
  document.getElementById("nextPageBtn").disabled = state.filesQuery.page >= state.filesMeta.total_pages;
}

function updateSortHeaders() {
  document.querySelectorAll("#filesTable thead th").forEach((th) => {
    th.classList.toggle("sort-active", th.dataset.sort === state.filesQuery.sort);
  });
}

document.querySelectorAll("#filesTable thead th").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.filesQuery.sort === key) {
      state.filesQuery.order = state.filesQuery.order === "asc" ? "desc" : "asc";
    } else {
      state.filesQuery.sort = key;
      state.filesQuery.order = "asc";
    }
    state.filesQuery.page = 1;
    fetchFiles();
  });
});

let fileFilterDebounce = null;
document.getElementById("fileFilter").addEventListener("input", (e) => {
  clearTimeout(fileFilterDebounce);
  const value = e.target.value;
  fileFilterDebounce = setTimeout(() => {
    state.filesQuery.q = value.trim();
    state.filesQuery.page = 1;
    fetchFiles();
  }, 300);
});

document.getElementById("prevPageBtn").addEventListener("click", () => {
  if (state.filesQuery.page > 1) {
    state.filesQuery.page -= 1;
    fetchFiles();
  }
});
document.getElementById("nextPageBtn").addEventListener("click", () => {
  if (state.filesQuery.page < state.filesMeta.total_pages) {
    state.filesQuery.page += 1;
    fetchFiles();
  }
});

document.getElementById("yearJumpSelect").addEventListener("change", (e) => {
  const year = e.target.value;
  updateYearNavigation();
  if (year) showFiles(year, null, null);
  else hideFiles();
});

document.getElementById("prevYearBtn").addEventListener("click", () => stepYear(-1));
document.getElementById("nextYearBtn").addEventListener("click", () => stepYear(1));

// ---------- HTML report export ----------

const exportDialog = document.getElementById("exportDialog");
let exportSelection = null;
let exportInProgress = false;
document.getElementById("exportBtn").addEventListener("click", () => {
  if (!state.root || !state.filesQuery.year) return;
  // Capture the selection when opening the dialog, including a just-typed filter.
  clearTimeout(fileFilterDebounce);
  state.filesQuery.q = document.getElementById("fileFilter").value.trim();
  state.filesQuery.page = 1;
  fetchFiles();
  exportSelection = { root: state.root, ...state.filesQuery };
  document.getElementById("exportScope").textContent =
    filesTitleText() + (exportSelection.q ? " | Filter: " + exportSelection.q : "");
  const sort = state.filesQuery.sort;
  document.getElementById("exportOrder").value =
    sort === "created_at" ? "date_" + state.filesQuery.order :
    sort === "path" ? "tree" :
    sort === "size" ? "size_" + state.filesQuery.order : "size_desc";
  document.getElementById("exportError").classList.add("hidden");
  document.getElementById("exportStatus").textContent = "";
  exportDialog.showModal();
});
document.getElementById("exportCancelBtn").addEventListener("click", () => exportDialog.close());
exportDialog.addEventListener("cancel", (event) => {
  if (exportInProgress) event.preventDefault();
});
document.getElementById("exportDownloadBtn").addEventListener("click", async () => {
  if (!exportSelection || exportInProgress) return;
  const button = document.getElementById("exportDownloadBtn");
  const cancel = document.getElementById("exportCancelBtn");
  const order = document.getElementById("exportOrder");
  const error = document.getElementById("exportError");
  const status = document.getElementById("exportStatus");
  exportInProgress = true;
  button.disabled = cancel.disabled = order.disabled = true;
  error.classList.add("hidden");
  status.textContent = "Preparing report...";
  try {
    const params = new URLSearchParams();
    for (const key of ["root", "year", "month", "day", "q"]) {
      if (exportSelection[key]) params.set(key, exportSelection[key]);
    }
    params.set("organization", order.value);
    const response = await fetch("/api/files/export?" + params);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Could not generate the report.");
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "DiskUsePerDay-" +
      [exportSelection.year, exportSelection.month, exportSelection.day].filter(Boolean).join("-") +
      "-" + order.value + ".html";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    exportDialog.close();
  } catch (err) {
    error.textContent = err.message || "Could not download the report.";
    error.classList.remove("hidden");
  } finally {
    exportInProgress = false;
    button.disabled = cancel.disabled = order.disabled = false;
    status.textContent = "";
  }
});

// ---------- Context menu (open file / open containing folder) ----------

const contextMenu = document.getElementById("fileContextMenu");
let contextMenuPath = null;

document.getElementById("filesTbody").addEventListener("contextmenu", (e) => {
  const row = e.target.closest("tr[data-path]");
  if (!row) return;
  e.preventDefault();
  contextMenuPath = row.dataset.path;
  const maxX = window.innerWidth - contextMenu.offsetWidth - 8;
  const maxY = window.innerHeight - contextMenu.offsetHeight - 8;
  contextMenu.style.left = `${Math.min(e.clientX, maxX)}px`;
  contextMenu.style.top = `${Math.min(e.clientY, maxY)}px`;
  contextMenu.classList.remove("hidden");
});

document.addEventListener("click", () => contextMenu.classList.add("hidden"));
document.addEventListener("scroll", () => contextMenu.classList.add("hidden"), true);
window.addEventListener("resize", () => contextMenu.classList.add("hidden"));

async function openPath(action) {
  contextMenu.classList.add("hidden");
  if (!contextMenuPath) return;
  const res = await fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: contextMenuPath, action }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || "Could not open path");
  }
}

document.getElementById("ctxOpenFile").addEventListener("click", () => openPath("file"));
document.getElementById("ctxOpenFolder").addEventListener("click", () => openPath("folder"));

// ---------- Scan modal ----------

const modal = document.getElementById("scanModal");

function openModal() {
  modal.classList.remove("hidden");
  document.getElementById("scanError").classList.add("hidden");
  document.getElementById("scanProgress").classList.add("hidden");
  document.getElementById("scanPathInput").disabled = false;
  document.getElementById("scanStartBtn").disabled = false;
}
function closeModal() {
  modal.classList.add("hidden");
}

document.getElementById("scanBtn").addEventListener("click", openModal);
document.getElementById("scanCancelBtn").addEventListener("click", closeModal);

document.getElementById("rescanBtn").addEventListener("click", () => {
  if (!state.root) return;
  openModal();
  document.getElementById("scanPathInput").value = state.root;
  startScanImpl(state.root);
});

document.getElementById("deleteRootBtn").addEventListener("click", async () => {
  if (!state.root) return;
  if (!confirm(`Forget scanned data for:\n${state.root}?`)) return;
  await API.deleteRoot(state.root);
  await refreshRoots();
});

document.getElementById("rootSelect").addEventListener("change", async (e) => {
  state.root = e.target.value;
  resetDrilldown();
  await loadYears();
});

document.getElementById("scanStartBtn").addEventListener("click", () => {
  const path = document.getElementById("scanPathInput").value.trim();
  if (!path) return;
  startScanImpl(path);
});

async function startScanImpl(path) {
  const errEl = document.getElementById("scanError");
  errEl.classList.add("hidden");
  document.getElementById("scanPathInput").disabled = true;
  document.getElementById("scanStartBtn").disabled = true;
  document.getElementById("scanProgress").classList.remove("hidden");

  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const data = await res.json();
  if (!res.ok) {
    errEl.textContent = data.error || "Failed to start scan";
    errEl.classList.remove("hidden");
    document.getElementById("scanProgress").classList.add("hidden");
    document.getElementById("scanPathInput").disabled = false;
    document.getElementById("scanStartBtn").disabled = false;
    return;
  }
  pollStatus(data.root);
}

async function pollStatus(root) {
  const text = document.getElementById("scanProgressText");
  const poll = async () => {
    const status = await API.status();
    if (status.error) {
      document.getElementById("scanError").textContent = status.error;
      document.getElementById("scanError").classList.remove("hidden");
      document.getElementById("scanProgress").classList.add("hidden");
      document.getElementById("scanPathInput").disabled = false;
      document.getElementById("scanStartBtn").disabled = false;
      return;
    }
    text.textContent = `Scanning… ${status.scanned.toLocaleString()} files (${formatBytes(status.total_size)})`;
    if (status.running) {
      setTimeout(poll, 500);
    } else if (status.done) {
      closeModal();
      await refreshRoots(root);
    }
  };
  poll();
}

// ---------- Init ----------

refreshRoots();

// Resume in-progress scan if the page was reloaded mid-scan.
(async () => {
  const status = await API.status();
  if (status.running) {
    openModal();
    document.getElementById("scanPathInput").value = status.root;
    document.getElementById("scanPathInput").disabled = true;
    document.getElementById("scanStartBtn").disabled = true;
    document.getElementById("scanProgress").classList.remove("hidden");
    pollStatus(status.root);
  }
})();
