const $ = (selector) => document.querySelector(selector);

const controls = $("#controls");
const dateInput = $("#dateInput");
const prevDateButton = $("#prevDateButton");
const nextDateButton = $("#nextDateButton");
const quickNavToggle = $("#quickNavToggle");
const quickNavPanel = $("#quickNavPanel");
const quickNavToggleState = $("#quickNavToggleState");
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
const TEAM_OVERVIEW_VALUE = "__teams__";
const TODAY_VIEW_OPTIONS = [
  ["fielders", "오늘의 야수", "야수"],
  ["pitchers", "오늘의 투수", "투수"],
];
let loadToken = 0;
let gameNavToken = 0;
let autoRefreshTimer = null;
let latestData = null;
let quickGames = [];
let quickGameDate = "";
let selectedGameId = "";
let rosterView = "all";
let todayView = "";
let todayPositionFilter = "";
let gameStatusView = false;

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

function parseDateInputValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateInputValue(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function changeDateBy(days) {
  const current = parseDateInputValue(dateInput.value) || parseDateInputValue(kstDateString());
  if (!current) return;
  current.setUTCDate(current.getUTCDate() + days);
  dateInput.value = formatDateInputValue(current);
  handleDateChange();
}

function validRosterView(value) {
  return ["all", "hitters", "pitchers"].includes(value) ? value : "all";
}

function validTodayView(value) {
  if (["fielders", "infielders", "outfielders"].includes(value)) return "fielders";
  return TODAY_VIEW_OPTIONS.some(([key]) => key === value) ? value : "";
}

function todayViewLabel(value = todayView) {
  return TODAY_VIEW_OPTIONS.find(([key]) => key === value)?.[1] || "";
}

function todayViewButtonLabel(value) {
  const option = TODAY_VIEW_OPTIONS.find(([key]) => key === value);
  return option?.[2] || option?.[1] || "";
}

function resetTodayPositionFilter() {
  todayPositionFilter = "";
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 720px)").matches;
}

function setQuickNavOpen(open) {
  if (!quickNavToggle || !quickNavPanel) return;
  quickNavPanel.classList.toggle("open", Boolean(open));
  quickNavToggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (quickNavToggleState) quickNavToggleState.textContent = open ? "접기" : "열기";
}

function closeQuickNavOnMobile() {
  if (isMobileViewport()) setQuickNavOpen(false);
}

function applyUrlState() {
  const params = new URLSearchParams(window.location.search);
  const dateParam = params.get("date");
  dateInput.value = parseDateInputValue(dateParam) ? dateParam : kstDateString();

  rosterView = validRosterView(params.get("view"));
  todayView = validTodayView(params.get("today"));
  const gameId = params.get("gameId") || "";
  const hasTeam = params.has("team");
  const team = hasTeam ? params.get("team") || "" : "NC";

  selectedGameId = todayView ? "" : gameId;
  if (todayView) {
    teamSelect.value = "";
  } else if (selectedGameId) {
    teamSelect.value = "";
  } else {
    if (team) ensureTeamOption(team, team);
    teamSelect.value = team;
  }
}

function syncUrlState() {
  const params = new URLSearchParams();
  if (dateInput.value) params.set("date", dateInput.value);
  if (todayView) {
    params.set("today", todayView);
  } else if (selectedGameId) {
    params.set("gameId", selectedGameId);
  } else if (teamSelect.value) {
    params.set("team", teamSelect.value);
  }
  if (!todayView && rosterView !== "all") params.set("view", rosterView);

  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}`;
  if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
    window.history.replaceState(null, "", nextUrl);
  }
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
  if (gameStatusView) return "경기상황";
  if (todayView) return todayViewLabel();
  if (data?.view_mode === "team_overview") return "구단 전체 기록";
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
  if (!cache?.enabled) {
    cacheLine.textContent = cache?.message || fallback;
    return;
  }

  const stats = cache.stats || {};
  const pairs = [
    ["선수", cache.stored_player_records, stats.player_record_hits, stats.player_record_fetches],
    ["상대투수", cache.stored_vs_player_stats, stats.vs_player_stats_hits, stats.vs_player_stats_fetches],
    ["경기로그", cache.stored_player_game_logs, stats.player_game_log_hits, stats.player_game_log_fetches],
    ["상황", cache.stored_kbo_hitter_situation, stats.kbo_hitter_situation_hits, stats.kbo_hitter_situation_fetches],
    ["팀상대", cache.stored_team_opponent_records, stats.team_opponent_record_hits, stats.team_opponent_record_fetches],
  ];
  const updated = cache.updated_at ? ` · 캐시 ${kstTimeString(cache.updated_at)}` : "";
  cacheLine.innerHTML = `
    <span>${escapeHtml(cache.message || fallback || "성적 캐시 사용 중")}${escapeHtml(updated)}</span>
    <span class="cache-detail">
      ${pairs.map(([label, stored, hits, fetches]) => `
        <span class="cache-pill" title="${escapeHtml(label)} 저장 ${intish(stored)}건 · 재사용 ${intish(hits)}건 · 조회 ${intish(fetches)}건">
          ${escapeHtml(label)} ${escapeHtml(stored ?? 0)}
          <small>${escapeHtml(hits ?? 0)}/${escapeHtml(fetches ?? 0)}</small>
        </span>
      `).join("")}
    </span>
  `;
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

function displayPosition(position) {
  const text = String(position || "").trim();
  const compact = text.replace(/\s+/g, "");
  if (/^(포|捕|포수|C)$/i.test(compact)) return "포수";
  if (/^(一|1|1루|1루수|일루수|1B)$/i.test(compact)) return "1루수";
  if (/^(二|2|2루|2루수|이루수|2B)$/i.test(compact)) return "2루수";
  if (/^(三|3|3루|3루수|삼루수|3B)$/i.test(compact)) return "3루수";
  if (/^(유|遊|유격|유격수|SS)$/i.test(compact)) return "유격수";
  if (/^(좌|左|좌익|좌익수|LF)$/i.test(compact)) return "좌익수";
  if (/^(중|中|중견|중견수|CF)$/i.test(compact)) return "중견수";
  if (/^(우|右|우익|우익수|RF)$/i.test(compact)) return "우익수";
  if (/^(지|指|지명|지명타자|DH)$/i.test(compact)) return "지명타자";
  if (/^(대|대타|PH)$/i.test(compact)) return "대타";
  if (/^(주|대주자|PR)$/i.test(compact)) return "대주자";
  return text;
}

function playerMeta(player) {
  return [displayPosition(player?.position), player?.bats_throws].filter(Boolean).join(" · ");
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
    return `${summary.games || 0}G ERA ${decimal(summary.era)} ${formatInnings(summary.innings || "0")}IP WHIP ${decimal(summary.whip)} ${intish(summary.kk)}K`;
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
    return `${prefix}ERA ${decimal(stats.era)} ${formatInnings(stats.inn)}IP ${intish(stats.w)}-${intish(stats.l)} ${intish(stats.kk)}K WHIP ${decimal(stats.whip)}`;
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

function recentGames(player) {
  const games = player?.records?.recent_10_games?.games;
  return Array.isArray(games) ? games.filter((game) => game && typeof game === "object") : [];
}

function pitcherAppearanceGames(player) {
  const games = player?.appearance_game_log?.games;
  if (Array.isArray(games)) {
    return games.filter((game) => game && typeof game === "object");
  }
  return recentGames(player);
}

function gameNumber(game, keys) {
  return intish(statValue(game, keys));
}

function summarizeHitterGames(games, limit) {
  const selected = games.slice(0, limit);
  const totals = {
    games: selected.length,
    pa: selected.reduce((sum, game) => sum + gameNumber(game, ["pa"]), 0),
    ab: selected.reduce((sum, game) => sum + gameNumber(game, ["ab"]), 0),
    hit: selected.reduce((sum, game) => sum + gameNumber(game, ["hit", "h"]), 0),
    h2: selected.reduce((sum, game) => sum + gameNumber(game, ["h2", "double"]), 0),
    h3: selected.reduce((sum, game) => sum + gameNumber(game, ["h3", "triple"]), 0),
    hr: selected.reduce((sum, game) => sum + gameNumber(game, ["hr", "homeRun"]), 0),
    rbi: selected.reduce((sum, game) => sum + gameNumber(game, ["rbi"]), 0),
    bb: selected.reduce((sum, game) => sum + gameNumber(game, ["bb", "bbhp", "baseOnBalls"]), 0),
  };
  const totalBases = totals.hit + totals.h2 + (2 * totals.h3) + (3 * totals.hr);
  const obpDenominator = totals.pa || (totals.ab + totals.bb);
  const obp = obpDenominator ? (totals.hit + totals.bb) / obpDenominator : null;
  const slg = totals.ab ? totalBases / totals.ab : null;
  totals.avg = totals.ab ? totals.hit / totals.ab : null;
  totals.ops = obp !== null && slg !== null ? obp + slg : null;
  return totals;
}

function hitterRecentPeriodStats(player, limit) {
  const records = player?.records;
  if (!records || records.error || records.player_type === "pitcher") {
    return emptyHitterStats(false);
  }
  const summary = summarizeHitterGames(recentGames(player), limit);
  return {
    avg: avg(summary.avg),
    ab: count(summary.ab, 2),
    ops: rateFixed(summary.ops),
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

function formatInnings(value) {
  if (value === null || value === undefined || value === "" || value === "-") return "-";
  if (typeof value === "number") {
    const whole = Math.trunc(value);
    const decimal = Math.round((value - whole) * 10);
    if (decimal === 0) return `${whole}.0`;
    if (decimal === 1 || decimal === 2) return `${whole}.${decimal}`;
    return outsToInningsText(Math.round(value * 3));
  }

  const text = String(value).trim().replace("⅓", " 1/3").replace("⅔", " 2/3");
  if (!text) return "-";
  const spaced = text.match(/^(\d+)\s+([12])\/3$/);
  if (spaced) return `${Number(spaced[1])}.${Number(spaced[2])}`;
  const dotted = text.match(/^(\d+)(?:\.([012]))?$/);
  if (dotted) {
    const whole = Number(dotted[1]);
    const rest = Number(dotted[2] || 0);
    return rest ? `${whole}.${rest}` : `${whole}.0`;
  }
  return text;
}

function innings(value, width = 5) {
  return formatInnings(value).padStart(width, " ");
}

function inningsToOuts(value) {
  if (value === null || value === undefined || value === "" || value === "-") return 0;
  if (typeof value === "number") {
    const whole = Math.trunc(value);
    const decimal = Math.round((value - whole) * 10);
    if (decimal === 1 || decimal === 2) return (whole * 3) + decimal;
    return Math.round(value * 3);
  }
  const text = String(value).trim();
  const spaced = text.match(/^(\d+)\s+([12])\/3$/);
  if (spaced) return (Number(spaced[1]) * 3) + Number(spaced[2]);
  const frac = text.match(/^(\d+)(?:\.([12]))$/);
  if (frac) return (Number(frac[1]) * 3) + Number(frac[2]);
  const whole = Number(text);
  return Number.isFinite(whole) ? Math.round(whole * 3) : 0;
}

function outsToInningsText(outs) {
  const safeOuts = intish(outs);
  const whole = Math.trunc(safeOuts / 3);
  const rest = safeOuts % 3;
  return rest ? `${whole}.${rest}` : `${whole}.0`;
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

function summarizePitcherGames(games, limit) {
  const selected = games.slice(0, limit);
  const outs = selected.reduce((sum, game) => sum + inningsToOuts(statValue(game, ["inn", "inning", "innings"])), 0);
  const hit = selected.reduce((sum, game) => sum + gameNumber(game, ["hit", "h"]), 0);
  const bb = selected.reduce((sum, game) => sum + gameNumber(game, ["bb", "baseOnBalls"]), 0);
  const er = selected.reduce((sum, game) => sum + gameNumber(game, ["er"]), 0);
  const inningsValue = outs / 3;
  return {
    games: selected.length,
    innings: outsToInningsText(outs),
    outs,
    era: inningsValue ? (er * 9) / inningsValue : null,
    whip: inningsValue ? (hit + bb) / inningsValue : null,
    hit,
    hr: selected.reduce((sum, game) => sum + gameNumber(game, ["hr", "homeRun"]), 0),
    bb,
    kk: selected.reduce((sum, game) => sum + gameNumber(game, ["kk", "so", "k"]), 0),
    r: selected.reduce((sum, game) => sum + gameNumber(game, ["r", "run"]), 0),
    er,
  };
}

function pitcherRecentPeriodStats(player, limit) {
  const records = player?.records;
  if (!records || records.error || records.player_type !== "pitcher") {
    return emptyPitcherStats(false);
  }
  const summary = summarizePitcherGames(pitcherAppearanceGames(player), limit);
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
  const displayValue = field === "innings" ? formatInnings(value) : value;
  return `<td class="stat number-stat${className}">${escapeHtml(displayValue)}</td>`;
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
  const spaced = text.match(/^(\d+)\s+([12])\/3$/);
  if (spaced) return Number(spaced[1]) + (Number(spaced[2]) / 3);
  const dotted = text.match(/^(\d+)(?:\.([12]))?$/);
  if (dotted) return Number(dotted[1]) + (dotted[2] ? Number(dotted[2]) / 3 : 0);
  return sortNumber(value);
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

function todayHitterCompare(a, b, currentYear) {
  const aStats = rawSeasonStats(a.player, currentYear) || {};
  const bStats = rawSeasonStats(b.player, currentYear) || {};
  return (
    compareNumbers(sortNumber(aStats.avg ?? aStats.hra), sortNumber(bStats.avg ?? bStats.hra), "desc")
    || compareNumbers(sortNumber(aStats.ab), sortNumber(bStats.ab), "desc")
    || String(a.team?.team_name || "").localeCompare(String(b.team?.team_name || ""), "ko-KR")
    || compareNumbers(sortNumber(a.player?.bat_order), sortNumber(b.player?.bat_order), "asc")
    || playerNameCompare(a.player, b.player)
  );
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

function isCancelledGame(game) {
  const status = String(game?.status || "");
  const code = String(game?.status_code || "").toUpperCase();
  return Boolean(game?.canceled || status.includes("취소") || ["CANCEL", "CANCELED", "CANCELLED"].includes(code));
}

function isScoredGame(game) {
  if (isCancelledGame(game)) return false;
  return game?.scoreboard?.visible || ["STARTED", "RESULT", "2", "4"].includes(String(game?.status_code || "").toUpperCase());
}

function scoreChip(game) {
  if (isCancelledGame(game)) return "취소";
  if (!isScoredGame(game) || game.away_score === undefined || game.home_score === undefined) {
    return game.status || "-";
  }
  return `${game.away_score} : ${game.home_score}`;
}

function detailScoreboardFallback(game, detail = false) {
  if (!detail || isCancelledGame(game)) return null;
  return {
    visible: true,
    columns: [],
    teams: [
      {
        name: game?.away_team || "-",
        scores: [],
        r: game?.away_score,
      },
      {
        name: game?.home_team || "-",
        scores: [],
        r: game?.home_score,
      },
    ],
  };
}

function scoreboardColumns(board, detail = false) {
  const columns = Array.isArray(board?.columns) ? board.columns.map((column) => String(column)) : [];
  const scoreCount = Array.isArray(board?.teams)
    ? Math.max(0, ...board.teams.map((row) => Array.isArray(row?.scores) ? row.scores.length : 0))
    : 0;
  const minimumCount = detail ? 9 : columns.length;
  const columnCount = Math.max(minimumCount, columns.length, scoreCount);
  return Array.from({ length: columnCount }, (_, index) => columns[index] || String(index + 1));
}

function renderScoreboard(game, detail = false) {
  const sourceBoard = game?.scoreboard;
  const board = sourceBoard?.visible ? sourceBoard : detailScoreboardFallback(game, detail);
  if (!board?.visible || !Array.isArray(board.teams) || !board.teams.length) return "";
  const columns = scoreboardColumns(board, detail);
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
            <th>B</th>
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
              <td class="score-total">${escapeHtml(totalScore(row.b))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderGameTimeline(game) {
  const events = Array.isArray(game?.timeline) ? game.timeline : [];
  if (!events.length) return "";
  return `
    <div class="game-timeline">
      <div class="timeline-title">경기 흐름</div>
      <ol>
        ${events.map((event) => `
          <li class="timeline-item timeline-${escapeHtml(event.type || "note")}">
            <span class="timeline-inning">${escapeHtml(event.inning || "-")}</span>
            <span class="timeline-text">${escapeHtml(event.text || "-")}</span>
            ${event.score ? `<span class="timeline-score">${escapeHtml(event.score)}</span>` : ""}
          </li>
        `).join("")}
      </ol>
    </div>
  `;
}

function renderGameDetailSummary(game) {
  const summary = game?.live_summary || {};
  const scoreText = summary.score || `${game.away_team || "-"} ${totalScore(game.away_score)}-${totalScore(game.home_score)} ${game.home_team || "-"}`;
  const situationText = summary.situation || game.status || "-";
  const batterText = summary.batters || "-";
  const pitcherText = summary.pitcher || [
    game.away_current_pitcher_name ? `${game.away_team} ${game.away_current_pitcher_name}` : "",
    game.home_current_pitcher_name ? `${game.home_team} ${game.home_current_pitcher_name}` : "",
  ].filter(Boolean).join(" / ") || "-";
  return `
    <div class="game-detail-summary">
      <div>
        <span>점수</span>
        <strong>${escapeHtml(scoreText)}</strong>
      </div>
      <div>
        <span>상황</span>
        <strong>${escapeHtml(situationText)}</strong>
      </div>
      <div>
        <span>타자</span>
        <strong>${escapeHtml(batterText)}</strong>
      </div>
      <div>
        <span>투수</span>
        <strong>${escapeHtml(pitcherText)}</strong>
      </div>
    </div>
  `;
}

function renderGameCard(game, data, detail = false) {
  const cardClass = detail ? "game-card game-card-detail" : "game-card";
  const matchupTitle = `${game.away_team || "-"} @ ${game.home_team || "-"}${detail && game.stadium ? ` ${game.stadium}` : ""}`;
  return `
    <article class="${cardClass}">
      <div class="game-card-head">
        <div>
          <strong>${escapeHtml(matchupTitle)}</strong>
        </div>
        <div class="game-meta">
          <span class="chip">${escapeHtml(game.time || "-")}</span>
          ${detail ? "" : `<span class="chip">${escapeHtml(game.stadium || "-")}</span>`}
          <span class="chip">${escapeHtml(scoreChip(game))}</span>
          <span class="chip">${escapeHtml(data.target_date)} KST</span>
        </div>
      </div>
      ${detail ? renderGameDetailSummary(game) : ""}
      ${renderScoreboard(game, detail)}
      ${detail ? "" : renderGameTimeline(game)}
    </article>
  `;
}

function renderGameStrip(data) {
  const games = Array.isArray(data.games) ? data.games : [];
  if (!games.length) {
    gameStrip.hidden = true;
    gameStrip.innerHTML = "";
    return;
  }
  gameStrip.hidden = false;
  const detail = gameStatusView || Boolean(data.selected_game);
  gameStrip.classList.toggle("game-strip-detail", detail);
  gameStrip.innerHTML = games.map((game) => renderGameCard(game, data, detail)).join("");
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

function hasGameScore(game) {
  return game?.away_score !== undefined
    && game?.away_score !== null
    && game?.home_score !== undefined
    && game?.home_score !== null;
}

function gameScoreText(game) {
  return hasGameScore(game) ? `${game.away_score} : ${game.home_score}` : "";
}

function quickGameMeta(game) {
  if (isCancelledGame(game)) {
    return [game.time, "취소"].filter(Boolean).join(" · ") || "취소";
  }

  const status = game.status || "";
  if (isScoredGame(game) && hasGameScore(game)) {
    return [status, gameScoreText(game)].filter(Boolean).join(" · ");
  }

  return [game.time, status].filter(Boolean).join(" · ") || "경기";
}

function renderGameQuickNav(games = quickGames) {
  const allGames = Array.isArray(games) ? games : [];
  const visibleGames = allGames.slice(0, 5);
  if (!allGames.length) {
    gameQuickNav.hidden = true;
    gameQuickNav.innerHTML = "";
    return;
  }

  gameQuickNav.hidden = false;
  const allButton = `
    <button
      class="game-jump game-jump-all${!todayView && !selectedGameId && teamSelect.value === "" ? " active" : ""}"
      type="button"
      data-game-team=""
      data-game-team-label="전체"
      data-game-id=""
      title="전체 경기"
    >
      <span>전체</span>
      <small>${escapeHtml(allGames.length)}경기</small>
    </button>
  `;
  const todayButtons = TODAY_VIEW_OPTIONS.map(([value, label]) => `
    <button
      class="game-jump today-jump${todayView === value ? " active" : ""}"
      type="button"
      data-today-view="${escapeHtml(value)}"
      title="${escapeHtml(label)}"
    >
      <span>${escapeHtml(todayViewButtonLabel(value))}</span>
      <small>라인업별</small>
    </button>
  `).join("");
  const gameButtons = visibleGames.map((game) => {
    const teamValue = gameJumpTeam(game);
    const label = `${game.away_team || "-"} @ ${game.home_team || "-"}`;
    const meta = quickGameMeta(game);
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
  gameQuickNav.innerHTML = `${todayButtons}${gameButtons}${allButton}`;
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

function opponentTeamFor(team, data) {
  const teams = Array.isArray(data?.teams) ? data.teams : [];
  return teams.find((candidate) => (
    candidate
    && candidate.game_id === team?.game_id
    && candidate.team_code !== team?.team_code
  )) || null;
}

function matchupPitcherForTeam(team, batters, data) {
  if (team?.matchup_pitcher?.name) return team.matchup_pitcher;
  const opponentTeam = opponentTeamFor(team, data);
  if (opponentTeam?.current_pitcher?.name) return opponentTeam.current_pitcher;
  const opponentRelievers = Array.isArray(opponentTeam?.relief_pitchers) ? opponentTeam.relief_pitchers : [];
  if (opponentRelievers.length) return { ...opponentRelievers[opponentRelievers.length - 1], role: "current" };
  const matchup = batters.find((batter) => batter.vs_starting_pitcher)?.vs_starting_pitcher;
  const pitcher = matchup?.opposing_pitcher;
  return pitcher?.name ? { ...pitcher, role: "starter" } : { name: "상대선발", role: "starter" };
}

function pitcherTodayLine(player) {
  const today = player?.today;
  if (!today) return "";
  return `오늘 ${formatInnings(today.inn)}IP ${intish(today.hit)}H ${intish(today.run)}R ${intish(today.er)}ER ${intish(today.kk)}K`;
}

function samePitcher(left, right) {
  if (!left || !right) return false;
  const leftCode = String(left.player_code || "");
  const rightCode = String(right.player_code || "");
  if (leftCode && rightCode) return leftCode === rightCode;
  return normalizeKey(left.name) && normalizeKey(left.name) === normalizeKey(right.name);
}

function pitcherSummaryCell(displayPitcher, starterPitcher) {
  const isRelief = (displayPitcher?.role === "current" || displayPitcher?.role === "relief")
    && !samePitcher(displayPitcher, starterPitcher);
  if (isRelief) {
    const recent = recentCell(displayPitcher);
    if (recent !== "-") return recent;
    return pitcherTodayLine(displayPitcher) || "교체 등판";
  }
  const today = pitcherTodayLine(displayPitcher);
  if (today) return today;
  return recentCell(starterPitcher || displayPitcher);
}

function pitcherContextCell(displayPitcher, starterPitcher) {
  const isRelief = (displayPitcher?.role === "current" || displayPitcher?.role === "relief")
    && !samePitcher(displayPitcher, starterPitcher);
  if (isRelief) return vsTeamCell(displayPitcher, true);
  if (displayPitcher?.role === "current") {
    return samePitcher(displayPitcher, starterPitcher) ? vsTeamCell(starterPitcher, true) : vsTeamCell(displayPitcher, true);
  }
  return vsTeamCell(starterPitcher || displayPitcher, true);
}

function renderPitcherLine(displayPitcher, label, starterPitcher, isCurrent = false) {
  const linePitcher = isCurrent ? { ...displayPitcher, role: "current" } : displayPitcher;
  return `
    <div class="pitcher-line${isCurrent ? " current" : ""}">
      <div>
        <div class="subtle">${escapeHtml(label)}</div>
        <div class="pitcher-name">
          ${escapeHtml(linePitcher?.name || "정보 없음")}
          ${isCurrent ? `<span class="chip live-chip">현재</span>` : ""}
        </div>
      </div>
      <div class="stat">${escapeHtml(pitcherSummaryCell(linePitcher, starterPitcher))}</div>
      <div class="stat">${escapeHtml(pitcherContextCell(linePitcher, starterPitcher))}</div>
    </div>
  `;
}

function renderLeagueHitterLeaders(players, seasonYear) {
  return `
    <section class="leader-panel">
      <div class="table-title">타자 시즌 상위 30 · AVG 순</div>
      <div class="table-scroll">
        <table class="leader-table leader-hitter-table">
          <thead>
            <tr>
              <th class="num">순</th>
              <th>선수</th>
              <th>팀</th>
              <th class="stat-focus">AVG</th>
              <th>AB</th>
              <th>OPS</th>
              <th>HR</th>
              <th>RBI</th>
              <th>WAR</th>
            </tr>
          </thead>
          <tbody>
            ${players.map((player, index) => {
              const stats = seasonHitterStats(player, seasonYear);
              return `
                <tr>
                  <td class="num">${escapeHtml(index + 1)}</td>
                  <td class="player">${playerName(player)}</td>
                  <td>${escapeHtml(player.team_name || player.team_code || "-")}</td>
                  ${hitterStatCells(stats, ["avg", "ab", "ops", "hr", "rbi", "war"])}
                </tr>
              `;
            }).join("") || `<tr><td colspan="9" class="empty-state">타자 상위권 정보 없음</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderLeaguePitcherLeaders(players, seasonYear) {
  return `
    <section class="leader-panel">
      <div class="table-title">투수 시즌 상위 30 · ERA 순</div>
      <div class="table-scroll">
        <table class="leader-table leader-pitcher-table">
          <thead>
            <tr>
              <th class="num">순</th>
              <th>선수</th>
              <th>팀</th>
              <th>G</th>
              <th class="stat-focus">ERA</th>
              <th>IP</th>
              <th>WHIP</th>
              <th>HR</th>
              <th>BB</th>
              <th>W</th>
              <th>L</th>
              <th>SV</th>
              <th>HLD</th>
              <th>K</th>
            </tr>
          </thead>
          <tbody>
            ${players.map((player, index) => {
              const stats = pitcherSeasonStats(player, seasonYear);
              return `
                <tr>
                  <td class="num">${escapeHtml(index + 1)}</td>
                  <td class="player">${playerName(player)}</td>
                  <td>${escapeHtml(player.team_name || player.team_code || "-")}</td>
                  ${pitcherStatCells(stats, ["games", "era", "innings", "whip", "hr", "bb", "win", "lose", "save", "hold", "kk"])}
                </tr>
              `;
            }).join("") || `<tr><td colspan="14" class="empty-state">투수 상위권 정보 없음</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderLeaguePlayerLeaders(data) {
  const leaders = data.league_player_leaders || {};
  const hitters = Array.isArray(leaders.hitters) ? leaders.hitters : [];
  const pitchers = Array.isArray(leaders.pitchers) ? leaders.pitchers : [];
  const seasonYear = Number(data.season_year || String(data.target_date || "").slice(0, 4));
  if (!hitters.length && !pitchers.length) return "";
  return `
    <div class="leader-grid">
      ${renderLeagueHitterLeaders(hitters, seasonYear)}
      ${renderLeaguePitcherLeaders(pitchers, seasonYear)}
    </div>
  `;
}

function categoryLeaderValue(player, key, group, seasonYear) {
  const stats = rawSeasonStats(player, seasonYear) || {};
  if (group === "hitters") {
    if (key === "avg") return rate(stats.avg ?? stats.hra);
    if (key === "ops") return rateFixed(stats.ops);
    if (key === "hr") return count(stats.hr, 2);
    if (key === "rbi") return count(stats.rbi, 3);
    if (key === "sb") return count(stats.sb, 2);
    if (key === "war") return war(stats.war);
  }
  if (key === "win") return count(stats.win ?? stats.w, 2);
  if (key === "era") return decimal(stats.era);
  if (key === "kk") return count(stats.kk ?? stats.k, 3);
  if (key === "save") return count(stats.save ?? stats.sv, 2);
  if (key === "hold") return count(stats.hold, 2);
  if (key === "whip") return decimal(stats.whip);
  return "-";
}

function renderCategoryLeaderPanel(category, group, seasonYear) {
  const players = Array.isArray(category.players) ? category.players : [];
  return `
    <section class="category-panel">
      <div class="category-title">${escapeHtml(category.label || "-")}</div>
      <table class="category-leader-table">
        <tbody>
          ${players.map((player, index) => `
            <tr>
              <td class="num">${escapeHtml(index + 1)}</td>
              <td class="player">${playerName(player)}</td>
              <td class="team-name">${escapeHtml(player.team_name || player.team_code || "-")}</td>
              <td class="stat number-stat">${escapeHtml(categoryLeaderValue(player, category.key, group, seasonYear))}</td>
            </tr>
          `).join("") || `<tr><td colspan="4" class="empty-state">정보 없음</td></tr>`}
        </tbody>
      </table>
    </section>
  `;
}

function renderCategoryLeaderGroup(title, categories, group, seasonYear) {
  if (!Array.isArray(categories) || !categories.length) return "";
  return `
    <section class="category-section">
      <div class="table-title">${escapeHtml(title)}</div>
      <div class="category-grid">
        ${categories.map((category) => renderCategoryLeaderPanel(category, group, seasonYear)).join("")}
      </div>
    </section>
  `;
}

function renderLeagueCategoryLeaders(data) {
  const leaders = data.league_category_leaders || {};
  const hitters = Array.isArray(leaders.hitters) ? leaders.hitters : [];
  const pitchers = Array.isArray(leaders.pitchers) ? leaders.pitchers : [];
  const seasonYear = Number(data.season_year || String(data.target_date || "").slice(0, 4));
  if (!hitters.length && !pitchers.length) return "";
  return `
    <div class="category-leaders">
      ${renderCategoryLeaderGroup("타자 주요 순위 · 전체 5위", hitters, "hitters", seasonYear)}
      ${renderCategoryLeaderGroup("투수 주요 순위 · 전체 5위", pitchers, "pitchers", seasonYear)}
    </div>
  `;
}

function renderTeamOverviewStats(rows) {
  return `
    <div class="table-title">구단별 현재 기록</div>
    <div class="table-scroll">
      <table class="team-overview-table">
        <thead>
          <tr>
            <th>순위</th>
            <th>팀</th>
            <th>승</th>
            <th>무</th>
            <th>패</th>
            <th>승률</th>
            <th>GB</th>
            <th class="stat-focus">AVG</th>
            <th>OPS</th>
            <th>HR</th>
            <th>SB</th>
            <th>득점</th>
            <th class="stat-focus">ERA</th>
            <th>WHIP</th>
            <th>QS</th>
            <th>HLD</th>
            <th>SV</th>
            <th>E</th>
            <th>최근5</th>
            <th>연속</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((stats) => `
            <tr>
              <td class="num">${escapeHtml(stats.ranking ?? "-")}</td>
              <td><strong>${escapeHtml(stats.teamName || stats.teamShortName || "-")}</strong></td>
              ${statCell(count(stats.winGameCount, 2), "win")}
              ${statCell(count(stats.drawnGameCount, 1), "draw")}
              ${statCell(count(stats.loseGameCount, 2), "lose")}
              ${statCell(rate(stats.wra), "winrate")}
              ${statCell(stats.gameBehind ?? "-", "gb")}
              ${statCell(rate(stats.offenseHra), "avg")}
              ${statCell(rateFixed(stats.offenseOps), "ops")}
              ${statCell(count(stats.offenseHr, 2), "hr")}
              ${statCell(count(stats.offenseSb, 2), "sb")}
              ${statCell(count(stats.offenseRun, 3), "run")}
              ${statCell(decimal(stats.defenseEra), "era")}
              ${statCell(decimal(stats.defenseWhip), "whip")}
              ${statCell(count(stats.defenseQs, 2), "qs")}
              ${statCell(count(stats.defenseHold, 2), "hold")}
              ${statCell(count(stats.defenseSave, 2), "save")}
              ${statCell(count(stats.defenseErr, 2), "err")}
              <td class="stat">${escapeHtml(stats.lastFiveGames || "-")}</td>
              <td>${escapeHtml(stats.continuousGameResult || "-")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderTeamStats(data) {
  const rows = data.league_team_stats?.teams || [];
  const overviewMode = data.view_mode === "team_overview";
  if (todayView || !rows.length || (!overviewMode && (data.selected_team || data.selected_game))) {
    teamStats.hidden = true;
    teamStats.innerHTML = "";
    return;
  }
  teamStats.hidden = false;
  teamStats.innerHTML = `
    ${renderTeamOverviewStats(rows)}
    ${overviewMode ? renderLeagueCategoryLeaders(data) : ""}
    ${overviewMode ? renderLeaguePlayerLeaders(data) : ""}
  `;
}

function isOutfielder(player) {
  const position = displayPosition(player?.position);
  return /좌익수|중견수|우익수|외야수|LF|CF|RF/i.test(position);
}

function isTodayHitterMatch(player, view) {
  if (!player?.name) return false;
  if (["fielders", "infielders", "outfielders"].includes(view)) return true;
  return false;
}

function positionLabel(player, view) {
  const position = displayPosition(player?.position);
  if (view === "pitchers") return "선발투수";
  if (/외야수/i.test(position)) return "외야수";
  return position || "야수 기타";
}

function positionSortOrder(label, view) {
  const order = view === "pitchers"
    ? ["선발투수"]
    : ["포수", "1루수", "2루수", "3루수", "유격수", "좌익수", "중견수", "우익수", "외야수", "지명타자", "대타", "대주자", "야수 기타"];
  const index = order.indexOf(label);
  return index === -1 ? order.length : index;
}

function gameForTeam(team, data) {
  return (data.games || []).find((game) => String(game?.game_id || "") === String(team?.game_id || "")) || null;
}

function todayGameLabel(team, data) {
  const game = gameForTeam(team, data);
  if (!game) return team?.opponent?.team_name ? `${team.team_name} vs ${team.opponent.team_name}` : "-";
  return `${game.away_team || "-"} @ ${game.home_team || "-"}`;
}

function todayHitterRows(data, view) {
  const rows = [];
  (data.teams || []).forEach((team) => {
    const batters = Array.isArray(team.batting_order) ? team.batting_order : [];
    batters.forEach((batter) => {
      lineupEntries(batter).forEach((entry) => {
        if (!isTodayHitterMatch(entry, view)) return;
        rows.push({
          team,
          player: entry,
          gameLabel: todayGameLabel(team, data),
        });
      });
    });
  });
  return rows;
}

function todayPitcherRows(data) {
  return (data.teams || [])
    .map((team) => ({
      team,
      player: team.starting_pitcher || {},
      gameLabel: todayGameLabel(team, data),
    }))
    .filter((row) => row.player?.name);
}

function groupTodayRows(rows, view, currentYear) {
  const groups = new Map();
  rows.forEach((row) => {
    const label = positionLabel(row.player, view);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  });
  return Array.from(groups.entries())
    .map(([label, groupRows]) => ({
      label,
      rows: view === "pitchers" ? groupRows : [...groupRows].sort((a, b) => todayHitterCompare(a, b, currentYear)),
    }))
    .sort((a, b) => (
      positionSortOrder(a.label, view) - positionSortOrder(b.label, view)
      || a.label.localeCompare(b.label, "ko-KR")
    ));
}

function todaySeasonYear(data) {
  return Number(data.season_year || String(data.target_date || "").slice(0, 4));
}

function renderTodayPositionFilter(groups) {
  if (todayView === "pitchers" || !groups.length) return "";
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const buttons = [
    { label: "전체", value: "", count: total },
    ...groups.map((group) => ({ label: group.label, value: group.label, count: group.rows.length })),
  ];
  return `
    <div class="today-position-filter" aria-label="포지션별 보기">
      ${buttons.map((button) => `
        <button
          class="position-filter-button${todayPositionFilter === button.value ? " active" : ""}"
          type="button"
          data-today-position="${escapeHtml(button.value)}"
        >
          <span>${escapeHtml(button.label)}</span>
          <small>${escapeHtml(button.count)}</small>
        </button>
      `).join("")}
    </div>
  `;
}

function dateShort(value) {
  const text = String(value || "");
  const compact = text.replaceAll("-", "");
  if (/^\d{8}$/.test(compact)) return `${compact.slice(4, 6)}.${compact.slice(6, 8)}`;
  return text || "-";
}

function pitcherPreviousGame(player) {
  const game = pitcherAppearanceGames(player)[0];
  if (!game) {
    return { date: "-", opponent: "-", result: "-", innings: "-", hit: "-", run: "-", er: "-", kk: "-" };
  }
  return {
    date: dateShort(statValue(game, ["gday", "gameDate", "date"])),
    opponent: statValue(game, ["opponent", "vsTeam", "teamName"]) || "-",
    result: statValue(game, ["wls", "result"]) || "-",
    innings: innings(statValue(game, ["inn", "inning", "innings"])),
    hit: count(statValue(game, ["hit", "h"]), 2),
    run: count(statValue(game, ["r", "run"]), 2),
    er: count(statValue(game, ["er"]), 2),
    kk: count(statValue(game, ["kk", "so", "k"]), 3),
  };
}

function renderTodayHitterRow(row, index, currentYear) {
  const player = row.player;
  const recent5 = hitterRecentPeriodStats(player, 5);
  const recent10 = hitterRecentPeriodStats(player, 10);
  const season = seasonHitterStats(player, currentYear);
  return `
    <tr${rowClass(player)}>
      <td class="num">${escapeHtml(index + 1)}</td>
      <td class="player">${playerName(player)}</td>
      <td>${escapeHtml(row.team?.team_name || "-")}</td>
      <td>${escapeHtml(row.gameLabel)}</td>
      <td class="stat number-stat">${escapeHtml(player.bat_order || "-")}</td>
      ${hitterStatCells(recent5, ["avg", "ab", "ops", "hr", "rbi"])}
      ${hitterStatCells(recent10, ["avg", "ab", "ops", "hr", "rbi"])}
      ${hitterStatCells(season, ["avg", "ab", "ops", "hr", "rbi", "war"])}
    </tr>
  `;
}

function renderTodayPitcherRow(row, index, currentYear) {
  const player = row.player;
  const previous = pitcherPreviousGame(player);
  const recent5 = pitcherRecentPeriodStats(player, 5);
  const season = pitcherSeasonStats(player, currentYear);
  return `
    <tr>
      <td class="num">${escapeHtml(index + 1)}</td>
      <td class="player">${playerName(player)}</td>
      <td>${escapeHtml(row.team?.team_name || "-")}</td>
      <td>${escapeHtml(row.gameLabel)}</td>
      <td>${escapeHtml(player.bats_throws || "-")}</td>
      <td class="stat prev-date">${escapeHtml(previous.date)}</td>
      <td class="prev-opponent">${escapeHtml(previous.opponent)}</td>
      <td class="stat prev-result">${escapeHtml(previous.result)}</td>
      ${pitcherStatCells(previous, ["innings", "hit", "run", "er", "kk"])}
      ${pitcherStatCells(recent5, ["games", "era", "innings", "whip", "hr", "bb", "kk"])}
      ${pitcherStatCells(season, ["games", "era", "innings", "whip", "hr", "bb", "win", "lose", "save", "hold", "kk"])}
    </tr>
  `;
}

function renderTodayHitterTable(rows, currentYear) {
  return `
    <div class="table-scroll">
      <table class="lineup-table today-lineup-table today-hitter-table">
        <colgroup>
          <col class="col-num">
          <col class="col-player">
          <col class="col-team">
          <col class="col-game">
          <col class="col-order">
          <col class="col-avg">
          <col class="col-ab">
          <col class="col-ops">
          <col class="col-count">
          <col class="col-rbi">
          <col class="col-avg">
          <col class="col-ab">
          <col class="col-ops">
          <col class="col-count col-recent10-hr">
          <col class="col-rbi col-recent10-rbi">
          <col class="col-avg">
          <col class="col-ab">
          <col class="col-ops">
          <col class="col-count">
          <col class="col-rbi">
          <col class="col-war">
        </colgroup>
        <thead>
          <tr>
            <th class="num" rowspan="2">순</th>
            <th rowspan="2">선수</th>
            <th rowspan="2">팀</th>
            <th rowspan="2">경기</th>
            <th rowspan="2">타순</th>
            <th class="group-head" colspan="5">최근5G</th>
            <th class="group-head" colspan="5">최근10G</th>
            <th class="group-head" colspan="6">${escapeHtml(currentYear)}년 성적</th>
          </tr>
          <tr class="sub-head">
            <th class="stat-focus">AVG</th>
            <th>AB</th>
            <th>OPS</th>
            <th>HR</th>
            <th>RBI</th>
            <th class="stat-focus">AVG</th>
            <th>AB</th>
            <th>OPS</th>
            <th>HR</th>
            <th>RBI</th>
            <th class="stat-focus">AVG</th>
            <th>AB</th>
            <th>OPS</th>
            <th>HR</th>
            <th>RBI</th>
            <th>WAR</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, index) => renderTodayHitterRow(row, index, currentYear)).join("") || `<tr><td colspan="21" class="empty-state">표시할 야수 정보가 없습니다.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function renderTodayPitcherTable(rows, currentYear) {
  return `
    <div class="table-scroll">
      <table class="lineup-table today-lineup-table today-pitcher-table">
        <colgroup>
          <col class="col-num">
          <col class="col-player">
          <col class="col-team">
          <col class="col-game">
          <col class="col-throws">
          <col class="col-prev-date">
          <col class="col-prev-opponent">
          <col class="col-prev-result">
          <col class="col-innings">
          <col class="col-count">
          <col class="col-count">
          <col class="col-count">
          <col class="col-kk">
          <col class="col-count">
          <col class="col-era">
          <col class="col-innings">
          <col class="col-whip">
          <col class="col-count">
          <col class="col-count">
          <col class="col-kk">
          <col class="col-count">
          <col class="col-era">
          <col class="col-innings">
          <col class="col-whip">
          <col class="col-count">
          <col class="col-count">
          <col class="col-count">
          <col class="col-count">
          <col class="col-count">
          <col class="col-count">
          <col class="col-kk">
        </colgroup>
        <thead>
          <tr>
            <th class="num" rowspan="2">순</th>
            <th rowspan="2">선수</th>
            <th rowspan="2">팀</th>
            <th rowspan="2">경기</th>
            <th rowspan="2">투구</th>
            <th class="group-head" colspan="8">직전경기</th>
            <th class="group-head" colspan="7">최근5경기출전</th>
            <th class="group-head" colspan="11">${escapeHtml(currentYear)}년 성적</th>
          </tr>
          <tr class="sub-head">
            <th class="prev-date">일자</th>
            <th class="prev-opponent">상대</th>
            <th class="prev-result">결과</th>
            <th class="stat-innings">IP</th>
            <th class="stat-hit">H</th>
            <th class="stat-run">R</th>
            <th class="stat-er">ER</th>
            <th class="stat-kk">K</th>
            <th class="stat-games">G</th>
            <th class="stat-focus stat-era">ERA</th>
            <th class="stat-innings">IP</th>
            <th class="stat-whip">WHIP</th>
            <th class="stat-hr">HR</th>
            <th class="stat-bb">BB</th>
            <th class="stat-kk">K</th>
            <th class="stat-games">G</th>
            <th class="stat-focus stat-era">ERA</th>
            <th class="stat-innings">IP</th>
            <th class="stat-whip">WHIP</th>
            <th class="stat-hr">HR</th>
            <th class="stat-bb">BB</th>
            <th class="stat-win">W</th>
            <th class="stat-lose">L</th>
            <th class="stat-save">SV</th>
            <th class="stat-hold">HLD</th>
            <th class="stat-kk">K</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, index) => renderTodayPitcherRow(row, index, currentYear)).join("") || `<tr><td colspan="31" class="empty-state">표시할 선발 투수 정보가 없습니다.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function renderTodayPositionSections(groups, currentYear) {
  if (!groups.length) {
    return `<div class="empty-state">표시할 선수 정보가 없습니다.</div>`;
  }
  const visibleGroups = todayPositionFilter && todayView !== "pitchers"
    ? groups.filter((group) => group.label === todayPositionFilter)
    : groups;
  if (!visibleGroups.length) {
    return `<div class="empty-state">선택한 포지션의 선수 정보가 없습니다.</div>`;
  }
  return visibleGroups.map((group) => `
    <section class="today-position-section">
      <div class="table-title">
        <span>${escapeHtml(group.label)}</span>
        <small>${escapeHtml(group.rows.length)}명</small>
      </div>
      ${todayView === "pitchers"
        ? renderTodayPitcherTable(group.rows, currentYear)
        : renderTodayHitterTable(group.rows, currentYear)}
    </section>
  `).join("");
}

function renderTodayLineupView(data) {
  const title = todayViewLabel();
  const rows = todayView === "pitchers" ? todayPitcherRows(data) : todayHitterRows(data, todayView);
  const currentYear = todaySeasonYear(data);
  const groups = groupTodayRows(rows, todayView, currentYear);
  if (todayPositionFilter && !groups.some((group) => group.label === todayPositionFilter)) {
    resetTodayPositionFilter();
  }
  const teamCount = new Set(rows.map((row) => row.team?.team_code || row.team?.team_name).filter(Boolean)).size;
  return `
    <article class="team-panel today-panel selected">
      <div class="team-head">
        <div>
          <div class="team-title">
            <h2>${escapeHtml(title)}</h2>
            <span class="chip">${escapeHtml(data.target_date)} 라인업</span>
          </div>
          <div class="status">오늘 라인업 기준으로 포지션별 선수를 모아 표시합니다.</div>
        </div>
        <div class="record-line">
          <span class="chip">${escapeHtml(teamCount)}팀</span>
          <span class="chip">${escapeHtml(rows.length)}명</span>
        </div>
      </div>
      <section class="team-section">
        <div class="table-title">${escapeHtml(title)} · 포지션별 · ${todayView === "pitchers" ? "직전경기 / 최근5경기출전 / 올해성적" : "최근5G / 최근10G / 올해성적"}</div>
        ${renderTodayPositionFilter(groups)}
        ${renderTodayPositionSections(groups, currentYear)}
      </section>
    </article>
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
      ${pitcherStatCells(recent, ["games", "era", "innings", "whip", "hr", "bb", "kk"])}
      ${yearColumns.map((year) => {
        const season = pitcherSeasonStats(player, year);
        return pitcherStatCells(season, ["games", "era", "innings", "whip", "hr", "bb", "win", "lose", "save", "hold", "kk"]);
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

function signedCount(value) {
  const parsed = intish(value);
  if (parsed > 0) return `+${parsed}`;
  return String(parsed);
}

function renderRosterTeamContext(team) {
  const stats = team.team_season || {};
  const opponents = Array.isArray(team.opponent_records) ? team.opponent_records : [];
  return `
    <section class="team-section roster-context-section">
      <div class="roster-context-grid">
        <div class="context-table-card">
          <div class="table-title">현재 구단 기록</div>
          <div class="table-scroll">
            <table class="lineup-table team-context-table">
              <thead>
                <tr>
                  <th>순위</th>
                  <th>G</th>
                  <th>W</th>
                  <th>D</th>
                  <th>L</th>
                  <th>승률</th>
                  <th>GB</th>
                  <th class="stat-focus">AVG</th>
                  <th>OPS</th>
                  <th>HR</th>
                  <th>SB</th>
                  <th>득점</th>
                  <th class="stat-focus">ERA</th>
                  <th>WHIP</th>
                  <th>실점</th>
                  <th>E</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  ${statCell(stats.ranking ?? "-", "rank")}
                  ${statCell(count(stats.gameCount, 2), "games")}
                  ${statCell(count(stats.winGameCount, 2), "win")}
                  ${statCell(count(stats.drawnGameCount, 1), "draw")}
                  ${statCell(count(stats.loseGameCount, 2), "lose")}
                  ${statCell(rate(stats.wra), "winrate")}
                  ${statCell(stats.gameBehind ?? "-", "gb")}
                  ${statCell(rate(stats.offenseHra), "avg")}
                  ${statCell(rateFixed(stats.offenseOps), "ops")}
                  ${statCell(count(stats.offenseHr, 2), "hr")}
                  ${statCell(count(stats.offenseSb, 2), "sb")}
                  ${statCell(count(stats.offenseRun, 3), "run")}
                  ${statCell(decimal(stats.defenseEra), "era")}
                  ${statCell(decimal(stats.defenseWhip), "whip")}
                  ${statCell(count(stats.defenseR, 3), "run")}
                  ${statCell(count(stats.defenseErr, 2), "err")}
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="context-table-card">
          <div class="table-title">상대팀별 성적</div>
          <div class="table-scroll">
            <table class="lineup-table team-context-table opponent-record-table">
              <thead>
                <tr>
                  <th rowspan="2">상대</th>
                  <th class="group-head" colspan="10">전적</th>
                  <th class="group-head" colspan="9">타격</th>
                  <th class="group-head" colspan="9">투수</th>
                </tr>
                <tr class="sub-head">
                  <th>G</th>
                  <th>W</th>
                  <th>D</th>
                  <th>L</th>
                  <th>승률</th>
                  <th>득점</th>
                  <th>실점</th>
                  <th>득실</th>
                  <th>홈</th>
                  <th>원정</th>
                  <th class="stat-focus">AVG</th>
                  <th>AB</th>
                  <th>H</th>
                  <th>R</th>
                  <th>HR</th>
                  <th>RBI</th>
                  <th>BB</th>
                  <th>K</th>
                  <th>SB</th>
                  <th class="stat-focus">ERA</th>
                  <th>IP</th>
                  <th>WHIP</th>
                  <th>H</th>
                  <th>HR</th>
                  <th>BB</th>
                  <th>K</th>
                  <th>R</th>
                  <th>ER</th>
                </tr>
              </thead>
              <tbody>
                ${opponents.map((record) => {
                  const batting = record.batting || {};
                  const pitching = record.pitching || {};
                  return `
                  <tr>
                    <td><strong>${escapeHtml(record.opponent_name || record.opponent_code || "-")}</strong></td>
                    ${statCell(count(record.games, 2), "games")}
                    ${statCell(count(record.wins, 2), "win")}
                    ${statCell(count(record.draws, 1), "draw")}
                    ${statCell(count(record.losses, 2), "lose")}
                    ${statCell(rate(record.win_rate), "winrate")}
                    ${statCell(count(record.runs_for, 3), "run")}
                    ${statCell(count(record.runs_against, 3), "run")}
                    ${statCell(signedCount(record.run_diff), "diff")}
                    ${statCell(count(record.home_games, 2), "home")}
                    ${statCell(count(record.away_games, 2), "away")}
                    ${statCell(rate(batting.avg), "avg")}
                    ${statCell(count(batting.ab, 3), "ab")}
                    ${statCell(count(batting.hit, 3), "hit")}
                    ${statCell(count(batting.run, 3), "run")}
                    ${statCell(count(batting.hr, 2), "hr")}
                    ${statCell(count(batting.rbi, 3), "rbi")}
                    ${statCell(count(batting.bb, 3), "bb")}
                    ${statCell(count(batting.kk, 3), "kk")}
                    ${statCell(count(batting.sb, 2), "sb")}
                    ${statCell(decimal(pitching.era), "era")}
                    ${statCell(pitching.innings || "-", "innings")}
                    ${statCell(decimal(pitching.whip), "whip")}
                    ${statCell(count(pitching.hit, 3), "hit")}
                    ${statCell(count(pitching.hr, 2), "hr")}
                    ${statCell(count(pitching.bb, 3), "bb")}
                    ${statCell(count(pitching.kk, 3), "kk")}
                    ${statCell(count(pitching.run, 3), "run")}
                    ${statCell(count(pitching.er, 3), "er")}
                  </tr>
                `;
                }).join("") || `<tr><td colspan="29" class="empty-state">상대팀별 성적 없음</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
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

      ${renderRosterTeamContext(team)}

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
                <th class="stat-focus">ERA</th>
                <th>IP</th>
                <th>WHIP</th>
                <th>HR</th>
                <th>BB</th>
                <th>K</th>
                ${yearColumns.map(() => `
                  <th>G</th>
                  <th class="stat-focus">ERA</th>
                  <th>IP</th>
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
  const matchupPitcher = matchupPitcherForTeam(team, batters, data);
  const matchupPitcherLabel = matchupPitcher.role === "current" ? "상대 현재 투수" : "상대 선발";
  const currentPitcher = team.current_pitcher?.name ? team.current_pitcher : null;
  const reliefPitchers = Array.isArray(team.relief_pitchers) ? team.relief_pitchers : [];
  const pitcherLinePlayers = [];
  reliefPitchers.forEach((reliever) => {
    if (!reliever?.name || samePitcher(reliever, pitcher)) return;
    if (!pitcherLinePlayers.some((existing) => samePitcher(existing, reliever))) {
      pitcherLinePlayers.push(reliever);
    }
  });
  if (
    currentPitcher
    && !samePitcher(currentPitcher, pitcher)
    && !pitcherLinePlayers.some((existing) => samePitcher(existing, currentPitcher))
  ) {
    pitcherLinePlayers.push(currentPitcher);
  }
  const yearColumns = historyYears(data);
  const currentYear = Number(data.season_year || String(data.target_date || "").slice(0, 4));
  const contextPlayer = contextHeaderPlayer(batters);
  const contextColspan = 2 + 2 + 2 + contextAvgOnlyColumns.length;
  const pitcherLines = [
    renderPitcherLine(pitcher, "선발투수", pitcher),
    ...pitcherLinePlayers.map((reliever) => renderPitcherLine(
      reliever,
      "교체투수",
      pitcher,
      Boolean(currentPitcher && samePitcher(reliever, currentPitcher)),
    )),
  ].join("");

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

      <div class="pitcher-stack">${pitcherLines}</div>

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
  if (todayView) {
    teamsRoot.dataset.mobileSection = "recent";
    teamsRoot.innerHTML = renderTodayLineupView(data);
    return;
  }
  if (data.view_mode === "team_overview") {
    teamsRoot.innerHTML = "";
    return;
  }
  if (data.view_mode === "team_roster" && teamsRoot.dataset.mobileSection === "history") {
    teamsRoot.dataset.mobileSection = "recent";
  }
  if (data.view_mode === "team_roster") {
    if (rosterView === "hitters") teamsRoot.dataset.mobileSection = "recent";
    if (rosterView === "pitchers") teamsRoot.dataset.mobileSection = "matchup";
  }
  if (!teams.length) {
    const hasCancelledGame = (data.games || []).some((game) => isCancelledGame(game));
    teamsRoot.innerHTML = `<div class="empty-state">${hasCancelledGame ? "취소된 경기입니다." : "표시할 팀 정보가 없습니다."}</div>`;
    return;
  }
  teamsRoot.innerHTML = teams.map((team) => renderTeamPanel(team, data)).join("");
}

function setMobileSection(section) {
  teamsRoot.dataset.mobileSection = ["recent", "matchup", "history"].includes(section) ? section : "recent";
}

function setLoading(isLoading, message = "데이터 수집 중") {
  [...controls.querySelectorAll("button"), refreshTodayStats].filter(Boolean).forEach((button) => {
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
    team: gameStatusView || todayView ? "" : teamSelect.value,
  });
  if (!gameStatusView && !todayView && selectedGameId) params.set("gameId", selectedGameId);
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
  refreshGameButton.classList.toggle("active", gameStatusView);
  renderGameStrip(data);
  if (gameStatusView) {
    teamStats.hidden = true;
    teamStats.innerHTML = "";
    teamsRoot.innerHTML = "";
    setStatus(data, phase);
    cacheLine.textContent = "경기 상황만 표시 중";
    return;
  }
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
  const overviewOnly = teamSelect.value === TEAM_OVERVIEW_VALUE && !selectedGameId;
  clearAutoRefresh();
  if (!silent) {
    setLoading(true, progressive ? "기본 정보 불러오는 중" : "데이터 수집 중");
    showError("");
  }

  try {
    if (gameStatusView) {
      const statusData = await fetchLineups({ includeRecords: false });
      if (token !== loadToken) return;
      renderData(statusData, phase);
      return;
    }

    if (progressive) {
      const baseData = await fetchLineups({ includeRecords: false });
      if (token !== loadToken) return;
      renderData(baseData, overviewOnly ? phase : "base");
      if (overviewOnly) return;
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

applyUrlState();
renderTeamQuickNav();
syncUrlState();
controls.addEventListener("submit", (event) => {
  event.preventDefault();
  gameStatusView = false;
  syncUrlState();
  loadData({ progressive: true });
});
teamSelect.addEventListener("change", () => {
  gameStatusView = false;
  todayView = "";
  selectedGameId = "";
  resetTodayPositionFilter();
  closeQuickNavOnMobile();
  renderGameQuickNav(quickGames);
  renderTeamQuickNav();
  syncUrlState();
  loadData({ progressive: true });
});
function handleDateChange() {
  todayView = "";
  selectedGameId = "";
  resetTodayPositionFilter();
  closeQuickNavOnMobile();
  loadGameQuickNav();
  syncUrlState();
  loadData({ progressive: true });
}

function loadTodayFromRefresh(options = {}) {
  gameStatusView = false;
  dateInput.value = kstDateString();
  selectedGameId = "";
  renderGameQuickNav(quickGames);
  renderTeamQuickNav();
  syncUrlState();
  loadGameQuickNav();
  loadData(options);
}

function loadGameStatusView() {
  gameStatusView = true;
  dateInput.value = kstDateString();
  todayView = "";
  selectedGameId = "";
  teamSelect.value = "";
  resetTodayPositionFilter();
  renderGameQuickNav(quickGames);
  renderTeamQuickNav();
  syncUrlState();
  closeQuickNavOnMobile();
  loadGameQuickNav();
  loadData({ progressive: false, refreshHistoryMode: false });
}

dateInput.addEventListener("change", handleDateChange);
prevDateButton.addEventListener("click", () => changeDateBy(-1));
nextDateButton.addEventListener("click", () => changeDateBy(1));
quickNavToggle.addEventListener("click", () => {
  const isOpen = quickNavToggle.getAttribute("aria-expanded") === "true";
  setQuickNavOpen(!isOpen);
});
gameQuickNav.addEventListener("click", (event) => {
  const todayButton = event.target.closest(".today-jump");
  if (todayButton) {
    gameStatusView = false;
    todayView = validTodayView(todayButton.dataset.todayView);
    selectedGameId = "";
    teamSelect.value = "";
    resetTodayPositionFilter();
    renderGameQuickNav(quickGames);
    renderTeamQuickNav();
    syncUrlState();
    closeQuickNavOnMobile();
    loadData({ progressive: true });
    return;
  }

  const button = event.target.closest(".game-jump");
  if (!button) return;
  gameStatusView = false;
  todayView = "";
  selectedGameId = button.dataset.gameId || "";
  teamSelect.value = "";
  resetTodayPositionFilter();
  renderGameQuickNav(quickGames);
  renderTeamQuickNav();
  syncUrlState();
  closeQuickNavOnMobile();
  loadData({ progressive: true });
});
teamQuickNav.addEventListener("click", (event) => {
  const button = event.target.closest(".team-jump");
  if (!button) return;
  gameStatusView = false;
  todayView = "";
  const value = button.dataset.teamValue || "";
  ensureTeamOption(value, button.dataset.teamLabel || value || "전체");
  teamSelect.value = value;
  selectedGameId = "";
  resetTodayPositionFilter();
  renderGameQuickNav(quickGames);
  renderTeamQuickNav();
  syncUrlState();
  closeQuickNavOnMobile();
  loadData({ progressive: true });
});
refreshGameButton.addEventListener("click", loadGameStatusView);
refreshTodayStats.addEventListener("click", () => loadTodayFromRefresh({ progressive: false, refreshDailyStats: true }));
autoRefresh.addEventListener("change", () => {
  if (latestData) scheduleAutoRefresh(latestData);
});
teamsRoot.addEventListener("click", (event) => {
  const positionButton = event.target.closest("[data-today-position]");
  if (positionButton) {
    todayPositionFilter = positionButton.dataset.todayPosition || "";
    if (latestData) renderData(latestData);
    return;
  }

  const rosterButton = event.target.closest("[data-roster-view]");
  if (rosterButton) {
    rosterView = validRosterView(rosterButton.dataset.rosterView);
    if (rosterView === "hitters") setMobileSection("recent");
    if (rosterView === "pitchers") setMobileSection("matchup");
    syncUrlState();
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
