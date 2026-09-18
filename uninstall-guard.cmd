@echo off
chcp 65001 >nul
node "%~dp0guard-uninstall.js" %*
pause
