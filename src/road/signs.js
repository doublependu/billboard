import * as THREE from 'three';
import { cel, flat } from '../core/toon.js';
import { PAL } from '../core/palette.js';
import { assetUrl } from '../core/assets.js';
import { patchSeason } from '../world/season.js';
import { patchClouds } from '../world/cloudfield.js';

/* ------------------------------------------------------------------ *
 * The billboards.
 *
 * Two posts and a face, standing `SIGN_LEAD` before the turning it
 * announces and on the same side of the road as that turning -- which
 * `prompt_17.md` asks for explicitly and which is also the only
 * arrangement where the two read as one thing rather than as a poster and
 * an unrelated track.
 *
 * **The face is one composited canvas**, not a picture with a text mesh
 * in front of it.  The prompt wants the image, the name, and `NEXT LEFT`
 * or `NEXT RIGHT` at the bottom; drawn together into a single texture
 * they are one material, one draw call, and a caption that cannot drift
 * out of register with the picture it belongs to.  The alternative is
 * three meshes whose alignment has to be maintained at every distance the
 * panel is seen from.
 *
 * Lifetime is `Furniture`'s: built when the arc window reaches them,
 * disposed behind the car, and rebuilt on the way back.  So the composed
 * face is cached and not repeated -- a player driving up and down the
 * same mile would otherwise recompose the same 2048 x 816 canvas every
 * few seconds.  See `faces` for what the cache is keyed on and why it is
 * no longer allowed to keep everything.
 * ------------------------------------------------------------------ */

/** The panel, in metres.  The picture is 32:9, which is the shape the
 *  list asks its images to be; the caption band goes under it. */
const PANEL_W = 12.8;
const PIC_H = PANEL_W * 9 / 32;          // 3.6
const CAP_H = 1.5;
const PANEL_H = PIC_H + CAP_H;
/** Bottom of the panel above the ground at the posts. */
const PANEL_Y = 4.2;
const FRAME = 0.16;

/** The composed texture.  2048 across is the panel at about 6 px/cm at
 *  the distance it is read from, and one mip level down from the source. */
const TEX_W = 2048;
const PIC_PX = Math.round(TEX_W * PIC_H / PANEL_W);
const CAP_PX = Math.round(TEX_W * CAP_H / PANEL_W);

/**
 * Composed faces, by billboard id **and side**, least recently used first.
 *
 * The side is in the key because it is in the picture: `NEXT LEFT` or
 * `NEXT RIGHT` is drawn into the texture.  While every billboard stood
 * exactly once that was the same thing as the id.  Since the list loops
 * (`prompt_4.md` item 4) the same billboard comes round again, often on
 * the other side of the road, and a face cached by id alone pointed the
 * player the wrong way.
 *
 * And it is bounded.  It said "never evicted" when there were three
 * billboards; one face is 2048 x 816 RGBA with its mips, about 8.9 MB of
 * GPU memory, and ten billboards on two sides is twenty of them kept for
 * the whole visit -- 180 MB, on a phone.  Signs are at least 457 m apart
 * and a face is built about 300 m out, so no more than two are ever on
 * the road at once; `FACE_CAP` keeps a couple more so the one just passed
 * survives a U-turn.  An evicted face costs, next time, one fetch from the
 * HTTP cache, one decode and one canvas draw, all of it three hundred
 * metres before anyone can read the result.
 */
const faces = new Map();
const FACE_CAP = 4;

function faceKey(billboard, side) { return billboard.id + ':' + (side < 0 ? 'L' : 'R'); }

/**
 * Drop the least recently used faces past `FACE_CAP`, never one a live
 * sign is showing and never one still waiting on its image -- that entry
 * has callbacks queued against materials that are on screen.
 */
function trimFaces(inUse) {
  let over = faces.size - FACE_CAP;
  for (const [k, e] of faces) {
    if (over <= 0) break;
    if (inUse.has(k) || !e.tex) continue;
    e.tex.dispose();
    faces.delete(k);
    over--;
  }
}

/**
 * Draw the picture, the name and the direction into one canvas.
 *
 * The picture is *letterboxed* into its band rather than stretched, so a
 * list entry whose image is not 32:9 comes out smaller and never
 * distorted -- which is the failure mode a person adding a row to
 * `billboards.js` will actually hit.
 */
function compose(billboard, img, side) {
  const c = document.createElement('canvas');
  c.width = TEX_W;
  c.height = PIC_PX + CAP_PX;
  const g = c.getContext('2d');

  // --- the picture ---
  g.fillStyle = '#0b0d12';
  g.fillRect(0, 0, TEX_W, PIC_PX);
  if (img) {
    const sc = Math.min(TEX_W / img.width, PIC_PX / img.height);
    const w = img.width * sc, h = img.height * sc;
    g.drawImage(img, (TEX_W - w) / 2, (PIC_PX - h) / 2, w, h);
  }

  // --- the caption band ---
  const ink = '#' + PAL.ink.toString(16).padStart(6, '0');
  const cream = '#' + PAL.lineWhite.toString(16).padStart(6, '0');
  g.fillStyle = ink;
  g.fillRect(0, PIC_PX, TEX_W, CAP_PX);
  /* A hairline of the marking cream between picture and caption.  It is
   * two texels and it is what stops the band reading as a black bar
   * someone forgot to fill in. */
  g.fillStyle = cream;
  g.fillRect(0, PIC_PX, TEX_W, 3);

  const pad = CAP_PX * 0.26;
  const baseline = PIC_PX + CAP_PX * 0.70;

  // --- "NEXT LEFT" / "NEXT RIGHT", on the right, in the road's own cream
  const dir = side < 0 ? 'NEXT LEFT' : 'NEXT RIGHT';
  const dirSize = Math.round(CAP_PX * 0.36);
  g.font = `600 ${dirSize}px system-ui, "Segoe UI", Helvetica, Arial, sans-serif`;
  g.textAlign = 'right';
  g.textBaseline = 'alphabetic';
  g.fillStyle = cream;
  g.fillText(dir, TEX_W - pad, baseline);
  const dirW = g.measureText(dir).width;

  /* --- the name, on the left, fitted ---
   *
   * Measured and shrunk rather than trusted.  `Man & Bot` fits at any
   * size; `Central Park Paintball` is already three words and the fourth
   * entry in that list will be somebody's four-word product name, and a
   * caption that overruns its band is a caption that runs under the
   * direction text and out of the panel. */
  const avail = TEX_W - pad * 2 - dirW - pad;
  let size = Math.round(CAP_PX * 0.56);
  g.textAlign = 'left';
  for (; size > 12; size -= 2) {
    g.font = `700 ${size}px system-ui, "Segoe UI", Helvetica, Arial, sans-serif`;
    if (g.measureText(billboard.name).width <= avail) break;
  }
  g.fillStyle = '#ffffff';
  g.fillText(billboard.name, pad, baseline);

  const tex = new THREE.CanvasTexture(c);
  /* The picture is a photograph and the canvas is in sRGB.  Without this
   * it is decoded as linear and the face comes out washed out and pale,
   * which on a dark image is most of the picture gone. */
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/**
 * The face for a billboard, composed once.
 *
 * Returns immediately with a placeholder -- the caption band alone, which
 * is already the name and the direction -- and swaps the picture in when
 * the decode lands.  A sign that pops into existence 300 m ahead cannot
 * wait on a network fetch, and a panel that is blank until it does is a
 * blank panel for the first second of every approach.
 */
function faceFor(billboard, side, onReady) {
  const key = faceKey(billboard, side);
  let e = faces.get(key);
  if (e) {
    /* Most recently used goes to the back of the map, which is the end
     * `trimFaces` reaches last. */
    faces.delete(key);
    faces.set(key, e);
    if (e.tex) onReady(e.tex);
    /* Still decoding.  Join the queue rather than dropping the callback:
     * a sign is built and disposed every time the player passes it, so
     * the second build of the same billboard can easily begin before the
     * first one's image has landed -- and a dropped callback is a panel
     * that stays a caption band for as long as it is on screen. */
    else e.waiting.push(onReady);
    /* **The composed face first, and the placeholder only if there is no
     * composed face yet.**  It read `e.placeholder || e.tex`, and the
     * placeholder was never cleared then -- so the *second* time a billboard
     * was built, the callback above set the real picture and then the
     * caller overwrote it with the caption-only placeholder on the very
     * next line.  Every sign the player drove back to was a black panel
     * with a name on it, for ever. */
    return e.tex || e.placeholder;
  }

  e = { tex: null, placeholder: compose(billboard, null, side), waiting: [onReady] };
  faces.set(key, e);

  const img = new Image();
  /* Same-origin, so no CORS dance; `assetUrl` for the reason spelled out
   * in `core/assets.js` -- a bare relative path resolves against the
   * document and breaks the moment the app is served from a subdirectory. */
  img.onload = () => {
    e.tex = compose(billboard, img, side);
    for (const cb of e.waiting) cb(e.tex);
    e.waiting.length = 0;
    /* Everything that was showing the placeholder has just been handed
     * the picture, so the placeholder is a second 2048 x 816 canvas that
     * nothing can see.  Let it go. */
    e.placeholder.dispose();
    e.placeholder = null;
  };
  img.onerror = () => {
    /* A missing image is a real thing that will happen to whoever edits
     * `billboards.js` next, and the useful failure is a sign with the
     * name on it and a black picture -- which the placeholder already is
     * -- plus one line in the console saying which file. */
    console.warn(`billboard ${billboard.id}: no image at ${billboard.image}`);
    e.tex = e.placeholder;
    /* And the queue is still answered.  Everyone in it is already showing
     * this very texture, so nothing changes on screen -- but a callback
     * that is never called is a callback holding a reference to a
     * material that was disposed three signs ago. */
    for (const cb of e.waiting) cb(e.tex);
    e.waiting.length = 0;
  };
  img.src = assetUrl(billboard.image);
  return e.placeholder;
}

/* --------------------------- the fingerpost ---------------------------- *
 *
 * `prompt_18.md` item 6: *make it obvious which way of the main road is
 * the right direction* -- and `prompt_19.md` item 2, which puts one at
 * every T-junction rather than only at the one the drive starts on.
 *
 * Directly across the main road from the mouth, facing back across it,
 * so it is the thing in the middle of the windscreen when a car comes up
 * a side road to the give-way line.  A board with an arrow on it, and the
 * arrow points up the road.
 *
 * Both directions of this road are real -- `prompt_5.md` gave it a
 * backward half and the tracer will happily build it for ever -- so this
 * is not a fence.  It is the difference between a junction with no
 * information at it and a junction with a sign, which is the difference
 * between guessing and choosing.
 */
const POST_W = 3.6;
const POST_H = 1.3;
/** Where it stands is decided at siting -- see `post` in `junctions.js`
 *  `_build`, and `POST_FAR` there. */
const POST_Y = 2.3;

/**
 * The board's face: a word and an arrow.
 *
 * `flip` draws the arrow the other way.  Which way it has to point is not
 * a property of the sign, it is a property of where the board ended up --
 * see `_fingerpost`, where the board's own local axis is compared against
 * the road's tangent.  Drawing it wrong is a sign that lies, which is
 * worse than no sign.
 */
function fingerFace(flip) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = Math.round(1024 * POST_H / POST_W);
  const g = c.getContext('2d');
  const ink = '#' + PAL.ink.toString(16).padStart(6, '0');
  const cream = '#' + PAL.lineWhite.toString(16).padStart(6, '0');

  g.fillStyle = ink;
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = cream;
  g.lineWidth = 8;
  g.strokeRect(14, 14, c.width - 28, c.height - 28);

  /* --- the word ---
   *
   * Laid out by hand rather than by the mirror below.  Reflecting the
   * whole canvas is the cheap way to move the arrow to the other end of
   * the board *and* turn it round, and for a shape that is exactly what
   * is wanted -- but it reverses the glyphs with it, and a fingerpost
   * reading `SDRAOBLLIB` is the one thing worse than one pointing the
   * wrong way.  So the word is drawn in the unmirrored frame, at the
   * place the mirror would have put it: hard against the end the arrow
   * is not at.
   */
  g.fillStyle = cream;
  g.font = '700 96px system-ui, "Segoe UI", Helvetica, Arial, sans-serif';
  g.textBaseline = 'middle';
  g.textAlign = flip ? 'right' : 'left';
  g.fillText('BILLBOARDS', flip ? c.width - 70 : 70, c.height * 0.5);

  g.save();
  if (flip) { g.translate(c.width, 0); g.scale(-1, 1); }

  /* The arrow, drawn rather than typed: a glyph arrow is whatever weight
   * the fallback font feels like and this one has to read at sixty
   * metres. */
  const y = c.height * 0.5;
  const x0 = c.width - 280, x1 = c.width - 80;
  g.strokeStyle = cream;
  g.lineWidth = 26;
  g.lineCap = 'butt';
  g.beginPath();
  g.moveTo(x0, y);
  g.lineTo(x1 - 60, y);
  g.stroke();
  g.beginPath();
  g.moveTo(x1, y);
  g.lineTo(x1 - 78, y - 62);
  g.lineTo(x1 - 78, y + 62);
  g.closePath();
  g.fill();
  g.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * The two possible fingerpost faces, composed at most once each.
 *
 * The home sign is rebuilt every time the arc window comes back round to
 * it, and a texture built per build is a texture leaked per build --
 * `Material.dispose` does not touch the map.  Two for the life of the
 * page, exactly as `faces` holds one per billboard.
 */
const fingerTex = [null, null];
function fingerFaceFor(flip) {
  const i = flip ? 1 : 0;
  if (!fingerTex[i]) fingerTex[i] = fingerFace(flip);
  return fingerTex[i];
}

export class Signs {
  constructor(scene, terrain, junctions) {
    this.scene = scene;
    this.T = terrain;
    this.junctions = junctions;
    this.live = new Map();

    /* Frame, posts and the back of the panel: one material, the same
     * weathered grey the guardrail posts use.  `cache: false` because it
     * is patched below and `toon.js` keys its cache on the constructor
     * arguments. */
    this.matFrame = cel({
      color: 0x6f747a, roughness: 0.7, metalness: 0.25, flat: true, cache: false,
    });
    patchClouds(this.matFrame, 'sign');
    patchSeason(this.matFrame, {
      fragment: `
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.94, 0.96, 1.0 ),
                                uSnow * 0.4 );
        diffuseColor.rgb *= 1.0 - uWet * 0.12;`,
    });

    this.fingerGeo = new THREE.PlaneGeometry(POST_W, POST_H);
    this.fingerFrame = new THREE.BoxGeometry(POST_W + 0.12, POST_H + 0.12, 0.14);
    this.postGeo = new THREE.CylinderGeometry(0.15, 0.18, 1, 8);
    this.postGeo.translate(0, 0.5, 0);
    this.panelGeo = new THREE.PlaneGeometry(PANEL_W, PANEL_H);
    this.frameGeo = new THREE.BoxGeometry(PANEL_W + FRAME * 2, PANEL_H + FRAME * 2, 0.22);

    /** Faces, so the night lighting can be set on all of them at once. */
    this.faceMats = [];
  }

  /**
   * Build every sign whose arc position is in `[s0, s1]`, drop the rest.
   *
   * The same shape as `Furniture.update` and for the same reason: what is
   * on screen is decided by where the car is on the road, not by a
   * distance in the plane, so a sign three hundred metres away round a
   * hairpin is not built.
   */
  update(s0, s1) {
    /* Two kinds of thing, keyed apart: since `prompt_19.md` item 2 a
     * junction has a billboard *and* a fingerpost, and they stand in
     * different places along the road so they come into range at
     * different times. */
    /* Keyed by the *turning*, `j.n`, and not by the billboard on it:
     * since the list loops, two turnings can carry the same billboard,
     * and with a short enough list both are in the window at once. */
    const want = new Set();
    for (const j of this.junctions.inRange(s0, s1)) {
      const k = 'face:' + j.n;
      want.add(k);
      if (!this.live.has(k)) this._build(j, k);
    }
    for (const j of this.junctions.postsInRange(s0, s1)) {
      const k = 'post:' + j.n;
      want.add(k);
      if (!this.live.has(k)) this._fingerpost(j, k);
    }
    for (const [id, e] of this.live) {
      if (want.has(id)) continue;
      this.scene.remove(e.group);
      /* The face texture is *not* disposed here: it is cached in
       * `faces`, shared with the next build, and `trimFaces` below is
       * what decides when it goes. */
      e.mat.dispose();
      this.faceMats = this.faceMats.filter((m) => m !== e.mat);
      this.live.delete(id);
    }
    if (faces.size > FACE_CAP) {
      const inUse = new Set();
      for (const e of this.live.values()) if (e.face) inUse.add(e.face);
      trimFaces(inUse);
    }
  }

  _build(j, key) {
    const group = new THREE.Group();
    const s = j.sign;
    const ground = this.T.heightAt(s.x, s.z);

    /* Two posts, set in from the panel's edges, running from the ground
     * to a third of the way up the panel -- a billboard is braced behind,
     * not held at its corners. */
    const spread = PANEL_W * 0.31;
    const top = ground + PANEL_Y + PANEL_H * 0.45;
    const posts = [];
    for (const o of [-spread, spread]) {
      const px = s.x + Math.cos(s.a + Math.PI / 2) * o;
      const pz = s.z + Math.sin(s.a + Math.PI / 2) * o;
      /* Each post from its *own* ground, so a panel on a cross-slope
       * stands level while its legs are different lengths -- which is
       * what a real one does and what stops a sign hovering. */
      const gy = this.T.heightAt(px, pz);
      const post = new THREE.Mesh(this.postGeo, this.matFrame);
      post.position.set(px, gy - 0.4, pz);
      post.scale.y = top - gy + 0.4;
      post.castShadow = true;
      post.matrixAutoUpdate = false;
      post.updateMatrix();
      group.add(post);
      /* The ground height goes with it.  `physics.syncPosts` must not
       * re-derive it -- the rule this repository has held since `plan_4`
       * is that a collider is built from the numbers the mesh was built
       * from, never from a fresh `heightAt`. */
      posts.push({ x: px, z: pz, y: gy, r: 0.18, h: PANEL_Y });
    }

    const cy = ground + PANEL_Y + PANEL_H / 2;

    const frame = new THREE.Mesh(this.frameGeo, this.matFrame);
    frame.position.set(s.x, cy, s.z);
    frame.rotation.y = -s.a + Math.PI / 2;
    frame.castShadow = true;
    frame.matrixAutoUpdate = false;
    frame.updateMatrix();
    group.add(frame);

    /**
     * The face, and why it is the one thing in this world that is not
     * cel-shaded.
     *
     * It was `cel()` with an emissive map that came up after dusk, on the
     * reasoning that a flat panel has one `N.L` across the whole of it,
     * so the toon ramp quantises the *lighting* and not the picture.
     * True, and beside the point: that one value is the value for a
     * **vertical sheet facing back down the road**, which is almost never
     * the direction the sun is in.  Measured at 11:00 in open sunshine,
     * white in the texture came back off the panel at 182/255 and the
     * caption band at 67 -- a picture at seven tenths of the brightness it
     * was authored at, with its darks lifted by the grade's shadow tint
     * on top.  Dark artwork, which is most websites, was unreadable, and
     * the daylight panel was *dimmer* than the same panel at midnight.
     *
     * A billboard face is not a surface the weather happens to fall on.
     * It is a printed sheet with its own floodlights on it, and the whole
     * reason it is standing there is to be read from a moving car.  So it
     * is drawn unlit, at the brightness the image was authored at, and
     * `setLight` takes a little off it after dark rather than adding it
     * all back.  The frame and the posts stay cel-shaded, so the object
     * still sits in the landscape -- it is the *paper* that is exempt.
     *
     * No `patchClouds` for the same reason: a cloud shadow multiplies
     * direct light, and there is none here.
     */
    const mat = flat({ color: 0xffffff, cache: false });
    mat.map = faceFor(j.billboard, s.side, (tex) => {
      mat.map = tex;
      mat.needsUpdate = true;
    });
    this.faceMats.push(mat);

    const panel = new THREE.Mesh(this.panelGeo, mat);
    panel.position.set(
      s.x + Math.cos(s.a) * 0.13,
      cy,
      s.z + Math.sin(s.a) * 0.13,
    );
    panel.rotation.y = -s.a + Math.PI / 2;
    panel.matrixAutoUpdate = false;
    panel.updateMatrix();
    group.add(panel);

    group.matrixAutoUpdate = false;
    this.scene.add(group);
    this.live.set(key, { group, mat, posts, cx: s.x, cz: s.z,
                         face: faceKey(j.billboard, s.side) });
  }

  /**
   * The board across the road from a turning, and which way it points.
   *
   * The one piece of arithmetic worth reading: a plane rotated by
   * `-a + PI/2` about Y has its normal along `(cos a, sin a)` and its
   * local +x along `(sin a, -cos a)` -- the facing direction turned a
   * quarter turn.  So whether the arrow drawn toward +x points *up* the
   * road or *down* it is one dot product, and it is asked rather than
   * assumed, because a sign that points the wrong way is worse than no
   * sign at all.
   *
   * Up the road is the only answer, at every junction including the last
   * one in the list: the board says which way is forward on this road,
   * and a player who has learned that once never has to read it again.
   */
  _fingerpost(j, key) {
    const group = new THREE.Group();
    const s = j.post;
    const x = s.x, z = s.z;
    const gy = this.T.heightAt(x, z);
    /* The board is set from the deck, not from the ground under the post:
     * across the road from a mouth is as likely as not a fill batter, and
     * a board set from its foot stands below the tarmac it is for. */
    const base = Math.max(gy, s.deckY - 0.3);

    /* Facing back across the road, toward the mouth. */
    const a = s.a;
    /* Local +x of the board, in world XZ, against the road's tangent. */
    const flip = (Math.sin(a) * s.tx - Math.cos(a) * s.tz) < 0;

    const post = new THREE.Mesh(this.postGeo, this.matFrame);
    post.position.set(x, gy - 0.3, z);
    post.scale.y = base - gy + POST_Y + 0.3;
    post.castShadow = true;
    post.matrixAutoUpdate = false;
    post.updateMatrix();
    group.add(post);

    const cy = base + POST_Y + POST_H / 2;
    const frame = new THREE.Mesh(this.fingerFrame, this.matFrame);
    frame.position.set(x, cy, z);
    frame.rotation.y = -a + Math.PI / 2;
    frame.castShadow = true;
    frame.matrixAutoUpdate = false;
    frame.updateMatrix();
    group.add(frame);

    /* Unlit, exactly as the billboard faces are and for the same reason:
     * this board is the first thing the player reads and it stands on the
     * shaded side of its own post for half the day. */
    const mat = flat({ color: 0xffffff, map: fingerFaceFor(flip), cache: false });
    this.faceMats.push(mat);

    const board = new THREE.Mesh(this.fingerGeo, mat);
    board.position.set(x + Math.cos(a) * 0.09, cy, z + Math.sin(a) * 0.09);
    board.rotation.y = -a + Math.PI / 2;
    board.matrixAutoUpdate = false;
    board.updateMatrix();
    group.add(board);

    group.matrixAutoUpdate = false;
    this.scene.add(group);
    this.live.set(key, {
      group, mat, cx: x, cz: z,
      posts: [{ x, z, y: gy, r: 0.18, h: base - gy + POST_Y }],
    });
  }

  /**
   * Hand the faces over from the sun to their own floodlights.
   *
   * The faces are unlit -- see `_build` -- so there is nothing to turn
   * *on*: what this does is take a little off them after dark, because a
   * bank of floodlights is not the sun and a panel that is exactly as
   * bright at midnight as at noon reads as a hole cut in the night rather
   * than as a lit sign.
   *
   * `atmos.light` is 1 in open daylight and about 0.06 at night, and the
   * ramp between 0.30 and 0.09 is roughly civil dusk -- so the change
   * happens over the same few minutes the headlights come on rather than
   * snapping at a threshold.  The floor is deliberately high: readable is
   * the entire job.
   */
  setLight(level) {
    const dark = 1 - Math.min(1, Math.max(0, (level - 0.09) / 0.21));
    const v = 1 - dark * 0.18;
    for (const m of this.faceMats) m.color.setScalar(v);
  }

  /** The posts, for `physics.syncPosts`. */
  get trunks() { return this.live; }

  /** How many composed faces are held, for `perf-bench/loop.mjs`.  At
   *  most `FACE_CAP` once every image has landed. */
  get faceCount() { return faces.size; }
}
