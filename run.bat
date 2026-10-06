@echo off
cd /d %~dp0
if exist .env for /f "usebackq tokens=1,* delims==" %%a in (".env") do set "%%a=%%b"
cd backend
echo SliceBot console: http://127.0.0.1:8787
start "" http://127.0.0.1:8787
.venv\Scripts\uvicorn slicebot.api:app --host 127.0.0.1 --port 8787
