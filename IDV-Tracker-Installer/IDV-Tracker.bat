@echo off
setlocal

set "SUPABASE_URL=https://tninlfmhruccphpncahs.supabase.co"
set "SUPABASE_ANON_KEY=sb_publishable_ILxcIFs_94-MnEc-AuDVVg_i8P0Eb1D"
set "REPO_ZIP=https://github.com/ozlima/idv-lol-agent/archive/refs/heads/master.zip"

set "BOOT_DIR=%~dp0"
set "APP_ROOT=%LOCALAPPDATA%\IDV Tracker"
set "DIR=%APP_ROOT%\idv-lol-agent"
set "BOOTSTRAP=%APP_ROOT%\IDV-Tracker.bat"
set "INSTALLER=%BOOT_DIR%installer.ps1"
set "ICON_PATH=%BOOT_DIR%icon.png"
set "NODE_DIR=%APP_ROOT%\runtime\node-v20.11.1-win-x64"

if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"

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

if exist "%DIR%\.installed" if exist "%DIR%\node_modules" (
    start "IDV Tracker" /MIN cmd /c ""%BOOTSTRAP%" --run"
    exit /b
)

if exist "%DIR%\.installed" del /f /q "%DIR%\.installed" >nul 2>&1

where node >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "& {Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Node.js portatil nao encontrado. Rode o IDV-Tracker-Setup.cmd novamente.', 'IDV Tracker', 'OK', 'Error')}"
    exit /b 1
)

if not exist "%DIR%\package.json" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $zip=Join-Path '%APP_ROOT%' 'agent.zip'; $tmp=Join-Path '%APP_ROOT%' 'agent-src'; if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }; if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }; if (Test-Path '%DIR%') { Remove-Item -LiteralPath '%DIR%' -Recurse -Force }; Invoke-WebRequest '%REPO_ZIP%' -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force; New-Item -ItemType Directory -Path '%DIR%' -Force | Out-Null; Copy-Item -Path (Join-Path $tmp 'idv-lol-agent-master\*') -Destination '%DIR%' -Recurse -Force; if (-not (Test-Path (Join-Path '%DIR%' 'package.json'))) { throw 'package.json nao foi extraido para a pasta do agent' }; $commit=(Invoke-RestMethod 'https://api.github.com/repos/ozlima/idv-lol-agent/commits/master').sha; Set-Content -LiteralPath (Join-Path '%DIR%' '.idv-version') -Value $commit -Encoding UTF8; Remove-Item -LiteralPath $zip -Force; Remove-Item -LiteralPath $tmp -Recurse -Force"
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
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"
cd /d "%DIR%"
:agentLoop
call npm run dev >> agent.log 2>&1
if %errorlevel%==42 (
    call npm install --silent >> agent.log 2>&1
    goto agentLoop
)
exit /b %errorlevel%
