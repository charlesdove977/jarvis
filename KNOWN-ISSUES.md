# JARVIS — Known Issues (running record)

Collected from live testing on 2026-09-18. Nothing here is fixed yet unless it
says FIXED. The plan is to fix the open ones in one pass. Evidence is from
Charles's screen recordings and screenshots plus code reading; file:line refs
point at the current code.

Legend: **P1** = breaks core use, **P2** = confusing/rough, **P3** = polish.

---

## Voice input (the big one)

### 1. [P1] Captured speech does not auto-submit — only Space forces it
- **Symptom:** You speak, the words appear in the transcript, but nothing is
  sent. Pressing Space submits it (and often submits the earlier held copy too).
- **Evidence:** Video "Testing Voice Capture"; collab-check screenshots show
  "can we run the collab check can we run collab check" as one YOU line — the
  first copy was held, the Space-forced repeat flushed both together.
- **Root cause:** Chrome's recognizer keeps the phrase as *interim* and often
  never emits a *final*, so the silence timer that would submit keeps resetting
  and never fires. Endpointing in `src/lib/voice.ts` (`makeAssembler`,
  `bumpSilence` ~700ms, `holdFor`).
- **Fix direction:** Force a final flush on the silence timer instead of waiting
  for `isFinal`; submit held text on real silence.
- **BOTH directions confirmed:** it also submits TOO EARLY — 2026-09-18 screenshot,
  user said "can you send them all together now", only "can you" was submitted and
  JARVIS replied "You were cut off after 'can you', sir." Chrome fires a false
  final on a brief pause. This is why the real fix is #6 local Whisper STT: VAD
  records the whole utterance and Whisper transcribes it once, killing both the
  never-submits and the submits-too-early failure modes.
- **DECISION (2026-09-18):** local Whisper STT is the FIRST fix, ahead of the
  rest — it is the root of #1/#3/#6/#14 and most of "answering the wrong thing".

### 2. [P1] Duplicate transcript ("X X")
- **Symptom:** The same phrase shows twice back to back.
- **Root cause:** Same as #1 — held text flushes together with the repeat.
- **Fix direction:** Falls out of #1; also the emit-dedup already added
  (`lastEmitted`) needs to cover the held-then-Space path.

### 3. [P1] Wake word captured but does not fire
- **Symptom:** Caption shows "hey jarvis, find me a loading animation" yet status
  stays STANDBY; never wakes.
- **Evidence:** Video frame 6.
- **Root cause:** Suspected same endpointing gap — the wake emit never fires
  because the result stays interim. Needs the #1 fix, then re-verify.

### 4. [P2] NOISE STRICT suppresses commands spoken right after JARVIS
- **Symptom:** A command said while/just after JARVIS speaks is captured to the
  log but not run, until Space.
- **Root cause:** Strict mode treats nothing as the user while he speaks
  (guard threshold Infinity in the VAD path; browser path word-gate).
- **Note:** Charles asked to LEAVE the noise setting alone. The #1 endpointing
  fix should make the captured text submit on silence regardless.

### 5. [P1] Spacebar / Escape / M stolen by focused buttons
- **Symptom:** After clicking CAMERA / SCREEN / SETTINGS / NOISE, Space just
  re-clicks that button instead of starting a turn.
- **Root cause:** Keydown guard at `src/App.tsx:709-710` only ignores INPUT and
  TEXTAREA, not buttons; HUD buttons never blur after click.
- **Fix direction:** Blur each HUD button after click; let the global handler
  own Space/Escape/M regardless of focus.

### 6. [P2] Chrome speech recognizer is flaky under load (secondary)
- **Symptom:** Intermittent "hears nothing" while the pulse still moves.
- **Root cause:** `webkitSpeechRecognition` ships audio to Google and is starved
  by a screen recorder (Loom) + ~30 open tabs; goes silent on network/aborted.
- **Fix direction (backlog):** Local Whisper STT in the bridge (`/stt`), reusing
  the existing VAD segment recorder. Free, reliable, no API key. Charles thinks
  the lag is network, so parked unless #1 doesn't fully resolve it.

---

## Queue + transcript

### 7. [P1] Queue redesign — coalesce instead of one-by-one (target spec)
- **Symptom:** Each thing said while busy becomes its own separate turn, run
  one at a time, out of order, half-shown. Feels like it lags and catches up;
  "the queue system is shit."
- **Current behaviour:** `enqueue(said)` at `src/App.tsx:385` (no `pushTurn`),
  drains one item per turn in `respond()`'s finally (`src/App.tsx:~248`); shows
  only in the side `UP NEXT` box (`src/ui/Hud.tsx:460`).
- **Target design (Charles, 2026-09-18):**
  - **Default = coalesce.** Things said while working ACCUMULATE and, when the
    current turn finishes, MERGE into ONE combined instruction (order preserved),
    run as a single response — not N separate turns.
  - **Escape = interrupt + re-plan.** Pressing Escape stops the current work,
    folds ALL queued items into what he was doing, re-optimizes the current task
    with the new info, and continues as one combined effort. Not a hard stop.
  - Show what was captured inline/clearly so it never feels lost.
- **Depends on:** #1 (clean endpointing) so captured text is accurate before it
  is merged. Escape re-plan reuses the existing interrupt path (`cutOff`).

### 8. [P3] Reactor colour states are unexplained
- **Symptom:** "It was purple running collab check then went green." Reads as a
  glitch; it is not.
- **Root cause / truth:** Colours are per-phase (`src/store.ts` phaseColor):
  tooling = purple `#a97bff`, speaking = green `#3ef2a8`, listening = teal
  `#19d8d2`, thinking = amber `#f0a93c`. Correct behaviour, no legend.
- **Fix direction:** Optional tiny legend, or leave as-is once documented.

---

## Interface

### 9. [P1] WebGL context loss → black / glitch flashes
- **Symptom:** The whole thing skips and turns black.
- **Root cause:** No `webglcontextlost` / `webglcontextrestored` handler in
  `src/scene/` — under GPU pressure (recorder + many tabs) the context drops and
  nothing recovers it.
- **Fix direction:** Listen for the events on the canvas, preventDefault on lost,
  restore the renderer on restored.

### 10. [P2] Remove the right-side text-box cards (panels)
- **Symptom:** Small closable text cards on the right are not the terminal vibe.
- **Root cause / where:** `panel` display cards — `Panels.tsx` (`slot:'right'`),
  CSS `.panels-right` (`src/index.css`), pushed via `watchPanels` →
  `pushPanel` (`src/App.tsx:458`), authored by the bridge `display` tool
  (`bridge/panels.mjs`).
- **Decision needed:** Kill panels entirely (bridge `display` always makes a
  blade), or just hide the cards. Charles leaning: terminal vibe only.

---

## Transcript fidelity + behaviour

### 14. [P1] On-screen transcript diverges from what was actually said
- **Symptom:** "The on-screen text vs the inputs coming through don't match up."
  Displayed YOU lines are misheard, merged, or lagged.
- **Evidence:** Screenshot 2026-09-18 — log shows "draft them and answer them and
  send them" while UP NEXT shows "draft them all and send them all" (same intent,
  different captured slice); earlier lines read as approximate paraphrases.
- **Root cause:** This is the *visible* symptom of #1/#2 (hold-then-flush merges
  fragments), #6 (Chrome mis-transcription under load), and #7 (queue captures a
  different moment than the transcript). The screen is a reconstruction, not a
  faithful record.
- **Fix direction:** Falls out of #1 (clean endpointing) + #6 (reliable STT). No
  separate fix; verify fidelity after those land.

### 15. [P2] Over-asks / opens a blade per item instead of just acting
- **Symptom:** "Why do you keep opening all these blades, just answer them all."
  JARVIS narrates each draft and asks "send, edit, or skip?" instead of doing
  the batch.
- **Root cause:** Opus-5 + full workspace prompt is cautious and chatty; the
  `display` tool opens a blade per step.
- **Fix direction:** Part of #13 lean voice profile + a "batch and act, do not
  narrate each step or ask per item unless it is destructive" instruction; ties
  to #10 (fewer on-screen cards).

---

## Performance

### 13. [P1] Slow — "gets slow, can't keep up with me"
- **Symptom:** Laggy, unresponsive, slow to answer.
- **Root cause (config, confirmed from log 2026-09-18):**
  - Model = `claude-opus-5` — heaviest/slowest model, wrong for real-time voice.
  - Workspace mode loads the **full BASE hook pipeline on every turn** (DOMAIN
    injections, DEVMODE, TRAITS, relay contract, CLAUDE.md, memory) — thousands
    of coding-agent tokens per spoken turn, reprocessed each time.
  - **38 MCP servers** loaded — every tool definition sits in context.
  - Endpointing lag (#1) adds to the felt slowness.
- **Immediate mitigation (no code):** SETTINGS → Model → Haiku 4.5 or Sonnet 5.
- **Real fix:** a lean "voice profile" — keep CLAUDE.md + memory so he knows the
  user, but strip the DEVMODE/TRAITS/domain-injection hooks from each turn and
  trim MCP to the ~10 servers voice uses. Default a voice-appropriate model.

---

## Features requested (not bugs — backlog, do not lose)

### 11. Terminal view + multi-session / master
- A typed terminal blade; multiple sessions via the BASE relay system; exactly
  one MASTER session talking to Charles, others as tabs. Scoped earlier.

### 12. Auto-install Desktop app
- Cross-platform installer written (`scripts/install-desktop-app.mjs`,
  `scripts/jarvis-app-launch.sh`, `scripts/jarvis-app.applescript`, icon at
  `public/jarvis-icon.png`). macOS build tested and working. **Uncommitted** —
  finish wiring auto-install on first `npm start`, then commit.

---

## Fixed earlier this session (for the record)

- **Model switch hang** — switching model/effort used to freeze the next turn
  (in-process SDK session restart). Rebuilt to persist choice + reconnect the
  socket; resumes the same conversation. FIXED (`6e0fecd`).
- **Double transcript from interim→final** — partial fix shipped (`95ccffa`);
  the held-then-Space path (#2 above) still open.
- **Barge-in → queue** — talking while busy queues instead of cutting off; a bare
  stop word still interrupts. Shipped (`260d1a9`). The display side is #7.
