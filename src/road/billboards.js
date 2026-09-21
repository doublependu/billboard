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
 * **Order is position.**  The first entry is the first sign the player
 * meets, the second is the next one after that, and so on until the list
 * runs out -- a billboard every thousand feet until there is no billboard
 * left.
 *
 * The image wants to be about 3840 x 1080 -- 32:9, which is the shape of
 * the panel.  Anything else is letterboxed into it rather than stretched,
 * so a wrong aspect is a smaller picture and never a distorted one.
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
];
