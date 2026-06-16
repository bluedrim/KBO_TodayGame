# KBO 오늘의 경기

KBO 오늘 경기의 라인업, 경기 상황, 선수 성적, 팀 기록을 한 화면에서 확인하는 로컬 웹앱입니다.  
네이버 스포츠와 KBO 기록 페이지의 공개 데이터를 이용해 오늘 경기 기준으로 정보를 수집하고, 같은 날 반복 조회되는 선수 기록은 캐시에 저장해 빠르게 재사용합니다.

## 주요 기능

- 오늘 KBO 5경기 일정과 경기 상태 표시
- 경기 전, 진행 중, 종료, 취소 상태 반영
- 경기 진행 중 현재 타자, 현재 투수, 교체 선수, 교체 투수 반영
- 팀별 선발 라인업과 엔트리 선수 성적 조회
- 타자 최근 10경기, 2026 시즌, 최근 3년 성적 표시
- 투수 최근 10경기, 2026 시즌, 최근 3년 성적 표시
- 타자별 상대팀 성적과 상대 선발/현재 투수 상대 기록 표시
- 오늘 상황별 타자 AVG 표시
- 구단 순위, 팀 타격/투수 기록, 상대팀별 팀 기록 표시
- 타자/투수 시즌 상위권 순위 표시
- 웹 접속용 IP 주소 자동 표시

## 파일 구성

```text
.
├── run_kbo.sh              # 실행 스크립트
├── run_kbo.bat             # Windows 실행 스크립트
├── kbo_lineups.py          # CLI 조회 프로그램
├── webapp/
│   ├── server.py           # 로컬 웹 서버/API
│   └── static/
│       ├── index.html      # 웹앱 HTML
│       ├── app.js          # 화면 로직
│       └── styles.css      # 화면 스타일
└── .cache/                 # 조회 캐시 저장 폴더
```

## 준비 사항

- Python 3.9 이상 권장
- 인터넷 연결
- macOS/Linux 터미널 또는 Windows 명령 프롬프트/PowerShell

외부 패키지는 따로 설치하지 않아도 됩니다. Python 표준 라이브러리만 사용합니다.

## 실행 방법

### macOS/Linux

가장 쉬운 실행 방법입니다.

```bash
./run_kbo.sh
```

실행하면 아래처럼 접속 주소가 표시됩니다.

```text
KBO 웹앱을 실행합니다.
  로컬 접속: http://127.0.0.1:8765/
  같은 Wi-Fi의 웹 접속:
    http://192.168.0.160:8765/
  종료: Ctrl+C
```

컴퓨터에서는 `http://127.0.0.1:8765/` 로 접속하면 됩니다.  
다른 기기에서는 같은 Wi-Fi에 연결한 뒤, 실행 화면에 표시된 `http://컴퓨터IP:8765/` 주소를 브라우저에 입력하면 됩니다.

### Windows

Windows에서는 명령 프롬프트 또는 PowerShell에서 아래처럼 실행합니다.

```bat
.\run_kbo.bat
```

Python 런처가 설치되어 있으면 `py -3`을 우선 사용하고, 없으면 `python` 명령을 사용합니다.

실행하면 macOS/Linux와 동일하게 로컬 접속 주소와 같은 Wi-Fi 웹 접속 주소가 표시됩니다.

## 포트 또는 호스트 변경

기본 포트는 `8765`입니다. 다른 포트를 쓰고 싶으면 아래처럼 실행합니다.

```bash
./run_kbo.sh web --host 0.0.0.0 --port 9000
```

Windows에서는 아래처럼 실행합니다.

```bat
.\run_kbo.bat web --host 0.0.0.0 --port 9000
```

환경변수로도 지정할 수 있습니다.

```bash
KBO_HOST=0.0.0.0 KBO_PORT=9000 ./run_kbo.sh
```

Windows 명령 프롬프트에서는 아래처럼 지정할 수 있습니다.

```bat
set KBO_HOST=0.0.0.0
set KBO_PORT=9000
.\run_kbo.bat
```

## 웹 화면 사용법

상단에는 선택 날짜의 경기 목록과 팀 바로가기 버튼이 표시됩니다.

- `전체`: 전체 경기와 구단 순위 정보를 표시합니다.
- 경기 버튼: 해당 경기의 양 팀 라인업과 매치업 기록을 표시합니다.
- 팀 버튼: 해당 팀의 전체 엔트리 선수 성적과 팀 기록을 표시합니다.
- 팀 화면의 `전체 / 타자 / 투수`: 팀 엔트리 테이블 표시 범위를 바꿉니다.
- `설정`: 최근 3년 기록 갱신 같은 관리 기능을 모아둔 영역입니다.

## 데이터 갱신과 캐시

웹앱은 조회 속도를 위해 `.cache/` 폴더에 데이터를 저장합니다.

- 올해 기록과 최근 10경기 기록은 실행 중 필요한 경우 최신 데이터로 확인합니다.
- 최근 3년 기록은 캐시에 저장해 재사용합니다.
- 저장된 최근 3년 기록이 없으면 자동으로 가져옵니다.
- 오늘 상황별 타자 기록, 상대투수 기록, 팀 상대전적 등 하루 단위로 반복되는 기록은 하루 동안 캐시를 재사용합니다.
- 설정에서 최근 3년 기록 갱신을 실행하면 저장된 기록을 새로 가져옵니다.

캐시 파일은 Git에 포함하지 않습니다.

## CLI 사용법

웹앱이 기본 사용 방식이지만, 터미널에서 텍스트로도 조회할 수 있습니다.

```bash
./run_kbo.sh cli
```

Windows에서는 아래처럼 실행합니다.

```bat
.\run_kbo.bat cli
```

특정 날짜를 조회합니다.

```bash
./run_kbo.sh cli --date 2026-06-14
```

```bat
.\run_kbo.bat cli --date 2026-06-14
```

특정 팀과 상대팀만 조회합니다.

```bash
./run_kbo.sh cli --team NC
```

```bat
.\run_kbo.bat cli --team NC
```

최근 3년 기록 캐시를 갱신합니다.

```bash
./run_kbo.sh cli --team NC --refresh-history
```

```bat
.\run_kbo.bat cli --team NC --refresh-history
```

JSON으로 저장합니다.

```bash
./run_kbo.sh cli --date 2026-06-14 --output result.json --quiet
```

```bat
.\run_kbo.bat cli --date 2026-06-14 --output result.json --quiet
```

## API 엔드포인트

웹앱 내부에서 사용하는 주요 API입니다.

```text
GET /api/games?date=YYYY-MM-DD
GET /api/lineups?date=YYYY-MM-DD
GET /api/lineups?date=YYYY-MM-DD&gameId=게임ID
GET /api/lineups?date=YYYY-MM-DD&team=NC
GET /api/lineups?date=YYYY-MM-DD&team=__teams__
GET /api/network
```

## 웹 접속이 안 될 때

- 실행 스크립트에 표시된 IP 주소와 포트가 맞는지 확인합니다.
- 접속하는 기기가 같은 Wi-Fi에 연결되어 있는지 확인합니다.
- macOS 또는 Windows 방화벽에서 Python 또는 터미널의 네트워크 접근이 차단되어 있지 않은지 확인합니다.
- 포트가 이미 사용 중이면 `--port 9000`처럼 다른 포트로 실행합니다.

## 데이터 출처

- 네이버 스포츠 KBO 공개 API
- KBO 기록 페이지

공식 API 계약 없이 공개 페이지/엔드포인트를 조회하는 구조이므로, 원본 사이트의 응답 형식이 바뀌면 일부 기능이 수정이 필요할 수 있습니다.

---

# KBO Today Game

This is a local web app for checking today's KBO games, lineups, live game context, player records, and team records in one place.  
It reads public data from Naver Sports and KBO record pages, then caches repeated daily lookups to keep the app responsive.

## Features

- Show today's five KBO games and game status
- Support pre-game, live, final, canceled, and suspended/canceled game states
- Reflect current batters, current pitchers, substituted players, and relief pitchers during live games
- Show team lineups and full roster player records
- Show hitter recent 10-game, current-season, and recent 3-year records
- Show pitcher recent 10-game, current-season, and recent 3-year records
- Show hitter records against the opponent team and opposing starter/current pitcher
- Show today's context-based hitter AVG
- Show league standings, team batting/pitching records, and team records by opponent
- Show season leaderboards for hitters and pitchers
- Print local and same-network web access URLs when the app starts

## Project Structure

```text
.
├── run_kbo.sh              # macOS/Linux runner
├── run_kbo.bat             # Windows runner
├── kbo_lineups.py          # CLI program
├── webapp/
│   ├── server.py           # local web server/API
│   └── static/
│       ├── index.html      # web app HTML
│       ├── app.js          # frontend logic
│       └── styles.css      # frontend styles
└── .cache/                 # local cache folder
```

## Requirements

- Python 3.9 or newer recommended
- Internet connection
- macOS/Linux terminal, Windows Command Prompt, or PowerShell

No external Python packages are required. The app uses only the Python standard library.

## Run

### macOS/Linux

```bash
./run_kbo.sh
```

The script prints local and same-network web URLs.

```text
KBO 웹앱을 실행합니다.
  로컬 접속: http://127.0.0.1:8765/
  같은 Wi-Fi의 웹 접속:
    http://192.168.0.160:8765/
  종료: Ctrl+C
```

Open `http://127.0.0.1:8765/` on the same computer.  
From another device on the same Wi-Fi, open the displayed `http://YOUR_COMPUTER_IP:8765/` address in a browser.

### Windows

Run this from Command Prompt or PowerShell.

```bat
.\run_kbo.bat
```

The Windows script uses `py -3` first when available, then falls back to `python`.

## Change Host or Port

Default port is `8765`.

```bash
./run_kbo.sh web --host 0.0.0.0 --port 9000
```

```bat
.\run_kbo.bat web --host 0.0.0.0 --port 9000
```

You can also use environment variables.

```bash
KBO_HOST=0.0.0.0 KBO_PORT=9000 ./run_kbo.sh
```

On Windows Command Prompt:

```bat
set KBO_HOST=0.0.0.0
set KBO_PORT=9000
.\run_kbo.bat
```

## Web UI

The top area shows the selected date's games and quick team buttons.

- `전체`: show all games and league/team summary information
- Game button: show both teams' lineups and matchup records for that game
- Team button: show that team's full roster records and team context
- `전체 / 타자 / 투수` in the team view: switch roster table sections
- `설정`: manage options such as refreshing recent 3-year records

## Cache and Updates

The app stores reusable lookup results under `.cache/`.

- Current-season and recent 10-game records are checked as needed while the app runs.
- Recent 3-year records are cached and reused.
- If no recent 3-year cache exists for a player, the app fetches it automatically.
- Daily repeated records, such as context hitter records, pitcher matchup records, and opponent team records, are reused during the same day.
- Use the settings panel to refresh recent 3-year records.

Cache files are not committed to Git.

## CLI Usage

The web app is the main interface, but the CLI can print text or JSON reports.

```bash
./run_kbo.sh cli
```

```bat
.\run_kbo.bat cli
```

Query a specific date.

```bash
./run_kbo.sh cli --date 2026-06-14
```

```bat
.\run_kbo.bat cli --date 2026-06-14
```

Query one team and its opponent.

```bash
./run_kbo.sh cli --team NC
```

```bat
.\run_kbo.bat cli --team NC
```

Refresh recent 3-year cached records.

```bash
./run_kbo.sh cli --team NC --refresh-history
```

```bat
.\run_kbo.bat cli --team NC --refresh-history
```

Write JSON output.

```bash
./run_kbo.sh cli --date 2026-06-14 --output result.json --quiet
```

```bat
.\run_kbo.bat cli --date 2026-06-14 --output result.json --quiet
```

## API Endpoints

```text
GET /api/games?date=YYYY-MM-DD
GET /api/lineups?date=YYYY-MM-DD
GET /api/lineups?date=YYYY-MM-DD&gameId=GAME_ID
GET /api/lineups?date=YYYY-MM-DD&team=NC
GET /api/lineups?date=YYYY-MM-DD&team=__teams__
GET /api/network
```

## Troubleshooting Web Access

- Check that the IP address and port shown by the runner are correct.
- Make sure the other device is on the same Wi-Fi network.
- Check that macOS or Windows firewall rules allow Python or the terminal to accept local network connections.
- If the port is already in use, run with another port, such as `--port 9000`.

## Data Sources

- Naver Sports public KBO endpoints
- KBO record pages

Because this project reads public pages/endpoints without an official API contract, some features may need updates if the source response format changes.
