/**
 * Local speech-to-text for the bridge, via a warm faster-whisper worker.
 *
 * The browser already records a whole utterance (its VAD trims the silence) and
 * POSTs the audio to /stt. When there is no ElevenLabs key, this is what answers
 * it: a single Python process, spawned once with the model loaded and kept warm,
 * fed one audio file at a time over stdin. Warm is the whole point — reloading
 * the model per turn is what makes local Whisper feel slow.
 *
 * It degrades to nothing: if Python or faster-whisper is missing the worker
 * never reports ready, `whisperReady()` stays false, /health advertises no local
 * STT, and the browser keeps using its own recogniser. No throw reaches the
 * caller.
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'whisper_stt.py')

/** Resolve the Python that actually has faster-whisper installed. Explicit,
 *  because the bridge is spawned by npm and must not inherit a guess. */
function resolvePython() {
  const override = process.env.JARVIS_PYTHON
  if (override) return override
  for (const cmd of ['python3', 'python']) {
    const r = spawnSync(cmd, ['-c', 'import faster_whisper'], {
      env: process.env,
      stdio: 'ignore',
    })
    if (r.status === 0) return cmd
  }
  return null
}

let proc = null
let ready = false
let unavailable = false
/** Serialises requests: the worker handles one clip at a time, in order. */
let chain = Promise.resolve()
/** Resolver for the single in-flight transcription, keyed by nothing because
 *  the chain guarantees one at a time. */
let pending = null
let stdoutBuf = ''

/** True once the model is loaded and the worker can transcribe. */
export function whisperReady() {
  return ready
}

/** True when we know local STT can never come up (no Python / no package). */
export function whisperUnavailable() {
  return unavailable
}

/**
 * Start the worker if it is not already running. Safe to call more than once.
 * The model download (~140 MB for base.en) happens inside the worker on first
 * ever run; `ready` simply flips later in that case.
 */
export function startWhisper() {
  if (proc || unavailable) return
  const python = resolvePython()
  if (!python && !existsSync(WORKER)) {
    unavailable = true
    return
  }
  if (!python) {
    unavailable = true
    console.warn('[jarvis] local STT unavailable: faster-whisper not importable by python3 (pip install --user faster-whisper)')
    return
  }

  proc = spawn(python, ['-u', WORKER], {
    // Explicit env, plus an unbuffered stdio so lines arrive promptly.
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  proc.stdout.on('data', (d) => {
    stdoutBuf += d.toString()
    let nl
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim()
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.ready) {
        ready = true
        console.log(`[jarvis] local STT ready (faster-whisper ${msg.model ?? ''})`)
        continue
      }
      // Otherwise it is a transcription result or a per-clip error.
      if (pending) {
        const p = pending
        pending = null
        if (typeof msg.text === 'string') p.resolve(msg.text)
        else p.reject(new Error(msg.error || 'transcription failed'))
      } else if (msg.error && !ready) {
        // A startup error (bad import / model load) before ready: give up.
        unavailable = true
        console.warn(`[jarvis] local STT unavailable: ${msg.error}`)
      }
    }
  })

  proc.stderr.on('data', (d) => {
    const s = d.toString().trim()
    if (s && process.env.JARVIS_DEBUG === '1') console.log('[whisper]', s)
  })

  proc.on('exit', (code) => {
    console.warn(`[jarvis] local STT worker exited (${code}); local transcription is off until restart`)
    proc = null
    ready = false
    if (pending) {
      pending.reject(new Error('whisper worker exited'))
      pending = null
    }
  })
}

/**
 * Transcribe one audio buffer. Resolves to the text (possibly empty). Rejects
 * only on a real failure; the caller decides how to surface that. Requests are
 * serialised so the single worker is never asked to do two at once.
 *
 * @param {Buffer} buffer
 * @param {string} contentType  the MediaRecorder mime, used only to pick an ext
 * @returns {Promise<string>}
 */
export function whisperTranscribe(buffer, contentType) {
  if (!ready || !proc) return Promise.reject(new Error('local STT not ready'))

  const run = () =>
    new Promise((resolve, reject) => {
      const ext = contentType?.includes('ogg')
        ? 'ogg'
        : contentType?.includes('wav')
          ? 'wav'
          : contentType?.includes('mp4') || contentType?.includes('mpeg')
            ? 'mp4'
            : 'webm'
      let file
      try {
        const dir = mkdtempSync(join(tmpdir(), 'jarvis-stt-'))
        file = join(dir, `clip.${ext}`)
        writeFileSync(file, buffer)
      } catch (err) {
        return reject(err)
      }
      pending = { resolve, reject }
      // Guard against a wedged worker: never hang the turn forever.
      const timer = setTimeout(() => {
        if (pending && pending.reject === reject) {
          pending = null
          reject(new Error('local STT timed out'))
        }
      }, 30_000)
      const done = (fn) => (v) => {
        clearTimeout(timer)
        fn(v)
      }
      pending = { resolve: done(resolve), reject: done(reject) }
      try {
        proc.stdin.write(file + '\n')
      } catch (err) {
        clearTimeout(timer)
        pending = null
        reject(err)
      }
    })

  // Append to the chain so calls run one after another; return this call's result.
  const result = chain.then(run, run)
  chain = result.then(
    () => {},
    () => {},
  )
  return result
}
