/**
 * The camera, and everything that looks through it.
 *
 * One stream, shared. Hand tracking wants it, the camera blade wants it, and
 * looking at something wants it — and a second getUserMedia makes Chrome drop
 * the first, so anything that opens its own would silently blind the others.
 * Everything here goes through one refcounted handle.
 *
 * Three ways of seeing, because "look at this" means three different things:
 *
 *   grabFrame   — one photograph. What is in front of me right now.
 *   watchAhead  — the next few seconds, as a grid. What am I doing.
 *   recentGrid  — the last few seconds, as a grid. What did I just do.
 *
 * The grid is the whole trick for the last two. A model sees images, not video,
 * so a clip has to become a contact sheet: frames sampled evenly, laid out in
 * reading order, each stamped with its offset so the order is unambiguous and
 * the model can talk about timing rather than just contents.
 *
 * Nothing is written to disk and nothing leaves the machine except the single
 * still that a tool call returns. The rolling buffer exists only while the
 * camera is open and is dropped the moment it closes.
 */

/** Frames per second kept in the rolling buffer. Enough to catch a gesture,
 *  cheap enough to run alongside hand tracking. */
const BUFFER_FPS = 6
/** How much past to keep. Long enough for "what did I just do", short enough
 *  that the memory cost is a few megabytes rather than a few hundred. */
const BUFFER_SECONDS = 10

/** Each cell in a contact sheet. Small on purpose — nine of these is already a
 *  large image, and detail past this adds tokens rather than understanding. */
const CELL_W = 426
const CELL_H = 240

let stream: MediaStream | null = null
let video: HTMLVideoElement | null = null
/** What the live stream is: the webcam, or a shared screen, window or tab. */
let source: 'camera' | 'screen' = 'camera'
/** Told when the user ends a share from Chrome's own bar, so the blade that
 *  opened it can close itself instead of showing a frozen frame. */
const endedListeners = new Set<() => void>()
/** How many things currently need the camera. It closes at zero, not before. */
let holders = 0

export const diag = {
  open: false,
  holders: 0,
  buffered: 0,
  lastError: '',
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__camera = diag
}

/* ------------------------------------------------------------------- stream */

/**
 * Take a hold on the camera. Every caller must release it exactly once.
 *
 * Refcounted rather than "open if closed", because the failure mode of getting
 * that wrong is invisible: whoever closes it last takes the picture away from
 * everyone still using it, and the symptom is another feature going blind for
 * reasons that have nothing to do with it.
 */
export async function holdCamera(): Promise<HTMLVideoElement> {
  return hold('camera')
}

/**
 * Share the screen instead. Chrome's own picker offers a tab, a window or
 * the whole screen, which is where "share the Zoom window" gets answered.
 * While a share is live it is what every look, watch and per-turn frame sees;
 * the webcam is not opened alongside it.
 */
export async function holdScreen(): Promise<HTMLVideoElement> {
  return hold('screen')
}

export const screenLive = () => source === 'screen' && Boolean(video && stream)

export function onShareEnded(fn: () => void): () => void {
  endedListeners.add(fn)
  return () => endedListeners.delete(fn)
}

async function hold(want: 'camera' | 'screen'): Promise<HTMLVideoElement> {
  holders++
  diag.holders = holders
  // A live share answers a request for the camera too: "look at this" while
  // sharing means the screen. A live camera does not answer a request for the
  // screen; that swaps the source.
  if (video && stream && (source === want || source === 'screen')) return video
  if (video && stream) tearDown()

  try {
    stream =
      want === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: 5 },
            audio: false,
          })
        : await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720, facingMode: 'user' },
          })
    source = want
    const el = document.createElement('video')
    el.autoplay = true
    el.playsInline = true
    el.muted = true
    el.srcObject = stream
    await el.play()
    video = el
    diag.open = true
    diag.lastError = ''
    if (want === 'screen') {
      // "Stop sharing" on Chrome's bar ends the track with no other signal.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        holders = 0
        diag.holders = 0
        tearDown()
        endedListeners.forEach((fn) => fn())
      })
    }
    return el
  } catch (err) {
    // The hold is given back on failure, or the count drifts up for ever and
    // the camera can never be closed.
    holders = Math.max(0, holders - 1)
    diag.holders = holders
    diag.lastError = String((err as Error)?.message ?? err)
    throw err
  }
}

/** Give back a hold. The camera light goes out when the last one does. */
export function releaseCamera(): void {
  holders = Math.max(0, holders - 1)
  diag.holders = holders
  if (holders > 0) return
  tearDown()
}

function tearDown(): void {
  stopBuffer()
  if (video) {
    video.pause()
    video.srcObject = null
    video = null
  }
  // Stopping every track is what actually extinguishes the hardware light.
  // Anything less leaves it on, and a user who sees that is right to distrust
  // every other claim this interface makes about its camera.
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  source = 'camera'
  diag.open = false
}

export const cameraLive = () => Boolean(video && stream)
export const cameraStream = () => stream

/* -------------------------------------------------------------------- frames */

function drawTo(canvas: HTMLCanvasElement, w: number, h: number) {
  const ctx = canvas.getContext('2d')
  if (!ctx || !video) return null
  canvas.width = w
  canvas.height = h
  /**
   * Drawn unmirrored, deliberately.
   *
   * The hand overlay mirrors its coordinates because a mirror is what a person
   * expects to see of themselves. The raw frame is not mirrored, and for
   * looking at something that is the correct choice: hold a label up to the
   * camera and the raw frame reads it the right way round, while a mirrored
   * one hands the model text backwards.
   */
  ctx.drawImage(video, 0, 0, w, h)
  return ctx
}

const toJpeg = (canvas: HTMLCanvasElement, q = 0.82) => {
  const url = canvas.toDataURL('image/jpeg', q)
  return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/jpeg' }
}

/** One frame, full size. */
export function grabFrame(): { data: string; mimeType: string } {
  if (!video?.videoWidth) throw new Error('the camera is not ready')
  const canvas = document.createElement('canvas')
  if (!drawTo(canvas, video.videoWidth, video.videoHeight)) {
    throw new Error('could not read the camera frame')
  }
  return toJpeg(canvas)
}

/**
 * The frame that rides with each spoken turn while the screen is shared, so
 * "what do you think of this" needs no tool call. Kept small: the model reads
 * a 1280-wide screenshot fine, and a full 4K frame per turn is mostly cost.
 */
export function frameForTurn(): { data: string; mimeType: string } | null {
  if (!screenLive() || !video?.videoWidth) return null
  const scale = Math.min(1, 1280 / video.videoWidth)
  const canvas = document.createElement('canvas')
  if (!drawTo(canvas, Math.round(video.videoWidth * scale), Math.round(video.videoHeight * scale))) {
    return null
  }
  return toJpeg(canvas, 0.6)
}

/* -------------------------------------------------------------------- buffer */

type Shot = { at: number; bitmap: HTMLCanvasElement }

let buffer: Shot[] = []
let bufferTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start remembering the recent past.
 *
 * Frames are kept as small canvases rather than as encoded images: encoding
 * costs real time and most of these are thrown away unlooked-at, so paying for
 * it up front would be paying six times a second for something used once.
 */
export function startBuffer(): void {
  if (bufferTimer) return
  bufferTimer = setInterval(() => {
    if (!video?.videoWidth) return
    const cell = document.createElement('canvas')
    if (!drawTo(cell, CELL_W, CELL_H)) return
    buffer.push({ at: performance.now(), bitmap: cell })
    const cutoff = performance.now() - BUFFER_SECONDS * 1000
    while (buffer.length && buffer[0].at < cutoff) buffer.shift()
    diag.buffered = buffer.length
  }, 1000 / BUFFER_FPS)
}

export function stopBuffer(): void {
  if (bufferTimer) clearInterval(bufferTimer)
  bufferTimer = null
  buffer = []
  diag.buffered = 0
}

/* --------------------------------------------------------------------- grids */

/**
 * Lay frames out as a contact sheet.
 *
 * Reading order, left to right and top to bottom, with each cell stamped with
 * its offset in seconds. The stamps are not decoration: without them a model
 * looking at nine similar frames has no way to know which came first, and will
 * describe a sequence of events in whatever order it happens to read them.
 */
function contactSheet(
  shots: { at: number; bitmap: HTMLCanvasElement }[],
  originAt: number,
): { data: string; mimeType: string } {
  const n = shots.length
  const cols = n <= 2 ? n : n <= 6 ? 3 : 4
  const rows = Math.ceil(n / cols)
  const canvas = document.createElement('canvas')
  canvas.width = cols * CELL_W
  canvas.height = rows * CELL_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('could not build the grid')

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  shots.forEach((shot, i) => {
    const x = (i % cols) * CELL_W
    const y = Math.floor(i / cols) * CELL_H
    ctx.drawImage(shot.bitmap, x, y, CELL_W, CELL_H)

    const label = `${i + 1}  ${((shot.at - originAt) / 1000).toFixed(1)}s`
    ctx.font = '600 22px ui-monospace, monospace'
    // Drawn twice — dark underneath, light on top — so the stamp survives both
    // a bright frame and a dark one without a panel behind it.
    ctx.lineWidth = 4
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.strokeText(label, x + 12, y + 30)
    ctx.fillStyle = '#fff'
    ctx.fillText(label, x + 12, y + 30)

    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, CELL_W - 1, CELL_H - 1)
  })

  return toJpeg(canvas, 0.78)
}

/** Evenly spaced picks, always including the first and last. */
function sample<T>(items: T[], want: number): T[] {
  if (items.length <= want) return items
  const out: T[] = []
  for (let i = 0; i < want; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (want - 1))])
  }
  return out
}

/**
 * Watch for the next few seconds and hand back a grid.
 *
 * Forward-looking, so it is the right tool for "watch me do this" — the answer
 * is about something that has not happened yet when the question is asked.
 */
export async function watchAhead(
  seconds: number,
  frames: number,
): Promise<{ data: string; mimeType: string }> {
  if (!video?.videoWidth) throw new Error('the camera is not ready')
  const shots: Shot[] = []
  const started = performance.now()
  const gap = (seconds * 1000) / Math.max(1, frames - 1)

  for (let i = 0; i < frames; i++) {
    const cell = document.createElement('canvas')
    if (drawTo(cell, CELL_W, CELL_H)) {
      shots.push({ at: performance.now(), bitmap: cell })
    }
    if (i < frames - 1) await new Promise((r) => setTimeout(r, gap))
  }
  if (!shots.length) throw new Error('no frames were captured')
  return contactSheet(shots, started)
}

/**
 * The last few seconds, as a grid.
 *
 * Only possible while the buffer is running, which it is whenever the camera
 * blade is open. This is what answers "what did I just do" — a question that
 * cannot be answered by starting to record when it is asked.
 */
export function recentGrid(
  seconds: number,
  frames: number,
): { data: string; mimeType: string } | null {
  const cutoff = performance.now() - seconds * 1000
  const window = buffer.filter((s) => s.at >= cutoff)
  if (window.length < 2) return null
  const picked = sample(window, frames)
  return contactSheet(picked, picked[0].at)
}

export const bufferedSeconds = () =>
  buffer.length < 2 ? 0 : (buffer[buffer.length - 1].at - buffer[0].at) / 1000
