@echo off
chcp 65001 >nul
title Novel-to-EPUB
setlocal

cd /d "%~dp0electron"

if not exist "..\backend\.venv\Scripts\python.exe" (
    echo [ERRO] Python do backend nao encontrado em "backend\.venv\Scripts\python.exe".
    echo Rode a instalacao do backend antes de iniciar.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [ERRO] Dependencias do Electron nao encontradas em "electron\node_modules".
    echo Rode "npm install" dentro da pasta "electron" antes de iniciar.
    pause
    exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ERRO] npm.cmd nao encontrado no PATH. Verifique a instalacao do Node.js.
    pause
    exit /b 1
)

echo Iniciando Novel-to-EPUB (backend + interface)...
echo Feche a janela do aplicativo para encerrar tudo.
echo.

call npm.cmd run dev
if errorlevel 1 (
    echo.
    echo [ERRO] O aplicativo encerrou com falha. Veja os detalhes acima.
    pause
    exit /b 1
)
