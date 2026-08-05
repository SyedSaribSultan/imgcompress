@echo off
REM Command-line version. Drop images in input\ and double-click,
REM or pass a folder:  compress.bat "C:\path\to\images"
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (set PYRUN=py -3) else (set PYRUN=python)
%PYRUN% compress.py %*
echo.
pause
