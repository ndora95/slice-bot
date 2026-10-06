@echo off
cd /d %~dp0
python -m venv backend\.venv
backend\.venv\Scripts\pip install -q --upgrade pip
backend\.venv\Scripts\pip install -q -r backend\requirements.txt
cd frontend && call npm install --no-audit --no-fund && call npm run build && cd ..
cd backend && set SLICEBOT_ENGINE=offline&& .venv\Scripts\python -m slicebot.data.generate > nul && cd ..
echo Setup done. Start with run.bat
