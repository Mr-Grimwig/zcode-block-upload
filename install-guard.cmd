@echo off
chcp 65001 >nul
node "%~dp0guard-install.js" %*
pause
