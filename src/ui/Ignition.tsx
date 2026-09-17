import { useStore } from '../store'

/**
 * The start gate.
 *
 * Browsers refuse to play audio or start speech synthesis until the user has
 * interacted with the page, so something has to be clicked before JARVIS can
 * make a sound. Rather than hide that behind a permissions banner, it's the
 * cold open: a dead interface waiting to be switched on.
 *
 * Deliberately NOT wrapped in AnimatePresence, and the reason is worth keeping.
 *
 * It used to be, for the sake of a blur-and-fade on the way out, and the exit
 * never completed — the node reached opacity 0 and then stayed in the DOM for
 * the rest of the session. Which would be a cosmetic non-event, except this is
 * a `position: fixed; inset: 0` button: invisible, unremovable, and the topmost
 * hit-testable thing under every single point on the screen.
 *
 * Everything that aims by hit-testing died on it. Hand control resolves its
 * target with elementFromPoint, so every pinch — focus, grab, drag, close —
 * landed on an invisible button instead of a blade, silently, with no error and
 * nothing on screen to suggest why. It cost an entire evening of looking at the
 * gesture code, which was fine.
 *
 * Two attempted fixes failed and are worth recording so nobody re-attempts
 * them. Giving the child a `key` did not make the exit complete. Adding a
 * phase-dependent `pointerEvents` did not help either, because AnimatePresence
 * renders an exiting child from a frozen snapshot of its last props — inside
 * that copy the phase is forever 'offline', so a guard written in terms of it
 * can never fire.
 *
 * A plain conditional cannot strand anything. The fade-in survives because
 * mounting is not the dangerous direction; the fade-out is gone, and the boot
 * sequence takes the screen immediately anyway, so there is nothing to see.
 */
export function Ignition({
  onStart,
  onSkip,
}: {
  onStart: () => void
  onSkip: () => void
}) {
  const phase = useStore((s) => s.phase)
  if (phase !== 'offline') return null

  return (
    <>
    <button className="ignition" onClick={onStart}>
      {/*
        Spun by CSS rather than framer. As a motion element with
        `repeat: Infinity` it was one of the things keeping the exit from ever
        finishing — AnimatePresence waits for a leaving subtree's animations,
        and an infinite one never ends.
      */}
      <span className="ignition-ring" />
      <span className="ignition-label">
        <span className="ignition-word">INITIALISE</span>
        <span className="ignition-sub">click, or clap, to power up</span>
      </span>
    </button>
    {/* A sibling, not a child: a button inside a button is invalid markup, and
        the browser would hoist it out anyway. Sits above the full-frame
        ignition button so it takes its own clicks. It unmounts with the
        ignition screen, under the same plain conditional. */}
    <button className="ignition-skip" onClick={onSkip}>
      Skip boot up
    </button>
    </>
  )
}
