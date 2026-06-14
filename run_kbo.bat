@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
cd /d "%APP_DIR%"

set "PYTHON_EXE="
set "PYTHON_ARGS="
if defined PYTHON (
  set "PYTHON_EXE=%PYTHON%"
) else (
  py -3 --version >nul 2>nul
  if not errorlevel 1 (
    set "PYTHON_EXE=py"
    set "PYTHON_ARGS=-3"
  ) else (
    python --version >nul 2>nul
    if not errorlevel 1 (
      set "PYTHON_EXE=python"
    )
  )
)

if not defined PYTHON_EXE (
  echo Python 실행 파일을 찾을 수 없습니다.
  echo Python 3 설치 후 다시 실행해 주세요.
  exit /b 1
)

set "MODE=%~1"
if "%MODE%"=="" goto parse_web
if /I "%MODE%"=="web" (
  shift
  goto parse_web
)
if /I "%MODE%"=="cli" (
  shift
  goto build_cli_args
)
if /I "%MODE%"=="help" goto usage
if /I "%MODE%"=="-h" goto usage
if /I "%MODE%"=="--help" goto usage

goto parse_web

:usage
echo KBO 분석 시스템 실행 스크립트
echo.
echo 사용법:
echo   run_kbo.bat
echo   run_kbo.bat web [--host HOST] [--port PORT]
echo   run_kbo.bat cli [kbo_lineups.py 옵션...]
echo.
echo 예시:
echo   run_kbo.bat
echo   run_kbo.bat web --host 0.0.0.0 --port 8765
echo   run_kbo.bat cli --team NC --date 2026-06-13
echo   run_kbo.bat cli --team KIA --refresh-history
echo.
echo 환경변수:
echo   PYTHON=C:\Python311\python.exe   사용할 Python 실행 파일
echo   KBO_HOST=0.0.0.0                 웹앱 접속 호스트
echo   KBO_PORT=8765                    웹앱 포트
exit /b 0

:parse_web
set "HOST=%KBO_HOST%"
if "%HOST%"=="" set "HOST=0.0.0.0"
set "PORT=%KBO_PORT%"
if "%PORT%"=="" set "PORT=8765"

:parse_web_loop
if "%~1"=="" goto run_web
if /I "%~1"=="--host" (
  if "%~2"=="" (
    echo --host 값이 필요합니다.
    exit /b 2
  )
  set "HOST=%~2"
  shift
  shift
  goto parse_web_loop
)
if /I "%~1"=="--port" (
  if "%~2"=="" (
    echo --port 값이 필요합니다.
    exit /b 2
  )
  set "PORT=%~2"
  shift
  shift
  goto parse_web_loop
)
if /I "%~1"=="-h" goto usage
if /I "%~1"=="--help" goto usage

echo 알 수 없는 web 옵션: %~1
call :usage
exit /b 2

:run_web
if not exist "%APP_DIR%\.cache" mkdir "%APP_DIR%\.cache"
call :print_web_urls
"%PYTHON_EXE%" %PYTHON_ARGS% "%APP_DIR%\webapp\server.py" --host "%HOST%" --port "%PORT%"
exit /b %ERRORLEVEL%

:build_cli_args
set "CLI_ARGS="
:build_cli_args_loop
if "%~1"=="" goto run_cli
set "CLI_ARGS=!CLI_ARGS! ^"%~1^""
shift
goto build_cli_args_loop

:run_cli
if not exist "%APP_DIR%\.cache" mkdir "%APP_DIR%\.cache"
"%PYTHON_EXE%" %PYTHON_ARGS% "%APP_DIR%\kbo_lineups.py" %CLI_ARGS%
exit /b %ERRORLEVEL%

:print_web_urls
echo KBO 웹앱을 실행합니다.
echo   로컬 접속: http://127.0.0.1:%PORT%/
if /I "%HOST%"=="0.0.0.0" (
  echo   같은 Wi-Fi의 웹 접속:
  set "FOUND_IP=0"
  for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /I "IPv4"') do (
    set "IP=%%A"
    set "IP=!IP: =!"
    if not "!IP!"=="" (
      if /I not "!IP:~0,4!"=="127." (
        if /I not "!IP:~0,8!"=="169.254." (
          echo     http://!IP!:%PORT%/
          set "FOUND_IP=1"
        )
      )
    )
  )
  if "!FOUND_IP!"=="0" echo     IP 확인 실패: Windows 네트워크 설정의 IPv4 주소를 확인해 주세요.
) else (
  echo   지정 호스트: http://%HOST%:%PORT%/
)
echo   종료: Ctrl+C
echo.
exit /b 0
