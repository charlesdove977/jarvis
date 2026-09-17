import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useStore } from '../store'

/**
 * The start-up sequence, rebuilt to the Iron Man boot it is quoting.
 *
 * Four beats, in order, cyan on black:
 *   1. an angular status bar — "INITIATING SYSTEM" — over a scrolling boot log,
 *      with a segmented bar filling left to right;
 *   2. concentric reticle rings assembling inward until "J.A.R.V.I.S" resolves
 *      at the centre;
 *   3. the suit schematic — a wireframe figure with component call-outs;
 *   4. the triangular arc reactor lighting from a dim outline to full glow,
 *      which is the hand-off into the live scene behind it.
 *
 * It is one full-frame overlay driven by a small stage clock rather than four
 * components, so the timing is legible in one place. Everything is SVG and CSS
 * — no images to load, nothing that can arrive late and stall the first beat.
 */

/** The stage boundaries, in milliseconds from power-on. `done` is when the
 *  overlay dissolves; App owns the actual hand-off, this is only for pacing. */
const T = { rings: 2600, suit: 5200, reactor: 7200 }

const LOG = [
  'MOUNT F:/BACKUP/GHOST (HIDDEN)',
  'EXTEND SYSTEM MEMORY .......... OK',
  'TELEMETRY / COMP CLIMATION',
  'REMOVE SYSTEM CONFIGURATION',
  'CHECKSUM ...................... OK',
  'RUN SYSTEM TOOL',
]

type Stage = 'bar' | 'rings' | 'suit' | 'reactor'

export function Boot() {
  const phase = useStore((s) => s.phase)
  const skipBoot = useStore((s) => s.skipBoot)
  const reduced = useReducedMotion()
  const [t, setT] = useState(0)

  // A single clock: elapsed milliseconds since the boot phase began. Every
  // stage reads from it, so nothing can drift out of step with anything else.
  //
  // Driven by setInterval over wall-clock time, NOT requestAnimationFrame —
  // rAF is throttled to a crawl (and paused outright) whenever the tab is not
  // the focused one, which froze the sequence on its first beat. An interval
  // reading Date.now advances by real elapsed time whatever the browser does
  // with its frame budget: throttling can cost smoothness, never correctness.
  useEffect(() => {
    if (phase !== 'boot') {
      setT(0)
      return
    }
    const start = Date.now()
    setT(0)
    const id = setInterval(() => setT(Date.now() - start), 50)
    return () => clearInterval(id)
  }, [phase])

  if (phase !== 'boot' || skipBoot) return null

  const stage: Stage =
    t >= T.reactor ? 'reactor' : t >= T.suit ? 'suit' : t >= T.rings ? 'rings' : 'bar'

  const logShown = Math.min(LOG.length, Math.floor((t / T.rings) * (LOG.length + 1)))
  const barPct = Math.min(1, t / (T.rings - 300))

  return (
    <AnimatePresence>
      <motion.div
        className="boot"
        initial={{ opacity: 1 }}
        exit={{ opacity: 0, filter: 'blur(10px)' }}
        transition={{ duration: 0.8 }}
      >
        {/* ---- beat 1: the status bar, dimming once its work is done ---- */}
        <div className={`boot-bar ${stage !== 'bar' ? 'boot-bar-dim' : ''}`}>
          <div className="boot-bar-frame">
            <span className="boot-bar-title">
              INITIATING SYSTEM 1<span className="boot-dots">…</span>
              <span className="boot-cursor" />
            </span>
            <div className="boot-seg">
              {Array.from({ length: 22 }, (_, i) => (
                <span
                  key={i}
                  className="boot-seg-cell"
                  data-on={i / 22 < barPct ? '1' : '0'}
                />
              ))}
            </div>
          </div>
          <div className="boot-log">
            {LOG.slice(0, logShown).map((l) => (
              <div key={l} className="boot-log-line">
                {l}
              </div>
            ))}
          </div>
        </div>

        {/* ---- beats 2-4: the centre stage ---- */}
        <div className="boot-stage">
          {stage === 'rings' && <Rings reduced={!!reduced} />}
          {stage === 'suit' && <Suit reduced={!!reduced} />}
          {stage === 'reactor' && <Reactor reduced={!!reduced} t={t - T.reactor} />}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

/* ------------------------------------------------------------------ beat 2 */

/** Concentric reticle rings drawing inward, with the name resolving last. */
function Rings({ reduced }: { reduced: boolean }) {
  const ease = 'easeOut'
  const ring = (r: number, delay: number, dash: string, w = 1) => (
    <motion.circle
      cx="0"
      cy="0"
      r={r}
      className="boot-ring"
      strokeDasharray={dash}
      strokeWidth={w}
      initial={reduced ? { opacity: 1 } : { opacity: 0, rotate: -40, scale: 1.15 }}
      animate={{ opacity: 1, rotate: 0, scale: 1 }}
      transition={{ duration: 0.7, delay, ease }}
    />
  )
  return (
    <svg className="boot-rings" viewBox="-160 -160 320 320">
      <g>
        {ring(150, 0.0, '3 6')}
        {ring(128, 0.08, '40 8 12 8', 1.4)}
        {ring(104, 0.16, '2 4')}
        {ring(84, 0.24, '30 6 6 6', 1.6)}
        {ring(60, 0.34, '1 3')}
      </g>
      <motion.text
        x="0"
        y="6"
        className="boot-name"
        initial={reduced ? { opacity: 1 } : { opacity: 0, letterSpacing: '1.4em' }}
        animate={{ opacity: 1, letterSpacing: '0.42em' }}
        transition={{ duration: 0.7, delay: 0.5, ease }}
      >
        J.A.R.V.I.S
      </motion.text>
    </svg>
  )
}

/* ------------------------------------------------------------------ beat 3 */

/**
 * The suit schematic — a wireframe figure flanked by component call-outs, the
 * way the film flashes the armour blueprint mid-boot. Not the actual Mark VII
 * geometry, but the same read: a lit humanoid outline and exploded diagrams.
 */
function Suit({ reduced }: { reduced: boolean }) {
  return (
    <svg className="boot-suit" viewBox="-200 -150 400 300">
      <motion.g
        className="boot-suit-fig"
        initial={reduced ? { opacity: 1 } : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <motion.path
          className="boot-wire"
          d="M0,-118 C11,-118 17,-108 17,-96 C17,-86 12,-80 12,-74
             L22,-64 L30,-30 L26,26 L34,64 L28,66 L18,30 L16,64 L20,110
             L6,112 L2,66 L-2,66 L-6,112 L-20,110 L-16,64 L-18,30 L-28,66
             L-34,64 L-26,26 L-30,-30 L-22,-64 L-12,-74 C-12,-80 -17,-86 -17,-96
             C-17,-108 -11,-118 0,-118 Z"
          initial={reduced ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 1.4, ease: 'easeInOut' }}
        />
        <path className="boot-wire boot-wire-dim" d="M-9,-104 L9,-104 M-8,-96 L8,-96 M0,-92 L0,-84" />
        <circle className="boot-wire" cx="0" cy="-40" r="9" />
        <path className="boot-wire boot-wire-dim" d="M0,-49 L0,-31 M-9,-40 L9,-40" />
      </motion.g>

      {[-150, 150].map((x, i) => (
        <motion.g
          key={x}
          className="boot-callout"
          initial={reduced ? { opacity: 1 } : { opacity: 0, x: x > 0 ? 20 : -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 0.3 + i * 0.12 }}
        >
          <circle className="boot-wire" cx={x} cy="-10" r="26" strokeDasharray="30 6 6 6" />
          <circle className="boot-wire boot-wire-dim" cx={x} cy="-10" r="15" />
          <circle className="boot-wire" cx={x} cy="-10" r="3" />
          <path
            className="boot-wire boot-wire-dim"
            d={x > 0 ? `M${x - 26},-10 L60,-10` : `M${x + 26},-10 L-60,-10`}
          />
        </motion.g>
      ))}
      <text x="-150" y="34" className="boot-tag">RT / PWR</text>
      <text x="150" y="34" className="boot-tag">DEP / MK</text>
    </svg>
  )
}

/* ------------------------------------------------------------------ beat 4 */

/** The triangular chest reactor, lighting from a dim outline to full glow. */
function Reactor({ reduced, t }: { reduced: boolean; t: number }) {
  const glow = reduced ? 1 : Math.min(1, Math.max(0, t / 1400))
  const seg = Array.from({ length: 16 }, (_, i) => i)
  return (
    <svg
      className="boot-reactor"
      viewBox="-120 -120 240 240"
      style={{ ['--glow' as string]: glow }}
    >
      {seg.map((i) => {
        const a = (i / seg.length) * Math.PI * 2 - Math.PI / 2
        const on = i / seg.length < glow * 1.05
        return (
          <line
            key={i}
            x1={Math.cos(a) * 70}
            y1={Math.sin(a) * 70}
            x2={Math.cos(a) * 100}
            y2={Math.sin(a) * 100}
            className={on ? 'boot-r-seg boot-r-on' : 'boot-r-seg'}
          />
        )
      })}
      <circle className="boot-r-ring" cx="0" cy="0" r="102" />
      <circle className="boot-r-ring boot-r-ring-in" cx="0" cy="0" r="66" />
      <path className="boot-r-tri" d="M0,-52 L46,30 L-46,30 Z" />
      <path className="boot-r-tri boot-r-tri-in" d="M0,-30 L28,20 L-28,20 Z" />
      <path className="boot-r-v" d="M-11,-4 L0,14 L11,-4" />
    </svg>
  )
}
