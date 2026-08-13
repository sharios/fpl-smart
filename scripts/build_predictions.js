/*
 * Builds data/predictions.json - a per-player, per-possible-opponent points
 * prediction table used by the "Coming Weeks" tab, plus data/current_fixtures.json
 * (this season's full fixture list). Run with: node scripts/build_predictions.js
 *
 * Source data:
 *  - Live FPL API (fantasy.premierleague.com) for the current season's teams
 *    and fixture schedule.
 *  - vaastav/Fantasy-Premier-League GitHub archive for last season's finished
 *    fixtures (-> final standings -> quarters) and gameweek-by-gameweek player
 *    performance (-> points(x,e)).
 *
 * Prediction logic (points(x, e) = predicted points for player x against
 * opponent e), per the product spec:
 *   1. team(x) not promoted, e not promoted:
 *        points_last_season(x, quarter_last_season(e))
 *   2. team(x) promoted, e not promoted:
 *        points_demoted_last_season(position(x), e)
 *   3. team(x) promoted, e promoted:
 *        points_demoted_last_season(position(x))
 *   4. team(x) not promoted, e promoted:
 *        points_against_demoted_last_season(x)
 *
 * "Promoted" = in this season's 20 clubs but not last season's; "demoted" =
 * in last season's 20 clubs but not this season's.
 *
 * Fallback chain (not specified by the product spec, needed for players with
 * no/sparse personal history last season, e.g. new-to-PL signings): each case
 * falls back from the most specific bucket down to a position-wide, any-
 * opponent average, so no prediction is ever left undefined. See FALLBACKS
 * below for the exact order per case.
 */

const fs = require("fs");
const path = require("path");

const LAST_SEASON = "2025-26";
const ARCHIVE_BASE = `https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/${LAST_SEASON}`;
const FPL_API = "https://fantasy.premierleague.com/api";
const DATA_DIR = path.join(__dirname, "..", "data");

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return res.text();
}
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return res.json();
}

/** Minimal RFC4180 CSV parser - handles quoted fields with embedded commas/newlines. */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // skip
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0];
  return rows
    .slice(1)
    .filter((r) => r.length === header.length)
    .map((r) => {
      const obj = {};
      header.forEach((h, idx) => (obj[h] = r[idx]));
      return obj;
    });
}

const bucketAdd = (bucket, key, pts) => {
  if (!bucket[key]) bucket[key] = { sum: 0, n: 0 };
  bucket[key].sum += pts;
  bucket[key].n += 1;
};
const bucketAvg = (bucket, key) => {
  const b = bucket && bucket[key];
  return b && b.n > 0 ? b.sum / b.n : null;
};

async function main() {
  console.log("Fetching current-season data (live FPL API)...");
  const [bootstrap, currentFixturesRaw] = await Promise.all([
    fetchJson(`${FPL_API}/bootstrap-static/`),
    fetchJson(`${FPL_API}/fixtures/`),
  ]);

  console.log("Fetching last-season data (vaastav archive)...");
  const [fixturesCsvText, teamsCsvText, mergedGwCsvText, playersRawCsvText] = await Promise.all([
    fetchText(`${ARCHIVE_BASE}/fixtures.csv`),
    fetchText(`${ARCHIVE_BASE}/teams.csv`),
    fetchText(`${ARCHIVE_BASE}/gws/merged_gw.csv`),
    fetchText(`${ARCHIVE_BASE}/players_raw.csv`),
  ]);

  const lastFixtures = parseCSV(fixturesCsvText);
  const lastTeams = parseCSV(teamsCsvText);
  const gwRows = parseCSV(mergedGwCsvText);
  const lastPlayersRaw = parseCSV(playersRawCsvText);

  // ---- team id -> name (last season's own numbering) ----
  const lastTeamNameById = {};
  for (const t of lastTeams) lastTeamNameById[t.id] = t.name;

  // ---- final last-season standings from finished fixtures ----
  const table = {};
  for (const t of lastTeams) table[t.name] = { pts: 0, gf: 0, ga: 0, played: 0 };
  for (const f of lastFixtures) {
    if (f.finished !== "True") continue;
    const h = lastTeamNameById[f.team_h];
    const a = lastTeamNameById[f.team_a];
    const hs = parseInt(f.team_h_score, 10);
    const as = parseInt(f.team_a_score, 10);
    if (!h || !a || Number.isNaN(hs) || Number.isNaN(as)) continue;
    table[h].played++;
    table[a].played++;
    table[h].gf += hs;
    table[h].ga += as;
    table[a].gf += as;
    table[a].ga += hs;
    if (hs > as) table[h].pts += 3;
    else if (hs < as) table[a].pts += 3;
    else {
      table[h].pts += 1;
      table[a].pts += 1;
    }
  }
  const standings = Object.entries(table)
    .map(([name, s]) => ({ name, ...s, gd: s.gf - s.ga }))
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);

  const incomplete = standings.filter((s) => s.played !== 38);
  if (incomplete.length) {
    console.warn(
      "WARNING: some teams don't have 38 played games - standings may be incomplete:",
      incomplete.map((s) => `${s.name}:${s.played}`).join(", ")
    );
  }

  const quarterOf = {};
  standings.forEach((s, i) => {
    quarterOf[s.name] = Math.floor(i / 5) + 1;
  });
  console.log("Last-season final standings computed. Quarters:");
  for (let q = 1; q <= 4; q++) {
    console.log(`  Q${q}:`, standings.slice((q - 1) * 5, q * 5).map((s) => s.name).join(", "));
  }

  // ---- promoted / demoted (by team name, current 20 vs last-season 20) ----
  const currentTeamNames = bootstrap.teams.map((t) => t.name);
  const lastSeasonTeamNames = standings.map((s) => s.name);
  const promoted = currentTeamNames.filter((n) => !lastSeasonTeamNames.includes(n));
  const demoted = lastSeasonTeamNames.filter((n) => !currentTeamNames.includes(n));
  console.log("Promoted this season:", promoted);
  console.log("Demoted last season:", demoted);
  if (promoted.length !== 3 || demoted.length !== 3) {
    console.warn("WARNING: expected exactly 3 promoted and 3 demoted teams - check name matching above.");
  }

  // ---- last-season id -> stable FPL player code (element ids reset every season) ----
  const lastIdToCode = {};
  for (const r of lastPlayersRaw) lastIdToCode[r.id] = r.code;

  // ---- current FPL code -> this app's player id (data/players.json) ----
  const players = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "players.json"), "utf8"));
  const codeToCurrentId = {};
  for (const p of players) codeToCurrentId[String(p.code)] = p.id;

  // ---- aggregate every last-season GW row into the buckets each case needs ----
  const xByQuarter = {}; // currentPlayerId -> quarter -> {sum,n}            (case 1 primary)
  const xVsDemoted = {}; // currentPlayerId -> {sum,n}                       (case 4 primary)
  const teamPosByQuarter = {}; // lastSeasonTeamName -> position -> quarter -> {sum,n}  (case 1 fallback)
  const teamPosVsDemoted = {}; // lastSeasonTeamName -> position -> {sum,n}  (case 4 fallback)
  const posGlobalVsQuarter = {}; // position -> quarter -> {sum,n}           (case 1/2 broad fallback)
  const posGlobalVsDemoted = {}; // position -> {sum,n}                      (case 3/4 broad fallback)
  const posGlobalOverall = {}; // position -> {sum,n}                        (absolute floor)
  const demotedPosVsOpp = {}; // position -> oppName -> {sum,n}              (case 2 primary)
  const demotedPosVsQuarter = {}; // position -> quarter -> {sum,n}          (case 2 fallback)
  const demotedPosVsDemoted = {}; // position -> {sum,n}                     (case 3 primary)

  let matchedRows = 0;
  let unmatchedRows = 0;

  for (const row of gwRows) {
    const pts = parseFloat(row.total_points) || 0;
    const oppName = lastTeamNameById[row.opponent_team];
    if (!oppName) continue;
    const quarter = quarterOf[oppName];
    const teamName = row.team;
    const position = row.position; // already GK/DEF/MID/FWD in this dataset
    const oppIsDemoted = demoted.includes(oppName);
    const teamIsDemoted = demoted.includes(teamName);

    if (!teamPosByQuarter[teamName]) teamPosByQuarter[teamName] = {};
    if (!teamPosByQuarter[teamName][position]) teamPosByQuarter[teamName][position] = {};
    bucketAdd(teamPosByQuarter[teamName][position], quarter, pts);

    if (oppIsDemoted) {
      if (!teamPosVsDemoted[teamName]) teamPosVsDemoted[teamName] = {};
      bucketAdd(teamPosVsDemoted[teamName], position, pts);
    }

    if (!posGlobalVsQuarter[position]) posGlobalVsQuarter[position] = {};
    bucketAdd(posGlobalVsQuarter[position], quarter, pts);

    if (oppIsDemoted) bucketAdd(posGlobalVsDemoted, position, pts);
    bucketAdd(posGlobalOverall, position, pts);

    if (teamIsDemoted) {
      if (!demotedPosVsOpp[position]) demotedPosVsOpp[position] = {};
      bucketAdd(demotedPosVsOpp[position], oppName, pts);
      if (!demotedPosVsQuarter[position]) demotedPosVsQuarter[position] = {};
      bucketAdd(demotedPosVsQuarter[position], quarter, pts);
      if (oppIsDemoted) bucketAdd(demotedPosVsDemoted, position, pts);
    }

    const code = lastIdToCode[row.element];
    const currentId = code && codeToCurrentId[code];
    if (currentId) {
      matchedRows++;
      if (!xByQuarter[currentId]) xByQuarter[currentId] = {};
      bucketAdd(xByQuarter[currentId], quarter, pts);
      if (oppIsDemoted) bucketAdd(xVsDemoted, currentId, pts);
    } else {
      unmatchedRows++;
    }
  }
  console.log(`GW rows joined to current players: ${matchedRows} matched, ${unmatchedRows} unmatched (left the league).`);

  // ---- FALLBACKS: ordered bucket lookups per case, always bottoming out at
  // posGlobalOverall so a prediction is never left undefined. ----
  function predictCase1(p, eName) {
    const q = quarterOf[eName];
    let v = bucketAvg(xByQuarter[p.id], q);
    if (v === null && p.last_season_club) v = bucketAvg(teamPosByQuarter[p.last_season_club]?.[p.position], q);
    if (v === null) v = bucketAvg(posGlobalVsQuarter[p.position], q);
    if (v === null) v = bucketAvg(posGlobalOverall, p.position);
    return v;
  }
  function predictCase2(p, eName) {
    let v = bucketAvg(demotedPosVsOpp[p.position], eName);
    if (v === null) v = bucketAvg(demotedPosVsQuarter[p.position], quarterOf[eName]);
    if (v === null) v = bucketAvg(posGlobalVsQuarter[p.position], quarterOf[eName]);
    if (v === null) v = bucketAvg(posGlobalOverall, p.position);
    return v;
  }
  function predictCase3(p) {
    let v = bucketAvg(demotedPosVsDemoted, p.position);
    if (v === null) v = bucketAvg(posGlobalVsDemoted, p.position);
    if (v === null) v = bucketAvg(posGlobalOverall, p.position);
    return v;
  }
  function predictCase4(p) {
    let v = bucketAvg(xVsDemoted, p.id);
    if (v === null && p.last_season_club) v = bucketAvg(teamPosVsDemoted[p.last_season_club], p.position);
    if (v === null) v = bucketAvg(posGlobalVsDemoted, p.position);
    if (v === null) v = bucketAvg(posGlobalOverall, p.position);
    return v;
  }

  console.log("Computing points(x,e) for every player x every possible current-season opponent...");
  const predictions = {};
  for (const p of players) {
    const xPromoted = promoted.includes(p.team);
    const per = {};
    for (const eName of currentTeamNames) {
      if (eName === p.team) continue; // a team never plays itself
      const ePromoted = promoted.includes(eName);
      let v;
      if (!xPromoted && !ePromoted) v = predictCase1(p, eName);
      else if (xPromoted && !ePromoted) v = predictCase2(p, eName);
      else if (xPromoted && ePromoted) v = predictCase3(p);
      else v = predictCase4(p);
      if (v === null || Number.isNaN(v)) v = 0;
      per[eName] = Math.round(v * 100) / 100;
    }
    predictions[p.id] = per;
  }

  // ---- this season's fixture schedule, trimmed to what the app needs ----
  const currentTeamNameById = {};
  for (const t of bootstrap.teams) currentTeamNameById[t.id] = t.name;
  const currentFixtures = currentFixturesRaw
    .filter((f) => f.event) // drop any not-yet-scheduled fixtures
    .map((f) => ({
      event: f.event,
      home: currentTeamNameById[f.team_h],
      away: currentTeamNameById[f.team_a],
    }));

  fs.writeFileSync(
    path.join(DATA_DIR, "predictions.json"),
    JSON.stringify({
      generated_at: new Date().toISOString(),
      last_season: LAST_SEASON,
      quarters: { 1: standings.slice(0, 5).map((s) => s.name), 2: standings.slice(5, 10).map((s) => s.name), 3: standings.slice(10, 15).map((s) => s.name), 4: standings.slice(15, 20).map((s) => s.name) },
      promoted,
      demoted,
      points: predictions,
    })
  );
  fs.writeFileSync(path.join(DATA_DIR, "current_fixtures.json"), JSON.stringify(currentFixtures));

  console.log("Wrote data/predictions.json and data/current_fixtures.json.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
