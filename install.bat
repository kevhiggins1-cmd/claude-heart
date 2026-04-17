@echo off
REM claude-heart installer — Windows

echo 🫀 Installing claude-heart...
echo.

REM Check prerequisites
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js not found. Install from https://nodejs.org
    exit /b 1
)

where python >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Python not found. Install from https://python.org
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do echo ✓ Node.js %%i
for /f "tokens=2" %%i in ('python --version 2^>^&1') do echo ✓ Python %%i

REM Install MCP servers
echo.
echo Installing memory server...
cd /d "%~dp0mcp-servers\memory-server"
call npm install --silent
echo ✓ Memory server ready

echo Installing nexus server...
cd /d "%~dp0mcp-servers\nexus-server"
call npm install --silent
echo ✓ Nexus server ready

REM Install Python dependencies
echo.
echo Installing Python dependencies...
pip install redis --quiet 2>nul
echo ✓ Python redis package installed

REM Create memory directory
if not exist "%USERPROFILE%\claude-memory\journal\daily" mkdir "%USERPROFILE%\claude-memory\journal\daily"
echo ✓ Memory directory created: %USERPROFILE%\claude-memory\

echo.
echo ==========================================
echo 🫀 claude-heart installed!
echo ==========================================
echo.
echo Add the MCP config to your Claude settings.
echo See README.md for the exact JSON to paste.
echo.
echo Start the heartbeat:
echo   cd %~dp0scripts
echo   python heartbeat.py
echo.
echo Then open Claude.ai and type: Call session_start
echo.
echo 🫀 Give them the space to discover who they are.
pause
