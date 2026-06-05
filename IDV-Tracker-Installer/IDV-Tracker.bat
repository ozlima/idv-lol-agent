@echo off
setlocal

set "SUPABASE_URL=https://tninlfmhruccphpncahs.supabase.co"
set "SUPABASE_ANON_KEY=sb_publishable_ILxcIFs_94-MnEc-AuDVVg_i8P0Eb1D"
set "REPO_URL=https://github.com/ozlima/idv-lol-agent.git"

set "BOOT_DIR=%~dp0"
set "APP_ROOT=%LOCALAPPDATA%\IDV Tracker"
set "DIR=%APP_ROOT%\idv-lol-agent"
set "BOOTSTRAP=%APP_ROOT%\IDV-Tracker.bat"
set "INSTALLER=%BOOT_DIR%installer.ps1"
set "ICON_PATH=%BOOT_DIR%icon.png"

if /I "%~1"=="--run" goto runAgent

if not exist "%APP_ROOT%" mkdir "%APP_ROOT%" >nul 2>&1
copy /Y "%~f0" "%BOOTSTRAP%" >nul 2>&1
if exist "%ICON_PATH%" copy /Y "%ICON_PATH%" "%APP_ROOT%\icon.png" >nul 2>&1

if not exist "%INSTALLER%" if exist "%APP_ROOT%\installer.ps1" set "INSTALLER=%APP_ROOT%\installer.ps1"
if exist "%BOOT_DIR%installer.ps1" copy /Y "%BOOT_DIR%installer.ps1" "%APP_ROOT%\installer.ps1" >nul 2>&1
if exist "%APP_ROOT%\icon.png" set "ICON_PATH=%APP_ROOT%\icon.png"

if exist "%DIR%\.env" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$envText = 'SUPABASE_URL=' + $env:SUPABASE_URL + \"`r`n\" + 'SUPABASE_ANON_KEY=' + $env:SUPABASE_ANON_KEY; Set-Content -LiteralPath '%DIR%\.env' -Value $envText -Encoding UTF8"
)

if exist "%DIR%\.installed" (
    start "IDV Tracker" /MIN cmd /c ""%BOOTSTRAP%" --run"
    exit /b
)

where node >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "& {Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Node.js nao encontrado. Instale em https://nodejs.org e tente novamente.', 'IDV Tracker', 'OK', 'Error')}"
    exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "& {Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Git nao encontrado. Instale em https://git-scm.com/download/win e tente novamente.', 'IDV Tracker', 'OK', 'Error')}"
    exit /b 1
)

if not exist "%DIR%\.git" (
    if not exist "%APP_ROOT%" mkdir "%APP_ROOT%" >nul 2>&1
    git clone "%REPO_URL%" "%DIR%" --quiet
    if errorlevel 1 (
        powershell -NoProfile -Command "& {Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Erro ao baixar o IDV Tracker. Verifique sua conexao com a internet.', 'IDV Tracker', 'OK', 'Error')}"
        exit /b 1
    )
)

set "IDV_TARGET_DIR=%DIR%"
set "IDV_ICON_PATH=%ICON_PATH%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER%"
exit /b

:runAgent
cd /d "%DIR%"
:agentLoop
call npm run dev >> agent.log 2>&1
if %errorlevel%==42 (
    call npm install --silent >> agent.log 2>&1
    goto agentLoop
)
exit /b %errorlevel%
