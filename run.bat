@echo off
REM Double-click to open the Pocketsize app.
REM Pass a folder to queue it on launch:  run.bat "C:\path\to\images"

cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (set PYRUN=py -3) else (
  where python >nul 2>nul
  if %errorlevel%==0 (set PYRUN=python) else (
    echo Python was not found. Install it from https://www.python.org/downloads/
    echo and tick "Add python.exe to PATH" during setup.
    pause & exit /b 1
  )
)

%PYRUN% -c "import PIL, numpy, ssimulacra2, imagequant, zopfli" 2>nul
if not %errorlevel%==0 (
  echo First run - installing dependencies, this takes a minute...
  %PYRUN% -m pip install --quiet --upgrade -r requirements.txt
)

%PYRUN% -m pocketsize.gui %*
if not %errorlevel%==0 pause
