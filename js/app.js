/* FPL Team Builder - UI wiring. Loads players.json, runs the squad
 * strategies from optimizer.js, and renders the pitch views + player table. */

// Four squad tabs share the same rendering/fixing logic; they differ only in
// which optimizer they call and which player field they maximise.
const CONTEXTS = {
  value: { resultKey: "valueResult", isXI: false, valueKey: "last_season_points", pointsLabel: "pts", periodLabel: "last szn" },
  xi: { resultKey: "xiResult", isXI: true, valueKey: "last_season_points", pointsLabel: "pts", periodLabel: "last szn" },
  valueHalf: { resultKey: "valueHalfResult", isXI: false, valueKey: "last_season_half_points", pointsLabel: "2nd-half pts", periodLabel: "last szn" },
  xiHalf: { resultKey: "xiHalfResult", isXI: true, valueKey: "last_season_half_points", pointsLabel: "2nd-half pts", periodLabel: "last szn" },
  comingWeeks: { resultKey: "comingWeeksResult", isXI: false, valueKey: "_predictedPoints", pointsLabel: "predicted pts", periodLabel: "GW range" },
};

const DOM_IDS = {
  value: { summary: "#valueSummary", pitch: "#valuePitch" },
  xi: { summary: "#xiSummary", pitch: "#xiPitch", bench: "#xiBench" },
  valueHalf: { summary: "#valueHalfSummary", pitch: "#valueHalfPitch" },
  xiHalf: { summary: "#xiHalfSummary", pitch: "#xiHalfPitch", bench: "#xiHalfBench" },
  comingWeeks: { summary: "#comingWeeksSummary", pitch: "#comingWeeksPitch" },
};

const state = {
  players: [],
  meta: null,
  valueResult: null,
  xiResult: null,
  valueHalfResult: null,
  xiHalfResult: null,
  comingWeeksResult: null,
  // predictions.json: { quarters, promoted, demoted, points: { [playerId]: { [opponentTeamName]: predictedPts } } }
  predictions: null,
  // team name -> [{ event, opponent }] for every fixture in the current season
  teamFixtures: null,
  // Player-level "locks" set via the replace-player modal, one map per
  // context/role. Keyed by player id -> player object. Passed into the
  // optimizer on rebuild so it keeps these players and only re-solves the
  // remaining budget/slots.
  fixed: {
    value: new Map(),
    xiStarters: new Map(),
    xiBench: new Map(),
    valueHalf: new Map(),
    xiHalfStarters: new Map(),
    xiHalfBench: new Map(),
    comingWeeks: new Map(),
  },
  // { player, context: 'value'|'xi'|'valueHalf'|'xiHalf', role: 'squad'|'starters'|'bench' } while open
  modal: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

async function loadData() {
  const [players, meta, predictions, currentFixtures] = await Promise.all([
    fetch("data/players.json").then((r) => r.json()),
    fetch("data/meta.json").then((r) => r.json()),
    fetch("data/predictions.json").then((r) => r.json()),
    fetch("data/current_fixtures.json").then((r) => r.json()),
  ]);
  state.players = players;
  state.meta = meta;
  state.predictions = predictions;

  state.teamFixtures = {};
  for (const f of currentFixtures) {
    (state.teamFixtures[f.home] ||= []).push({ event: f.event, opponent: f.away });
    (state.teamFixtures[f.away] ||= []).push({ event: f.event, opponent: f.home });
  }

  $("#metaLine").textContent =
    `${meta.player_count} players • current: ${meta.current_season} • ` +
    `last season points from ${meta.last_season} (2nd half = ${meta.half_split.split(" vs ")[1]})`;
}

// Sums predictions.points[player][opponent] over every fixture that
// player's current team plays between startWeek and endWeek (inclusive),
// and stashes it on each player as `_predictedPoints` for the optimizer.
function computePredictedPoints(startWeek, endWeek) {
  const pointsByPlayer = state.predictions.points;
  for (const p of state.players) {
    const fixtures = state.teamFixtures[p.team] || [];
    const oppPoints = pointsByPlayer[p.id] || {};
    let sum = 0;
    for (const fx of fixtures) {
      if (fx.event < startWeek || fx.event > endWeek) continue;
      sum += oppPoints[fx.opponent] || 0;
    }
    p._predictedPoints = Math.round(sum * 100) / 100;
  }
}

function usablePlayers() {
  return state.players.filter((p) => p.status !== "u");
}

function fixedMapFor(context, role) {
  if (role === "starters") return state.fixed[`${context}Starters`];
  if (role === "bench") return state.fixed[`${context}Bench`];
  return state.fixed[context]; // role === "squad"
}

function chip(p, statKey, statLabel, ctx) {
  const c = el("div", "player-chip");
  const posBadge = el("span", `pos-badge ${p.position}`, p.position);
  c.appendChild(posBadge);
  c.appendChild(el("span", "pname", p.web_name));
  c.appendChild(el("span", "pclub", `${p.team_short} £${p.now_cost.toFixed(1)}m`));
  c.appendChild(el("span", "pstat", `${p[statKey]} ${statLabel}`));
  if (ctx) {
    if (fixedMapFor(ctx.context, ctx.role).has(p.id)) {
      c.classList.add("fixed");
      c.appendChild(el("span", "pin-badge", "FIXED"));
    }
    c.addEventListener("click", () => openPlayerModal(p, ctx));
  }
  return c;
}

function renderPitch(container, byPosition, statKey, statLabel, ctx) {
  container.innerHTML = "";
  const order = ["GK", "DEF", "MID", "FWD"];
  for (const pos of order) {
    const players = byPosition[pos] || [];
    if (!players.length) continue;
    const row = el("div", "pitch-row");
    for (const p of players) row.appendChild(chip(p, statKey, statLabel, ctx));
    container.appendChild(row);
  }
}

function renderBench(container, benchPlayers, ctx) {
  container.innerHTML = "";
  for (const p of benchPlayers) container.appendChild(chip(p, "now_cost", "", ctx));
}

function summaryStat(val, lbl) {
  const s = el("div", "summary-stat");
  s.appendChild(el("span", "val", val));
  s.appendChild(el("span", "lbl", lbl));
  return s;
}

function renderSquadTab(context) {
  const cfg = CONTEXTS[context];
  const ids = DOM_IDS[context];
  const result = state[cfg.resultKey];
  const summary = $(ids.summary);
  summary.innerHTML = "";

  if (cfg.isXI) {
    summary.appendChild(summaryStat(result.formation, "Formation"));
    summary.appendChild(summaryStat(`£${result.totalCost.toFixed(1)}m`, "Squad cost"));
    summary.appendChild(summaryStat(result.xiPoints, `XI ${cfg.pointsLabel} (${cfg.periodLabel})`));
    summary.appendChild(summaryStat(`£${result.benchCost.toFixed(1)}m`, "Bench cost"));
    renderPitch($(ids.pitch), result.byPosition.starters, cfg.valueKey, cfg.pointsLabel, { context, role: "starters" });
    renderBench(
      $(ids.bench),
      result.byPosition.bench.GK.concat(result.byPosition.bench.DEF, result.byPosition.bench.MID, result.byPosition.bench.FWD),
      { context, role: "bench" }
    );
  } else {
    summary.appendChild(summaryStat(`£${result.totalCost.toFixed(1)}m`, "Total cost"));
    summary.appendChild(summaryStat(result.totalPoints, `Total ${cfg.pointsLabel} (${cfg.periodLabel})`));
    summary.appendChild(summaryStat((result.totalPoints / result.totalCost).toFixed(1), "Pts per £m"));
    renderPitch($(ids.pitch), result.byPosition, cfg.valueKey, cfg.pointsLabel, { context, role: "squad" });
  }
}

function rebuildTeams() {
  const budget = parseFloat($("#budgetInput").value) || 100.0;
  const statusMsg = $("#statusMsg");
  statusMsg.textContent = "Solving…";
  setTimeout(() => {
    try {
      const pool = usablePlayers();
      let fixedCount = 0;

      for (const context of ["value", "valueHalf"]) {
        const cfg = CONTEXTS[context];
        const fixedPlayers = [...state.fixed[context].values()];
        fixedCount += fixedPlayers.length;
        state[cfg.resultKey] = buildValueSquad(pool, budget, fixedPlayers, cfg.valueKey);
      }
      for (const context of ["xi", "xiHalf"]) {
        const cfg = CONTEXTS[context];
        const fixed = {
          starters: [...state.fixed[`${context}Starters`].values()],
          bench: [...state.fixed[`${context}Bench`].values()],
        };
        fixedCount += fixed.starters.length + fixed.bench.length;
        state[cfg.resultKey] = buildStartingXIsquad(pool, budget, fixed, cfg.valueKey);
      }

      const startWeek = parseInt($("#startWeekInput").value, 10);
      const endWeek = parseInt($("#endWeekInput").value, 10);
      if (!Number.isInteger(startWeek) || !Number.isInteger(endWeek) || startWeek < 1 || endWeek > 38 || startWeek > endWeek) {
        throw new Error("Coming Weeks: Start GW and End GW must be between 1-38, with Start <= End.");
      }
      computePredictedPoints(startWeek, endWeek);
      const comingWeeksFixed = [...state.fixed.comingWeeks.values()];
      fixedCount += comingWeeksFixed.length;
      state.comingWeeksResult = buildValueSquad(pool, budget, comingWeeksFixed, CONTEXTS.comingWeeks.valueKey);

      for (const context of Object.keys(CONTEXTS)) renderSquadTab(context);

      statusMsg.textContent =
        `Updated for £${budget.toFixed(1)}m budget.` + (fixedCount ? ` ${fixedCount} fixed player(s) kept.` : "");
    } catch (err) {
      console.error(err);
      statusMsg.textContent = err.message || "Could not build a squad for that budget - try a higher value.";
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

function currentSquadIds(context) {
  const result = state[CONTEXTS[context].resultKey];
  return new Set(result.squad.map((p) => p.id));
}

function openPlayerModal(player, ctx) {
  state.modal = { player, context: ctx.context, role: ctx.role };

  $("#modalTitle").textContent = `Replace ${player.web_name}`;
  $("#modalSubtitle").textContent =
    `${player.position} · ${player.team_short} · £${player.now_cost.toFixed(1)}m — pick a same-position player to swap in.`;

  const isFixed = fixedMapFor(ctx.context, ctx.role).has(player.id);
  $("#modalFixedNote").classList.toggle("hidden", !isFixed);

  const posPlayers = usablePlayers().filter((p) => p.position === player.position);

  const clubSelect = $("#modalClubFilter");
  const clubs = [...new Set(posPlayers.map((p) => p.team))].sort();
  clubSelect.innerHTML =
    `<option value="">All clubs</option>` + clubs.map((c) => `<option value="${c}">${c}</option>`).join("");
  clubSelect.value = "";

  const costs = posPlayers.map((p) => p.now_cost);
  const priceInput = $("#modalPriceMax");
  priceInput.min = String(Math.floor(Math.min(...costs) * 10) / 10);
  priceInput.max = String(Math.ceil(Math.max(...costs) * 10) / 10);
  priceInput.step = "0.1";
  priceInput.value = priceInput.max;
  $("#modalPriceVal").textContent = priceInput.value;

  $("#modalSearch").value = "";
  $("#modalSort").value = CONTEXTS[ctx.context].valueKey;

  renderModalList();
  $("#playerModal").classList.remove("hidden");
}

function closePlayerModal() {
  $("#playerModal").classList.add("hidden");
  state.modal = null;
}

function renderModalList() {
  const list = $("#modalList");
  if (!state.modal) return;
  const { player, context } = state.modal;
  const cfg = CONTEXTS[context];

  const q = $("#modalSearch").value.trim().toLowerCase();
  const club = $("#modalClubFilter").value;
  const maxPrice = parseFloat($("#modalPriceMax").value);
  const sortKey = $("#modalSort").value;

  const excludeIds = currentSquadIds(context);
  excludeIds.delete(player.id); // the clicked player's own slot is always shown

  let rows = usablePlayers().filter((p) => {
    if (p.position !== player.position) return false;
    if (p.id !== player.id && excludeIds.has(p.id)) return false; // no duplicate squad members
    if (club && p.team !== club) return false;
    if (p.now_cost > maxPrice + 1e-9) return false;
    if (q) {
      const hay = `${p.web_name} ${p.team} ${p.first_name} ${p.second_name}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  rows = rows.slice().sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
  rows = rows.slice(0, 150);

  list.innerHTML = "";
  if (!rows.length) {
    list.appendChild(el("p", "modal-empty", "No players match these filters."));
    return;
  }
  for (const p of rows) {
    const isCurrent = p.id === player.id;
    const row = el("div", "modal-row" + (isCurrent ? " current" : ""));
    row.appendChild(el("span", "mr-name", `${p.web_name}${isCurrent ? " <small>(current)</small>" : ""}`));
    row.appendChild(el("span", "mr-club", p.team_short));
    row.appendChild(el("span", "mr-cost", `£${p.now_cost.toFixed(1)}m`));
    row.appendChild(el("span", "mr-pts", `${p[cfg.valueKey]} ${cfg.pointsLabel}`));
    row.addEventListener("click", () => selectReplacement(p));
    list.appendChild(row);
  }
}

function swapPlayerInSquad(context, role, oldPlayer, newPlayer) {
  const cfg = CONTEXTS[context];
  const result = state[cfg.resultKey];
  const pos = oldPlayer.position;
  const posOrder = ["GK", "DEF", "MID", "FWD"];

  if (!cfg.isXI) {
    const arr = result.byPosition[pos];
    const idx = arr.findIndex((p) => p.id === oldPlayer.id);
    if (idx === -1) return;
    arr[idx] = newPlayer;
    result.squad = posOrder.flatMap((p) => result.byPosition[p]);
    result.totalCost = result.squad.reduce((s, p) => s + p.now_cost, 0);
    result.totalPoints = result.squad.reduce((s, p) => s + p[cfg.valueKey], 0);
  } else {
    const arr = result.byPosition[role][pos];
    const idx = arr.findIndex((p) => p.id === oldPlayer.id);
    if (idx === -1) return;
    arr[idx] = newPlayer;
    result.starters = posOrder.flatMap((p) => result.byPosition.starters[p]);
    result.bench = posOrder.flatMap((p) => result.byPosition.bench[p]);
    result.squad = [...result.starters, ...result.bench];
    result.totalCost = result.squad.reduce((s, p) => s + p.now_cost, 0);
    result.xiPoints = result.starters.reduce((s, p) => s + p[cfg.valueKey], 0);
    result.benchCost = result.bench.reduce((s, p) => s + p.now_cost, 0);
  }
  renderSquadTab(context);
}

function selectReplacement(newPlayer) {
  if (!state.modal) return;
  const { player: oldPlayer, context, role } = state.modal;
  if (newPlayer.id !== oldPlayer.id) {
    const fixedMap = fixedMapFor(context, role);
    fixedMap.delete(oldPlayer.id);
    fixedMap.set(newPlayer.id, newPlayer);
    swapPlayerInSquad(context, role, oldPlayer, newPlayer); // re-renders, so the map must be up to date first
  }
  closePlayerModal();
}

function unfixCurrentModalPlayer() {
  if (!state.modal) return;
  const { player, context, role } = state.modal;
  fixedMapFor(context, role).delete(player.id);
  closePlayerModal();
  renderSquadTab(context);
}

function wireModal() {
  $("#modalClose").addEventListener("click", closePlayerModal);
  $("#playerModal").addEventListener("click", (e) => {
    if (e.target.id === "playerModal") closePlayerModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.modal) closePlayerModal();
  });
  $("#modalSearch").addEventListener("input", renderModalList);
  $("#modalClubFilter").addEventListener("change", renderModalList);
  $("#modalSort").addEventListener("change", renderModalList);
  $("#modalPriceMax").addEventListener("input", () => {
    $("#modalPriceVal").textContent = $("#modalPriceMax").value;
    renderModalList();
  });
  $("#modalUnfix").addEventListener("click", unfixCurrentModalPlayer);
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
  wireModal();
  await loadData();
  rebuildTeams();
  renderTable();

  $("#rebuildBtn").addEventListener("click", rebuildTeams);
  $("#searchInput").addEventListener("input", renderTable);
  $("#positionFilter").addEventListener("change", renderTable);
  $("#sortSelect").addEventListener("change", renderTable);

  if ("serviceWorker" in navigator) {
    // If this load was already controlled by a service worker and a newer
    // one takes over (i.e. a real deploy landed, not the first-ever
    // install), reload once so the fresh cached assets take effect instead
    // of silently sitting there until the next manual refresh.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded || !hadController) {
        reloaded = true;
        return;
      }
      reloaded = true;
      window.location.reload();
    });
    navigator.serviceWorker
      .register("service-worker.js")
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {});
  }
}

main();
