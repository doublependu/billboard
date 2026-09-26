# next_5 — `upstream/main` merged in, uncommitted

Implements `ai/plan_5.md`, with the defaults it proposed.  `git merge
--no-commit --no-ff upstream/main` (upstream at `b45fc76`), conflicts
resolved, everything staged, **no commit**.  `MERGE_HEAD` is set, so a plain
`git commit` concludes it as a two-parent merge on top of `8cd76c8` ("plan
5", which was committed while the merge was open — that's fine, it just
becomes the first parent).

---

## 1. What was resolved, and how

| file | resolution |
|---|---|
| `.gitignore` | upstream's lines (`chrome-prof-*/`) |
| `ai/prompt_4.md`, `plan_4.md`, `next_4.md` | ours, unchanged |
| `ai/upstream/` | upstream's `prompt_4`, `plan_4`, `next_4`, `suggest_4`, plus a README saying whose they are |
| `index.html` | fork link → `https://github.com/doublependu/billboard` |
| `src/world/terrain.js` | upstream's `heightAt(x, z, h = base)` + `lastRoad`, with our junction stage on the no-road branch; `roadPaint(x, z, o, main)` takes the main-road answer when the caller has it |
| `src/world/chunks.js` | upstream's rewritten `_build` (base grid, curvature from it, road written in the first loop), but that first loop calls `roadPaint(…, T.lastRoad)` so spurs are still paved and `roadJ`/`roadK` still written; both sized to `nv`; `writeSkirt` copies them too |
| `src/core/post.js` | both routes and the warp; **while the warp is on, the FXAA route is taken** even where the up route would be |
| `src/main.js` | both blocks; `recover()` falls back to `arcOf(near)` rather than `auto.s`; `?debug=1` gets a line: arc, spur/road, parked, run, best |
| `tools/play/lib.mjs`, `perf-bench/void.mjs` | realtime URLs get `&start=road` (see §3) |
| `README.md` | `start=road` next to `?auto`; upstream's `prompt_4.md` pointed at `ai/upstream/` |

Checked and needing nothing: `junctions.height` uses its own scratch
object, so `lastRoad` (which is `terrain.js`'s shared `_q`) survives it.
`_restitch` rewrites only heights and normals; the skirt copy it makes
reads road attributes that have not changed.

## 2. Tests: what ran, what they said

No `npm test` exists.  Everything below ran on the merged tree, headless,
on this machine.

| check | result |
|---|---|
| `npm run build` | ok; main chunk 100.1 kB gz vs. 97.9 kB on pre-merge HEAD |
| `perf-bench/run.mjs` | **all passed** — 3 seeds × 8 game-min autodrive, stop, gate, parked |
| `perf-bench/loop.mjs` | **all passed** — 34 turnings, anchors, face cap, one-entry list, return from 23 |
| `perf-bench/dpr.mjs` | surface: canvas 1800×1200, up route; phone: 786×1702, up route; desktop: fxaa.  Same as upstream reports |
| `perf-bench/void.mjs` (6× throttle, 300 s) | **pass** — 13442 frames, 0 falls, 0 no-chunk, 0 stale collider; 1 m chunks ~81 ms |
| `perf-bench/seam.mjs` (4× throttle, 300 s) | **pass** — 0 / 1500 frames with a crack, 5.6 km, past several turnings |
| `perf-bench/far.mjs` | matches upstream's table except 60 km wheel jitter 1.35 mm vs. 0.62 (see §4) |
| `tools/play/autoplay.mjs --minutes 20` (stepped) | **no failures** — 21.9 km, one recover (the scenario's own `T`) |
| `tools/play/autoplay.mjs --realtime --throttle 4 --quality low --minutes 5` | **1 FAILURE**, reproducible — see §3 |
| warp on the up route (scratch probe, phone emulation) | draws: ring → radial blur → back to the up route after |

`perf-bench/faces.mjs` is a picture generator, not a test; not run.  The
`tools/probe/*.mjs` our code comments cite (`portal`, `park`, `sign`,
`boot`, `rest`, `clouds`) are in neither repo and could not be run.

## 3. The realtime autoplay failure — upstream's, not the merge's

`nudge: not back in lane 15 s after a nudge`, at 2.63 km, both runs.

Traced: the scenario's first nudge is `KeyD` for 0.444 s at s ≈ 2555 (the
seeded schedule, identical on both sides).  The car runs ~10 m right of
the road and stops dead ~7 m off at s ≈ 2640, then creeps at under 1 m/s,
never reaching 3.5 m within the 15 s.  There is no tree and no sign post
within 6 m of where it stops.

**Upstream does the same.**  Replaying that exact nudge in realtime on
upstream's own tree stops the car at s ≈ 2619, 7 m off, speed ~0, creeping
the same way.  Upstream's own autoplay run passed only because its car
reaches that point on a slightly different schedule (it starts on the
road at s = 51, not parked on a spur), so its nudge did not end up at
that spot.  In stepped mode neither side gets stuck.

So: a real autopilot weakness (it does not back out of whatever it is
pressed against off-road), exposed by where the timing happens to land.
Not fixed here, because a merge is not the place for autopilot changes.

`start=road` is what let the realtime run move at all: without it a
fresh drive parks on the home spur with the handbrake on, and only a
manual throttle/brake lets it off.

## 4. Things noticed, not changed

* **60 km wheel jitter** (`far.mjs`): 1.35 mm vs. 0.62.  With `?signs=off`
  it is 0.615, i.e. upstream's number.  The 10 s test drive passes the
  mouth of turning 86 (s = 60126) and one side's wheels move a few mm
  across the bellmouth.  Our junctions' doing, and small; a
  bellmouth-smoothness probe would pin it down.
* **First warp on a phone may hitch.**  On the up route the plain look
  pass is never drawn, so its shader compiles on the first frame of the
  first warp.  Nothing measured it.  If it shows, draw the look quad once
  into a 1×1 target at boot.
* **The ground-net rescue ends the run** (plan §3, decision 4, default
  kept): `watchGround` → `recover()` → `placeOn` stops the car, and the
  run ends as a stop.  Unfair when the game lost the ground; a grace
  window in `run.js` would fix it.
* Upstream's comments that say "`prompt_4.md`" mean `ai/upstream/prompt_4.md`;
  left as written.

## 5. Next

1. Review, then `git commit` to conclude the merge.
2. The autopilot getting pinned off-road (§3) — back out when stuck with
   the wheel held off the road; then the realtime autoplay passes as it
   stands.
3. The ground-net grace window (§4).
4. `tools/probe/` — either bring those probes into the repo or drop the
   references to them.
