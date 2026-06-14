#!/usr/bin/env python3
"""Fetch today's KBO starting lineups by team.

The script reads Naver Sports' public JSON endpoints. If a current lineup has
not been published yet, it marks the team as unconfirmed and uses that team's
most recent confirmed batting order as the fallback basis. It also enriches
each listed player with recent game logs and recent season records.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python 3.8 fallback is best effort.
    ZoneInfo = None  # type: ignore


SCHEDULE_URL = "https://api-gw.sports.naver.com/schedule/games"
PREVIEW_URL = "https://api-gw.sports.naver.com/schedule/games/{game_id}/preview"
PLAYER_RECORD_URL = "https://api-gw.sports.naver.com/players/kbo/{player_code}/playerend-record"
VS_PLAYER_STATS_URL = "https://api-gw.sports.naver.com/players/kbo/{player_code}/vs-player-stats"
TEAM_STATS_URL = "https://api-gw.sports.naver.com/statistics/categories/kbo/seasons/{season_year}/teams"
SOURCE_NAME = "Naver Sports API"
SOURCE_BASE_URL = "https://m.sports.naver.com/kbaseball/schedule/index"
CACHE_SCHEMA_VERSION = 1
DEFAULT_HISTORY_CACHE = Path(__file__).resolve().parent / ".cache" / "kbo_player_history.json"


class KboLineupError(RuntimeError):
    """Raised when lineup data cannot be loaded."""


@dataclass(frozen=True)
class GameRef:
    game_id: str
    date: str
    home_code: str
    home_name: str
    away_code: str
    away_name: str
    stadium: str
    status: str
    time: str


@dataclass
class HistoryCache:
    path: Path
    data: dict[str, Any]
    dirty: bool = False


def kst_today() -> str:
    if ZoneInfo is None:
        return datetime.now().strftime("%Y-%m-%d")
    return datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d")


def now_kst_iso() -> str:
    if ZoneInfo is None:
        return datetime.now().isoformat(timespec="seconds")
    return datetime.now(ZoneInfo("Asia/Seoul")).isoformat(timespec="seconds")


def load_history_cache(path: str | Path) -> HistoryCache:
    cache_path = Path(path).expanduser()
    empty_cache = {"schema_version": CACHE_SCHEMA_VERSION, "players": {}}
    if not cache_path.exists():
        return HistoryCache(cache_path, empty_cache)

    try:
        with open(cache_path, encoding="utf-8") as file:
            data = json.load(file)
    except (OSError, json.JSONDecodeError):
        return HistoryCache(cache_path, empty_cache, dirty=True)

    if not isinstance(data, dict) or data.get("schema_version") != CACHE_SCHEMA_VERSION:
        return HistoryCache(cache_path, empty_cache, dirty=True)
    if not isinstance(data.get("players"), dict):
        data["players"] = {}
    return HistoryCache(cache_path, data)


def save_history_cache(cache: HistoryCache) -> None:
    if not cache.dirty:
        return
    cache.data["updated_at"] = now_kst_iso()
    cache.path.parent.mkdir(parents=True, exist_ok=True)
    with open(cache.path, "w", encoding="utf-8") as file:
        json.dump(cache.data, file, ensure_ascii=False, indent=2)
        file.write("\n")
    cache.dirty = False


def request_json(url: str, params: dict[str, str] | None = None, retries: int = 2) -> dict[str, Any]:
    if params:
        url = f"{url}?{urlencode(params)}"

    headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (compatible; KBO-Lineup-Fetcher/1.0)",
    }

    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with urlopen(Request(url, headers=headers), timeout=12) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                payload = response.read().decode(charset)
            data = json.loads(payload)
            if not data.get("success", True):
                raise KboLineupError(f"API returned unsuccessful response for {url}")
            return data
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(0.4 * (attempt + 1))

    raise KboLineupError(f"Failed to load {url}: {last_error}")


def fetch_games(target_date: str) -> list[GameRef]:
    data = request_json(
        SCHEDULE_URL,
        {
            "fields": "basic,schedule,baseball",
            "upperCategory": "kbaseball",
            "category": "kbo",
            "fromDate": target_date,
            "toDate": target_date,
            "size": "100",
        },
    )

    games = []
    for raw in data.get("result", {}).get("games", []):
        if raw.get("categoryId") != "kbo":
            continue
        if raw.get("cancel") or raw.get("suspended"):
            continue

        games.append(
            GameRef(
                game_id=raw["gameId"],
                date=raw.get("gameDate", target_date),
                home_code=raw.get("homeTeamCode", ""),
                home_name=raw.get("homeTeamName", ""),
                away_code=raw.get("awayTeamCode", ""),
                away_name=raw.get("awayTeamName", ""),
                stadium=raw.get("stadium", ""),
                status=raw.get("statusInfo") or raw.get("statusCode", ""),
                time=(raw.get("gameDateTime") or "").split("T")[-1][:5],
            )
        )

    return games


def fetch_preview(game_id: str) -> dict[str, Any]:
    data = request_json(PREVIEW_URL.format(game_id=game_id))
    preview = data.get("result", {}).get("previewData")
    if not isinstance(preview, dict):
        raise KboLineupError(f"No previewData for game {game_id}")
    return preview


def fetch_team_stats(season_year: int | str) -> dict[str, dict[str, Any]]:
    data = request_json(TEAM_STATS_URL.format(season_year=season_year))
    teams = data.get("result", {}).get("seasonTeamStats") or []
    if not isinstance(teams, list):
        raise KboLineupError(f"No team stats for season {season_year}")

    by_code = {}
    for team in teams:
        if not isinstance(team, dict):
            continue
        team_code = str(team.get("teamId") or "")
        if team_code:
            by_code[team_code] = team
    return by_code


def parse_json_object(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def is_season_year(value: Any) -> bool:
    try:
        int(str(value))
    except (TypeError, ValueError):
        return False
    return True


def find_season_record(seasons: list[Any], year: int) -> dict[str, Any] | None:
    for season in seasons:
        if isinstance(season, dict) and str(season.get("gyear")) == str(year):
            return season
    return None


def build_history_cache_entry(
    player_code: str,
    player_name: str,
    result: dict[str, Any],
    seasons: list[Any],
    current_year: int,
    player_type: str,
) -> dict[str, Any]:
    historical_seasons = [
        season for season in seasons
        if isinstance(season, dict)
        and is_season_year(season.get("gyear"))
        and int(str(season.get("gyear"))) != current_year
    ]
    historical_seasons.sort(key=lambda item: int(str(item.get("gyear"))), reverse=True)
    career = next(
        (season for season in seasons if isinstance(season, dict) and str(season.get("gyear")) == "통산"),
        None,
    )

    return {
        "player_code": player_code,
        "player_name": player_name,
        "player_type": player_type,
        "description": result.get("playerDescription", ""),
        "cached_at": now_kst_iso(),
        "source_url": PLAYER_RECORD_URL.format(player_code=player_code),
        "historical_seasons": historical_seasons,
        "career": career,
    }


def ensure_history_entry(
    cache: HistoryCache | None,
    player_code: str,
    player_name: str,
    result: dict[str, Any],
    seasons: list[Any],
    current_year: int,
    player_type: str,
    refresh_history: bool,
) -> tuple[dict[str, Any] | None, str]:
    if cache is None:
        return build_history_cache_entry(player_code, player_name, result, seasons, current_year, player_type), "live_only"

    players = cache.data.setdefault("players", {})
    entry = players.get(player_code)
    if refresh_history or not isinstance(entry, dict):
        entry = build_history_cache_entry(player_code, player_name, result, seasons, current_year, player_type)
        players[player_code] = entry
        cache.dirty = True
        return entry, "refreshed" if refresh_history else "created"

    return entry, "reused"


def compose_recent_3_years(
    current_year: int,
    current_year_record: dict[str, Any] | None,
    history_entry: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    by_year: dict[str, dict[str, Any]] = {}
    if current_year_record:
        by_year[str(current_year)] = current_year_record

    if history_entry:
        for season in history_entry.get("historical_seasons", []):
            if isinstance(season, dict) and is_season_year(season.get("gyear")):
                by_year[str(season.get("gyear"))] = season

    recent_years = [str(year) for year in range(current_year, current_year - 3, -1)]
    return [by_year[year] for year in recent_years if year in by_year]


def fetch_player_record(
    player_code: str,
    history_cache: HistoryCache | None = None,
    refresh_history: bool = False,
    player_name: str = "",
) -> dict[str, Any]:
    data = request_json(PLAYER_RECORD_URL.format(player_code=player_code))
    result = data.get("result")
    if not isinstance(result, dict):
        raise KboLineupError(f"No player record for player {player_code}")

    record = parse_json_object(result.get("record"))
    basic_record = parse_json_object(result.get("basicRecord"))
    current_year = int(result.get("currentSeasonYear") or result.get("year") or datetime.now().year)

    recent_games = record.get("game") or []
    seasons = record.get("season") or []
    vs_team = parse_json_object(result.get("vsTeam"))
    vs_teams = vs_team.get("vsteam") or []
    if not isinstance(recent_games, list):
        recent_games = []
    if not isinstance(seasons, list):
        seasons = []
    if not isinstance(vs_teams, list):
        vs_teams = []

    player_type = result.get("playerType") or infer_player_type_from_seasons(seasons)
    recent_10_games = recent_games[:10]
    current_year_record = find_season_record(seasons, current_year)
    history_entry, history_cache_status = ensure_history_entry(
        cache=history_cache,
        player_code=player_code,
        player_name=player_name,
        result=result,
        seasons=seasons,
        current_year=current_year,
        player_type=player_type,
        refresh_history=refresh_history,
    )

    return {
        "player_type": player_type,
        "description": result.get("playerDescription", ""),
        "current_season_year": current_year,
        "basic": basic_record.get("basic", {}),
        "ranks": basic_record.get("rank", []),
        "current_year_record": current_year_record,
        "recent_10_games": {
            "summary": summarize_recent_games(recent_10_games, player_type),
            "games": recent_10_games,
            "day_limit": record.get("day_limit"),
            "day_start": record.get("day_start"),
            "updated_at": now_kst_iso(),
        },
        "vs_teams": [item for item in vs_teams if isinstance(item, dict)],
        "recent_3_years": compose_recent_3_years(current_year, current_year_record, history_entry),
        "recent_3_years_cache": {
            "status": history_cache_status,
            "cache_path": str(history_cache.path) if history_cache else None,
            "cached_at": history_entry.get("cached_at") if isinstance(history_entry, dict) else None,
        },
        "career": history_entry.get("career") if isinstance(history_entry, dict) else None,
        "source_url": PLAYER_RECORD_URL.format(player_code=player_code),
    }


def fetch_vs_player_stats(
    player_code: str,
    vs_player_code: str,
    player_type: str = "hitter",
) -> dict[str, Any]:
    data = request_json(
        VS_PLAYER_STATS_URL.format(player_code=player_code),
        {
            "playerType": player_type,
            "vsPlayerId": vs_player_code,
        },
    )
    result = data.get("result")
    if not isinstance(result, dict):
        raise KboLineupError(f"No vs player stats for player {player_code} vs {vs_player_code}")

    season_stats = result.get("seasonStats") or []
    if not isinstance(season_stats, list):
        season_stats = []
    season_stats = [season for season in season_stats if isinstance(season, dict)]
    season_stats.sort(key=lambda season: intish(season.get("year")), reverse=True)

    return {
        "player_code": result.get("playerId") or player_code,
        "vs_player_code": result.get("vsPlayerId") or vs_player_code,
        "player_type": player_type,
        "summary": summarize_vs_hitter(season_stats),
        "season_stats": season_stats,
        "updated_at": now_kst_iso(),
        "source_url": (
            f"{VS_PLAYER_STATS_URL.format(player_code=player_code)}?"
            f"playerType={player_type}&vsPlayerId={vs_player_code}"
        ),
    }


def infer_player_type_from_seasons(seasons: list[Any]) -> str:
    for season in seasons:
        if not isinstance(season, dict):
            continue
        if "era" in season or "inn" in season or "whip" in season:
            return "pitcher"
        if "hra" in season or "rbi" in season or "ops" in season:
            return "hitter"
    return "unknown"


def numeric(value: Any, default: float = 0.0) -> float:
    if value in (None, "", "-"):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def intish(value: Any) -> int:
    return int(numeric(value))


def format_avg(value: float | None) -> str:
    if value is None:
        return "-"
    return f"{value:.3f}".replace("0.", ".")


def display_width(value: Any) -> int:
    text = str(value)
    return sum(2 if unicodedata.east_asian_width(char) in ("F", "W") else 1 for char in text)


def pad_display(value: Any, width: int) -> str:
    text = str(value)
    return text + " " * max(width - display_width(text), 0)


def short_year(value: Any) -> str:
    text = str(value or "")
    return text[-2:] if len(text) == 4 and text.isdigit() else text


def innings_to_outs(value: Any) -> int:
    if value in (None, "", "-"):
        return 0
    if isinstance(value, (int, float)):
        whole = int(value)
        fraction = round((float(value) - whole) * 10)
        return whole * 3 + fraction

    text = str(value).strip().replace("⅓", "1/3").replace("⅔", "2/3")
    if not text:
        return 0

    if " " in text:
        whole_text, fraction_text = text.split(" ", 1)
        whole = intish(whole_text)
    else:
        whole, fraction_text = 0, text
        if "/" not in text:
            return intish(text) * 3

    if fraction_text == "1/3":
        return whole * 3 + 1
    if fraction_text == "2/3":
        return whole * 3 + 2
    return whole * 3


def outs_to_innings(outs: int) -> str:
    whole, remainder = divmod(outs, 3)
    if remainder == 0:
        return str(whole)
    return f"{whole} {remainder}/3"


def summarize_recent_games(games: list[dict[str, Any]], player_type: str) -> dict[str, Any]:
    if player_type == "pitcher":
        return summarize_recent_pitching(games)
    return summarize_recent_hitting(games)


def summarize_vs_hitter(season_stats: list[dict[str, Any]]) -> dict[str, Any]:
    totals = {
        "seasons": len(season_stats),
        "years": [season.get("year") for season in season_stats if season.get("year")],
        "pa": sum(intish(season.get("pa")) for season in season_stats),
        "ab": sum(intish(season.get("ab")) for season in season_stats),
        "hit": sum(intish(season.get("hit")) for season in season_stats),
        "h2": sum(intish(season.get("h2")) for season in season_stats),
        "h3": sum(intish(season.get("h3")) for season in season_stats),
        "hr": sum(intish(season.get("hr")) for season in season_stats),
        "rbi": sum(intish(season.get("rbi")) for season in season_stats),
        "bbhp": sum(intish(season.get("bbhp")) for season in season_stats),
        "kk": sum(intish(season.get("kk")) for season in season_stats),
        "gd": sum(intish(season.get("gd")) for season in season_stats),
    }
    total_bases = (
        totals["hit"]
        + totals["h2"]
        + 2 * totals["h3"]
        + 3 * totals["hr"]
    )
    totals["avg"] = round(totals["hit"] / totals["ab"], 3) if totals["ab"] else None
    totals["obp"] = round((totals["hit"] + totals["bbhp"]) / totals["pa"], 3) if totals["pa"] else None
    totals["slg"] = round(total_bases / totals["ab"], 3) if totals["ab"] else None
    totals["ops"] = (
        round(totals["obp"] + totals["slg"], 3)
        if totals["obp"] is not None and totals["slg"] is not None
        else None
    )
    return totals


def summarize_recent_hitting(games: list[dict[str, Any]]) -> dict[str, Any]:
    totals = {
        "games": len(games),
        "ab": sum(intish(game.get("ab")) for game in games),
        "hit": sum(intish(game.get("hit")) for game in games),
        "h2": sum(intish(game.get("h2")) for game in games),
        "h3": sum(intish(game.get("h3")) for game in games),
        "hr": sum(intish(game.get("hr")) for game in games),
        "rbi": sum(intish(game.get("rbi")) for game in games),
        "run": sum(intish(game.get("run")) for game in games),
        "bb": sum(intish(game.get("bb")) for game in games),
        "kk": sum(intish(game.get("kk")) for game in games),
        "sb": sum(intish(game.get("sb")) for game in games),
    }
    totals["avg"] = round(totals["hit"] / totals["ab"], 3) if totals["ab"] else None
    return totals


def summarize_recent_pitching(games: list[dict[str, Any]]) -> dict[str, Any]:
    outs = sum(innings_to_outs(game.get("inn")) for game in games)
    er = sum(intish(game.get("er")) for game in games)
    hit = sum(intish(game.get("hit")) for game in games)
    bb = sum(intish(game.get("bb")) for game in games)
    summary = {
        "games": len(games),
        "innings": outs_to_innings(outs),
        "outs": outs,
        "w": sum(1 for game in games if game.get("wls") == "W"),
        "l": sum(1 for game in games if game.get("wls") == "L"),
        "hold": sum(intish(game.get("hold")) for game in games),
        "hit": hit,
        "hr": sum(intish(game.get("hr")) for game in games),
        "bb": bb,
        "hp": sum(intish(game.get("hp")) for game in games),
        "kk": sum(intish(game.get("kk")) for game in games),
        "r": sum(intish(game.get("r")) for game in games),
        "er": er,
    }
    innings = outs / 3 if outs else 0
    summary["era"] = round(er * 9 / innings, 2) if innings else None
    summary["whip"] = round((hit + bb) / innings, 2) if innings else None
    return summary


def compact_player(raw: dict[str, Any]) -> dict[str, Any]:
    player = {
        "name": raw.get("playerName") or raw.get("name") or "",
        "player_code": raw.get("playerCode") or raw.get("pCode") or raw.get("pcode") or "",
        "position": raw.get("positionName") or raw.get("position") or raw.get("pos") or "",
        "bat_order": raw.get("batorder") or raw.get("batOrder"),
        "bats_throws": raw.get("batsThrows") or raw.get("hitType") or "",
        "back_number": raw.get("backnum") or "",
    }
    return {key: value for key, value in player.items() if value not in ("", None)}


def get_lineup(preview: dict[str, Any], side: str) -> dict[str, Any]:
    lineup_key = f"{side}TeamLineUp"
    lineup = preview.get(lineup_key)
    return lineup if isinstance(lineup, dict) else {}


def lineup_parts(lineup: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    full_lineup = lineup.get("fullLineUp") or []
    if not isinstance(full_lineup, list):
        return None, []

    pitcher = None
    batters = []
    for raw in full_lineup:
        if not isinstance(raw, dict):
            continue
        player = compact_player(raw)
        if raw.get("positionName") == "선발투수" and pitcher is None:
            pitcher = player
        if raw.get("batorder") is not None:
            batters.append(player)

    batters.sort(key=lambda item: int(item.get("bat_order", 99)))
    return pitcher, batters


def is_confirmed_lineup(lineup: dict[str, Any]) -> bool:
    _pitcher, batters = lineup_parts(lineup)
    return len({batter.get("bat_order") for batter in batters}) >= 9


def game_ref_from_preview(preview: dict[str, Any], fallback_game_id: str = "") -> GameRef:
    info = preview.get("gameInfo", {})
    game_date = str(info.get("gdate") or "")
    if len(game_date) == 8:
        game_date = f"{game_date[:4]}-{game_date[4:6]}-{game_date[6:]}"

    return GameRef(
        game_id=fallback_game_id,
        date=game_date,
        home_code=info.get("hCode", ""),
        home_name=info.get("hName", ""),
        away_code=info.get("aCode", ""),
        away_name=info.get("aName", ""),
        stadium=info.get("stadium", ""),
        status=str(info.get("statusCode", "")),
        time=info.get("gtime", ""),
    )


def side_for_team(preview: dict[str, Any], team_code: str) -> str | None:
    info = preview.get("gameInfo", {})
    if info.get("hCode") == team_code:
        return "home"
    if info.get("aCode") == team_code:
        return "away"
    return None


def previous_games_for_side(preview: dict[str, Any], side: str) -> list[dict[str, Any]]:
    games = preview.get(f"{side}TeamPreviousGames") or []
    return games if isinstance(games, list) else []


def find_previous_confirmed_lineup(
    team_code: str,
    previous_games: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    for previous in previous_games:
        previous_game_id = previous.get("gameId")
        if not previous_game_id:
            continue

        previous_preview = fetch_preview(previous_game_id)
        previous_side = side_for_team(previous_preview, team_code)
        if previous_side is None:
            continue

        previous_lineup = get_lineup(previous_preview, previous_side)
        if is_confirmed_lineup(previous_lineup):
            source_game = {
                "game_id": previous_game_id,
                "date": str(previous.get("gdate", "")),
                "weekday": previous.get("gweek", ""),
                "result": previous.get("result", ""),
                "home_team": previous.get("hName", ""),
                "away_team": previous.get("aName", ""),
                "home_score": previous.get("hScore"),
                "away_score": previous.get("aScore"),
            }
            if len(source_game["date"]) == 8:
                raw_date = source_game["date"]
                source_game["date"] = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
            return previous_lineup, source_game

    return None


def build_team_lineup(
    preview: dict[str, Any],
    game: GameRef,
    side: str,
) -> dict[str, Any]:
    info = preview.get("gameInfo", {})
    team_code = info.get("hCode") if side == "home" else info.get("aCode")
    team_name = info.get("hName") if side == "home" else info.get("aName")
    current_lineup = get_lineup(preview, side)
    current_pitcher, current_batters = lineup_parts(current_lineup)

    if is_confirmed_lineup(current_lineup):
        return {
            "team_code": team_code,
            "team_name": team_name,
            "status": "확정",
            "basis": "오늘 발표 라인업",
            "source_game": {
                "game_id": game.game_id,
                "date": game.date,
                "home_team": game.home_name,
                "away_team": game.away_name,
            },
            "starting_pitcher": current_pitcher,
            "batting_order": current_batters,
        }

    previous = find_previous_confirmed_lineup(
        team_code=team_code,
        previous_games=previous_games_for_side(preview, side),
    )

    if previous is None:
        return {
            "team_code": team_code,
            "team_name": team_name,
            "status": "미확정",
            "basis": "전 경기 라인업 없음",
            "source_game": None,
            "starting_pitcher": current_pitcher,
            "batting_order": [],
        }

    previous_lineup, source_game = previous
    previous_pitcher, previous_batters = lineup_parts(previous_lineup)

    return {
        "team_code": team_code,
        "team_name": team_name,
        "status": "미확정",
        "basis": "전 경기 타순 기준",
        "source_game": source_game,
        "starting_pitcher": current_pitcher or previous_pitcher,
        "batting_order": previous_batters,
        "note": "오늘 라인업이 아직 공개되지 않아 타순은 직전 확인 라인업을 사용했습니다.",
    }


def enrich_player_with_records(
    player: dict[str, Any] | None,
    record_cache: dict[str, dict[str, Any]],
    history_cache: HistoryCache | None,
    refresh_history: bool,
) -> dict[str, Any] | None:
    if not player:
        return player

    player_code = str(player.get("player_code") or "")
    if not player_code:
        player["records"] = {"error": "player_code 없음"}
        return player

    if player_code not in record_cache:
        try:
            record_cache[player_code] = fetch_player_record(
                player_code,
                history_cache=history_cache,
                refresh_history=refresh_history,
                player_name=str(player.get("name") or ""),
            )
        except KboLineupError as exc:
            record_cache[player_code] = {
                "error": str(exc),
                "source_url": PLAYER_RECORD_URL.format(player_code=player_code),
            }

    player["records"] = record_cache[player_code]
    return player


def enrich_team_with_records(
    team: dict[str, Any],
    record_cache: dict[str, dict[str, Any]],
    history_cache: HistoryCache | None,
    refresh_history: bool,
) -> dict[str, Any]:
    enrich_player_with_records(team.get("starting_pitcher"), record_cache, history_cache, refresh_history)
    for batter in team.get("batting_order", []):
        enrich_player_with_records(batter, record_cache, history_cache, refresh_history)
    return team


def enrich_batters_with_vs_starter(
    team: dict[str, Any],
    opposing_pitcher: dict[str, Any] | None,
    vs_cache: dict[tuple[str, str], dict[str, Any]],
) -> dict[str, Any]:
    if not opposing_pitcher:
        return team

    pitcher_code = str(opposing_pitcher.get("player_code") or "")
    if not pitcher_code:
        return team

    pitcher_info = {
        "name": opposing_pitcher.get("name", ""),
        "player_code": pitcher_code,
        "position": opposing_pitcher.get("position", ""),
        "bats_throws": opposing_pitcher.get("bats_throws", ""),
    }

    for batter in team.get("batting_order", []):
        batter_code = str(batter.get("player_code") or "")
        if not batter_code:
            batter["vs_starting_pitcher"] = {
                "opposing_pitcher": pitcher_info,
                "error": "player_code 없음",
            }
            continue

        cache_key = (batter_code, pitcher_code)
        if cache_key not in vs_cache:
            try:
                vs_cache[cache_key] = fetch_vs_player_stats(
                    batter_code,
                    pitcher_code,
                    player_type="hitter",
                )
            except KboLineupError as exc:
                vs_cache[cache_key] = {
                    "error": str(exc),
                    "source_url": (
                        f"{VS_PLAYER_STATS_URL.format(player_code=batter_code)}?"
                        f"playerType=hitter&vsPlayerId={pitcher_code}"
                    ),
                }

        batter["vs_starting_pitcher"] = {
            "opposing_pitcher": pitcher_info,
            "stats": vs_cache[cache_key],
        }

    return team


def build_vs_opponent_record(
    season_vs_result: dict[str, Any] | None,
    side: str,
    opponent: dict[str, Any],
) -> dict[str, Any]:
    opponent_team = {
        "team_code": opponent.get("team_code", ""),
        "team_name": opponent.get("team_name", ""),
    }
    if not isinstance(season_vs_result, dict):
        return {"opponent_team": opponent_team, "available": False}

    prefix = "h" if side == "home" else "a"
    wins = intish(season_vs_result.get(f"{prefix}w"))
    losses = intish(season_vs_result.get(f"{prefix}l"))
    draws = intish(season_vs_result.get(f"{prefix}d"))
    return {
        "opponent_team": opponent_team,
        "available": True,
        "wins": wins,
        "draws": draws,
        "losses": losses,
        "games": wins + draws + losses,
        "raw": season_vs_result,
    }


def attach_team_context(
    team: dict[str, Any],
    opponent: dict[str, Any],
    team_stats_by_code: dict[str, dict[str, Any]],
    season_vs_result: dict[str, Any] | None,
    side: str,
) -> dict[str, Any]:
    team_code = str(team.get("team_code") or "")
    team["opponent"] = {
        "team_code": opponent.get("team_code", ""),
        "team_name": opponent.get("team_name", ""),
    }
    team["team_season"] = team_stats_by_code.get(team_code)
    team["vs_opponent_record"] = build_vs_opponent_record(season_vs_result, side, opponent)
    return team


def find_player_vs_team_stats(player: dict[str, Any], opponent_code: str) -> dict[str, Any] | None:
    records = player.get("records")
    if not isinstance(records, dict):
        return None

    for item in records.get("vs_teams") or []:
        if isinstance(item, dict) and str(item.get("team") or "") == opponent_code:
            return item
    return None


def attach_player_vs_opponent_team(player: dict[str, Any] | None, opponent: dict[str, Any]) -> None:
    if not isinstance(player, dict):
        return

    opponent_team = {
        "team_code": opponent.get("team_code", ""),
        "team_name": opponent.get("team_name", ""),
    }
    records = player.get("records")
    if not isinstance(records, dict):
        player["vs_opponent_team"] = {
            "opponent_team": opponent_team,
            "available": False,
        }
        return
    if records.get("error"):
        player["vs_opponent_team"] = {
            "opponent_team": opponent_team,
            "available": False,
            "error": records.get("error"),
        }
        return

    opponent_code = str(opponent_team.get("team_code") or "")
    stats = find_player_vs_team_stats(player, opponent_code)
    player["vs_opponent_team"] = {
        "opponent_team": opponent_team,
        "available": stats is not None,
        "stats": stats,
        "updated_at": records.get("recent_10_games", {}).get("updated_at"),
    }


def enrich_team_with_vs_opponent(team: dict[str, Any], opponent: dict[str, Any]) -> dict[str, Any]:
    attach_player_vs_opponent_team(team.get("starting_pitcher"), opponent)
    for batter in team.get("batting_order", []):
        attach_player_vs_opponent_team(batter, opponent)
    return team


def sorted_team_stats(team_stats_by_code: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        team_stats_by_code.values(),
        key=lambda team: (intish(team.get("ranking") or 999), str(team.get("teamName") or "")),
    )


def collect_lineups(
    target_date: str,
    include_player_records: bool = True,
    refresh_history: bool = False,
    history_cache_path: str | Path = DEFAULT_HISTORY_CACHE,
) -> dict[str, Any]:
    games = fetch_games(target_date)
    teams = []
    game_results = []
    record_cache: dict[str, dict[str, Any]] = {}
    vs_cache: dict[tuple[str, str], dict[str, Any]] = {}
    history_cache = load_history_cache(history_cache_path) if include_player_records else None
    season_year = int(target_date[:4])
    team_stats_by_code = fetch_team_stats(season_year)

    for game in games:
        preview = fetch_preview(game.game_id)
        away = build_team_lineup(preview, game, "away")
        home = build_team_lineup(preview, game, "home")
        away["game_id"] = game.game_id
        away["side"] = "away"
        home["game_id"] = game.game_id
        home["side"] = "home"
        season_vs_result = preview.get("seasonVsResult")
        season_vs_result = season_vs_result if isinstance(season_vs_result, dict) else None
        attach_team_context(away, home, team_stats_by_code, season_vs_result, "away")
        attach_team_context(home, away, team_stats_by_code, season_vs_result, "home")
        if include_player_records:
            enrich_team_with_records(away, record_cache, history_cache, refresh_history)
            enrich_team_with_records(home, record_cache, history_cache, refresh_history)
            enrich_team_with_vs_opponent(away, home)
            enrich_team_with_vs_opponent(home, away)
            enrich_batters_with_vs_starter(away, home.get("starting_pitcher"), vs_cache)
            enrich_batters_with_vs_starter(home, away.get("starting_pitcher"), vs_cache)
        teams.extend([away, home])
        game_results.append(
            {
                "game_id": game.game_id,
                "date": game.date,
                "time": game.time,
                "stadium": game.stadium,
                "status": game.status,
                "away_team": game.away_name,
                "home_team": game.home_name,
            }
        )

    generated_at = datetime.now(ZoneInfo("Asia/Seoul")).isoformat(timespec="seconds") if ZoneInfo else datetime.now().isoformat(timespec="seconds")
    if history_cache:
        save_history_cache(history_cache)

    return {
        "target_date": target_date,
        "generated_at": generated_at,
        "source": {
            "name": SOURCE_NAME,
            "url": SOURCE_BASE_URL,
        },
        "season_year": season_year,
        "league_team_stats": {
            "source_url": TEAM_STATS_URL.format(season_year=season_year),
            "teams": sorted_team_stats(team_stats_by_code),
        },
        "player_records_included": include_player_records,
        "history_cache": {
            "enabled": include_player_records,
            "path": str(history_cache.path) if history_cache else None,
            "refresh_requested": refresh_history,
        },
        "games": game_results,
        "teams": teams,
    }


def normalize_team_key(value: Any) -> str:
    return "".join(str(value or "").strip().lower().split())


def team_match_keys(team: dict[str, Any]) -> set[str]:
    values = [
        team.get("team_code"),
        team.get("team_name"),
    ]
    stats = team.get("team_season")
    if isinstance(stats, dict):
        values.extend(
            [
                stats.get("teamId"),
                stats.get("teamName"),
                stats.get("teamShortName"),
            ]
        )
    return {normalize_team_key(value) for value in values if normalize_team_key(value)}


def team_matches_query(team: dict[str, Any], query: str, partial: bool = False) -> bool:
    query_key = normalize_team_key(query)
    if not query_key:
        return False

    keys = team_match_keys(team)
    if query_key in keys:
        return True
    return partial and any(query_key in key for key in keys)


def available_team_labels(data: dict[str, Any]) -> str:
    labels = []
    seen = set()
    for team in data.get("teams", []):
        if not isinstance(team, dict):
            continue
        team_name = str(team.get("team_name") or "")
        team_code = str(team.get("team_code") or "")
        key = (team_name, team_code)
        if key in seen:
            continue
        seen.add(key)
        labels.append(f"{team_name}({team_code})" if team_code else team_name)
    return ", ".join(labels) if labels else "선택 가능한 팀 없음"


def filter_data_for_team(data: dict[str, Any], team_query: str | None) -> dict[str, Any]:
    if not team_query:
        return data

    teams = [team for team in data.get("teams", []) if isinstance(team, dict)]
    matches = [team for team in teams if team_matches_query(team, team_query)]
    if not matches:
        partial_matches = [team for team in teams if team_matches_query(team, team_query, partial=True)]
        unique_codes = {team.get("team_code") for team in partial_matches}
        if len(unique_codes) == 1:
            matches = partial_matches

    if not matches:
        raise KboLineupError(
            f"팀을 찾을 수 없습니다: {team_query}. 선택 가능: {available_team_labels(data)}"
        )

    game_ids = []
    for team in matches:
        game_id = team.get("game_id")
        if game_id and game_id not in game_ids:
            game_ids.append(game_id)

    selected_teams = []
    for game_id in game_ids:
        game_teams = [team for team in teams if team.get("game_id") == game_id]
        selected = [team for team in game_teams if team_matches_query(team, team_query)]
        if not selected:
            selected = [team for team in game_teams if team_matches_query(team, team_query, partial=True)]
        selected_ids = {id(team) for team in selected}
        opponents = [team for team in game_teams if id(team) not in selected_ids]
        selected_teams.extend(selected + opponents)

    selected_codes = {team.get("team_code") for team in selected_teams}
    filtered_games = [
        game for game in data.get("games", [])
        if isinstance(game, dict) and game.get("game_id") in game_ids
    ]

    filtered = dict(data)
    filtered["games"] = filtered_games
    filtered["teams"] = selected_teams
    filtered["selected_team"] = {
        "query": team_query,
        "team_name": matches[0].get("team_name"),
        "team_code": matches[0].get("team_code"),
        "included_game_ids": game_ids,
    }

    league = dict(data.get("league_team_stats") or {})
    league_teams = league.get("teams") or []
    if isinstance(league_teams, list):
        league["teams"] = [
            team for team in league_teams
            if isinstance(team, dict) and team.get("teamId") in selected_codes
        ]
    filtered["league_team_stats"] = league
    return filtered


def format_player_line(player: dict[str, Any] | None, fallback: str = "정보 없음") -> str:
    if not player:
        return fallback
    details = []
    if player.get("position"):
        details.append(str(player["position"]))
    if player.get("bats_throws"):
        details.append(str(player["bats_throws"]))
    suffix = f" ({', '.join(details)})" if details else ""
    return f"{player.get('name', fallback)}{suffix}"


def format_player_cell(player: dict[str, Any] | None) -> str:
    if not player:
        return "정보 없음"
    name = player.get("name", "정보 없음")
    tags = []
    if player.get("position"):
        tags.append(str(player["position"]))
    if player.get("bats_throws"):
        tags.append(str(player["bats_throws"]))
    return f"{name}({', '.join(tags)})" if tags else str(name)


def format_decimal(value: Any, digits: int = 2) -> str:
    if value in (None, "", "-"):
        return "-"
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return str(value)


def format_rate(value: Any) -> str:
    if value in (None, "", "-"):
        return "-"
    try:
        return f"{float(value):.3f}".replace("0.", ".")
    except (TypeError, ValueError):
        text = str(value)
        return text.replace("0.", ".") if text.startswith("0.") else text


def format_rate_fixed(value: Any, width: int = 5) -> str:
    return format_rate(value).rjust(width)


def format_count(value: Any, width: int) -> str:
    return str(intish(value)).rjust(width)


def format_hit_attempts(hit: Any, attempts: Any, width: int = 3) -> str:
    return f"{format_count(hit, width)}/{format_count(attempts, width)}"


def format_hr(value: Any) -> str:
    return f"{format_count(value, 2)}HR"


def format_rbi(value: Any) -> str:
    return f"{format_count(value, 3)}RBI"


def format_record_triplet(wins: Any, draws: Any, losses: Any) -> str:
    return f"{intish(wins)}승 {intish(draws)}무 {intish(losses)}패"


def format_team_overall_cell(stats: dict[str, Any] | None) -> str:
    if not isinstance(stats, dict):
        return "팀 성적 없음"

    record = format_record_triplet(
        stats.get("winGameCount"),
        stats.get("drawnGameCount"),
        stats.get("loseGameCount"),
    )
    details = [
        f"{stats.get('ranking', '-')}위",
        record,
        f"승률 {format_rate(stats.get('wra'))}",
        f"GB {stats.get('gameBehind', '-')}",
    ]
    recent = stats.get("lastFiveGames")
    streak = stats.get("continuousGameResult")
    if recent:
        details.append(f"최근5 {recent}")
    if streak:
        details.append(str(streak))
    return " ".join(details)


def format_team_batting_cell(stats: dict[str, Any] | None) -> str:
    if not isinstance(stats, dict):
        return "타격 성적 없음"
    return (
        f"AVG {format_rate(stats.get('offenseHra'))} "
        f"OBP {format_rate(stats.get('offenseObp'))} "
        f"SLG {format_rate(stats.get('offenseSlg'))} "
        f"OPS {format_rate_fixed(stats.get('offenseOps'))} "
        f"{stats.get('offenseHr', 0)}HR {stats.get('offenseRun', 0)}득점"
    )


def format_team_pitching_cell(stats: dict[str, Any] | None) -> str:
    if not isinstance(stats, dict):
        return "투수 성적 없음"
    return (
        f"ERA {format_decimal(stats.get('defenseEra'))} "
        f"WHIP {format_decimal(stats.get('defenseWhip'))} "
        f"QS {stats.get('defenseQs', 0)} "
        f"SV {stats.get('defenseSave', 0)} "
        f"HLD {stats.get('defenseHold', 0)}"
    )


def format_team_vs_record(team: dict[str, Any]) -> str:
    record = team.get("vs_opponent_record")
    opponent = team.get("opponent") or {}
    opponent_name = opponent.get("team_name") or "상대팀"
    if not isinstance(record, dict) or not record.get("available"):
        return f"vs {opponent_name}: 상대전적 없음"
    return (
        f"vs {opponent_name}: "
        f"{format_record_triplet(record.get('wins'), record.get('draws'), record.get('losses'))}"
    )


def format_recent_cell(player: dict[str, Any]) -> str:
    records = player.get("records")
    if not isinstance(records, dict):
        return "-"
    if records.get("error"):
        return "기록 오류"

    player_type = records.get("player_type")
    summary = records.get("recent_10_games", {}).get("summary", {})
    if not isinstance(summary, dict):
        return "-"

    if player_type == "pitcher":
        return (
            f"{summary.get('games', 0)}G {summary.get('innings', '0')}IP "
            f"ERA {format_decimal(summary.get('era'))} "
            f"WHIP {format_decimal(summary.get('whip'))} "
            f"{summary.get('kk', 0)}K"
        )

    return (
        f"{format_avg(summary.get('avg'))} "
        f"{format_hit_attempts(summary.get('hit'), summary.get('ab'))} "
        f"{format_hr(summary.get('hr'))} {format_rbi(summary.get('rbi'))}"
    )


def format_vs_team_cell(player: dict[str, Any], include_opponent: bool = True) -> str:
    matchup = player.get("vs_opponent_team")
    if not isinstance(matchup, dict):
        return "-"

    opponent = matchup.get("opponent_team") or {}
    opponent_name = opponent.get("team_name") or "상대팀"
    prefix = f"vs {opponent_name} " if include_opponent else ""
    if matchup.get("error"):
        return f"vs {opponent_name}: 기록 오류" if include_opponent else "기록 오류"

    stats = matchup.get("stats")
    if not isinstance(stats, dict):
        return f"vs {opponent_name}: 올해 전적 없음" if include_opponent else "올해 전적 없음"

    records = player.get("records") if isinstance(player.get("records"), dict) else {}
    if records.get("player_type") == "pitcher":
        if stats.get("inn") in (None, "", "-") and stats.get("era") in (None, "", "-"):
            return f"vs {opponent_name}: 올해 전적 없음" if include_opponent else "올해 전적 없음"
        return (
            f"{prefix}ERA {format_decimal(stats.get('era'))} "
            f"{stats.get('inn', '-')}IP {intish(stats.get('w'))}-{intish(stats.get('l'))} "
            f"{stats.get('kk', 0)}K WHIP {format_decimal(stats.get('whip'))}"
        )

    if stats.get("ab") in (None, "", "-") and stats.get("pa") in (None, "", "-"):
        return f"vs {opponent_name}: 올해 전적 없음" if include_opponent else "올해 전적 없음"
    return (
        f"{prefix}{format_rate(stats.get('hra'))} "
        f"{format_hit_attempts(stats.get('hit'), stats.get('ab'))} "
        f"OPS {format_rate_fixed(stats.get('ops'))} "
        f"{format_hr(stats.get('hr'))} {format_rbi(stats.get('rbi'))}"
    )


def format_season_cell(player: dict[str, Any]) -> str:
    records = player.get("records")
    if not isinstance(records, dict) or records.get("error"):
        return "-"
    years = records.get("recent_3_years") or []
    if not isinstance(years, list) or not years:
        return "시즌 기록 없음"

    player_type = records.get("player_type")
    chunks = []
    for year in years:
        if not isinstance(year, dict):
            continue
        label = year.get("gyear")
        if player_type == "pitcher":
            chunks.append(
                f"{short_year(label)} ERA {format_decimal(year.get('era'))} "
                f"{year.get('inn', '-')}IP {year.get('w', 0)}-{year.get('l', 0)} "
                f"{year.get('kk', 0)}K"
            )
        else:
            chunks.append(
                f"{short_year(label)} {format_rate(year.get('hra'))}/OPS {format_rate_fixed(year.get('ops'))} "
                f"{format_hr(year.get('hr'))} {format_rbi(year.get('rbi'))}"
            )
    return " | ".join(chunks)


def format_vs_starter_cell(player: dict[str, Any], include_pitcher: bool = True) -> str:
    matchup = player.get("vs_starting_pitcher")
    if not isinstance(matchup, dict):
        return "-"

    pitcher = matchup.get("opposing_pitcher") or {}
    pitcher_name = pitcher.get("name") or "상대선발"
    prefix = f"vs {pitcher_name} " if include_pitcher else ""
    stats = matchup.get("stats") or {}
    if not isinstance(stats, dict):
        return f"vs {pitcher_name}: -" if include_pitcher else "-"
    if stats.get("error"):
        return f"vs {pitcher_name}: 기록 오류" if include_pitcher else "기록 오류"

    summary = stats.get("summary") or {}
    if not isinstance(summary, dict) or intish(summary.get("pa")) == 0:
        return f"vs {pitcher_name}: 전적 없음" if include_pitcher else "전적 없음"

    return (
        f"{prefix}"
        f"{format_count(summary.get('pa'), 3)}PA "
        f"{format_hit_attempts(summary.get('hit'), summary.get('ab'))} "
        f"{format_hr(summary.get('hr'))} {format_rbi(summary.get('rbi'))} "
        f"OPS {format_rate_fixed(summary.get('ops'))}"
    )


def print_table(headers: list[str], rows: list[list[Any]], indent: str = "    ") -> None:
    if not rows:
        return

    widths = []
    for index, header in enumerate(headers[:-1]):
        widths.append(max(display_width(header), *(display_width(row[index]) for row in rows)))

    header_line = indent + "  ".join(
        pad_display(header, widths[index]) if index < len(widths) else str(header)
        for index, header in enumerate(headers)
    )
    divider = indent + "  ".join(
        "-" * widths[index] if index < len(widths) else "-" * min(max(display_width(header), 12), 60)
        for index, header in enumerate(headers)
    )
    print(header_line)
    print(divider)
    for row in rows:
        print(
            indent
            + "  ".join(
                pad_display(value, widths[index]) if index < len(widths) else str(value)
                for index, value in enumerate(row)
            )
        )


def print_league_team_stats(data: dict[str, Any]) -> None:
    league = data.get("league_team_stats") or {}
    teams = league.get("teams") or []
    if not isinstance(teams, list) or not teams:
        return

    title = f"{data.get('season_year', '')} 리그 팀 성적"
    if data.get("selected_team"):
        title = f"{data.get('season_year', '')} 선택 경기 팀 성적"
    print(title)
    rows = []
    for stats in teams:
        if not isinstance(stats, dict):
            continue
        rows.append(
            [
                stats.get("ranking", "-"),
                stats.get("teamName") or stats.get("teamShortName") or "-",
                format_team_overall_cell(stats),
                format_team_batting_cell(stats),
                format_team_pitching_cell(stats),
            ]
        )
    print_table(["순위", "팀", "전체", "타격", "투수"], rows, indent="  ")
    print()


def print_team_summary(team: dict[str, Any]) -> None:
    print("  팀 요약")
    stats = team.get("team_season") if isinstance(team.get("team_season"), dict) else None
    print(f"    전체: {format_team_overall_cell(stats)}")
    print(f"    타격: {format_team_batting_cell(stats)}")
    print(f"    투수: {format_team_pitching_cell(stats)}")
    print(f"    상대: {format_team_vs_record(team)}")


def print_starting_pitcher(player: dict[str, Any] | None) -> None:
    print("  선발투수")
    print(f"    {format_player_cell(player)}")
    if isinstance(player, dict) and player.get("records"):
        print(f"    최근10G: {format_recent_cell(player)}")
        print(f"    상대팀: {format_vs_team_cell(player)}")
        print(f"    시즌흐름: {format_season_cell(player)}")


def print_batter_table(batters: list[dict[str, Any]], opponent: dict[str, Any] | None = None) -> None:
    print("  타순/타자 기록")
    if not batters:
        print("    - 정보 없음")
        return

    opponent_name = ""
    if isinstance(opponent, dict):
        opponent_name = str(opponent.get("team_name") or "")
    vs_team_header = f"상대팀 vs {opponent_name} 올해" if opponent_name else "상대팀 올해"

    today_rows = []
    season_rows = []
    for batter in batters:
        today_rows.append(
            [
                batter.get("bat_order", "-"),
                format_player_cell(batter),
                format_recent_cell(batter) if batter.get("records") else "-",
                format_vs_team_cell(batter, include_opponent=False) if batter.get("records") else "-",
            ]
        )
    for batter in batters:
        season_rows.append(
            [
                batter.get("bat_order", "-"),
                batter.get("name", "정보 없음"),
                format_season_cell(batter) if batter.get("records") else "-",
            ]
        )
    print_table(["순", "선수", "최근10G", vs_team_header], today_rows)
    print("  상대 선발 전적")
    starter_name = ""
    for batter in batters:
        matchup = batter.get("vs_starting_pitcher")
        if not isinstance(matchup, dict):
            continue
        pitcher = matchup.get("opposing_pitcher") or {}
        starter_name = str(pitcher.get("name") or "")
        if starter_name:
            break
    starter_header = f"상대 선발 vs {starter_name}" if starter_name else "상대 선발"
    starter_rows = [
        [
            batter.get("bat_order", "-"),
            batter.get("name", "정보 없음"),
            format_vs_starter_cell(batter, include_pitcher=False),
        ]
        for batter in batters
    ]
    print_table(["순", "선수", starter_header], starter_rows)
    print("  최근 3년 시즌 흐름")
    print_table(["순", "선수", "최근3년 시즌"], season_rows)


def print_text_report(data: dict[str, Any]) -> None:
    print(f"KBO 선발 라인업 - {data['target_date']} KST")
    print(f"생성시각: {data['generated_at']}")
    print(f"출처: {data['source']['name']} {data['source']['url']}")
    selected = data.get("selected_team")
    if isinstance(selected, dict):
        print(
            "선택 팀: "
            f"{selected.get('team_name')}({selected.get('team_code')}) "
            "상대팀 포함"
        )
    print()
    print_league_team_stats(data)

    game_by_team: dict[str, dict[str, Any]] = {}
    for game in data["games"]:
        game_by_team[game["away_team"]] = game
        game_by_team[game["home_team"]] = game

    for team in data["teams"]:
        game = game_by_team.get(team["team_name"], {})
        matchup = ""
        if game:
            matchup = f"{game.get('away_team')} @ {game.get('home_team')}, {game.get('time')} {game.get('stadium')}, {game.get('status')}"
        print(f"[{team['team_name']}] {team['status']} - {team['basis']}")
        if matchup:
            print(f"  경기: {matchup}")
        source_game = team.get("source_game")
        if source_game:
            score = ""
            if source_game.get("away_score") is not None and source_game.get("home_score") is not None:
                score = f", {source_game.get('away_score')}-{source_game.get('home_score')}"
            print(
                "  기준 경기: "
                f"{source_game.get('date')} {source_game.get('away_team')} @ {source_game.get('home_team')}"
                f"{score} {source_game.get('result', '')}".rstrip()
            )
        if team.get("note"):
            print(f"  참고: {team['note']}")
        print_team_summary(team)
        print_starting_pitcher(team.get("starting_pitcher"))
        print_batter_table(team.get("batting_order", []), team.get("opponent"))
        print()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch KBO starting lineups from Naver Sports.")
    parser.add_argument("--date", default=kst_today(), help="Target date in YYYY-MM-DD format. Default: today in KST.")
    parser.add_argument("--no-player-records", action="store_true", help="Do not fetch recent game logs and season records.")
    parser.add_argument(
        "--refresh-history",
        action="store_true",
        help="Refresh cached historical season records. Current-year and recent-10-game records always refresh.",
    )
    parser.add_argument(
        "--history-cache",
        default=str(DEFAULT_HISTORY_CACHE),
        help=f"Historical season cache path. Default: {DEFAULT_HISTORY_CACHE}",
    )
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON instead of text.")
    parser.add_argument("--output", help="Write the full JSON payload to this path.")
    parser.add_argument("--quiet", action="store_true", help="Do not print a report. Useful with --output.")
    parser.add_argument(
        "--team",
        help="Print only the selected team's game, including its opponent. Accepts team name or code, e.g. 한화, LG, HH.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        data = collect_lineups(
            args.date,
            include_player_records=not args.no_player_records,
            refresh_history=args.refresh_history,
            history_cache_path=args.history_cache,
        )
        data = filter_data_for_team(data, args.team)
    except KboLineupError as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 1

    if args.output:
        with open(args.output, "w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=False, indent=2)
            file.write("\n")

    if args.quiet:
        return 0

    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print_text_report(data)

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
