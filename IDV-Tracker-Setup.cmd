@echo off
setlocal

set "APP_ROOT=%LOCALAPPDATA%\IDV Tracker"
set "SETUP_DIR=%APP_ROOT%\setup"
set "REPO_RAW=https://raw.githubusercontent.com/ozlima/idv-lol-agent/master"
set "BOOTSTRAP=%SETUP_DIR%\IDV-Tracker.bat"
set "INSTALLER=%SETUP_DIR%\installer.ps1"
set "ICON=%SETUP_DIR%\icon.png"

if not exist "%SETUP_DIR%" mkdir "%SETUP_DIR%" >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
  "Invoke-WebRequest '%REPO_RAW%/IDV-Tracker.bat' -OutFile '%BOOTSTRAP%';" ^
  "Invoke-WebRequest '%REPO_RAW%/installer.ps1' -OutFile '%INSTALLER%';" ^
  "Invoke-WebRequest '%REPO_RAW%/icon.png' -OutFile '%ICON%';"

if errorlevel 1 (
    powershell -NoProfile -Command "& {Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Erro ao baixar o instalador. Verifique sua conexao com a internet.', 'IDV Tracker', 'OK', 'Error')}"
    exit /b 1
)

call "%BOOTSTRAP%"
