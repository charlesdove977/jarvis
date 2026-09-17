import { echoStrict, getMic } from './audio'

/**
 * Voice-activity detection and segment capture.
 *
 * This is the piece that makes the assistant reliable, and it exists because
 * the browser's SpeechRecognition does not. That API dies silently under
 * always-on use — Chrome throttles it, it stops firing events, and nothing you
 * can catch tells you it has gone deaf. Detecting that a human is speaking is
 * not a language problem, though; it is an energy problem, and energy on the
 * microphone signal is something we can measure ourselves, every frame, with no
 * black box that can quietly stop answering.
 *
 * So: a running-mean noise floor, a threshold above it, and a hysteresis gate.
 * When the signal crosses the threshold a fresh recorder starts; when it falls
 * quiet for long enough the recorder stops and hands back one self-contained
 * audio blob for the bridge to transcribe. The detection is instant and local
 * — that is what makes barge-in feel natural — and the words come back a moment
 * later from a real transcriber that cannot silently fail the way the browser
 * one did.
 *
 * Hearing himself is the one hard part. The microphone picks up JARVIS's own
 * voice through the speakers, and raw energy cannot tell that from the user.
 * Two things handle it: getUserMedia is asked for echo cancellation, which
 * removes most of the playback, and while he is speaking the trigger threshold
 * is raised so the residue that leaks through does not cross it. A text check
 * after transcription is the final backstop, in voice.ts.
 */

export type VadHandlers = {
  /** The signal crossed into speech. Instant; this is the barge-in trigger. */
  onStart: () => void
  /** Speech ended. The blob is one complete, decodable audio file. */
  onEnd: (audio: Blob, ms: number) => void
  /** 0..1 smoothed input level, for the caption/orb while capturing. */
  onLevel: (v: number) => void
  /** Capture is impossible — no microphone, or no MediaRecorder support. */
  onError: (message: string) => void
}

export type Vad = {
  stop: () => void
  /** Raise the trigger bar while JARVIS speaks, so his own playback leaking
   *  past echo cancellation does not register as the user talking. */
  setGuard: (on: boolean) => void
  live: () => boolean
  /** Live internals, for the diagnostics panel. */
  meter: () => { energy: number; floor: number; threshold: number; speaking: boolean }
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** How far above the noise floor the signal must rise to count as speech.
 *  The floor tracks the room, so this is a ratio, not an absolute level. */
const TRIGGER_OVER_FLOOR = 2.6
/** While he is speaking, demand this much more, so residual echo is ignored. */
const GUARD_BOOST = 2.4
/** Falling back below trigger×this ends the segment. Hysteresis stops a single
 *  dip mid-word from cutting a sentence in half. */
const RELEASE_RATIO = 0.6

/** Sustained energy for this long confirms speech rather than a knock or click. */
const START_MS = 110
/**
 * Quiet for this long ends the SEGMENT — which is no longer the same thing as
 * ending the turn.
 *
 * It used to be both, which is why this number was impossible to set: long
 * enough not to clip someone thinking mid-sentence meant every completed
 * question also sat waiting for nothing. Deciding whether the thought is
 * actually finished now happens a layer up, on the words rather than the
 * energy (see makeAssembler in voice.ts), so this can go back to being what it
 * should always have been — a cheap "have they stopped making noise" — and the
 * shorter window gets the transcript moving sooner.
 */
const SILENCE_MS = 650
/** Nobody speaks one segment for this long; cut it and transcribe what we have. */
const MAX_MS = 20000

/** The floor adapts slowly upward (a fan spinning up) and quickly downward (a
 *  door closing), so it settles to genuine ambient noise without chasing speech. */
const FLOOR_UP = 0.0008
const FLOOR_DOWN = 0.02

function pickMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ]
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
      return m
    }
  }
  return ''
}

export async function startVad(h: VadHandlers): Promise<Vad> {
  let stream: MediaStream
  try {
    stream = await getMic()
  } catch (err) {
    h.onError(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access denied — voice input is unavailable.'
        : 'No microphone available.',
    )
    return { stop: () => {}, setGuard: () => {}, live: () => false, meter: () => ({ energy: 0, floor: 0, threshold: 0, speaking: false }) }
  }

  if (typeof MediaRecorder === 'undefined') {
    h.onError('This browser cannot record audio — voice input is unavailable.')
    return { stop: () => {}, setGuard: () => {}, live: () => false, meter: () => ({ energy: 0, floor: 0, threshold: 0, speaking: false }) }
  }

  const mime = pickMime()
  const ctx = new AudioContext()
  // Some browsers start an AudioContext suspended even after a gesture; resume
  // is a no-op when it is already running.
  void ctx.resume()
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.35
  source.connect(analyser)
  const buf = new Float32Array(analyser.fftSize)

  let stopped = false
  let guard = false
  let floor = 0.01
  let smoothEnergy = 0
  let threshold = 0

  // Segment state.
  let recorder: MediaRecorder | null = null
  let parts: Blob[] = []
  let armedAt = 0 // energy first rose; recording may be pre-rolling
  let speaking = false
  let speechStartedAt = 0
  let lastLoud = 0
  let raf = 0

  const rms = (): number => {
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    return Math.sqrt(sum / buf.length)
  }

  const startRecorder = () => {
    parts = []
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
    } catch {
      recorder = new MediaRecorder(stream)
    }
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) parts.push(e.data)
    }
    recorder.start()
  }

  const discardRecorder = () => {
    if (!recorder) return
    try {
      recorder.ondataavailable = null
      if (recorder.state !== 'inactive') recorder.stop()
    } catch {
      /* already gone */
    }
    recorder = null
    parts = []
  }

  const endSegment = () => {
    const rec = recorder
    const startedAt = speechStartedAt
    speaking = false
    speechStartedAt = 0
    if (!rec) return
    recorder = null

    const finalise = () => {
      const type = rec.mimeType || mime || 'audio/webm'
      const blob = new Blob(parts, { type })
      parts = []
      const ms = startedAt ? performance.now() - startedAt : 0
      h.onEnd(blob, ms)
    }
    rec.onstop = finalise
    try {
      if (rec.state !== 'inactive') rec.stop()
      else finalise()
    } catch {
      finalise()
    }
  }

  const tick = () => {
    if (stopped) return
    raf = requestAnimationFrame(tick)

    const energy = rms()
    smoothEnergy += (energy - smoothEnergy) * 0.5
    h.onLevel(Math.min(1, smoothEnergy * 12))

    // Adapt the floor only when we are confident this is not speech.
    if (!speaking && armedAt === 0) {
      const rate = smoothEnergy > floor ? FLOOR_UP : FLOOR_DOWN
      floor += (smoothEnergy - floor) * rate
      floor = Math.max(floor, 0.0015)
    }

    // Strict noise guard: while he speaks, nothing crosses. Barge-in by voice is
    // the price; Escape still cuts him off.
    threshold = guard && echoStrict()
      ? Infinity
      : floor * TRIGGER_OVER_FLOOR * (guard ? GUARD_BOOST : 1)
    const release = threshold * RELEASE_RATIO
    const now = performance.now()

    if (!speaking) {
      if (smoothEnergy > threshold) {
        if (armedAt === 0) {
          // Onset: start recording immediately so the first phoneme is captured,
          // before we have even confirmed this is speech. If it turns out to be
          // a blip, the recorder is discarded and nothing was lost.
          armedAt = now
          startRecorder()
        } else if (now - armedAt >= START_MS) {
          // Confirmed. This is the moment barge-in fires.
          speaking = true
          speechStartedAt = armedAt
          lastLoud = now
          h.onStart()
        }
      } else if (armedAt !== 0) {
        // Rose and fell without confirming — a knock, a click, a lip smack.
        armedAt = 0
        discardRecorder()
      }
    } else {
      if (smoothEnergy > release) lastLoud = now
      const quietFor = now - lastLoud
      const runFor = now - speechStartedAt
      if (quietFor >= SILENCE_MS || runFor >= MAX_MS) {
        armedAt = 0
        endSegment()
      }
    }
  }

  tick()

  return {
    stop: () => {
      stopped = true
      cancelAnimationFrame(raf)
      discardRecorder()
      try {
        source.disconnect()
        void ctx.close()
      } catch {
        /* noop */
      }
    },
    setGuard: (on) => {
      guard = on
    },
    live: () => !stopped,
    meter: () => ({ energy: smoothEnergy, floor, threshold, speaking }),
  }
}
