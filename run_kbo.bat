@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

pushd "%~dp0" >nul 2>nul
if errorlevel 1 (
  echo 실행 폴더로 이동하지 못했습니다.
  exit /b 1
)
set "APP_DIR=%CD%"

call :find_python
if errorlevel 1 (
  set "EXIT_CODE=1"
  goto finish
)

set "MODE=%~1"
if "%MODE%"=="" goto mode_web_default
if /I "%MODE%"=="web" goto mode_web
if /I "%MODE%"=="cli" goto mode_cli
if /I "%MODE%"=="help" goto mode_help
if /I "%MODE%"=="-h" goto mode_help
if /I "%MODE%"=="--help" goto mode_help
goto mode_web_default

:mode_web
shift
call :run_web %*
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:mode_cli
shift
call :run_cli %*
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:mode_help
call :usage
set "EXIT_CODE=0"
goto finish

:mode_web_default
call :run_web %*
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:finish
popd >nul 2>nul
exit /b %EXIT_CODE%

:find_python
set "PYTHON_EXE="
set "PYTHON_ARGS="

if defined PYTHON (
  set "PYTHON_EXE=%PYTHON:"=%"
  exit /b 0
)

py -3 --version >nul 2>&1
if not errorlevel 1 (
  set "PYTHON_EXE=py"
  set "PYTHON_ARGS=-3"
  exit /b 0
)

python --version >nul 2>&1
if not errorlevel 1 (
  set "PYTHON_EXE=python"
  exit /b 0
)

echo Python 실행 파일을 찾을 수 없습니다.
echo Python 3 설치 후 다시 실행해 주세요.
exit /b 1

:usage
echo KBO 분석 시스템 실행 스크립트
echo.
echo 사용법:
echo   .\run_kbo.bat
echo   .\run_kbo.bat web [--host HOST] [--port PORT]
echo   .\run_kbo.bat cli [kbo_lineups.py 옵션...]
echo.
echo 예시:
echo   .\run_kbo.bat
echo   .\run_kbo.bat web --host 0.0.0.0 --port 8765
echo   .\run_kbo.bat cli --team NC --date 2026-06-13
echo   .\run_kbo.bat cli --team KIA --refresh-history
echo.
echo 환경변수:
echo   PYTHON=C:\Python311\python.exe   사용할 Python 실행 파일
echo   KBO_HOST=0.0.0.0                 웹앱 접속 호스트
echo   KBO_PORT=8765                    웹앱 포트
exit /b 0

:run_web
set "HOST=%KBO_HOST%"
if "%HOST%"=="" set "HOST=0.0.0.0"
set "PORT=%KBO_PORT%"
if "%PORT%"=="" set "PORT=8765"

:parse_web_loop
if "%~1"=="" goto start_web
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
if /I "%~1"=="-h" (
  call :usage
  exit /b 0
)
if /I "%~1"=="--help" (
  call :usage
  exit /b 0
)

echo 알 수 없는 web 옵션: %~1
call :usage
exit /b 2

:start_web
if not exist "%APP_DIR%\.cache" mkdir "%APP_DIR%\.cache"
call :print_web_urls "%HOST%" "%PORT%"
"%PYTHON_EXE%" %PYTHON_ARGS% "%APP_DIR%\webapp\server.py" --host "%HOST%" --port "%PORT%"
exit /b %ERRORLEVEL%

:run_cli
if not exist "%APP_DIR%\.cache" mkdir "%APP_DIR%\.cache"
"%PYTHON_EXE%" %PYTHON_ARGS% "%APP_DIR%\kbo_lineups.py" %*
exit /b %ERRORLEVEL%

:print_web_urls
set "HOST_TO_PRINT=%~1"
set "PORT_TO_PRINT=%~2"
echo KBO 웹앱을 실행합니다.
echo   로컬 접속: http://127.0.0.1:%PORT_TO_PRINT%/
if /I "%HOST_TO_PRINT%"=="0.0.0.0" (
  echo   같은 Wi-Fi의 웹 접속:
  set "FOUND_IP=0"
  for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /I "IPv4"') do (
    set "IP=%%A"
    set "IP=!IP: =!"
    if not "!IP!"=="" (
      if /I not "!IP:~0,4!"=="127." (
        if /I not "!IP:~0,8!"=="169.254." (
          echo     http://!IP!:%PORT_TO_PRINT%/
          set "FOUND_IP=1"
        )
      )
    )
  )
  if "!FOUND_IP!"=="0" echo     IP 확인 실패: Windows 네트워크 설정의 IPv4 주소를 확인해 주세요.
) else (
  echo   지정 호스트: http://%HOST_TO_PRINT%:%PORT_TO_PRINT%/
)
echo   종료: Ctrl+C
echo.
exit /b 0
