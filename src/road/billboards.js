/* ------------------------------------------------------------------ *
 * The list.
 *
 * This file is data and nothing else -- add an entry, drop the image in
 * `public/billboards/`, and a sign appears beside the road with a turning
 * after it.  Nothing here knows how a billboard is built or where it
 * stands; that is `junctions.js` and `signs.js`.
 *
 *   id      stable, and the key the composed face is cached under
 *   name    drawn on the caption band under the picture
 *   image   a path under `public/`, resolved through `assetUrl`
 *   link    where turning off the road takes you
 *
 * **Order is position, and the list loops.**  The first entry is the
 * first sign the player meets, the second is the next one after that, and
 * after the last one it starts again from the top (`prompt_4.md` item 4)
 * -- so with ten entries the eleventh turning is the first billboard
 * again, and the road never runs out of them.
 *
 * The image wants to be 32:9, which is the shape of the panel, and at
 * least 2048 wide, which is what the panel's texture is composed at --
 * 2560 x 720 to 3840 x 1080, under about 250 KB.  Anything else is
 * letterboxed into it rather than stretched, so a wrong aspect is a
 * smaller picture and never a distorted one.  `perf-bench/faces.mjs` makes
 * one from the link for any entry that has none.
 *
 * **Nothing here is fetched at boot.**  A face is decoded when the arc
 * window reaches its sign, which is about three hundred metres out, and
 * cached by id for the rest of the visit -- so the size of these files is
 * a question about how quickly a panel fills in on approach and not about
 * time to first frame.  See `faceFor` in `signs.js`, which shows the
 * caption band immediately and swaps the picture in behind it.
 * ------------------------------------------------------------------ */

export const BILLBOARDS = [
  {
    id: 1,
    name: 'Man & Bot',
    image: 'billboards/1-manandbot.jpg',
    link: 'https://manandbot.com',
  },
  {
    id: 2,
    name: 'Central Park Paintball',
    image: 'billboards/2-central-park-paintball.jpg',
    link: 'https://v0.maize.live/',
  },
  {
    id: 3,
    name: 'Maize Maze',
    image: 'billboards/3-maize-maze.jpg',
    link: 'https://v1.maize.live/',
  },
  {
    id: 4,
    name: 'Doodle District',
    image: 'billboards/4-doodle-district.jpg',
    link: 'https://doodleshooter.vercel.app/',
  },
  {
    id: 5,
    name: 'Whiteout',
    image: 'billboards/5-whiteout.jpg',
    link: 'https://whiteout.plgb.chatgpt.site/',
  },
  {
    id: 6,
    name: 'Ink Tide',
    image: 'billboards/6-ink-tide.jpg',
    link: 'https://wave-racer.vercel.app/',
  },
  {
    id: 7,
    name: 'Sakura Crossing',
    image: 'billboards/7-sakura-crossing.jpg',
    link: 'https://sakura.gh.maize.live/',
  },
  {
    id: 8,
    name: 'Friends',
    image: 'billboards/8-friends.jpg',
    link: 'https://bday.maize.live/',
  },
  {
    id: 9,
    name: 'Fork me on GitHub',
    image: 'billboards/9-github.jpg',
    link: 'https://github.com/doublependu/billboard',
  },
  {
    id: 10,
    name: 'Cloudflare',
    image: 'billboards/10-cloudflare.jpg',
    link: 'https://www.cloudflare.com/',
  },
];
