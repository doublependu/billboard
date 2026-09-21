import * as THREE from 'three';
import { cel } from '../core/toon.js';
import { patchClouds } from '../world/cloudfield.js';
import { GATE_R } from './junctions.js';

/* ------------------------------------------------------------------ *
 * The gate at the end of a side road.
 *
 * `prompt_18.md` item 3: *create a mysterious portal at the end of each
 * side road, driving through it takes the player to the link.*
 *
 * This is a small file with one large consequence, which is that a spur
 * stops being a trigger and becomes a place.  `plan_17.md` built the side
 * road as a stub whose only job was to be entered -- the link fired
 * twenty-two metres in, nothing stood at the far end, and no player ever
 * saw more of one than the first two seconds.  Everything that has been
 * added to `junctions.js` this iteration (a curvature profile, a spline
 * through the node heights, a surface, a length that varies) is here
 * because of this object: it puts something at the end of the road worth
 * driving to, and the road then has to be worth driving.
 *
 * **Three meshes and no collider.**  A ring, a membrane inside it, and a
 * glow card behind.  You drive *through* it, so a physics body would be a
 * wall across the one thing the player is being invited to do -- and
 * `physics.syncPosts` is deliberately not told about these.
 *
 * **The membrane is a shader and not a texture.**  What it has to convey
 * is that the space inside the ring is not the space around it, and a
 * still image inside a ring reads as a poster on a frame.  Domain-warped
 * noise turning about the centre, a rim that brightens at grazing angles,
 * and a colour that belongs to the junction rather than to the game --
 * see `tint`.
 *
 * Lifetime is `Signs`': built when the arc window reaches the junction's
 * mouth, dropped behind the car, rebuilt on the way back.  A portal is
 * cheap enough that this could be skipped and wrong enough to skip -- a
 * drive is hours long and the list of billboards is not.
 * ------------------------------------------------------------------ */

/**
 * Clear radius of the gate.
 *
 * **Imported rather than chosen**, because `Junctions.crossedGate` tests
 * a car's path against this same number: the hole you can see and the
 * hole that fires the link are one value, and cannot drift apart.
 */
const RING_R = GATE_R;
const RING_T = 0.34;
/** How high the bottom of the ring floats over the road surface. */
const LIFT = 0.15;

/**
 * The colours a gate can be.
 *
 * Keyed off the billboard id so a player who has been through one
 * recognises it on the way back, and so the home portal -- item 6's way
 * back to the previous page -- is visibly not one of the others.  Amber
 * for that one, and the cool end of the spectrum for the links, which is
 * the same division road signs make between "you came from here" and
 * "you are going there".
 */
const TINTS = [0xffb347, 0x7fd4ff, 0x9d8cff, 0x5ff0c8, 0xff8ad2, 0xa8e05f];

function tint(j) {
  if (j.billboard.back) return new THREE.Color(TINTS[0]);
  return new THREE.Color(TINTS[1 + (j.billboard.id % (TINTS.length - 1))]);
}

const MEMBRANE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

/* GLSL in a template literal: no backticks anywhere below, not even
 * around an identifier in a comment.  One ends the string and the build
 * fails somewhere else entirely -- groundmat.js carries the same warning
 * for the same reason, and so do the probes. */
const MEMBRANE_FRAG = /* glsl */ `
  uniform float uTime, uOpen, uCold;
  uniform vec3 uTint;
  varying vec2 vUv;

  float hash( vec2 p ) {
    return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
  }
  float noise( vec2 p ) {
    vec2 i = floor( p ), f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), f.x ),
                mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), f.x ),
                f.y );
  }
  float fbm( vec2 p ) {
    float v = 0.0, a = 0.5;
    for ( int i = 0; i < 4; i++ ) { v += a * noise( p ); p *= 2.03; a *= 0.5; }
    return v;
  }

  void main() {
    /* Polar, about the middle of the disc: what is wanted is something
     * turning, and something turning in Cartesian noise is a smear. */
    vec2 d = vUv * 2.0 - 1.0;
    float r = length( d );
    if ( r > 1.0 ) discard;
    float ang = atan( d.y, d.x );

    /* Domain warp: the noise is sampled at a position the noise itself
     * moved, which is what stops it reading as clouds on a disc. */
    vec2 q = vec2( ang * 1.6 + uTime * 0.22, r * 3.0 - uTime * 0.6 );
    float w = fbm( q + fbm( q * 1.7 + uTime * 0.1 ) * 1.4 );

    /* Brighter toward the middle, so the disc has depth in it rather than
     * being a flat swirl, and a hard bright rim where it meets the ring. */
    float core = smoothstep( 0.95, 0.1, r );
    float rim = smoothstep( 0.72, 1.0, r );

    vec3 col = uTint * ( 0.35 + 1.5 * w * core );
    col += uTint * rim * 1.4;
    col = mix( col, vec3( 1.0 ), core * w * 0.35 );

    /* Cold: a gate with nowhere to go back to.  Item 6 again -- a portal
     * that sometimes does nothing has to look like it. */
    col = mix( col, vec3( dot( col, vec3( 0.33 ) ) ) * 0.5, uCold );

    float a = uOpen * ( 0.22 + 0.78 * ( core * ( 0.35 + w ) + rim ) );
    gl_FragColor = vec4( col, clamp( a, 0.0, 1.0 ) );
  }
`;

export class Portals {
  constructor(scene, terrain, junctions) {
    this.scene = scene;
    this.T = terrain;
    this.junctions = junctions;
    this.live = new Map();
    this.time = 0;

    this.ringGeo = new THREE.TorusGeometry(RING_R, RING_T, 8, 40);
    this.discGeo = new THREE.CircleGeometry(RING_R, 40);
    this.glowGeo = new THREE.PlaneGeometry(RING_R * 4.2, RING_R * 4.2);

    /* One glow texture for every gate: a radial falloff, tinted per
     * portal by the material's colour rather than by a second canvas. */
    this.glowTex = glowTexture();
  }

  /** Build every portal whose mouth is in `[s0, s1]`, drop the rest. */
  update(s0, s1, dt = 0) {
    this.time += dt;
    const want = new Set();
    for (const j of this.junctions.mouthsInRange(s0, s1)) {
      want.add(j.billboard.id);
      if (!this.live.has(j.billboard.id)) this._build(j);
    }
    for (const [id, e] of this.live) {
      if (want.has(id)) continue;
      this.scene.remove(e.group);
      e.mats.forEach((m) => m.dispose());
      this.live.delete(id);
    }
    for (const e of this.live.values()) {
      e.membrane.uniforms.uTime.value = this.time;
    }
  }

  /**
   * Where a portal is in the world, for the warp's camera work and for
   * the probes.  Null if that junction has no gate standing.
   */
  centre(j) {
    const e = this.live.get(j.billboard.id);
    return e ? e.centre : null;
  }

  /**
   * Say whether a gate leads anywhere.  A cold one is drawn grey and
   * still, and `depart.js` will not fire it -- see `Depart.navigate`,
   * where the history test lives.
   */
  setCold(j, cold) {
    const e = this.live.get(j.billboard.id);
    if (e) e.membrane.uniforms.uCold.value = cold ? 1 : 0;
  }

  _build(j) {
    const group = new THREE.Group();
    const p = j.pointAt(j.portalA, {});
    /* The road's own surface height at the gate, from the junction's
     * frozen nodes rather than from a fresh `heightAt` -- the rule this
     * repository has held since `plan_4`: a thing is built from the
     * numbers the thing under it was built from. */
    const y = p.y + LIFT;
    const col = tint(j);

    /* Square across the road, which is what the last twelve metres of
     * `_spur`'s heading profile are straight for. */
    const face = Math.atan2(p.tz, p.tx);

    const matRing = cel({
      color: 0x2a2f3a, roughness: 0.5, metalness: 0.6, flat: true, cache: false,
    });
    matRing.emissive = col.clone().multiplyScalar(0.35);
    patchClouds(matRing, 'portalring');
    const ring = new THREE.Mesh(this.ringGeo, matRing);
    ring.position.set(p.x, y + RING_R, p.z);
    ring.rotation.y = -face + Math.PI / 2;
    ring.castShadow = true;
    ring.matrixAutoUpdate = false;
    ring.updateMatrix();
    group.add(ring);

    const membrane = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpen: { value: 1 },
        uCold: { value: 0 },
        uTint: { value: col.clone() },
      },
      vertexShader: MEMBRANE_VERT,
      fragmentShader: MEMBRANE_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: true,
    });
    const disc = new THREE.Mesh(this.discGeo, membrane);
    disc.position.copy(ring.position);
    disc.rotation.y = -face + Math.PI / 2;
    disc.matrixAutoUpdate = false;
    disc.updateMatrix();
    group.add(disc);

    /* The glow, so the gate is findable from the main road at dusk and
     * unmistakable at night.  Additive, unlit, and behind the ring. */
    const matGlow = new THREE.MeshBasicMaterial({
      map: this.glowTex,
      color: col.clone(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
    });
    const glow = new THREE.Mesh(this.glowGeo, matGlow);
    glow.position.set(
      p.x - Math.cos(face) * 0.35,
      y + RING_R,
      p.z - Math.sin(face) * 0.35,
    );
    glow.rotation.y = -face + Math.PI / 2;
    glow.renderOrder = -1;
    glow.matrixAutoUpdate = false;
    glow.updateMatrix();
    group.add(glow);

    group.matrixAutoUpdate = false;
    this.scene.add(group);
    this.live.set(j.billboard.id, {
      group,
      membrane,
      mats: [matRing, membrane, matGlow],
      centre: new THREE.Vector3(p.x, y + RING_R, p.z),
    });
  }
}

/** A soft radial falloff, drawn once and shared by every gate. */
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.28, 'rgba(255,255,255,0.30)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
