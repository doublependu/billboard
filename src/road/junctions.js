import { STEP, MAX_GRADE, EARTHWORK_MAX, CURVE_NODES } from './trace.js';
import { WATER_LEVEL, CARRIAGEWAY, SHOULDER, crown } from '../world/terrain.js';
import { hash3, hashFloat } from '../core/rng.js';
import { BILLBOARDS } from './billboards.js';

/* ------------------------------------------------------------------ *
 * The turnings, and where they are allowed to be.
 *
 * `prompt_17.md` asks for a side road after every billboard, and this
 * repository has spent seventeen iterations writing everything -- the
 * height field, the paint, the physics, the guardrail -- in terms of
 * *the* road, singular.  So the interesting half of this file is not the
 * spur geometry.  It is the two decisions that keep a second road from
 * pulling the first one apart.
 *
 * **1.  A spur is not a third `Midline`.**
 *
 * `RoadPath` already answers `nearest` for two lines and the obvious move
 * is a third.  It is the wrong move twice over.  The tag encoding in
 * `spline.js` is `i * 2 + id` with `tag & 1` un-picking it in three
 * places including the revert sweep, and widening that means opening the
 * one file with the most hard-won invariants in it for a feature that
 * touches none of them.
 *
 * Worse is `o.s`.  The signed arc coordinate is the road's *address*:
 * `main.js` takes the car's `s` from `nearest` and hands it to
 * `road.protect`, `road.extend`, `furniture.update`, the chunk field's
 * forward bias and the save cookie.  A third line in that answer means
 * `nearest` can hand back an arc position on a seventy-metre stub, and
 * every one of those consumers would believe it -- the car protected at
 * the wrong node, the road extended from the wrong end, and a cookie that
 * resumes a drive eighty metres into a field.
 *
 * So spurs live here, with their own index, and `RoadPath` is untouched.
 * There are never more than a handful alive, so the index is a bounding
 * box per junction and a linear walk of seven segments inside one.  For
 * the overwhelming majority of terrain vertices the answer is four float
 * comparisons and a null.
 *
 * **2.  A spur is benched into the ground the main road has already
 * made**, not blended with it.
 *
 * The naive combination -- ask both roads, take the nearer -- reproduces
 * `next_16.md` §1 exactly.  Two roads equidistant from a point is a
 * *medial axis*; `nearest` answers for one branch on one side of it and
 * the other on the other; the two road heights differ; and the ink pass
 * in `core/post.js`, which is a second difference of depth, draws the
 * step as a line across a field.  That fault is already open in this
 * repository and this change would have multiplied it by the number of
 * billboards.
 *
 * `Terrain.heightAt` is therefore strictly ordered: the main road benches
 * the bare landform into `y1`, and the spur benches `y1`.  Which is what
 * actually happens on a hillside -- the side road is built into the
 * finished ground, later -- and it is continuous with no blending, no
 * runner-up and no medial axis, because `y1` is already continuous and
 * the batter formula is continuous in its input.
 *
 * The two stages agree across the mouth by *identity* rather than by
 * tuning: see `MOUTH` below.
 * ------------------------------------------------------------------ */

/**
 * How far apart billboards are: at least 1500 ft and at most 3000 ft,
 * measured mouth to mouth -- which is also sign to sign, since every sign
 * stands the same `SIGN_LEAD` before its turning.
 *
 * `prompt_19.md` item 1, and the correction to the first plan for it: the
 * two numbers are not a spacing and a tolerance, they are **the range the
 * best spot is looked for in**.  So there is no third constant for the
 * width of the search -- it was `SCAN_WINDOW = 250` beside a 1000 ft
 * `SPACING`, and two numbers describing one window is how a window ends
 * up somewhere neither of them meant.  The window *is* `[MIN, MAX]`.
 *
 * The floor is hard by construction: nothing before `prev + MIN` is ever
 * surveyed.  The ceiling is what `update` and `_commit` spend most of
 * their length defending -- see the three tiers there.
 */
export const SPACING_MIN = 457.2;
export const SPACING_MAX = 914.4;

/**
 * How far before the turning the sign stands.
 *
 * Six seconds at cruise.  Long enough to read a name and decide, short
 * enough that `NEXT LEFT` is not a lie -- and comfortably inside the
 * distance the face is legible from, which is about 250 m.
 */
export const SIGN_LEAD = 120;

/**
 * The ordinal the home turning carries.  Every other turning is numbered
 * from 0 in the order it was sited, and that number -- not the billboard's
 * id -- is what names one turning, because since `prompt_4.md` item 4 the
 * list loops and billboard 3 is the 3rd, 13th and 23rd turning at once.
 */
export const HOME_N = -1;

/**
 * How far behind the car the chain of turnings may be picked up again
 * after a reload.  See `anchorBefore`.
 *
 * Past `VIEW` in `main.js` (1400 m), so every turning the player could
 * have seen from where they were is re-sited in the same place, and far
 * enough inside the drive that the few it costs to walk forward from
 * there are nothing -- two or three turnings, not the hundred and forty a
 * hundred-kilometre drive has left behind it.
 */
const ANCHOR_BACK = 1500;

/**
 * How long a spur is, and why it is a range rather than a number.
 *
 * `prompt_18.md` item 5 asks for side roads of different lengths, and the
 * cheap way to do that is a random number per junction.  The better way
 * costs nothing extra: `_corridor` already walks the ground the spur
 * would be built on, so let it walk to `SPUR_MAX` and report **how far
 * the flat part actually goes**.  A site with ninety metres of good
 * ground gets a long road and a site with fifty gets a short one, and
 * both of them are flat -- which is item 1 of the same prompt.  Length
 * stops being a taste and becomes a measurement, the same move
 * `plan_17.md` made for spacing.
 *
 * **`SPUR_MAX` is 92 and that is a constraint, not a preference.**
 * `chunks.js` picks vertex spacing from distance to the midline and its
 * finest band reaches 95 m (`LOD[0].within`), so a spur inside that is
 * meshed at 1 m end to end with no LOD work at all.  Going further means
 * teaching `_lodFor` about junctions -- which is possible, but it has to
 * stay a pure function of position for the neighbour stitching to work,
 * so a newly sited turning would have to invalidate its ground box padded
 * by a whole chunk or the seam it was stitched to moves and opens a
 * crack.  Not worth it to make a side road ten metres longer.
 */
const SPUR_MIN = 45;
const SPUR_MAX = 92;

/**
 * Node spacing along a spur.  Half the tracer's, and for two reasons that
 * only turned up once there was a reason to drive to the end of one.
 *
 * The height field reads spur nodes as a *polyline* (`at`, below), so the
 * spacing is how closely the built ground follows the curve; and the
 * heading profile in `_spur` is integrated node by node, so it is also
 * the resolution of the curve itself.  At the tracer's ten metres a
 * 25-degree bend is a 25-degree corner.  See `_spur`.
 */
const SPUR_STEP = 5;

/**
 * The surface a side road is made of.  `prompt_18.md` item 5.
 *
 * Index rather than name, because it travels to the ground shader as an
 * interpolated vertex attribute (`roadK` in `chunks.js`) and a float is
 * what a varying is.  0 is reserved for the main road and for the sealed
 * apron every turning starts with, so the attribute is zero wherever two
 * road frames meet -- which is the whole reason the transition is free of
 * the interpolation fault `plan_18.md` §3 exists to fix.
 */
export const KIND = { sealed: 1, gravel: 2, dirt: 3 };
const KIND_LIST = [KIND.sealed, KIND.gravel, KIND.dirt];

/**
 * How far the sealed apron runs before the surface changes, past the
 * bellmouth.
 *
 * Not decoration: an unsealed access road off a classified road really is
 * tarmac for its first few metres, because that is where the traffic
 * turns and loose material would be dragged onto the main carriageway.
 * It also puts the surface change well clear of the mouth.
 */
const KIND_FADE = 8;

/** How far short of the far end the portal stands. */
const PORTAL_SETBACK = 6;

/**
 * Clear radius of the gate, and therefore of the thing you drive through.
 *
 * Exported because `road/portal.js` builds its ring to this and
 * `crossedGate` tests against it: the hole you can see and the hole that
 * fires the link have to be one number, or the player is right and the
 * game is wrong.
 */
export const GATE_R = 3.4;

/**
 * The tightest a side road may curve, in metres of radius.
 *
 * Forty-five, which at `SPUR_STEP` is a six-degree turn from one chord to
 * the next and about seven centimetres of sag between the chord and the
 * curve -- a fifteenth of the metre the ground beside it is meshed at.
 * See `_spur`, where it becomes a clamp on the bend.
 */
const MIN_RADIUS = 45;

/**
 * Where the drive starts looking for somewhere to start.
 *
 * Far enough out that the road has settled into the landscape and the
 * first sign is still ahead; near enough that the loader is not tracing
 * for a second before anybody sees anything.
 */
const HOME_FROM = 70;
const HOME_TO = 200;

/**
 * Half-width of the spur's built platform.
 *
 * The same as the main road's base platform (`terrain.js:platform`), so
 * the two carriageways are the same width and the shader -- which paints
 * from a distance and knows nothing about which road it is looking at --
 * needs no notion of a minor road at all.
 */
const SPUR_HALF = CARRIAGEWAY + SHOULDER + 0.9;

/**
 * The bellmouth: the flare at the mouth, and the reason the junction has
 * no step in it.
 *
 * Two jobs in one number.  The platform flares from `SPUR_HALF` out to
 * `MOUTH` over the first `MOUTH` metres of spur, which is the apron a
 * real T-junction has and what lets a car take the turning at 25 km/h.
 * And over the same distance the pad's surface height is blended onto
 * `deck` -- the main road's own platform surface, extended sideways --
 * with a weight that reaches **exactly zero at the centreline**.  So at
 * the mouth the junction's answer is not merely close to the main road's,
 * it *is* the main road's, and the continuity is by construction rather
 * than by choosing a good number.
 */
const MOUTH = 16;

/** Where the sign stands, laterally.  Clear of platform, shoulder, verge. */
const SIGN_OFFSET = 14;

/**
 * Where the fingerpost across the road from each mouth stands, laterally.
 *
 * Three metres past the guardrail line (`OFFSET` in `furniture.js`,
 * `CARRIAGEWAY + 0.55`), so a rail on that side passes in front of it.
 */
export const POST_FAR = CARRIAGEWAY + 0.55 + 3;

/** Batters for the spur's own earthwork.  The main road's numbers. */
const CUT_BATTER = 1.5;
const FILL_BATTER = 2.0;

/**
 * How far out the spur's earthwork is still asked about, and over how
 * many metres it is eased to nothing before that.
 *
 * The same argument as `EARTH_FADE` in `world/terrain.js`, for the same
 * reason: whatever is still happening at the edge of a query radius
 * becomes a step in the height field, and a step is what the ink pass
 * draws.  Anything that changes when the spur stops being visible from a
 * point has to be zero by the time it gets there.
 */
const SPUR_QUERY = 34;
const SPUR_FADE = 12;

/* There is no minimum-gap constant, and there was one.
 *
 * It was 500 m, on the grounds that two signs in one field read as a
 * strip mall -- which is a defensible piece of taste and was, here,
 * simply wrong: `prompt_17.md` asks for a billboard *every 1000 feet*,
 * and 500 m is 1640.  It bound instead of the spacing, and quietly made
 * the spacing 64 % larger than the brief asked for.  The scan never looks
 * before `prev + SPACING_MIN`, so a second rule about spacing could only
 * ever disagree with the first. */

/* --- the siting tests -------------------------------------------------
 *
 * **Every threshold below was measured, and every one of them was wrong
 * on the first guess.**  They were written from an idea of what flat
 * ground is, and this is British upland: over 5 km on four seeds the road
 * runs a median 3.0 m from the bare landform, through a median curve of
 * 110 m radius, with a median cross-fall of 0.32 down its own verge.  The
 * first set of numbers -- 1.5 m of earthwork, a 220 m radius, a 0.08
 * cross-fall -- sat at or below the *first percentile* of two of those
 * three, and the result was a road with no billboards on it at all.
 *
 * So each one sits near the median of its own distribution, which lets a
 * site through about one position in twenty and puts a turning within a
 * couple of hundred metres of wherever it is asked for.  `tools/probe/
 * sign.mjs` re-measures the spacing that comes out of them.
 */

/**
 * The one that matters, and it is not the flattest-sounding.
 *
 * How steeply the spur would have to run to get from the carriageway down
 * (or up) to the natural landform at its far end.  This is the question
 * *subject to the flatness of the terrain* actually asks -- can a side
 * road be built here at all -- and it subsumes the earthwork test, since
 * a carriageway on a high embankment is a long way above the ground its
 * spur has to reach.  Under `MAX_GRADE`, so the spur's own limiter has
 * headroom and the last node is not still descending.
 *
 * Measured quartiles across four seeds: 0.05 / 0.11 / 0.19.
 *
 * **Two numbers, and the difference between them is a correction.**  The
 * first version made this a hard gate at 0.10 on the grounds that it was
 * physical -- above it there is no spur to build.  That is not true, and
 * believing it put the first billboard on `billboard` two kilometres from
 * the start.  A spur does not have to *reach* natural ground: it is
 * seventy metres long, the link fires twenty-two metres down it, and a
 * far end still standing a metre or two above the land is a road going
 * over a rise, which is what roads do.  What is genuinely physical is
 * `_spur`'s own grade clamp and `EARTHWORK_MAX` ceiling, and those were
 * doing the job already.
 *
 * So the gate is loose and the *score* is where flatness is actually
 * wanted -- which is the right division everywhere in this block: a gate
 * says what is impossible, the score says what is good.
 */
const SITE_REACH = 0.10;          // the scale flatness is judged on
const SITE_REACH_MAX = 0.22;      // ...and the point past which it is a ramp

/**
 * Steepest cross-fall along the corridor, per metre, off `coarseAt`.
 *
 * Not a flatness test so much as a cliff test: the spur's own grade
 * limiter and earthwork ceiling decide whether it can be built, and this
 * decides whether what it would be built across is ground or a drop.
 * Quartiles: 0.20 / 0.32 / 0.45.
 */
const SITE_CROSSFALL = 0.42;

/** Tightest curve, as 1/radius.  Quartiles, as radius: 183 / 110 / 60 m.
 *  A gate rather than a preference: the score below prefers the straight,
 *  and this only rules out taking a turning off a hairpin. */
const SITE_CURVATURE = 1 / 70;

/** Steepest the main road may be running through the mouth. */
const SITE_GRADE = 0.10;

/**
 * Why the scan gathers a whole window and does not take the first site
 * that passes.
 *
 * The gates above say where a turning *can* go; the flattest place in
 * the window is how the prompt's *subject to the flatness of the terrain*
 * is actually honoured, and the difference between the two is the whole
 * of why this file has a scoring function in it.
 *
 * Gates alone put the first billboard on `billboard` at s = 2165 and
 * spaced the rest a median 1.4 km apart -- because on this terrain a
 * threshold tight enough to mean "flat" passes about one position in
 * forty.  So the rule is *the flattest place between 1500 and 3000 feet*:
 * gather every position in the window that could take a turning, score
 * them, and commit the best.
 *
 * The window is 457 m wide, and the commit happens at the end of it --
 * which is why `main.js` sites 880 m ahead of the car rather than the 660
 * a 250 m window needed.  The arithmetic is at `junctions.update` there.
 */
const SCAN_WINDOW = SPACING_MAX - SPACING_MIN;

/**
 * What "flattest" means, as one number, lower being better.
 *
 * Each term is the measured quantity over roughly its own gate, so no
 * term can dominate merely by being measured in smaller units, and the
 * weights say which of them a driver would actually notice: the reach
 * decides whether the spur is a ramp, and the curve decides whether the
 * sign is facing you.
 *
 * **And then the same thing again, relative to the window.**
 * `prompt_18.md` item 1 asks for *relatively* flat areas, and the terms
 * above cannot express that: they are measured against fixed gates, so on
 * gentle ground every candidate scores about the same and the choice
 * between them is arithmetic noise, while on rough ground the winner can
 * still be a slope.  `med` is the median reach and cross-fall of the
 * candidates gathered in this window -- the local idea of ordinary
 * ground -- so the second half of the score says *flatter than what is
 * around here* and the first half says *flat*.  A turning wants both, and
 * neither one alone is what the prompt asked for.
 *
 * `med` is null for the first candidate ranked, which is harmless: every
 * candidate in a window is ranked against the same median or against
 * none.
 */
function score(c, med) {
  const abs = c.reach / SITE_REACH * 1.6
            + c.fall / SITE_CROSSFALL
            + Math.abs(c.k) / SITE_CURVATURE * 1.2
            + Math.abs(c.grade) / SITE_GRADE * 0.8
            + c.earth / SITE_EARTHWORK * 0.6;
  if (!med) return abs;
  /* Floors on the denominators, because a window whose median reach is
   * two millimetres would otherwise make the relative term the only term
   * and rank on rounding error. */
  return abs
       + c.reach / Math.max(0.02, med.reach) * 0.9
       + c.fall / Math.max(0.06, med.fall) * 0.6;
}

/** The median of a list of numbers.  Short lists, so a sort is fine. */
function median(xs) {
  if (!xs.length) return 0;
  const a = xs.slice().sort((p, q) => p - q);
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) * 0.5;
}

/**
 * A sanity bound on how high the bellmouth pad may stand, not a flatness
 * test -- `SITE_REACH` is the flatness test.  The apron extends the
 * carriageway plane sixteen metres sideways, so on an embankment it is a
 * flat top with a fill slope round it, which is what a real junction on
 * an embankment is.  At some depth that stops being true and becomes a
 * mesa; this is where.
 */
const SITE_EARTHWORK = 7;

/** Clearance above the water line across the whole corridor.  No jetties. */
const SITE_FREEBOARD = 3;
/** Lateral gradient past which `furniture.js` wants a guardrail.  Must
 *  match `FALL` there: a mouth with a rail across it is a fence. */
const SITE_FALL = 0.85;

/** How far apart the positions a window surveys are. */
const SCAN_STEP = STEP;

/**
 * The shortest a side road may be, and only as the last resort before a
 * gap goes past `SPACING_MAX`.  See the third tier in `_commit`.
 *
 * Thirty-five and not less: the bellmouth takes sixteen, the portal stands
 * `PORTAL_SETBACK` short of the end, and what is left between the two has
 * to be enough road to read as a road rather than a gate in a lay-by.
 */
const SPUR_SHORT = 35;

/**
 * How much further than the nearest a segment may be and still have a say
 * in the answer.  See the second pass of `Junction.at`.
 *
 * A metre.  It has to be wide enough that the blend it produces is gentle
 * -- the arc positions in play differ by a couple of metres where this
 * bites, and squeezing that transition into a few centimetres would trade
 * a step for a crease -- and narrow enough that a vertex with an
 * unambiguous nearest segment, which is very nearly all of them, gets
 * exactly that segment's answer and skips the arithmetic.
 */
const TIE = 1.0;

/** Cell of the junction index, metres.  Comfortably larger than a
 *  junction's own box, so a box lands in at most four cells. */
const JCELL = 256;

function jkey(cx, cz) {
  return cx * 73856093 ^ cz * 19349663;
}

function smoothstep01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

const _p = {};
const _p2 = {};

/**
 * One turning: a sign, a mouth, and seventy metres of side road.
 *
 * `nodes` are in the shape `Midline` produces -- `x, z, y` with a
 * quadratic control point -- so the same sampling arithmetic works on
 * them.  Their heights are **frozen at siting** and never recomputed,
 * which is not an optimisation: a spur whose elevation is derived per
 * query from the finished ground is a spur that is a term in its own
 * definition.
 */
class Junction {
  constructor(billboard, n, { s, side, nodes, sign, post, x, z, y, kind, len, tier }) {
    this.billboard = billboard;
    /** Which turning this is, counted from 0 in siting order; `HOME_N`
     *  for the home turning.  The billboard names what is *on* the sign;
     *  this names the sign. */
    this.n = n;
    /** Arc position of the mouth on the main line.  Always positive. */
    this.s = s;
    /** +1 or -1 across the main road's tangent: which way the spur goes. */
    this.side = side;
    this.nodes = nodes;
    /** Where the billboard stands, and which way it faces.  Null on the
     *  home turning, which carries no billboard. */
    this.sign = sign;
    /** The fingerpost across the main road from the mouth.  Every
     *  junction has one.  See `_build`. */
    this.post = post;
    /** What the surface is made of, past the apron.  One of `KIND`. */
    this.kind = kind;
    /** How far the spur runs, a whole number of `SPUR_STEP`. */
    this.len = len;
    /** Which tier of candidate it was sited from.  See `_commit`. */
    this.tier = tier;
    /**
     * How far along the gate stands, and therefore what the player is
     * driving at.  Short of the far end, so the ring has road behind it
     * and does not read as a lid on the end of a pipe.
     */
    this.portalA = Math.max(SPUR_STEP, len - PORTAL_SETBACK);
    /**
     * Where the gate stands and which way it faces, frozen at siting.
     *
     * The same rule as everything else built on a spur: a thing is built
     * from the numbers the road under it was built from, never from a
     * fresh query.  `portal.js` puts the ring here and `crossedGate`
     * tests the plane through it.
     */
    this.gate = this.pointAt(this.portalA, {});
    /** The mouth, on the main centreline. */
    this.x = x; this.z = z; this.y = y;

    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.z < minZ) minZ = n.z;
      if (n.z > maxZ) maxZ = n.z;
    }
    const m = Math.max(MOUTH, SPUR_HALF + SPUR_QUERY);
    this.box = { minX: minX - m, minZ: minZ - m, maxX: maxX + m, maxZ: maxZ + m };

    /**
     * A second, much wider box: everything this junction changes.
     *
     * `box` is the broad phase for `nearest` and has to stay tight, since
     * it is tested per terrain vertex.  What has to be *rebuilt* when a
     * turning appears is a different and larger region, because the
     * sightline exclusion reaches 220 m back up the main road from the
     * sign -- a wood scattered before the turning existed has a conifer
     * standing in front of the panel, and a box drawn round the spur
     * would never have touched it.
     */
    /* And the fingerpost across the road, which is outside `box` on a
     * short spur and whose clearing a wood scattered earlier would
     * otherwise keep a tree in. */
    const xs = [this.box.minX, this.box.maxX, post.x];
    const zs = [this.box.minZ, this.box.maxZ, post.z];
    if (sign) {
      xs.push(sign.x, sign.x + Math.cos(sign.a) * 220);
      zs.push(sign.z, sign.z + Math.sin(sign.a) * 220);
    }
    this.clearBox = {
      minX: Math.min(...xs) - 20, minZ: Math.min(...zs) - 20,
      maxX: Math.max(...xs) + 20, maxZ: Math.max(...zs) + 20,
    };
  }

  /** Distance from the box, zero inside it.  The broad phase. */
  boxDist(x, z) {
    const b = this.box;
    const dx = Math.max(b.minX - x, 0, x - b.maxX);
    const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
    return Math.hypot(dx, dz);
  }

  /**
   * Where a point sits on this spur: `a` metres along from the mouth, `u`
   * signed metres across, `d` the true distance, `sy` the frozen surface
   * height there.  Null outside the corridor's reach.
   *
   * Seven segments walked linearly.  Against the chords rather than the
   * quadratics, and that is sound here where it was not in `spline.js`:
   * the spur has one 25-degree bend in it against the tracer's 40, and
   * `CHORD_SAG` at this curvature is under four centimetres -- a
   * twenty-fifth of the vertex spacing the ground is meshed at.
   */
  at(x, z, out) {
    const ns = this.nodes;
    const segs = ns.length - 1;

    /* First pass: where the foot of the perpendicular falls on each
     * segment, and how far away it is. */
    let bd2 = Infinity, bi = -1;
    for (let i = 0; i < segs; i++) {
      const n0 = ns[i], n1 = ns[i + 1];
      const ex = n1.x - n0.x, ez = n1.z - n0.z;
      const len2 = ex * ex + ez * ez;
      let t = len2 > 0 ? ((x - n0.x) * ex + (z - n0.z) * ez) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = n0.x + ex * t, pz = n0.z + ez * t;
      const d2 = (x - px) ** 2 + (z - pz) ** 2;
      _st[i] = t;
      _sd[i] = d2;
      if (d2 < bd2) { bd2 = d2; bi = i; }
    }
    if (bi < 0) return null;
    const d = Math.sqrt(bd2);
    if (d > SPUR_HALF + SPUR_QUERY) return null;

    /**
     * Second pass: **every** segment within `TIE` of the nearest, blended
     * by how close it is to being the nearest.
     *
     * A polyline's distance field is continuous everywhere, but *which
     * segment is nearest* is not: on the concave side of any bend there
     * is a medial axis where two feet are equidistant and in different
     * places, so the arc position and the surface height read off "the
     * nearest segment" jump across it while the distance does not.
     * Measured on `billboard`, twelve metres off the inside of a spur:
     * `a` steps by a metre and `sy` with it, which on a road climbing at
     * eight per cent is a **six-centimetre cliff** running out across the
     * field -- and the ink pass in `core/post.js` draws exactly that.  It
     * is `next_16.md` §1 one more time, and it wants the same answer:
     * blend rather than choose.
     *
     * **Two candidates is not enough, and that is worth the paragraph.**
     * The first version of this took the nearest and the runner-up and
     * mixed them by the difference of their distances, which is
     * continuous right up until the *runner-up itself* changes identity
     * -- which happens near a node, where the segment before and the
     * segment after are equally close seconds.  The blended answer then
     * jumps by half the node spacing: measured, a 1.26 m step in `a` and
     * a 32 cm cliff in the ground, which is five times worse than the
     * fault it was introduced to fix.  A weighted sum over everything
     * within the band has no such moment: each weight is continuous in
     * position, no term can appear or vanish except by passing through
     * zero, and the nearest segment always carries weight one.
     *
     * Cost is one extra pass over at most nineteen segments, of which
     * typically one has a non-zero weight and the arithmetic is skipped
     * for the rest.
     */
    let wsum = 0, aw = 0, syw = 0, gfaw = 0, txw = 0, tzw = 0, uw = 0;
    for (let i = 0; i < segs; i++) {
      const di = Math.sqrt(_sd[i]);
      const w = 1 - (di - d) / TIE;
      if (w <= 0) continue;
      const t = _st[i];
      const n0 = ns[i], n1 = ns[i + 1];
      let ex = n1.x - n0.x, ez = n1.z - n0.z;
      const el = Math.hypot(ex, ez) || 1;
      ex /= el; ez /= el;
      const fx = n0.x + (n1.x - n0.x) * t, fz = n0.z + (n1.z - n0.z) * t;
      wsum += w;
      aw += w * (i + t) * SPUR_STEP;
      syw += w * spline4(ns, i, t, 'y');
      gfaw += w * spline4(ns, i, t, 'gfa');
      txw += w * ex; tzw += w * ez;
      uw += w * ((x - fx) * -ez + (z - fz) * ex);
    }

    let tx = txw / wsum, tz = tzw / wsum;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;

    const o = out || {};
    o.d = d;
    o.a = aw / wsum;
    o.u = uw / wsum;
    /**
     * The surface height, and it is a spline rather than a lerp.
     *
     * This was `n0.y + (n1.y - n0.y) * bt` -- piecewise linear, so the
     * built ground had a **slope discontinuity at every node**, which at
     * the tracer's spacing was a ridge across the road every ten metres.
     * Height was continuous and the continuity probe said so; a
     * suspension does not measure height.  That is half of
     * `prompt_18.md` item 2's *the road at intersections is a bit bumpy*,
     * and the reason it was never seen before is that nobody drove more
     * than twenty-two metres of a spur.
     *
     * Catmull-Rom through the four surrounding nodes is C1 by
     * construction, and the ends reflect their neighbour rather than
     * repeating it, so the slope carries through the first and last
     * segments instead of flattening into them.  The nodes themselves are
     * still frozen at siting -- that invariant is about not recursing into
     * `heightAt`, not about how they are read back.
     */
    o.sy = syw / wsum;
    /* `platform()` in `terrain.js` reads these off whatever road answered,
     * so a spur has to carry them.  A spur is level across -- it is only
     * sited where the land is -- so the lateral gradient is zero and only
     * the grade it is climbing widens its platform. */
    o.g = 0;
    o.gfa = gfaw / wsum;
    o.tx = tx; o.tz = tz;
    /* `s` under its road-coordinate name, so a spur answer is a drop-in
     * for a main-road one in `chunks.js`, which writes it as the marking
     * texture's longitudinal coordinate and does not care which road it
     * came from. */
    o.s = o.a;
    /**
     * How far *behind* the mouth, along the spur's own initial heading.
     * Zero in front of it, positive on the far side of the main road.
     *
     * The bellmouth is a sixteen-metre flare and a flare is a disc, so
     * without this it opens on both sides of the carriageway -- and the
     * siting test only ever looked at the land on the side the spur goes.
     * A flat apron sixteen metres out over ground nobody surveyed is a
     * mesa.  `height` gates the flare on this and the far side keeps the
     * bare spur width, where the main road's own platform already covers
     * it and the junction's answer is a no-op.
     */
    const e0 = ns[1];
    let ax = e0.x - ns[0].x, az = e0.z - ns[0].z;
    const al = Math.hypot(ax, az) || 1;
    o.behind = Math.max(0, -((x - ns[0].x) * ax + (z - ns[0].z) * az) / al);
    o.j = this;
    return o;
  }

  /** Half-width of the built pad at `a` metres along: the bellmouth flare. */
  halfWidth(a) {
    if (a >= MOUTH) return SPUR_HALF;
    const t = 1 - a / MOUTH;
    return SPUR_HALF + (MOUTH - SPUR_HALF) * t * t;
  }

  /**
   * Where a point `a` metres down the spur is, and which way the road
   * points there.  The inverse of `at`, for everything that wants to put
   * an object on a side road rather than ask about one: the portal, the
   * parked start, and the probes.
   */
  pointAt(a, out = {}) {
    const ns = this.nodes;
    const f = Math.max(0, Math.min(this.len, a)) / SPUR_STEP;
    let i = Math.min(ns.length - 2, Math.floor(f));
    const t = f - i;
    const n0 = ns[i], n1 = ns[i + 1];
    out.x = n0.x + (n1.x - n0.x) * t;
    out.z = n0.z + (n1.z - n0.z) * t;
    out.y = spline4(ns, i, t, 'y');
    const h = Math.atan2(n1.z - n0.z, n1.x - n0.x);
    out.a = h;
    out.tx = Math.cos(h); out.tz = Math.sin(h);
    return out;
  }
}

/**
 * Catmull-Rom through four consecutive node values, with reflected ends.
 *
 * Uniform rather than centripetal, which is exact here because the nodes
 * are exactly `SPUR_STEP` apart by construction -- `_site` rounds the
 * length to a whole number of them for this reason.
 */
function spline4(ns, i, t, key) {
  const p1 = ns[i][key], p2 = ns[i + 1][key];
  const p0 = i > 0 ? ns[i - 1][key] : 2 * p1 - p2;
  const p3 = i + 2 < ns.length ? ns[i + 2][key] : 2 * p2 - p1;
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1
              + (-p0 + p2) * t
              + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
              + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export class Junctions {
  constructor(terrain, road, opts = {}) {
    this.T = terrain;
    this.road = road;
    /**
     * Every turning, home first, **in increasing `s`** -- siting only ever
     * walks forward and the home turning is sited before the first
     * billboard's window opens.  The arc-window queries below lean on
     * that order to binary-search rather than filter: since the list loops
     * (`prompt_4.md` item 4) this array grows by about one and a half
     * turnings a kilometre for as long as anyone drives.
     */
    this.list = [];
    /** Turnings by ordinal, `Junction.n`. */
    this.byN = new Map();
    /** The anchor `resumeFrom` restarted the chain from, or null. */
    this.base = null;
    /**
     * Junction indices by coarse cell, so `nearest` is not a walk of the
     * whole list.
     *
     * With the one billboard the list ships with, a linear walk is four
     * float comparisons and this is over-engineering.  With the list this
     * file exists to serve -- somebody's twenty billboards -- it is four
     * comparisons *times twenty*, on a function that runs once per
     * terrain vertex, which is 16 641 of them per 128 m chunk.  A
     * junction covers about a hundred metres square and the cell is
     * bigger than that, so a query reads one cell and, nearly everywhere
     * in the world, finds it empty.
     */
    this.grid = new Map();
    /** The ordinal the next turning will get.  Its billboard is
     *  `BILLBOARDS[next % BILLBOARDS.length]`: the list loops. */
    this.next = 0;
    /** How far along the forward line the siting scan has looked. */
    this.cursor = SPACING_MIN;
    /** Where the next turning's window opens.  The scan looks from here
     *  to `SPACING_MAX` past the previous turning and commits the best of
     *  what it finds. */
    this.target = SPACING_MIN;
    /**
     * Gaps that went past `SPACING_MAX`, each `{ from, to, why }`.
     *
     * Not a log for its own sake.  The ceiling is defended by three tiers
     * of candidate, and past the third there is no honest turning to put
     * down -- a lake, a gorge.  What happens then is that the scan walks
     * on and takes the first thing that builds, and this is where that
     * is written down, so `tools/probe/sign.mjs` can count it rather than
     * a player finding it.
     */
    this.overruns = [];
    /** Whether the current window has already had a commit fail in it. */
    this.windowFailed = false;
    /** Every candidate gathered in the current window.  Ranked against
     *  its own median at the end of it -- see `_commit`. */
    this.window = [];
    this.enabled = opts.enabled !== false;
    /** The world seed, so a spur's surface and bend are a pure function
     *  of the world like everything else in it. */
    this.seed = opts.seed || 1;
    /**
     * The turning the drive starts on, or null.  `prompt_18.md` item 6.
     *
     * Not in `list` until `siteHome` runs, and never in `byN` -- it
     * carries no billboard.  Its ordinal is `HOME_N`.
     */
    this.home = null;
    /**
     * What a new turning has changed, consumed once by `main.js`.
     *
     * Two boxes per junction and they are deliberately different sizes.
     * `ground` is where the *height field* moved, which is the spur and
     * its earthwork; `clear` also covers the 220 m sightline back up the
     * road from the sign, where nothing about the ground changed but the
     * trees are no longer allowed to stand.  `s` is the mouth's arc
     * position, for the guardrail, which is indexed by arc rather than by
     * position and wants neither box.  Rebuilding chunks over the
     * whole sightline would be six chunks of mesh thrown away to move a
     * conifer.
     *
     * The twin of `RoadPath.takeLaidBoxes`, and it exists for exactly the
     * same reason.  Siting runs up to 400 m ahead of the car and the chunk
     * field builds ground further out than that, so a junction is
     * routinely created *inside ground that has already been meshed*.
     * Nothing else would ever rebuild it: `_relod` reacts only to a change
     * of resolution, and a chunk beside the road was at 1 m spacing to
     * begin with.  What that looks like is a bellmouth in the collider and
     * a hillside on the screen.
     */
    this.newBoxes = [];
  }

  /** Put a junction in every cell its box touches. */
  _index(j) {
    const b = j.box;
    const x0 = Math.floor(b.minX / JCELL), x1 = Math.floor(b.maxX / JCELL);
    const z0 = Math.floor(b.minZ / JCELL), z1 = Math.floor(b.maxZ / JCELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = jkey(cx, cz);
        let arr = this.grid.get(k);
        if (!arr) { arr = []; this.grid.set(k, arr); }
        arr.push(j);
      }
    }
  }

  /** The junctions whose box could contain this point, or null for none. */
  _cell(x, z) {
    return this.grid.get(jkey(Math.floor(x / JCELL), Math.floor(z / JCELL))) || null;
  }

  /** What the turnings have changed since this was last called. */
  takeNewBoxes() {
    const out = this.newBoxes;
    this.newBoxes = [];
    return out;
  }

  /* ---------------------------- siting ------------------------------ */

  /**
   * Site any billboards whose ground is now available and safe.
   *
   * `limit` is how far along the forward line siting may look, and it is
   * **the tracer's protected window, not its tail**.  `RoadPath.protect`
   * keeps a revert from cutting within 400 m of the car; a junction sited
   * outside that margin can have the road pulled out from under it, and
   * what is left is a sign beside a field and a spur leaving nothing.
   * Inside it, the road under a placed junction cannot move.
   *
   * At cruise that is twenty seconds of warning and about 300 m of
   * visibility, against a face that is legible at 250.  It is the only
   * spacing in this file between "correct" and an afternoon of
   * screenshots.
   */
  update(limit) {
    if (!this.enabled) return;
    let guard = 0;
    /* No end to the list any more: `prompt_4.md` item 4 loops it, so the
     * only thing that stops siting is running out of protected road. */
    if (!BILLBOARDS.length) return;
    while (this.cursor <= limit && guard++ < 90) {
      const s = this.cursor;
      this.cursor += SCAN_STEP;

      /* Gather, while the window is open -- and after it has closed, if
       * it closed with nothing built.  A survey and not a spur: the nodes
       * are built for the winner only, which is what makes keeping the
       * whole window affordable. */
      if (s >= this.target && s - SIGN_LEAD >= STEP * 2) {
        const c = this._survey(s);
        if (c) this.window.push(c);
      }

      /* Commit at the end of the window -- or, once it has run out, the
       * moment anything at all turns up that builds. */
      if (this.window.length && s >= this.target + SCAN_WINDOW - SCAN_STEP) {
        const prev = this.target - SPACING_MIN;
        const j = this._commit();
        /* Every candidate in every tier failed to build.  Keep walking:
         * past the ceiling there is nothing better to do than the first
         * site that works, and dropping the window means the next step's
         * candidate is tried on its own. */
        if (!j) { this.window.length = 0; this.windowFailed = true; continue; }
        if (j.s - prev > SPACING_MAX + 0.5 && prev > 0) {
          this.overruns.push({
            from: Math.round(prev), to: Math.round(j.s),
            why: this.windowFailed ? 'nothing built' : 'no candidate',
          });
        }
        /* The next window is measured from *this* turning, not from where
         * the scan happened to be, so a site the land pushed late does not
         * drag the rest of the list along behind it. */
        this.target = j.s + SPACING_MIN;
        this.cursor = Math.max(this.cursor, this.target);
        /* Where the next window's scan starts, which is *not* always
         * `target`: see `resumeFrom`.  Kept on the turning so an anchor
         * can hand it on. */
        j.cursor = this.cursor;
        this.window.length = 0;
        this.windowFailed = false;
      }
    }
  }

  /**
   * Keep siting until turning `n` exists, or the scan passes `limit`.
   * The junction, or null.
   *
   * For the return through the back button (`prompt_19.md` item 2): the
   * page that comes back has to put the car on the side road it left by,
   * and has to do it *before* the first ground is meshed.  `update` is
   * bounded to ninety steps a call so a frame never pays for more than
   * 900 m of survey; this is a loop over it with its own bound, so a
   * cookie from a very long drive costs a longer boot rather than a hang.
   *
   * By ordinal and not by billboard id, since the list loops -- asking
   * for billboard 3 would find the *first* turning showing it.  And cheap
   * however deep `n` is only because `resumeFrom` has already moved the
   * chain up to a few turnings short of it.
   */
  siteUntil(n, limit) {
    if (n === HOME_N) return this.home;
    for (let i = 0; i < 4000; i++) {
      const j = this.byN.get(n);
      if (j) return j;
      if (!BILLBOARDS.length || this.next > n || this.cursor > limit) break;
      this.update(Math.min(limit, this.cursor + 900));
    }
    return this.byN.get(n) || null;
  }

  /**
   * Where the chain of turnings can be picked up from, for a save made
   * with the car at arc `s`: the last turning at least `ANCHOR_BACK`
   * behind it, as `{ n, s }`, or null to start from home.
   *
   * **Why a save needs this at all.**  Siting is a chain: every window
   * opens `SPACING_MIN` past the turning before it, so where turning `n`
   * stands depends on where `n - 1` stood, all the way back to the home
   * turning at the origin.  While the list ran out after three entries
   * the chain did too.  Looped, it does not, and a page resuming a
   * hundred-kilometre drive would have to re-site a hundred and forty
   * turnings to find the one in front of the car -- a boot cost that grows
   * with the length of the drive.
   *
   * With an anchor the chain restarts from a turning the save names, and
   * that is exact rather than approximate: see `resumeFrom`.  `c` is where
   * the scan stood when that turning was committed, and it is part of the
   * anchor for the reason given there.
   */
  anchorBefore(s) {
    const i = lowerBound(this.list, s - ANCHOR_BACK, mouthS) - 1;
    const j = i >= 0 ? this.list[i] : null;
    const a = j && j.n !== HOME_N ? { n: j.n, s: j.s, c: j.cursor } : null;
    /* Never older than the anchor this page itself resumed from.  The
     * turnings behind that were not re-sited, so until the car has driven
     * `ANCHOR_BACK` past it the list has nothing newer to offer -- and a
     * save written in that stretch would otherwise hand the next page the
     * whole chain to walk again. */
    return this.base && (!a || a.n < this.base.n) ? this.base : a;
  }

  /**
   * Restart the chain from a saved anchor rather than from home.  Call
   * after `siteHome` and before the first `update`.
   *
   * Exact, and this is the argument, because if it were not a reload
   * would move every sign in the world:
   *
   *   - `_survey` and `_build` read nothing but the road and the
   *     junction-blind landform (`bareAt`, `coarseAt`) -- never another
   *     turning -- and every hash in `_build` is positional;
   *   - so the whole state of the chain after turning `n` is `{ next,
   *     target, cursor }`, and the anchor carries all three.
   *
   * **The cursor is the one that is easy to leave out**, and the first
   * version did.  It is usually equal to `target` -- the window is 457.2 m
   * wide and so is the floor, so the scan that closes one window stops
   * where the next one opens -- but the scan walks in `SCAN_STEP`s from
   * wherever the last window ended, and when a window's *first* candidate
   * wins, the cursor stands up to one step past the new target.  The next
   * window is then surveyed on a grid offset by that remainder, and a
   * restart from `target` alone put turning 22 of `country` 2.8 m from
   * where the drive had it -- a sign that moves on a reload, and a return
   * through its gate that lands on the main road.  `perf-bench/loop.mjs`
   * checks every anchor of a long drive for this.
   *
   * What it does *not* do is re-site the turnings behind the anchor.  They
   * are more than `ANCHOR_BACK` back, past the view distance, and a
   * player who turns round and drives that far will find road with no
   * turnings on it -- which is the price of not walking the whole chain.
   */
  resumeFrom(anchor) {
    if (!anchor || !this.enabled || !(anchor.n >= 0) || !Number.isFinite(anchor.s)) return;
    if (this.list.length > (this.home ? 1 : 0)) return;
    const target = anchor.s + SPACING_MIN;
    if (target <= this.target) return;
    this.base = { n: anchor.n, s: anchor.s, c: anchor.c };
    this.next = anchor.n + 1;
    this.target = target;
    /* An anchor with no cursor -- hand-edited, or from before it was
     * written -- restarts on the aligned grid, which is right nearly
     * always and a few metres out otherwise. */
    this.cursor = Number.isFinite(anchor.c) && anchor.c >= target && anchor.c < target + SCAN_WINDOW
      ? anchor.c : target;
    this.window.length = 0;
    this.windowFailed = false;
  }

  /**
   * Rank the window, build the best that builds, and put it in the world.
   *
   * **Three tiers, and they are the ceiling.**  `prompt_19.md` item 1
   * makes 3000 ft a limit rather than a hope, and a window that ends with
   * nothing built is the only way past it.  So a window is not allowed to
   * end empty while anything in it could be a road:
   *
   *   0  strict    every gate passes and the corridor is a full-length,
   *                gentle road.  Ranked by score, as it always was.
   *   1  relaxed   the corridor is full but the main road is too steep,
   *                too curved or too far off the landform for the gates.
   *                `siteHome`'s argument applied everywhere: a gate says
   *                what is impossible and the score says what is good,
   *                and those three gates were never about possibility.
   *   2  short     the corridor runs out before `SPUR_MIN`, or reaches
   *                the land too steeply.  Only tried at `SPUR_SHORT`.
   *
   * And after the tiers, every candidate is tried once more at
   * `SPUR_SHORT`, because the usual reason `_build` refuses ground
   * `_survey` passed is the spur's own grade clamp running out of
   * corridor before the far end -- which a shorter road does not reach.
   *
   * The fall-through matters as it always did: the survey reads the
   * *landform* through `coarseAt` while the spur has to be a road, node
   * by node, and trying the next candidate is a great deal better than
   * losing the turning.
   */
  _commit() {
    const med = {
      reach: median(this.window.map((c) => c.reach)),
      fall: median(this.window.map((c) => c.fall)),
    };
    const ranked = this.window
      .map((c) => ({ c, sc: score(c, med) }))
      .sort((a, b) => (a.c.tier - b.c.tier) || (a.sc - b.sc));

    for (const short of [false, true]) {
      for (const { c } of ranked) {
        const site = this._build(c, short);
        if (!site) continue;
        const b = BILLBOARDS[this.next % BILLBOARDS.length];
        const j = new Junction(b, this.next, site);
        this.list.push(j);
        this.byN.set(j.n, j);
        this._index(j);
        this.next++;
        this.newBoxes.push({ ground: j.box, clear: j.clearBox, s: j.s });
        return j;
      }
    }
    return null;
  }

  /**
   * Is arc position `s` a place a turning can go?  Returns the built site
   * or null.
   *
   * **Nothing in here may call `heightAt`, `gradientAt` or `surfaceAt`.**
   * By the time this runs, `Terrain.heightAt` calls back into this class,
   * so a siting pass that used it would recurse into the thing it is
   * deciding.  `bareAt` and `coarseAt` are road-blind and junction-blind
   * by construction, and `road.sampleAt` reads the tracer's own nodes.
   */
  _survey(s) {
    const road = this.road;
    if (s + MOUTH > road.length - STEP * 2) return null;
    const p = road.sampleAt(s, _p);

    /* Gates 1 to 3 no longer reject: they decide the tier.  See `_commit`
     * for why a window may not end empty while a road could be built. */
    // 1. not on a slope
    let gates = Math.abs(p.grade) <= SITE_GRADE;

    // 2. not off a hairpin, over the length of the mouth and then some
    let k = 0;
    for (const ds of [-60, -30, 0, 30, 60]) {
      const q = road.sampleAt(Math.max(STEP, s + ds), _p2);
      if (Math.abs(q.k) > k) k = Math.abs(q.k);
    }
    if (k > SITE_CURVATURE) gates = false;

    // 3. the pad would not be a mesa
    const earth = Math.abs(p.y - this.T.bareAt(p.x, p.z));
    if (earth > SITE_EARTHWORK) gates = false;

    /* The road has to exist for the mouth's whole width.  The guardrail
     * is deliberately *not* a test: `railBlocked` opens the fence across
     * a mouth wherever one is sited, so refusing a site because the rail
     * rule wanted a barrier there would be refusing on the strength of a
     * barrier this class then removes.  Whether the ground beside the
     * road falls away is asked properly, below, by `_corridor`. */
    if (!road.mid.nodes[Math.max(0, Math.round(s / STEP)) + 2]) return null;

    /* 5. the corridor itself, on each side.  This is the prompt's
     * "subject to the flatness of the terrain" and it is the only test
     * that looks at ground the road has never been near. */
    let best = null;
    for (const side of [1, -1]) {
      const c = this._corridor(p, side);
      if (c === null) continue;
      /* A full corridor beats a short one, and then the flatter side
       * wins.  Ranked on the *reach* rather than on the cross-fall,
       * because reach is the one that decides whether the spur can be
       * built and cross-fall only decides whether it would be built
       * across a cliff. */
      if (!best || (c.full && !best.full)
          || (c.full === best.full && c.reach < best.reach)) best = { side, ...c };
    }
    /* Neither side will take a road measured from the deck -- the main
     * road is in a cutting or up on an embankment.  Ask again from the
     * ground.  Only ever tier 2, and only asked when the question above
     * has already said no, so it costs nothing on ordinary ground. */
    if (!best) {
      for (const side of [1, -1]) {
        const c = this._corridor(p, side, true);
        if (c !== null && (!best || c.reach < best.reach)) best = { side, ...c };
      }
    }
    if (!best) return null;

    return {
      s, side: best.side, k, grade: p.grade, earth,
      reach: best.reach, fall: best.fall, len: best.len,
      tier: !best.full ? 2 : gates ? 0 : 1,
    };
  }

  /**
   * Turn a survey into a turning: the spur, its surface, and the sign.
   *
   * Separate from `_survey` because the whole window is surveyed and only
   * one candidate is built, and building is where the cost is -- a
   * `coarseAt` per node is seven heightmap samples, and there are up to
   * nineteen nodes.
   */
  _build(c, short = false, kindOverride = 0) {
    const road = this.road;
    const side = c.side;
    const p = road.sampleAt(c.s, _p);

    /**
     * What this one is made of, and how hard it bends.
     *
     * Hashed from the world seed and the arc position rather than drawn
     * from a stream, for the reason every generator in this repository is
     * positional: the same world has to come back the same way after a
     * reload, a resume, and a return from somebody else's website.  The
     * position is rounded to the metre so that floating-point noise in
     * `s` cannot change a road's surface.
     *
     * Decided *before* the spur is built, because a sealed road is built
     * to a different profile -- see `_spur`.  `siteHome` passes its own,
     * since the road a drive starts on is always tarmac.
     */
    const id = Math.round(c.s);
    const kind = kindOverride || KIND_LIST[hash3(id, 11, 3, this.seed) % KIND_LIST.length];
    const bend = (hashFloat(id, 17, 1, this.seed) - 0.5) * 1.4;

    /**
     * How long this one is.
     *
     * `c.len` is how far the corridor survey got before the ground
     * stopped being good, and the first version of this used it directly
     * -- *the land decides* being a better rule than a random number, and
     * the same move `plan_17.md` made for spacing.
     *
     * Measured, it is a rule with almost nothing to say.  This terrain is
     * open enough that the corridor reaches `SPUR_MAX` at nearly every
     * site on every side, so every spur came out the same length and
     * `prompt_18.md` item 5's *some side roads can be longer, others
     * shorter* was quietly not implemented.  A cap that never binds is
     * not a decision.
     *
     * So both: the land sets the **ceiling**, and the hash picks where
     * under it this road stops.  Where the ground is good that is variety
     * the terrain had no opinion about, and where it is not the survey
     * still wins -- which is the half that had to be true.
     */
    const want = SPUR_MIN + hashFloat(id, 5, 9, this.seed) * (SPUR_MAX - SPUR_MIN);
    let len = Math.round(Math.min(c.len, want) / SPUR_STEP) * SPUR_STEP;
    /* The last resort before a gap goes past the ceiling.  See `_commit`. */
    if (short) len = SPUR_SHORT;
    else if (len < SPUR_MIN) return null;

    const sealed = kind === KIND.sealed;
    let nodes = this._spur(p, side, len, bend, sealed);
    /* A sealed spur holds the main road's vertical curve, so it cannot
     * follow a rise the way a track does, and the ground it would not
     * follow is earthwork.  Where that runs past `EARTHWORK_MAX` the road
     * is shortened rather than the site lost -- the same division as
     * `c.len`: the land sets how far a road of this kind can go. */
    while (!nodes && sealed && !short && len > SPUR_MIN) {
      len -= SPUR_STEP;
      nodes = this._spur(p, side, len, bend, sealed);
    }
    if (!nodes) return null;

    /* The sign goes on the same side as the turning, which the prompt asks
     * for and which is also the only arrangement where the two read as one
     * thing. */
    /* Clamped, because `siteHome` sites turnings inside the first
     * `SIGN_LEAD` metres of road and a sign at a negative arc position is
     * a sign on the backward line, which is not where it goes.  Every
     * other junction is at least a thousand feet out and unaffected. */
    const sp = road.sampleAt(Math.max(STEP * 2, c.s - SIGN_LEAD), _p2);
    const sign = {
      s: c.s - SIGN_LEAD,
      x: sp.x + sp.rx * SIGN_OFFSET * side,
      z: sp.z + sp.rz * SIGN_OFFSET * side,
      /* Facing back down the road, toed in eight degrees toward the
       * carriageway so the face is square-on to a driver at about 150 m
       * rather than at infinity. */
      a: Math.atan2(sp.tz, sp.tx) + Math.PI - side * 0.14,
      side,
    };
    /**
     * The fingerpost, directly across the main road from the mouth.
     * `prompt_19.md` item 2.
     *
     * On the main road's normal through the mouth, on the side the spur
     * is *not*, so a car waiting at the give-way line has it dead ahead.
     * Out past the guardrail line, so a rail on that side runs in front of
     * the post rather than through it, and past the shoulder, so the post
     * -- which is a collider -- is never in the carriageway.
     *
     * It faces back across the road toward the spur.  Which way its arrow
     * points is not decided here or anywhere: always up the road, `+s`,
     * at every junction including the last one in the list.  `signs.js`
     * works out which end of the board that is.
     *
     * `deckY` is the main road's height at the mouth, because the far
     * side of a road on an embankment is a fill batter and a board set
     * from the ground there would stand below the tarmac it is for.
     */
    const post = {
      s: c.s, side,
      x: p.x - p.rx * side * POST_FAR,
      z: p.z - p.rz * side * POST_FAR,
      a: Math.atan2(p.rz * side, p.rx * side),
      tx: p.tx, tz: p.tz,
      deckY: p.y,
    };
    return {
      s: c.s, side, nodes, sign, post, kind, len,
      /* Which tier of `_commit` this came from, 3 for the short fallback.
       * Nothing reads it but `tools/probe/sign.mjs`, which counts them. */
      tier: short ? 3 : c.tier,
      x: p.x, z: p.z, y: p.y,
    };
  }

  /**
   * How far down one side a road could go, and how flat it is on the way.
   *
   * Read off `coarseAt` rather than `bareAt`: the spur is a road, and what
   * decides whether it can be built is the *landform*, not whether there
   * is a three-metre hummock in the way.  That is the same argument
   * `trace.js` makes about its feelers, one scale up.
   *
   * **The length is the answer, not the question.**  This used to walk a
   * fixed seventy metres and return a yes or a no.  Walking to `SPUR_MAX`
   * and reporting where the ground stopped being good gives
   * `prompt_18.md` items 1 and 5 out of the same survey: every spur is
   * built on flat ground, and they are different lengths *because* the
   * flat ground is different lengths.  A random length would have looked
   * the same from the car and meant nothing.
   */
  _corridor(p, side, fromGround = false) {
    const nx = p.rx * side, nz = p.rz * side;
    let worst = 0;
    /* From the deck, normally: a road in a five-metre cutting has a
     * five-metre wall beside it, and that is a refusal.  From the ground
     * at the first node only as the last resort before a gap goes past
     * 3000 ft -- see `_survey` -- where the question is no longer whether
     * the land is good but whether `_spur` can build anything at all, and
     * its own grade clamp and earthwork ceiling are what answer that. */
    let prev = fromGround ? this.T.coarseAt(p.x + nx * SPUR_STEP, p.z + nz * SPUR_STEP) : p.y;
    let last = prev;
    /* The furthest node the survey has reached and approved.  Zero until
     * the first one passes, which is what makes a cliff at five metres a
     * refusal rather than a very short road. */
    let ok = 0;
    for (let a = SPUR_STEP; a <= SPUR_MAX; a += SPUR_STEP) {
      const x = p.x + nx * a, z = p.z + nz * a;
      const y = this.T.coarseAt(x, z);
      if (y < WATER_LEVEL + SITE_FREEBOARD) break;
      const g = Math.abs(y - prev) / SPUR_STEP;
      if (g > SITE_CROSSFALL) break;
      /* And across the corridor, so a spur running along the side of a
       * bank is caught as well as one running up it.  Across the *spur*,
       * which at the mouth is along the main road -- `p.tx, p.tz`. */
      let blocked = false;
      for (const o of [-SPUR_HALF, SPUR_HALF]) {
        const cx = x + p.tx * o, cz = z + p.tz * o;
        const yy = this.T.coarseAt(cx, cz);
        if (yy < WATER_LEVEL + SITE_FREEBOARD) { blocked = true; break; }
        if (Math.abs(yy - y) / SPUR_HALF > SITE_CROSSFALL * 1.6) { blocked = true; break; }
      }
      if (blocked) break;
      if (g > worst) worst = g;
      prev = y;
      last = y;
      ok = a;
    }
    if (ok < SPUR_SHORT) return null;
    /* How steeply the spur would have to run to meet the land at its far
     * end.  The test the whole siting rule turns on -- see `SITE_REACH`.
     *
     * Not a refusal any more, but the difference between a full corridor
     * and a short one: past `SITE_REACH_MAX` the spur is a ramp, and a
     * ramp is only worth building when the alternative is a gap past
     * 3000 ft.  `_spur`'s grade clamp and earthwork ceiling still decide
     * whether it can physically be built. */
    const reach = Math.abs(last - p.y) / ok;
    return {
      fall: worst, reach, len: ok,
      full: !fromGround && ok >= SPUR_MIN && reach <= SITE_REACH_MAX,
    };
  }

  /**
   * The spur itself: authored rather than traced, from a curvature
   * profile rather than from three hand-placed corners.
   *
   * What was here turned by `-side * 0.61` at node 1 and `side * 0.44` at
   * node 4 -- a 35-degree and a 25-degree **corner**, ten metres apart,
   * on a road the player was never expected to look down.  That is
   * `prompt_18.md` item 4: *there are points whose tangent do not look
   * continuous*, and they are exactly those two nodes.
   *
   * The replacement is one rule: the heading is a smooth function of
   * distance, so the curvature is its derivative and is continuous by
   * construction.
   *
   *   heading(a) = perpendicular + bend * smoothstep((a - a0) / W)
   *
   * A smoothstep has zero slope at both ends, so the curvature starts at
   * zero, peaks in the middle of the bend and returns to zero -- which is
   * what a clothoid entry and exit *are*, and it means the spur leaves
   * the main road exactly perpendicular and reaches the portal exactly
   * straight.  Peak curvature is `1.5 * bend / W`: about 1/90 on a long
   * spur and 1/33 on the shortest, both well inside what a car takes at
   * the speed a player who has read a sign is doing.
   *
   * The turn a car makes to get onto it is not this curve -- that is the
   * bellmouth's job, and `MOUTH` is sixteen metres of flare for it.
   */
  _spur(p, side, len, bend, sealed = false) {
    const nodes = [];
    /* Node 0 is the mouth, on the main centreline, at the main road's own
     * node height.  Everything downstream measures `a` from here. */
    let x = p.x, z = p.z, y = p.y;
    const base = Math.atan2(p.rz * side, p.rx * side);

    /* The bend runs between these, leaving a straight length at each end:
     * the first so the junction is a clean T, the last so the portal
     * stands square across the road rather than skewed to it. */
    const a0 = Math.min(14, len * 0.25);
    const a1 = Math.max(a0 + 10, len - 12);
    const W = a1 - a0;
    /**
     * And the bend is clamped to what a road drawn at `SPUR_STEP` can
     * actually be.
     *
     * A smoothstep's slope peaks at 1.5, so the tightest curvature on the
     * spur is `1.5 * bend / W` and the heading therefore turns by
     * `1.5 * bend * SPUR_STEP / W` at the sharpest node.  The ground is
     * built from the *chords* between nodes, so that per-node turn is a
     * visible crease in the edge of the tarmac however smooth the
     * underlying profile is -- which is `prompt_18.md` item 4 again, one
     * level down from the corners it was about.
     *
     * Capping the radius at `MIN_RADIUS` makes the per-node turn
     * `SPUR_STEP / MIN_RADIUS` -- 6.4 degrees, the same at every length,
     * because the cap scales with the window.  A short spur simply bends
     * less, which is also what a short road does.
     */
    const cap = W / (1.5 * MIN_RADIUS);
    const bendC = Math.max(-cap, Math.min(cap, bend));
    const heading = (a) => base + bendC * smoothstep01((a - a0) / W);

    const n = Math.round(len / SPUR_STEP);
    nodes.push({ x, z, y, a: heading(0), cx: x, cz: z, g: 0, gfa: 0 });

    /* Plan first, then heights: the line does not depend on the profile,
     * and a sealed profile is fitted to the whole of it at once. */
    const plan = [];
    for (let i = 1, px = x, pz = z; i <= n; i++) {
      /* Integrated at the midpoint of the step rather than at its start,
       * which is the difference between a polygon inscribed in the curve
       * and one that straddles it -- second-order accurate for the same
       * one cosine. */
      const hm = heading((i - 0.5) * SPUR_STEP);
      px += Math.cos(hm) * SPUR_STEP;
      pz += Math.sin(hm) * SPUR_STEP;
      plan.push({ x: px, z: pz, want: this.T.coarseAt(px, pz) });
    }

    /**
     * A sealed spur is a vertical curve, and it is the main road's.
     *
     * The profile below chases the land with an easing step, which lets
     * the grade change by up to five per cent in five metres: measured,
     * 0.009 to 0.019 of grade per metre on every spur against 0.0037 at
     * worst on the main road, and most spurs at the full twelve per cent
     * inside seventy metres.  On a gravel track that is a track.  On a
     * road the same colour as the one it leaves, it reads as a switchback
     * bolted to a motorway.
     *
     * So a sealed spur gets the tracer's own limit, `MAX_GRADE` over
     * `CURVE_NODES` nodes, and within it the one shape that limit allows
     * from a level start: `y = y0 + c a^2`, with `c` the least-squares fit
     * to the landform and clamped to half the limit.  Level at the mouth,
     * which is where the deck it blends into is level; never more than
     * two and a bit metres of rise over `SPUR_MAX`; and whatever the land
     * does beyond that is earthwork, which is what the main road does
     * with it too.
     */
    let c = 0;
    if (sealed) {
      let num = 0, den = 0;
      for (let i = 0; i < n; i++) {
        const a = (i + 1) * SPUR_STEP, a2 = a * a;
        num += a2 * (plan[i].want - y);
        den += a2 * a2;
      }
      const cap = 0.5 * MAX_GRADE / (CURVE_NODES * STEP);
      c = den > 0 ? Math.max(-cap, Math.min(cap, num / den)) : 0;
    }

    let grade = 0;
    const y0 = y;
    for (let i = 1; i <= n; i++) {
      const { x: px, z: pz, want } = plan[i - 1];
      let py;
      if (sealed) {
        const a = i * SPUR_STEP;
        py = y0 + c * a * a;
        grade = 2 * c * a;
      } else {
        /* Height follows the land with the grade clamped, and eased, so
         * the spur descends into the landform rather than hanging off the
         * carriageway.  The same limiter `trace.js` applies, without the
         * profile fit.  The easing coefficient is per *node*, so halving
         * the node spacing has to halve it too or the profile would
         * follow the ground twice as eagerly as it used to:
         * 1 - sqrt(1 - 0.45) is 0.26. */
        let g = (want - y) / SPUR_STEP;
        if (g > MAX_GRADE) g = MAX_GRADE;
        if (g < -MAX_GRADE) g = -MAX_GRADE;
        grade += (g - grade) * 0.26;
        py = y + grade * SPUR_STEP;
      }
      /* And the same earthwork ceiling, so a spur cannot build a
       * five-storey embankment out into a valley.  If it wants to, the
       * site was not flat and the corridor test should have caught it --
       * this is the belt to that pair of braces. */
      if (Math.abs(py - want) > EARTHWORK_MAX) return null;
      if (py < WATER_LEVEL + 0.5) return null;

      /* The quadratic control point, exactly as `trace.js` builds it: half
       * a step along the node's own tangent, so the drawn road is the
       * Bezier through it rather than the polyline. */
      const prev = nodes[nodes.length - 1];
      prev.cx = prev.x + Math.cos(prev.a) * SPUR_STEP * 0.5;
      prev.cz = prev.z + Math.sin(prev.a) * SPUR_STEP * 0.5;

      x = px; z = pz; y = py;
      nodes.push({
        x, z, y, a: heading(i * SPUR_STEP),
        cx: x, cz: z, g: 0, gfa: Math.abs(grade),
      });
    }
    return nodes;
  }

  /* ---------------------------- queries ----------------------------- */

  /**
   * The nearest spur to a point, or null.  `out` is a scratch object so
   * this can be called per terrain vertex without allocating.
   *
   * **Its own scratch, never `terrain.js`'s `_q`.**  That object is handed
   * to `road.nearest` by both `heightAt` and `roadUV`, and `heightAt`
   * calls this one *while holding* the answer from the other.
   */
  nearest(x, z, out) {
    const list = this._cell(x, z);
    if (!list) return null;
    const o = out || _scratch;
    let bd = Infinity, got = false;
    for (let i = 0; i < list.length; i++) {
      const j = list[i];
      if (j.boxDist(x, z) > 0) continue;
      const q = j.at(x, z, _probe);
      if (!q || q.d >= bd) continue;
      bd = q.d;
      Object.assign(o, q);
      got = true;
    }
    return got ? o : null;
  }

  /**
   * The spur's contribution to the height field: `y1` benched.
   *
   * `deck` is what the main road's platform surface would be at this
   * point if the platform were wide enough -- `q.y + crown(q.d, w)` from
   * `terrain.js`, or null out of the road's reach.  It is the whole of
   * why the mouth has no step in it: the pad's target height is blended
   * onto `deck` with a weight that reaches exactly zero at the mouth, so
   * across the junction the answer *is* the carriageway plane rather than
   * something tuned to sit near it.
   */
  height(x, z, y1, deck, deckW) {
    const q = this.nearest(x, z, _hit);
    if (!q) return y1;

    /**
     * The flare, on the spur's side only -- and *eased* onto the far
     * side rather than switched.
     *
     * This was `q.behind > 0 ? SPUR_HALF : halfWidth(q.a)`, and `behind`
     * crosses zero on the main road's centreline: a step in the built
     * half-width from about 5.6 m to 16 m, straight across the
     * carriageway, at the one place `prompt_18.md` item 2 calls bumpy.
     * Wherever the pad's target height and the ground it is benched into
     * differ by even a centimetre -- which is everywhere, since the main
     * road is crowned and cambered -- that step is a ridge you drive over.
     *
     * Three metres of smoothstep is enough: the two widths are only ever
     * both in play within a few metres of the mouth.
     */
    const flare = q.j.halfWidth(q.a);
    const w = flare + (SPUR_HALF - flare) * smoothstep01(q.behind / 3);
    /**
     * How much of the pad is the spur's own profile and how much is the
     * main road's deck.  Zero at the mouth, one past the bellmouth.
     *
     * `deckW` fades the deck's claim out as the main road's own answer
     * runs out of range, because `deck` used to be offered as a hard
     * yes-or-no at 30 m: a point still taking fourteen per cent of its
     * height from the carriageway plane on one side of that radius and
     * none on the other is a step in the batter face, drawn by the same
     * ink pass as every other step.  It is the medial axis again, in
     * miniature.
     */
    const m = 1 - (1 - smoothstep01(q.a / MOUTH)) * (deck === null ? 0 : deckW);
    /**
     * The pad's own surface, **crowned like a road** rather than flat.
     *
     * A flat pad meeting a crowned carriageway is a slope discontinuity
     * along the whole length of the blend -- continuous in height, which
     * is what the continuity probe measures, and a ridge under the wheels,
     * which is what the driver measures.  Using the main road's own crown
     * function means the two cross-sections are the same shape, so the
     * blend between them is smooth in the first derivative and not just
     * the zeroth.  A side road that sheds water is also simply correct.
     *
     * `min(d, w)` so that beyond the platform edge this is the *edge*
     * height, which is where the batter starts -- exactly the `edge` term
     * in `terrain.js:heightAt`.
     *
     * **`w` is passed as well as clamped against**, because the shoulder
     * fall is spent between `FALL_START` and the platform edge rather
     * than over a fixed 95 cm -- see `crown` -- so the function needs to
     * know where this cross-section's edge is.  Handing it a spur's own
     * half-width is what makes the two profiles the same *shape* at
     * different widths, which is the whole point of sharing the function.
     */
    const surf = q.sy + crown(Math.min(q.d, w), w);
    const target = deck === null ? surf : surf * m + deck * (1 - m);

    /* Distance to the curve, not the lateral offset.  The two agree
     * wherever the foot of the perpendicular is interior to the spur, and
     * off either end they do not -- a point ten metres beyond the last
     * node sits on the tangent's extension, so its offset is near zero
     * while its distance is ten metres.  Building the pad on the offset
     * puts a tongue of flat ground off the end of the spur and out across
     * the far side of the main road; on the distance it ends in a rounded
     * cap, which is where it ends.  `chunks.js` learned the same lesson
     * about paint one iteration ago. */
    const d = q.d;
    if (d < w) return target;

    const over = d - w;
    let y;
    if (y1 > target) {
      const face = target + over / CUT_BATTER;
      if (face >= y1) return y1;
      y = face;
    } else {
      const face = target - over / FILL_BATTER;
      if (face <= y1) return y1;
      y = face;
    }
    /* Eased to nothing before the query radius, for the reason
     * `EARTH_FADE` exists in `terrain.js`: whatever is still happening
     * where a query stops being answered is a step, and the ink pass
     * draws steps. */
    const fade = SPUR_HALF + SPUR_QUERY;
    if (d <= fade - SPUR_FADE) return y;
    return y + (y1 - y) * smoothstep01((d - (fade - SPUR_FADE)) / SPUR_FADE);
  }

  /**
   * Road coordinates for the ground shader, when the spur is the nearer
   * road.  The shader has no notion of a minor road: it paints whatever
   * `roadA` says is close, so a spur is tarmac for free.
   */
  roadUV(x, z, mainD) {
    const q = this.nearest(x, z, _hit);
    if (!q || q.d >= mainD) return null;
    return q;
  }

  /**
   * What the surface is, for an answer `roadUV` has already found.  The
   * number `chunks.js` writes into `roadK` and `groundmat.js` reads back:
   * zero on the main road, on every bellmouth, and everywhere that is not
   * a side road at all.
   *
   * Takes the hit rather than a position so that one `nearest` per vertex
   * answers both questions -- and so that `terrain.js` does not have to
   * import this file, which would be a cycle through `CARRIAGEWAY` and
   * would land in its temporal dead zone depending on which module the
   * bundler happened to load first.
   *
   * **The ramp is what makes this safe to interpolate.**  A vertex
   * attribute is linear across a triangle, so a quantity that jumps
   * between two road frames draws garbage along the seam between them --
   * which is the whole of `plan_18.md` §3.  Starting the surface change
   * `KIND_FADE` metres *past* the bellmouth means the attribute is
   * already exactly zero everywhere the two frames meet, and the only
   * place it varies is out along a spur where nothing else is happening.
   *
   * It is also just what an unsealed road looks like where it meets a
   * classified one: tarmac for the first few metres, because that is
   * where the traffic turns.
   */
  kindOf(q) {
    /* Fades out again across the platform edge, so the grass beside a
     * dirt road is grass and not a wide brown smear. */
    const lateral = 1 - smoothstep01((q.d - SPUR_HALF) / 3);
    return q.j.kind * smoothstep01((q.a - MOUTH) / KIND_FADE) * lateral;
  }

  /**
   * Distance to the nearest mouth, **signed by which side it is on**, for
   * `chunks.js`'s `roadJ` attribute.
   *
   * What this was for: `roadU` used to be the lateral offset of whichever
   * road was nearer, so across a bellmouth it flipped to a frame at right
   * angles, and a triangle spanning the flip interpolated between two
   * unrelated signed values and drew a centre line across the junction.
   * The answer was to suppress every marking within seventeen metres of a
   * mouth -- and `prompt_18.md` item 2 is the bill for that: *at an
   * intersection, the center line on the main road should continue.*
   *
   * It continues now because the flip is gone rather than painted over:
   * `roadU` is the *main* road's frame everywhere (`terrain.js:mainUV`),
   * so nothing near a mouth has a marking coordinate that differs from
   * the one it had before the turning existed.
   *
   * What is left for this number is the one piece of suppression that is
   * real.  At a T-junction the major road's centre line runs straight
   * through and its **edge line is broken across the mouth** -- on the
   * side the minor road joins, and only there.  Hence the sign: the
   * shader compares it against the sign of `roadU` and breaks one line.
   *
   * The sign is safe to interpolate for the same reason `roadA` is: the
   * magnitude is a distance, so it approaches zero from both directions
   * at the mouth, and two junctions on opposite sides are at least
   * `SPACING_MIN` apart -- fifteen hundred feet -- so no triangle ever
   * spans both.
   */
  mouthDist(x, z) {
    /* The same cell as `nearest`, and that is sound rather than lucky: a
     * junction's box is its spur padded by forty metres and the mouth is
     * one of that spur's own nodes, so any point near enough to a mouth
     * to matter here -- the markings have finished fading by seventeen
     * metres -- lies inside that junction's box, and therefore in a cell
     * it was indexed into. */
    const list = this._cell(x, z);
    if (!list) return Infinity;
    let best = Infinity, side = 1;
    for (let i = 0; i < list.length; i++) {
      const d = Math.hypot(list[i].x - x, list[i].z - z);
      if (d < best) { best = d; side = list[i].side; }
    }
    return best === Infinity ? Infinity : best * side;
  }

  /**
   * Should `scatter.js` keep off this square metre?
   *
   * Two exclusions.  The spur corridor, because a tree in the road is a
   * tree in the road; and a sightline box running back up the main road
   * from each sign, because a billboard behind a conifer is a billboard
   * nobody reads.
   */
  excludes(x, z) {
    for (const j of this.list) {
      /* Everything below lies inside `clearBox` -- that is what the box
       * is drawn round -- so this is exact, and it turns a walk of a list
       * that now grows for as long as the drive does into four
       * comparisons a turning. */
      const cb = j.clearBox;
      if (x < cb.minX || x > cb.maxX || z < cb.minZ || z > cb.maxZ) continue;
      if (j.boxDist(x, z) === 0) {
        const q = j.at(x, z, _hit);
        if (q && Math.abs(q.u) < SPUR_HALF + 5) return true;
      }
      /* The fingerpost: a clearing round it, and the strip from the
       * mouth across the road to it, so nothing grows between the
       * give-way line and the board. */
      const po = j.post;
      const px = x - po.x, pz = z - po.z;
      const r2 = px * px + pz * pz;
      if (r2 < 16) return true;
      /* The strip is `POST_FAR` long by construction, so the frame is the
       * main road's own normal and no square root is needed. */
      if (r2 < (POST_FAR + 4) * (POST_FAR + 4)) {
        /* `a` faces from the post toward the mouth. */
        const ex = Math.cos(po.a), ez = Math.sin(po.a);
        const f = px * ex + pz * ez;
        const t = Math.abs(-px * ez + pz * ex);
        if (f > 0 && f < POST_FAR && t < 4) return true;
      }
      const s = j.sign;
      if (!s) continue;
      /* The sightline, in the sign's own frame: 220 m back along the road
       * the sign faces, and wide enough to cover the panel. */
      const dx = x - s.x, dz = z - s.z;
      const f = dx * Math.cos(s.a) + dz * Math.sin(s.a);
      const t = -dx * Math.sin(s.a) + dz * Math.cos(s.a);
      if (f > -6 && f < 220 && Math.abs(t) < 16) return true;
    }
    return false;
  }

  /**
   * Does a guardrail node at arc `s` on `side` sit in a mouth?
   *
   * `furniture.js` asks per node and gets a plain boolean back, which its
   * existing run-splitting turns into two runs with a gap -- and
   * `physics.syncRails` builds its colliders from those same runs, so the
   * gap in the fence and the gap in the collider are the same object
   * rather than two derivations of one rule.
   */
  railBlocked(s, side) {
    const half = MOUTH + 6;
    for (let i = lowerBound(this.list, s - half, mouthS); i < this.list.length; i++) {
      const j = this.list[i];
      if (j.s >= s + half) break;
      if (j.side === side && Math.abs(s - j.s) < half) return true;
    }
    return false;
  }

  /**
   * Where the car is with respect to a turning: `null`, or the junction
   * it is on together with how far down and whether it is past the gate.
   *
   * **This used to be the whole trigger.**  `turnedOnto` returned a
   * junction once the wheels were twenty-two metres down a spur, and
   * `depart.js` counted three seconds and navigated.  `prompt_18.md` item
   * 3 replaces the timer with a thing in the world -- *create a
   * mysterious portal at the end of each side road, driving through it
   * takes the player to the link* -- so the question splits in two.
   *
   *   `on`      the car is in the corridor and pointed down it.  The
   *             departure card comes up: this is the announcement, and it
   *             is cancellable for as long as the spur lasts.
   *   `through` it has crossed the gate.  This is the commitment, and it
   *             is a place rather than a countdown -- which is both what
   *             the prompt asks for and a better answer to the question
   *             `depart.js` was arguing with itself about, since a player
   *             who did not mean to leave has the whole length of the
   *             side road to brake or steer out.
   *
   * The heading test survives unchanged and is still the one that
   * matters: without it a car that spins on the apron, or a player who
   * parks in the mouth to read the sign, is sent to a website.
   */
  onSpur(x, z, yaw, speed, out = {}) {
    /* The cell rather than the whole list: a point inside a junction's
     * box is in every cell that box was indexed into, and the list now
     * grows for as long as the drive does. */
    const list = this._cell(x, z);
    if (!list) return null;
    for (const j of list) {
      if (j.boxDist(x, z) > 0) continue;
      const q = j.at(x, z, _hit);
      if (!q) continue;
      /* Past the bellmouth and roughly on the carriageway.  Held wider
       * than the tarmac so that a car wandering on a dirt road is still
       * on the dirt road. */
      if (Math.abs(q.u) > 8 || q.a < MOUTH + 6) continue;
      if (Math.abs(speed) < 0.5) continue;
      const along = q.tx * Math.cos(yaw) + q.tz * Math.sin(yaw);
      if (along < 0.4) continue;             // 66 degrees of the spur's line
      out.j = j;
      out.a = q.a;
      out.u = q.u;
      return out;
    }
    return null;
  }

  /**
   * Has the car just driven through a gate?  The junction, or null.
   *
   * **A crossing of a plane, and not a test of where the car is.**  What
   * was here asked whether the car was far enough down the spur, close
   * enough to its centreline, moving, pointed the right way, and *armed*
   * -- five conditions, four of which could be false for a single frame
   * of ordinary driving.  And a frame in which any of them was false took
   * the departure card down, which disarmed the turning, which meant the
   * gate could not fire at all for the rest of that visit.  Wobble once on
   * the way down a side road and the portal was dead.  That is the bug
   * behind *the link doesn't trigger when the car drives through the
   * portal*, and no amount of loosening those five thresholds would have
   * fixed it, because the fault was in having them.
   *
   * Driving through a gate is not a position, it is an **event**: the
   * segment the car moved along this frame crosses the disc of the ring.
   * So that is what is asked.  It cannot be missed at speed -- a car doing
   * 40 m/s covers 0.7 m in a frame and the test is a segment, not a
   * sample -- it needs no arming, because a crossing is directional and
   * driving back out is the other direction, and it is the same `GATE_R`
   * the ring is drawn to, so what the player sees is what fires.
   */
  crossedGate(x0, z0, x1, z1) {
    /* Only the junctions indexed where the car is.  A crossing is within
     * `GATE_R` of a spur node and the box is the nodes padded by far more
     * than that, so a car crossing a gate is inside that gate's box at
     * both ends of the step -- and in its cell. */
    const list = this._cell(x1, z1);
    if (!list) return null;
    for (const j of list) {
      const g = j.gate;
      /* Signed distance along the gate's own normal, which is the spur's
       * heading there: negative in front of the gate, positive past it. */
      const d0 = (x0 - g.x) * g.tx + (z0 - g.z) * g.tz;
      const d1 = (x1 - g.x) * g.tx + (z1 - g.z) * g.tz;
      if (d0 >= 0 || d1 < 0) continue;
      const t = d1 === d0 ? 0 : -d0 / (d1 - d0);
      const cx = x0 + (x1 - x0) * t, cz = z0 + (z1 - z0) * t;
      /* And through the hole rather than past the side of it. */
      const lat = (cx - g.x) * -g.tz + (cz - g.z) * g.tx;
      if (Math.abs(lat) > GATE_R) continue;
      return j;
    }
    return null;
  }

  /**
   * The arc address of a car that is on a spur, or null.
   *
   * `main.js` asks when `RoadPath.nearest` has given up -- which it does
   * beyond 46 m, and a spur runs to 92.  The honest answer is the mouth
   * the spur hangs off: it is a real position on the real road, it is
   * where the player will come back out, and it is where a resume from
   * the link already puts them.  See `arcOf` in `main.js` for what was
   * happening before it was asked.
   */
  arcFor(x, z) {
    const list = this._cell(x, z);
    if (!list) return null;
    for (let i = 0; i < list.length; i++) {
      const j = list[i];
      if (j.boxDist(x, z) > 0) continue;
      const q = j.at(x, z, _hit);
      if (q && Math.abs(q.u) < SPUR_HALF + 4) return j.s;
    }
    return null;
  }

  /* There was a `disarmNear` here, and an `armed` flag on every junction.
   *
   * They existed because the trigger used to be a *place*: a car standing
   * inside a corridor was indistinguishable from one that had just driven
   * into it, so a resume from the link -- which lands at the mouth it
   * just used -- fired the same turning again, a loop the back button
   * could not break.
   *
   * A crossing has no such problem.  You cannot *stand on* a crossing,
   * only make one, and arriving back from a link makes none.  The flag
   * went with the fault it was patching: state that nothing reads is
   * worse than no state at all, because the next person to read it will
   * believe it.
   */

  /**
   * The turnings whose mouth is in `[s0, s1]`, by binary search on the
   * list's order rather than a filter of all of it.  Three of these a
   * frame, over a list that since `prompt_4.md` item 4 never stops
   * growing.
   */
  _between(s0, s1) {
    const i0 = lowerBound(this.list, s0, mouthS);
    let i1 = i0;
    while (i1 < this.list.length && this.list[i1].s <= s1) i1++;
    return this.list.slice(i0, i1);
  }

  /** Junctions whose sign is inside the arc window, for `signs.js`.  A
   *  sign stands exactly `SIGN_LEAD` before its mouth -- see `_build`. */
  inRange(s0, s1) {
    return this._between(s0 + SIGN_LEAD, s1 + SIGN_LEAD).filter((j) => j.sign);
  }

  /** Junctions whose fingerpost is inside the arc window, for `signs.js`.
   *  The post is at the mouth's own arc position. */
  postsInRange(s0, s1) {
    return this._between(s0, s1);
  }

  /**
   * Junctions whose *mouth* is inside the arc window, for `portal.js`.
   *
   * A different window from `inRange` and deliberately so: a sign stands
   * `SIGN_LEAD` before its turning and a portal stands the length of a
   * spur after it, and the thing being built has to be in range of where
   * it actually is.
   */
  mouthsInRange(s0, s1) {
    return this._between(s0, s1);
  }

  /**
   * Site the turning the drive starts on.  `prompt_18.md` item 6.
   *
   * Three things make it unlike every other junction.
   *
   * **It must exist.**  Everywhere else a site that fails every gate is
   * simply not built and the scan walks on; here there is nowhere else
   * for the player to be, so the gates rank rather than reject and the
   * best of what is in the window is taken whatever it scores.  In
   * practice this is never a bad site -- the first few hundred metres of
   * road are as ordinary as any other few hundred -- but it must not be
   * able to fail.
   *
   * **It carries no billboard.**  A panel reading "Back" beside the road
   * is furniture nobody asked for, so its sign record is marked `post`
   * and `signs.js` builds a fingerpost pointing the way the billboards
   * are instead -- which is `prompt_18.md`'s *make it obvious which way
   * of the main road is the right direction*.
   *
   * **It is sealed.**  The first road anybody drives should not be the
   * one that teaches them the car slides on gravel.
   */
  siteHome() {
    if (this.home || !this.enabled) return null;
    /**
     * Relaxed, and this is the difference between a rule and a promise.
     *
     * The gates were measured against a road that is *mostly* gentle, and
     * the first three hundred metres of a given seed need not be: on
     * `billboard` it leaves the origin downhill at eleven per cent, which
     * is outside `SITE_GRADE` from end to end of the window, so every
     * gate-respecting site in it fails and the drive has nowhere to
     * start.  Everywhere else that is the right answer -- the scan simply
     * walks on to better ground -- and here there is no walking on.
     *
     * So the gates become terms in the score, which they already are, and
     * the search is over the *best available* rather than the acceptable.
     * The corridor test still binds, because it is the one that asks
     * whether a road can physically be built, and a start on a spur that
     * does not fit is not a start.
     */
    const cands = [];
    for (let s = HOME_FROM; s <= HOME_TO; s += SCAN_STEP) {
      const c = this._survey(s);
      if (c) cands.push(c);
    }
    /* And if even that found nothing, look further out before giving up:
     * a mile of gorge at the start of a seed is rare and survivable, and
     * `main.js` falls back to the main road if this returns null. */
    if (!cands.length) {
      for (let s = HOME_TO + SCAN_STEP; s <= HOME_TO + 600; s += SCAN_STEP) {
        const c = this._survey(s);
        if (c) cands.push(c);
      }
    }
    if (!cands.length) return null;
    const med = {
      reach: median(cands.map((c) => c.reach)),
      fall: median(cands.map((c) => c.fall)),
    };
    /* A full corridor first -- which is what this used to require -- and
     * then the best score, which is where the gates now live. */
    cands.sort((a, b) => ((a.tier === 2) - (b.tier === 2))
                         || (score(a, med) - score(b, med)));
    for (const c of cands) {
      const site = this._build(c, false, KIND.sealed);
      if (!site) continue;
      /* No billboard.  The fingerpost every turning has across the road
       * is the only sign here, and `prompt_18.md`'s *make it obvious which
       * way is the right direction* is what it is for. */
      site.sign = null;
      const j = new Junction({ id: 0, name: 'Back', back: true }, HOME_N, site);
      this.home = j;
      /* In `s` order like everything else in `list`.  It is always first
       * in practice -- this runs at boot, before any other siting -- but
       * the range queries binary-search on that order, so it is kept by
       * construction rather than by call order. */
      this.list.splice(lowerBound(this.list, j.s, mouthS), 0, j);
      this._index(j);
      this.newBoxes.push({ ground: j.box, clear: j.clearBox, s: j.s });
      /* Fifteen hundred feet from *here*, not from the origin, so the
       * first billboard's window is measured from the road the player
       * drives out onto. */
      this.target = Math.max(this.target, j.s + SPACING_MIN);
      this.cursor = Math.max(this.cursor, this.target);
      return j;
    }
    return null;
  }
}

/** The first index in `list` whose `key` is not below `v`.  `list` is in
 *  increasing `key` -- see `Junctions.list`. */
function lowerBound(list, v, key) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
const mouthS = (j) => j.s;

const _scratch = {};
/** Per-segment scratch for `Junction.at`: where the foot of the
 *  perpendicular fell, and how far away it was.  Sized well past the
 *  nineteen segments `SPUR_MAX / SPUR_STEP` can produce. */
const _st = new Float64Array(64);
const _sd = new Float64Array(64);
const _hit = {};
/** `nearest` walks candidates into this and keeps the winner in `out`. */
const _probe = {};
