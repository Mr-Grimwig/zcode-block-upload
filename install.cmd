@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "NODE="
for %%P in (node.exe) do if not defined NODE set "NODE=%%~$PATH:P"
if not defined NODE if exist "D:\Nodejs\node.exe" set "NODE=D:\Nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%APPDATA%\nvm\node.exe" set "NODE=%APPDATA%\nvm\node.exe"
if not defined NODE (
  echo.
  echo [x] node.exe not found. Please install Node.js from https://nodejs.org
  echo     then run install.cmd again.
  echo.
  pause
  exit /b 1
)
"%NODE%" "%~dp0setup.js" %*
echo.
pause
