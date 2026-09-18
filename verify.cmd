@echo off
chcp 65001 >nul
node "%~dp0zcode-block-upload.js" --verify %*
pause
