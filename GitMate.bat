@echo off
rem 直接启动 electron.exe（GUI 程序，无控制台窗口）
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
