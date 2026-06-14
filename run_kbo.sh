#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON:-python3}"

usage() {
  cat <<'USAGE'
KBO 분석 시스템 실행 스크립트

사용법:
  ./run_kbo.sh
  ./run_kbo.sh web [--host HOST] [--port PORT]
  ./run_kbo.sh cli [kbo_lineups.py 옵션...]

예시:
  ./run_kbo.sh
  ./run_kbo.sh web --host 0.0.0.0 --port 8765
  ./run_kbo.sh cli --team NC --date 2026-06-13
  ./run_kbo.sh cli --team KIA --refresh-history

환경변수:
  PYTHON=python3.11   사용할 Python 실행 파일
  KBO_HOST=0.0.0.0    웹앱 접속 호스트
  KBO_PORT=8765       웹앱 포트
USAGE
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

local_ipv4_addresses() {
  if ! command_exists ifconfig; then
    return 0
  fi

  ifconfig | awk '
    /inet / {
      ip = $2
      if (ip !~ /^127\./ && ip !~ /^169\.254\./ && ip !~ /^0\./) {
        print ip
      }
    }
  ' | awk '!seen[$0]++'
}

print_web_urls() {
  local host="$1"
  local port="$2"
  local ip
  local found_ip=0

  echo "KBO 웹앱을 실행합니다."
  echo "  로컬 접속: http://127.0.0.1:${port}/"
  if [[ "$host" == "0.0.0.0" ]]; then
    echo "  같은 Wi-Fi의 휴대폰/태블릿:"
    while IFS= read -r ip; do
      [[ -z "$ip" ]] && continue
      echo "    http://${ip}:${port}/"
      found_ip=1
    done < <(local_ipv4_addresses)
    if [[ "$found_ip" -eq 0 ]]; then
      echo "    IP 확인 실패: macOS 시스템 설정의 Wi-Fi/네트워크 IP를 확인해 주세요."
    fi
  else
    echo "  지정 호스트: http://${host}:${port}/"
  fi
  echo "  종료: Ctrl+C"
  echo
}

run_web() {
  local host="${KBO_HOST:-0.0.0.0}"
  local port="${KBO_PORT:-8765}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --host)
        host="${2:-}"
        shift 2
        ;;
      --port)
        port="${2:-}"
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        echo "알 수 없는 web 옵션: $1" >&2
        usage >&2
        return 2
        ;;
    esac
  done

  mkdir -p "$APP_DIR/.cache"
  print_web_urls "$host" "$port"
  exec "$PYTHON_BIN" "$APP_DIR/webapp/server.py" --host "$host" --port "$port"
}

run_cli() {
  mkdir -p "$APP_DIR/.cache"
  exec "$PYTHON_BIN" "$APP_DIR/kbo_lineups.py" "$@"
}

main() {
  cd "$APP_DIR"

  if ! command_exists "$PYTHON_BIN"; then
    echo "Python 실행 파일을 찾을 수 없습니다: $PYTHON_BIN" >&2
    return 1
  fi

  local mode="${1:-web}"
  case "$mode" in
    web)
      shift || true
      run_web "$@"
      ;;
    cli)
      shift || true
      run_cli "$@"
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      run_web "$@"
      ;;
  esac
}

main "$@"
