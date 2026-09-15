@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer.ps1"
echo.
powershell.exe -NoProfile -Command "Write-Host ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5oyJ5Lu75oSP6ZSu5YWz6Zet5q2k56qX5Y+jLi4u')))"
pause >nul

