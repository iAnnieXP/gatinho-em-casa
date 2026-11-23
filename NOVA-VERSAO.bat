@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale em https://nodejs.org e rode de novo.
  pause
  exit /b
)
call npm version patch --no-git-tag-version
echo.
echo Versao aumentada (acima). Agora envie a pasta para o GitHub: o Render publica e os jogos se atualizam sozinhos.
pause
