/**
 * A football, as a data URL.
 *
 * Shared by the Android and iOS icons so the mark is defined once. Delivered as
 * an <img> rather than inline SVG because the icons are rendered by Satori
 * (next/og), whose support for arbitrary SVG elements is partial — a data URL
 * is handed to its image decoder instead and comes out identical every time.
 *
 * The geometry is a regular pentagon at the centre with seams running from each
 * of its corners to the edge. Not a real truncated icosahedron, which needs
 * twelve pentagons and reads as grey mush below about 128px. This is the shape
 * people actually draw when they draw a football.
 */
const CENTRE = 50;
const PENTAGON_RADIUS = 20;
const BALL_RADIUS = 48;

/** Pentagon corners, first one pointing straight up. */
const CORNERS = [-90, -18, 54, 126, 198].map((degrees) => {
  const radians = (degrees * Math.PI) / 180;
  return {
    inner: {
      x: CENTRE + PENTAGON_RADIUS * Math.cos(radians),
      y: CENTRE + PENTAGON_RADIUS * Math.sin(radians),
    },
    outer: {
      x: CENTRE + BALL_RADIUS * Math.cos(radians),
      y: CENTRE + BALL_RADIUS * Math.sin(radians),
    },
  };
});

const round = (value: number) => Math.round(value * 100) / 100;

const pentagon = CORNERS.map((corner) => `${round(corner.inner.x)},${round(corner.inner.y)}`).join(
  " ",
);

const seams = CORNERS.map(
  (corner) =>
    `<line x1='${round(corner.inner.x)}' y1='${round(corner.inner.y)}' ` +
    `x2='${round(corner.outer.x)}' y2='${round(corner.outer.y)}' />`,
).join("");

const svg =
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>` +
  `<circle cx='50' cy='50' r='${BALL_RADIUS}' fill='%23ffffff'/>` +
  `<g stroke='%230f172a' stroke-width='5' stroke-linecap='round' fill='none'>${seams}</g>` +
  `<polygon points='${pentagon}' fill='%230f172a'/>` +
  `</svg>`;

export const BALL_DATA_URL = `data:image/svg+xml;utf8,${svg}`;
