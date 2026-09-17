#!/bin/zsh
# Relaunch the local JARVIS (bridge + face) with the same env it was started
# with: workspace mode, writes on, and the Fish Audio key lifted off the
# running process so it never has to be typed. Local convenience only.
set -u
DIR=/Users/user/Desktop/Development-Charlie-2/Charlieautomates/apps/jarvis
cd "$DIR"
B=$(lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null | head -1)
FISH=""
if [ -n "$B" ]; then
  FISH=$(ps eww -o command -p "$B" | grep -o "FISH_AUDIO_API_KEY=[^ ]*" | head -1)
  P=$(ps -o ppid= -p "$B" | tr -d ' ')
  kill $P $B $(lsof -tiTCP:5173 -sTCP:LISTEN 2>/dev/null) 2>/dev/null
  sleep 2
fi
: > jarvis-run.log
if [ -n "$FISH" ]; then
  env JARVIS_WORKSPACE=/Users/user/Desktop/Development-Charlie-2/Charlieautomates "$FISH" nohup node scripts/start.mjs --writes >> jarvis-run.log 2>&1 &
else
  env JARVIS_WORKSPACE=/Users/user/Desktop/Development-Charlie-2/Charlieautomates nohup node scripts/start.mjs --writes >> jarvis-run.log 2>&1 &
fi
sleep 8
curl -s http://localhost:8787/health; echo
