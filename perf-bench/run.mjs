/* ------------------------------------------------------------------ *
 * The run: the rule that ends one, checked where it could go wrong.
 *
 * `plan_4.md` §5.  Four checks:
 *
 *   autodrive  full autodrive for MINUTES game-minutes on three seeds never
 *              drops under 10 mph -- the claim the whole game rests on,
 *              since *just put on autodrive* is how the prompt describes
 *              the way to drive for ever
 *   stop       slowing through 10 mph ends the run on that frame, and the
 *              best keeps it
 *   gate       crossing a ring ends the run on the crossing frame, the
 *              return flag carries what it cost, and `Esc` (here, the
 *              dry run) does not give it back
 *   parked     a fresh drive shows 0.00, dimmed, until the car is moving
 *
 *     npx vite --port 5178
 *     HEADLESS=1 node perf-bench/run.mjs
 *     MINUTES=20 SEEDS=country,alder,billboard HEADLESS=1 node perf-bench/run.mjs
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';

const PORT = process.env.PORT || 5178;
const SEEDS = (process.env.SEEDS || 'country,alder,billboard').split(',');
const MINUTES = Number(process.env.MINUTES || 8);
/* 60 Hz, not 30: the chunk field builds on a per-frame budget, and at 30
 * steps a game-second a fast car can outrun its own ground in a way no
 * player's frame rate would let it. */
const DT = 1 / 60;
const BASE = `http://127.0.0.1:${PORT}/`;

const c = await launch({ w: 960, h: 540 });
await c.send('Page.enable');
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failed++; };

async function open(q, start = false) {
  await c.send('Page.navigate', { url: BASE + '?' + q });
  for (let i = 0; i < 240; i++) {
    if (await c.evaluate('!!(window.__game && window.__game.loader)').catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (start) {
    for (let i = 0; i < 240; i++) {
      if (await c.evaluate('__game.loader.el.classList.contains("ready")').catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await c.evaluate('__game.start("resume")');
  }
  await c.evaluate('window.__game.loaded');
}

const key = (type, code) => c.evaluate(
  `dispatchEvent(new KeyboardEvent('${type}', { code: '${code}' })); 1`);

/* -------------------------------- autodrive ------------------------------ */
for (const seed of SEEDS) {
  await open(`rec=1&fresh&sound=0&dynres=0&nogo=1&seed=${seed}`);
  await c.evaluate(`__game.auto.setMode('full'); window.__r = {
    stops: [], minV: Infinity, counting: false, prev: 0, t: 0 }; 1`);
  const total = Math.round(MINUTES * 60 / DT);
  const t0 = Date.now();
  for (let done = 0; done < total; done += 1800) {
    await c.evaluate(`(() => {
      const g = __game, R = __r, V = ${10 * 0.44704};
      for (let i = 0; i < 1800; i++) {
        g.tick(${DT}); R.t += ${DT};
        const v = Math.abs(g.car.speed);
        if (v >= V) R.counting = true;
        else if (R.counting) R.minV = Math.min(R.minV, v);
        if (R.counting) R.minV = Math.min(R.minV, v);
        if (g.run.drive < R.prev && R.prev > 0) R.stops.push({ t: +R.t.toFixed(1), at: +R.prev.toFixed(0), s: +g.arc.toFixed(0) });
        R.prev = g.run.drive;
      }
    })()`);
  }
  const r = await c.evaluate(`({ ...__r, drive: __game.run.drive, arc: __game.arc })`);
  console.log(`${seed}: ${MINUTES} game-min in ${((Date.now() - t0) / 1000).toFixed(0)} s, `
            + `${(r.drive / 1609.344).toFixed(2)} mi run, slowest ${(r.minV * 2.23694).toFixed(1)} mph`);
  check(r.stops.length === 0, `${seed}: full autodrive never ends the run`
        + (r.stops.length ? ` -- ended ${JSON.stringify(r.stops.slice(0, 4))}` : ''));
}

/* ---------------------------------- stop --------------------------------- */
/* Same page, same run: take the cruise down to walking pace and let the
 * autopilot brake through the line. */
const stop = await c.evaluate(`(() => {
  const g = __game, V = ${10 * 0.44704};
  const before = g.run.drive, bestBefore = g.run.best;
  g.auto.cruise = 2;
  let at = null;
  for (let i = 0; i < 60 * 30 && at === null; i++) {
    const v0 = Math.abs(g.car.speed), d0 = g.run.drive;
    g.tick(${DT});
    if (d0 > 0 && g.run.drive === 0) at = { v0, v: Math.abs(g.car.speed), d0 };
  }
  return { before, bestBefore, at, best: g.run.best,
           toast: document.querySelector('#hud-toast').textContent };
})()`);
check(stop.at && stop.at.v0 >= 10 * 0.44704 - 0.2 && stop.at.v < 10 * 0.44704,
      `braking ends the run on the frame it crosses 10 mph `
      + (stop.at ? `(${(stop.at.v0 * 2.23694).toFixed(2)} -> ${(stop.at.v * 2.23694).toFixed(2)} mph)` : '(never)'));
check(stop.at && stop.best >= stop.at.d0 - 1e-6 && stop.best >= stop.bestBefore,
      `the best keeps it (${(stop.best / 1609.344).toFixed(2)} mi), and says: "${stop.toast}"`);

/* ---------------------------------- gate --------------------------------- */
/* Onto the next turning's spur, on the straight the last twelve metres of
 * every spur are built as (`_spur`), rolling at 20 mph toward the ring
 * with the throttle held.  Nothing steers, so it has to start pointed at
 * the hole. */
await c.evaluate('sessionStorage.removeItem("br_portal"); 1');
const gate = await c.evaluate(`(async () => {
  const g = __game, J = g.junctions, V = ${10 * 0.44704};
  g.auto.setMode('manual');
  const j = J.list.find((k) => k.n >= 0 && k.s > g.arc + 50) || J.list.find((k) => k.n >= 0);
  const p = j.pointAt(Math.max(6, j.portalA - 11), {});
  g.car.placeAt(p.x, p.y, p.z, Math.atan2(p.tz, p.tx));
  g.tick(${DT});
  g.car.body.setLinvel({ x: p.tx * 9, y: 0, z: p.tz * 9 }, true);
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
  let seeded = false, commit = null;
  for (let i = 0; i < 60 * 12 && !commit; i++) {
    const was = g.depart.lastFired;
    g.tick(${DT});
    /* A run of a kilometre, once the car is above the line, so the
     * crossing has something to take. */
    if (!seeded && Math.abs(g.car.speed) >= V) { g.run.drive = 1000; seeded = true; }
    if (g.depart.lastFired && g.depart.lastFired !== was) {
      commit = { drive: g.run.drive, v: Math.abs(g.car.speed) };
    }
  }
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  const flag = JSON.parse(sessionStorage.getItem('br_portal') || 'null');
  /* Let the dry crossing unwind, the way Esc would. */
  for (let i = 0; i < 60 * 4; i++) g.tick(${DT});
  return { n: j.n, name: j.billboard.name, seeded, commit, flag, after: g.run.drive,
           toast: document.querySelector('#hud-toast').textContent };
})()`);
check(gate.seeded && gate.commit && gate.commit.drive === 0,
      `crossing gate ${gate.n} ends the run on the crossing frame`
      + (gate.commit ? ` (at ${(gate.commit.v * 2.23694).toFixed(1)} mph)` : ' (never crossed)'));
check(gate.flag && gate.flag.n === gate.n && gate.flag.lost >= 1000 && gate.flag.name === gate.name,
      `the return flag names turning ${gate.n} and carries the run it cost (${gate.flag && gate.flag.lost} m)`);
check(gate.after < 50 && gate.toast.startsWith('stayed'),
      `staying does not give it back: "${gate.toast}"`);

/* --------------------------------- parked -------------------------------- */
await open('fresh&sound=0&dynres=0&nogo=1&seed=country', true);
const parked = await c.evaluate(`({
  idle: document.querySelector('#hud-run').classList.contains('idle'),
  text: document.querySelector('#hud-dist').textContent,
  parked: __game.parkBrake, drive: __game.run.drive })`);
check(parked.parked && parked.idle && parked.text === '0.00' && parked.drive === 0,
      `a fresh drive starts parked at ${parked.text}, dimmed`);
await key('keydown', 'KeyW');
/* Real frames, so however long this machine takes to get the car past
 * 10 mph -- a software rasteriser can take a while. */
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (await c.evaluate('__game.run.drive > 20')) break;
}
const moving = await c.evaluate(`({
  idle: document.querySelector('#hud-run').classList.contains('idle'),
  v: Math.abs(__game.car.speed), drive: __game.run.drive,
  text: document.querySelector('#hud-dist').textContent })`);
await key('keyup', 'KeyW');
check(!moving.idle && moving.drive > 0,
      `and counts once it is moving: ${moving.text} mi at ${(moving.v * 2.23694).toFixed(0)} mph`);

c.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
