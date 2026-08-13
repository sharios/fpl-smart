/*
 * FPL Team Builder optimizer.
 *
 * Solves the FPL squad-selection problem as a bounded 0/1 knapsack per
 * position, then combines positions under the overall £100m budget.
 * Squad rules enforced: 2 GK / 5 DEF / 5 MID / 3 FWD, budget <= given
 * limit, max 3 players from any one real-world club.
 *
 * Two strategies are exposed:
 *   buildValueSquad()  - maximise total points across the full 15-man squad
 *                         ("Strategy A" - classic knapsack).
 *   buildStartingXI()  - maximise the points of the best valid starting XI
 *                         (1 GK + 3-5 DEF + 2-5 MID + 1-3 FWD = 11) while
 *                         filling the remaining 4 squad slots as cheaply
 *                         as possible ("Strategy B" - bench-fodder squad).
 *
 * All money amounts are handled as integers in tenths of a million
 * (e.g. £6.5m -> 65) to avoid floating point drift, matching FPL's own
 * price representation.
 */

const POSITION_QUOTA = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
const MAX_PER_CLUB = 3;
const XI_RANGE = { GK: [1, 1], DEF: [3, 5], MID: [2, 5], FWD: [1, 3] };

function toTenths(m) {
  return Math.round(m * 10);
}
function fromTenths(t) {
  return t / 10;
}

/**
 * Exact 0/1 "choose exactly k of n" knapsack, computed for every k up to
 * kMax and every cost up to costMax in one pass, so callers can slice out
 * whichever k they need afterwards (used heavily by Strategy B, which
 * needs several different starter counts per position).
 *
 * items: [{ id, cost /* tenths of £m *\/, value, ref }]
 * returns { get(k,c), reconstruct(k,c) }
 */
function buildKnapsackTable(items, kMax, costMax) {
  const n = items.length;
  const K = kMax + 1;
  const C = costMax + 1;
  // dp[i] is a (K x C) Float64Array; keep all layers for reconstruction.
  const layers = new Array(n + 1);
  const base = new Float64Array(K * C).fill(-Infinity);
  for (let c = 0; c < C; c++) base[0 * C + c] = 0; // k=0 always achievable, value 0
  layers[0] = base;

  for (let i = 1; i <= n; i++) {
    const prev = layers[i - 1];
    const cur = new Float64Array(K * C);
    const it = items[i - 1];
    for (let k = 0; k < K; k++) {
      for (let c = 0; c < C; c++) {
        let best = prev[k * C + c];
        if (k > 0 && c >= it.cost) {
          const cand = prev[(k - 1) * C + (c - it.cost)];
          if (cand !== -Infinity) {
            const withIt = cand + it.value;
            if (withIt > best) best = withIt;
          }
        }
        cur[k * C + c] = best;
      }
    }
    layers[i] = cur;
  }

  function get(k, c) {
    if (k < 0 || k > kMax || c < 0) return -Infinity;
    c = Math.min(c, costMax);
    return layers[n][k * C + c];
  }

  function reconstruct(k, c) {
    const chosen = [];
    let ci = n, kk = k, cc = Math.min(c, costMax);
    while (ci > 0 && kk > 0) {
      const it = items[ci - 1];
      const without = layers[ci - 1][kk * C + cc];
      let withIt = -Infinity;
      if (cc >= it.cost) {
        const cand = layers[ci - 1][(kk - 1) * C + (cc - it.cost)];
        if (cand !== -Infinity) withIt = cand + it.value;
      }
      if (withIt > without) {
        chosen.push(it.ref);
        kk -= 1;
        cc -= it.cost;
      }
      ci -= 1;
    }
    return chosen;
  }

  return { get, reconstruct, n, kMax, costMax };
}

function groupByPosition(players) {
  const groups = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of players) {
    if (groups[p.position]) groups[p.position].push(p);
  }
  return groups;
}

function toItems(players, valueKey) {
  return players.map((p) => ({
    id: p.id,
    cost: toTenths(p.now_cost),
    value: p[valueKey] || 0,
    ref: p,
  }));
}

/** Convolve two monotone-in-cost arrays A,B (index = cost, value = best
 *  points achievable with cost <= index) into a combined array, tracking
 *  the split so the choice can be recovered later. */
function convolve(a, costMax) {
  // a: array of {get(c)} functions/arrays to combine, in order.
  // Returns { get(c), splitFor(c) -> array of per-part costs actually used }
  // Implemented iteratively, two arrays at a time.
  function combine2(getA, getB) {
    const best = new Float64Array(costMax + 1).fill(-Infinity);
    const splitA = new Int32Array(costMax + 1).fill(-1);
    for (let c = 0; c <= costMax; c++) {
      let bestVal = -Infinity;
      let bestA = 0;
      for (let ca = 0; ca <= c; ca++) {
        const va = getA(ca);
        if (va === -Infinity) continue;
        const vb = getB(c - ca);
        if (vb === -Infinity) continue;
        const total = va + vb;
        if (total > bestVal) {
          bestVal = total;
          bestA = ca;
        }
      }
      best[c] = bestVal;
      splitA[c] = bestA;
    }
    return {
      get: (c) => (c < 0 ? -Infinity : best[Math.min(c, costMax)]),
      splitA,
    };
  }
  let acc = a[0];
  const splits = [];
  for (let i = 1; i < a.length; i++) {
    const combined = combine2(acc.get, a[i].get);
    splits.push(combined.splitA);
    acc = { get: combined.get };
  }
  return { get: acc.get, splits };
}

function enforceClubLimit(squadPlayers) {
  const counts = {};
  for (const p of squadPlayers) counts[p.team] = (counts[p.team] || 0) + 1;
  const violations = [];
  for (const [team, n] of Object.entries(counts)) {
    if (n > MAX_PER_CLUB) violations.push(team);
  }
  return violations;
}

/**
 * Strategy A: maximise total squad points under budget + quota + club
 * constraints. Uses constraint-generation: solve, check club limits, ban
 * the weakest offending player and resolve, repeat until feasible.
 */
function buildValueSquad(players, budgetMillions) {
  const budget = toTenths(budgetMillions);
  const banned = new Set();
  let attempt = 0;
  const MAX_ATTEMPTS = 40;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const pool = players.filter((p) => !banned.has(p.id) && p.now_cost > 0);
    const groups = groupByPosition(pool);

    const tables = {};
    for (const pos of Object.keys(POSITION_QUOTA)) {
      const items = toItems(groups[pos], "last_season_points");
      tables[pos] = buildKnapsackTable(items, POSITION_QUOTA[pos], budget);
    }

    const posOrder = ["GK", "DEF", "MID", "FWD"];
    const arrays = posOrder.map((pos) => ({
      get: (c) => tables[pos].get(POSITION_QUOTA[pos], c),
    }));
    const combined = convolve(arrays, budget);
    const bestValue = combined.get(budget);

    if (bestValue === -Infinity) {
      throw new Error("No feasible squad found within budget.");
    }

    // recover the cost split across the 4 positions
    const splitCosts = new Array(posOrder.length).fill(0);
    let remaining = budget;
    // combined.splits[i] holds the cost given to the *accumulated* first
    // (i+1) positions at each total cost; walk backwards.
    let accCost = budget;
    const perPosCost = [];
    for (let i = combined.splits.length; i >= 1; i--) {
      const used = combined.splits[i - 1][accCost];
      perPosCost.unshift(accCost - used);
      accCost = used;
    }
    perPosCost.unshift(accCost);

    const chosen = {};
    for (let i = 0; i < posOrder.length; i++) {
      const pos = posOrder[i];
      chosen[pos] = tables[pos].reconstruct(POSITION_QUOTA[pos], perPosCost[i]);
    }

    const squad = posOrder.flatMap((pos) => chosen[pos]);
    const violations = enforceClubLimit(squad);

    if (violations.length === 0) {
      const totalCost = squad.reduce((s, p) => s + p.now_cost, 0);
      const totalPoints = squad.reduce((s, p) => s + p.last_season_points, 0);
      return { squad, totalCost, totalPoints, byPosition: chosen };
    }

    // ban the weakest player from the most-over-represented club
    for (const team of violations) {
      const clubPlayers = squad
        .filter((p) => p.team === team)
        .sort((a, b) => a.last_season_points - b.last_season_points);
      banned.add(clubPlayers[0].id);
    }
  }
  throw new Error("Could not satisfy club-limit constraint within attempt budget.");
}

/**
 * Strategy B: maximise the points of the best starting XI while keeping
 * the 4 bench slots as cheap as possible, under the same budget/quota/
 * club constraints.
 */
function buildStartingXIsquad(players, budgetMillions) {
  const budget = toTenths(budgetMillions);
  const banned = new Set();
  let attempt = 0;
  const MAX_ATTEMPTS = 40;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const pool = players.filter((p) => !banned.has(p.id) && p.now_cost > 0);
    const groups = groupByPosition(pool);

    const tables = {};
    const cheapestSorted = {};
    for (const pos of Object.keys(POSITION_QUOTA)) {
      const items = toItems(groups[pos], "last_season_points");
      tables[pos] = buildKnapsackTable(items, POSITION_QUOTA[pos], budget);
      cheapestSorted[pos] = [...groups[pos]].sort((a, b) => a.now_cost - b.now_cost);
    }

    function benchCostEstimate(pos, s) {
      const need = POSITION_QUOTA[pos] - s;
      if (need <= 0) return 0;
      // cheapest `need` players, ignoring overlap with starters (fixed up
      // exactly at reconstruction time).
      let sum = 0;
      for (let i = 0; i < need; i++) {
        sum += toTenths(cheapestSorted[pos][i].now_cost);
      }
      return sum;
    }

    // Enumerate valid formations: DEF 3-5, MID 2-5, FWD 1-3, sum = 10.
    const formations = [];
    for (let d = XI_RANGE.DEF[0]; d <= XI_RANGE.DEF[1]; d++) {
      for (let m = XI_RANGE.MID[0]; m <= XI_RANGE.MID[1]; m++) {
        for (let f = XI_RANGE.FWD[0]; f <= XI_RANGE.FWD[1]; f++) {
          if (d + m + f === 10) formations.push([d, m, f]);
        }
      }
    }

    let best = null;

    for (const [sDef, sMid, sFwd] of formations) {
      const posSpecs = [
        { pos: "GK", s: 1 },
        { pos: "DEF", s: sDef },
        { pos: "MID", s: sMid },
        { pos: "FWD", s: sFwd },
      ];
      const benchEst = posSpecs.map((sp) => benchCostEstimate(sp.pos, sp.s));
      // curve(C) = best starter points for this position with TOTAL cost
      // (starters + estimated bench) <= C
      const arrays = posSpecs.map((sp, i) => ({
        get: (C) => {
          const starterBudget = C - benchEst[i];
          if (starterBudget < 0) return -Infinity;
          return tables[sp.pos].get(sp.s, starterBudget);
        },
      }));
      const combined = convolve(arrays, budget);
      const val = combined.get(budget);
      if (val === -Infinity) continue;
      if (!best || val > best.val) {
        best = { val, sDef, sMid, sFwd, combined, posSpecs, benchEst };
      }
    }

    if (!best) throw new Error("No feasible starting XI found within budget.");

    // recover per-position total cost (starters+bench) split
    let accCost = budget;
    const perPosCost = [];
    for (let i = best.combined.splits.length; i >= 1; i--) {
      const used = best.combined.splits[i - 1][accCost];
      perPosCost.unshift(accCost - used);
      accCost = used;
    }
    perPosCost.unshift(accCost);

    const starters = {};
    const bench = {};
    for (let i = 0; i < best.posSpecs.length; i++) {
      const { pos, s } = best.posSpecs[i];
      const starterBudget = perPosCost[i] - best.benchEst[i];
      const chosenStarters = tables[pos].reconstruct(s, Math.max(0, starterBudget));
      starters[pos] = chosenStarters;
      const chosenIds = new Set(chosenStarters.map((p) => p.id));
      const need = POSITION_QUOTA[pos] - s;
      const benchPlayers = [];
      for (const cand of cheapestSorted[pos]) {
        if (benchPlayers.length >= need) break;
        if (!chosenIds.has(cand.id)) benchPlayers.push(cand);
      }
      bench[pos] = benchPlayers;
    }

    const posOrder = ["GK", "DEF", "MID", "FWD"];
    const xi = posOrder.flatMap((pos) => starters[pos]);
    const benchAll = posOrder.flatMap((pos) => bench[pos]);
    const squad = [...xi, ...benchAll];

    const totalCost = squad.reduce((s, p) => s + p.now_cost, 0);
    if (totalCost > budgetMillions + 1e-9) {
      // extremely rare estimate/exclusion mismatch - ban the cheapest
      // overlap-prone player and retry rather than show an over-budget XI.
      const offender = cheapestSorted.DEF[0] || cheapestSorted.MID[0];
      if (offender) banned.add(offender.id);
      continue;
    }

    const violations = enforceClubLimit(squad);
    if (violations.length === 0) {
      const xiPoints = xi.reduce((s, p) => s + p.last_season_points, 0);
      const benchCost = benchAll.reduce((s, p) => s + p.now_cost, 0);
      return {
        squad,
        starters: xi,
        bench: benchAll,
        formation: `${best.sDef}-${best.sMid}-${best.sFwd}`,
        totalCost,
        xiPoints,
        benchCost,
        byPosition: { starters, bench },
      };
    }

    for (const team of violations) {
      const clubPlayers = squad
        .filter((p) => p.team === team)
        .sort((a, b) => a.last_season_points - b.last_season_points);
      banned.add(clubPlayers[0].id);
    }
  }
  throw new Error("Could not satisfy club-limit constraint within attempt budget.");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildValueSquad, buildStartingXIsquad, POSITION_QUOTA, MAX_PER_CLUB };
}
