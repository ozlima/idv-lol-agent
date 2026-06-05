@echo off
setlocal EnableExtensions
title IDV Tracker Setup
color 0A

set "APP_ROOT=%LOCALAPPDATA%\IDV Tracker"
set "SETUP_DIR=%APP_ROOT%\setup"
set "REPO_RAW=https://raw.githubusercontent.com/ozlima/idv-lol-agent/master"
set "BOOTSTRAP=%SETUP_DIR%\IDV-Tracker.bat"
set "INSTALLER=%SETUP_DIR%\installer.ps1"
set "ICON=%SETUP_DIR%\icon.png"
set "SETUP_LOG=%SETUP_DIR%\setup.log"
set "AGENT_LOG=%APP_ROOT%\idv-lol-agent\agent.log"

if not exist "%SETUP_DIR%" mkdir "%SETUP_DIR%" >nul 2>&1

call :log "========================================"
call :log "IDV Tracker Setup"
call :log "Pasta: %APP_ROOT%"
call :log "Log: %SETUP_LOG%"
call :log "========================================"

call :log "Verificando Node.js..."
where node >nul 2>&1
if errorlevel 1 (
    call :fail "Node.js nao encontrado. Instale em https://nodejs.org e rode este setup de novo."
    exit /b 1
)

call :log "Verificando Git..."
where git >nul 2>&1
if errorlevel 1 (
    call :fail "Git nao encontrado. Instale em https://git-scm.com/download/win e rode este setup de novo."
    exit /b 1
)

call :log "Baixando arquivos do instalador..."
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
  "Invoke-WebRequest '%REPO_RAW%/IDV-Tracker-Installer/IDV-Tracker.bat' -OutFile '%BOOTSTRAP%';" ^
  "Invoke-WebRequest '%REPO_RAW%/IDV-Tracker-Installer/installer.ps1' -OutFile '%INSTALLER%';" ^
  "Invoke-WebRequest '%REPO_RAW%/IDV-Tracker-Installer/icon.png' -OutFile '%ICON%';" >> "%SETUP_LOG%" 2>&1
if errorlevel 1 (
    call :fail "Erro ao baixar arquivos do GitHub. Confira a internet e mande o setup.log."
    exit /b 1
)

call :log "Iniciando instalador visual..."
call "%BOOTSTRAP%" >> "%SETUP_LOG%" 2>&1
if errorlevel 1 (
    call :fail "O instalador retornou erro. Mande o setup.log."
    exit /b 1
)

call :log "Setup finalizado."
echo.
if exist "%AGENT_LOG%" (
    echo Ultimas linhas do agent.log:
    echo ----------------------------------------
    powershell -NoProfile -Command "Get-Content -LiteralPath '%AGENT_LOG%' -Tail 80"
    echo ----------------------------------------
    echo.
) else (
    echo Agent log ainda nao foi criado: "%AGENT_LOG%"
    echo.
)

echo Logs para debug:
echo   Setup: "%SETUP_LOG%"
echo   Agent: "%AGENT_LOG%"
echo.
echo Se o agent nao aparecer online, copie e mande esses dois logs.
echo Esta janela pode ser fechada.
echo.
pause
exit /b 0

:log
echo [%date% %time%] %~1
>> "%SETUP_LOG%" echo [%date% %time%] %~1
exit /b 0

:fail
call :log "ERRO: %~1"
echo.
echo ERRO: %~1
echo.
echo Logs para mandar:
echo   "%SETUP_LOG%"
echo   "%AGENT_LOG%"
echo.
pause
exit /b 1
