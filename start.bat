@echo off
REM Treasury Brain — Startup Script
REM Starts the Flask server and folder watcher together.

SET PYTHON=C:\Users\SuhaylO'Brien\AppData\Local\Programs\Python\Python312\python.exe

echo.
echo =============================================
echo   Treasury Brain — SA Bullion
echo =============================================
echo.

REM Initialise DB if not present
if not exist "data\treasury.db" (
    echo Initialising database...
    "%PYTHON%" backend\models.py
)

echo Starting web server on http://localhost:5000
echo Starting folder watcher on data\inbox\
echo.
echo Drop dealer Excel files into data\inbox\ to auto-process.
echo Open http://localhost:5000 in your browser for the live dashboard.
echo Press Ctrl+C to stop.
echo.

REM Start watcher in background
start "Treasury Brain Watcher" "%PYTHON%" backend\watcher.py

REM Start Flask server (foreground)
"%PYTHON%" backend\app.py
