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

/** Groups a list of "must be in the squad" players by position and totals
 *  their cost/points, so callers can subtract them from the budget/quota
 *  before running the knapsack over the remaining pool. */
function summarizeFixed(fixedPlayers) {
  const byPos = { GK: [], DEF: [], MID: [], FWD: [] };
  const cost = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  const points = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of fixedPlayers || []) {
    byPos[p.position].push(p);
    cost[p.position] += toTenths(p.now_cost);
    points[p.position] += p.last_season_points || 0;
  }
  return { byPos, cost, points };
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
 *
 * `fixedPlayers` (optional) are players the user has manually locked in -
 * they are always included in the returned squad, their cost is removed
 * from the budget up front, and their position's quota is reduced by the
 * number of fixed players in that position before the knapsack runs.
 */
function buildValueSquad(players, budgetMillions, fixedPlayers = []) {
  const budget = toTenths(budgetMillions);
  const fixed = summarizeFixed(fixedPlayers);
  const fixedIds = new Set(fixedPlayers.map((p) => p.id));

  for (const pos of Object.keys(POSITION_QUOTA)) {
    if (fixed.byPos[pos].length > POSITION_QUOTA[pos]) {
      throw new Error(`Too many fixed ${pos} players for the squad quota.`);
    }
  }
  const fixedTotalCost = Object.values(fixed.cost).reduce((a, b) => a + b, 0);
  if (fixedTotalCost > budget) {
    throw new Error("Fixed players cost more than the total budget.");
  }
  const remainingBudget = budget - fixedTotalCost;

  const banned = new Set();
  let attempt = 0;
  const MAX_ATTEMPTS = 40;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const pool = players.filter((p) => !banned.has(p.id) && !fixedIds.has(p.id) && p.now_cost > 0);
    const groups = groupByPosition(pool);

    const tables = {};
    const need = {};
    for (const pos of Object.keys(POSITION_QUOTA)) {
      need[pos] = POSITION_QUOTA[pos] - fixed.byPos[pos].length;
      const items = toItems(groups[pos], "last_season_points");
      tables[pos] = buildKnapsackTable(items, need[pos], remainingBudget);
    }

    const posOrder = ["GK", "DEF", "MID", "FWD"];
    const arrays = posOrder.map((pos) => ({
      get: (c) => tables[pos].get(need[pos], c),
    }));
    const combined = convolve(arrays, remainingBudget);
    const bestValue = combined.get(remainingBudget);

    if (bestValue === -Infinity) {
      throw new Error("No feasible squad found within budget.");
    }

    // recover the cost split across the 4 positions
    // combined.splits[i] holds the cost given to the *accumulated* first
    // (i+1) positions at each total cost; walk backwards.
    let accCost = remainingBudget;
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
      chosen[pos] = [...fixed.byPos[pos], ...tables[pos].reconstruct(need[pos], perPosCost[i])];
    }

    const squad = posOrder.flatMap((pos) => chosen[pos]);
    const violations = enforceClubLimit(squad);

    if (violations.length === 0) {
      const totalCost = squad.reduce((s, p) => s + p.now_cost, 0);
      const totalPoints = squad.reduce((s, p) => s + p.last_season_points, 0);
      return { squad, totalCost, totalPoints, byPosition: chosen };
    }

    // ban the weakest non-fixed player from the most-over-represented club
    let bannedSomething = false;
    for (const team of violations) {
      const clubPlayers = squad
        .filter((p) => p.team === team && !fixedIds.has(p.id))
        .sort((a, b) => a.last_season_points - b.last_season_points);
      if (clubPlayers.length === 0) {
        throw new Error(`Cannot satisfy the ${MAX_PER_CLUB}-per-club limit because of fixed players from the same club.`);
      }
      banned.add(clubPlayers[0].id);
      bannedSomething = true;
    }
    if (!bannedSomething) {
      throw new Error("Could not satisfy club-limit constraint with the current fixed players.");
    }
  }
  throw new Error("Could not satisfy club-limit constraint within attempt budget.");
}

/**
 * Strategy B: maximise the points of the best starting XI while keeping
 * the 4 bench slots as cheap as possible, under the same budget/quota/
 * club constraints.
 *
 * `fixed` (optional) is `{ starters: Player[], bench: Player[] }` - players
 * the user has manually locked into a specific role. Fixed starters must
 * appear in the XI, fixed bench players must appear on the bench; both are
 * removed from the budget/quota up front, mirroring buildValueSquad.
 */
function buildStartingXIsquad(players, budgetMillions, fixed = { starters: [], bench: [] }) {
  const fixedStarters = fixed.starters || [];
  const fixedBench = fixed.bench || [];
  const budget = toTenths(budgetMillions);
  const fs = summarizeFixed(fixedStarters);
  const fb = summarizeFixed(fixedBench);
  const fixedIds = new Set([...fixedStarters, ...fixedBench].map((p) => p.id));

  for (const pos of Object.keys(POSITION_QUOTA)) {
    if (fs.byPos[pos].length + fb.byPos[pos].length > POSITION_QUOTA[pos]) {
      throw new Error(`Too many fixed ${pos} players for the squad quota.`);
    }
  }
  const fixedTotalCost =
    Object.values(fs.cost).reduce((a, b) => a + b, 0) +
    Object.values(fb.cost).reduce((a, b) => a + b, 0);
  if (fixedTotalCost > budget) {
    throw new Error("Fixed players cost more than the total budget.");
  }

  const banned = new Set();
  let attempt = 0;
  const MAX_ATTEMPTS = 40;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const pool = players.filter((p) => !banned.has(p.id) && !fixedIds.has(p.id) && p.now_cost > 0);
    const groups = groupByPosition(pool);

    const tables = {};
    const cheapestSorted = {};
    for (const pos of Object.keys(POSITION_QUOTA)) {
      const items = toItems(groups[pos], "last_season_points");
      tables[pos] = buildKnapsackTable(items, POSITION_QUOTA[pos], budget);
      cheapestSorted[pos] = [...groups[pos]].sort((a, b) => a.now_cost - b.now_cost);
    }

    function nonFixedBenchCostEstimate(pos, need) {
      if (need <= 0) return 0;
      // cheapest `need` players, ignoring overlap with starters (fixed up
      // exactly at reconstruction time).
      let sum = 0;
      for (let i = 0; i < need; i++) {
        if (!cheapestSorted[pos][i]) return Infinity; // not enough players left
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

      // A formation is only feasible if it has enough starter slots for
      // the fixed starters in each position, and enough bench slots left
      // over for the fixed bench players in each position.
      let feasible = true;
      const nonFixedStarterNeed = {};
      const nonFixedBenchNeed = {};
      for (const sp of posSpecs) {
        const fsCount = fs.byPos[sp.pos].length;
        const fbCount = fb.byPos[sp.pos].length;
        if (sp.s < fsCount) { feasible = false; break; }
        const benchSlots = POSITION_QUOTA[sp.pos] - sp.s;
        if (benchSlots < fbCount) { feasible = false; break; }
        nonFixedStarterNeed[sp.pos] = sp.s - fsCount;
        nonFixedBenchNeed[sp.pos] = benchSlots - fbCount;
      }
      if (!feasible) continue;

      const benchEst = posSpecs.map((sp) => {
        const est = nonFixedBenchCostEstimate(sp.pos, nonFixedBenchNeed[sp.pos]);
        return est === Infinity ? Infinity : est + fb.cost[sp.pos];
      });
      if (benchEst.some((e) => e === Infinity)) continue;

      // curve(C) = best starter points for this position with TOTAL cost
      // (fixed starters + non-fixed starters + estimated bench) <= C
      const arrays = posSpecs.map((sp, i) => ({
        get: (C) => {
          const starterBudget = C - benchEst[i] - fs.cost[sp.pos];
          if (starterBudget < 0) return -Infinity;
          const val = tables[sp.pos].get(nonFixedStarterNeed[sp.pos], starterBudget);
          if (val === -Infinity) return -Infinity;
          return val + fs.points[sp.pos];
        },
      }));
      const combined = convolve(arrays, budget);
      const val = combined.get(budget);
      if (val === -Infinity) continue;
      if (!best || val > best.val) {
        best = { val, sDef, sMid, sFwd, combined, posSpecs, benchEst, nonFixedStarterNeed, nonFixedBenchNeed };
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
      const { pos } = best.posSpecs[i];
      const starterBudget = perPosCost[i] - best.benchEst[i] - fs.cost[pos];
      const chosenNonFixedStarters = tables[pos].reconstruct(
        best.nonFixedStarterNeed[pos],
        Math.max(0, starterBudget)
      );
      starters[pos] = [...fs.byPos[pos], ...chosenNonFixedStarters];

      const chosenIds = new Set(chosenNonFixedStarters.map((p) => p.id));
      const need = best.nonFixedBenchNeed[pos];
      const benchPlayers = [];
      for (const cand of cheapestSorted[pos]) {
        if (benchPlayers.length >= need) break;
        if (!chosenIds.has(cand.id)) benchPlayers.push(cand);
      }
      bench[pos] = [...fb.byPos[pos], ...benchPlayers];
    }

    const posOrder = ["GK", "DEF", "MID", "FWD"];
    const xi = posOrder.flatMap((pos) => starters[pos]);
    const benchAll = posOrder.flatMap((pos) => bench[pos]);
    const squad = [...xi, ...benchAll];

    const totalCost = squad.reduce((s, p) => s + p.now_cost, 0);
    if (totalCost > budgetMillions + 1e-9) {
      // extremely rare estimate/exclusion mismatch - ban the cheapest
      // non-fixed overlap-prone player and retry rather than show an
      // over-budget XI.
      const offender =
        cheapestSorted.DEF.find((p) => !fixedIds.has(p.id)) ||
        cheapestSorted.MID.find((p) => !fixedIds.has(p.id));
      if (offender) {
        banned.add(offender.id);
        continue;
      }
      throw new Error("Could not satisfy the budget with the current fixed players.");
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

    let bannedSomething = false;
    for (const team of violations) {
      const clubPlayers = squad
        .filter((p) => p.team === team && !fixedIds.has(p.id))
        .sort((a, b) => a.last_season_points - b.last_season_points);
      if (clubPlayers.length === 0) {
        throw new Error(`Cannot satisfy the ${MAX_PER_CLUB}-per-club limit because of fixed players from the same club.`);
      }
      banned.add(clubPlayers[0].id);
      bannedSomething = true;
    }
    if (!bannedSomething) {
      throw new Error("Could not satisfy club-limit constraint with the current fixed players.");
    }
  }
  throw new Error("Could not satisfy club-limit constraint within attempt budget.");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildValueSquad, buildStartingXIsquad, POSITION_QUOTA, MAX_PER_CLUB };
}
