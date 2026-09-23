/* ------------------------------------------------------------------ *
 * Billboard pictures, made rather than drawn.
 *
 * `prompt_4.md` item 3 adds seven billboards as a name and a link each,
 * and a sign with no picture is a caption band on a black panel -- which
 * works, and which nobody would turn off the road for.  So this makes the
 * picture from the link: the site itself, photographed at the panel's own
 * shape.
 *
 *     node perf-bench/faces.mjs              every entry with no image yet
 *     IDS=4,6 node perf-bench/faces.mjs      just these, overwriting
 *     WAIT=12 IDS=5 node perf-bench/faces.mjs
 *
 * Headful by default, because most of these links are WebGL games and a
 * headless browser on a machine without a GPU hands them a context that
 * may not exist.  `HEADLESS=1` works where it works.
 *
 * **1920 x 540 at DPR 2 is 3840 x 1080**, which is 32:9 -- the shape
 * `billboards.js` asks for -- so the page lays out in the panel's own
 * aspect and nothing is cropped or letterboxed afterwards.  A page that
 * lays out badly that wide and that short is better handled by looking at
 * it and choosing, which is `CARDS` below.
 *
 * **250 KB each, at most.**  Faces are fetched on approach and never at
 * boot, so this is not about time to first frame -- it is about the
 * picture arriving in the 300 m before the sign is readable, on a phone,
 * on mobile data.  Quality steps down from 82 until it fits.
 *
 * Some links are not worth photographing: a repository page or a
 * marketing homepage is small grey text at 250 m.  Those are `CARDS` -- a
 * page of big type rendered here and photographed the same way.
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';
import { existsSync, writeFileSync } from 'node:fs';
import { BILLBOARDS } from '../src/road/billboards.js';

const W = 1920, H = 540, DPR = 2;
const WAIT = Number(process.env.WAIT || 8) * 1000;
const BUDGET = 250 * 1024;
const IDS = process.env.IDS ? process.env.IDS.split(',').map(Number) : null;

/**
 * Style put into a photographed page before the picture is taken, by
 * billboard id.  For a site whose landing screen is a dimmed scene under
 * an overlay: at 250 m a dark panel is a black rectangle, and the caption
 * band under the picture already carries the name the overlay was there
 * to show.
 */
const STYLE = {
  6: '#hud { visibility: hidden !important; }',   // Ink Tide's "stand by" dimmer
};

/** Faces set in type rather than photographed, by billboard id. */
const CARDS = {
  9: () => page('#0d1117', `
    <svg viewBox="0 0 120 200" style="height:390px;margin-right:90px">
      <g fill="none" stroke="#f0f6fc" stroke-width="12" stroke-linecap="round">
        <path d="M30 40 V160"/><path d="M90 40 V70 Q90 100 30 120"/>
      </g>
      <g fill="#0d1117" stroke="#f0f6fc" stroke-width="12">
        <circle cx="30" cy="30" r="18"/><circle cx="90" cy="30" r="18"/>
        <circle cx="30" cy="170" r="18"/>
      </g>
    </svg>
    <div>
      <div style="font:900 250px/1 Lato,sans-serif;color:#f0f6fc;letter-spacing:-4px">fork me</div>
      <div style="font:500 74px/1.3 'DejaVu Sans Mono',monospace;color:#8b949e;margin-top:28px">
        github.com/doublependu/billboard</div>
    </div>`),
  10: () => page('linear-gradient(100deg,#f38020 0%,#faae40 100%)', `
    <svg viewBox="0 0 200 110" style="height:330px;margin-right:80px">
      <g fill="#fff">
        <circle cx="62" cy="68" r="34"/><circle cx="112" cy="50" r="46"/>
        <circle cx="158" cy="74" r="28"/><rect x="28" y="70" width="158" height="32" rx="16"/>
      </g>
    </svg>
    <div>
      <div style="font:600 92px/1 Lato,sans-serif;color:#fff;opacity:.85;letter-spacing:6px">THIS ROAD IS SERVED FROM</div>
      <div style="font:900 250px/1.05 Lato,sans-serif;color:#fff;letter-spacing:-4px">the edge</div>
    </div>`),
};

function page(background, body) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
    <html><body style="margin:0;width:${W * DPR}px;height:${H * DPR}px;background:${background};
      display:flex;align-items:center;justify-content:center;zoom:${1 / DPR}">${body}</body></html>`);
}

const c = await launch({ w: W, h: H + 120 });
await c.send('Page.enable');
await c.send('Emulation.setDeviceMetricsOverride',
             { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
/* A page taller than 540 px grows a scrollbar, and a scrollbar is a grey
 * stripe down the right-hand edge of somebody's billboard. */
await c.send('Emulation.setScrollbarsHidden', { hidden: true });

for (const b of BILLBOARDS) {
  const out = `public/${b.image}`;
  if (IDS ? !IDS.includes(b.id) : existsSync(out)) continue;
  const url = CARDS[b.id] ? CARDS[b.id]() : b.link;
  await c.send('Page.navigate', { url });
  await c.evaluate(`new Promise((r) => document.readyState === 'complete'
    ? r() : addEventListener('load', () => r(), { once: true }))`, 30000).catch(() => {});
  await new Promise((r) => setTimeout(r, CARDS[b.id] ? 500 : WAIT));
  if (STYLE[b.id]) {
    await c.evaluate(`document.head.appendChild(Object.assign(
      document.createElement('style'), { textContent: ${JSON.stringify(STYLE[b.id])} })); 1`);
    await new Promise((r) => setTimeout(r, 500));
  }

  /* Quality first, down to 64, and then size: a busy frame -- Ink Tide's
   * ocean -- is still over budget at q 40 at full width, and q 40 is
   * blocks.  2560 x 720 is still wider than the 2048 px the panel's
   * texture is composed at (`TEX_W` in `signs.js`), so the smaller frame
   * costs the sign nothing and the lower quality would have. */
  let data, q, scale;
  capture: for (scale of [1, 2 / 3]) {
    for (q = 82; q >= 64; q -= 6) {
      const r = await c.send('Page.captureScreenshot', {
        format: 'jpeg', quality: q, captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: W, height: H, scale },
      });
      data = Buffer.from(r.result.data, 'base64');
      if (data.length <= BUDGET) break capture;
    }
  }
  writeFileSync(out, data);
  console.log(`${b.id}  ${b.name.padEnd(22)} ${out}  ${(data.length / 1024).toFixed(0)} KB`
            + `  q${q}  ${Math.round(W * DPR * scale)}px`);
}

c.close();
process.exit(0);
