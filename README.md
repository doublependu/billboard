# country-road

An endless road through open country, traced through a procedural landscape
and drawn as a cel-shaded picture. Built in Three.js, no engine.


```bash
npm install
npm run dev            # http://127.0.0.1:5178/?seed=country
npm run build && npx vite preview --port 5179


# deploy
npx wrangler login
npm run deploy
```

| key | |
|---|---|
| `W A S D` | drive — and taking the controls switches autodrive off |
| `SPACE` | handbrake |
| `T` | back onto the road, if you have ended up somewhere you cannot leave |
| `F` | autodrive — manual, full, auto steering, auto speed |
| `[` `]` | wind the clock — a tap is half a game-hour, holding keeps going |
| `Z` | rest until morning, or until the rain or snow is over |
| `C` | camera — chase, chase far, bonnet; the wheel moves the eye |
| `ESC` | quit to the load screen: continue, or a new drive |
| `M` | sound on or off — remembered between visits |
| `H` | hide the HUD |
| `O` / `G` | toggle the ink pass / the colour grade |
| `R` | a new seed |
| `N` | on the load screen, with a saved drive: start a fresh one |

Everything in that table is on the phone's `☰` panel too, except `O`, `G`
and `R` — the two render toggles and the reseed, all three of which the load
screen or a query string already reaches.

Mouse: drag to look around, scroll to change the camera distance.

## On a phone

Open it on a phone and the controls change to fit: a thumb pad on the left
that steers by how far you sweep it, a throttle and a brake on the right
(hold the brake at a standstill to reverse), and a strip of buttons in the
top corner — `AUTO`, `CAM`, and `☰` for the other eight commands. Drag
anywhere on the road to look around and pinch to change the camera distance;
the wheel and every key still work if there is one attached.

One control comes and goes: **`stay here`**, high and centre where neither
driving thumb is, for the two seconds a portal crossing lasts. It is the touch
screen's `Esc`, and it is the only way to refuse a gate.

The controls appear when the browser says the pointer is coarse, and on the
first touch regardless. `?touch=1` puts them on a desktop, which is how they
get tested; `?touch=0` takes them away.

`?quality=low` — the default on a touch device — halves the shadow map,
marches the cloud layer at 0.4 of the frame rather than 0.5, and drops the
scene's supersample from 1.75× to 1.25×. `?quality=high` is the desktop
picture, on any device.

`?seed=` takes a word or a number. `?flat` puts the pre-cel renderer back —
standard materials, no post. It only works on the dev server (`npm run dev`);
the production build always draws cel.
`?rec=1` hands the frame loop to a script and skips the load screen.
`?lod=1` pins the ground in the road corridor to 1 m vertex spacing however
far it is from the car — a diagnostic for the ink on the verge, and an
expensive one: it is the case `FAR_LOD` exists to prevent.
`?car=coupe` keeps the code-built stand-in instead of the modelled car.

`?t=18:20`, `?season=autumn`, `?weather=heavyRain` and `?day=7` pin the sky, and
they are useful for screenshots — with a 24-minute day and hourly weather, a
still shot at whatever the seed happened to be doing is not comparable with
anything, including itself an hour later. `?clouds=off` puts the bare gradient
dome back and `?clouds=full` marches the layer at full resolution. `?sky=only`
hides the world so the frame is dome plus cloud layer and nothing else.
`?fresh` ignores the saved drive.

`?signs=off` takes the billboards and their turnings out of the world, which is
how anything that measures the ground gets a before and an after. `?nogo=1`
plays the whole crossing and reports what it *would* have navigated to, so a
gate can be watched firing without the page leaving underneath it. `?start=road`
begins on the main road the way earlier iterations did, `?warpin=0` skips the
arrival, and `?bb=N` adds N synthetic billboards with no image — which is how
"add more entries to the list and it just works" gets tested rather than
asserted.

Every drive starts on a **spring morning** — day 1 of the twelve-day year, at
08:00. The landscape, the weather and the moon are still seeded; only the
calendar is fixed, so a first thirty seconds is the same first thirty seconds.

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


