@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale em https://nodejs.org e rode de novo.
  pause
  exit /b
)
call npm install
call npm run dist
echo.
echo Pronto! O jogo esta em: dist\GatinhoEmCasa.exe
pause
