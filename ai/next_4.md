# next_4 — what landed in `1a8915f` "add billboards"

There is no prompt and plan pair for this one.  `1a8915f` is a single
squashed commit dropped onto `0f1e007` ("itr 3"), and what it contains is a
whole feature — **billboards, the turnings after them, and the portals at
the end of those** — plus a `README.md` the repository did not have before.
51 files, +4753 / −49.

This file is a summary of the commit as it stands, not a report of work I
did.  Everything under "Measured here" I ran; everything else is what the
code and its comments say.

---

## 1  What the feature is

A sign every **1500–3000 ft** (`SPACING_MIN` 457.2 m, `SPACING_MAX` 914.4 m,
mouth to mouth), standing `SIGN_LEAD` = 120 m — six seconds at cruise —
before a **side road**, with a **portal** at the far end of that side road.
Drive through the portal and the tab navigates to the billboard's link under
a 1.9-second warp.  Across the main road from every turning is a
`BILLBOARDS →` fingerpost.

The content is a plain list in `src/road/billboards.js`: `id`, `name`,
`image` under `public/billboards/`, `link`.  Order is position.  Three
entries ship (Man & Bot, Central Park Paintball, Maize Maze), all
3840 × 1080 as the file asks for.

And a drive now **starts out of a gate**: parked on a side road of its own,
handbrake on, facing the mouth, world resolving out of a white-out, with a
back-gate behind the car.  Press the browser's back button after following a
billboard and you come back through the same gate with no load-screen menu,
because the back button already answered *continue or new drive*.

## 2  New files

| file | lines | what |
|---|---|---|
| `src/road/junctions.js` | 1912 | siting, spur geometry, the spur height stage, and every query the rest of the world asks about a turning |
| `src/road/signs.js` | 547 | the billboard: two posts and one composited face |
| `src/road/portal.js` | 283 | the gate — ring, shader membrane, glow card, no collider |
| `src/core/warp.js` | 291 | *when* a crossing happens, and the `sessionStorage` flag that survives it |
| `src/core/depart.js` | 242 | the card that names where you are going, and `location.assign` |
| `src/road/billboards.js` | 50 | the list, and nothing else |
| `README.md` | 118 | the first one this repo has had |

Plus `public/billboards/*.jpg` (three), and `ai/perf-bench/` moved to
`perf-bench/` at the top level with `ai/capture/` deleted and `capture/`
gitignored.

## 3  The two decisions that carry it

Both are about keeping a second road from pulling the first one apart, and
both are in `junctions.js`'s header.

**A spur is not a third `Midline`.**  `RoadPath.nearest` returns `o.s`, and
that arc coordinate is the road's *address* — `main.js` hands it to
`road.protect`, `road.extend`, `furniture.update`, the chunk field's forward
bias and the save cookie.  A third line in that answer means `nearest` can
hand back a position on a seventy-metre stub and all five believe it: the
car protected at the wrong node, the road extended from the wrong end, a
cookie that resumes eighty metres into a field.  So spurs live in
`junctions.js` with their own index — a bounding box per junction, then a
linear walk of seven segments inside one — and **`spline.js` is untouched**.
For almost every terrain vertex the answer is four float comparisons and a
null.

**A spur is benched into ground the main road has already made.**  Ask both
roads and take the nearer and you have built a medial axis: `nearest`
answers for one branch on one side and the other on the other, the two road
heights differ, the ground steps, and the ink pass — a second difference of
depth — draws the step as a line across a field.  `Terrain.heightAt` is
therefore strictly ordered: the main road benches the bare landform into
`y1`, then `junctions.height` benches `y1`.  Continuous with no blending at
all, because `y1` is already continuous and the batter formula is continuous
in its input.

The mouth agrees with the carriageway **by identity**: `terrain.js` now
exports its platform surface sideways as `deck` (`DECK_REACH` 30 m,
`DECK_FADE` 8 m), and the bellmouth's target height is blended onto it with
a weight that reaches exactly zero at the centreline.  At the junction the
pad is not near the carriageway plane, it *is* the carriageway plane.

## 4  The paint, which is where the subtlety went

`Terrain.roadUV` is now `Terrain.roadPaint(x, z, o)` and returns five
things instead of two: `u`, `s` (the **main road's** frame, everywhere),
`d` (distance to the nearest road *surface*, main or spur — the paving
mask), `k` (what that surface is made of), `j` (signed distance to the
nearest mouth).  `chunks.js` carries the two new ones as `roadJ` and `roadK`
vertex attributes, filled with a sentinel on every build so a recycled chunk
never reads as "inside a junction".

Handing the shader the main road's frame everywhere is what lets **the
centre line run through a junction**: a vertex near a mouth has the same
marking coordinate it would have had with no turning there, so there is no
frame to flip and nothing to suppress.  What `groundmat.js` then does is the
suppression that is real — a T-junction breaks the major road's **edge**
line across the mouth, on the side the minor road joins and only there
(`edgeBand * mouth * sameSide`, three lines).

Two more things in that shader worth knowing:

* **The bellmouth flare is in paint**, not geometry: `au = max(0, vRoadA −
  mouth * 3.4)` pulls the paved distance in across the mouth so the two
  carriageways widen into each other and the gravel shoulder flares round
  the outside.  Without it a junction is two ribbons crossing at a right
  angle with grass in the corners — an elbow, not a turning.
* **Plain tarmac is the marked tile read at two lateral positions**
  (0.5 ± 0.13, averaged) rather than a ninth sampler.  Symmetric about the
  centre so wheel-track wear cancels.  `0.5` itself would have painted a
  solid white slab across every junction mouth in the world.

Three surfaces — sealed, gravel, dirt (`KIND`) — chosen by a hash of the
world seed, with the first `KIND_FADE` = 8 m of every one of them tarmac.
That is what an unsealed access road off a classified road actually looks
like, *and* it keeps `roadK` at exactly zero wherever two road frames meet,
which is what makes the attribute safe to interpolate.  Gravel and dirt are
one new texture (`TEX.track`) under two tints.  `Terrain.surfaceAt` reports
them as loose, so grip changes a few metres after the colour does.

## 5  Three caches that had to learn to forget

The same fault three times: **siting runs ahead of the car, and everything
else builds ahead of the car too**, so a turning is routinely cut into
ground that was already meshed, planted and fenced.  Nothing in this project
ever rebuilt anything.

* `ChunkField.invalidate` — existed; now fed from `junctions.takeNewBoxes()`
  alongside `road.takeDirtyBoxes()` and `takeLaidBoxes()`.
* `Scatter.invalidate` — **new**.  Placement is a pure function of the chunk
  index, so a dropped chunk grows back identical except for what the new
  exclusions remove.  Without it: a conifer in the carriageway and a
  billboard nobody can read.
* `Furniture.invalidateArc` — **new**.  The guardrail opens for a mouth by
  zeroing one entry in the array the runs are grouped from — one line, no
  new bookkeeping, and **the runs are also the collider**, so the gap you
  can see and the gap you can drive through are one object.  The comment
  records exactly one instance of the stale case across four seeds, on
  `alder` — which is what a fault that needs a junction sited inside a
  620 m window looks like.

`SITING_LEAD` is 880 m and `road.protect` is now called with 920 rather than
the default 400, because the sign for a turning has to exist before the
window reaches it.

## 6  The crossing

**A crossing, not a place.**  `junctions.crossedGate(x0, z0, x1, z1)` tests
the segment the car moved along this frame against the disc of the ring, so
it cannot be jumped at speed and a single wide frame cannot disarm it.  A
teleport is explicitly not a crossing: `main.js` rejects any step over 20 m.
`GATE_R` = 3.4 is exported from `junctions.js` and *imported* by
`portal.js`, so the hole you see and the hole that fires are one number.

**`depart.js` used to be the decision and is now the announcement.**  The
old three-second countdown is gone, and so is every cancel that used to
exist — braking, steering out, stopping.  Those turned out to mean that one
frame of driving a little wide disarmed the portal for the rest of the
visit, and the player then drove through a ring that did nothing.  There is
exactly one refusal now and it is during the crossing: `Esc`, or the
`stay here` button that appears on a touch screen — the only control in this
game that comes and goes, placed high and centre where neither driving thumb
is.

`warp.js` owns the ordering: the car is taken out of the player's hands (not
frozen — a car that stops dead reads as hitting something), the frame is
pulled into the gate over 1.9 s, and the save is forced and *then* the
navigation, both under the white-out, at `COMMIT` = 0.95 — so cancel works
for 1.8 of the 1.9 seconds and the arriving page still lands behind a white
frame.  Nothing in the file reads a clock; `t` advances by the frame time it
is handed, so a fixed-dt probe sees the player's animation exactly.

The animation itself is one new pass in `post.js`: sixteen-tap radial smear
from the gate's screen position, chromatic separation growing with radius,
starfield streaks in the same polar frame over the second half, white-out at
the end.  **Off for the whole of every drive except that second and a bit**,
which is the only reason a sixteen-tap blur is affordable.  It runs *after*
the look pass, so it smears line work and all — ink drawn on top of a warp
is a pencil drawing of a blur.

Same tab, `location.assign`, never `window.open`: the trigger fires on a
physics frame rather than inside the keydown that caused it, so a new tab is
a popup with no gesture behind it and every blocker eats it silently.
Same-tab is also the only reason the back button can resume.

The return trip is `sessionStorage` (`br_portal` = `{ seed, id, s }`) — this
tab's history, not the drive, and it must not survive a new tab.  A page
restored from the back/forward cache never reloads at all, so a `pageshow`
handler plays the arrival by hand.

## 7  New query strings

`?signs=off` (turnings and billboards out of the world — how anything that
measures the ground gets a before and after), `?nogo=1` (play the whole
crossing, report the navigation, never leave), `?start=road` (begin on the
main road the way iterations 1–3 did), `?warpin=0` (skip the arrival),
`?bb=N` (N synthetic billboards with no image, capped at 60 — "add a row and
it just works" tested rather than asserted).

## 8  Loading, against the spec

`public/_headers` gets `/billboards/*` at `max-age=3600, must-revalidate`.

**Nothing in the feature is fetched at boot.**  A face is decoded when the
arc window reaches its sign — about 300 m out — and cached by id for the
rest of the visit; the panel shows its caption band immediately and the
picture arrives behind it.  So the three JPEGs are a question about how fast
a sign fills in on approach, not about time to first frame, and the CLAUDE.md
budget is not touched by them.

That said: **`2-central-park-paintball.jpg` is 798 KB.**  The other two are
125 KB and 259 KB for the same 3840 × 1080.  On a phone on mobile data, 798 KB
is several seconds — which is most of the approach — and the panel is
2048 px wide, so the source is being decoded at twice the width it is ever
sampled at.  Re-encoding that one to the ~150 KB the others manage is free
and is item 3 below.

## 9  Measured here

* `npm run build` — **clean**, 61 modules, 284 ms.
* Bundle: `index-DgwsPUEv.js` 269 KB / **96 KB gzip**, `body-Bkoj9XZ0.js`
  3475 KB / **1260 KB gzip**, `index.html` 20 KB / 6 KB gzip.  The big chunk
  is the car model and it is lazy — but the warning rolldown prints is the
  same one `next_3.md` item 5 is about.
* Working tree clean at `1a8915f`; nothing untracked.

**Not measured, by me or visibly by anyone:** frame time, anywhere.  The
commit adds a 1912-line height-field stage that runs for every terrain
vertex, two new vertex attributes, a branch in the ground shader, a
composited 2048 × 816 canvas per sign, a shader membrane per portal, and two
cylinder colliders per sign — and `next_3.md` item 3 ("frame time on a
machine whose timer queries work, and on a phone") was *already* the oldest
debt in the project before any of it landed.  It is now considerably older.

## 10  Next, in the order I would do them

1. **Frame time, on a phone and on a machine whose timer queries work.**
   `next_3.md` item 3, now with a much larger bill attached (§9).  The
   corridor cost of `junctions.height` per terrain vertex is the specific
   number to get: it is on the path of every chunk build.
2. **A probe for the feature itself.**  Nothing in `perf-bench/` knows a
   billboard exists, so there is no way to check the two things most likely
   to break quietly: that siting keeps every mouth inside
   `[SPACING_MIN, SPACING_MAX]` across a run of seeds, and that a gate
   crossing fires at the speed a player actually arrives at one.  Both are
   cheap — `?nogo=1` reports the navigation without leaving the page, and
   `?bb=N` supplies as many turnings as a run needs.
3. **Re-encode `2-central-park-paintball.jpg`** (§8).  Ten minutes, and the
   only thing in this commit that touches the loading spec at all.
4. **The ink on a junction.**  Iteration 3 spent its whole Part A getting
   the verge's slope break under the ink threshold, and this commit adds a
   second road benched into that ground, a bellmouth, and a batter around a
   spur.  `perf-bench/verge.mjs` and `streak.mjs` both still work and
   `?signs=off` exists precisely to A/B them — nobody appears to have.
5. `streak.mjs`'s far bucket (`next_3.md` item 1) and `nearest` on the
   inside of a tight bend (item 2) are both still open and untouched.
6. `clouds.js` behind a dynamic import — still the one first-load win with a
   number on it, and the rolldown warning in §9 is pointing at it.



## from README.md that Claude wrote on billboards

> This is too detailed for README.md so copying it here

## The billboards, and the turnings after them

A sign every 1500 to 3000 feet, on the flattest ground in that range, with a
side road right after it and a portal at the end of that — drive through the
portal and the game hands you over to the link. Across the main road from every
turning stands a `BILLBOARDS →` fingerpost, pointing up the road.

The list lives in `src/road/billboards.js` and is meant to be edited: an id, a
name, an image under `public/billboards/`, and a URL. The image wants to be
about 3840 × 1080 — 32:9, the shape of the panel — and anything else is
letterboxed into it rather than stretched. Order is position: the first entry
is the first sign you meet.

None of it is fetched at boot. A face is decoded when the arc window reaches
its sign, about three hundred metres out, and cached by id for the rest of the
visit — the panel shows its caption band straight away and the picture arrives
behind it. So the size of those files is a question about how fast a billboard
fills in on approach, not about time to first frame.

Two decisions carry the whole feature, and neither is the sign.

**A spur is not a third `Midline`.** `RoadPath` already answers `nearest` for
two lines and the obvious move is a third, but the signed arc coordinate it
returns is the road's *address* — `main.js` hands it to `road.protect`,
`road.extend`, `furniture.update`, the chunk field's forward bias and the save
cookie. A third line in that answer means `nearest` can hand back a position on
a seventy-metre stub and every one of those believes it: the car protected at
the wrong node, the road extended from the wrong end, a cookie that resumes
eighty metres into a field. Spurs live in `src/road/junctions.js` with their own
index, and `spline.js` is untouched.

**A spur is benched into the ground the main road has already made.** Ask both
roads and take the nearer and you have built a medial axis — the locus where
two roads are equidistant, where `nearest` answers for one branch on one side
and the other on the other, the road heights differ, the ground steps, and the
ink pass draws the step as a line across a field. `Terrain.heightAt` is
therefore strictly ordered: the main road benches the bare landform into `y1`;
the spur benches `y1`. Which is what a side road actually is, and it is
continuous with no blending at all.

The mouth agrees with the carriageway by identity rather than by tuning: over
the first sixteen metres the bellmouth's target height is blended onto the main
road's own platform surface with a weight that reaches exactly zero at the
centreline, so at the junction the pad is not near the carriageway plane, it
**is** the carriageway plane.

Three things had to get out of the way. The guardrail opens for a mouth by
zeroing one entry in the array `furniture.js` already groups into runs — and
those runs are also the collider, so the gap you can see and the gap you can
drive through are one object. Trees keep out of the corridor and out of a
sightline box running back up the road from each sign. And a turning has to
*invalidate* what was built before it existed: the chunk field, the scatter and
the furniture all build ahead of the car, and siting runs ahead of that, so all
three have an `invalidate`.

There are three surfaces — sealed, gravel, dirt — chosen by a hash of the world
seed, and the first few metres of every one of them is tarmac, because that is
what an unsealed access road off a classified road actually looks like *and*
because it puts the surface change clear of the mouth, where two road frames
meet. `Terrain.surfaceAt` reports the unsealed ones as loose, so the grip
changes a few metres after the colour does.

### The centre line, and the gate

The marking frame is the **main road's, everywhere** — nothing near a mouth has
a coordinate that differs from the one it would have had with no turning there,
so the centre line runs through a junction because the frame never flips rather
than because the line is painted back on. What is left is the suppression that
is real: a T-junction runs the major road's centre line straight through and
breaks its **edge** line across the mouth, on the side the minor road joins.

At the far end of every side road is a **portal**. Driving through it takes you
to the link, under two seconds of radial smear, chromatic fringing and
starfield streaks that start on the frame you cross the ring.

The trigger is a **crossing, not a place**: the segment the car moved along
this frame against the disc of the ring. A crossing cannot be jumped over at
speed, because it is a segment rather than a sample, and a single wide frame
cannot disarm it.

**One thing cancels, and it is `Esc`** (or the button that appears on a touch
screen, which is the only control in this game that comes and goes). Braking,
steering, stopping, turning round — all of that is just driving, and driving a
car at a portal is how you go through one. If the navigation is refused —
`Esc`, `?nogo=1`, or a back-gate with no history behind it — the crossing
unwinds and the world comes back out of the light.

### Where a drive starts, and where it comes back to

Out of a gate. A fresh drive opens on the parked car with the world resolving
out of a white-out, on a side road of its own, handbrake on, facing the mouth,
with a gate behind the car that goes back to whatever page you came from. The
fingerpost across the main road is straight ahead through the windscreen.

Follow a billboard and press the browser's back button, and you come back the
same way — out of the gate you drove into, parked on that side road, facing the
main road — with no load-screen menu in between, because the back button has
already answered *continue or new drive*. The tab remembers which gate in
`sessionStorage`; the world is a pure function of the seed, so the side road is
where it was. Two details make that true. The home turning is sited on every
boot, not just on a fresh one, because the first billboard's window is measured
from it. And a page served from the back/forward cache never reloads at all —
it comes back holding the white-out it left on — so a `pageshow` handler plays
the same arrival by hand.

---



