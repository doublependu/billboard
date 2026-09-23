/* ------------------------------------------------------------------ *
 * The list that loops, and the things that assumed it did not.
 *
 * `plan_4.md` §8.  Five checks, each a claim `prompt_4.md` item 4 made
 * true or a fault it would have introduced:
 *
 *   loop       30+ turnings carry billboards 1..N, 1..N, ... and every gap
 *              is inside [SPACING_MIN, SPACING_MAX] or on `overruns`
 *   anchor     re-siting from a saved anchor puts every later turning
 *              exactly where the unbroken chain put it -- `resumeFrom`'s
 *              argument, checked rather than trusted
 *   faces      the face cache stays at FACE_CAP however far the drive goes
 *   one        with a one-entry list, two turnings showing the same
 *              billboard are both built, and a left and a right one do
 *              not share a face
 *   return     the back button from turning 23: the car comes back parked
 *              on that spur, having sited a handful of turnings and not
 *              twenty-three
 *
 *     npx vite --port 5178
 *     HEADLESS=1 node perf-bench/loop.mjs
 *     SEED=alder TURNS=40 HEADLESS=1 node perf-bench/loop.mjs
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';

const PORT = process.env.PORT || 5178;
const SEED = process.env.SEED || 'country';
const TURNS = Number(process.env.TURNS || 34);
const DEEP = Number(process.env.DEEP || 23);
const BASE = `http://127.0.0.1:${PORT}/`;

const c = await launch({ w: 960, h: 540 });
await c.send('Page.enable');
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failed++; };

async function open(q) {
  await c.send('Page.navigate', { url: BASE + '?' + q });
  for (let i = 0; i < 240; i++) {
    if (await c.evaluate('!!(window.__game && window.__game.loaded)').catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await c.evaluate('window.__game.loaded');
}

/* Walk the car up the road in 150 m hops, ticking the world at each, and
 * yield between hops so the billboard images can land -- a face still
 * waiting on its image is one the cache is not allowed to drop. */
const WALK = `async (until, onHop) => {
  const g = __game, J = g.junctions;
  let maxFaces = 0;
  for (let s = 40; !until(J) && s < 90000; s += 150) {
    for (let i = 0; i < 200 && g.road.length < s + 400; i++) g.tick(1 / 30);
    g.car.placeOn(g.road, s);
    for (let k = 0; k < 4; k++) g.tick(1 / 30);
    if (onHop) onHop(g, s);
    maxFaces = Math.max(maxFaces, g.signs.faceCount);
    await new Promise((r) => setTimeout(r, 15));
  }
  return maxFaces;
}`;

/* ---------------------------- loop, anchor, faces ------------------------ */
await open(`rec=1&fresh&sound=0&dynres=0&nogo=1&seed=${SEED}`);
const a = await c.evaluate(`(async () => {
  const g = __game, J = g.junctions;
  const { BILLBOARDS } = await import('/src/road/billboards.js');
  const maxFaces = await (${WALK})((J) => J.byN.size >= ${TURNS});
  await new Promise((r) => setTimeout(r, 1500));
  const rows = [...J.byN.values()].map((j) => ({
    n: j.n, id: j.billboard.id, s: j.s, side: j.side, kind: j.kind, len: j.len }));

  /* The same road, sited again from an anchor part way along -- once to
   * the end, and then from *every* anchor for the two turnings after it,
   * because the fault this exists for (the scan cursor off the window's
   * grid) only shows on the windows where the first candidate won. */
  const key = (j) => ({ n: j.n, id: j.billboard.id, s: j.s, side: j.side, kind: j.kind, len: j.len });
  const from = (n, upto) => {
    const K = new J.constructor(g.terrain, g.road, { seed: J.seed });
    K.siteHome();
    const an = J.byN.get(n);
    K.resumeFrom({ n: an.n, s: an.s, c: an.cursor });
    for (let i = 0; i < 400 && !K.byN.has(upto); i++) K.update(K.cursor + 900);
    return [...K.byN.values()].map(key);
  };
  const last = rows[rows.length - 1];
  const an = J.byN.get(${Math.floor(TURNS * 0.6)});
  const again = from(an.n, last.n);
  const every = [];
  for (let n = 0; n + 2 <= last.n; n++) every.push({ n, got: from(n, n + 2) });

  return { rows, again, every, anchor: an.n, count: BILLBOARDS.length,
           overruns: J.overruns, home: J.home && J.home.s,
           maxFaces, facesNow: g.signs.faceCount };
})()`);

const rows = a.rows;
console.log(`${SEED}: ${rows.length} turnings, list of ${a.count}, home at ${a.home?.toFixed(0)}`);
console.log(rows.map((r) => r.id).join(' '));
check(rows.length >= TURNS, `sited ${TURNS} turnings`);
check(rows.every((r, i) => r.n === i && r.id === (i % a.count) + 1),
      'billboard ids run 1..N and start again');
const gaps = rows.slice(1).map((r, i) => r.s - rows[i].s);
const over = gaps.filter((d) => d > 914.4 + 0.5).length;
check(gaps.every((d) => d >= 457.2 - 0.5), `no gap under SPACING_MIN (min ${Math.min(...gaps).toFixed(0)} m)`);
check(over === a.overruns.filter((o) => o.from > 0).length,
      `every gap over SPACING_MAX is a recorded overrun (${over}, max ${Math.max(...gaps).toFixed(0)} m)`);

const tail = rows.filter((r) => r.n > a.anchor);
const same = tail.every((r) => {
  const q = a.again.find((x) => x.n === r.n);
  return q && q.id === r.id && Math.abs(q.s - r.s) < 1e-6 && q.side === r.side
      && q.kind === r.kind && q.len === r.len;
});
check(same && a.again.every((r) => r.n > a.anchor),
      `re-siting from anchor ${a.anchor} reproduces turnings ${a.anchor + 1}..${rows.length - 1} exactly`);
const bad = a.every.filter(({ got }) => got.some((q) => {
  const r = rows[q.n];
  return !r || Math.abs(q.s - r.s) > 1e-6 || q.side !== r.side || q.kind !== r.kind || q.len !== r.len;
})).map(({ n }) => n);
check(bad.length === 0, `every anchor 0..${rows.length - 3} reproduces the two turnings after it`
      + (bad.length ? ` -- not from ${bad.join(' ')}` : ''));
check(a.maxFaces <= 6 && a.facesNow <= 4,
      `face cache bounded: peak ${a.maxFaces} while images land, ${a.facesNow} after`);

/* ---------------------------------- one ---------------------------------- */
/* Trim the list to one entry after boot.  Everything sited from here on is
 * billboard 1, so any two signs in the window are the same billboard. */
await open(`rec=1&fresh&sound=0&dynres=0&nogo=1&seed=${SEED}`);
const one = await c.evaluate(`(async () => {
  const { BILLBOARDS } = await import('/src/road/billboards.js');
  BILLBOARDS.splice(1);
  let pairs = 0, mixed = 0, sharedAcross = 0, gates = 0;
  await (${WALK})((J) => J.byN.size >= 16, (g) => {
    const faces = [...g.signs.live].filter(([k]) => k.startsWith('face:'));
    const js = faces.map(([k]) => g.junctions.byN.get(Number(k.slice(5))));
    if (faces.length >= 2 && js.every((j) => j && j.billboard.id === 1)) {
      pairs++;
      if (js[0].side !== js[1].side) {
        mixed++;
        if (faces[0][1].mat.map === faces[1][1].mat.map) sharedAcross++;
      }
    }
    if (g.portals.live.size >= 2) gates++;
  });
  return { pairs, mixed, sharedAcross, gates };
})()`);
check(one.pairs > 0, `one-entry list: two signs for the same billboard built together (${one.pairs} hops)`);
check(one.mixed > 0 && one.sharedAcross === 0,
      `a left and a right sign never share a face (${one.mixed} hops with both)`);
check(one.gates > 0, `two gates for the same billboard standing together (${one.gates} hops)`);

/* --------------------------------- return -------------------------------- */
/* Leave through turning DEEP as the warp would -- the flag in
 * sessionStorage and the save forced -- and come back through the back
 * button, which is a plain load of the page. */
await open(`rec=1&fresh&sound=0&dynres=0&nogo=1&seed=${SEED}`);
const left = await c.evaluate(`(async () => {
  const g = __game, J = g.junctions;
  await (${WALK})((J) => J.byN.has(${DEEP}));
  const j = J.byN.get(${DEEP});
  const anchor = J.anchorBefore(j.s);
  sessionStorage.setItem('br_portal', JSON.stringify({
    seed: g.seed, n: j.n, id: j.billboard.id, s: j.s, a: anchor, lost: 2400, name: j.billboard.name }));
  g.save.write({ seed: g.seed, t: g.clock.t, s: j.s, odometer: 30000, camera: g.chase.mode,
                 auto: 'manual', anchor }, 0, true);
  return { s: j.s, anchor, name: j.billboard.name,
           later: [...J.byN.values()].filter((k) => k.n > (anchor ? anchor.n : -1)).map((k) => [k.n, k.s]) };
})()`);
await open('sound=0&dynres=0&nogo=1');
await new Promise((r) => setTimeout(r, 1500));
const back = await c.evaluate(`(() => {
  const g = __game, J = g.junctions, car = g.car;
  const j = J.byN.get(${DEEP});
  return {
    ns: J.list.map((k) => k.n), s: j && j.s,
    on: J.arcFor(car.pos.x, car.pos.z), parked: g.parkBrake,
    toast: document.querySelector('#hud-toast').textContent,
    drive: g.run.drive,
    later: [...J.byN.values()].map((k) => [k.n, k.s]),
  };
})()`);
console.log(`left through ${DEEP} at s = ${left.s.toFixed(1)}, anchor ${JSON.stringify(left.anchor)}`);
console.log(`came back with turnings [${back.ns.join(' ')}] sited`);
check(back.s !== undefined && Math.abs(back.s - left.s) < 1e-6, `turning ${DEEP} rebuilt in the same place`);
check(back.on !== null && Math.abs(back.on - left.s) < 1e-6 && back.parked,
      'car parked on its spur, handbrake on');
check(back.ns.filter((n) => n >= 0).length <= 6,
      `only a handful of turnings sited on the way back (${back.ns.filter((n) => n >= 0).length})`);
check(back.later.every(([n, s]) => { const o = left.later.find((x) => x[0] === n); return !o || Math.abs(o[1] - s) < 1e-6; }),
      'every turning the return sited is where the first page had it');
check(back.drive === 0 && back.toast.startsWith('distracted by ' + left.name),
      `run at zero and the toast says so: "${back.toast}"`);

c.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
