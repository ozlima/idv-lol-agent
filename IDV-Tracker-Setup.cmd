@echo off
setlocal EnableExtensions

set "IDV_DEBUG=0"
set "IDV_INNER=0"
set "IDV_LAUNCHER_LOG=%TEMP%\IDV-Tracker-launcher.log"

:parseArgs
if "%~1"=="" goto argsDone
if /I "%~1"=="--debug" set "IDV_DEBUG=1"
if /I "%~1"=="--inner" set "IDV_INNER=1"
if /I "%~1"=="--silent" set "IDV_INNER=1"
shift
goto parseArgs

:argsDone
if "%IDV_DEBUG%"=="0" if "%IDV_INNER%"=="0" (
    set "IDV_RELAUNCH=%TEMP%\IDV-Tracker-Setup-local.cmd"
    >> "%IDV_LAUNCHER_LOG%" echo [%date% %time%] Stage 1: copiando "%~f0" para "%IDV_RELAUNCH%"
    copy /Y "%~f0" "%IDV_RELAUNCH%" >nul 2>&1
    if errorlevel 1 (
        powershell -NoProfile -Command "& {Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Nao foi possivel preparar o instalador limpo.`nLog: %IDV_LAUNCHER_LOG%', 'IDV Tracker', 'OK', 'Error')}"
        exit /b 1
    )
    powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$ErrorActionPreference='Stop'; try { Add-Content -LiteralPath $env:IDV_LAUNCHER_LOG -Value ('[' + (Get-Date).ToString('dd/MM/yyyy HH:mm:ss') + '] Stage 1: iniciando via cmd.exe ' + $env:IDV_RELAUNCH); if (-not (Test-Path -LiteralPath $env:IDV_RELAUNCH)) { throw ('Copia local nao encontrada: ' + $env:IDV_RELAUNCH) }; Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c',$env:IDV_RELAUNCH,'--inner') -WindowStyle Hidden } catch { Add-Type -AssemblyName System.Windows.Forms; Add-Content -LiteralPath $env:IDV_LAUNCHER_LOG -Value ('ERRO: ' + $_.Exception.Message); [System.Windows.Forms.MessageBox]::Show($_.Exception.Message + \"`n`nLog: \" + $env:IDV_LAUNCHER_LOG, 'IDV Tracker', 'OK', 'Error'); exit 1 }"
    exit /b
)

if "%IDV_DEBUG%"=="1" (
    title IDV Tracker Setup
    color 0A
)

set "APP_ROOT=%LOCALAPPDATA%\IDV Tracker"
set "SETUP_DIR=%APP_ROOT%\setup"
set "RUNTIME_DIR=%APP_ROOT%\runtime"
set "NODE_VERSION=22.11.0"
set "NODE_DIR=%RUNTIME_DIR%\node-v%NODE_VERSION%-win-x64"
set "NODE_ZIP=%RUNTIME_DIR%\node.zip"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip"
set "REPO_RAW=https://raw.githubusercontent.com/ozlima/idv-lol-agent/master"
set "BOOTSTRAP=%SETUP_DIR%\IDV-Tracker.bat"
set "INSTALLER=%SETUP_DIR%\installer.ps1"
set "ICON=%SETUP_DIR%\icon.png"
set "SETUP_LOG=%SETUP_DIR%\setup.log"
set "INSTALL_LOG=%APP_ROOT%\idv-lol-agent\install.log"
set "AGENT_LOG=%APP_ROOT%\idv-lol-agent\agent.log"

if not exist "%SETUP_DIR%" mkdir "%SETUP_DIR%" >nul 2>&1
if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%" >nul 2>&1

call :log "========================================"
call :log "IDV Tracker Setup"
call :log "Pasta: %APP_ROOT%"
call :log "Log: %SETUP_LOG%"
call :log "========================================"

call :log "Preparando Node.js portatil..."
if not exist "%NODE_DIR%\node.exe" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$ErrorActionPreference='Stop';" ^
      "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
      "Invoke-WebRequest '%NODE_URL%' -OutFile '%NODE_ZIP%';" ^
      "if (Test-Path '%NODE_DIR%') { Remove-Item -LiteralPath '%NODE_DIR%' -Recurse -Force };" ^
      "Expand-Archive -LiteralPath '%NODE_ZIP%' -DestinationPath '%RUNTIME_DIR%' -Force;" ^
      "Remove-Item -LiteralPath '%NODE_ZIP%' -Force;" >> "%SETUP_LOG%" 2>&1
    if errorlevel 1 (
        call :fail "Erro ao baixar/preparar Node.js portatil. Confira a internet e mande o setup.log."
        exit /b 1
    )
)

set "PATH=%NODE_DIR%;%PATH%"
call :log "Node.js pronto: %NODE_DIR%"

call :log "Baixando arquivos do instalador..."
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
  "$cache=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();" ^
  "Invoke-WebRequest ('%REPO_RAW%/IDV-Tracker-Installer/IDV-Tracker.bat?v=' + $cache) -OutFile '%BOOTSTRAP%';" ^
  "Invoke-WebRequest ('%REPO_RAW%/IDV-Tracker-Installer/installer.ps1?v=' + $cache) -OutFile '%INSTALLER%';" ^
  "Invoke-WebRequest ('%REPO_RAW%/IDV-Tracker-Installer/icon.png?v=' + $cache) -OutFile '%ICON%';" >> "%SETUP_LOG%" 2>&1
if errorlevel 1 (
    call :fail "Erro ao baixar arquivos do GitHub. Confira a internet e mande o setup.log."
    exit /b 1
)

call :log "Iniciando instalador visual..."
set "IDV_SETUP_LOG=%SETUP_LOG%"
set "IDV_FORCE_SETUP=1"
call "%BOOTSTRAP%" >> "%SETUP_LOG%" 2>&1
if errorlevel 1 (
    call :fail "O instalador retornou erro. Mande o setup.log."
    exit /b 1
)

call :log "Setup finalizado."
if "%IDV_DEBUG%"=="0" exit /b 0
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

if exist "%INSTALL_LOG%" (
    echo Ultimas linhas do install.log:
    echo ----------------------------------------
    powershell -NoProfile -Command "Get-Content -LiteralPath '%INSTALL_LOG%' -Tail 80"
    echo ----------------------------------------
    echo.
)

echo Logs para debug:
echo   Setup: "%SETUP_LOG%"
echo   Install: "%INSTALL_LOG%"
echo   Agent: "%AGENT_LOG%"
echo.
echo Se o agent nao aparecer online, copie e mande esses dois logs.
echo Esta janela pode ser fechada.
echo.
pause
exit /b 0

:log
if "%IDV_DEBUG%"=="1" echo [%date% %time%] %~1
>> "%SETUP_LOG%" echo [%date% %time%] %~1
exit /b 0

:fail
call :log "ERRO: %~1"
if "%IDV_DEBUG%"=="0" (
    powershell -NoProfile -Command "& {Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('%~1`n`nLog: %SETUP_LOG%', 'IDV Tracker', 'OK', 'Error')}" >nul 2>&1
    exit /b 1
)
echo.
echo ERRO: %~1
echo.
echo Logs para mandar:
echo   "%SETUP_LOG%"
echo   "%AGENT_LOG%"
echo.
pause
exit /b 1
