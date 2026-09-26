/**
 * PIECE ART — one place to swap the glyphs for real SVG art.
 *
 * Phase 1 renders the standard Unicode chess characters: they scale to any board
 * size, take their colour from CSS, and need no image or font download, so the
 * site works offline on Dali's phone. `GLYPH` is the ONLY thing that has to
 * change when the real SVG set lands — return an <svg> string here instead and
 * the board renderer will use it unchanged.
 *
 * @author DALI951
 */
export const GLYPH = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};

const TYPE_LETTER = ['', 'p', 'n', 'b', 'r', 'q', 'k'];

/**
 * Markup for one piece. `color` is 'w' or 'b', `type` is 1..6 (p n b r q k).
 * The character is wrapped in an inline <svg> so it stays crisp at any size and
 * inherits fill from the .piece CSS class.
 */
export function pieceMarkup(color, type) {
  const ch = GLYPH[color][TYPE_LETTER[type]];
  return `<svg class="piece ${color}" viewBox="0 0 100 100" aria-hidden="true">` +
         `<text x="50" y="78" text-anchor="middle" font-size="92">${ch}</text></svg>`;
}

/** Accessible name for a square, e.g. "e4 white knight". */
export const pieceAlt = (color, type) =>
  `${color === 'w' ? 'white' : 'black'} ${['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'][type - 1]}`;
