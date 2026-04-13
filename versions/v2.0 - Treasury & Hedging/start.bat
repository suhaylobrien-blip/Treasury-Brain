@echo off
REM Treasury Brain — Startup Script
REM Starts the Flask server and folder watcher together.

SET PYTHON=C:\Users\SuhaylO'Brien\AppData\Local\Programs\Python\Python312\python.exe
SET ROOT=%~dp0

echo.
echo =============================================
echo   Treasury Brain ^— SA Bullion
echo =============================================
echo.

REM Initialise DB and auto-import source sheets if empty
echo Checking database...
"%PYTHON%" "%ROOT%backend\startup.py"
echo.

REM Apply end-of-day positions (safe to re-run every startup)
"%PYTHON%" "%ROOT%backend\seed_positions.py"
echo.

echo Starting web server on http://localhost:5000
echo Drop new dealer sheets into data\inbox\ to auto-process.
echo Open http://localhost:5000 in your browser.
echo Press Ctrl+C to stop.
echo.

REM Start watcher in background
start "Treasury Brain Watcher" "%PYTHON%" "%ROOT%backend\watcher.py"

REM Start Flask server (foreground)
"%PYTHON%" "%ROOT%backend\app.py"
