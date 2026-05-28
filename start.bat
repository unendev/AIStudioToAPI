@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [AIStudioToAPI] 正在启动服务...
echo [AIStudioToAPI] 代理: http://127.0.0.1:7897

set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
set TZ=Asia/Shanghai

node main.js
if errorlevel 1 goto error
exit /b 0

:error
echo.
echo [ERROR] Service crashed with exit code %errorlevel%
pause
