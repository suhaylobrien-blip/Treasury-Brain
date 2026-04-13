@echo off
REM ================================================================
REM  save-version.bat  —  Treasury Brain Version Snapshot Tool
REM
REM  Usage:
REM    save-version.bat 1.0 "Initial Release"
REM    save-version.bat 1.1 "Spot price improvements"
REM    save-version.bat 2.0 "Products page launch"
REM ================================================================
setlocal EnableDelayedExpansion

REM ── Argument validation ─────────────────────────────────────────
if "%~1"=="" (
    echo.
    echo  ERROR: You must provide a version number.
    echo.
    echo  Usage:  save-version.bat 1.0 "Initial Release"
    echo          save-version.bat 1.1 "Spot price improvements"
    echo.
    pause
    exit /b 1
)

SET VERSION=%~1
SET DESCRIPTION=%~2
SET ROOT=%~dp0

REM Strip trailing backslash from ROOT
if "%ROOT:~-1%"=="\" SET ROOT=%ROOT:~0,-1%

REM ── Sanitise description: replace & with "and" so folder names are
REM    safe to double-click in Windows Explorer (& breaks cmd.exe parsing)
SET DESCRIPTION=!DESCRIPTION:&=and!

REM ── Build folder name ────────────────────────────────────────────
if "%DESCRIPTION%"=="" (
    SET FOLDER_NAME=v%VERSION%
    SET TAG_MSG=v%VERSION%
) else (
    SET FOLDER_NAME=v%VERSION% - %DESCRIPTION%
    SET TAG_MSG=v%VERSION% - %DESCRIPTION%
)

SET SNAPSHOT_DIR=%ROOT%\versions\%FOLDER_NAME%

REM ── Check version doesn't already exist ─────────────────────────
if exist "%SNAPSHOT_DIR%" (
    echo.
    echo  ERROR: Version "%FOLDER_NAME%" already exists.
    echo  Choose a different version number, or delete the existing folder first.
    echo.
    pause
    exit /b 1
)

REM ── Check git is available ───────────────────────────────────────
git --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  ERROR: git is not installed or not on your PATH.
    echo  Download Git from https://git-scm.com/download/win
    echo.
    pause
    exit /b 1
)

REM ── Get today's date ─────────────────────────────────────────────
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set DATETIME=%%I
SET DATESTAMP=!DATETIME:~0,4!-!DATETIME:~4,2!-!DATETIME:~6,2!

REM ── Print preview ────────────────────────────────────────────────
echo.
echo  ================================================================
echo   Treasury Brain  —  Save Version
echo  ================================================================
echo.
echo   Version  :  %FOLDER_NAME%
echo   Date     :  %DATESTAMP%
echo   Snapshot :  versions\%FOLDER_NAME%\
echo   Git tag  :  v%VERSION%
echo   GitHub   :  https://github.com/suhaylobrien-blip/Treasury-Brain
echo.
echo  Steps that will run:
echo    1. Copy frontend\, backend\, config\, requirements.txt to snapshot folder
echo    2. Create CHANGES.md in the snapshot folder
echo    3. git add -A
echo    4. git commit -m "version: %TAG_MSG%"
echo    5. git tag v%VERSION%
echo    6. git push origin main --tags
echo.
echo  ================================================================
echo.
set /p CONFIRM="  Type YES to proceed, or anything else to cancel: "
if /i not "!CONFIRM!"=="YES" (
    echo.
    echo  Cancelled. No changes made.
    echo.
    pause
    exit /b 0
)

echo.

REM ── Create folder structure ──────────────────────────────────────
echo  [1/6] Creating snapshot folder...
mkdir "%SNAPSHOT_DIR%"
mkdir "%SNAPSHOT_DIR%\frontend"
mkdir "%SNAPSHOT_DIR%\backend"
mkdir "%SNAPSHOT_DIR%\config"

REM ── Copy files ───────────────────────────────────────────────────
echo  [2/6] Copying files...

for %%F in ("%ROOT%\frontend\*.*") do (
    copy "%%F" "%SNAPSHOT_DIR%\frontend\" >nul
)

for %%F in ("%ROOT%\backend\*.py") do (
    copy "%%F" "%SNAPSHOT_DIR%\backend\" >nul
)

for %%F in ("%ROOT%\config\*.*") do (
    copy "%%F" "%SNAPSHOT_DIR%\config\" >nul
)

copy "%ROOT%\requirements.txt" "%SNAPSHOT_DIR%\" >nul
copy "%ROOT%\start.bat"       "%SNAPSHOT_DIR%\" >nul

REM ── Create CHANGES.md ────────────────────────────────────────────
echo  [3/6] Creating CHANGES.md...

(
echo # %FOLDER_NAME%
echo.
echo **Date:** %DATESTAMP%
echo.
echo ## What changed in this version
echo.
echo - ^<!-- Add your notes here --^>
echo.
echo ## Files included
echo.
echo - frontend/index.html
echo - frontend/dashboard.js
echo - frontend/style.css
echo - frontend/products.html
echo - backend/app.py
echo - backend/models.py
echo - backend/importer.py
echo - backend/processor.py
echo - backend/spot_prices.py
echo - backend/excel_writer.py
echo - backend/watcher.py
echo - backend/startup.py
echo - backend/seed_positions.py
echo - backend/sheets.py
echo - config/settings.json
echo - config/products.json
echo - requirements.txt
) > "%SNAPSHOT_DIR%\CHANGES.md"

REM ── Create versions/README.txt on first run ───────────────────────
if not exist "%ROOT%\versions\README.txt" (
    (
    echo Treasury Brain — Version Snapshots
    echo ===================================
    echo.
    echo Each folder is a complete snapshot of the app at a specific version.
    echo.
    echo To RESTORE a version:
    echo   1. Open the version folder in File Explorer
    echo   2. Select all (Ctrl+A) and Copy (Ctrl+C)
    echo   3. Navigate to the project root and Paste (Ctrl+V)
    echo   4. Confirm "Replace" when prompted
    echo   5. Run start.bat
    echo.
    echo Versions are also tagged in git and visible on GitHub:
    echo   https://github.com/suhaylobrien-blip/Treasury-Brain/tags
    ) > "%ROOT%\versions\README.txt"
)

REM ── Git operations ───────────────────────────────────────────────
cd /d "%ROOT%"

echo  [4/6] Staging all changes...
git add -A
if errorlevel 1 (
    echo.
    echo  ERROR: git add failed.
    pause
    exit /b 1
)

echo  [5/6] Committing and tagging...
git commit -m "version: %TAG_MSG%"
if errorlevel 1 (
    echo.
    echo  ERROR: git commit failed. There may be nothing new to commit.
    echo  Check git status and try again.
    pause
    exit /b 1
)

git tag v%VERSION%
if errorlevel 1 (
    echo.
    echo  ERROR: Tag v%VERSION% already exists in git.
    echo  Use a different version number.
    pause
    exit /b 1
)

echo  [6/6] Pushing to GitHub...
git push origin main --tags
if errorlevel 1 (
    echo.
    echo  WARNING: Push to GitHub failed.
    echo  The snapshot was saved locally and committed.
    echo  Check your internet connection, then run:
    echo    git push origin main --tags
    echo.
    pause
    exit /b 1
)

REM ── Done ─────────────────────────────────────────────────────────
echo.
echo  ================================================================
echo   Done!  Version %FOLDER_NAME% saved.
echo  ================================================================
echo.
echo   Local  :  versions\%FOLDER_NAME%\
echo   GitHub :  https://github.com/suhaylobrien-blip/Treasury-Brain/releases/tag/v%VERSION%
echo.
echo   Tip: Open CHANGES.md to add notes about what changed:
echo   notepad "%SNAPSHOT_DIR%\CHANGES.md"
echo.
pause
endlocal
