/* FPL Team Builder - UI wiring. Loads players.json, runs the two squad
 * strategies from optimizer.js, and renders the pitch views + player table. */

const state = { players: [], meta: null, valueResult: null, xiResult: null };

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

async function loadData() {
  const [players, meta] = await Promise.all([
    fetch("data/players.json").then((r) => r.json()),
    fetch("data/meta.json").then((r) => r.json()),
  ]);
  state.players = players;
  state.meta = meta;
  $("#metaLine").textContent =
    `${meta.player_count} players • current: ${meta.current_season} • ` +
    `last season points from ${meta.last_season} (2nd half = ${meta.half_split.split(" vs ")[1]})`;
}

function usablePlayers() {
  return state.players.filter((p) => p.status !== "u");
}

function chip(p, statKey, statLabel) {
  const c = el("div", "player-chip");
  const posBadge = el("span", `pos-badge ${p.position}`, p.position);
  c.appendChild(posBadge);
  c.appendChild(el("span", "pname", p.web_name));
  c.appendChild(el("span", "pclub", `${p.team_short} £${p.now_cost.toFixed(1)}m`));
  c.appendChild(el("span", "pstat", `${p[statKey]} ${statLabel}`));
  return c;
}

function renderPitch(container, byPosition, statKey, statLabel) {
  container.innerHTML = "";
  const order = ["GK", "DEF", "MID", "FWD"];
  for (const pos of order) {
    const players = byPosition[pos] || [];
    if (!players.length) continue;
    const row = el("div", "pitch-row");
    for (const p of players) row.appendChild(chip(p, statKey, statLabel));
    container.appendChild(row);
  }
}

function renderBench(container, benchPlayers) {
  container.innerHTML = "";
  for (const p of benchPlayers) container.appendChild(chip(p, "now_cost", ""));
}

function summaryStat(val, lbl) {
  const s = el("div", "summary-stat");
  s.appendChild(el("span", "val", val));
  s.appendChild(el("span", "lbl", lbl));
  return s;
}

function renderValueSquad(result) {
  const summary = $("#valueSummary");
  summary.innerHTML = "";
  summary.appendChild(summaryStat(`£${result.totalCost.toFixed(1)}m`, "Total cost"));
  summary.appendChild(summaryStat(result.totalPoints, "Total pts (last szn)"));
  summary.appendChild(summaryStat((result.totalPoints / result.totalCost).toFixed(1), "Pts per £m"));
  renderPitch($("#valuePitch"), result.byPosition, "last_season_points", "pts");
}

function renderXISquad(result) {
  const summary = $("#xiSummary");
  summary.innerHTML = "";
  summary.appendChild(summaryStat(result.formation, "Formation"));
  summary.appendChild(summaryStat(`£${result.totalCost.toFixed(1)}m`, "Squad cost"));
  summary.appendChild(summaryStat(result.xiPoints, "XI pts (last szn)"));
  summary.appendChild(summaryStat(`£${result.benchCost.toFixed(1)}m`, "Bench cost"));
  renderPitch($("#xiPitch"), result.byPosition.starters, "last_season_points", "pts");
  renderBench($("#xiBench"), result.byPosition.bench.GK
    .concat(result.byPosition.bench.DEF, result.byPosition.bench.MID, result.byPosition.bench.FWD));
}

function rebuildTeams() {
  const budget = parseFloat($("#budgetInput").value) || 100.0;
  const statusMsg = $("#statusMsg");
  statusMsg.textContent = "Solving…";
  setTimeout(() => {
    try {
      const pool = usablePlayers();
      const valueResult = buildValueSquad(pool, budget);
      const xiResult = buildStartingXIsquad(pool, budget);
      state.valueResult = valueResult;
      state.xiResult = xiResult;
      renderValueSquad(valueResult);
      renderXISquad(xiResult);
      statusMsg.textContent = `Updated for £${budget.toFixed(1)}m budget.`;
    } catch (err) {
      console.error(err);
      statusMsg.textContent = "Could not build a squad for that budget - try a higher value.";
    }
  }, 10);
}

function renderTable() {
  const tbody = $("#playersTableBody");
  const q = $("#searchInput").value.trim().toLowerCase();
  const posFilter = $("#positionFilter").value;
  const sortKey = $("#sortSelect").value;

  let rows = state.players.filter((p) => {
    if (posFilter && p.position !== posFilter) return false;
    if (q) {
      const hay = `${p.web_name} ${p.team} ${p.first_name} ${p.second_name}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  rows = rows.slice().sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
  rows = rows.slice(0, 200); // keep DOM light on mobile

  tbody.innerHTML = "";
  for (const p of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.web_name}${p.new_to_pl ? " <small>(new)</small>" : ""}</td>
      <td>${p.position}</td>
      <td>${p.team_short}</td>
      <td>${p.now_cost.toFixed(1)}</td>
      <td>${p.last_season_club_short || "—"}</td>
      <td>${p.last_season_points}</td>
      <td>${p.last_season_half_points}</td>
      <td>${p.pts_per_million.toFixed(2)}</td>
      <td>${p.half_pts_per_million.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $(`#${btn.dataset.tab}`).classList.add("active");
    });
  });
}

async function main() {
  wireTabs();
  await loadData();
  rebuildTeams();
  renderTable();

  $("#rebuildBtn").addEventListener("click", rebuildTeams);
  $("#searchInput").addEventListener("input", renderTable);
  $("#positionFilter").addEventListener("change", renderTable);
  $("#sortSelect").addEventListener("change", renderTable);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

main();
