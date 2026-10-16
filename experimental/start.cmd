@echo off
rem ===========================================================================
rem  CAJ 阅读器 — Windows 一键启动
rem  需要 Node.js 18+（仅用于起一个本地静态服务，不做任何转换运算）
rem ===========================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js。
  echo   请先安装：https://nodejs.org/   ^(建议 LTS 版本^)
  echo.
  pause
  exit /b 1
)

set PORT=8080
if not "%~1"=="" set PORT=%~1

echo.
echo   正在启动 CAJ 阅读器...
echo.
node serve.js --port %PORT%
pause
