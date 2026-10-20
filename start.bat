@echo off
title JiaJia AI Voice Assistant
echo ==========================================
echo   [JiaJia] AI Yu Yin Zhu Shou
echo ==========================================
echo.
echo Starting services (server 8000/8003 + UI 8006)...
echo Old instances on these ports will be stopped first.
echo.
echo Keep this window open. Closing it stops all services.
echo.
"%~dp0venv-xiaozhi\Scripts\python.exe" "%~dp0supervisor.py"
echo.
echo Supervisor exited.
pause
