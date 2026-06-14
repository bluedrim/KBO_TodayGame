#!/usr/bin/env python3
"""Small local web app for the KBO lineup analyzer."""

from __future__ import annotations

import argparse
import html
import http.cookiejar
import json
import mimetypes
import re
import socket
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import HTTPCookieProcessor, Request, build_opener

ROOT_DIR = Path(__file__).resolve().parents[1]
STATIC_DIR = Path(__file__).resolve().parent / "static"
sys.path.insert(0, str(ROOT_DIR))

from kbo_lineups import (  # noqa: E402
    DEFAULT_HISTORY_CACHE,
    SOURCE_BASE_URL,
    SOURCE_NAME,
    TEAM_STATS_URL,
    KboLineupError,
    VS_PLAYER_STATS_URL,
    attach_player_vs_opponent_team,
    attach_team_context,
    build_team_lineup,
    collect_lineups,
    enrich_team_with_vs_opponent,
    fetch_games,
    fetch_player_record,
    fetch_preview,
    fetch_team_stats,
    fetch_vs_player_stats,
    filter_data_for_team,
    kst_today,
    load_history_cache,
    normalize_team_key,
    now_kst_iso,
    parse_json_object,
    request_json,
    save_history_cache,
    sorted_team_stats,
)

SCHEDULE_URL = "https://api-gw.sports.naver.com/schedule/games"
GAME_RECORD_URL = "https://api-gw.sports.naver.com/schedule/games/{game_id}/record"
PLAYER_GAME_LOG_URL = "https://api-gw.sports.naver.com/players/kbo/{player_code}/game-log"
PLAYER_STATS_URL = "https://api-gw.sports.naver.com/statistics/categories/kbo/seasons/{season_year}/players"
KBO_HITTER_SITUATION_URL = "https://www.koreabaseball.com/Record/Player/HitterBasic/Situation.aspx"
PLAYER_STATS_PAGE_SIZE = 100
LIVE_STATUS_CODES = {"STARTED", "2"}
RESULT_STATUS_CODES = {"RESULT", "4"}
CANCEL_STATUS_CODES = {"CANCEL", "CANCELED", "CANCELLED"}
TEAM_OVERVIEW_QUERY = "__teams__"
MAX_FETCH_WORKERS = 12
DAILY_STATS_CACHE = ROOT_DIR / ".cache" / "kbo_web_daily_stats.json"
DAILY_STATS_CACHE_SCHEMA_VERSION = 1
KBO_FORM_PREFIX = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$"
KBO_PITCHER_TYPE_SITUATION = "41"
KBO_PITCHER_TYPE_DETAILS = {
    "좌완": "LO",
    "좌투": "LO",
    "우완": "RO",
    "우투": "RO",
    "언더": "LU,RU",
    "언더핸드": "LU,RU",
}
KBO_TEAM_CODE_ALIASES = {
    "lg": "LG",
    "엘지": "LG",
    "kt": "KT",
    "케이티": "KT",
    "ss": "SS",
    "삼성": "SS",
    "ht": "HT",
    "kia": "HT",
    "기아": "HT",
    "hh": "HH",
    "한화": "HH",
    "ob": "OB",
    "두산": "OB",
    "nc": "NC",
    "엔씨": "NC",
    "sk": "SK",
    "ssg": "SK",
    "쓱": "SK",
    "lt": "LT",
    "롯데": "LT",
    "wo": "WO",
    "키움": "WO",
}


@dataclass
class DailyStatsCache:
    path: Path
    target_date: str
    data: dict[str, Any]
    dirty: bool = False
    stats: dict[str, int] = field(default_factory=dict)

    @property
    def day(self) -> dict[str, Any]:
        dates = self.data.setdefault("dates", {})
        day = dates.setdefault(self.target_date, {})
        day.setdefault("player_records", {})
        day.setdefault("vs_player_stats", {})
        day.setdefault("player_game_logs", {})
        day.setdefault("schedule_meta", {})
        day.setdefault("kbo_hitter_situation", {})
        return day


def truthy(value: str | None) -> bool:
    return str(value or "").lower() in {"1", "true", "yes", "on"}


def load_daily_stats_cache(target_date: str, path: str | Path = DAILY_STATS_CACHE) -> DailyStatsCache:
    cache_path = Path(path).expanduser()
    empty = {"schema_version": DAILY_STATS_CACHE_SCHEMA_VERSION, "dates": {}}
    if not cache_path.exists():
        return DailyStatsCache(cache_path, target_date, empty)

    try:
        with open(cache_path, encoding="utf-8") as file:
            data = json.load(file)
    except (OSError, json.JSONDecodeError):
        return DailyStatsCache(cache_path, target_date, empty, dirty=True)

    if not isinstance(data, dict) or data.get("schema_version") != DAILY_STATS_CACHE_SCHEMA_VERSION:
        return DailyStatsCache(cache_path, target_date, empty, dirty=True)
    if not isinstance(data.get("dates"), dict):
        data["dates"] = {}
    cache = DailyStatsCache(cache_path, target_date, data)
    _ = cache.day
    return cache


def save_daily_stats_cache(cache: DailyStatsCache | None) -> None:
    if not cache or not cache.dirty:
        return

    dates = cache.data.get("dates")
    if isinstance(dates, dict) and len(dates) > 14:
        keep_dates = sorted(dates)[-14:]
        cache.data["dates"] = {date: dates[date] for date in keep_dates}
    cache.data["updated_at"] = now_kst_iso()
    cache.path.parent.mkdir(parents=True, exist_ok=True)
    with open(cache.path, "w", encoding="utf-8") as file:
        json.dump(cache.data, file, ensure_ascii=False, indent=2)
        file.write("\n")
    cache.dirty = False


def count_cache_event(cache: DailyStatsCache | None, key: str) -> None:
    if not cache:
        return
    cache.stats[key] = cache.stats.get(key, 0) + 1


def cached_player_record(cache: DailyStatsCache | None, player_code: str) -> dict[str, Any] | None:
    if not cache:
        return None
    record = cache.day.get("player_records", {}).get(player_code)
    if isinstance(record, dict):
        count_cache_event(cache, "player_record_hits")
        return record
    return None


def store_player_record(cache: DailyStatsCache | None, player_code: str, record: dict[str, Any]) -> None:
    if not cache:
        return
    cache.day.setdefault("player_records", {})[player_code] = record
    count_cache_event(cache, "player_record_fetches")
    cache.dirty = True


def vs_cache_key(player_code: str, pitcher_code: str, player_type: str = "hitter") -> str:
    return f"{player_type}:{player_code}:{pitcher_code}"


def cached_vs_player_stats(
    cache: DailyStatsCache | None,
    player_code: str,
    pitcher_code: str,
    player_type: str = "hitter",
) -> dict[str, Any] | None:
    if not cache:
        return None
    record = cache.day.get("vs_player_stats", {}).get(vs_cache_key(player_code, pitcher_code, player_type))
    if isinstance(record, dict):
        count_cache_event(cache, "vs_player_stats_hits")
        return record
    return None


def store_vs_player_stats(
    cache: DailyStatsCache | None,
    player_code: str,
    pitcher_code: str,
    player_type: str,
    record: dict[str, Any],
) -> None:
    if not cache:
        return
    cache.day.setdefault("vs_player_stats", {})[vs_cache_key(player_code, pitcher_code, player_type)] = record
    count_cache_event(cache, "vs_player_stats_fetches")
    cache.dirty = True


def player_game_log_cache_key(player_code: str, player_type: str = "hitter") -> str:
    return f"{player_type}:{player_code}"


def cached_player_game_log(
    cache: DailyStatsCache | None,
    player_code: str,
    player_type: str = "hitter",
) -> dict[str, Any] | None:
    if not cache:
        return None
    record = cache.day.get("player_game_logs", {}).get(player_game_log_cache_key(player_code, player_type))
    if isinstance(record, dict):
        count_cache_event(cache, "player_game_log_hits")
        return record
    return None


def store_player_game_log(
    cache: DailyStatsCache | None,
    player_code: str,
    player_type: str,
    record: dict[str, Any],
) -> None:
    if not cache:
        return
    cache.day.setdefault("player_game_logs", {})[player_game_log_cache_key(player_code, player_type)] = record
    count_cache_event(cache, "player_game_log_fetches")
    cache.dirty = True


def cached_schedule_meta(cache: DailyStatsCache | None, target_date: str) -> dict[str, Any] | None:
    if not cache:
        return None
    record = cache.day.get("schedule_meta", {}).get(target_date)
    if isinstance(record, dict):
        count_cache_event(cache, "schedule_meta_hits")
        return record
    return None


def store_schedule_meta(cache: DailyStatsCache | None, target_date: str, record: dict[str, Any]) -> None:
    if not cache:
        return
    cache.day.setdefault("schedule_meta", {})[target_date] = record
    count_cache_event(cache, "schedule_meta_fetches")
    cache.dirty = True


def kbo_hitter_situation_cache_key(season_year: int | str, team_code: str, detail_code: str) -> str:
    return f"{season_year}:{team_code}:{KBO_PITCHER_TYPE_SITUATION}:{detail_code}"


def cached_kbo_hitter_situation(
    cache: DailyStatsCache | None,
    season_year: int | str,
    team_code: str,
    detail_code: str,
) -> dict[str, Any] | None:
    if not cache:
        return None
    record = cache.day.get("kbo_hitter_situation", {}).get(
        kbo_hitter_situation_cache_key(season_year, team_code, detail_code)
    )
    if isinstance(record, dict):
        count_cache_event(cache, "kbo_hitter_situation_hits")
        return record
    return None


def store_kbo_hitter_situation(
    cache: DailyStatsCache | None,
    season_year: int | str,
    team_code: str,
    detail_code: str,
    record: dict[str, Any],
) -> None:
    if not cache:
        return
    cache.day.setdefault("kbo_hitter_situation", {})[
        kbo_hitter_situation_cache_key(season_year, team_code, detail_code)
    ] = record
    count_cache_event(cache, "kbo_hitter_situation_fetches")
    cache.dirty = True


def cache_status(
    cache: DailyStatsCache | None,
    include_records: bool,
    refresh_history: bool,
    refresh_daily_stats: bool,
) -> dict[str, Any]:
    if not include_records:
        return {
            "enabled": False,
            "message": "기본 정보 먼저 표시 중",
        }
    if not cache:
        return {
            "enabled": False,
            "message": "성적 캐시 없음",
        }

    day = cache.day
    player_records = day.get("player_records") if isinstance(day.get("player_records"), dict) else {}
    vs_records = day.get("vs_player_stats") if isinstance(day.get("vs_player_stats"), dict) else {}
    game_logs = day.get("player_game_logs") if isinstance(day.get("player_game_logs"), dict) else {}
    schedule_meta = day.get("schedule_meta") if isinstance(day.get("schedule_meta"), dict) else {}
    kbo_situation = day.get("kbo_hitter_situation") if isinstance(day.get("kbo_hitter_situation"), dict) else {}
    stats = {
        "player_record_hits": cache.stats.get("player_record_hits", 0),
        "player_record_fetches": cache.stats.get("player_record_fetches", 0),
        "vs_player_stats_hits": cache.stats.get("vs_player_stats_hits", 0),
        "vs_player_stats_fetches": cache.stats.get("vs_player_stats_fetches", 0),
        "player_game_log_hits": cache.stats.get("player_game_log_hits", 0),
        "player_game_log_fetches": cache.stats.get("player_game_log_fetches", 0),
        "schedule_meta_hits": cache.stats.get("schedule_meta_hits", 0),
        "schedule_meta_fetches": cache.stats.get("schedule_meta_fetches", 0),
        "kbo_hitter_situation_hits": cache.stats.get("kbo_hitter_situation_hits", 0),
        "kbo_hitter_situation_fetches": cache.stats.get("kbo_hitter_situation_fetches", 0),
    }
    fetched = (
        stats["player_record_fetches"]
        + stats["vs_player_stats_fetches"]
        + stats["player_game_log_fetches"]
        + stats["schedule_meta_fetches"]
        + stats["kbo_hitter_situation_fetches"]
    )
    hits = (
        stats["player_record_hits"]
        + stats["vs_player_stats_hits"]
        + stats["player_game_log_hits"]
        + stats["schedule_meta_hits"]
        + stats["kbo_hitter_situation_hits"]
    )
    if refresh_history:
        message = "3년 기록 갱신으로 성적을 새로 조회했습니다"
    elif refresh_daily_stats:
        message = f"오늘 성적 강제 갱신으로 {fetched}건 새로 조회"
    elif fetched and hits:
        message = f"캐시 {hits}건 사용, 변경/신규 {fetched}건 조회"
    elif fetched:
        message = f"변경/신규 성적 {fetched}건 조회"
    elif hits:
        message = f"오늘 저장된 성적 {hits}건 재사용"
    else:
        message = "성적 캐시 대기 중"

    return {
        "enabled": True,
        "target_date": cache.target_date,
        "refresh_history": refresh_history,
        "stored_player_records": len(player_records),
        "stored_vs_player_stats": len(vs_records),
        "stored_player_game_logs": len(game_logs),
        "stored_schedule_meta": len(schedule_meta),
        "stored_kbo_hitter_situation": len(kbo_situation),
        "stats": stats,
        "message": message,
    }


def fetch_schedule_meta(target_date: str) -> dict[str, dict[str, Any]]:
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

    games: dict[str, dict[str, Any]] = {}
    for raw in data.get("result", {}).get("games", []):
        if not isinstance(raw, dict) or raw.get("categoryId") != "kbo":
            continue
        game_id = str(raw.get("gameId") or "")
        if game_id:
            games[game_id] = raw
    return games


def fetch_schedule_meta_cached(
    target_date: str,
    cache: DailyStatsCache | None,
    use_daily_cache: bool = True,
) -> dict[str, dict[str, Any]]:
    # Today's schedule carries live inning/score/pitcher state, so stale daily
    # cache must not overwrite fresh game status during the full records pass.
    if use_daily_cache and target_date < kst_today():
        cached = cached_schedule_meta(cache, target_date)
        if cached is not None:
            return {str(key): value for key, value in cached.items() if isinstance(value, dict)}

    schedule = fetch_schedule_meta(target_date)
    store_schedule_meta(cache, target_date, schedule)
    return schedule


def fetch_player_game_log(
    player_code: str,
    player_type: str = "hitter",
    season_start: str | None = None,
    max_pages: int = 20,
) -> dict[str, Any]:
    games: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    before = ""

    for _ in range(max_pages):
        params: dict[str, Any] = {"playerType": player_type}
        if before:
            params["before"] = before
            if season_start:
                params["seasonStart"] = season_start
        data = request_json(PLAYER_GAME_LOG_URL.format(player_code=player_code), params)
        result = data.get("result")
        if not isinstance(result, dict):
            raise KboLineupError(f"No game log for player {player_code}")
        page_games = result.get("games")
        if not isinstance(page_games, list) or not page_games:
            break

        for raw in page_games:
            if not isinstance(raw, dict):
                continue
            game_id = str(raw.get("gameId") or "")
            dedupe_key = game_id or f"{raw.get('gday')}:{raw.get('opponent')}:{len(games)}"
            if dedupe_key in seen_ids:
                continue
            seen_ids.add(dedupe_key)
            games.append(raw)

        if not result.get("hasMore"):
            break
        next_before = str(page_games[-1].get("gday") or "")
        if not next_before or next_before == before:
            break
        before = next_before

    return {
        "player_code": player_code,
        "player_type": player_type,
        "games": games,
        "updated_at": now_kst_iso(),
        "source_url": PLAYER_GAME_LOG_URL.format(player_code=player_code),
    }


def html_value(page: str, name: str) -> str:
    pattern = r'(?:name|id)="{}"[^>]*value="([^"]*)"'.format(re.escape(name))
    match = re.search(pattern, page)
    return html.unescape(match.group(1)) if match else ""


def strip_html_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<.*?>", "", value))).strip()


def kbo_team_code_for_team(team: dict[str, Any]) -> str:
    values = [
        team.get("team_code"),
        team.get("team_name"),
        (team.get("team_season") or {}).get("teamId") if isinstance(team.get("team_season"), dict) else None,
        (team.get("team_season") or {}).get("teamName") if isinstance(team.get("team_season"), dict) else None,
        (team.get("team_season") or {}).get("teamShortName") if isinstance(team.get("team_season"), dict) else None,
    ]
    for value in values:
        key = normalize_team_key(value)
        if key in KBO_TEAM_CODE_ALIASES:
            return KBO_TEAM_CODE_ALIASES[key]
        upper = str(value or "").strip().upper()
        if upper in set(KBO_TEAM_CODE_ALIASES.values()):
            return upper
    return ""


def pitcher_throw_type_from_text(value: Any) -> str:
    text = normalize_team_key(value)
    if not text:
        return ""
    if any(token in text for token in ("언", "언더", "사이드", "side", "submarine")):
        return "언더"
    if "좌" in text or "left" in text:
        return "좌완"
    if "우" in text or "right" in text:
        return "우완"
    return ""


def kbo_pitcher_type_detail_code(label: str) -> str:
    return KBO_PITCHER_TYPE_DETAILS.get(label, "")


def kbo_form_values(page: str) -> dict[str, str]:
    return {
        "__VIEWSTATE": html_value(page, "__VIEWSTATE"),
        "__VIEWSTATEGENERATOR": html_value(page, "__VIEWSTATEGENERATOR"),
        "__EVENTVALIDATION": html_value(page, "__EVENTVALIDATION"),
    }


def post_kbo_hitter_situation(
    opener: Any,
    page: str,
    event_name: str,
    season_year: int | str,
    team_code: str,
    situation_code: str,
    detail_code: str,
) -> str:
    fields = {
        "__EVENTTARGET": f"{KBO_FORM_PREFIX}{event_name}",
        "__EVENTARGUMENT": "",
        "__LASTFOCUS": "",
        **kbo_form_values(page),
        f"{KBO_FORM_PREFIX}ddlSeason$ddlSeason": str(season_year),
        f"{KBO_FORM_PREFIX}ddlSeries$ddlSeries": "0",
        f"{KBO_FORM_PREFIX}ddlTeam$ddlTeam": team_code,
        f"{KBO_FORM_PREFIX}ddlPos$ddlPos": "",
        f"{KBO_FORM_PREFIX}ddlSituation$ddlSituation": situation_code,
        f"{KBO_FORM_PREFIX}ddlSituationDetail$ddlSituationDetail": detail_code,
        f"{KBO_FORM_PREFIX}hfPage": "1",
        f"{KBO_FORM_PREFIX}hfOrderByCol": "HRA_RT",
        f"{KBO_FORM_PREFIX}hfOrderBy": "DESC",
    }
    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": KBO_HITTER_SITUATION_URL,
        "User-Agent": "Mozilla/5.0 (compatible; KBO-Lineup-Fetcher/1.0)",
    }
    request = Request(KBO_HITTER_SITUATION_URL, data=urlencode(fields).encode(), headers=headers)
    with opener.open(request, timeout=15) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, "replace")


def parse_kbo_rate(value: Any) -> float | None:
    text = str(value or "").strip()
    if not text or text == "-":
        return None
    try:
        return round(float(text), 3)
    except ValueError:
        return None


def parse_kbo_int(value: Any) -> int:
    try:
        return int(float(str(value or "0").replace(",", "")))
    except ValueError:
        return 0


def kbo_ops_from_basic_stats(row: dict[str, Any]) -> float | None:
    ab = parse_kbo_int(row.get("ab"))
    hit = parse_kbo_int(row.get("hit"))
    doubles = parse_kbo_int(row.get("h2"))
    triples = parse_kbo_int(row.get("h3"))
    homers = parse_kbo_int(row.get("hr"))
    walks = parse_kbo_int(row.get("bb"))
    hbp = parse_kbo_int(row.get("hbp"))
    if not ab:
        return None
    total_bases = hit + doubles + (2 * triples) + (3 * homers)
    obp_denom = ab + walks + hbp
    obp = (hit + walks + hbp) / obp_denom if obp_denom else None
    slg = total_bases / ab
    return round(obp + slg, 3) if obp is not None else None


def parse_kbo_hitter_situation_rows(page: str) -> dict[str, Any]:
    players_by_code: dict[str, dict[str, Any]] = {}
    players_by_name: dict[str, dict[str, Any]] = {}
    for table_row in re.findall(r"<tr[^>]*>[\s\S]*?</tr>", page):
        if "/Record/Player/HitterDetail/Basic.aspx?playerId=" not in table_row:
            continue
        cells = [
            strip_html_text(cell)
            for cell in re.findall(r"<td[^>]*>([\s\S]*?)</td>", table_row)
        ]
        if len(cells) < 14:
            continue
        player_id_match = re.search(r"playerId=(\d+)", table_row)
        name_match = re.search(r"playerId=\d+[^>]*>([^<]+)</a>", table_row)
        player_code = player_id_match.group(1) if player_id_match else ""
        name = html.unescape(name_match.group(1)).strip() if name_match else cells[1]
        stats = {
            "player_code": player_code,
            "name": name,
            "team": cells[2],
            "avg": parse_kbo_rate(cells[3]),
            "ab": parse_kbo_int(cells[4]),
            "hit": parse_kbo_int(cells[5]),
            "h2": parse_kbo_int(cells[6]),
            "h3": parse_kbo_int(cells[7]),
            "hr": parse_kbo_int(cells[8]),
            "rbi": parse_kbo_int(cells[9]),
            "bb": parse_kbo_int(cells[10]),
            "hbp": parse_kbo_int(cells[11]),
            "so": parse_kbo_int(cells[12]),
            "gdp": parse_kbo_int(cells[13]),
        }
        stats["ops"] = kbo_ops_from_basic_stats(stats)
        stats["games"] = stats["ab"]
        if player_code:
            players_by_code[player_code] = stats
        players_by_name[normalize_team_key(name)] = stats

    return {
        "players_by_code": players_by_code,
        "players_by_name": players_by_name,
    }


def fetch_kbo_hitter_situation(
    season_year: int | str,
    team_code: str,
    detail_code: str,
) -> dict[str, Any]:
    jar = http.cookiejar.CookieJar()
    opener = build_opener(HTTPCookieProcessor(jar))
    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        "Referer": "https://www.koreabaseball.com/",
        "User-Agent": "Mozilla/5.0 (compatible; KBO-Lineup-Fetcher/1.0)",
    }
    try:
        with opener.open(Request(KBO_HITTER_SITUATION_URL, headers=headers), timeout=15) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            page = response.read().decode(charset, "replace")
        page = post_kbo_hitter_situation(
            opener,
            page,
            "ddlSituation$ddlSituation",
            season_year,
            team_code,
            KBO_PITCHER_TYPE_SITUATION,
            "",
        )
        page = post_kbo_hitter_situation(
            opener,
            page,
            "ddlSituationDetail$ddlSituationDetail",
            season_year,
            team_code,
            KBO_PITCHER_TYPE_SITUATION,
            detail_code,
        )
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise KboLineupError(f"KBO 투수유형별 타자 기록 조회 실패: {exc}") from exc

    parsed = parse_kbo_hitter_situation_rows(page)
    return {
        **parsed,
        "season_year": str(season_year),
        "team_code": team_code,
        "situation_code": KBO_PITCHER_TYPE_SITUATION,
        "detail_code": detail_code,
        "source_name": "KBO 공식 기록실",
        "source_url": KBO_HITTER_SITUATION_URL,
        "updated_at": now_kst_iso(),
    }


def lookup_kbo_hitter_situation_stats(
    record: dict[str, Any] | None,
    batter: dict[str, Any],
) -> dict[str, Any] | None:
    if not isinstance(record, dict) or record.get("error"):
        return None
    player_code = str(batter.get("player_code") or "")
    by_code = record.get("players_by_code") if isinstance(record.get("players_by_code"), dict) else {}
    if player_code and isinstance(by_code.get(player_code), dict):
        return by_code[player_code]

    by_name = record.get("players_by_name") if isinstance(record.get("players_by_name"), dict) else {}
    name_key = normalize_team_key(batter.get("name"))
    stats = by_name.get(name_key)
    return stats if isinstance(stats, dict) else None


def fetch_game_record(game_id: str) -> dict[str, Any]:
    data = request_json(GAME_RECORD_URL.format(game_id=game_id))
    result = data.get("result")
    if not isinstance(result, dict):
        raise KboLineupError(f"No record data for game {game_id}")
    return result


def game_matches_query(game: Any, query: str | None) -> bool:
    query_key = normalize_team_key(query)
    if not query_key:
        return False
    values = [
        game.home_code,
        game.home_name,
        game.away_code,
        game.away_name,
    ]
    keys = {normalize_team_key(value) for value in values if normalize_team_key(value)}
    return query_key in keys or any(query_key in key for key in keys)


def first_present(data: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    return None


def team_stat_match_keys(stats: dict[str, Any]) -> set[str]:
    values = [
        stats.get("teamId"),
        stats.get("teamName"),
        stats.get("teamShortName"),
    ]
    return {normalize_team_key(value) for value in values if normalize_team_key(value)}


def find_team_stats(team_stats_by_code: dict[str, dict[str, Any]], team_query: str | None) -> dict[str, Any]:
    query_key = normalize_team_key(team_query)
    if not query_key:
        raise KboLineupError("팀을 선택해야 합니다")

    for stats in team_stats_by_code.values():
        keys = team_stat_match_keys(stats)
        if query_key in keys:
            return stats

    for stats in team_stats_by_code.values():
        keys = team_stat_match_keys(stats)
        if any(query_key in key or key in query_key for key in keys):
            return stats

    raise KboLineupError(f"팀 정보를 찾지 못했습니다: {team_query}")


def fetch_team_player_stats(
    season_year: int | str,
    team_code: str,
    player_type: str,
    page_size: int = PLAYER_STATS_PAGE_SIZE,
    sort_field: str | None = None,
    sort_direction: str | None = None,
) -> list[dict[str, Any]]:
    player_type = player_type.upper()
    if player_type not in {"HITTER", "PITCHER"}:
        raise KboLineupError(f"Unknown playerType: {player_type}")

    params = {
        "playerType": player_type,
        "page": "1",
        "pageSize": str(page_size),
        "sortField": sort_field or ("hitterAb" if player_type == "HITTER" else "pitcherInning"),
        "sortDirection": sort_direction or "desc",
        "playerYn": "Y",
    }
    if team_code:
        params["teamCode"] = team_code
    data = request_json(PLAYER_STATS_URL.format(season_year=season_year), params)
    stats = data.get("result", {}).get("seasonPlayerStats")
    if not isinstance(stats, list):
        raise KboLineupError(f"No {player_type.lower()} stats for {team_code} in {season_year}")
    return [item for item in stats if isinstance(item, dict)]


def fetch_league_player_leaders(season_year: int | str) -> dict[str, list[dict[str, Any]]]:
    with ThreadPoolExecutor(max_workers=2) as executor:
        hitter_future = executor.submit(
            fetch_team_player_stats,
            season_year,
            "",
            "HITTER",
            30,
            "hitterHra",
            "desc",
        )
        pitcher_future = executor.submit(
            fetch_team_player_stats,
            season_year,
            "",
            "PITCHER",
            30,
            "pitcherEra",
            "asc",
        )
        hitter_rows = hitter_future.result()
        pitcher_rows = pitcher_future.result()

    return {
        "hitters": [compact_roster_hitter(raw, index + 1, int(season_year)) for index, raw in enumerate(hitter_rows[:30])],
        "pitchers": [compact_roster_pitcher(raw, index + 1, int(season_year)) for index, raw in enumerate(pitcher_rows[:30])],
    }


def fetch_league_category_leaders(season_year: int | str) -> dict[str, list[dict[str, Any]]]:
    hitter_categories = [
        ("avg", "타율", "hitterHra", "desc"),
        ("hr", "홈런", "hitterHr", "desc"),
        ("rbi", "타점", "hitterRbi", "desc"),
        ("ops", "OPS", "hitterOps", "desc"),
        ("sb", "도루", "hitterSb", "desc"),
        ("war", "WAR", "hitterWar", "desc"),
    ]
    pitcher_categories = [
        ("win", "승리", "pitcherWin", "desc"),
        ("era", "ERA", "pitcherEra", "asc"),
        ("kk", "탈삼진", "pitcherKk", "desc"),
        ("save", "세이브", "pitcherSave", "desc"),
        ("hold", "홀드", "pitcherHold", "desc"),
        ("whip", "WHIP", "pitcherWhip", "asc"),
    ]

    results: dict[str, list[dict[str, Any]]] = {"hitters": [], "pitchers": []}
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {}
        for key, label, sort_field, direction in hitter_categories:
            future = executor.submit(fetch_team_player_stats, season_year, "", "HITTER", 5, sort_field, direction)
            futures[future] = ("hitters", key, label)
        for key, label, sort_field, direction in pitcher_categories:
            future = executor.submit(fetch_team_player_stats, season_year, "", "PITCHER", 5, sort_field, direction)
            futures[future] = ("pitchers", key, label)

        for future in as_completed(futures):
            group, key, label = futures[future]
            rows = future.result()
            compact = compact_roster_hitter if group == "hitters" else compact_roster_pitcher
            results[group].append(
                {
                    "key": key,
                    "label": label,
                    "players": [compact(raw, index + 1, int(season_year)) for index, raw in enumerate(rows[:5])],
                }
            )

    sort_order = {
        "hitters": [key for key, *_ in hitter_categories],
        "pitchers": [key for key, *_ in pitcher_categories],
    }
    for group, keys in sort_order.items():
        order = {key: index for index, key in enumerate(keys)}
        results[group].sort(key=lambda item: order.get(str(item.get("key")), 99))
    return results


def roster_profile(raw: dict[str, Any]) -> dict[str, Any]:
    return parse_json_object(raw.get("profile"))


def compact_roster_player_base(raw: dict[str, Any]) -> dict[str, Any]:
    profile = roster_profile(raw)
    player = {
        "name": first_present(raw, "playerName", "name"),
        "player_code": str(first_present(raw, "playerId", "playerCode", "pCode", "pcode") or ""),
        "position": first_present(raw, "positionName", "position", "pos") or profile.get("position") or "",
        "bats_throws": first_present(raw, "batsThrows", "hitType") or profile.get("hitType") or "",
        "back_number": first_present(raw, "backNumber", "backnum") or profile.get("backNumber") or "",
        "team_code": first_present(raw, "teamId", "teamCode"),
        "team_name": first_present(raw, "teamName", "teamShortName"),
    }
    return {key: value for key, value in player.items() if value not in ("", None)}


def compact_roster_hitter(raw: dict[str, Any], order: int, season_year: int) -> dict[str, Any]:
    player = compact_roster_player_base(raw)
    player.update(
        {
            "player_role": "hitter",
            "bat_order": order,
            "season_stats": {
                "season_year": season_year,
                "games": first_present(raw, "hitterGameCount", "gameCount"),
                "avg": first_present(raw, "hitterHra", "hra"),
                "ab": first_present(raw, "hitterAb", "ab"),
                "hit": first_present(raw, "hitterHit", "hit"),
                "h2": first_present(raw, "hitterH2", "h2"),
                "h3": first_present(raw, "hitterH3", "h3"),
                "hr": first_present(raw, "hitterHr", "hr"),
                "rbi": first_present(raw, "hitterRbi", "rbi"),
                "run": first_present(raw, "hitterRun", "run"),
                "bb": first_present(raw, "hitterBb", "bb"),
                "sb": first_present(raw, "hitterSb", "sb"),
                "obp": first_present(raw, "hitterObp", "obp"),
                "slg": first_present(raw, "hitterSlg", "slg"),
                "ops": first_present(raw, "hitterOps", "ops"),
                "war": first_present(raw, "hitterWar", "war"),
            },
        }
    )
    return player


def compact_roster_pitcher(raw: dict[str, Any], order: int, season_year: int) -> dict[str, Any]:
    player = compact_roster_player_base(raw)
    player.update(
        {
            "player_role": "pitcher",
            "bat_order": order,
            "position": player.get("position") or "투수",
            "season_stats": {
                "season_year": season_year,
                "games": first_present(raw, "pitcherGameCount", "gameCount"),
                "innings": first_present(raw, "pitcherInning", "inning", "inn"),
                "era": first_present(raw, "pitcherEra", "era"),
                "win": first_present(raw, "pitcherWin", "w", "win"),
                "lose": first_present(raw, "pitcherLose", "l", "lose"),
                "save": first_present(raw, "pitcherSave", "sv", "save"),
                "hold": first_present(raw, "pitcherHold", "hold"),
                "hit": first_present(raw, "pitcherHit", "hit"),
                "hr": first_present(raw, "pitcherHr", "hr"),
                "run": first_present(raw, "pitcherR", "r", "run"),
                "er": first_present(raw, "pitcherEr", "er"),
                "bb": first_present(raw, "pitcherBb", "bb"),
                "kk": first_present(raw, "pitcherKk", "kk"),
                "whip": first_present(raw, "pitcherWhip", "whip"),
                "war": first_present(raw, "pitcherWar", "war"),
            },
        }
    )
    return player


def collect_team_roster(
    target_date: str,
    team_query: str | None,
    include_player_records: bool,
    refresh_history: bool,
    use_daily_cache: bool,
    daily_cache: DailyStatsCache | None,
    history_cache_path: str | Path = DEFAULT_HISTORY_CACHE,
) -> dict[str, Any]:
    season_year = int(target_date[:4])
    team_stats_by_code = fetch_team_stats(season_year)
    selected_stats = find_team_stats(team_stats_by_code, team_query)
    team_code = str(selected_stats.get("teamId") or team_query or "")
    team_name = selected_stats.get("teamName") or selected_stats.get("teamShortName") or team_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        hitter_future = executor.submit(fetch_team_player_stats, season_year, team_code, "HITTER")
        pitcher_future = executor.submit(fetch_team_player_stats, season_year, team_code, "PITCHER")
        hitter_rows = hitter_future.result()
        pitcher_rows = pitcher_future.result()

    hitters = [compact_roster_hitter(raw, index + 1, season_year) for index, raw in enumerate(hitter_rows)]
    pitchers = [compact_roster_pitcher(raw, index + 1, season_year) for index, raw in enumerate(pitcher_rows)]

    team = {
        "team_code": team_code,
        "team_name": team_name,
        "status": "팀 전체",
        "basis": f"{season_year} 시즌 선수단",
        "note": "선택 팀 전체 선수 성적입니다.",
        "team_season": selected_stats,
        "batting_order": hitters,
        "pitching_staff": pitchers,
        "roster_mode": True,
        "roster_counts": {
            "hitters": len(hitters),
            "pitchers": len(pitchers),
        },
    }

    history_cache = load_history_cache(history_cache_path) if include_player_records else None
    record_cache: dict[str, dict[str, Any]] = {}
    if include_player_records:
        enrich_teams_with_records_parallel([team], record_cache, history_cache, refresh_history, use_daily_cache, daily_cache)
    if history_cache:
        save_history_cache(history_cache)

    return {
        "target_date": target_date,
        "generated_at": now_kst_iso(),
        "source": {
            "name": SOURCE_NAME,
            "url": SOURCE_BASE_URL,
        },
        "season_year": season_year,
        "view_mode": "team_roster",
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
        "games": [],
        "teams": [team],
        "selected_team": {
            "query": team_query,
            "team_name": team_name,
            "team_code": team_code,
            "mode": "team_roster",
        },
    }


def collect_team_overview(target_date: str) -> dict[str, Any]:
    season_year = int(target_date[:4])
    team_stats_by_code = fetch_team_stats(season_year)
    with ThreadPoolExecutor(max_workers=2) as executor:
        player_leaders_future = executor.submit(fetch_league_player_leaders, season_year)
        category_leaders_future = executor.submit(fetch_league_category_leaders, season_year)
        league_player_leaders = player_leaders_future.result()
        league_category_leaders = category_leaders_future.result()
    return {
        "target_date": target_date,
        "generated_at": now_kst_iso(),
        "source": {
            "name": SOURCE_NAME,
            "url": SOURCE_BASE_URL,
        },
        "season_year": season_year,
        "view_mode": "team_overview",
        "league_team_stats": {
            "source_url": TEAM_STATS_URL.format(season_year=season_year),
            "teams": sorted_team_stats(team_stats_by_code),
        },
        "player_records_included": False,
        "history_cache": {
            "enabled": False,
            "path": None,
            "refresh_requested": False,
        },
        "games": [],
        "teams": [],
        "league_player_leaders": league_player_leaders,
        "league_category_leaders": league_category_leaders,
    }


def is_cancelled_game_ref(game: Any) -> bool:
    status = str(getattr(game, "status", "") or "")
    status_code = str(getattr(game, "status_code", "") or "").upper()
    return bool(
        getattr(game, "canceled", False)
        or "취소" in status
        or status_code in {"CANCEL", "CANCELED", "CANCELLED"}
    )


def game_summary(game: Any) -> dict[str, Any]:
    canceled = is_cancelled_game_ref(game)
    return {
        "game_id": game.game_id,
        "date": game.date,
        "time": game.time,
        "stadium": game.stadium,
        "status": "취소" if canceled else game.status,
        "status_code": getattr(game, "status_code", "") or "",
        "canceled": canceled,
        "suspended": bool(getattr(game, "suspended", False)),
        "away_code": game.away_code,
        "home_code": game.home_code,
        "away_team": game.away_name,
        "home_team": game.home_name,
    }


def collect_selected_game_lineups(
    target_date: str,
    team_query: str | None,
    game_id: str | None,
    include_player_records: bool,
    refresh_history: bool,
    use_daily_cache: bool,
    daily_cache: DailyStatsCache | None,
    history_cache_path: str | Path = DEFAULT_HISTORY_CACHE,
) -> dict[str, Any]:
    games = fetch_games(target_date)
    if game_id:
        selected_games = [game for game in games if str(game.game_id) == str(game_id)]
        if not selected_games:
            raise KboLineupError(f"선택한 경기를 찾지 못했습니다: {game_id}")
    else:
        selected_games = [game for game in games if not team_query or game_matches_query(game, team_query)]

    if team_query and not game_id and not selected_games:
        data = collect_lineups(
            target_date,
            include_player_records=False,
            refresh_history=False,
            history_cache_path=history_cache_path,
        )
        return filter_data_for_team(data, team_query)

    season_year = int(target_date[:4])
    team_stats_by_code = fetch_team_stats(season_year)
    game_pairs = []
    teams = []
    game_results = []
    for game in selected_games:
        summary = game_summary(game)
        try:
            preview = fetch_preview(game.game_id)
        except KboLineupError:
            if summary["canceled"]:
                game_results.append(summary)
                continue
            raise

        away = build_team_lineup(preview, game, "away")
        home = build_team_lineup(preview, game, "home")
        away["game_id"] = game.game_id
        away["side"] = "away"
        home["game_id"] = game.game_id
        home["side"] = "home"
        if summary["canceled"]:
            away["status"] = "취소"
            away["note"] = "경기 취소"
            home["status"] = "취소"
            home["note"] = "경기 취소"

        season_vs_result = preview.get("seasonVsResult")
        season_vs_result = season_vs_result if isinstance(season_vs_result, dict) else None
        attach_team_context(away, home, team_stats_by_code, season_vs_result, "away")
        attach_team_context(home, away, team_stats_by_code, season_vs_result, "home")
        game_pairs.append((away, home))
        teams.extend([away, home])
        game_results.append(summary)

    history_cache = load_history_cache(history_cache_path) if include_player_records else None
    record_cache: dict[str, dict[str, Any]] = {}
    vs_cache: dict[tuple[str, str], dict[str, Any]] = {}
    if include_player_records:
        enrich_teams_with_records_parallel(teams, record_cache, history_cache, refresh_history, use_daily_cache, daily_cache)
        for away, home in game_pairs:
            enrich_team_with_vs_opponent(away, home)
            enrich_team_with_vs_opponent(home, away)
            attach_batter_vs_pitcher(away, home.get("starting_pitcher"), vs_cache, "starter", use_daily_cache, daily_cache)
            attach_batter_vs_pitcher(home, away.get("starting_pitcher"), vs_cache, "starter", use_daily_cache, daily_cache)
    if history_cache:
        save_history_cache(history_cache)

    data = {
        "target_date": target_date,
        "generated_at": now_kst_iso(),
        "source": {
            "name": SOURCE_NAME,
            "url": SOURCE_BASE_URL,
        },
        "season_year": season_year,
        "view_mode": "game_lineups",
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
    if game_id:
        data["selected_game"] = {
            "game_id": str(game_id),
            "mode": "game_lineups",
        }
        return data
    return filter_data_for_team(data, team_query) if team_query else data


def collect_games_for_date(target_date: str) -> dict[str, Any]:
    games = fetch_games(target_date)
    return {
        "target_date": target_date,
        "generated_at": now_kst_iso(),
        "games": [game_summary(game) for game in games],
    }


def team_players(team: dict[str, Any]) -> list[dict[str, Any]]:
    players = []
    pitcher = team.get("starting_pitcher")
    if isinstance(pitcher, dict):
        players.append(pitcher)
    players.extend(player for player in team.get("batting_order", []) if isinstance(player, dict))
    players.extend(player for player in team.get("pitching_staff", []) if isinstance(player, dict))
    return players


def enrich_teams_with_records_parallel(
    teams: list[dict[str, Any]],
    record_cache: dict[str, dict[str, Any]],
    history_cache: Any,
    refresh_history: bool,
    use_daily_cache: bool,
    daily_cache: DailyStatsCache | None,
) -> None:
    players_by_code: dict[str, list[dict[str, Any]]] = {}
    for team in teams:
        for player in team_players(team):
            player_code = str(player.get("player_code") or "")
            if not player_code:
                player["records"] = {"error": "player_code 없음"}
                continue
            players_by_code.setdefault(player_code, []).append(player)

    for code in players_by_code:
        if code not in record_cache and use_daily_cache:
            cached = cached_player_record(daily_cache, code)
            if cached:
                record_cache[code] = cached

    missing_codes = [code for code in players_by_code if code not in record_cache]
    if missing_codes:
        worker_count = min(MAX_FETCH_WORKERS, len(missing_codes))
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = {
                executor.submit(
                    fetch_player_record,
                    code,
                    history_cache=history_cache,
                    refresh_history=refresh_history,
                    player_name=str(players_by_code[code][0].get("name") or ""),
                ): code
                for code in missing_codes
            }
            for future in as_completed(futures):
                code = futures[future]
                try:
                    record_cache[code] = future.result()
                except KboLineupError as exc:
                    record_cache[code] = {"error": str(exc)}
                store_player_record(daily_cache, code, record_cache[code])

    for code, players in players_by_code.items():
        for player in players:
            player["records"] = record_cache.get(code, {"error": "기록 없음"})


def is_live_game(meta: dict[str, Any] | None) -> bool:
    if not meta:
        return False
    return str(meta.get("statusCode") or "").upper() in LIVE_STATUS_CODES or str(meta.get("statusNum") or "") == "2"


def is_result_game(meta: dict[str, Any] | None) -> bool:
    if not meta:
        return False
    return str(meta.get("statusCode") or "").upper() in RESULT_STATUS_CODES or str(meta.get("statusNum") or "") == "4"


def is_cancelled_meta(meta: dict[str, Any] | None) -> bool:
    if not meta:
        return False
    status_info = str(meta.get("statusInfo") or "")
    status_code = str(meta.get("statusCode") or "").upper()
    return bool(meta.get("cancel") or "취소" in status_info or status_code in CANCEL_STATUS_CODES)


def is_cancelled_game(game: dict[str, Any] | None, meta: dict[str, Any] | None = None) -> bool:
    if not isinstance(game, dict):
        return is_cancelled_meta(meta)
    status = str(game.get("status") or "")
    status_code = str(game.get("status_code") or "").upper()
    return bool(game.get("canceled") or "취소" in status or status_code in CANCEL_STATUS_CODES or is_cancelled_meta(meta))


def should_show_scoreboard(target_date: str, meta: dict[str, Any] | None) -> bool:
    if is_cancelled_meta(meta):
        return False
    if is_live_game(meta) or is_result_game(meta):
        return True
    return target_date < kst_today()


def pitcher_from_record_side(
    record: dict[str, Any] | None,
    side: str,
    fallback_name: str | None = None,
) -> dict[str, Any] | None:
    if not record:
        return None

    boxscore = record.get("recordData", {}).get("pitchersBoxscore", {})
    pitchers = boxscore.get(side) if isinstance(boxscore, dict) else None
    if not isinstance(pitchers, list) or not pitchers:
        return None

    selected = None
    if fallback_name:
        selected = next((item for item in reversed(pitchers) if item.get("name") == fallback_name), None)
    if selected is None:
        selected = pitchers[-1]
    if not isinstance(selected, dict):
        return None

    return {
        "name": selected.get("name") or fallback_name or "",
        "player_code": str(selected.get("pcode") or ""),
        "position": "투수",
        "bats_throws": selected.get("hitType") or "",
        "today": compact_pitcher_today(selected),
    }


def pitchers_from_record_side(record: dict[str, Any] | None, side: str) -> list[dict[str, Any]]:
    if not record:
        return []

    boxscore = record.get("recordData", {}).get("pitchersBoxscore", {})
    pitchers = boxscore.get(side) if isinstance(boxscore, dict) else None
    if not isinstance(pitchers, list):
        return []

    results: list[dict[str, Any]] = []
    for raw in pitchers:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if not name:
            continue
        results.append(
            {
                "name": name,
                "player_code": str(raw.get("pcode") or ""),
                "position": "투수",
                "bats_throws": raw.get("hitType") or "",
                "today": compact_pitcher_today(raw),
            }
        )
    return results


def numeric_value(value: Any, fallback: float = 0.0) -> float:
    if value in (None, "", "-"):
        return fallback
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def first_value(data: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    return None


def compact_batter_today(raw: dict[str, Any]) -> dict[str, Any]:
    today = {
        "pa": first_value(raw, "pa", "tpa", "turnAtBat"),
        "ab": first_value(raw, "ab", "atBat"),
        "run": first_value(raw, "run", "r"),
        "hit": first_value(raw, "hit", "h"),
        "h2": first_value(raw, "h2", "double"),
        "h3": first_value(raw, "h3", "triple"),
        "hr": first_value(raw, "hr", "homeRun"),
        "rbi": first_value(raw, "rbi"),
        "bb": first_value(raw, "bb", "baseOnBalls"),
        "kk": first_value(raw, "kk", "so", "strikeOut"),
        "sb": first_value(raw, "sb", "steal"),
        "wpa": first_value(raw, "wpa"),
    }
    hit = numeric_value(today.get("hit"))
    run = numeric_value(today.get("run"))
    rbi = numeric_value(today.get("rbi"))
    hr = numeric_value(today.get("hr"))
    bb = numeric_value(today.get("bb"))
    sb = numeric_value(today.get("sb"))
    kk = numeric_value(today.get("kk"))
    wpa = first_value(raw, "wpa")
    if wpa not in (None, "", "-"):
        today["impact"] = numeric_value(wpa)
        today["impact_source"] = "wpa"
    else:
        today["impact"] = round(hit + run + (rbi * 1.4) + (hr * 2.0) + (bb * 0.4) + (sb * 0.6) - (kk * 0.25), 2)
        today["impact_source"] = "simple"
    return {key: value for key, value in today.items() if value not in (None, "")}


def compact_pitcher_today(raw: dict[str, Any]) -> dict[str, Any]:
    today = {
        "inn": first_value(raw, "inn", "inning"),
        "hit": first_value(raw, "hit", "h"),
        "run": first_value(raw, "r", "run"),
        "er": first_value(raw, "er"),
        "kk": first_value(raw, "kk", "so", "strikeOut"),
        "bb": first_value(raw, "bb", "baseOnBalls"),
        "bf": first_value(raw, "bf"),
        "hr": first_value(raw, "hr", "homeRun"),
        "np": first_value(raw, "np", "pitchCount"),
        "wls": first_value(raw, "wls"),
    }
    return {key: value for key, value in today.items() if value not in (None, "")}


def pitcher_from_schedule(meta: dict[str, Any] | None, side: str) -> dict[str, Any] | None:
    if not meta:
        return None
    name_key = "homeCurrentPitcherName" if side == "home" else "awayCurrentPitcherName"
    name = meta.get(name_key)
    if not name:
        name_key = "homeStarterName" if side == "home" else "awayStarterName"
        name = meta.get(name_key)
    if not name:
        return None
    return {"name": name, "player_code": "", "position": "투수"}


def compact_pitcher_info(pitcher: dict[str, Any] | None, role: str) -> dict[str, Any] | None:
    if not pitcher:
        return None
    return {
        "role": role,
        "name": pitcher.get("name") or "",
        "player_code": str(pitcher.get("player_code") or ""),
        "position": pitcher.get("position") or "",
        "bats_throws": pitcher.get("bats_throws") or "",
        "today": pitcher.get("today") if isinstance(pitcher.get("today"), dict) else None,
    }


def same_pitcher(left: dict[str, Any] | None, right: dict[str, Any] | None) -> bool:
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    left_code = str(left.get("player_code") or left.get("pcode") or "")
    right_code = str(right.get("player_code") or right.get("pcode") or "")
    if left_code and right_code:
        return left_code == right_code
    return bool(normalize_team_key(left.get("name")) and normalize_team_key(left.get("name")) == normalize_team_key(right.get("name")))


def compact_relief_pitchers(
    pitchers: list[dict[str, Any]],
    starter: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for pitcher in pitchers:
        if same_pitcher(pitcher, starter):
            continue
        compacted = compact_pitcher_info(pitcher, "relief")
        if compacted and not any(same_pitcher(compacted, existing) for existing in results):
            results.append(compacted)
    return results


def compact_live_batter(raw: dict[str, Any], existing: dict[str, Any] | None = None) -> dict[str, Any]:
    previous_code = str((existing or {}).get("player_code") or "")
    original_player = dict(existing or {})
    if original_player:
        original_player["substitute_out"] = True
        original_player.pop("live_batter", None)
        original_player.pop("substitute_in", None)
        original_player.pop("replaced_player", None)
    player = dict(existing or {})
    player.update(
        {
            "name": raw.get("name") or player.get("name") or "",
            "player_code": str(raw.get("playerCode") or raw.get("pcode") or player.get("player_code") or ""),
            "position": raw.get("posName") or raw.get("pos") or player.get("position") or "",
            "bat_order": raw.get("batOrder") or player.get("bat_order"),
            "bats_throws": raw.get("hitType") or player.get("bats_throws") or "",
            "back_number": raw.get("backnum") or player.get("back_number") or "",
            "today": compact_batter_today(raw),
        }
    )
    if previous_code and previous_code != str(player.get("player_code") or ""):
        for key in ("records", "vs_opponent_team", "vs_starting_pitcher"):
            player.pop(key, None)
        player["replaced_player"] = {
            key: value for key, value in original_player.items() if value not in ("", None)
        }
    player["live_batter"] = True
    if raw.get("substituteIn"):
        player["substitute_in"] = True
    return {key: value for key, value in player.items() if value not in ("", None)}


def compact_boxscore_batter(raw: dict[str, Any], template: dict[str, Any] | None = None) -> dict[str, Any]:
    player = dict(template or {})
    for key in ("replaced_player", "replaced_players", "substitute_out"):
        player.pop(key, None)
    player.update(
        {
            "name": raw.get("name") or player.get("name") or "",
            "player_code": str(raw.get("playerCode") or raw.get("pcode") or player.get("player_code") or ""),
            "position": raw.get("posName") or raw.get("pos") or player.get("position") or "",
            "bat_order": raw.get("batOrder") or player.get("bat_order"),
            "bats_throws": raw.get("hitType") or player.get("bats_throws") or "",
            "back_number": raw.get("backnum") or player.get("back_number") or "",
            "today": compact_batter_today(raw),
        }
    )
    player["live_batter"] = True
    if raw.get("substituteIn"):
        player["substitute_in"] = True
    return {key: value for key, value in player.items() if value not in ("", None)}


def live_batting_sequences(record: dict[str, Any] | None, side: str) -> dict[str, list[dict[str, Any]]]:
    if not record:
        return {}

    boxscore = record.get("recordData", {}).get("battersBoxscore", {})
    batters = boxscore.get(side) if isinstance(boxscore, dict) else None
    if not isinstance(batters, list):
        return {}

    by_order: dict[str, list[dict[str, Any]]] = {}
    for raw in batters:
        if not isinstance(raw, dict):
            continue
        bat_order = raw.get("batOrder")
        if bat_order is None:
            continue
        key = str(bat_order)
        by_order.setdefault(key, []).append(raw)
    return by_order


def live_batting_order(record: dict[str, Any] | None, side: str) -> dict[str, dict[str, Any]]:
    return {order: sequence[-1] for order, sequence in live_batting_sequences(record, side).items() if sequence}


def player_code(player: dict[str, Any] | None) -> str:
    if not isinstance(player, dict):
        return ""
    return str(player.get("player_code") or player.get("playerCode") or player.get("pcode") or "")


def attach_records_and_context(
    player: dict[str, Any],
    opponent: dict[str, Any] | None,
    include_player_records: bool,
    player_cache: dict[str, dict[str, Any]],
    history_cache: Any,
    refresh_history: bool,
    use_daily_cache: bool,
    daily_cache: DailyStatsCache | None,
) -> None:
    if not include_player_records:
        return
    attach_player_records(player, player_cache, history_cache, refresh_history, use_daily_cache, daily_cache)
    if isinstance(opponent, dict):
        attach_player_vs_opponent_team(player, opponent)


def attach_pitchers_records_and_context(
    pitchers: list[dict[str, Any]],
    opponent: dict[str, Any] | None,
    include_player_records: bool,
    player_cache: dict[str, dict[str, Any]],
    history_cache: Any,
    refresh_history: bool,
    use_daily_cache: bool,
    daily_cache: DailyStatsCache | None,
) -> None:
    for pitcher in pitchers:
        if isinstance(pitcher, dict):
            attach_records_and_context(
                pitcher,
                opponent,
                include_player_records,
                player_cache,
                history_cache,
                refresh_history,
                use_daily_cache,
                daily_cache,
            )


def attach_player_records(
    player: dict[str, Any],
    player_cache: dict[str, dict[str, Any]],
    history_cache: Any,
    refresh_history: bool,
    use_daily_cache: bool,
    daily_cache: DailyStatsCache | None,
) -> None:
    player_code = str(player.get("player_code") or "")
    if not player_code:
        player["records"] = {"error": "player_code 없음"}
        return
    if player.get("records") and not player.get("records", {}).get("error"):
        return

    if player_code not in player_cache and use_daily_cache:
        cached = cached_player_record(daily_cache, player_code)
        if cached:
            player_cache[player_code] = cached

    if player_code not in player_cache:
        try:
            player_cache[player_code] = fetch_player_record(
                player_code,
                history_cache=history_cache,
                refresh_history=refresh_history,
                player_name=str(player.get("name") or ""),
            )
        except KboLineupError as exc:
            player_cache[player_code] = {"error": str(exc)}
        store_player_record(daily_cache, player_code, player_cache[player_code])
    player["records"] = player_cache[player_code]


def update_live_batters(
    team: dict[str, Any],
    opponent: dict[str, Any] | None,
    record: dict[str, Any] | None,
    side: str,
    finalized: bool,
    include_player_records: bool,
    player_cache: dict[str, dict[str, Any]],
    history_cache: Any,
    refresh_history: bool,
    use_daily_cache: bool,
    daily_cache: DailyStatsCache | None,
) -> None:
    live_by_order = live_batting_sequences(record, side)
    if not live_by_order:
        return

    original_by_order = {
        str(batter.get("bat_order")): batter
        for batter in team.get("batting_order", [])
        if isinstance(batter, dict) and batter.get("bat_order") is not None
    }
    updated = []
    changed = False
    for order in sorted(live_by_order, key=lambda value: int(value) if value.isdigit() else 99):
        sequence = live_by_order[order]
        existing = original_by_order.get(order)
        entries: list[dict[str, Any]] = []
        existing_code = player_code(existing)

        for raw in sequence:
            raw_code = player_code(raw)
            template = existing if existing_code and raw_code == existing_code else None
            batter = compact_boxscore_batter(raw, template)
            if entries and player_code(entries[-1]) == player_code(batter):
                entries[-1] = batter
            else:
                entries.append(batter)

        if existing and existing_code and all(player_code(entry) != existing_code for entry in entries):
            original = dict(existing)
            original["substitute_out"] = True
            entries.insert(0, original)

        if not entries:
            continue

        current = entries[-1]
        replacements = []
        for replacement in entries[:-1]:
            replacement["substitute_out"] = True
            replacement.pop("substitute_in", None)
            replacement.pop("replaced_player", None)
            replacement.pop("replaced_players", None)
            attach_records_and_context(
                replacement,
                opponent,
                include_player_records,
                player_cache,
                history_cache,
                refresh_history,
                use_daily_cache,
                daily_cache,
            )
            replacements.append(replacement)

        if replacements:
            current["replaced_players"] = [
                {key: value for key, value in replacement.items() if value not in ("", None)}
                for replacement in replacements
            ]
            current["replaced_player"] = current["replaced_players"][0]
            current["substitute_in"] = True

        current["bat_order"] = order
        if existing is None or existing_code != player_code(current) or replacements:
            changed = True
        attach_records_and_context(
            current,
            opponent,
            include_player_records,
            player_cache,
            history_cache,
            refresh_history,
            use_daily_cache,
            daily_cache,
        )
        updated.append(current)

    if updated:
        team["batting_order"] = updated
    if changed:
        team["live_lineup_updated"] = True
        team["basis"] = "최종 라인업" if finalized else "실시간 라인업"
        team["note"] = (
            "경기 종료 후 교체 선수를 최종 박스스코어 기준으로 모두 반영했습니다."
            if finalized
            else "경기 중 교체 선수를 현재 박스스코어 기준으로 반영했습니다."
        )


def seed_matchup_pitchers(data: dict[str, Any]) -> None:
    for team in data.get("teams", []):
        if not isinstance(team, dict):
            continue
        for batter in team.get("batting_order", []):
            matchup = batter.get("vs_starting_pitcher") if isinstance(batter, dict) else None
            pitcher = matchup.get("opposing_pitcher") if isinstance(matchup, dict) else None
            if isinstance(pitcher, dict):
                team["matchup_pitcher"] = compact_pitcher_info(pitcher, "starter")
                break


def team_batting_entries(team: dict[str, Any]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for batter in team.get("batting_order", []):
        if not isinstance(batter, dict):
            continue
        replacements = batter.get("replaced_players")
        if isinstance(replacements, list):
            entries.extend(replacement for replacement in replacements if isinstance(replacement, dict))
        elif isinstance(batter.get("replaced_player"), dict):
            entries.append(batter["replaced_player"])
        entries.append(batter)
    return entries


def yyyymmdd_to_iso(value: Any) -> str:
    text = str(value or "").strip()
    if re.fullmatch(r"\d{8}", text):
        return f"{text[:4]}-{text[4:6]}-{text[6:8]}"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text
    return ""


def parse_iso_date(value: Any) -> datetime | None:
    text = yyyymmdd_to_iso(value)
    if not text:
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        return None


def weekday_label(value: Any) -> str:
    parsed = parse_iso_date(value)
    if not parsed:
        return "-"
    return ["월", "화", "수", "목", "금", "토", "일"][parsed.weekday()]


def season_half_label(value: Any) -> str:
    parsed = parse_iso_date(value)
    if not parsed:
        return "-"
    return "전반기" if (parsed.month, parsed.day) < (7, 16) else "후반기"


def game_time_bucket(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        match = re.search(r"(\d{1,2}):(\d{2})", text)
        if match:
            return "주간" if int(match.group(1)) < 18 else "야간"
        digits = re.sub(r"\D", "", text)
        if len(digits) >= 10:
            hour = int(digits[8:10])
            return "주간" if hour < 18 else "야간"
    return "-"


def normalized_team_values(*values: Any) -> set[str]:
    aliases = {
        "ht": {"kia", "기아", "기아타이거즈"},
        "kia": {"ht", "기아", "기아타이거즈"},
        "ob": {"두산", "두산베어스"},
        "sk": {"ssg", "쓱", "ssg랜더스"},
        "ssg": {"sk", "쓱", "ssg랜더스"},
        "wo": {"키움", "키움히어로즈"},
        "kiwoom": {"wo", "키움", "키움히어로즈"},
        "ss": {"삼성", "삼성라이온즈"},
        "lt": {"롯데", "롯데자이언츠"},
        "hh": {"한화", "한화이글스"},
        "lg": {"엘지", "lg트윈스"},
        "kt": {"케이티", "kt위즈"},
        "nc": {"엔씨", "nc다이노스"},
    }
    keys = {normalize_team_key(value) for value in values if normalize_team_key(value)}
    for key in list(keys):
        keys.update(aliases.get(key, set()))
    return keys


def keys_overlap(left: set[str], right: set[str]) -> bool:
    if not left or not right:
        return False
    if left & right:
        return True
    return any(a in b or b in a for a in left for b in right)


def log_game_side(log: dict[str, Any], team: dict[str, Any], meta: dict[str, Any] | None) -> str:
    team_keys = normalized_team_values(
        team.get("team_code"),
        team.get("team_name"),
        (team.get("team_season") or {}).get("teamId") if isinstance(team.get("team_season"), dict) else None,
        (team.get("team_season") or {}).get("teamName") if isinstance(team.get("team_season"), dict) else None,
        (team.get("team_season") or {}).get("teamShortName") if isinstance(team.get("team_season"), dict) else None,
    )
    if meta:
        home_keys = normalized_team_values(meta.get("homeTeamCode"), meta.get("homeTeamName"))
        away_keys = normalized_team_values(meta.get("awayTeamCode"), meta.get("awayTeamName"))
        if keys_overlap(team_keys, home_keys):
            return "home"
        if keys_overlap(team_keys, away_keys):
            return "away"

    game_id = str(log.get("gameId") or "")
    body = game_id[8:-5] if len(game_id) >= 13 else ""
    if len(body) >= 4:
        away_code = body[:2]
        home_code = body[2:4]
        if keys_overlap(team_keys, normalized_team_values(home_code)):
            return "home"
        if keys_overlap(team_keys, normalized_team_values(away_code)):
            return "away"
    return ""


def stat_avg_ops(games: list[dict[str, Any]]) -> dict[str, Any]:
    if not games:
        return {"games": 0, "avg": None, "ops": None}

    ab = sum(numeric_value(game.get("ab")) for game in games)
    hit = sum(numeric_value(game.get("hit")) for game in games)
    doubles = sum(numeric_value(game.get("h2")) for game in games)
    triples = sum(numeric_value(game.get("h3")) for game in games)
    homers = sum(numeric_value(game.get("hr")) for game in games)
    walks = sum(numeric_value(game.get("bb")) for game in games)
    hbp = sum(numeric_value(first_value(game, "hp", "hbp", "hitByPitch")) for game in games)
    sac_fly = sum(numeric_value(game.get("sf")) for game in games)

    avg_value = hit / ab if ab else None
    total_bases = hit + doubles + (2 * triples) + (3 * homers)
    obp_denom = ab + walks + hbp + sac_fly
    obp = (hit + walks + hbp) / obp_denom if obp_denom else None
    slg = total_bases / ab if ab else None
    ops = (obp + slg) if obp is not None and slg is not None else None
    return {
        "games": len(games),
        "avg": round(avg_value, 3) if avg_value is not None else None,
        "ops": round(ops, 3) if ops is not None else None,
    }


def matchup_summary_avg_ops(batter: dict[str, Any]) -> dict[str, Any]:
    summary = batter.get("vs_starting_pitcher", {}).get("stats", {}).get("summary")
    if not isinstance(summary, dict) or not numeric_value(summary.get("pa")):
        return {"games": 0, "avg": None, "ops": None}
    return {
        "games": numeric_value(summary.get("pa")),
        "avg": summary.get("avg"),
        "ops": summary.get("ops"),
    }


def pitcher_throw_label(pitcher: dict[str, Any] | None) -> str:
    if not isinstance(pitcher, dict):
        return "-"
    label = pitcher_throw_type_from_text(
        pitcher.get("bats_throws")
        or pitcher.get("throws")
        or pitcher.get("throw")
        or pitcher.get("pitcherHand")
        or ""
    )
    if label:
        return label
    return str(pitcher.get("name") or "-")


def context_row(
    kind: str,
    label: str,
    stats: dict[str, Any] | None,
    note: str = "",
    situation: str = "",
) -> dict[str, Any]:
    stats = stats or {}
    row = {
        "kind": kind,
        "label": label,
        "avg": stats.get("avg"),
        "ops": stats.get("ops"),
        "games": stats.get("games", 0),
    }
    if note:
        row["note"] = note
    if situation:
        row["situation"] = situation
    return row


def build_context_matchups(
    batter: dict[str, Any],
    team: dict[str, Any],
    game: dict[str, Any],
    logs: list[dict[str, Any]],
    schedule_by_game: dict[str, dict[str, Any]],
    target_date: str,
    pitcher_type_stats: dict[str, Any] | None = None,
    pitcher_type_source: str = "",
) -> dict[str, Any]:
    opponent = team.get("opponent") if isinstance(team.get("opponent"), dict) else {}
    opponent_keys = normalized_team_values(
        opponent.get("team_code"),
        opponent.get("team_name"),
        (opponent.get("team_season") or {}).get("teamId") if isinstance(opponent.get("team_season"), dict) else None,
        (opponent.get("team_season") or {}).get("teamName") if isinstance(opponent.get("team_season"), dict) else None,
        (opponent.get("team_season") or {}).get("teamShortName") if isinstance(opponent.get("team_season"), dict) else None,
    )
    opponent_label = opponent.get("team_name") or game.get("home_team") or game.get("away_team") or "상대팀"
    month = parse_iso_date(target_date).month if parse_iso_date(target_date) else None
    month_label = f"{month}월" if month else "-"
    weekday = weekday_label(target_date)
    stadium = str(game.get("stadium") or "").strip() or "-"
    side = str(team.get("side") or "")
    side_label = "홈" if side == "home" else "원정" if side == "away" else "-"
    current_meta = schedule_by_game.get(str(game.get("game_id") or "")) or {}
    day_night = game_time_bucket(game.get("time"), current_meta.get("gameDateTime"), current_meta.get("gameTime"))
    half = season_half_label(target_date)
    pitcher = batter.get("vs_starting_pitcher", {}).get("opposing_pitcher", {})
    pitcher_role = pitcher.get("role") if isinstance(pitcher, dict) else ""
    pitcher_label = "상대 현재 투수" if pitcher_role == "current" else "상대 선발"
    pitcher_name = pitcher.get("name") if isinstance(pitcher, dict) else ""
    pitcher_situation = pitcher_throw_label(pitcher if isinstance(pitcher, dict) else None)
    pitcher_type_label = f"{pitcher_label} {pitcher_name}".strip()
    if pitcher_type_source:
        pitcher_type_label = f"{pitcher_type_label} / {pitcher_type_source}".strip()

    dated_logs = [
        log for log in logs
        if isinstance(log, dict) and parse_iso_date(log.get("gday"))
    ]

    def log_meta(log: dict[str, Any]) -> dict[str, Any]:
        return schedule_by_game.get(str(log.get("gameId") or "")) or {}

    def same_opponent(log: dict[str, Any]) -> bool:
        return keys_overlap(normalized_team_values(log.get("opponent")), opponent_keys)

    def same_month(log: dict[str, Any]) -> bool:
        parsed = parse_iso_date(log.get("gday"))
        return bool(parsed and month and parsed.month == month)

    def same_weekday(log: dict[str, Any]) -> bool:
        return weekday_label(log.get("gday")) == weekday

    def same_stadium(log: dict[str, Any]) -> bool:
        meta = log_meta(log)
        return normalize_team_key(meta.get("stadium")) == normalize_team_key(stadium)

    def same_side(log: dict[str, Any]) -> bool:
        return bool(side and log_game_side(log, team, log_meta(log)) == side)

    def same_day_night(log: dict[str, Any]) -> bool:
        meta = log_meta(log)
        return game_time_bucket(meta.get("gameDateTime"), meta.get("gameTime")) == day_night

    def same_half(log: dict[str, Any]) -> bool:
        return season_half_label(log.get("gday")) == half

    rows = [
        context_row(
            "pitcher",
            pitcher_type_label,
            pitcher_type_stats,
            situation=pitcher_situation,
        ),
        context_row("opponent", f"vs {opponent_label}", stat_avg_ops([log for log in dated_logs if same_opponent(log)]), situation=str(opponent_label)),
        context_row("month", month_label, stat_avg_ops([log for log in dated_logs if same_month(log)]), situation=str(month) if month else ""),
        context_row("weekday", f"{weekday}요일" if weekday != "-" else "-", stat_avg_ops([log for log in dated_logs if same_weekday(log)]), situation=weekday),
        context_row("stadium", stadium, stat_avg_ops([log for log in dated_logs if same_stadium(log)]), situation=stadium),
        context_row("home_away", side_label, stat_avg_ops([log for log in dated_logs if same_side(log)]), situation=side_label),
        context_row("day_night", day_night, stat_avg_ops([log for log in dated_logs if same_day_night(log)]), situation=day_night),
        context_row("half", half, stat_avg_ops([log for log in dated_logs if same_half(log)]), situation=half),
    ]
    return {
        "rows": rows,
        "updated_at": now_kst_iso(),
    }


def attach_context_matchups(
    data: dict[str, Any],
    target_date: str,
    use_daily_cache: bool,
    daily_cache: DailyStatsCache | None,
) -> None:
    games = [game for game in data.get("games", []) if isinstance(game, dict)]
    if len(games) != 1:
        return
    teams = [team for team in data.get("teams", []) if isinstance(team, dict)]
    if not teams:
        return

    game = games[0]
    use_context_daily_cache = daily_cache is not None
    player_log_cache: dict[str, dict[str, Any]] = {}
    missing: list[tuple[str, str | None]] = []
    missing_codes: set[str] = set()
    for team in teams:
        for batter in team_batting_entries(team):
            if not isinstance(batter, dict):
                continue
            records = batter.get("records") if isinstance(batter.get("records"), dict) else {}
            if records.get("player_type") == "pitcher":
                continue
            code = str(batter.get("player_code") or "")
            if not code:
                batter["context_matchups"] = {"rows": []}
                continue
            cached = cached_player_game_log(daily_cache, code, "hitter") if use_context_daily_cache else None
            if cached:
                player_log_cache[code] = cached
            elif code not in player_log_cache and code not in missing_codes:
                season_start = None
                recent = records.get("recent_10_games") if isinstance(records, dict) else None
                if isinstance(recent, dict):
                    season_start = str(recent.get("day_start") or "") or None
                missing.append((code, season_start))
                missing_codes.add(code)

    if missing:
        worker_count = min(MAX_FETCH_WORKERS, len(missing))
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = {
                executor.submit(fetch_player_game_log, code, "hitter", season_start): code
                for code, season_start in missing
            }
            for future in as_completed(futures):
                code = futures[future]
                try:
                    player_log_cache[code] = future.result()
                except KboLineupError as exc:
                    player_log_cache[code] = {"error": str(exc), "games": []}
                store_player_game_log(daily_cache, code, "hitter", player_log_cache[code])

    log_dates: set[str] = {target_date}
    for record in player_log_cache.values():
        games_list = record.get("games") if isinstance(record, dict) else []
        if not isinstance(games_list, list):
            continue
        for log in games_list:
            if not isinstance(log, dict):
                continue
            log_date = yyyymmdd_to_iso(log.get("gday"))
            if log_date:
                log_dates.add(log_date)

    schedule_by_date: dict[str, dict[str, dict[str, Any]]] = {}
    missing_dates: list[str] = []
    for log_date in sorted(log_dates):
        cached = cached_schedule_meta(daily_cache, log_date) if use_context_daily_cache else None
        if cached is not None:
            schedule_by_date[log_date] = {str(key): value for key, value in cached.items() if isinstance(value, dict)}
        else:
            missing_dates.append(log_date)

    if missing_dates:
        worker_count = min(MAX_FETCH_WORKERS, len(missing_dates))
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = {executor.submit(fetch_schedule_meta, log_date): log_date for log_date in missing_dates}
            for future in as_completed(futures):
                log_date = futures[future]
                try:
                    schedule_by_date[log_date] = future.result()
                except KboLineupError:
                    schedule_by_date[log_date] = {}
                store_schedule_meta(daily_cache, log_date, schedule_by_date[log_date])

    schedule_by_game: dict[str, dict[str, Any]] = {}
    for schedule in schedule_by_date.values():
        schedule_by_game.update(schedule)

    season_year = target_date[:4] if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(target_date)) else str(datetime.now().year)
    situation_record_cache: dict[tuple[str, str, str], dict[str, Any]] = {}

    def pitcher_type_stats_for(team: dict[str, Any], batter: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
        pitcher = batter.get("vs_starting_pitcher", {}).get("opposing_pitcher", {})
        if not isinstance(pitcher, dict):
            return None, ""
        throw_label = pitcher_throw_label(pitcher)
        detail_code = kbo_pitcher_type_detail_code(throw_label)
        team_code = kbo_team_code_for_team(team)
        if not team_code or not detail_code:
            return None, ""

        cache_key = (season_year, team_code, detail_code)
        if cache_key not in situation_record_cache:
            cached = (
                cached_kbo_hitter_situation(daily_cache, season_year, team_code, detail_code)
                if use_context_daily_cache else None
            )
            if cached is not None:
                situation_record_cache[cache_key] = cached
            else:
                try:
                    situation_record_cache[cache_key] = fetch_kbo_hitter_situation(
                        season_year,
                        team_code,
                        detail_code,
                    )
                except KboLineupError as exc:
                    situation_record_cache[cache_key] = {
                        "error": str(exc),
                        "season_year": season_year,
                        "team_code": team_code,
                        "detail_code": detail_code,
                        "source_url": KBO_HITTER_SITUATION_URL,
                        "updated_at": now_kst_iso(),
                    }
                store_kbo_hitter_situation(
                    daily_cache,
                    season_year,
                    team_code,
                    detail_code,
                    situation_record_cache[cache_key],
                )

        record = situation_record_cache.get(cache_key)
        return lookup_kbo_hitter_situation_stats(record, batter), "KBO 투수유형별"

    for team in teams:
        for batter in team_batting_entries(team):
            code = str(batter.get("player_code") or "")
            record = player_log_cache.get(code, {})
            logs = record.get("games") if isinstance(record, dict) else []
            pitcher_type_stats, pitcher_type_source = pitcher_type_stats_for(team, batter)
            batter["context_matchups"] = build_context_matchups(
                batter,
                team,
                game,
                logs if isinstance(logs, list) else [],
                schedule_by_game,
                target_date,
                pitcher_type_stats,
                pitcher_type_source,
            )


def attach_batter_vs_pitcher(
    team: dict[str, Any],
    opposing_pitcher: dict[str, Any] | None,
    vs_cache: dict[tuple[str, str], dict[str, Any]],
    role: str,
    use_daily_cache: bool,
    daily_cache: DailyStatsCache | None,
) -> None:
    pitcher_info = compact_pitcher_info(opposing_pitcher, role)
    if not pitcher_info:
        return

    team["matchup_pitcher"] = pitcher_info
    pitcher_code = str(pitcher_info.get("player_code") or "")
    if not pitcher_code:
        for batter in team_batting_entries(team):
            if isinstance(batter, dict):
                batter["vs_starting_pitcher"] = {
                    "opposing_pitcher": pitcher_info,
                    "stats": None,
                    "note": "현재 투수 코드 없음",
                }
        return

    batters_needing_fetch = []
    for batter in team_batting_entries(team):
        if not isinstance(batter, dict):
            continue
        existing = batter.get("vs_starting_pitcher")
        existing_pitcher = existing.get("opposing_pitcher") if isinstance(existing, dict) else None
        if (
            isinstance(existing_pitcher, dict)
            and str(existing_pitcher.get("player_code") or "") == pitcher_code
            and existing.get("stats")
        ):
            continue

        batter_code = str(batter.get("player_code") or "")
        if not batter_code:
            batter["vs_starting_pitcher"] = {
                "opposing_pitcher": pitcher_info,
                "error": "player_code 없음",
            }
            continue

        cache_key = (batter_code, pitcher_code)
        if cache_key not in vs_cache:
            cached = cached_vs_player_stats(daily_cache, batter_code, pitcher_code) if use_daily_cache else None
            if cached:
                vs_cache[cache_key] = cached
            else:
                batters_needing_fetch.append((batter_code, cache_key))

    if batters_needing_fetch:
        worker_count = min(MAX_FETCH_WORKERS, len(batters_needing_fetch))
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = {
                executor.submit(fetch_vs_player_stats, batter_code, pitcher_code, player_type="hitter"): cache_key
                for batter_code, cache_key in batters_needing_fetch
            }
            for future in as_completed(futures):
                cache_key = futures[future]
                try:
                    vs_cache[cache_key] = future.result()
                except KboLineupError as exc:
                    batter_code = cache_key[0]
                    vs_cache[cache_key] = {
                        "error": str(exc),
                        "source_url": (
                            f"{VS_PLAYER_STATS_URL.format(player_code=batter_code)}?"
                            f"playerType=hitter&vsPlayerId={pitcher_code}"
                        ),
                    }
                store_vs_player_stats(daily_cache, cache_key[0], cache_key[1], "hitter", vs_cache[cache_key])

    for batter in team_batting_entries(team):
        if not isinstance(batter, dict):
            continue
        batter_code = str(batter.get("player_code") or "")
        if not batter_code:
            continue
        cache_key = (batter_code, pitcher_code)
        if cache_key not in vs_cache:
            cached = cached_vs_player_stats(daily_cache, batter_code, pitcher_code) if use_daily_cache else None
            if cached:
                vs_cache[cache_key] = cached
            else:
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
                store_vs_player_stats(daily_cache, batter_code, pitcher_code, "hitter", vs_cache[cache_key])

        batter["vs_starting_pitcher"] = {
            "opposing_pitcher": pitcher_info,
            "stats": vs_cache[cache_key],
        }


def scoreboard_from_record(
    game: dict[str, Any],
    record: dict[str, Any] | None,
    meta: dict[str, Any] | None,
    visible: bool,
) -> dict[str, Any] | None:
    if not record:
        return None

    score_board = record.get("recordData", {}).get("scoreBoard")
    if not isinstance(score_board, dict):
        return None

    innings = score_board.get("inn") if isinstance(score_board.get("inn"), dict) else {}
    rheb = score_board.get("rheb") if isinstance(score_board.get("rheb"), dict) else {}
    away_scores = innings.get("away") if isinstance(innings.get("away"), list) else []
    home_scores = innings.get("home") if isinstance(innings.get("home"), list) else []
    column_count = max(len(away_scores), len(home_scores))
    if not column_count:
        return None

    def side_row(side: str, scores: list[Any]) -> dict[str, Any]:
        side_totals = rheb.get(side) if isinstance(rheb.get(side), dict) else {}
        score_key = "awayTeamScore" if side == "away" else "homeTeamScore"
        return {
            "side": side,
            "name": game.get(f"{side}_team") or (meta or {}).get(f"{side}TeamName") or side,
            "scores": ["" if index >= len(scores) else str(scores[index]) for index in range(column_count)],
            "r": side_totals.get("r", (meta or {}).get(score_key)),
            "h": side_totals.get("h"),
            "e": side_totals.get("e"),
        }

    return {
        "visible": visible,
        "status": (meta or {}).get("statusInfo") or game.get("status"),
        "columns": [str(index + 1) for index in range(column_count)],
        "teams": [
            side_row("away", away_scores),
            side_row("home", home_scores),
        ],
    }


def enrich_live_context(
    data: dict[str, Any],
    target_date: str,
    include_player_records: bool,
    refresh_history: bool,
    use_daily_cache: bool,
    daily_cache: DailyStatsCache | None,
) -> None:
    seed_matchup_pitchers(data)

    try:
        schedule = fetch_schedule_meta_cached(target_date, daily_cache, use_daily_cache)
    except KboLineupError as exc:
        data["live_context_error"] = str(exc)
        return

    teams_by_game_side = {
        (team.get("game_id"), team.get("side")): team
        for team in data.get("teams", [])
        if isinstance(team, dict)
    }
    game_record_cache: dict[str, dict[str, Any] | None] = {}
    player_cache: dict[str, dict[str, Any]] = {}
    vs_cache: dict[tuple[str, str], dict[str, Any]] = {}
    history_cache = load_history_cache(DEFAULT_HISTORY_CACHE) if include_player_records else None

    for game in data.get("games", []):
        if not isinstance(game, dict):
            continue
        game_id = str(game.get("game_id") or "")
        meta = schedule.get(game_id)
        if meta:
            game["status_code"] = meta.get("statusCode")
            game["status"] = meta.get("statusInfo") or game.get("status")
            game["away_score"] = meta.get("awayTeamScore")
            game["home_score"] = meta.get("homeTeamScore")
            game["away_current_pitcher_name"] = meta.get("awayCurrentPitcherName")
            game["home_current_pitcher_name"] = meta.get("homeCurrentPitcherName")

        if is_cancelled_game(game, meta):
            game["canceled"] = True
            game["status"] = "취소"
            game["status_code"] = game.get("status_code") or (meta or {}).get("statusCode") or "CANCEL"
            continue

        visible_scoreboard = should_show_scoreboard(target_date, meta)
        record: dict[str, Any] | None = None
        if visible_scoreboard or is_live_game(meta):
            if game_id not in game_record_cache:
                try:
                    game_record_cache[game_id] = fetch_game_record(game_id)
                except KboLineupError as exc:
                    game_record_cache[game_id] = None
                    game["scoreboard_error"] = str(exc)
            record = game_record_cache.get(game_id)

        scoreboard = scoreboard_from_record(game, record, meta, visible_scoreboard)
        if scoreboard:
            game["scoreboard"] = scoreboard

        lineup_from_boxscore = is_live_game(meta) or is_result_game(meta)
        if not lineup_from_boxscore:
            continue

        home_team = teams_by_game_side.get((game_id, "home"))
        away_team = teams_by_game_side.get((game_id, "away"))
        finalized = is_result_game(meta)
        if isinstance(home_team, dict):
            update_live_batters(
                home_team,
                away_team,
                record,
                "home",
                finalized,
                include_player_records,
                player_cache,
                history_cache,
                refresh_history,
                use_daily_cache,
                daily_cache,
            )
        if isinstance(away_team, dict):
            update_live_batters(
                away_team,
                home_team,
                record,
                "away",
                finalized,
                include_player_records,
                player_cache,
                history_cache,
                refresh_history,
                use_daily_cache,
                daily_cache,
            )

        home_pitchers = pitchers_from_record_side(record, "home")
        away_pitchers = pitchers_from_record_side(record, "away")
        if isinstance(home_team, dict):
            home_team["relief_pitchers"] = compact_relief_pitchers(home_pitchers, home_team.get("starting_pitcher"))
        if isinstance(away_team, dict):
            away_team["relief_pitchers"] = compact_relief_pitchers(away_pitchers, away_team.get("starting_pitcher"))

        if include_player_records:
            if isinstance(home_team, dict):
                attach_pitchers_records_and_context(
                    home_team.get("relief_pitchers", []),
                    away_team,
                    include_player_records,
                    player_cache,
                    history_cache,
                    refresh_history,
                    use_daily_cache,
                    daily_cache,
                )
            if isinstance(away_team, dict):
                attach_pitchers_records_and_context(
                    away_team.get("relief_pitchers", []),
                    home_team,
                    include_player_records,
                    player_cache,
                    history_cache,
                    refresh_history,
                    use_daily_cache,
                    daily_cache,
                )

        if finalized:
            if include_player_records:
                if isinstance(away_team, dict) and isinstance(home_team, dict):
                    attach_batter_vs_pitcher(away_team, home_team.get("starting_pitcher"), vs_cache, "starter", use_daily_cache, daily_cache)
                if isinstance(home_team, dict) and isinstance(away_team, dict):
                    attach_batter_vs_pitcher(home_team, away_team.get("starting_pitcher"), vs_cache, "starter", use_daily_cache, daily_cache)
            continue

        home_current = (
            (home_pitchers[-1] if home_pitchers else None)
            or
            pitcher_from_record_side(record, "home", str((meta or {}).get("homeCurrentPitcherName") or ""))
            or pitcher_from_schedule(meta, "home")
        )
        away_current = (
            (away_pitchers[-1] if away_pitchers else None)
            or
            pitcher_from_record_side(record, "away", str((meta or {}).get("awayCurrentPitcherName") or ""))
            or pitcher_from_schedule(meta, "away")
        )

        if isinstance(home_team, dict):
            home_team["current_pitcher"] = compact_pitcher_info(home_current, "current")
        if isinstance(away_team, dict):
            away_team["current_pitcher"] = compact_pitcher_info(away_current, "current")

        if include_player_records:
            if isinstance(home_team, dict) and isinstance(home_team.get("current_pitcher"), dict):
                attach_records_and_context(
                    home_team["current_pitcher"],
                    away_team,
                    include_player_records,
                    player_cache,
                    history_cache,
                    refresh_history,
                    use_daily_cache,
                    daily_cache,
                )
            if isinstance(away_team, dict) and isinstance(away_team.get("current_pitcher"), dict):
                attach_records_and_context(
                    away_team["current_pitcher"],
                    home_team,
                    include_player_records,
                    player_cache,
                    history_cache,
                    refresh_history,
                    use_daily_cache,
                    daily_cache,
                )
            if isinstance(away_team, dict):
                attach_batter_vs_pitcher(away_team, home_current, vs_cache, "current", use_daily_cache, daily_cache)
            if isinstance(home_team, dict):
                attach_batter_vs_pitcher(home_team, away_current, vs_cache, "current", use_daily_cache, daily_cache)

    if history_cache:
        save_history_cache(history_cache)

    if include_player_records:
        attach_context_matchups(data, target_date, use_daily_cache, daily_cache)


class KboWebHandler(BaseHTTPRequestHandler):
    server_version = "KBOAnalyzer/1.0"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/lineups":
            self.handle_lineups(parsed.query)
            return
        if parsed.path == "/api/games":
            self.handle_games(parsed.query)
            return
        if parsed.path == "/api/network":
            self.handle_network()
            return
        if parsed.path in {"", "/"}:
            self.serve_static("index.html")
            return
        if parsed.path.startswith("/static/"):
            self.serve_static(parsed.path.removeprefix("/static/"))
            return
        self.send_error(404, "Not found")

    def handle_lineups(self, query: str) -> None:
        params = parse_qs(query)
        target_date = first(params, "date") or kst_today()
        team = first(params, "team")
        game_id = first(params, "gameId")
        include_records = not truthy(first(params, "noPlayerRecords"))
        refresh_history = truthy(first(params, "refreshHistory"))
        refresh_daily_stats = truthy(first(params, "refreshDailyStats"))
        use_daily_cache = not refresh_history and not refresh_daily_stats
        daily_cache = load_daily_stats_cache(target_date) if include_records else None

        try:
            if team == TEAM_OVERVIEW_QUERY and not game_id:
                data = collect_team_overview(target_date)
            elif team and not game_id:
                data = collect_team_roster(
                    target_date,
                    team,
                    include_player_records=include_records,
                    refresh_history=refresh_history,
                    use_daily_cache=use_daily_cache,
                    daily_cache=daily_cache,
                    history_cache_path=DEFAULT_HISTORY_CACHE,
                )
            else:
                data = collect_selected_game_lineups(
                    target_date,
                    None if game_id else team,
                    game_id,
                    include_player_records=include_records,
                    refresh_history=refresh_history,
                    use_daily_cache=use_daily_cache,
                    daily_cache=daily_cache,
                    history_cache_path=DEFAULT_HISTORY_CACHE,
                )
                enrich_live_context(data, target_date, include_records, refresh_history, use_daily_cache, daily_cache)
            save_daily_stats_cache(daily_cache)
            data["cache_status"] = cache_status(daily_cache, include_records, refresh_history, refresh_daily_stats)
        except KboLineupError as exc:
            self.send_json({"error": str(exc)}, status=502)
            return
        except Exception as exc:  # pragma: no cover - local app guardrail.
            self.send_json({"error": f"Unexpected server error: {exc}"}, status=500)
            return

        self.send_json(data)

    def handle_games(self, query: str) -> None:
        params = parse_qs(query)
        target_date = first(params, "date") or kst_today()
        try:
            data = collect_games_for_date(target_date)
        except KboLineupError as exc:
            self.send_json({"error": str(exc)}, status=502)
            return
        except Exception as exc:  # pragma: no cover - local app guardrail.
            self.send_json({"error": f"Unexpected server error: {exc}"}, status=500)
            return
        self.send_json(data)

    def handle_network(self) -> None:
        port = self.server.server_port
        addresses = []
        seen = set()
        for address in local_ipv4_addresses():
            if address in seen:
                continue
            seen.add(address)
            addresses.append({"host": address, "url": f"http://{address}:{port}/"})
        self.send_json(
            {
                "port": port,
                "host_header": self.headers.get("Host", ""),
                "addresses": addresses,
            }
        )

    def serve_static(self, relative_path: str) -> None:
        target = (STATIC_DIR / relative_path).resolve()
        if STATIC_DIR.resolve() not in target.parents and target != STATIC_DIR.resolve():
            self.send_error(403, "Forbidden")
            return
        if not target.is_file():
            self.send_error(404, "Not found")
            return

        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        payload = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, payload: dict, status: int = 200) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        print(f"[web] {self.address_string()} - {format % args}", file=sys.stderr)


def first(params: dict[str, list[str]], key: str) -> str | None:
    values = params.get(key)
    if not values:
        return None
    value = values[0].strip()
    return value or None


def local_ipv4_addresses() -> list[str]:
    addresses: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = info[4][0]
            if address and not address.startswith(("127.", "169.254.")):
                addresses.add(address)
    except OSError:
        pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            address = sock.getsockname()[0]
            if address and not address.startswith(("127.", "169.254.")):
                addresses.add(address)
    except OSError:
        pass

    return sorted(addresses)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the KBO analyzer web app.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    server = ThreadingHTTPServer((args.host, args.port), KboWebHandler)
    url = f"http://{args.host}:{args.port}"
    print(f"KBO web app running at {url}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping KBO web app.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
