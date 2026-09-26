# plan_5 — bring in `upstream/main`

Answers `ai/prompt_5.md`: take `boomgogo/country-road`'s `main` into this
repo, resolve the conflicts, and pass everything that counts as a test here.

Nothing in this file has been applied.  Everything below was found by
fetching `upstream` and doing a trial merge in a throwaway worktree
(since removed); the checkout is untouched.

---

## 0. What the two sides are

Both branched from `0f1e007` ("itr 3").  Since then:

| side | commits | what |
|---|---|---|
| **ours** (`main`) | 11 | `1a8915f` billboards / junctions / portals / warp; `af568f7` itr 4 (the run rule, ten billboards, the looping list); cloudflare deploy; GPL; prompt_5 |
| **upstream** | 9 | their own `prompt_4` → `plan_4` → itr 4: autoplay + film tools, DPR-correct canvas with an "up" pass, governor floors per tier, chunk build 3.5× cheaper, seam restitching, skirts, collider revisions, ground watch, `?debug=1`, fork-me link; GPL; credit |

The trial merge (`git merge upstream/main`) auto-merges 13 files and stops
on **8**:

| file | hunks | kind |
|---|---|---|
| `.gitignore` | 1 | trivial |
| `ai/prompt_4.md`, `ai/plan_4.md`, `ai/next_4.md` | add/add | same names, different conversations |
| `src/main.js` | 1 textual (+ semantic, §3) | both sides added a block in the same spot |
| `src/core/post.js` | 3 | our warp pass vs. their up route |
| `src/world/terrain.js` | 1 | both changed the top of `heightAt` |
| `src/world/chunks.js` | 4 | our junction paint vs. their rewritten `_build` |

`README.md`, `index.html`, `package.json`, `package-lock.json`,
`src/car/physics.js`, `LICENSE` and the `ai/perf-bench → perf-bench` move
(both sides made it; upstream then edited `cdp.mjs`) all merge cleanly.

---

## 1. Merge, not rebase

The prompt allows either.  Merge, for four reasons:

1. **CLAUDE.md says I don't commit.**  A rebase *is* commits — eleven of
   them, rewritten.  A merge can be done with `--no-commit` and left
   staged with `MERGE_HEAD` set, for you to review and commit.
2. **Our history is already on `origin`.**  A rebase would need a
   force-push of `main`.
3. **One resolution instead of several.**  `1a8915f` and `af568f7` both
   touch `chunks.js`, `main.js`, `terrain.js` and `post.js`; a rebase would
   stop on each and ask for the same conflicts to be resolved against
   intermediate states that never shipped.
4. **The `ai/` pairs stay intact.**  Both sides wrote a `prompt_4`; with a
   merge each keeps the commit it was written in.

```bash
git fetch upstream
git merge --no-commit --no-ff upstream/main
# resolve (§2–§4), test (§5), leave staged
```

---

## 2. The easy ones

**`.gitignore`** — take upstream's lines: `chrome-prof/`, `chrome-prof-*/`,
`capture/` (upstream's `cdp.mjs` now takes a profile per harness).

**`ai/*_4.md`** — ours stay where they are: they are this repo's prompt 4,
and `plan_5`/`next_5` follow on from them.  Upstream's four files go to
`ai/upstream/` under their own names (`prompt_4.md`, `plan_4.md`,
`next_4.md`, `suggest_4.md`), with a one-line `ai/upstream/README.md`
saying where they came from and which commit.  Code comments on both sides
say "`prompt_4.md`" meaning different files.  I'll leave those comments
alone; the new README says which is which.  (`suggest_4.md` doesn't clash
but belongs with its siblings.)

**`index.html` fork link** — merges cleanly, but upstream's `href` is
`https://github.com/boomgogo/country-road`.  Our prompt_4 "Fork me on
Github" billboard points to `https://github.com/doublependu/billboard`.
**Recommend** pointing the link at `doublependu/billboard` so the two
agree.  Say if you'd rather keep upstream's.

**`README.md`** — auto-merges.  Read the result to check it hangs
together: our "The game" section, then their `?debug` / `?auto` /
`tools/play` sections, then the credit.

**`package.json` / lock** — upstream adds `mp4-muxer` (dev only, for
`film.mjs`).  Run `npm install` and make sure `npm ci` is clean against the
merged lock.

---

## 3. `src/main.js`

**Textual hunk** — keep both: our `lastS` / `_spur` / `_prev` /
`PARKED_AXES` / `releaseParkBrake` / `arcOf` / `parkOn` block, then
upstream's `const stats = { recovers: 0 };`.

The auto-merged parts that need a check, because upstream wrote them
without junctions:

* **`recover()` now has a second caller.**  Upstream's `watchGround` calls
  it after 0.4 s under the ground.  `recover()` does
  `road.nearest(...) ?? auto.s`, and down a spur `nearest` is null (46 m
  limit), so a car rescued there goes to a stale `auto.s`.  Fix: use
  `arcOf(near)` (the spur's mouth, or the last good arc) as the fallback.
  One line.  The portal crossing is already safe: the `stepped > 20` guard
  treats a teleport as "not a crossing".
* **Does a ground-net rescue end the run?**  `placeOn` stops the car, so
  the next `run.update` sees < 10 mph and ends the run.  That's fair for
  `troubleFor` (the player rolled it).  It isn't fair for `watchGround`,
  which only fires when the *game* lost the ground.  **Recommend:** a
  `run.excuse()` / grace window after a ground-net rescue so the drive
  survives it.  It's small, but it changes behaviour, so I'll only do it
  if you agree.  Otherwise I'll leave it and list it in `next_5`.
* **`watchGround`'s `below` test** uses `terrain.heightAt`, which on our
  side includes the junction stage, so on a spur it is right as-is.
* **`colliderUnder()`** sits next to our `physics.syncPosts(signs, …)`;
  keep both, in the order the auto-merge gave.
* **Governor** gets `downFps` / `upFps` from the tier.  That merged
  cleanly; check the constructor call still receives them.
* **`window.__game`**: keep both sides' fields (`junctions … arc` and
  `groundWatch, stats`).
* **`?debug=1` overlay**: add a line for ours — `arc`, the spur we're on
  (if any), `parkBrake`, `run.drive`.  Optional, ~3 lines.

---

## 4. The two real conflicts

### 4a. `src/world/terrain.js` — `heightAt`

Upstream: `heightAt(x, z, h = this.hm.base(x, z))` and stores
`this.lastRoad` (the nearest-road answer used, or null) for the mesher.
Ours: the no-road branch returns `junctions.height(...)`.  Merged:

```js
heightAt(x, z, h = this.hm.base(x, z)) {
  this.lastRoad = null;
  if (!this.road) return h;
  const q = this.road.nearest(x, z, _q);
  if (!q) return this.junctions ? this.junctions.height(x, z, h, null, 0) : h;
  this.lastRoad = q;
  …ours unchanged…
```

**What to check:** `lastRoad` is the shared `_q`.  If `junctions.height`
calls back into anything that writes `_q` (`heightAt`, `roadUV`,
`roadPaint`), `lastRoad` is clobbered before the mesher reads it.  Read
`junctions.height` to confirm it doesn't.  If it does, snapshot the four
fields the mesher needs (`d`, `u`, `s`, `y`) into a private object before
the junction stage.

### 4b. `src/world/chunks.js` — `_build`

This is the one that matters.  Upstream rewrote `_build` so the **first**
loop, right after `heightAt`, fills `roadU/roadA/roadS` from `T.lastRoad`
and computes `curv` on its own grid.  The second loop no longer queries
the road at all; that is most of the 3.5×.  Ours replaced `T.roadUV` with
`T.roadPaint(x, z, _paint)`, which also answers for **spurs** (`d` is the
distance to the nearest surface, main *or* spur) and adds `roadJ` (distance
to a mouth) and `roadK` (surface kind).  Taking upstream's fast path as-is
would mean no paint on side roads.  Taking ours as-is would throw away
upstream's saving.

**Resolution: let `roadPaint` accept the main-road answer it would
otherwise look up.**

* `Terrain.roadPaint(x, z, o, q = <query>)`: an optional 4th argument.
  Pass `T.lastRoad` from the mesher's first loop, and `roadPaint` skips its
  own `road.nearest`.  The spur part (`J.roadUV(x, z, mainD)`) still runs,
  but only where `junctions` exists, and it is already bounded by `mainD`.
* In the first loop: `T.roadPaint(x, z, _paint, T.lastRoad)` →
  `roadU, roadA, roadS, roadJ, roadK`.  Keep upstream's `curv`.  Drop both
  sides' old second-loop road writes; keep upstream's comment and add ours
  (the main-road frame / centre line through a junction).
* **Sizes:** upstream's attributes are `nv` long (grid + skirt vertices).
  Size `roadJ` / `roadK` to `nv` too, and keep our sentinel fill so a
  recycled geometry never reads as "in a junction".
* **Skirts:** add `at.roadJ.array` and `at.roadK.array` to `writeSkirt`'s
  `lists`, or a skirt under a bellmouth shades as plain verge.
* **Import:** keep upstream's `ROAD_OFF, ROAD_QUERY, WATER_LEVEL`.  Drop
  our now-unused `_paint` only if nothing else uses it.
* **`needsUpdate`** for `roadJ` / `roadK` goes wherever upstream now flags
  the others.  After a `_restitch` too, if restitch rewrites attributes
  (it rewrites heights and bumps `rev`; check whether it touches road
  attributes).
* **`_restitch` + junctions:** it recomputes edge rows with
  `T.heightAt(x, z, fround(base))`, which includes the junction stage, so
  mended seams follow junction heights.  When a turning is sited into
  ground that's already meshed, our `invalidate` from
  `junctions.takeNewBoxes()` drops those chunks.  Upstream's new
  "invalidated while in flight" handling covers the race our side never
  did.  Nothing to write, but `seam.mjs` has to be run on a seed with
  turnings in view (§5).

Cost check: the `debug` overlay's `build` line and upstream's
`buildTimes` give ms per chunk size.  Merged build time should be close
to upstream's; ours adds one `junctions.roadUV` per vertex only where a
spur is possible.  If it isn't close, gate the spur query on a per-chunk
"any junction box overlaps" test before the loop.

### 4c. `src/core/post.js` — warp × up route

Upstream added a second route: when the scene is visibly smaller than the
canvas, `lookSplit` → `rtUp` (linear + ink in alpha) → `up` pass → screen,
and it `return`s before the FXAA path.  Our warp lives in the FXAA path
only, so on phones and the Surface Go (the devices that take the up route)
**the warp would silently not draw.**

**Resolution: while the warp is on, take the FXAA route.**  The picture is
under a sixteen-tap radial blur for 1.9 s, so the up pass's sharp ink is
invisible anyway.  That costs no new render target at device resolution,
and the warp shader keeps reading the sRGB bytes it was written for.
Concretely:

* `if (this.mode === 'up' && !this.enabled.warp) { …upstream's up route…; return; }`
* The FXAA path keeps our warp branch.  `rtWarp` stays scene-sized (`rw×rh`).
  The final FXAA/look draw goes to the canvas, which is now `ow×oh`; that's
  a plain bilinear stretch, fine under the blur.
* `setSize`: keep both, i.e. `if (this.rtWarp) this.rtWarp.setSize(rw, rh);`
  plus `uAspect`, plus upstream's `rtUp` block.
* Uniforms: `enabled = { ink, grade, fxaa, warp: false }`.  The look mat's
  defines go through upstream's `_defines(m, {})` on both routes.
* `dispose()`: `[rtScene, rtB, rtUp, rtWarp]` and
  `[look, lookSplit, warp, fxaa, up]`.
* Check `portals.centre(gate)` still gives a correct UV now that canvas ≠
  CSS size.  It should: it's a projection, not pixel-based.

---

## 5. "Pass all tests"

There is no `npm test`.  The tests in this repo are the build and the CDP
harnesses on both sides.  The bar is: all of these pass on the merge,
**and** each one also passes on its own parent, so a failure can be
blamed on the merge and not on something that was already broken.

Setup: `npm install`, `npx vite --port 5178`, `HEADLESS=1`.

| check | from | what it guards |
|---|---|---|
| `npm run build` | — | it builds; bundle size vs. both parents (spec: 2–3 s load) |
| `perf-bench/run.mjs` | ours | the run rule; autodrive never drops under 10 mph on 3 seeds |
| `perf-bench/loop.mjs` | ours | the looping list, anchor re-siting, face cap, back-button return |
| `perf-bench/faces.mjs` | ours | billboard faces |
| `perf-bench/dpr.mjs` | upstream | canvas = panel; up route on emulated Surface Go / phone |
| `perf-bench/void.mjs` | upstream | no fall into the void |
| `perf-bench/seam.mjs` | upstream | seams mended — **also run on a seed/stretch with turnings** |
| `perf-bench/far.mjs` | upstream | far LOD |
| `tools/play/autoplay.mjs --minutes 20` | upstream | stepped play with its `Watch`; 0 failures |
| `tools/play/autoplay.mjs --realtime --throttle 4 --quality low` | upstream | realtime, slow CPU |

Two things I expect to have to fix in the harnesses, not the game:

* **Realtime autoplay starts parked.**  Its URL is `?auto=full&fresh`,
  with no `rec`.  On our side a fresh drive parks on the home spur with
  the handbrake on, and only a *manual* throttle/brake releases it
  (`releaseParkBrake`), so the autopilot sits there and `Watch` reports
  **stuck**.  Stepped mode uses `?rec`, which implies `START_ON_ROAD`, so
  it's fine.  Fix in `tools/play/lib.mjs`: add `&start=road` to the
  realtime URL.  (The other choice, letting the autopilot release the
  handbrake, is a game-design change I won't make as part of a merge.)
* **`fromRoad` in `lib.mjs`** uses `road.nearest`, which is null down a
  spur.  After `start=road` the autopilot shouldn't be on one, but if
  autoplay's "off into a field" scenario lands near a mouth it could read
  as off-road.  Use `__game.arc` / `junctions.onSpur` if it fires.

Also:

* **A portal walk-through by hand** (`?warp` path): on desktop (FXAA
  route) and in `dpr.mjs`'s phone emulation (up route).  This is the §4c
  risk.  A screenshot mid-warp on each goes in `capture/` (gitignored).
* **`?debug=1`** on a spur: no `no-collider` counts from `colliderUnder`
  while parked at home.  Our spur ground is the same chunks, so it
  shouldn't have any.
* The `tools/probe/*.mjs` files our code comments cite (`portal`, `park`,
  `sign`, `boot`, `rest`, `clouds`) **aren't in the repo** on either
  side, so they can't be run.  I'll say so in `next_5` rather than
  pretend they passed.

---

## 6. Order of work

1. `git merge --no-commit --no-ff upstream/main`.
2. `.gitignore`, `ai/` moves, `index.html` link (§2).
3. `terrain.js` (§4a) → `chunks.js` (§4b) → `post.js` (§4c) → `main.js`
   (§3).  In that order, because chunks depends on `lastRoad` and main.js
   depends on the rest building.
4. `npm install`, `npm run build`.
5. §5 harnesses; fix; repeat.
6. `README.md` read-through; add the `start=road` note next to `?auto`.
7. Write `ai/next_5.md`: what merged, what was decided, what was measured,
   what couldn't be run.
8. Leave the merge **staged, uncommitted**, for you.

## 7. Decisions I need from you (defaults in bold)

1. Merge vs. rebase: **merge** (§1).
2. Upstream's `ai/*_4.md`: **move to `ai/upstream/`** (§2).
3. Fork link: **`doublependu/billboard`** (§2).
4. Ground-net rescue ends the run: **leave as is for this merge, note in
   `next_5`**, unless you say to add the grace (§3).
