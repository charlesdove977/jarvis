/**
 * A single shared microphone stream plus an analyser, so the reactor can pulse
 * with the user's voice. Opening the mic more than once causes Chrome to drop
 * the earlier stream, so everything that needs audio goes through here.
 */

let stream: MediaStream | null = null
let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let buf: Uint8Array | null = null

let strict = false

export async function getMic(): Promise<MediaStream> {
  if (stream) return stream
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })
  applyIsolation()
  return stream
}

/**
 * The noise guard.
 *
 * Strict asks the platform for voice isolation, the model-based filter that
 * keeps a voice and drops everything else, including a voice coming out of the
 * speakers. Not every browser offers it; where it is unknown the constraint is
 * ignored and strict still does its other half, in vad.ts: nothing heard while
 * JARVIS is speaking counts as the user.
 */
export function setEchoStrict(on: boolean): void {
  strict = on
  applyIsolation()
}

export function echoStrict(): boolean {
  return strict
}

function applyIsolation(): void {
  for (const track of stream?.getAudioTracks() ?? []) {
    const supported = navigator.mediaDevices.getSupportedConstraints() as Record<string, boolean>
    if (!supported.voiceIsolation) continue
    void track
      .applyConstraints({ ...track.getConstraints(), voiceIsolation: strict } as MediaTrackConstraints)
      .catch(() => {
        /* the device refused it; the VAD gate still applies */
      })
  }
}

/**
 * Mute or unmute the shared microphone. Disabling the tracks feeds silence to
 * every consumer of the stream (analyser, VAD, recorder) without closing it,
 * so unmuting is instant and never re-prompts for permission.
 */
export function setMicMuted(muted: boolean): void {
  stream?.getAudioTracks().forEach((t) => (t.enabled = !muted))
}

export async function startAnalyser(): Promise<void> {
  if (analyser) return
  const s = await getMic()
  ctx = new AudioContext()
  const src = ctx.createMediaStreamSource(s)
  analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.75
  src.connect(analyser)
  buf = new Uint8Array(analyser.frequencyBinCount)
}

/** 0..1 loudness. Returns 0 before the analyser is up. */
export function micLevel(): number {
  if (!analyser || !buf) return 0
  analyser.getByteFrequencyData(buf as Uint8Array<ArrayBuffer>)
  let sum = 0
  // Skip the lowest bins — they're mostly rumble and mains hum.
  for (let i = 4; i < buf.length; i++) sum += buf[i]
  const avg = sum / (buf.length - 4) / 255
  // Voice sits low in this range; stretch it so the visuals actually move.
  return Math.min(1, avg * 3.2)
}

/** Analyser fed from an <audio> element, so the orb reacts while JARVIS talks. */
export function attachOutputAnalyser(el: HTMLAudioElement): () => number {
  const c = new AudioContext()
  const src = c.createMediaElementSource(el)
  const a = c.createAnalyser()
  a.fftSize = 512
  a.smoothingTimeConstant = 0.7
  src.connect(a)
  a.connect(c.destination)
  const b = new Uint8Array(a.frequencyBinCount)
  return () => {
    a.getByteFrequencyData(b as Uint8Array<ArrayBuffer>)
    let sum = 0
    for (let i = 2; i < b.length; i++) sum += b[i]
    return Math.min(1, sum / (b.length - 2) / 255 * 3)
  }
}
