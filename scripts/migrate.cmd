@echo off
rem migrate.cmd - обёртка для запуска migrate.ps1 без настройки ExecutionPolicy.
rem Примеры:
rem   scripts\migrate.cmd check
rem   scripts\migrate.cmd deploy
rem   scripts\migrate.cmd serve
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0migrate.ps1" %*
