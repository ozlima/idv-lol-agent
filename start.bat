@echo off
title IDV LoL Agent
color 0A
chcp 65001 >nul

echo.
echo  ╔══════════════════════════════════════╗
echo  ║       IDV LoL Agent                  ║
echo  ║   Monitor de partidas em tempo real  ║
echo  ╚══════════════════════════════════════╝
echo.

:: Verifica Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERRO] Node.js nao encontrado.
    echo  Baixe e instale em: https://nodejs.org
    echo  Reinicie o PC apos instalar e tente de novo.
    echo.
    pause
    exit /b 1
)

:: Verifica Git
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo  [AVISO] Git nao encontrado — atualizacoes automaticas nao funcionarao.
    echo  Para habilitar: https://git-scm.com/download/win
    echo.
)

:: Verifica .env
if not exist ".env" (
    echo  [ERRO] Arquivo .env nao encontrado nesta pasta.
    echo  Contate o administrador para receber o arquivo .env.
    echo.
    pause
    exit /b 1
)

:: Instala dependencias na primeira vez
if not exist "node_modules\" (
    echo  Primeira execucao — instalando dependencias...
    echo  ^(pode demorar 1-2 minutos^)
    echo.
    call npm install --silent
    echo  Pronto!
    echo.
)

echo  Aguardando o League of Legends abrir...
echo  Mantenha esta janela aberta durante as partidas.
echo  Para fechar: pressione Ctrl+C ou feche a janela.
echo.
echo  ──────────────────────────────────────────
echo.

:loop
call npm run dev
if %errorlevel% == 42 (
    echo.
    echo  Reiniciando apos atualizacao...
    echo.
    goto loop
)

echo.
echo  Agent encerrado. Pressione qualquer tecla para fechar.
pause >nul
