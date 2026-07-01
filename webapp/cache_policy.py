"""Cache policy labels for the local KBO web app."""

from __future__ import annotations

from typing import Any


CACHE_BUCKETS: dict[str, dict[str, str]] = {
    "schedule_meta": {
        "label": "경기상태",
        "policy": "오늘/진행중은 매번 최신 조회, 지난 경기는 RESULT/CANCEL 확정 후 재사용",
    },
    "player_records": {
        "label": "선수성적",
        "policy": "선수 변경 또는 오래된 과거 경기 캐시일 때만 재조회",
    },
    "player_game_logs": {
        "label": "경기로그",
        "policy": "최근 경기 로그는 하루 1회 재사용, 과거 경기 누락 시 갱신",
    },
    "vs_player_stats": {
        "label": "상대투수",
        "policy": "같은 날짜/선수/투수 조합은 하루 동안 재사용",
    },
    "kbo_hitter_situation": {
        "label": "상황",
        "policy": "오늘 상황별 타자 기록은 하루 1회 조회 후 재사용",
    },
    "kbo_pitcher_situation": {
        "label": "투수좌우",
        "policy": "투수 좌/우타 피안타율은 날짜/팀/타자유형 기준 저장 후 재사용",
    },
    "team_opponent_records": {
        "label": "팀상대",
        "policy": "팀 상대 성적은 날짜/팀 기준 저장 후 재사용",
        "stat_key": "team_opponent_record",
    },
    "kbo_registered_rosters": {
        "label": "1군",
        "policy": "KBO 등록 명단은 날짜/팀 기준 저장 후 재사용",
        "stat_key": "kbo_registered_roster",
    },
    "team_recent_ten": {
        "label": "최근10G",
        "policy": "팀 최근 10경기는 날짜 기준 저장 후 재사용",
    },
}


def cache_policy_rows(stored_counts: dict[str, int], stats: dict[str, int]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for key, meta in CACHE_BUCKETS.items():
        stat_key = meta.get("stat_key", key)
        rows.append(
            {
                "key": key,
                "label": meta["label"],
                "policy": meta["policy"],
                "stored": stored_counts.get(key, 0),
                "hits": stats.get(f"{stat_key}_hits", 0),
                "fetches": stats.get(f"{stat_key}_fetches", 0),
                "stale": stats.get(f"{stat_key}_stale", 0),
            }
        )
    return rows
