/* ------------------------------------------------------------------ *
 * The run: how far you have driven without giving in.
 *
 * `prompt_4.md` item 1 turns the drive into a game -- *stay undistracted
 * for as long as you can* -- and item 2 says how it is scored: distance
 * driven **continuously**.  Two things end a run, and they are the two
 * ways of being distracted:
 *
 *   stopping   dropping below 10 mph.  Checked every physics frame and
 *              with no grace period, because a real stop is a real stop
 *              and a debounce is a tuning constant somebody has to
 *              defend.  The rescue (`T`), the rest (`Z`) and a resumed
 *              drive all zero the car's speed, so they end a run here
 *              without a line of their own -- which is right: each of
 *              them *is* a stop.
 *   a portal   going through one, which `main.js` reports with `end` on
 *              the frame the car crosses the ring.  Not when the page
 *              leaves: `Esc` during the crossing brings the car back but
 *              not the distance, or the best strategy in the game would
 *              be to drive through every gate and cancel.
 *
 * A run starts on its own, the first frame the car is above the line.
 * Nothing here is persisted except the best: a page that loads is a car
 * that is standing still, and a car standing still has no run.
 *
 * No three.js and no DOM, so a probe can drive it with numbers.
 * ------------------------------------------------------------------ */

/** 10 mph, in metres a second.  The prompt's line. */
export const V_MIN = 10 * 0.44704;

export class Run {
  /** `best` is the stored record, in metres. */
  constructor(best = 0) {
    /** Metres since the car last stopped or went through a gate. */
    this.drive = 0;
    /** The longest `drive` there has ever been, in metres. */
    this.best = best;
    /** Set when `best` has moved and the store has not heard about it. */
    this.dirty = false;
  }

  /** Is the car above the line, and so is this frame counting? */
  counting(speed) { return Math.abs(speed) >= V_MIN; }

  /**
   * One physics frame.  Returns the distance the run ended at if this
   * frame ended one by stopping, and null otherwise -- including when
   * there was no run to end, so a parked car does not report a stop
   * every frame.
   */
  update(speed, dt) {
    if (this.counting(speed)) {
      this.drive += Math.abs(speed) * dt;
      return null;
    }
    return this.drive > 0 ? this.end() : null;
  }

  /**
   * End the run where it stands.  Returns the distance it reached, which
   * is also what `best` is compared against.
   */
  end() {
    const d = this.drive;
    this.drive = 0;
    if (d > this.best) { this.best = d; this.dirty = true; }
    return d;
  }
}
