import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * Through space and time, and then somewhere else.
 *
 * `prompt_18.md` item 3 asks for *an animation as if travelling through
 * space and time*, and the whole of the animation is in `post.js`'s WARP
 * pass.  What is here is the part that is easy to get wrong: **when**.
 *
 * Three things have to happen in one order and no other.
 *
 *   1  the car is taken out of the player's hands.  Not frozen -- a car
 *      that stops dead reads as hitting something, and the player is
 *      supposed to be leaving under their own power -- but no longer
 *      steerable, because a gate that can be steered out of *after* it
 *      has been driven through is a gate that did not mean anything.
 *   2  the frame is pulled into the gate, over a second and a half.  Long
 *      enough to be a journey and short enough that nobody waits.
 *   3  the save is forced, and only then the navigation, and both of them
 *      happen underneath the white-out -- so the page that arrives does so
 *      behind a white frame rather than behind a picture of a hillside
 *      that has stopped moving.
 *
 * **Nothing in here reads a clock.**  `t` is advanced by the frame time
 * it is handed, so a probe stepping the game at a fixed dt sees exactly
 * the same animation the player does, and `tools/probe/portal.mjs` checks
 * frames rather than milliseconds.
 * ------------------------------------------------------------------ */

/** How long the crossing takes, and where in it the page changes. */
const DURATION = 1.9;
/**
 * How far into it the navigation is asked for.
 *
 * **Late, and deliberately.** `Esc` during the crossing is the only way
 * to refuse a portal -- nothing else cancels anything any more -- so the
 * window in which it works had better be the whole animation rather than
 * the first two thirds of it.  0.95 of 1.9 seconds is 1.8 s of cancel,
 * and by then the white-out is at 96 % so the page that arrives still
 * does so behind a white frame rather than behind a hillside.
 */
const COMMIT = 0.95;

/** The return journey, played on the way back in.  See `resume`. */
const BACK_DURATION = 1.1;

/**
 * Marks the tab as having left through a gate, and **which** gate, for the
 * return trip.  `sessionStorage` and not the save cookie: it is about this
 * tab's history and not about the drive, and it must not survive a new
 * tab.
 *
 * `{ seed, id, s }`.  The id is what lets `prompt_19.md` item 2 put the
 * car back on the side road it left by rather than on the main road
 * beside it; the seed is so a flag from one world is never read as a gate
 * in another; and `s` is where that gate's mouth was, so the page that
 * comes back can tell whether it has built the same world.  Not the
 * cookie's `s` for that: a car on a short side road is still inside the
 * main road's query radius, and its saved position is the main road's
 * nearest point rather than the mouth.  A bare `'1'` is what a tab open across the deploy holds, and
 * it still means "came back" -- just not from where.
 *
 * Since `prompt_4.md` the list of billboards loops, so an id no longer
 * names one gate and the flag carries three more things:
 *
 *   n       which turning, counted in siting order.  What the page that
 *           comes back actually asks for.
 *   a       where the chain of turnings can be picked up from to reach
 *           it quickly -- `Junctions.anchorBefore`, `{ n, s, c }` or null.
 *   lost    how far the run had gone when the car went through, so the
 *           page that comes back can say what the portal cost.  `name`
 *           is the billboard's, for the same sentence.
 *
 * A flag with no `n` is from a tab that left before the list looped, when
 * billboard `k` was always turning `k - 1` and id 0 was home.
 */
const FLAG = 'br_portal';

export class Warp {
  constructor(pipeline, camera) {
    this.pipeline = pipeline;
    this.camera = camera;
    /** 0 when nothing is happening.  Runs up on the way out and down on
     *  the way back in. */
    this.t = 0;
    this.dir = 0;
    this.junction = null;
    /** Set when a crossing was refused and unwound.  `main.js` clears the
     *  card and disarms the turning on the strength of it. */
    this.stayed = false;
    this.target = new THREE.Vector3();
    this.centre = new THREE.Vector2(0.5, 0.5);
    /** Called once, under the white-out.  `main.js` saves and navigates,
     *  and returns false if the page is in fact staying put. */
    this.onArrive = null;
    /** Called when a refused crossing has finished unwinding. */
    this.onStay = null;
    this.arrived = false;
    this.baseFov = camera.fov;
    /** The world's seed, for the flag.  Set by `main.js`. */
    this.seed = null;
    /** How the page last arrived -- `'resume'`, `'arrive'` or null.  For
     *  `tools/probe/portal.mjs`, which cannot otherwise tell an arrival
     *  that played from one that finished before it looked. */
    this.arrivedBy = null;
    this._v = new THREE.Vector3();
  }

  /** Is anything playing -- a crossing on the way out, or an arrival? */
  get active() { return this.dir !== 0; }

  /** Is a crossing on the way out, and still refusable? */
  get leaving() { return this.dir > 0 && !this.arrived; }

  /** Is the page held on the white-out, the navigation already asked for?
   *  What a back/forward-cache restore finds -- see `main.js`. */
  get held() { return this.dir > 0 && this.arrived; }

  /**
   * Go.  `at` is where the gate is in the world, for the camera work;
   * `anchor` and `lost` ride along in the flag -- see `FLAG`.
   */
  begin(j, at, { anchor = null, lost = 0 } = {}) {
    if (this.active) return;
    this.junction = j;
    this.dir = 1;
    this.t = 0;
    this.arrived = false;
    this.baseFov = this.camera.fov;
    if (at) this.target.copy(at);
    try {
      sessionStorage.setItem(FLAG, JSON.stringify({
        seed: this.seed, n: j.n, id: j.billboard.id, s: +j.s.toFixed(2),
        a: anchor, lost: +lost.toFixed(1), name: j.billboard.back ? null : j.billboard.name,
      }));
    } catch { /* private window */ }
  }

  /**
   * Did this page load arrive through a gate?  Consumed once, so a reload
   * on the far side of a diversion does not replay the arrival for ever.
   */
  static cameBack() {
    let raw = null;
    try {
      raw = sessionStorage.getItem(FLAG);
      if (raw === null) return null;
      sessionStorage.removeItem(FLAG);
    } catch {
      return null;
    }
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && Number.isFinite(v.id)) {
        const n = Number.isFinite(v.n) ? v.n : v.id - 1;
        const a = v.a && Number.isFinite(v.a.n) && Number.isFinite(v.a.s)
          ? { n: v.a.n, s: v.a.s, c: Number.isFinite(v.a.c) ? v.a.c : null } : null;
        return {
          seed: String(v.seed), n, s: Number.isFinite(v.s) ? v.s : null, anchor: a,
          lost: Number.isFinite(v.lost) ? v.lost : 0,
          name: typeof v.name === 'string' ? v.name : null,
        };
      }
    } catch { /* the old flag, or something hand-edited */ }
    return { seed: null, n: null, s: null, anchor: null, lost: 0, name: null };
  }

  /**
   * Play the crossing backwards, which is what coming out of a gate is.
   *
   * The browser's back button reloads the page and the cookie resumes the
   * drive, so without this the round trip is a white flash and a
   * hillside.  A second of the same effect unwinding is most of what
   * makes it feel like one motion rather than two events.
   */
  resume(at) {
    /* From a page held on its own white-out -- a back/forward-cache
     * restore -- the lens is still open, and taking that as the base
     * would leave the camera wide for the rest of the drive. */
    if (this.dir > 0) this.camera.fov = this.baseFov;
    this.dir = -1;
    this.t = 1;
    this.arrived = true;
    this.stayed = false;
    this.junction = null;
    this.baseFov = this.camera.fov;
    this.target.set(0, 0, 0);
    if (at) this.target.copy(at);
    else this.centre.set(0.5, 0.5);
    this.arrivedBy = 'resume';
  }

  /**
   * The same thing at the start of a fresh drive.  `prompt_19.md` item 3.
   *
   * A separate name for one line of difference today and none of
   * behaviour, because the two are called for different reasons: this is
   * the first thing a new player ever sees and `resume` is the tail of a
   * round trip, and a future change to one -- a longer opening, a sound
   * -- should not quietly change the other.
   *
   * `at` is the car.  The gate it came out of is behind the camera, where
   * a projection means nothing, so the world resolves outward from the
   * thing the player is about to drive.
   */
  arrive(at) {
    this.resume(at);
    this.arrivedBy = 'arrive';
  }

  /**
   * Refuse the crossing.  `Esc`, or the button on a touch screen.
   *
   * True if it took -- which it does right up until the navigation has
   * been asked for, after which the page is already leaving and there is
   * nothing here to cancel.
   */
  cancel() {
    if (this.dir <= 0 || this.arrived) return false;
    this.dir = -1;
    this.stayed = true;
    return true;
  }

  /**
   * One frame.  Returns the axes the car should be driving on, or null to
   * leave the player in charge.
   */
  update(dt) {
    if (!this.dir) return null;

    const span = this.dir > 0 ? DURATION : BACK_DURATION;
    this.t += (dt / span) * this.dir;

    if (this.dir > 0 && this.t >= COMMIT && !this.arrived) {
      this.arrived = true;
      /**
       * And the case where nothing happens.
       *
       * Three ways to drive through a gate and still be here afterwards:
       * `?nogo=1`, which is how the probes and the recorder watch this
       * without the page leaving; the home gate on a tab with no history
       * to go back to, where `Depart.navigate` deliberately refuses to
       * invent a destination; and any navigation the browser declines.
       *
       * A white screen is the correct last frame of a page that is going
       * away and the wrong one for a page that is staying, so the
       * crossing runs *backwards* instead -- the world comes back out of
       * the light, which is the same animation the return trip plays and
       * reads as the gate not having taken.
       */
      const left = this.onArrive ? this.onArrive(this.junction) : true;
      if (!left) {
        this.dir = -1;
        this.stayed = true;
        return ZERO;
      }
    }

    if (this.t >= 1 && this.dir > 0) {
      /* Held at the end rather than switched off.  The navigation has
       * already been asked for and this tab is on its way out; dropping
       * back to a hillside for the last few frames before it goes is the
       * one thing the white-out exists to prevent. */
      this.t = 1;
      this.pipeline.setWarp(0.999, this._project());
      this.camera.fov = this.baseFov * 1.55;
      this.camera.updateProjectionMatrix();
      return ZERO;
    }
    if (this.t <= 0 && this.dir < 0) {
      this.t = 0;
      this.dir = 0;
      this.pipeline.setWarp(0, null);
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
      if (this.stayed && this.onStay) this.onStay(this.junction);
      this.stayed = false;
      this.junction = null;
      return null;
    }

    this.pipeline.setWarp(this.t, this._project());
    /* The lens opens as the frame is pulled in.  A wider field with the
     * radial smear is the difference between the world rushing past and
     * the camera zooming, and only one of those is travelling. */
    const e = this.t * this.t * (3 - 2 * this.t);
    this.camera.fov = this.baseFov * (1 + 0.55 * e);
    this.camera.updateProjectionMatrix();

    return this.dir > 0 ? ZERO : null;
  }

  /** Where the gate is on screen, in UV.  The smear runs from here. */
  _project() {
    if (!this.target.lengthSq()) return this.centre;
    this._v.copy(this.target).project(this.camera);
    /* Clamped, because a gate that has gone off the edge of the frame
     * would otherwise put the centre of the effect outside it and the
     * smear would run sideways off the screen. */
    this.centre.set(
      Math.min(1.2, Math.max(-0.2, this._v.x * 0.5 + 0.5)),
      Math.min(1.2, Math.max(-0.2, this._v.y * 0.5 + 0.5)),
    );
    return this.centre;
  }
}

/**
 * No throttle, no steering, and the handbrake on.
 *
 * The car coasts to a stop over the length of the animation rather than
 * stopping on the frame it crossed the line, which is both kinder to look
 * at and what actually happens when something takes the wheel off you.
 */
const ZERO = { throttle: 0, brake: 0, steer: 0, handbrake: 1 };
