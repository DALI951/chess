/**
 * PIECE PREVIEW — renders each piece silhouette and prints it as ASCII.
 *
 * This exists because the art cannot be reviewed by eye on this machine: the
 * model reads no images and the vision agent is broken. A screenshot proves
 * nothing if nobody can look at it, but a SILHOUETTE is text. Forty rows of '#'
 * is a shape you can read in a terminal, and it catches the failure modes that
 * matter for hand-written path data: a typo that empties the shape, a contour
 * that crosses itself and punches a hole, a piece that is far too small or too
 * tall next to its neighbours, a horse that reads as a blob.
 *
 *   node tools/piece-preview.mjs           all six, 44 cols
 *   node tools/piece-preview.mjs n         just the knight
 *   node tools/piece-preview.mjs --grid    overlay the construction grid
 *
 * @author DALI951
 */
import { chromium } from 'playwright-core';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const COLS = 44;
const ROWS = 30;

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const p = join(root, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.error('No Chromium. Set CHROME_PATH, or: npx playwright install chromium');
  process.exit(2);
}

// The renderer imports the REAL art module, so the preview can never drift from
// what the board draws.
const mod = await import(new URL('../assets/js/pieces.js', import.meta.url).href);
const { SHAPES, PLINTH, TYPE_LETTER } = mod.__shapes;

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const showGrid = process.argv.includes('--grid');

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8080/brand/'.replace(/brand\/$/, ''), { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');

const masks = await page.evaluate(async ({ shapes, plinth, cols, rows }) => {
  const out = {};
  for (const [key, body] of Object.entries(shapes)) {
    const d = body + ' ' + plinth;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols}" height="${rows}" ` +
                `viewBox="0 0 100 100" preserveAspectRatio="none">` +
                `<path d="${d}" fill="#000" stroke="none"/></svg>`;
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const cv = document.createElement('canvas');
    cv.width = cols; cv.height = rows;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, cols, rows);
    g.drawImage(img, 0, 0, cols, rows);
    const px = g.getImageData(0, 0, cols, rows).data;
    const grid = [];
    for (let y = 0; y < rows; y++) {
      const row = [];
      for (let x = 0; x < cols; x++) row.push(px[(y * cols + x) * 4 + 3] > 110 ? 1 : 0);
      grid.push(row);
    }
    out[key] = grid;
  }
  return out;
}, { shapes: SHAPES, plinth: PLINTH, cols: COLS, rows: ROWS });

await browser.close();

const NAMES = { p: 'PAWN', n: 'KNIGHT', b: 'BISHOP', r: 'ROOK', q: 'QUEEN', k: 'KING' };
const keys = only.length ? only : Object.keys(SHAPES);
const bounds = [];
let bad = 0;

for (const key of keys) {
  const g = masks[key];
  if (!g) { console.error(`no art for "${key}"`); bad++; continue; }
  const filled = g.flat().filter(Boolean).length;
  // tight bounds, so an off-centre or undersized piece is obvious
  let minX = COLS, maxX = -1, minY = ROWS, maxY = -1;
  g.forEach((row, y) => row.forEach((v, x) => {
    if (!v) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }));
  console.log(`\n${NAMES[key] || key}  cells ${filled}  x ${minX}-${maxX}  y ${minY}-${maxY}`);
  for (let y = 0; y < ROWS; y++) {
    let line = '';
    for (let x = 0; x < COLS; x++) {
      const on = g[y][x];
      let ch = on ? '#' : '.';
      if (showGrid && !on) {
        const gx = (x + 0.5) / COLS * 100, gy = (y + 0.5) / ROWS * 100;
        if (Math.abs(gx % 10) < 5 / COLS * 10) ch = gx % 20 < 10 ? ':' : '|';
        else if (Math.abs(gy % 10) < 5 / ROWS * 10) ch = gy % 20 < 10 ? '-' : '=';
      }
      line += ch;
    }
    console.log('  ' + line);
  }
  if (filled < 60) { console.error(`  !! ${key} is nearly empty (${filled} cells)`); bad++; }
  if (maxY - minY < 18) { console.error(`  !! ${key} is too flat`); bad++; }
  if (minX < 2 || maxX > COLS - 3) { console.error(`  !! ${key} touches the edge`); bad++; }
  bounds.push({ key, minX, maxX, minY, maxY, filled });
}

// Every piece stands on the SAME plinth, so all six silhouettes must agree on
// their bottom row. This is the check that catches a contour whose winding runs
// opposite to the shared one: the two subpaths then cancel under the nonzero
// fill rule and the plinth silently disappears. It happened once already.
if (bounds.length > 1) {
  const ref = bounds[0].maxY;
  for (const b of bounds.slice(1)) {
    if (b.maxY !== ref) {
      console.error(`  !! ${b.key} does not reach the shared plinth (bottom row ${b.maxY}, expected ${ref})`);
      bad++;
    }
  }
}

console.log(bad ? `\n${bad} SHAPE(S) SUSPECT` : '\nall silhouettes rendered');
process.exit(bad ? 1 : 0);
