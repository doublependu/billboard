/* ------------------------------------------------------------------ *
 * Leaving.
 *
 * **This file used to be the decision and is now the announcement.**
 *
 * `prompt_17.md` asked for a turn onto a side road to take the player to
 * a link, and what was here did it on a three-second countdown, with a
 * long note arguing that the delay was worth departing from the brief
 * for: a navigation that fires unannounced ends the drive, the drive is
 * the product, and a player who clipped a turning while looking at the
 * scenery should not learn what happened from somebody else's website.
 *
 * That argument was right and the mechanism was a compromise.
 * `prompt_18.md` item 3 replaces it with something better on every axis:
 * *create a mysterious portal at the end of each side road, driving
 * through it takes the player to the link.*  The commitment is now a
 * place rather than a timer.  A player who did not mean to leave has the
 * whole length of the side road -- three to eight seconds, and visibly a
 * road going somewhere -- to brake or steer out, and a player who does
 * mean to leave says so by driving at the gate.  Nobody has to be told
 * how long they have left, because what they have left is a distance they
 * can see.
 *
 * So the card is no longer a countdown.  It comes up on the turn, names
 * the billboard and the host, and shows how far down the side road the
 * car is against where the gate stands.
 *
 * **And it no longer cancels anything.**  The first version of this let
 * braking, steering out of the corridor or `Esc` refuse the turning, and
 * refusing *disarmed* it -- which turned out to mean that a single frame
 * of ordinary driving with the wheels a little wide, or a moment spent
 * slowing to look at the gate, killed the portal for the rest of that
 * visit.  The player then drove through a ring that did nothing.
 *
 * There is exactly one way to refuse now, and it is during the crossing:
 * `Esc`, or the button that appears on a touch screen.  Everything else
 * -- braking, steering, stopping, turning round -- is just driving, and
 * driving a car at a portal is how you go through it.
 *
 * **Same tab, and `location.assign`.**  Not `window.open`.  The trigger
 * fires on a physics frame rather than inside the keydown handler that
 * caused it, so a new tab is a popup with no user gesture behind it and
 * every blocker will eat it silently -- which reaches the player as a
 * billboard that does nothing.  Same-tab also means the browser's back
 * button returns to a page that reads the cookie and resumes, which is
 * the only reason a diversion is survivable at all.
 *
 * The save is forced first, for the same reason `openMenu` forces it:
 * this may be the last thing that happens in this tab, and the throttle
 * is two seconds.
 * ------------------------------------------------------------------ */

const CSS = `
.depart {
  position: fixed; left: 50%; bottom: 12%; transform: translateX(-50%);
  z-index: 8; min-width: 300px; max-width: 84vw; padding: 14px 20px 12px;
  background: rgba(20, 26, 34, .84); color: #f2f5f7;
  border: 1px solid rgba(255,255,255,.22);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  text-align: center; opacity: 0; transition: opacity .22s ease;
  pointer-events: none; backdrop-filter: blur(3px);
}
.depart.on { opacity: 1; }
.depart b { display: block; font-weight: 400; font-size: 14px;
            letter-spacing: .22em; }
.depart u { display: block; text-decoration: none; font-size: 10px;
            letter-spacing: .18em; opacity: .62; padding-top: 6px; }
.depart .depart-bar { display: block; height: 1px; margin: 13px 0 9px;
                      background: rgba(255,255,255,.22); overflow: hidden; }
.depart .depart-bar i { display: block; height: 100%; width: 0;
                        background: rgba(255,255,255,.86);
                        transition: width .18s linear; }
.depart s { display: block; text-decoration: none; font-size: 9px;
            letter-spacing: .20em; opacity: .5; }
body.clean .depart { display: none; }
`;

export class Depart {
  constructor(root = document.body) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.el = document.createElement('div');
    this.el.className = 'depart';
    this.el.innerHTML =
      '<b></b><u></u><span class="depart-bar"><i></i></span><s></s>';
    root.appendChild(this.el);
    this.name = this.el.querySelector('b');
    this.host = this.el.querySelector('u');
    this.bar = this.el.querySelector('i');
    this.note = this.el.querySelector('s');

    /** The junction being left by, or null. */
    this.junction = null;
    /** Set once the navigation has been asked for, so it happens once. */
    this.going = false;
    /** Called with no arguments just before leaving.  `main.js` saves. */
    this.onLeave = null;
    /** `?nogo=1` arms everything and never navigates.  This is how
     *  `tools/probe/sign.mjs` watches the trigger without the page
     *  leaving underneath it, and how the recorder drives past a turning
     *  without the film ending there. */
    this.dry = false;
    this.lastFired = null;
    /** What the last `navigate` did, or would have done under `?nogo=1`. */
    this.lastAction = null;
  }

  /** Raise the card for `j`.  Idempotent while it is up. */
  begin(j) {
    if (this.junction === j || this.going) return;
    this.junction = j;
    const b = j.billboard;
    this.name.textContent = b.name;
    if (b.back) {
      /* The way back to wherever the player came from.  Named for what it
       * does rather than for a URL, because there is not one -- see
       * `navigate`. */
      this.host.textContent = this.canGoBack()
        ? 'the way you came'
        : 'nothing to go back to';
    } else {
      let host = b.link;
      try { host = new URL(b.link).host; } catch { /* keep the raw string */ }
      this.host.textContent = 'opening  ' + host;
    }
    this.note.textContent = 'drive through the gate';
    this.bar.style.width = '0%';
    this.el.classList.add('on');
  }

  /**
   * Is there a previous page to go back to?  `prompt_18.md` item 6.
   *
   * `history.length` is the only thing a page is allowed to know about
   * its own history, and it counts the current entry -- so anything above
   * one means `back()` has somewhere to go.  It is a heuristic (a reload
   * adds nothing, a redirect adds one) and it is used the safe way round:
   * a false positive costs a `back()` that does nothing, and there is no
   * fallback navigation to a referrer, because a gate that sometimes
   * takes you to a stranger's page is worse than one that sometimes does
   * nothing at all.
   */
  canGoBack() {
    try { return history.length > 1; } catch { return false; }
  }

  /**
   * Put the card away.
   *
   * Just the card: the turning is *not* disarmed, because the only thing
   * that lowers it now is the car no longer being on the side road, and
   * a car that wanders wide for a frame has not refused anything.
   */
  cancel() {
    if (!this.junction) return;
    this.junction = null;
    this.el.classList.remove('on');
  }

  /**
   * One frame.  `on` is `Junctions.onSpur`'s answer or null; `refused` is
   * true if the player is asking to stay.
   *
   * The bar is now a *distance* rather than a countdown -- how far down
   * the spur the car is, against where the gate stands.  Same pixels,
   * and it now measures something the player can also see out of the
   * windscreen.
   */
  update(dt, on) {
    if (this.going) return;
    if (!on) { this.cancel(); return; }
    this.begin(on.j);
    if (this.junction !== on.j) return;
    const frac = Math.min(1, Math.max(0, on.a / on.j.portalA));
    this.bar.style.width = `${(frac * 100).toFixed(1)}%`;
  }

  /**
   * The car has gone through the gate.  Latch, and say so once.
   *
   * Separate from `update` because the crossing is detected in `main.js`
   * where the physics is, and because this is the point of no return: it
   * is what `Warp` is started from, and the navigation happens later,
   * under the white-out, from `navigate`.
   */
  commit(j) {
    if (this.going) return false;
    this.going = true;
    this.junction = j;
    this.lastFired = j.billboard;
    /* The card stays up through the crossing and becomes the one place
     * the way out is written down.  It is the only cancel there is, so it
     * has to be on screen for as long as it is available.  Written here
     * rather than through `begin`, which declines to do anything once
     * `going` is set -- that is what stops the approach card fighting the
     * crossing for the same element. */
    const b = j.billboard;
    this.name.textContent = b.name;
    if (b.back) this.host.textContent = 'the way you came';
    else {
      let host = b.link;
      try { host = new URL(b.link).host; } catch { /* keep the raw string */ }
      this.host.textContent = 'opening  ' + host;
    }
    this.note.textContent = 'ESC to cancel';
    this.bar.style.width = '100%';
    this.el.classList.add('on');
    return true;
  }

  /** The crossing was refused, or led nowhere.  Back to driving. */
  release() {
    this.going = false;
    this.junction = null;
    this.note.textContent = '';
    this.el.classList.remove('on');
  }

  /**
   * Go.  Called under the white-out, once.
   *
   * `?nogo=1` stops short of the navigation and nothing else, so a probe
   * watches the whole animation on a page that stays where it is, and a
   * recording drives through a gate without the film ending there.
   */
  navigate(b) {
    if (this.onLeave) this.onLeave(b);
    /* Decided before the dry test rather than after it, so that
     * `?nogo=1` reports *what would have happened* instead of only that
     * nothing did.  A probe that can see the difference between "would
     * have gone back" and "would have opened a link" is the only way to
     * test the home gate without a browser history to go back into. */
    const action = b.back ? (this.canGoBack() ? 'back' : 'nowhere') : 'link';
    this.lastAction = action;
    if (this.dry) return 'dry:' + action;
    if (action === 'back') history.back();
    else if (action === 'link') location.assign(b.link);
    return action;
  }
}
