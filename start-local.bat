@echo off
echo === Polako Smeta — локальный запуск ===

REM Загружаем переменные из .env.local
for /f "usebackq tokens=1,* delims==" %%a in (".env.local") do (
  if not "%%a"=="" if not "%%a:~0,1%"=="#" set "%%a=%%b"
)

echo Запускаю сервер на http://localhost:3000
echo Для остановки нажми Ctrl+C
echo.

node server.js
