@echo off
chcp 65001 >nul
title Prenotazioni Ristorante
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js non e' installato su questo computer.
  echo   Scaricalo da https://nodejs.org ^(versione LTS^), installalo e riprova.
  echo.
  pause
  exit /b 1
)

echo.
echo   ==========================================
echo     SISTEMA DI PRENOTAZIONE - AVVIO
echo   ==========================================
echo.
echo   Lascia aperta questa finestra mentre lavori.
echo   Per spegnere il sistema chiudi questa finestra.
echo.

rem apre il browser dopo qualche secondo, quando il sistema e' pronto
start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:3000"

node --disable-warning=ExperimentalWarning server.js

echo.
echo   Premi un tasto per chiudere questa finestra.
pause >nul
