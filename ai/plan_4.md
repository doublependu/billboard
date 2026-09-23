# plan_4 — a game with a score, and a list that never runs out

Answers `ai/prompt_4.md`.  Four items, in two parts that barely touch:

* **Part A**, items 1 and 2: the drive gets a rule you can lose by, and the
  distance on the HUD becomes how long you have kept to it.
* **Part B**, items 3 and 4: seven more billboards, and the list loops.

Part A is mostly new code in one small new file.  Part B *looks* like a
data edit plus a modulo, and it is not: four things in the current code
quietly depend on every billboard appearing **once**, and one of them turns
a resume into a boot cost that grows with how far you have driven.  Most of
this plan is about those.

---

# Part A — the rule, and the distance

## 1. The rule, as I read it

The prompt names three ways to lose a run:

1. **Stopping**, meaning speed below 10 mph (4.4704 m/s).
2. **Leaving through a portal.**
3. **Coming back from a portal**, which resets the distance.

And one way to keep one: autodrive is allowed.  That is the point of the
game, since autodrive will drive forever and the only thing that ends the
run is the player turning off.

Everything else follows from **one rule, applied every physics frame**:

```
v = |car.speed|
if v >= V_MIN:       drive += v * dt
else if drive > 0:   end('stopped')
```

That is the whole state machine, and it handles the edge cases without
any special code:

| situation | what happens | why it is right |
|---|---|---|
| fresh drive, parked, handbrake on | `drive` stays 0; the counter starts once you pass 10 mph | a run starts when you are moving |
| slowing through 10 mph | the run ends, `drive = 0` | the prompt's rule |
| `T` rescue, auto-rescue after rolling | `placeOn` zeroes the speed, so the run ends | you stopped |
| `Z` rest | `rest()` calls `car.halt()`, so the run ends | resting is stopping |
| pause menu, hidden tab | no frame runs, so there is nothing to sample and the run survives | pausing is not stopping |
| reload → *continue* | the car resumes stationary, so `drive` starts at 0 | reloading is leaving |
| *new drive* | same | same |

**Autodrive never trips it by accident.**  The autopilot's corner speed is
`sqrt(A_LAT / k)` with `A_LAT = 4.6`, so getting under 4.47 m/s needs a
radius under 4.3 m, and the tracer never builds one.  The off-road cap is
`12 + …` m/s.  The worst climb `autodrive.js` records is 9.7 m/s.  §4
checks this rather than trusting it.

**No grace period.**  A real stop is a real stop, and a debounce is a
tuning constant that needs defending.  If the §4 probe finds single-frame
dips on bumps or kerb strikes, add a 0.25 s debounce then, with the
measurement next to it.

**Reversing** at 10 mph or more counts, because `|speed|` is what the
odometer already uses.  Getting to 10 mph backwards and holding it is
harder than driving forwards, so this is not an exploit worth a branch.

## 2. The portal: the run ends at the ring

The gate is where the player gives in, so **`depart.commit(gate)` ends the
run**.  That is the frame the car crosses the ring, before the warp and
before any navigation.  It covers the real crossing, the `?flat` crossing
(no warp, instant `depart.navigate`), `?nogo=1`, and the home back-gate,
because all four pass through that one branch in `main.js` (~line 1662).

**One decision you may want to reverse: `Esc` during the crossing does not
give the distance back.**  My reasoning is that the prompt's loss is
*turning off and going through*, and the crossing has already happened by
the time `Esc` is possible.  If `Esc` restored the run, the dominant
strategy would be "drive through every portal and cancel", which removes
the temptation the game is about.  Reversing this means removing one call:
move `end('portal')` from `commit` to `warp.onArrive`.

**Coming back.**  The page that returns never has a live run: `drive` is
not persisted (see §3), and the car is parked on the spur anyway.
`main.js:2031`, `odometer = resumable ? resumable.odometer : 0`, stays as
it is, because that is the *total* odometer (§3).  Writing the lost
distance and the billboard's name into the `sessionStorage` flag costs two
fields, and lets the returning page say what happened:

> distracted by Doodle District — 3.41 miles

That line fits the game better than a silent 0.00, and it is the only
place the player finds out the portal cost them the run.

## 3. Two distances, one of them new

`odometer` today is total distance.  It goes into the save cookie, it is
restored on resume, and it is the `x miles` on the pause and resume
screens.  **It stays as it is.**  The prompt's *drive distance* is a new
quantity, and turning the old one into it would change the save format
and the menu for no gain.

| | `odometer` (exists) | `run.drive` (new) | `run.best` (new) |
|---|---|---|---|
| means | total metres this drive | metres since you last stopped or took a portal | the longest `drive` ever |
| on the HUD | no longer | the big number, bottom left | small, under it |
| persisted | save cookie, as now | **never**: a resumed car is stationary | `localStorage` `br.best` |
| cleared by *new drive* | yes | yes | **no** |

**`best` is not in the prompt.**  I am adding it because *as long as you
can* needs something to beat, and it is about twenty lines.  If you do not
want it, cut §3's last column and the "new best" toast; nothing else
depends on it.  It lives in its own key and not in `br.save`, because
`freshStart` clears `br.save` and a new world should not erase your record.
It is global rather than per seed, so a different landscape is still the
same game.

## 4. Where the code goes

**`src/core/run.js`** is new, about 60 lines, with no three.js and no DOM.
`V_MIN`, `update(speed, dt)` returning `'stopped'` or null, `end(why)`
returning the distance just lost, `drive`, `best`, and `load` and `save`
for the `br.best` key.  It is pure so a probe can drive it with numbers.

**`src/main.js`**, a handful of lines:

* the frame loop: `run.update(car.speed, dt)` beside `odometer += …`
  (line 1681); on `'stopped'` with a lost distance above 0.05 mi, toast
  `stopped — 3.41 miles` or `new best — 3.41 miles`
* the crossing branch: `run.end('portal')` in the `if (gate &&
  depart.commit(gate))` block, and pass `{ lost, name }` to `warp.begin`
  for the flag
* the arrival path (`arrival.gate` block, and the `pageshow` handler):
  the "distracted by" toast
* `hud.update(run.drive, …)` in both places it is called, including the
  lapse early-return at 1420
* `jumpTo` (probe hook): `run.drive = 0`
* `window.__game.run`, so probes can read it

**`src/core/hud.js`**:

* the left corner shows `run.drive` in miles to **two** decimals (16 m
  per tick, so it visibly counts at cruise; one decimal ticks every eight
  seconds, which reads as stalled)
* a `best 3.41` line under it
* the number dims (class `idle`) while you are under 10 mph, so a parked
  car shows *not counting yet* rather than a broken 0.00

Check the touch layout at 360 px wide, since the left corner shares the
bottom edge with the drive thumb.

**`src/core/warp.js`**: the flag gains `n` (§7), `lost` and `name`.
`cameBack` passes them through.

**`index.html`**: one line under `<h1>country road</h1>` on the load
screen stating the goal, e.g. *stay on the road — don't stop, don't turn
off*.  The load screen is the only place a new player can learn there is a
goal at all.

**`README.md`**: a short "the game" section above the key table.

## 5. Verifying Part A

`perf-bench/run.mjs`, a new probe:

1. **No false stops.**  Full autodrive, `?nogo=1&start=road`, three seeds
   (`country`, `alder`, and one hilly seed from `verge.mjs`'s list), 20
   game-minutes each at fixed dt.  Assert no `'stopped'`, and report the
   minimum speed seen.  This is the check behind §1's claim that autodrive
   never trips the rule.
2. **A stop ends it.**  Brake to rest.  `drive` goes to 0 on the frame
   speed crosses 4.47, and `best` holds the old value.
3. **A gate ends it.**  `?nogo=1`, drive into the first turning (the probe
   already knows how, through `junctions` and `autodrive`), cross the ring,
   and check `drive === 0` on the commit frame.
4. **Parked start.**  Fresh drive: `drive` is 0 and the HUD has `idle`
   until 10 mph.

---

# Part B — the list, and looping it

## 6. The seven entries

These are appended in the prompt's order, as ids 4 to 10, so the loop
goes Man & Bot → … → Maize Maze → Doodle District → Whiteout → Ink Tide →
Sakura Crossing → Friends → Fork me on GitHub → Cloudflare → Man & Bot → …

| id | name | link | image |
|---|---|---|---|
| 4 | Doodle District | https://doodleshooter.vercel.app/ | `4-doodle-district.jpg` |
| 5 | Whiteout | https://whiteout.plgb.chatgpt.site/ | `5-whiteout.jpg` |
| 6 | Ink Tide | https://wave-racer.vercel.app/ | `6-ink-tide.jpg` |
| 7 | Sakura Crossing | https://sakura.gh.maize.live/ | `7-sakura-crossing.jpg` |
| 8 | Friends | https://bday.maize.live/ | `8-friends.jpg` |
| 9 | Fork me on GitHub | https://github.com/doublependu/billboard | `9-github.jpg` |
| 10 | Cloudflare | https://www.cloudflare.com/ | `10-cloudflare.jpg` |

"GitHub" takes the capital H because that is how the caption band will
spell it.  Say if you want "Github" exactly as written.

### The images: I need a decision from you

**The prompt gives names and links but no pictures**, and every existing
entry has a 3840 × 1080 JPEG.  An entry with no image still works (it gets
the caption band on a black panel plus a console warning, the `?bb=N`
path), but that is a sign nobody would turn off for.

**Default, unless you would rather supply your own:**

* **The five game sites** (Doodle District through Friends): capture them
  with the headless Chrome `perf-bench/cdp.mjs` already drives, at a
  1920 × 540 viewport and DPR 2, which gives 3840 × 1080 directly in the
  panel's own 32:9.  Wait for load plus a few seconds, since most of these
  are canvas games whose first frame is a loading screen.  If a site lays
  out badly that wide and short, capture at 1920 × 1080 and crop the middle
  band.  I will look at every frame before it goes in.
* **GitHub and Cloudflare**: do not screenshot them.  A repository page or
  a marketing homepage with a cookie banner is unreadable at 250 m.  Make a
  simple typographic face instead: the name large, on a flat colour, drawn
  by the same script.  Brand logos only if you want them and supply them.
* **Encoding**: JPEG around q 80, **at most 250 KB each**.  The same pass
  re-encodes `2-central-park-paintball.jpg`, which is 798 KB against
  125–259 KB for the other two (`next_4.md` item 3, ten minutes, and the
  one thing here that touches the loading spec).  Faces are fetched on
  approach and never at boot, so none of this affects time to first frame.

The capture script goes in `perf-bench/faces.mjs` next to `cdp.mjs`, so
the next billboard someone adds is one command rather than an afternoon.

## 7. Looping, and the four things that assumed a list runs out

The loop itself is the change the prompt describes: in
`Junctions.update` and `_commit`, remove the `this.next <
BILLBOARDS.length` guard and take `BILLBOARDS[this.next %
BILLBOARDS.length]`.  With an empty list, keep today's behaviour of siting
nothing.  `this.next` becomes the **ordinal** `n` of the turning, stored on
the junction as `j.n`.

Then the four faults:

### 7a. A billboard's id no longer names one turning

`byId`, `siteUntil(id)`, the warp's return flag `{ seed, id, s }`,
`Portals.live` and `Signs.live` (`'face:' + id`, `'post:' + id`) are all
keyed on `billboard.id`, and with a loop, id 3 is the 3rd, 13th, 23rd …
turning.

* **The back button breaks first.**  `siteUntil(3)` returns the *first*
  junction showing billboard 3, `main.js:1938` sees its `s` does not match
  the flag's, and the return quietly lands on the main road with a
  console warning.  So the return journey fails from the second lap on.
* **Portals and signs** only collide if two turnings with the same
  billboard are both inside the ~900 m arc window.  That never happens
  with 10 entries, but it happens immediately with a one-entry list, where
  one of the two signs is simply never built.

**The fix is to key everything on `j.n`.**  `byId` becomes `byN`,
`siteUntil(n)`, the live maps use `'face:' + j.n`, and the flag carries `n`.
The home gate, currently id 0, becomes `n = -1`.  **Legacy flags** (from a
tab that left before this ships) have only `id`, and for the three
shipped entries id *k* was always ordinal *k − 1*, so `cameBack` maps
`id 0 → home, id k → n = k − 1`.  The `|j.s − s| < 1` guard at
`main.js:1938` stays as the backstop.  The portal tint keeps using
`billboard.id`, so the same site always glows the same colour.

### 7b. The face has the direction baked in, and is cached by id only

`compose(billboard, img, side)` draws `NEXT LEFT` or `NEXT RIGHT` into the
texture, and `faces` is keyed by `billboard.id`.  Once, this was fine.
With a loop, the second time Whiteout stands on the other side of the
road, **its sign points the wrong way**.  Key the cache on `id + ':' +
side`.

### 7c. The face cache is never evicted, and now it would grow

`signs.js:48` says "never evicted", which was safe for three faces.  One
face is 2048 × 816 RGBA plus mipmaps, about **8.9 MB of GPU memory**.  Ten
billboards times two sides is up to **20 faces, about 180 MB**, reached
after a long drive and kept for the whole visit.  An entry-level phone
(CLAUDE.md spec 2.2) will not survive that.

**Make it a small LRU**: at most **4** composed faces.  It never evicts a
face a live sign is using, and dispose the texture when it does evict one.
Signs are at least 457 m apart and a face is built about 300 m out, so at
most two are ever live.  A re-built face costs one image fetch, served by
the HTTP cache under `/billboards/*`'s `max-age=3600`, plus one decode and
one canvas draw, all 300 m before anyone can read it.

### 7d. Resume now walks the whole chain from the start of the road

This is the one that affects the loading spec.  Siting is a **chain**:
each window opens at `prev.s + SPACING_MIN`, so where turning *n* stands
depends on where *n − 1* stood, back to the home turning at the origin.
With three entries, the chain ended after three links.  With a loop it
never ends, and **a resumed drive at s = 100 km has to re-site about 140
turnings** to find the next one.

`update` caps itself at 90 scan steps (900 m of survey) per frame, so this
does not show up as a slow boot.  It shows up as roughly **110 heavy frames
straight after the load screen, with no billboard near the car until they
finish**.  The back-button return is worse, because `siteUntil` runs the
whole chain synchronously *during boot*, before the first ground is
meshed.  That is boot time that grows with the length of the drive, against
a 2–3 s budget.

**Fix: save the chain's anchor.**  The save cookie gets two more fields:
the ordinal and `s` of the **last turning at least 300 m behind the
car**.  300 m is outside every arc window: signs keep 260 m behind,
portals 300 m.  On boot, siting restarts from the anchor, with `target =
anchor.s + SPACING_MIN`, `cursor = target` and `next = anchor.n + 1`,
instead of from home.  The warp flag carries the gate's own predecessor in
the same way, so `siteUntil` on a return builds **one** turning, not a
hundred.

This is exact rather than approximate, and here is why:

* `_survey` is road-blind and junction-blind by design (it reads `bareAt`,
  `coarseAt` and the tracer's own nodes)
* `_build`'s surface and bend hashes are positional (`Math.round(c.s)`)
* after every commit, `cursor === target`: the window width and the
  spacing floor are both 457.2 m, and an overrun commit lands the cursor
  just short of the new target

So restarting at `anchor.s + SPACING_MIN` replays the original windows
exactly.  **Verify that `_build` reads nothing from `this.list`** before
relying on this.  If it does, for example an overlap test against the
previous spur, anchor one turning earlier and re-site the anchor too.

Consequences:

* **Save version 2 → 3.**  A v2 cookie reads with anchor = home, which is
  today's behaviour: correct, just slow for a long drive.
* **Turnings behind the anchor are not rebuilt** after a resume.  You
  would only see this by U-turning and driving more than 300 m back, and
  what you would see is road with no signs on it.  I think that is
  acceptable, but it is a real difference.

### 7e. Two small things that stop being small

* `inRange`, `postsInRange` and `mouthsInRange` each `filter` the whole
  `list` every frame, three allocations over a list that now grows about
  1.4 entries per km.  `list` is pushed in increasing `s`, so use a binary
  search on `s` and a slice.  That is ten lines.
* The comment in `billboards.js` says *until there is no billboard left*,
  and should say it starts again from the top.  The same goes for the
  README's billboard paragraph.

## 8. Verifying Part B

Extend `perf-bench/run.mjs`, or add `perf-bench/loop.mjs`:

1. **The loop.**  `?nogo=1&start=road`, then jump in steps and site 30
   turnings.  Billboard ids come out as `1..10, 1..10, 1..10`, and every
   gap stays inside `[SPACING_MIN, SPACING_MAX]`, with `overruns` reported
   the way `junctions` already records them.
2. **Direction.**  For every live sign, the composed face's side matches
   the junction's `side`.  This is a unit check on the cache key, with no
   pixels needed.
3. **Anchor determinism, which is the check that matters.**  Site 40
   turnings from home.  Then, in a second page, resume with the anchor set
   to turning 25 and site forward.  Every `(n, s, side, kind, len)` from 26
   onward must be **identical**.  If it is not, §7d's argument is wrong
   and the fallback applies.
4. **Return from a deep gate.**  Commit a crossing at turning 23 under
   `?nogo=1`, then reload with the flag in `sessionStorage`.  The car is
   parked on turning 23's spur, and boot time is within 50 ms of a
   gate-0 return.
5. **Memory.**  Drive past 25 turnings and read the face-cache size from
   the probe hook.  It must be 4 or fewer.
6. **A one-entry list** (temporarily trim `BILLBOARDS` in a probe build):
   every turning shows that one billboard, and with two turnings inside
   the window both signs are built.  This is §7a's collision case.
7. **Regressions.**  `npm run build` stays clean, and `?bb=N` still works,
   now looping over 10 + N entries.

---

## 9. Order of work

1. §7a–§7c (keys, face side, LRU).  These are small, and without them the
   loop is wrong.
2. The loop itself, plus §7e.
3. §7d, the anchor, with §8.3 written **first**, since it is the only
   thing that can show the argument is right.
4. `run.js`, the HUD, and the portal hook (§1–§4), then §5.
5. The images (§6), once you have answered the question there.  The seven
   entries can go into `billboards.js` before the images exist, since the
   missing-image path is already safe.
6. README, the `billboards.js` comment, and the load-screen line.

## 10. Out of scope, but worth knowing

**The backward road has no billboards.**  The tracer builds the road in
both directions (`prompt_5.md`), but siting only ever walks the forward
line.  A player who U-turns at the start and drives towards negative `s`
meets no signs at all, which means no temptation and so a trivial
infinite run.  Siting the backward half means mirroring the chain for
negative `s`, a second cursor and target, and signs facing the other way.
That is a real piece of work, and it should be its own prompt if it
matters to you.

**Frame time is still unmeasured** (`next_4.md` item 1).  This plan adds
nothing per frame beyond a few comparisons.  The LRU and the binary search
make it cheaper than the naive loop would have been.
