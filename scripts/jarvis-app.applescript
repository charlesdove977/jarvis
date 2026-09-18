on run
	set launcher to "/Users/user/Desktop/Development-Charlie-2/Charlieautomates/apps/jarvis/scripts/jarvis-app-launch.sh"
	display notification "Booting the brain and the face…" with title "J.A.R.V.I.S."
	-- Backgrounded with & and detached stdio so osascript returns at once and
	-- never holds (or reaps) the servers the launcher starts.
	do shell script "/bin/zsh -lic " & quoted form of launcher & " >/dev/null 2>&1 &"
end run
