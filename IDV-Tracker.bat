@echo off
set SUPABASE_URL=https://tninlfmhruccphpncahs.supabase.co
set SUPABASE_ANON_KEY=sb_publishable_ILxcIFs_94-MnEc-AuDVVg_i8P0Eb1D
set DIR=%~dp0idv-lol-agent

if /I "%~1"=="--run" goto runAgent

:: Atualiza credenciais (caso o .bat mude)
if exist "%DIR%\.env" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$envText = 'SUPABASE_URL=' + $env:SUPABASE_URL + \"`r`n\" + 'SUPABASE_ANON_KEY=' + $env:SUPABASE_ANON_KEY; Set-Content -LiteralPath '%DIR%\.env' -Value $envText -Encoding UTF8"
)

:: Ja instalado: inicia agent direto (sem GUI)
if exist "%DIR%\.installed" (
    start "IDV Tracker" /MIN cmd /c ""%~f0" --run"
    exit /b
)

:: Primeira vez: clona o repositorio
if not exist "%DIR%\.git" (
    git clone https://github.com/ozlima/idv-lol-agent.git "%DIR%" --quiet 2>nul
    if %errorlevel% neq 0 (
        powershell -Command "& {Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Erro ao baixar o IDV Tracker. Verifique sua conexao com a internet.', 'IDV Tracker', 'OK', 'Error')}"
        exit /b 1
    )
)

:: Lanca o installer GUI
set IDV_TARGET_DIR=%DIR%
set IDV_ICON_PATH=%DIR%\icon.png
powershell -ExecutionPolicy Bypass -File "%DIR%\installer.ps1"
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
