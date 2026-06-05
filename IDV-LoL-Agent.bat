@echo off
chcp 65001 >nul
title IDV LoL Agent

:: ════════════════════════════════════════════════════
::  Preencha as credenciais abaixo antes de enviar:
set SUPABASE_URL=https://COLE_AQUI.supabase.co
set SUPABASE_ANON_KEY=COLE_AQUI_A_ANON_KEY
:: ════════════════════════════════════════════════════

set DIR=%~dp0idv-lol-agent

echo.
echo  ╔══════════════════════════════════════╗
echo  ║       IDV LoL Agent                  ║
echo  ║   Monitor de partidas em tempo real  ║
echo  ╚══════════════════════════════════════╝
echo.

:: ── Node.js ──────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Node.js nao encontrado.
    echo      Abrindo pagina de download...
    echo      Instale, reinicie o PC e clique neste arquivo de novo.
    echo.
    start https://nodejs.org/en/download
    pause
    exit /b 1
)

:: ── Git ──────────────────────────────────────────────
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Git nao encontrado.
    echo      Abrindo pagina de download...
    echo      Instale, reinicie o PC e clique neste arquivo de novo.
    echo.
    start https://git-scm.com/download/win
    pause
    exit /b 1
)

:: ── Download (so na primeira vez) ───────────────────
if not exist "%DIR%\.git" (
    echo  Baixando o agent pela primeira vez...
    echo  ^(aguarde, pode demorar alguns segundos^)
    echo.
    git clone https://github.com/ozlima/idv-lol-agent.git "%DIR%" --quiet
    if %errorlevel% neq 0 (
        echo  [ERRO] Falha ao baixar. Verifique sua conexao com a internet.
        pause
        exit /b 1
    )
    echo  Download concluido!
    echo.
)

:: ── Cria/atualiza o .env com as credenciais ─────────
echo SUPABASE_URL=%SUPABASE_URL%> "%DIR%\.env"
echo SUPABASE_ANON_KEY=%SUPABASE_ANON_KEY%>> "%DIR%\.env"

cd /d "%DIR%"

:: ── Dependencias (so na primeira vez) ───────────────
if not exist "node_modules\" (
    echo  Instalando dependencias ^(so acontece uma vez^)...
    call npm install --silent
    if %errorlevel% neq 0 (
        echo  [ERRO] Falha ao instalar dependencias.
        pause
        exit /b 1
    )
    echo  Pronto!
    echo.
)

echo  Tudo configurado! Aguardando o League of Legends...
echo  Mantenha esta janela aberta durante as partidas.
echo  Para encerrar: pressione Ctrl+C ou feche a janela.
echo.
echo  ────────────────────────────────────────────────
echo.

:loop
call npm run dev
if %errorlevel% == 42 (
    echo  Atualizacao recebida. Reiniciando...
    call npm install --silent >nul 2>&1
    echo.
    goto loop
)

echo.
echo  Agent encerrado.
pause
