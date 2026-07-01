#!/usr/bin/env python3
"""Run lightweight local checks for the KBO web app."""

from __future__ import annotations

import json
import py_compile
import subprocess
import sys
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
SERVER = "http://127.0.0.1:8765"


def check_python() -> None:
    for relative in ("webapp/server.py", "webapp/cache_policy.py", "kbo_lineups.py"):
        py_compile.compile(str(ROOT / relative), doraise=True)
        print(f"ok python {relative}")


def check_javascript() -> None:
    subprocess.run(["node", "--check", "webapp/static/app.js"], cwd=ROOT, check=True)
    print("ok javascript webapp/static/app.js")


def fetch_json(path: str) -> dict:
    with urlopen(f"{SERVER}{path}", timeout=12) as response:
        return json.loads(response.read().decode("utf-8"))


def check_local_api() -> None:
    try:
        games = fetch_json("/api/games")
    except URLError as exc:
        print(f"skip api local server unavailable: {exc.reason}")
        return

    if "games" not in games:
        raise RuntimeError("/api/games did not return games")
    print(f"ok api games {len(games.get('games') or [])}")

    lineups = fetch_json("/api/lineups?team=NC&noPlayerRecords=1")
    if lineups.get("view_mode") != "team_roster":
        raise RuntimeError("/api/lineups team=NC did not return team_roster")
    teams = lineups.get("teams") or []
    if not teams:
        raise RuntimeError("/api/lineups team=NC returned no teams")
    recent = (teams[0].get("team_season") or {}).get("recentTenGames")
    print(f"ok api team roster NC recent10={recent or '-'}")


def main() -> int:
    try:
        check_python()
        check_javascript()
        check_local_api()
    except Exception as exc:
        print(f"fail {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
