@echo off
setlocal
cd /d "%~dp0.."
echo Open http://127.0.0.1:8123/3d/ in Chrome or Edge.
python -B -m http.server 8123 --bind 127.0.0.1 --directory "%CD%"
endlocal
