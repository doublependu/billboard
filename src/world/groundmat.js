import * as THREE from 'three';
import { TEX, roadTexture, ROAD_TILE_LENGTH } from '../core/textures.js';
import { CEL, gradientMap, shadowTint } from '../core/toon.js';
import { CARRIAGEWAY, SHOULDER } from './terrain.js';
import { SEASON_UNIFORMS, SEASON_PARS } from './season.js';
import { patchClouds } from './cloudfield.js';

/* ------------------------------------------------------------------ *
 * The ground material.
 *
 * A `MeshStandardMaterial` with its map stage replaced -- the lighting,
 * shadows and fog that three.js already does well are left alone, and
 * only the question of *what colour is this square metre* is taken over.
 *
 * Four inputs decide it, and the fourth is the interesting one:
 *
 *   height        sand at the water, grass in the middle, heather high up
 *   steepness     rock breaks through wherever the ground stands up
 *   road prox     gravel on the shoulder; and no rock near the road,
 *                 because a cutting is engineered, not weathered
 *   curvature     a discrete Laplacian of the landform -- positive in a
 *                 hollow, negative on a ridge.  Sediment gathers in one
 *                 and rock is exposed on the other, which is a far better
 *                 rule than height or slope alone and costs four samples
 *                 that were already being taken.
 *
 * On top of those, the same blend noise is read at three world scales --
 * 8 m, 220 m and 1400 m -- so the transitions between surfaces are
 * ragged at every distance you look at them from.  A crossfade governed
 * by height alone puts a contour line around every hill.
 * ------------------------------------------------------------------ */

const DETILE = /* glsl */ `
  /* Explicit gradients, because every call is inside a branch -- see
   * "only the layers that show" in FRAG_BODY -- and an implicit derivative
   * inside non-uniform control flow is undefined.  g is the gradient pair
   * for a; b is the same world position at BREAK_RATIO of the scale, so its
   * gradients are g times that and need not be taken twice. */
  #define BREAK_RATIO 0.3688
  vec3 detile( sampler2D t, vec2 a, vec2 b, float k, vec4 g ) {
    return mix( textureGrad( t, a, g.xy, g.zw ).rgb,
                textureGrad( t, b, g.xy * BREAK_RATIO, g.zw * BREAK_RATIO ).rgb,
                0.30 + 0.30 * k );
  }
`;

const PARS = /* glsl */ `
  uniform sampler2D tGrass, tGrassDry, tHeather, tRock, tGravel, tSand, tFade, tRoad;
  uniform sampler2D tTrack;
  uniform float uWater, uCarriageway, uRoadTile, uShoulder;
  varying vec3 vWorld;
  varying float vSteep, vCurv, vRoadU, vRoadA, vRoadS, vRoadJ, vRoadK;
` + SEASON_PARS;

const VERT_PARS = /* glsl */ `
  attribute float roadU;
  attribute float roadA;
  attribute float roadJ;
  attribute float roadK;
  attribute float roadS;
  attribute float curv;
  varying vec3 vWorld;
  varying float vSteep, vCurv, vRoadU, vRoadA, vRoadS, vRoadJ, vRoadK;
`;

const VERT_BODY = /* glsl */ `
  vec4 wp = modelMatrix * vec4( transformed, 1.0 );
  vWorld = wp.xyz;
  vSteep = clamp( ( 1.0 - dot( normalize( objectNormal ), vec3( 0.0, 1.0, 0.0 ) ) ) * 2.6, 0.0, 1.0 );
  vRoadU = roadU;
  vRoadA = roadA;
  vRoadJ = roadJ;
  vRoadK = roadK;
  vRoadS = roadS;
  vCurv = curv;
`;

const FRAG_BODY = /* glsl */ `
  vec2 uvNear = vWorld.xz * 0.125;          // 8 m tile
  /* Second sample of the same texture at an incommensurate scale and
   * offset, mixed by the slow noise.  An 8 m tile seen at 250 m across a
   * hillside moires into corduroy stripes that follow the contours, and
   * no amount of anisotropy fixes it because the repeat is real.  Two
   * scales beating against each other has no period. */
  vec2 uvBreak = vWorld.xz * 0.0461 + vec2( 0.37, 0.71 );
  vec2 uvMid  = vWorld.xz * 0.0045;         // 220 m
  vec2 uvFar  = vWorld.xz * 0.0007;         // 1400 m

  float f0 = texture2D( tFade, uvNear ).r;
  float f1 = texture2D( tFade, uvMid ).r;
  float f2 = texture2D( tFade, uvFar ).r;

  /* uvNear's gradients, taken once and out here in uniform control flow.
   * uvBreak is uvNear * BREAK_RATIO plus a constant: 0.0461 / 0.125. */
  vec4 gNear = vec4( dFdx( uvNear ), dFdy( uvNear ) );

  float h = vWorld.y;
  float alt = clamp( ( h - uWater ) / 150.0, 0.0, 1.0 );

  /* Every layer's *weight* first, and only then any of its texels.
   *
   * This used to read the texture of all six surfaces at every fragment,
   * twice each for the detile -- fifteen anisotropic taps -- and then mix
   * most of them away at a weight of exactly zero: rock and sand and
   * gravel under an open field, all of the grass under the tarmac.  On an
   * Intel HD 630 at 1080p that blend was 23 of the ground's 35 ms (the
   * same triangles in a flat colour cost 9), and the ground was most of
   * the frame: hiding it took the game from 23 frames a second to 80.
   * Sampling only what shows took the whole frame from 44 ms to 27, for
   * an identical picture.
   *
   * The weights below are the same expressions as before, in the same
   * order, so the picture does not change: a layer is skipped only when
   * its weight is exactly zero, or when a layer mixed on top of it has a
   * weight of exactly one -- mix( x, y, 1.0 ) is y whatever x was. */

  // --- the green, which is two greens ---
  float dry = smoothstep( 0.35, 0.85, alt * 0.7 + f1 * 0.5 );

  // --- heather on the tops, ragged at the 220 m scale ---
  float heath = smoothstep( 0.46, 0.62, min( 1.0, h / 165.0 ) * f1 * ( f2 * 0.5 + 0.6 ) );

  /* How far off the road this fragment is, 0 far away, 1 at the tarmac edge.
   *
   * vRoadA and not abs( vRoadU ): the signed offset is interpolated across
   * the triangle, and the off-road sentinel is positive, so an edge running
   * from the *left* of the road out past the query radius crosses zero
   * somewhere in a field -- and everything below would then paint a
   * carriageway there.  vRoadA is the distance to the curve, which cannot.
   * See terrain.js at ROAD_QUERY and chunks.js where it is written.  The
   * signed value is still exactly right for the marking coordinate at the
   * bottom of this function, because that is only read where the mask is
   * open, and there the two agree. */
  /* How far inside a junction mouth this fragment is, 0 outside.  Wanted
   * before the mask, because a bellmouth is *paved*: see below.
   *
   * vRoadJ is signed -- negative where the turning goes off to the left --
   * so the magnitude is the distance and the sign says which edge line is
   * the one a minor road breaks.  See the marking block below, and
   * Junctions.mouthDist for why a sign is safe to interpolate here. */
  float mouth = 1.0 - smoothstep( 9.0, 17.0, abs( vRoadJ ) );

  /* The bellmouth flare, in paint.
   *
   * vRoadA is the distance to the nearer road curve, so on its own a
   * junction is two ribbons crossing at a right angle with grass in the
   * corners -- an elbow, not a turning.  Pulling the distance in across
   * the mouth widens both carriageways into each other exactly where they
   * meet and lets the gravel shoulder flare out around the outside of it,
   * which is the shape a car actually turns through.  It tapers off with
   * the mouth, so nothing changes where nothing is happening. */
  float au = max( 0.0, vRoadA - mouth * 3.4 );
  float prox = 1.0 - clamp( ( au - uCarriageway ) / 7.0, 0.0, 1.0 );

  // --- sediment in the hollows, rock on the ridges ---
  float curvature = clamp( vCurv * 4.0, -1.0, 1.0 );
  float outcrop = clamp( ( -curvature - f2 * 0.55 ) * max( 0.4, f1 ), 0.0, 1.0 );

  // --- rock where it is steep, and where the ground is convex ---
  /* Rock wants to be the exception, not the ground cover.  At a 0.30
   * threshold it climbed the whole hillside above every cutting; bare rock
   * belongs on the cut face and the crags, with grass over everything
   * else. */
  float rocky = max( smoothstep( 0.44, 0.86, vSteep + f0 * 0.14 - 0.07 ), outcrop * 0.34 );
  /* Keep rock off the *flat* ground beside the road -- a verge is soil --
   * but a cut face is the one place rock is most exposed, not least, and
   * suppressing it there took the rock out of every cutting.  So the
   * suppression is gated on the ground being flat as well as near. */
  rocky *= 1.0 - prox * 0.85 * ( 1.0 - smoothstep( 0.18, 0.45, vSteep ) );

  // --- the shore ---
  float shore = smoothstep( uWater + 3.4, uWater - 0.4, h );

  /* --- the shoulder ---
   * A proper band of aggregate outside the tarmac, hard on the inside edge
   * and ragged where it gives out into the grass. */
  float gravel = 1.0 - smoothstep( uShoulder * 0.55, uShoulder * 1.5,
                                   au - uCarriageway + f0 * uShoulder * 0.7 );
  gravel *= step( uCarriageway - 0.4, au );
  gravel = clamp( gravel, 0.0, 1.0 );

  /* The tarmac's weight, from further down, because it covers everything
   * here: the edge is hard, so across nearly all of the carriageway it is
   * exactly one and none of the layers under it are read at all. */
  float edge = au < uCarriageway + 0.35
    ? 1.0 - smoothstep( uCarriageway - 0.15, uCarriageway + 0.30, au ) : 0.0;

  // --- only the layers that show, bottom up ---
  bool hideGravel = edge >= 1.0;
  bool hideSand = hideGravel || gravel >= 1.0;
  bool hideRock = hideSand || shore >= 1.0;
  bool hideHeath = hideRock || rocky >= 1.0;
  bool hideGreen = hideHeath || heath >= 1.0;

  vec3 col = vec3( 0.0 );
  if ( !hideGreen ) {
    vec3 lush = dry < 1.0 ? detile( tGrass, uvNear, uvBreak, f1, gNear ) : vec3( 0.0 );
    vec3 parched = dry > 0.0 ? detile( tGrassDry, uvNear, uvBreak, f1, gNear ) : vec3( 0.0 );
    col = mix( lush, parched, dry );
  }
  if ( !hideHeath && heath > 0.0 ) col = mix( col, detile( tHeather, uvNear, uvBreak, f1, gNear ), heath );
  if ( !hideRock && rocky > 0.0 ) col = mix( col, detile( tRock, uvNear, uvBreak, f1, gNear ), rocky );
  if ( !hideSand && shore > 0.0 ) col = mix( col, detile( tSand, uvNear, uvBreak, f1, gNear ), shore );
  if ( !hideGravel && gravel > 0.0 ) col = mix( col, detile( tGravel, uvNear, uvBreak, f1, gNear ), gravel );

  // a broad, very slow tint so two hillsides are never the same green
  col *= 0.93 + 0.14 * f2;

  /* --- the season -------------------------------------------------- *
   * A tint on the vegetation rather than four sets of textures.  The
   * grass and heather have already been blended above, and what changes
   * with the season is their *colour*, not their pattern -- a hillside
   * in autumn is the same hillside.  Rock, gravel and sand are left
   * alone deliberately: stone does not have a season.
   *
   * The mask is what keeps that true.  It is built from how green the
   * fragment already is, so the tint lands on vegetation and slides off
   * the rock in the same cutting.
   */
  float green = clamp( ( col.g - max( col.r, col.b ) ) * 5.0 + 0.35, 0.0, 1.0 );
  float veg = green * ( 1.0 - rocky * 0.85 ) * ( 1.0 - shore * 0.7 );
  vec3 tint = seasonMix(
    vec3( 1.00, 1.18, 0.92 ),      // spring: light green, not ochre
    vec3( 1.00, 1.00, 1.00 ),      // summer: the palette as it stands
    vec3( 1.34, 1.02, 0.52 ),      // autumn: ochre and rust
    vec3( 0.92, 0.90, 0.86 ) );    // winter: bleached, before any snow
  col *= mix( vec3( 1.0 ), tint, veg );

  /* Spring wildflowers, in the ground as well as in the grass: a sparse
   * speckle of warm white at the 8 m scale, so a spring verge reads as
   * flowering from a distance the individual tufts cannot be seen at. */
  float bloom = uSeason.x * smoothstep( 0.78, 0.94, f0 ) * veg;
  col = mix( col, vec3( 0.95, 0.93, 0.80 ), bloom * 0.75 );

  /* --- snow ---
   *
   * Not a texture swap -- a layer, laid over everything the weather can
   * reach.  Two rules do all the work: snow does not stick to a cliff,
   * and it is ragged at the 220 m scale rather than uniform, because a
   * uniform white hillside is a white hillside and not a snowy one. */
  float lie = smoothstep( 0.62, 0.16, vSteep );
  float snow = uSnow * lie * ( 0.62 + 0.38 * f1 ) * ( 1.0 - shore * 0.85 );
  /* Hollows hold snow and ridges lose it, which is the same curvature
   * term the rock blend is built on, used the other way up. */
  snow *= clamp( 0.75 + curvature * 0.5, 0.0, 1.2 );
  snow = clamp( snow, 0.0, 1.0 );
  vec3 snowCol = vec3( 0.93, 0.95, 0.99 ) * ( 0.94 + 0.06 * f0 );
  col = mix( col, snowCol, snow );

  /* --- wet ---
   * Wet ground is darker and less saturated.  The tarmac gets a good deal
   * more of it than the verge does, below. */
  col *= 1.0 - uWet * 0.18 * ( 1.0 - snow );

  /* --- and the carriageway itself, on top of everything ---
   *
   * Sampled in road coordinates rather than world ones, so the markings
   * follow the curve and keep their pitch through a corner.  The edge is
   * hard on purpose: tarmac ends where it ends, and feathering it into the
   * verge is the one place a soft transition looks wrong. */
  vec2 ruv = vec2( ( vRoadU + uCarriageway ) / ( 2.0 * uCarriageway ),
                   vRoadS / uRoadTile );
  vec2 rdx = dFdx( ruv ), rdy = dFdy( ruv );
  /* The row alone, for the two lateral positions sampled at a fixed u
   * below: a constant column has no gradient across, only along. */
  vec2 rowdx = vec2( 0.0, rdx.y ), rowdy = vec2( 0.0, rdy.y );
  if ( edge > 0.0 ) {
    /* Clamped off the tile's own edges.  A bellmouth widens the paved
     * mask past the carriageway, and a marking coordinate a little
     * outside [0,1] wraps round to the far shoulder line. */
    vec2 muv = vec2( clamp( ruv.x, 0.02, 0.98 ), ruv.y );
    vec3 marked = textureGrad( tRoad, muv, rdx, rdy ).rgb;

    /* Plain tarmac: the same tile read at two lateral positions that are
     * certainly not a marking, rather than a second sampler.  One texel
     * fetch each, and the aggregate matches the marked road by
     * construction.  The tile spans 2 * uCarriageway with the broken
     * centre line at u = 0.5 and the two edge lines at 0.5 +/- 0.33, so
     * 0.5 +/- 0.13 is between them -- and 0.5 itself is the centre line,
     * which would paint a solid white slab across every junction mouth in
     * the world.
     *
     * Two samples averaged and symmetric about the centre, so the
     * wheel-track wear cancels and the grain comes out smoother than a
     * single texel column would.
     *
     * A note for whoever edits this block next: it is GLSL inside a JS
     * template literal, so a backtick anywhere in it -- including around
     * an identifier in a comment, which is this repository's house style
     * -- ends the string and the build fails somewhere else entirely. */
    vec3 bare = 0.5 * ( textureGrad( tRoad, vec2( 0.63, ruv.y ), rowdx, rowdy ).rgb
                      + textureGrad( tRoad, vec2( 0.37, ruv.y ), rowdx, rowdy ).rgb );

    /* --- which of the two this fragment gets ---
     *
     * vRoadU is the main road's frame, so the marked tile is only
     * meaningful where the fragment is actually on the main carriageway.
     * Everywhere else that is paved -- the bellmouth flare, and every
     * metre of every spur -- is plain tarmac, with the surface below
     * deciding what happens to it next.
     *
     * The ramp is deliberately the same pair of numbers as the edge blend
     * that "edge" is built from.  Off the road with no turning nearby the
     * two arguments are the same quantity, so wherever this fades the
     * marked tile out the whole carriageway is fading out with it and the
     * difference cannot be seen.  Near a mouth they differ, which is
     * exactly the case this exists for. */
    float onMain = 1.0 - smoothstep( uCarriageway - 0.15, uCarriageway + 0.30,
                                     abs( vRoadU ) );
    vec3 tar = mix( bare, marked, onMain );

    /* --- the markings, and where a real junction breaks them ---
     *
     * The centre line runs straight through a T-junction and the *edge*
     * line is broken across the mouth, on the side the minor road joins
     * and only there.  That is what this draws, and it is worth saying
     * why it is only three lines.
     *
     * vRoadU is the main road's lateral offset everywhere -- see
     * Terrain.roadPaint -- so nothing near a mouth has a marking
     * coordinate that differs from the one it would have had with no
     * turning there at all.  There is no frame to flip, so there is
     * nothing to suppress, so the centre line simply continues.  What is
     * left is the edge line, and breaking it is a positive act rather
     * than damage control.
     *
     * edgeBand is the two outer marking columns of the tile;
     * sameSide is true where this fragment is on the same side of the
     * road as the mouth, which is what vRoadJ carries its sign for. */
    float edgeBand = smoothstep( 0.22, 0.28, abs( muv.x - 0.5 ) );
    float sameSide = step( 0.0, vRoadU * vRoadJ );
    tar = mix( tar, bare, mouth * edgeBand * sameSide );

    /* --- and a side road is not this road ---
     *
     * vRoadK is 0 on the main carriageway and on every bellmouth, and
     * rises to one of KIND once a spur is clear of its apron -- so this
     * is the only place that knows there is such a thing as a minor road,
     * and it cannot affect the main one:
     *
     *   1  sealed   the same tarmac, with no markings on it
     *   2  gravel   pale, loose, no shoulder line
     *   3  dirt     browner, with wheel ruts
     *
     * Gravel and dirt are one tile under two tints.  A second and third
     * texture would have been two more samplers on a shader that already
     * takes eight, for a difference between two unsealed surfaces that is
     * mostly colour anyway.  World-space UV, because there are no
     * markings to keep in register and a longitudinal coordinate would
     * have been another vertex attribute to carry. */
    if ( vRoadK > 0.001 ) {
      /* --- tarmac off the main road needs a coordinate of its own ---
       *
       * ruv.y is vRoadS, which is the *main* road's arc position and is
       * zero wherever the main road is out of reach -- which is most of
       * the length of most spurs.  Sampling the tile at a constant row
       * gives a side road one texel-row of grain stretched down its whole
       * length, and worse, the row is interpolated from a real value at
       * the mouth to zero further out, so the aggregate smears.
       *
       * A world-space coordinate along an arbitrary direction fixes it
       * and costs nothing: the tile's grain is noise in this axis, so
       * what the diagonal is does not matter, only that it is continuous
       * and does not repeat with anything else. */
      float wy = ( vWorld.x * 0.6 + vWorld.z * 0.8 ) / uRoadTile;
      vec2 wdx = vec2( 0.0, dFdx( wy ) ), wdy = vec2( 0.0, dFdy( wy ) );
      vec3 bareT = 0.5 * ( textureGrad( tRoad, vec2( 0.63, wy ), wdx, wdy ).rgb
                         + textureGrad( tRoad, vec2( 0.37, wy ), wdx, wdy ).rgb );
      vec3 track = detile( tTrack, uvNear, uvBreak, f1, gNear );
      vec3 gravelCol = track * vec3( 1.02, 1.01, 0.98 );
      vec3 dirtCol   = track * vec3( 1.12, 0.86, 0.62 );
      /* Ruts: two darker bands where the wheels go, in road coordinates
       * across but world coordinates along, so they follow the spur
       * without needing to know where along it we are. */
      float rut = 1.0 - 0.14 * ( 1.0 - smoothstep( 0.0, 1.1, abs( abs( vRoadU ) - 1.5 ) ) );
      dirtCol *= rut;
      gravelCol *= mix( 1.0, rut, 0.5 );

      vec3 unpaved = mix( gravelCol, dirtCol,
                          clamp( vRoadK - 2.0, 0.0, 1.0 ) );
      /* 1 -> bare tarmac, 2 -> gravel, 3 -> dirt, and smoothly between,
       * which is what the attribute's ramp out of the apron reads as. */
      vec3 kindCol = mix( bareT, unpaved, clamp( vRoadK - 1.0, 0.0, 1.0 ) );
      tar = mix( tar, kindCol, clamp( vRoadK, 0.0, 1.0 ) );
    }

    /* A road that is driven is a road that is cleared.  The carriageway
     * takes a *fraction* of the snow the ground beside it does, and what
     * it does take gathers toward the edges rather than lying evenly --
     * so tarmac shows through with white verges, which is both what
     * winter looks like from a car and what keeps the road legible. */
    float across = clamp( au / uCarriageway, 0.0, 1.0 );
    float ploughed = uSnow * ( 0.10 + 0.62 * pow( across, 2.2 ) ) * ( 0.7 + 0.3 * f0 );
    tar = mix( tar, snowCol, clamp( ploughed, 0.0, 0.85 ) );

    /* Wet tarmac is much darker than wet grass, and it is the difference
     * that reads as rain -- a road that does not change colour in a
     * downpour is a road with weather happening near it. */
    tar *= 1.0 - uWet * 0.34;

    col = mix( col, tar, edge );
  }

  diffuseColor.rgb *= col;
`;

export function groundMaterial() {
  /* The ground goes through the same switch as everything else: a toon
   * material under the cel pass, a standard one under `?flat`.  Only the
   * *lighting* changes -- the whole blend above, which is the interesting
   * half, is identical either way, because it decides what colour a square
   * metre is and not how it is lit. */
  const mat = CEL
    ? new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradientMap(3) })
    : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const uniforms = {
    tGrass: { value: TEX.grass() },
    tGrassDry: { value: TEX.grassDry() },
    tHeather: { value: TEX.heather() },
    tRock: { value: TEX.rock() },
    tGravel: { value: TEX.gravel() },
    tSand: { value: TEX.sand() },
    tFade: { value: TEX.fade() },
    tRoad: { value: roadTexture(2 * CARRIAGEWAY) },
    /** Gravel and dirt side roads, tinted apart in the shader. */
    tTrack: { value: TEX.track() },
    uWater: { value: 2 },
    uCarriageway: { value: CARRIAGEWAY },
    uShoulder: { value: SHOULDER },
    uRoadTile: { value: ROAD_TILE_LENGTH },
    /* The season block, shared by reference with the grass, the trees and
     * the furniture -- one write in `main.js` re-dresses all four. */
    ...SEASON_UNIFORMS,
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <project_vertex>', VERT_BODY + '\n#include <project_vertex>');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS + DETILE)
      .replace('#include <map_fragment>', FRAG_BODY);
  };
  mat.customProgramCacheKey = () => 'ground' + (CEL ? '_cel' : '');
  if (CEL) shadowTint(mat, 0x585d75);
  /* And the cloud shadow, which is the one moving light gradient in a
   * world whose direct term is quantised into three flat bands.  One
   * material instance serves every chunk, so this costs one patch. */
  patchClouds(mat, 'ground');
  return mat;
}
