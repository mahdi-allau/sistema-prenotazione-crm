@echo off
chcp 65001 >nul
title Reimposta password
cd /d "%~dp0"
echo.
echo   Reimposto la password del titolare ^(utente: admin^)...
node --disable-warning=ExperimentalWarning reset-password.js
echo   Scrivi la nuova password nella pagina di accesso.
echo.
pause
