const $ = (selector) => document.querySelector(selector);

const controls = $("#controls");
const dateInput = $("#dateInput");
const gameQuickNav = $("#gameQuickNav");
const teamQuickNav = $("#teamQuickNav");
const teamSelect = $("#teamSelect");
const refreshHistory = $("#refreshHistory");
const autoRefresh = $("#autoRefresh");
const refreshGameButton = $("#refreshGameButton");
const refreshTodayStats = $("#refreshTodayStats");
const statusLine = $("#statusLine");
const cacheLine = $("#cacheLine");
const networkLine = $("#networkLine");
const errorBox = $("#errorBox");
const gameStrip = $("#gameStrip");
const teamStats = $("#teamStats");
const teamsRoot = $("#teams");

const AUTO_REFRESH_MS = 45000;
let loadToken = 0;
let gameNavToken = 0;
let autoRefreshTimer = null;
let latestData = null;
let quickGames = [];
let quickGameDate = "";
let selectedGameId = "";
let rosterView = "all";

teamsRoot.dataset.mobileSection = "recent";

function kstDateString() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

function kstTimeString(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function hasLiveGame(data) {
  return (data?.games || []).some((game) => {
    const code = String(game?.status_code || "").toUpperCase();
    return code === "STARTED" || code === "2";
  });
}

function selectedTeamLabel(data) {
  if (data?.selected_game) {
    const game = (data.games || []).find((item) => String(item.game_id || "") === String(data.selected_game.game_id || ""));
    return game ? `${game.away_team} @ ${game.home_team}` : "경기 선택";
  }
  return data?.selected_team ? `${data.selected_team.team_name}(${data.selected_team.team_code})` : "전체";
}

function setStatus(data, phase = "ready") {
  const selected = selectedTeamLabel(data);
  const generated = kstTimeString(data?.generated_at);
  const live = hasLiveGame(data);
  const autoText = live && autoRefresh.checked ? " · 자동 갱신 켜짐" : "";
  if (phase === "base") {
    statusLine.textContent = `${selected} · 기본 정보 표시 · 성적 수집 중${generated ? ` · ${generated}` : ""}${autoText}`;
    return;
  }
  if (phase === "auto") {
    statusLine.textContent = `${selected} · 자동 갱신 완료${generated ? ` · ${generated}` : ""}${autoText}`;
    return;
  }
  statusLine.textContent = `${selected}${generated ? ` · 마지막 갱신 ${generated}` : ""}${autoText}`;
}

function setCacheStatus(data, fallback = "") {
  const cache = data?.cache_status;
  cacheLine.textContent = cache?.message || fallback;
}

function num(value, fallback = 0) {
  if (value === null || value === undefined || value === "" || value === "-") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intish(value) {
  return Math.trunc(num(value));
}

function rate(value) {
  if (value === null || value === undefined || value === "" || value === "-") return "-";
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed.toFixed(3).replace("0.", ".");
  const text = String(value);
  return text.startsWith("0.") ? text.replace("0.", ".") : text;
}

function rateFixed(value, width = 5) {
  return rate(value).padStart(width, " ");
}

function decimal(value, digits = 2) {
  if (value === null || value === undefined || value === "" || value === "-") return "-";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : String(value);
}

function signedDecimal(value, digits = 2) {
  if (value === null || value === undefined || value === "" || value === "-") return "-";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : String(value);
}

function war(value) {
  return signedDecimal(value).padStart(5, " ");
}

function count(value, width) {
  return String(intish(value)).padStart(width, " ");
}

function hitAttempts(hit, attempts, width = 3) {
  return `${count(hit, width)}/${count(attempts, width)}`;
}

function hr(value) {
  return `${count(value, 2)}HR`;
}

function rbi(value) {
  return `${count(value, 3)}RBI`;
}

function avg(value) {
  if (value === null || value === undefined || value === "" || value === "-") return "-";
  return rate(value);
}

function formatRecord(wins, draws, losses) {
  return `${intish(wins)}승 ${intish(draws)}무 ${intish(losses)}패`;
}

function teamOverall(stats) {
  if (!stats) return "팀 성적 없음";
  return `${stats.ranking ?? "-"}위 ${formatRecord(stats.winGameCount, stats.drawnGameCount, stats.loseGameCount)} 승률 ${rate(stats.wra)} GB ${stats.gameBehind ?? "-"}`;
}

function teamBatting(stats) {
  if (!stats) return "-";
  return `AVG ${rate(stats.offenseHra)} OPS ${rateFixed(stats.offenseOps)} ${intish(stats.offenseHr)}HR ${intish(stats.offenseRun)}득점`;
}

function teamPitching(stats) {
  if (!stats) return "-";
  return `ERA ${decimal(stats.defenseEra)} WHIP ${decimal(stats.defenseWhip)} QS ${intish(stats.defenseQs)}`;
}

function teamVs(team) {
  const record = team.vs_opponent_record;
  const opponent = team.opponent?.team_name || "상대팀";
  if (!record?.available) return `vs ${opponent} 상대전적 없음`;
  return `vs ${opponent} ${formatRecord(record.wins, record.draws, record.losses)}`;
}

function playerMeta(player) {
  return [player?.position, player?.bats_throws].filter(Boolean).join(" · ");
}

function playerLine(player, extra = "") {
  const name = escapeHtml(player?.name || "정보 없음");
  const meta = playerMeta(player);
  return `${name}${extra ? ` ${extra}` : ""}${meta ? `<small>${escapeHtml(meta)}</small>` : ""}`;
}

function playerName(player) {
  let badge = "";
  if (player?._lineup_state === "replaced") badge = `<span class="change-badge">교체</span>`;
  else if (player?._lineup_state === "current") badge = `<span class="current-label">현재</span>`;
  else if (player?.substitute_in) badge = `<span class="change-badge">교체</span>`;
  return playerLine(player, badge);
}

function rowClass(player) {
  const classes = [];
  if (player?._lineup_state === "replaced") classes.push("lineup-replaced-row");
  if (player?._lineup_state === "current") classes.push("lineup-current-row", "lineup-changed");
  else if (player?.substitute_in) classes.push("lineup-changed");
  if (player?.live_batter) classes.push("live-batter");
  return classes.length ? ` class="${classes.join(" ")}"` : "";
}

function lineupEntries(batter) {
  const replacements = Array.isArray(batter?.replaced_players)
    ? batter.replaced_players.filter((player) => player?.name)
    : batter?.replaced_player?.name
      ? [batter.replaced_player]
      : [];

  if (batter?.substitute_in && replacements.length) {
    return [
      ...replacements.map((player, index) => ({
        ...player,
        bat_order: index === 0 ? (batter.bat_order || player.bat_order) : "↳",
        _lineup_state: "replaced",
      })),
      {
        ...batter,
        bat_order: "↳",
        _lineup_state: "current",
      },
    ];
  }
  return [batter];
}

function recentCell(player) {
  const records = player?.records;
  if (!records || records.error) return "-";
  const summary = records.recent_10_games?.summary || {};
  if (records.player_type === "pitcher") {
    return `${summary.games || 0}G ${summary.innings || "0"}IP ERA ${decimal(summary.era)} WHIP ${decimal(summary.whip)} ${intish(summary.kk)}K`;
  }
  return `${avg(summary.avg)} ${hitAttempts(summary.hit, summary.ab)} ${hr(summary.hr)} ${rbi(summary.rbi)}`;
}

function vsTeamCell(player, includeOpponent = false) {
  const matchup = player?.vs_opponent_team;
  if (!matchup) return "-";
  const opponent = matchup.opponent_team?.team_name || "상대팀";
  const prefix = includeOpponent ? `vs ${opponent} ` : "";
  if (matchup.error) return includeOpponent ? `vs ${opponent}: 기록 오류` : "기록 오류";
  const stats = matchup.stats;
  if (!stats) return includeOpponent ? `vs ${opponent}: 올해 전적 없음` : "올해 전적 없음";

  if (player.records?.player_type === "pitcher") {
    if ((stats.inn === undefined || stats.inn === "" || stats.inn === "-") && (stats.era === undefined || stats.era === "" || stats.era === "-")) {
      return includeOpponent ? `vs ${opponent}: 올해 전적 없음` : "올해 전적 없음";
    }
    return `${prefix}ERA ${decimal(stats.era)} ${stats.inn || "-"}IP ${intish(stats.w)}-${intish(stats.l)} ${intish(stats.kk)}K WHIP ${decimal(stats.whip)}`;
  }

  return `${prefix}${rate(stats.hra)} ${hitAttempts(stats.hit, stats.ab)} OPS ${rateFixed(stats.ops)} ${hr(stats.hr)} ${rbi(stats.rbi)}`;
}

function vsStarterCell(player, includePitcher = false) {
  const matchup = player?.vs_starting_pitcher;
  if (!matchup) return "-";
  const pitcherName = matchup.opposing_pitcher?.name || "상대선발";
  const prefix = includePitcher ? `vs ${pitcherName} ` : "";
  const stats = matchup.stats;
  if (!stats) return includePitcher ? `vs ${pitcherName}: -` : "-";
  if (stats.error) return includePitcher ? `vs ${pitcherName}: 기록 오류` : "기록 오류";
  const summary = stats.summary || {};
  if (!intish(summary.pa)) return includePitcher ? `vs ${pitcherName}: 전적 없음` : "전적 없음";
  return `${prefix}${count(summary.pa, 3)}PA ${hitAttempts(summary.hit, summary.ab)} ${hr(summary.hr)} ${rbi(summary.rbi)} OPS ${rateFixed(summary.ops)}`;
}

function emptyHitterStats(includePa = false) {
  return includePa
    ? { pa: "-", avg: "-", ab: "-", ops: "-", hr: "-", rbi: "-", war: "-" }
    : { avg: "-", ab: "-", ops: "-", hr: "-", rbi: "-", war: "-" };
}

function signedNumber(value, digits = 1) {
  if (value === null || value === undefined || value === "" || value === "-") return "-";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return String(value);
  const text = parsed.toFixed(digits);
  return parsed > 0 ? `+${text}` : text;
}

function todayHitterStats(player) {
  const today = player?.today;
  if (!today) return { line: "-", impact: "-" };
  const ab = intish(today.ab);
  const hit = intish(today.hit);
  const run = intish(today.run);
  const rbiValue = intish(today.rbi);
  const hrValue = intish(today.hr);
  const bb = intish(today.bb);
  const kk = intish(today.kk);
  const sb = intish(today.sb);
  const hasGameLine = [today.pa, today.ab, today.hit, today.run, today.rbi, today.hr].some(
    (value) => value !== null && value !== undefined && value !== "" && value !== "-",
  );
  if (!hasGameLine) return { line: "-", impact: signedNumber(today.impact) };

  const parts = [`${hit}/${ab}`];
  if (run) parts.push(`${run}R`);
  if (rbiValue) parts.push(`${rbiValue}RBI`);
  if (hrValue) parts.push(`${hrValue}HR`);
  if (bb) parts.push(`${bb}BB`);
  if (sb) parts.push(`${sb}SB`);
  if (kk) parts.push(`${kk}K`);
  return {
    line: parts.join(" "),
    impact: signedNumber(today.impact),
  };
}

function recentHitterStats(player) {
  const records = player?.records;
  if (!records || records.error || records.player_type === "pitcher") {
    return emptyHitterStats(false);
  }
  const summary = records.recent_10_games?.summary || {};
  return {
    avg: avg(summary.avg),
    ab: count(summary.ab, 3),
    ops: recentOps(summary),
    hr: count(summary.hr, 2),
    rbi: count(summary.rbi, 3),
  };
}

function opponentHitterStats(player) {
  const stats = player?.vs_opponent_team?.stats;
  if (!stats || stats.ab === "-" || stats.pa === "-") {
    return emptyHitterStats(false);
  }
  return {
    avg: rate(stats.hra),
    ab: count(stats.ab, 3),
    ops: rateFixed(stats.ops),
    hr: count(stats.hr, 2),
    rbi: count(stats.rbi, 3),
  };
}

function starterHitterStats(player) {
  const summary = player?.vs_starting_pitcher?.stats?.summary;
  if (!summary || !intish(summary.pa)) {
    return emptyHitterStats(true);
  }
  return {
    pa: count(summary.pa, 3),
    avg: avg(summary.avg),
    ab: count(summary.ab, 3),
    ops: rateFixed(summary.ops),
    hr: count(summary.hr, 2),
    rbi: count(summary.rbi, 3),
  };
}

function recentOps(summary) {
  const ab = intish(summary.ab);
  if (!ab) return "-";
  const hit = intish(summary.hit);
  const doubles = intish(summary.h2);
  const triples = intish(summary.h3);
  const homers = intish(summary.hr);
  const walks = intish(summary.bb);
  const totalBases = hit + doubles + (2 * triples) + (3 * homers);
  const obpDenominator = ab + walks;
  const obp = obpDenominator ? (hit + walks) / obpDenominator : 0;
  const slg = totalBases / ab;
  return rateFixed(obp + slg);
}

function seasonStatsMatch(player, targetYear) {
  const stats = player?.season_stats;
  if (!stats) return null;
  if (!targetYear || String(stats.season_year || "") === String(targetYear)) return stats;
  return null;
}

function hitterSeasonFromRoster(stats) {
  return {
    avg: rate(stats.avg ?? stats.hra),
    ab: count(stats.ab, 3),
    ops: rateFixed(stats.ops),
    hr: count(stats.hr, 2),
    rbi: count(stats.rbi, 3),
    war: war(stats.war),
  };
}

function seasonHitterStats(player, targetYear) {
  const rosterSeason = seasonStatsMatch(player, targetYear);
  if (rosterSeason && player?.player_role !== "pitcher") {
    return hitterSeasonFromRoster(rosterSeason);
  }

  const records = player?.records;
  const year = seasonRecordForYear(player, targetYear);
  if (!records || records.error || !year || records.player_type === "pitcher") {
    return emptyHitterStats(false);
  }
  return {
    avg: rate(year.hra),
    ab: count(year.ab, 3),
    ops: rateFixed(year.ops),
    hr: count(year.hr, 2),
    rbi: count(year.rbi, 3),
    war: war(year.war),
  };
}

function statValue(data, keys) {
  for (const key of keys) {
    const value = data?.[key];
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return undefined;
}

function innings(value, width = 5) {
  if (value === null || value === undefined || value === "" || value === "-") return "-".padStart(width, " ");
  return String(value).padStart(width, " ");
}

function emptyPitcherStats(includeWar = true) {
  const stats = {
    games: "-",
    innings: "-",
    era: "-",
    whip: "-",
    hr: "-",
    bb: "-",
    win: "-",
    lose: "-",
    save: "-",
    hold: "-",
    kk: "-",
  };
  if (includeWar) stats.war = "-";
  return stats;
}

function recentPitcherStats(player) {
  const records = player?.records;
  if (!records || records.error || records.player_type !== "pitcher") {
    return emptyPitcherStats(false);
  }
  const summary = records.recent_10_games?.summary || {};
  return {
    games: count(summary.games, 2),
    innings: innings(summary.innings),
    era: decimal(summary.era).padStart(5, " "),
    whip: decimal(summary.whip).padStart(4, " "),
    hr: count(summary.hr, 2),
    bb: count(summary.bb, 3),
    kk: count(summary.kk, 3),
  };
}

function pitcherSeasonStats(player, targetYear) {
  const rosterSeason = seasonStatsMatch(player, targetYear);
  if (rosterSeason && player?.player_role === "pitcher") {
    return {
      games: count(rosterSeason.games, 2),
      innings: innings(rosterSeason.innings),
      era: decimal(rosterSeason.era).padStart(5, " "),
      whip: decimal(rosterSeason.whip).padStart(4, " "),
      hr: count(rosterSeason.hr, 2),
      bb: count(rosterSeason.bb, 3),
      win: count(rosterSeason.win, 2),
      lose: count(rosterSeason.lose, 2),
      save: count(rosterSeason.save, 2),
      hold: count(rosterSeason.hold, 2),
      kk: count(rosterSeason.kk, 3),
      war: war(rosterSeason.war),
    };
  }

  const records = player?.records;
  const year = seasonRecordForYear(player, targetYear) || (!targetYear ? records?.current_year_record : null);
  if (!records || records.error || records.player_type !== "pitcher" || !year) {
    return emptyPitcherStats(true);
  }
  return {
    games: count(statValue(year, ["gamenum", "game", "games", "g"]), 2),
    innings: innings(statValue(year, ["inn", "inning", "innings"])),
    era: decimal(statValue(year, ["era"])).padStart(5, " "),
    whip: decimal(statValue(year, ["whip"])).padStart(4, " "),
    hr: count(statValue(year, ["hr", "homeRun"]), 2),
    bb: count(statValue(year, ["bb", "baseOnBalls"]), 3),
    win: count(statValue(year, ["w", "win"]), 2),
    lose: count(statValue(year, ["l", "lose"]), 2),
    save: count(statValue(year, ["sv", "save"]), 2),
    hold: count(statValue(year, ["hold", "hld"]), 2),
    kk: count(statValue(year, ["kk", "so", "k"]), 3),
    war: war(statValue(year, ["war"])),
  };
}

function statCell(value, field = "") {
  const className = field ? ` stat-${field}` : "";
  return `<td class="stat number-stat${className}">${escapeHtml(value)}</td>`;
}

function hitterStatCells(stats, fields) {
  return fields.map((field) => statCell(stats[field], field)).join("");
}

function pitcherStatCells(stats, fields) {
  return fields.map((field) => statCell(stats[field], field)).join("");
}

function sortNumber(value) {
  if (value === null || value === undefined || value === "" || value === "-") return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function rawSeasonStats(player, targetYear) {
  return seasonStatsMatch(player, targetYear) || seasonRecordForYear(player, targetYear) || null;
}

function inningsSortValue(value) {
  if (value === null || value === undefined || value === "" || value === "-") return NaN;
  if (typeof value === "number") return value;
  const text = String(value).trim();
  const match = text.match(/^(\d+)(?:\s+([12])\/3)?$/);
  if (!match) return sortNumber(value);
  return Number(match[1]) + (match[2] ? Number(match[2]) / 3 : 0);
}

function compareNumbers(a, b, direction = "desc") {
  const aValid = Number.isFinite(a);
  const bValid = Number.isFinite(b);
  if (aValid && bValid && a !== b) return direction === "asc" ? a - b : b - a;
  if (aValid && !bValid) return -1;
  if (!aValid && bValid) return 1;
  return 0;
}

function playerNameCompare(a, b) {
  return String(a?.name || "").localeCompare(String(b?.name || ""), "ko-KR");
}

function sortedRosterHitters(players, currentYear) {
  return [...players].sort((a, b) => {
    const aStats = rawSeasonStats(a, currentYear) || {};
    const bStats = rawSeasonStats(b, currentYear) || {};
    return (
      compareNumbers(sortNumber(aStats.avg ?? aStats.hra), sortNumber(bStats.avg ?? bStats.hra), "desc")
      || compareNumbers(sortNumber(aStats.ab), sortNumber(bStats.ab), "desc")
      || playerNameCompare(a, b)
    );
  });
}

function sortedRosterPitchers(players, currentYear) {
  return [...players].sort((a, b) => {
    const aStats = rawSeasonStats(a, currentYear) || {};
    const bStats = rawSeasonStats(b, currentYear) || {};
    return (
      compareNumbers(sortNumber(aStats.era), sortNumber(bStats.era), "asc")
      || compareNumbers(inningsSortValue(aStats.innings ?? aStats.inn), inningsSortValue(bStats.innings ?? bStats.inn), "desc")
      || playerNameCompare(a, b)
    );
  });
}

function renderRecentSeasonRow(batter, currentYear) {
  const today = todayHitterStats(batter);
  const recent = recentHitterStats(batter);
  const season = seasonHitterStats(batter, currentYear);
  return `
    <tr${rowClass(batter)}>
      <td class="num">${escapeHtml(batter.bat_order || "-")}</td>
      <td class="player">${playerName(batter)}</td>
      ${hitterStatCells(today, ["line", "impact"])}
      ${hitterStatCells(recent, ["avg", "ab", "ops", "hr", "rbi"])}
      ${hitterStatCells(season, ["avg", "ab", "ops", "hr", "rbi", "war"])}
    </tr>
  `;
}

function renderRecentSeasonRows(batter, currentYear) {
  return lineupEntries(batter).map((entry) => renderRecentSeasonRow(entry, currentYear)).join("");
}

function renderMatchupRow(batter) {
  const opponent = opponentHitterStats(batter);
  const starter = starterHitterStats(batter);
  return `
    <tr${rowClass(batter)}>
      <td class="num">${escapeHtml(batter.bat_order || "-")}</td>
      <td class="player">${playerName(batter)}</td>
      ${hitterStatCells(opponent, ["avg", "ab", "ops", "hr", "rbi"])}
      ${hitterStatCells(starter, ["pa", "avg", "ab", "ops", "hr", "rbi"])}
    </tr>
  `;
}

function renderMatchupRows(batter) {
  return lineupEntries(batter).map(renderMatchupRow).join("");
}

const contextAvgOnlyColumns = [
  ["opponent", "상대팀"],
  ["month", "월"],
  ["weekday", "요일"],
  ["stadium", "구장"],
  ["home_away", "홈/방문"],
  ["day_night", "주야간"],
  ["half", "전후반기"],
];

function contextRows(player) {
  const rows = player?.context_matchups?.rows;
  return Array.isArray(rows) ? rows : [];
}

function contextRowByKind(player, kind) {
  return contextRows(player).find((row) => row?.kind === kind) || null;
}

function contextStat(row, key) {
  if (!row || row[key] === null || row[key] === undefined || row[key] === "") return "-";
  return rateFixed(row[key]);
}

function contextHeaderTitle(player, kind, title) {
  const row = contextRowByKind(player, kind);
  const situation = row?.situation || "";
  if (!situation || situation === "-") return title;
  if (kind === "pitcher") {
    if (situation === "좌완") return "좌투수";
    if (situation === "우완") return "우투수";
    if (situation === "언더") return "언더투수";
    return `${situation}투수`;
  }
  if (kind === "opponent") return `vs.${situation}`;
  if (kind === "month") return `${situation}월`;
  if (kind === "weekday") return `${situation}요일`;
  if (kind === "stadium") return situation;
  if (kind === "home_away") return situation === "방문" ? "원정" : situation;
  return situation;
}

function contextHeaderPlayer(batters) {
  return batters.flatMap(lineupEntries).find((player) => contextRows(player).length) || null;
}

function renderContextMatchupRow(batter, currentYear) {
  const season = seasonHitterStats(batter, currentYear);
  const pitcher = contextRowByKind(batter, "pitcher");
  const pitcherTitle = pitcher?.label ? ` title="${escapeHtml(pitcher.label)}"` : "";
  return `
    <tr${rowClass(batter)}>
      <td class="num">${escapeHtml(batter.bat_order || "-")}</td>
      <td class="player">${playerName(batter)}</td>
      <td class="stat number-stat stat-avg">${escapeHtml(season.avg)}</td>
      <td class="stat number-stat stat-ops">${escapeHtml(season.ops)}</td>
      <td class="stat number-stat stat-avg"${pitcherTitle}>${escapeHtml(contextStat(pitcher, "avg"))}</td>
      <td class="stat number-stat stat-ops"${pitcherTitle}>${escapeHtml(contextStat(pitcher, "ops"))}</td>
      ${contextAvgOnlyColumns.map(([kind]) => {
        const row = contextRowByKind(batter, kind);
        const label = row?.label ? ` title="${escapeHtml(row.label)}"` : "";
        return `
          <td class="stat number-stat stat-avg"${label}>${escapeHtml(contextStat(row, "avg"))}</td>
        `;
      }).join("")}
    </tr>
  `;
}

function renderContextMatchupRows(batter, currentYear) {
  return lineupEntries(batter).map((entry) => renderContextMatchupRow(entry, currentYear)).join("");
}

function renderHistoryRow(batter, yearColumns) {
  return `
    <tr${rowClass(batter)}>
      <td class="num">${escapeHtml(batter.bat_order || "-")}</td>
      <td class="player">${playerName(batter)}</td>
      ${yearColumns.map((year) => {
        const stats = seasonHitterStats(batter, year);
        return hitterStatCells(stats, ["avg", "ab", "ops", "hr", "rbi", "war"]);
      }).join("")}
    </tr>
  `;
}

function renderHistoryRows(batter, yearColumns) {
  return lineupEntries(batter).map((entry) => renderHistoryRow(entry, yearColumns)).join("");
}

function historyYears(data) {
  const seasonYear = Number(data.season_year || String(data.target_date || "").slice(0, 4));
  if (!Number.isFinite(seasonYear)) return [];
  return [seasonYear, seasonYear - 1, seasonYear - 2];
}

function shortSeasonYear(year) {
  return String(year);
}

function seasonRecordForYear(player, targetYear) {
  const records = player?.records;
  const years = Array.isArray(records?.recent_3_years) ? records.recent_3_years : [];
  return years.find((year) => String(year?.gyear) === String(targetYear));
}

function totalScore(value) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function isScoredGame(game) {
  return game?.scoreboard?.visible || ["STARTED", "RESULT", "2", "4"].includes(String(game?.status_code || "").toUpperCase());
}

function scoreChip(game) {
  if (!isScoredGame(game) || game.away_score === undefined || game.home_score === undefined) {
    return game.status || "-";
  }
  return `${game.away_score} : ${game.home_score}`;
}

function renderScoreboard(game) {
  const board = game?.scoreboard;
  if (!board?.visible || !Array.isArray(board.teams) || !board.teams.length) return "";
  const columns = Array.isArray(board.columns) ? board.columns : [];
  return `
    <div class="scoreboard">
      <table>
        <thead>
          <tr>
            <th>팀</th>
            ${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}
            <th>R</th>
            <th>H</th>
            <th>E</th>
          </tr>
        </thead>
        <tbody>
          ${board.teams.map((row) => `
            <tr>
              <th>${escapeHtml(row.name || "-")}</th>
              ${columns.map((_, index) => `<td>${escapeHtml(row.scores?.[index] ?? "")}</td>`).join("")}
              <td class="score-total">${escapeHtml(totalScore(row.r))}</td>
              <td class="score-total">${escapeHtml(totalScore(row.h))}</td>
              <td class="score-total">${escapeHtml(totalScore(row.e))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderGameCard(game, data) {
  return `
    <article class="game-card">
      <div class="game-card-head">
        <strong>${escapeHtml(game.away_team)} @ ${escapeHtml(game.home_team)}</strong>
        <div class="game-meta">
          <span class="chip">${escapeHtml(game.time || "-")}</span>
          <span class="chip">${escapeHtml(game.stadium || "-")}</span>
          <span class="chip">${escapeHtml(scoreChip(game))}</span>
          <span class="chip">${escapeHtml(data.target_date)} KST</span>
        </div>
      </div>
      ${renderScoreboard(game)}
    </article>
  `;
}

function renderGameStrip(data) {
  const games = Array.isArray(data.games) ? data.games : [];
  if (!games.length) {
    gameStrip.hidden = true;
    return;
  }
  gameStrip.hidden = false;
  gameStrip.innerHTML = games.map((game) => renderGameCard(game, data)).join("");
}

function teamOptionValue(candidates) {
  const options = Array.from(teamSelect.options);
  for (const candidate of candidates.filter(Boolean)) {
    const direct = options.find((option) => option.value === candidate);
    if (direct) return direct.value;
    const labelMatch = options.find((option) => option.textContent.trim() === candidate);
    if (labelMatch) return labelMatch.value;
  }

  const keys = candidates.filter(Boolean).map(normalizeKey);
  const fuzzy = options.find((option) => {
    const valueKey = normalizeKey(option.value);
    const labelKey = normalizeKey(option.textContent);
    return keys.includes(valueKey) || keys.includes(labelKey);
  });
  return fuzzy?.value || candidates.find(Boolean) || "";
}

function ensureTeamOption(value, label) {
  if (!value || Array.from(teamSelect.options).some((option) => option.value === value)) return;
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label || value;
  teamSelect.append(option);
}

function gameJumpTeam(game) {
  return teamOptionValue([game.away_code, game.away_team]);
}

function selectedTeamKeys() {
  const selected = teamSelect.selectedOptions[0];
  return new Set([teamSelect.value, selected?.textContent].filter(Boolean).map(normalizeKey));
}

function teamOptions() {
  return Array.from(teamSelect.options).map((option) => ({
    value: option.value,
    label: option.textContent.trim() || option.value || "전체",
  }));
}

function renderTeamQuickNav() {
  const options = teamOptions();
  if (!options.length) {
    teamQuickNav.hidden = true;
    teamQuickNav.innerHTML = "";
    return;
  }

  teamQuickNav.hidden = false;
  teamQuickNav.innerHTML = options.map((option) => {
    const active = !selectedGameId && teamSelect.value === option.value ? " active" : "";
    return `
      <button
        class="team-jump${active}"
        type="button"
        data-team-value="${escapeHtml(option.value)}"
        data-team-label="${escapeHtml(option.label)}"
        title="${escapeHtml(option.label)}"
      >${escapeHtml(option.label)}</button>
    `;
  }).join("");
}

function isSelectedGame(game) {
  if (selectedGameId) return String(game?.game_id || "") === String(selectedGameId);
  return false;
}

function renderGameQuickNav(games = quickGames) {
  const visibleGames = Array.isArray(games) ? games.slice(0, 5) : [];
  if (!visibleGames.length) {
    gameQuickNav.hidden = true;
    gameQuickNav.innerHTML = "";
    return;
  }

  gameQuickNav.hidden = false;
  const allButton = `
    <button
      class="game-jump game-jump-all${!selectedGameId && teamSelect.value === "" ? " active" : ""}"
      type="button"
      data-game-team=""
      data-game-team-label="전체"
      data-game-id=""
      title="전체 경기"
    >
      <span>전체</span>
      <small>${escapeHtml(visibleGames.length)}경기</small>
    </button>
  `;
  const gameButtons = visibleGames.map((game) => {
    const teamValue = gameJumpTeam(game);
    const label = `${game.away_team || "-"} @ ${game.home_team || "-"}`;
    const meta = [game.time, game.status].filter(Boolean).join(" · ") || "경기";
    const active = isSelectedGame(game) ? " active" : "";
    return `
      <button
        class="game-jump${active}"
        type="button"
        data-game-team="${escapeHtml(teamValue)}"
        data-game-team-label="${escapeHtml(game.away_team || teamValue)}"
        data-game-id="${escapeHtml(game.game_id || "")}"
        title="${escapeHtml(label)}"
      >
        <span>${escapeHtml(label)}</span>
        <small>${escapeHtml(meta)}</small>
      </button>
    `;
  }).join("");
  gameQuickNav.innerHTML = `${allButton}${gameButtons}`;
}

async function loadGameQuickNav() {
  const targetDate = dateInput.value;
  if (!targetDate) return;
  const token = ++gameNavToken;
  try {
    const params = new URLSearchParams({ date: targetDate, _: Date.now().toString() });
    const response = await fetch(`/api/games?${params.toString()}`, { cache: "no-store" });
    const data = await response.json();
    if (token !== gameNavToken) return;
    if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
    quickGames = Array.isArray(data.games) ? data.games : [];
    quickGameDate = data.target_date || targetDate;
    renderGameQuickNav(quickGames);
    renderTeamQuickNav();
  } catch {
    if (token !== gameNavToken) return;
    quickGames = [];
    quickGameDate = "";
    renderGameQuickNav([]);
    renderTeamQuickNav();
  }
}

function matchupPitcherForTeam(team, batters) {
  if (team?.matchup_pitcher?.name) return team.matchup_pitcher;
  const matchup = batters.find((batter) => batter.vs_starting_pitcher)?.vs_starting_pitcher;
  const pitcher = matchup?.opposing_pitcher;
  return pitcher?.name ? { ...pitcher, role: "starter" } : { name: "상대선발", role: "starter" };
}

function pitcherTodayLine(player) {
  const today = player?.today;
  if (!today) return "";
  return `오늘 ${today.inn || "-"}IP ${intish(today.hit)}H ${intish(today.run)}R ${intish(today.er)}ER ${intish(today.kk)}K`;
}

function pitcherSummaryCell(displayPitcher, starterPitcher) {
  const today = pitcherTodayLine(displayPitcher);
  if (today) return today;
  return recentCell(starterPitcher || displayPitcher);
}

function pitcherContextCell(displayPitcher, starterPitcher) {
  if (displayPitcher?.role === "current") {
    const samePitcher = displayPitcher.player_code && starterPitcher?.player_code && displayPitcher.player_code === starterPitcher.player_code;
    return samePitcher ? vsTeamCell(starterPitcher, true) : "경기 중 현재 등판";
  }
  return vsTeamCell(starterPitcher || displayPitcher, true);
}

function renderTeamStats(data) {
  const rows = data.league_team_stats?.teams || [];
  if (!rows.length || data.selected_team || data.selected_game) {
    teamStats.hidden = true;
    teamStats.innerHTML = "";
    return;
  }
  teamStats.hidden = false;
  teamStats.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>순위</th>
          <th>팀</th>
          <th>전체</th>
          <th>타격</th>
          <th>투수</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((stats) => `
          <tr>
            <td class="num">${escapeHtml(stats.ranking ?? "-")}</td>
            <td><strong>${escapeHtml(stats.teamName || stats.teamShortName || "-")}</strong></td>
            <td>${escapeHtml(teamOverall(stats))}</td>
            <td class="stat">${escapeHtml(teamBatting(stats))}</td>
            <td class="stat">${escapeHtml(teamPitching(stats))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderRosterHitterRow(player, yearColumns, displayOrder) {
  const recent = recentHitterStats(player);
  return `
    <tr>
      <td class="num">${escapeHtml(displayOrder || "-")}</td>
      <td class="player">${playerName(player)}</td>
      ${hitterStatCells(recent, ["avg", "ab", "ops", "hr", "rbi"])}
      ${yearColumns.map((year) => {
        const season = seasonHitterStats(player, year);
        return hitterStatCells(season, ["avg", "ab", "ops", "hr", "rbi", "war"]);
      }).join("")}
    </tr>
  `;
}

function renderRosterPitcherRow(player, yearColumns, displayOrder) {
  const recent = recentPitcherStats(player);
  return `
    <tr>
      <td class="num">${escapeHtml(displayOrder || "-")}</td>
      <td class="player">${playerName(player)}</td>
      ${pitcherStatCells(recent, ["games", "innings", "era", "whip", "hr", "bb", "kk"])}
      ${yearColumns.map((year) => {
        const season = pitcherSeasonStats(player, year);
        return pitcherStatCells(season, ["games", "innings", "era", "whip", "hr", "bb", "win", "lose", "save", "hold", "kk"]);
      }).join("")}
    </tr>
  `;
}

function renderRosterViewTabs() {
  const options = [
    ["all", "전체"],
    ["hitters", "타자"],
    ["pitchers", "투수"],
  ];
  return `
    <div class="roster-view-tabs" aria-label="선수 보기">
      ${options.map(([value, label]) => `
        <button
          class="roster-view-tab${rosterView === value ? " active" : ""}"
          type="button"
          data-roster-view="${escapeHtml(value)}"
        >${escapeHtml(label)}</button>
      `).join("")}
    </div>
  `;
}

function renderRosterTeamPanel(team, data) {
  const stats = team.team_season || {};
  const hitters = Array.isArray(team.batting_order) ? team.batting_order : [];
  const pitchers = Array.isArray(team.pitching_staff) ? team.pitching_staff : [];
  const yearColumns = historyYears(data);
  const currentYear = Number(data.season_year || String(data.target_date || "").slice(0, 4));
  const showHitters = rosterView !== "pitchers";
  const showPitchers = rosterView !== "hitters";
  const sortedHitters = sortedRosterHitters(hitters, currentYear);
  const sortedPitchers = sortedRosterPitchers(pitchers, currentYear);
  const counts = team.roster_counts || { hitters: hitters.length, pitchers: pitchers.length };
  const hitterColspan = 2 + 5 + (yearColumns.length * 6);
  const pitcherColspan = 2 + 7 + (yearColumns.length * 11);

  return `
    <article class="team-panel roster-panel selected">
      <div class="team-head">
        <div>
          <div class="team-title">
            <h2>${escapeHtml(team.team_name)}</h2>
            ${renderRosterViewTabs()}
          </div>
          <div class="status">${escapeHtml(team.basis || "")}${team.note ? ` · ${escapeHtml(team.note)}` : ""}</div>
        </div>
        <div class="record-line">
          <span class="chip">${escapeHtml(teamOverall(stats))}</span>
          <span class="chip">타자 ${escapeHtml(counts.hitters ?? hitters.length)}명</span>
          <span class="chip">투수 ${escapeHtml(counts.pitchers ?? pitchers.length)}명</span>
        </div>
      </div>

      <div class="metric-grid">
        <div class="metric"><span>타격</span><strong class="stat">${escapeHtml(teamBatting(stats))}</strong></div>
        <div class="metric"><span>투수</span><strong class="stat">${escapeHtml(teamPitching(stats))}</strong></div>
        <div class="metric"><span>최근5</span><strong>${escapeHtml(stats.lastFiveGames || "-")}</strong></div>
        <div class="metric"><span>연속</span><strong>${escapeHtml(stats.continuousGameResult || "-")}</strong></div>
      </div>

      ${rosterView === "all" ? `
        <div class="mobile-section-tabs" aria-label="표 전환">
          <button class="section-tab" type="button" data-section="recent">타자</button>
          <button class="section-tab" type="button" data-section="matchup">투수</button>
        </div>
      ` : ""}

      <section class="team-section section-recent"${showHitters ? "" : " hidden"}>
        <div class="table-title">타자 엔트리 · AVG 순 · 최근10G / 최근 3년 성적</div>
        <div class="table-scroll">
          <table class="lineup-table recent-season-table roster-table roster-hitter-table">
            <thead>
              <tr>
                <th class="num" rowspan="2">순</th>
                <th rowspan="2">선수</th>
                <th class="group-head" colspan="5">최근10G</th>
                ${yearColumns.map((year) => `<th class="group-head" colspan="6">${escapeHtml(shortSeasonYear(year))}년 성적</th>`).join("")}
              </tr>
              <tr class="sub-head">
                <th class="stat-focus">AVG</th>
                <th>AB</th>
                <th>OPS</th>
                <th>HR</th>
                <th>RBI</th>
                ${yearColumns.map(() => `
                  <th class="stat-focus">AVG</th>
                  <th>AB</th>
                  <th>OPS</th>
                  <th>HR</th>
                  <th>RBI</th>
                  <th>WAR</th>
                `).join("")}
              </tr>
            </thead>
            <tbody>
              ${sortedHitters.map((player, index) => renderRosterHitterRow(player, yearColumns, index + 1)).join("") || `<tr><td colspan="${escapeHtml(hitterColspan)}" class="empty-state">타자 정보 없음</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>

      <section class="team-section section-matchup"${showPitchers ? "" : " hidden"}>
        <div class="table-title">투수 엔트리 · ERA 순 · 최근10G / 최근 3년 성적</div>
        <div class="table-scroll">
          <table class="lineup-table pitcher-roster-table roster-table">
            <thead>
              <tr>
                <th class="num" rowspan="2">순</th>
                <th rowspan="2">선수</th>
                <th class="group-head" colspan="7">최근10G</th>
                ${yearColumns.map((year) => `<th class="group-head" colspan="11">${escapeHtml(shortSeasonYear(year))}년 성적</th>`).join("")}
              </tr>
              <tr class="sub-head">
                <th>G</th>
                <th>IP</th>
                <th class="stat-focus">ERA</th>
                <th>WHIP</th>
                <th>HR</th>
                <th>BB</th>
                <th>K</th>
                ${yearColumns.map(() => `
                  <th>G</th>
                  <th>IP</th>
                  <th class="stat-focus">ERA</th>
                  <th>WHIP</th>
                  <th>HR</th>
                  <th>BB</th>
                  <th>W</th>
                  <th>L</th>
                  <th>SV</th>
                  <th>HLD</th>
                  <th>K</th>
                `).join("")}
              </tr>
            </thead>
            <tbody>
              ${sortedPitchers.map((player, index) => renderRosterPitcherRow(player, yearColumns, index + 1)).join("") || `<tr><td colspan="${escapeHtml(pitcherColspan)}" class="empty-state">투수 정보 없음</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    </article>
  `;
}

function renderTeamPanel(team, data) {
  if (data.view_mode === "team_roster" || team.roster_mode) {
    return renderRosterTeamPanel(team, data);
  }

  const selectedCode = data.selected_team?.team_code;
  const className = selectedCode
    ? team.team_code === selectedCode ? "selected" : "opponent"
    : team.side === "away" ? "selected" : "opponent";
  const stats = team.team_season || {};
  const batters = Array.isArray(team.batting_order) ? team.batting_order : [];
  const pitcher = team.starting_pitcher || {};
  const opponentName = team.opponent?.team_name || "상대팀";
  const matchupPitcher = matchupPitcherForTeam(team, batters);
  const matchupPitcherLabel = matchupPitcher.role === "current" ? "상대 현재 투수" : "상대 선발";
  const displayPitcher = team.current_pitcher?.name ? team.current_pitcher : pitcher;
  const pitcherLabel = displayPitcher.role === "current" ? "현재투수" : "선발투수";
  const yearColumns = historyYears(data);
  const currentYear = Number(data.season_year || String(data.target_date || "").slice(0, 4));
  const contextPlayer = contextHeaderPlayer(batters);
  const contextColspan = 2 + 2 + 2 + contextAvgOnlyColumns.length;

  return `
    <article class="team-panel ${className}">
      <div class="team-head">
        <div>
          <div class="team-title">
            <h2>${escapeHtml(team.team_name)}</h2>
            <span class="chip">${escapeHtml(team.status || "-")}</span>
          </div>
          <div class="status">${escapeHtml(team.basis || "")}${team.note ? ` · ${escapeHtml(team.note)}` : ""}</div>
        </div>
        <div class="record-line">
          <span class="chip">${escapeHtml(teamOverall(stats))}</span>
          <span class="chip">${escapeHtml(teamVs(team))}</span>
        </div>
      </div>

      <div class="metric-grid">
        <div class="metric"><span>타격</span><strong class="stat">${escapeHtml(teamBatting(stats))}</strong></div>
        <div class="metric"><span>투수</span><strong class="stat">${escapeHtml(teamPitching(stats))}</strong></div>
        <div class="metric"><span>최근5</span><strong>${escapeHtml(stats.lastFiveGames || "-")}</strong></div>
        <div class="metric"><span>연속</span><strong>${escapeHtml(stats.continuousGameResult || "-")}</strong></div>
      </div>

      <div class="pitcher-line">
        <div>
          <div class="subtle">${escapeHtml(pitcherLabel)}</div>
          <div class="pitcher-name">
            ${escapeHtml(displayPitcher.name || "정보 없음")}
            ${displayPitcher.role === "current" ? `<span class="chip live-chip">현재</span>` : ""}
          </div>
        </div>
        <div class="stat">${escapeHtml(pitcherSummaryCell(displayPitcher, pitcher))}</div>
        <div class="stat">${escapeHtml(pitcherContextCell(displayPitcher, pitcher))}</div>
      </div>

      <div class="mobile-section-tabs" aria-label="표 전환">
        <button class="section-tab" type="button" data-section="recent">최근/올해</button>
        <button class="section-tab" type="button" data-section="matchup">매치업</button>
        <button class="section-tab" type="button" data-section="history">3년</button>
      </div>

      <section class="team-section section-recent">
        <div class="table-title">오늘 / 최근10G / ${escapeHtml(currentYear)}년 성적</div>
        <div class="table-scroll">
          <table class="lineup-table recent-season-table">
            <thead>
              <tr>
                <th class="num" rowspan="2">순</th>
                <th rowspan="2">선수</th>
                <th class="group-head" colspan="2">오늘</th>
                <th class="group-head" colspan="5">최근10G</th>
                <th class="group-head" colspan="6">${escapeHtml(currentYear)}년 성적</th>
              </tr>
              <tr class="sub-head">
                <th>기록</th>
                <th>기여</th>
                <th>AVG</th>
                <th>AB</th>
                <th>OPS</th>
                <th>HR</th>
                <th>RBI</th>
                <th>AVG</th>
                <th>AB</th>
                <th>OPS</th>
                <th>HR</th>
                <th>RBI</th>
                <th>WAR</th>
              </tr>
            </thead>
            <tbody>
              ${batters.map((batter) => renderRecentSeasonRows(batter, currentYear)).join("") || `<tr><td colspan="15" class="empty-state">라인업 정보 없음</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>

      <section class="team-section section-matchup">
        <div class="table-title">매치업 기록</div>
        <div class="table-scroll">
          <table class="lineup-table matchup-table">
            <thead>
              <tr>
                <th class="num" rowspan="2">순</th>
                <th rowspan="2">선수</th>
                <th class="group-head" colspan="5">상대팀 vs ${escapeHtml(opponentName)} 올해</th>
                <th class="group-head" colspan="6">${escapeHtml(matchupPitcherLabel)} vs ${escapeHtml(matchupPitcher.name || "-")}</th>
              </tr>
              <tr class="sub-head">
                <th>AVG</th>
                <th>AB</th>
                <th>OPS</th>
                <th>HR</th>
                <th>RBI</th>
                <th>PA</th>
                <th>AVG</th>
                <th>AB</th>
                <th>OPS</th>
                <th>HR</th>
                <th>RBI</th>
              </tr>
            </thead>
            <tbody>
              ${batters.map(renderMatchupRows).join("") || `<tr><td colspan="13" class="empty-state">라인업 정보 없음</td></tr>`}
            </tbody>
          </table>
        </div>

        <div class="table-title context-title">
          <span>오늘 상황별 타자 AVG</span>
        </div>
        <div class="table-scroll">
          <table class="lineup-table context-matchup-table">
            <thead>
              <tr>
                <th class="num" rowspan="2">순</th>
                <th rowspan="2">선수</th>
                <th class="group-head" colspan="2">${escapeHtml(currentYear)}</th>
                <th class="group-head" colspan="2">${escapeHtml(contextHeaderTitle(contextPlayer, "pitcher", "투수상황"))}</th>
                ${contextAvgOnlyColumns.map(([kind, title]) => `<th class="group-head" rowspan="2">${escapeHtml(contextHeaderTitle(contextPlayer, kind, title))}</th>`).join("")}
              </tr>
              <tr class="sub-head">
                <th>AVG</th>
                <th>OPS</th>
                <th>AVG</th>
                <th>OPS</th>
              </tr>
            </thead>
            <tbody>
              ${batters.map((batter) => renderContextMatchupRows(batter, currentYear)).join("") || `<tr><td colspan="${escapeHtml(contextColspan)}" class="empty-state">상황별 기록 없음</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>

      <section class="team-section section-history">
        <details class="history">
          <summary>최근 3년 시즌 흐름</summary>
          <div class="table-scroll">
            <table class="history-table">
              <thead>
                <tr>
                  <th class="num" rowspan="2">순</th>
                  <th rowspan="2">선수</th>
                  ${yearColumns.map((year) => `<th class="group-head" colspan="6">${escapeHtml(shortSeasonYear(year))}</th>`).join("")}
                </tr>
                <tr class="sub-head">
                  ${yearColumns.map(() => `
                    <th>AVG</th>
                    <th>AB</th>
                    <th>OPS</th>
                    <th>HR</th>
                    <th>RBI</th>
                    <th>WAR</th>
                  `).join("")}
                </tr>
              </thead>
              <tbody>
                ${batters.map((batter) => renderHistoryRows(batter, yearColumns)).join("")}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </article>
  `;
}

function renderTeams(data) {
  const teams = data.teams || [];
  teamsRoot.dataset.mobileSection = teamsRoot.dataset.mobileSection || "recent";
  if (data.view_mode === "team_roster" && teamsRoot.dataset.mobileSection === "history") {
    teamsRoot.dataset.mobileSection = "recent";
  }
  if (data.view_mode === "team_roster") {
    if (rosterView === "hitters") teamsRoot.dataset.mobileSection = "recent";
    if (rosterView === "pitchers") teamsRoot.dataset.mobileSection = "matchup";
  }
  if (!teams.length) {
    teamsRoot.innerHTML = `<div class="empty-state">표시할 팀 정보가 없습니다.</div>`;
    return;
  }
  teamsRoot.innerHTML = teams.map((team) => renderTeamPanel(team, data)).join("");
}

function setMobileSection(section) {
  teamsRoot.dataset.mobileSection = ["recent", "matchup", "history"].includes(section) ? section : "recent";
}

function setLoading(isLoading, message = "데이터 수집 중") {
  controls.querySelectorAll("button").forEach((button) => {
    button.disabled = isLoading;
  });
  if (isLoading) statusLine.textContent = message;
}

function showError(message) {
  errorBox.hidden = !message;
  errorBox.textContent = message || "";
}

function buildLineupParams({ includeRecords = true, refreshDailyStats = false, refreshHistoryMode = false } = {}) {
  const params = new URLSearchParams({
    date: dateInput.value,
    team: teamSelect.value,
  });
  if (selectedGameId) params.set("gameId", selectedGameId);
  if (!includeRecords) params.set("noPlayerRecords", "1");
  if (refreshHistoryMode) params.set("refreshHistory", "1");
  if (refreshDailyStats) params.set("refreshDailyStats", "1");
  params.set("_", Date.now().toString());
  return params;
}

async function fetchLineups(options = {}) {
  const params = buildLineupParams(options);
  const response = await fetch(`/api/lineups?${params.toString()}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function renderData(data, phase = "ready") {
  latestData = data;
  if (quickGameDate === data.target_date) renderGameQuickNav(quickGames);
  renderGameStrip(data);
  renderTeamStats(data);
  renderTeams(data);
  setStatus(data, phase);
  setCacheStatus(data, phase === "base" ? "기본 정보 먼저 표시 중" : "");
}

function clearAutoRefresh() {
  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function scheduleAutoRefresh(data) {
  clearAutoRefresh();
  if (!autoRefresh.checked || !hasLiveGame(data)) return;
  autoRefreshTimer = window.setTimeout(() => {
    loadData({
      progressive: false,
      silent: true,
      phase: "auto",
      refreshHistoryMode: false,
    });
  }, AUTO_REFRESH_MS);
}

async function loadData({
  progressive = true,
  refreshDailyStats = false,
  silent = false,
  phase = "ready",
  refreshHistoryMode = refreshHistory.checked,
} = {}) {
  const token = ++loadToken;
  clearAutoRefresh();
  if (!silent) {
    setLoading(true, progressive ? "기본 정보 불러오는 중" : "데이터 수집 중");
    showError("");
  }

  try {
    if (progressive) {
      const baseData = await fetchLineups({ includeRecords: false });
      if (token !== loadToken) return;
      renderData(baseData, "base");
      if (!silent) setLoading(true, "성적 붙이는 중");
    }

    const fullData = await fetchLineups({
      includeRecords: true,
      refreshDailyStats,
      refreshHistoryMode: refreshDailyStats ? false : refreshHistoryMode,
    });
    if (token !== loadToken) return;
    renderData(fullData, phase);
    if (refreshHistoryMode && !refreshDailyStats) refreshHistory.checked = false;
  } catch (error) {
    if (token !== loadToken) return;
    showError(error.message);
    statusLine.textContent = "조회 실패";
  } finally {
    if (token === loadToken) {
      if (!silent) setLoading(false);
      if (latestData) scheduleAutoRefresh(latestData);
    }
  }
}

dateInput.value = kstDateString();
teamSelect.value = "NC";
renderTeamQuickNav();
controls.addEventListener("submit", (event) => {
  event.preventDefault();
  loadData({ progressive: true });
});
teamSelect.addEventListener("change", () => {
  selectedGameId = "";
  renderGameQuickNav(quickGames);
  renderTeamQuickNav();
  loadData({ progressive: true });
});
dateInput.addEventListener("change", () => {
  selectedGameId = "";
  loadGameQuickNav();
  loadData({ progressive: true });
});
gameQuickNav.addEventListener("click", (event) => {
  const button = event.target.closest(".game-jump");
  if (!button) return;
  selectedGameId = button.dataset.gameId || "";
  teamSelect.value = "";
  renderGameQuickNav(quickGames);
  renderTeamQuickNav();
  loadData({ progressive: true });
});
teamQuickNav.addEventListener("click", (event) => {
  const button = event.target.closest(".team-jump");
  if (!button) return;
  const value = button.dataset.teamValue || "";
  ensureTeamOption(value, button.dataset.teamLabel || value || "전체");
  teamSelect.value = value;
  selectedGameId = "";
  renderGameQuickNav(quickGames);
  renderTeamQuickNav();
  loadData({ progressive: true });
});
refreshGameButton.addEventListener("click", () => loadData({ progressive: true }));
refreshTodayStats.addEventListener("click", () => loadData({ progressive: false, refreshDailyStats: true }));
autoRefresh.addEventListener("change", () => {
  if (latestData) scheduleAutoRefresh(latestData);
});
teamsRoot.addEventListener("click", (event) => {
  const rosterButton = event.target.closest("[data-roster-view]");
  if (rosterButton) {
    rosterView = rosterButton.dataset.rosterView || "all";
    if (rosterView === "hitters") setMobileSection("recent");
    if (rosterView === "pitchers") setMobileSection("matchup");
    if (latestData) renderData(latestData);
    return;
  }

  const button = event.target.closest("[data-section]");
  if (!button) return;
  setMobileSection(button.dataset.section);
});

async function loadNetworkInfo() {
  try {
    const response = await fetch(`/api/network?_=${Date.now()}`, { cache: "no-store" });
    const data = await response.json();
    const firstAddress = data.addresses?.[0]?.url;
    networkLine.textContent = firstAddress ? `외부접속 ${firstAddress}` : "외부접속 주소를 확인하지 못했습니다";
  } catch {
    networkLine.textContent = "";
  }
}

loadNetworkInfo();
loadGameQuickNav();
loadData({ progressive: true });
