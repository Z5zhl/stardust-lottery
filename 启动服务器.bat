@echo off
chcp 65001 >nul
title 星尘抽奖 - 服务器
cd /d "%~dp0"

echo.
echo ========================================
echo   星尘抽奖 V1 - 启动中
echo ========================================
echo.
echo   目录: %cd%
echo.

:: 检查 Node.js 是否安装
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   ❌ 未找到 Node.js，请先安装!
    echo.
    echo   下载地址: https://nodejs.org
    echo   推荐安装 LTS 版本，安装后重启此程序
    echo.
    pause
    exit /b 1
)

echo   ✓ Node.js 已就绪
echo.

:: 检查并释放端口
netstat -ano | findstr ":9999" >nul
if %errorlevel%==0 (
    echo   端口 9999 已被占用，尝试释放...
    for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":9999"') do (
        taskkill /F /PID %%P >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
)

echo   正在启动服务器...
echo.
echo   启动后请用浏览器打开:
echo   http://localhost:9999/gesture-particles/stardust-lottery.html
echo.
echo   按 Ctrl+C 可停止服务器
echo ========================================
echo.

node server.js
pause