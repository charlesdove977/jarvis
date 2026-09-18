#!/bin/zsh
# Boot JARVIS locally and open it in Chrome. Meant to be run from a login shell
# (the Desktop app calls it via `zsh -lic`) so ~/.zshrc is sourced and the
# FISH_AUDIO_API_KEY export is present. Safe to run when JARVIS is already up:
# it reuses the running bridge and just opens the tab.
set -u
DIR="/Users/user/Desktop/Development-Charlie-2/Charlieautomates/apps/jarvis"
WORKSPACE="/Users/user/Desktop/Development-Charlie-2/Charlieautomates"
URL="http://localhost:5173"
cd "$DIR" || exit 1

# Already listening? Just open the tab.
if ! curl -s -o /dev/null "http://localhost:8787/health"; then
  : > jarvis-run.log
  # --writes = actions on; workspace mode = your CLAUDE.md, memory, hooks, MCPs.
  # FISH_AUDIO_API_KEY rides in from the login shell if it is exported there.
  # Fully detached: </dev/null frees the controlling terminal and `disown`
  # drops it from this shell's job table, so it survives the Desktop app's
  # AppleScript quitting. Without this the servers were killed the instant the
  # app finished launching.
  JARVIS_WORKSPACE="$WORKSPACE" nohup node scripts/start.mjs --writes </dev/null >> jarvis-run.log 2>&1 &
  disown
  # Wait for the face to answer, up to ~40s.
  for i in {1..80}; do
    curl -s -o /dev/null "$URL" && break
    sleep 0.5
  done
fi

open -a "Google Chrome" "$URL"
