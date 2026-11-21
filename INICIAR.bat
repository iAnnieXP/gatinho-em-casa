@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale em https://nodejs.org e rode este arquivo de novo.
  pause
  exit /b
)
start "" http://localhost:3000
echo Servidor ligado. Feche esta janela para desligar.
node server.js
pause
