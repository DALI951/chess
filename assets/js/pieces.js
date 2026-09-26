/**
 * PIECE ART — hand-authored SVG silhouettes, one contour per piece.
 *
 * WHY ONE CONTOUR PER PIECE
 * A piece is read through fill AND rim (see .piece.w / .piece.b in the CSS), and
 * the rim is what makes a white piece visible on a light square. If a piece were
 * built from several overlapping shapes, every shape would carry its own stroke
 * and the seams between them would show as dark lines across the body. So each
 * piece is ONE closed path: the stroke then traces the silhouette and nothing
 * else. Where two parts genuinely meet (a bishop's mitre on its collar) the
 * edges are coincident, so the shared stroke is invisible.
 *
 * The set is geometric on purpose: every piece is built on the same 100x100 grid
 * with the same plinth (y 82-90) and the same visual weight, so a board of them
 * reads as one family. `tools/piece-preview.mjs` renders each silhouette to an
 * ASCII mask, which is how the shapes get checked without eyes.
 *
 * `GLYPH` is kept for the captured-material strip, which wants six cheap text
 * characters rather than six inline SVGs.
 *
 * @author DALI951
 */

export const GLYPH = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};

const TYPE_LETTER = ['', 'p', 'n', 'b', 'r', 'q', 'k'];

/** The shared plinth every piece stands on: x 20-80, y 82-90. */
const PLINTH = 'M20 82 H80 V90 H20 Z';

/**
 * One closed silhouette per piece, on a 100x100 grid, y down.
 * Coordinates were laid out on that grid by hand; see tools/piece-preview.mjs.
 */
const SHAPES = {
  // ball head, narrow neck, flaring skirt
  p: 'M33 82 C32 78 33 73 35 69 L42 45 C36 42 34 37 36 31 C38 23 44 18 50 18 ' +
     'C56 18 62 23 64 31 C66 37 64 42 58 45 L65 69 C67 73 68 78 67 82 Z',
  // horse head facing left, ear at the top, mane down the back
  n: 'M26 82 H76 V76 L66 72 L64 46 L70 38 L66 30 L60 20 L57 10 L52 22 L44 16 ' +
     'L34 22 L26 28 L20 36 L28 40 L36 40 L32 50 L26 56 L24 66 L30 76 Z',
  // mitre that tapers to a rounded point, then a collar
  b: 'M32 82 C31 78 32 73 34 69 V58 H66 V69 C68 73 69 78 68 82 Z ' +
     'M36 58 C34 52 35 45 40 39 L45 32 L46 26 L50 23 L54 26 L55 32 L60 39 ' +
     'C65 45 66 52 64 58 Z',
  // three merlons over a straight body
  r: 'M30 82 C31 78 32 74 33 70 L36 42 L28 39 V20 H38 V31 H46 V20 H56 V31 H64 ' +
     'V20 H74 V39 L66 42 L69 70 C70 74 71 78 72 82 Z',
  // five-point coronet, collar, skirt
  q: 'M72 82 L69 70 L70 62 H80 V30 L66 46 L50 16 L34 46 L20 30 V62 H30 L27 70 ' +
     'L28 82 Z',
  // cross on a dome, collar, skirt
  k: 'M72 82 L70 72 L68 66 H76 V58 H68 V46 C68 36 60 30 50 30 V26 H62 V14 H56 ' +
     'V2 H44 V14 H38 V26 H44 V30 C40 36 32 46 32 58 H24 V66 H30 L28 72 L28 82 Z',
};

/** type 1..6 (p n b r q k) -> path data, always including the plinth. */
function shapeFor(type) {
  const body = SHAPES[TYPE_LETTER[type]];
  if (!body) throw new Error('no art for piece type ' + type);
  return body + ' ' + PLINTH;
}

/**
 * Markup for one piece. `color` is 'w' or 'b', `type` is 1..6 (p n b r q k).
 * Fill and stroke come from CSS (.piece.w / .piece.b) and are inherited by the
 * path, so this function stays pure geometry.
 */
export function pieceMarkup(color, type) {
  const letter = TYPE_LETTER[type];
  return `<svg class="piece ${color}" data-piece="${color}${letter}" viewBox="0 0 100 100" ` +
         `aria-hidden="true" focusable="false"><path d="${shapeFor(type)}"/></svg>`;
}

/** The eight-pointed star mark: a square crossed with a khatem. */
export function brandMark(cls = '') {
  return `<svg class="mark ${cls}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">` +
         `<path class="mark-a" d="M16 1.5 21 11 30.5 16 21 21 16 30.5 11 21 1.5 16 11 11 Z"/>` +
         `<path class="mark-b" d="M7.4 7.4 H24.6 V24.6 H7.4 Z"/></svg>`;
}

/** Accessible name for a piece, e.g. "white knight". */
export const pieceAlt = (color, type) =>
  `${color === 'w' ? 'white' : 'black'} ${['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'][type - 1]}`;

/** Exposed for tools/piece-preview.mjs so it renders exactly what the board does. */
export const __shapes = { SHAPES, PLINTH, TYPE_LETTER };
