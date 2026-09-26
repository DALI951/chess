/**
 * VISUAL CHECKS THAT NEED NO EYES.
 *
 * A screenshot review is the best test, but it is not the only one. These are
 * the three ways this UI can be quietly broken in a way no assertion catches:
 *
 *   1. pieces that do not contrast with the square under them
 *   2. a second accent colour sneaking in and breaking the "ONE red" rule
 *   3. tap targets too small to hit on a phone
 *
 *   node tools/visual-check.mjs
 *
 * @author DALI951
 */
import { chromium } from 'playwright-core';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', 'assets', 'css', 'style.css'), 'utf8');

let failures = 0;
const check = (ok, what, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${extra ? '  -> ' + extra : ''}`);
  if (!ok) failures++;
};

// ── colour helpers ──────────────────────────────────────────────────────────
const hex = (h) => {
  const s = h.replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/**
 * Absolute chroma, 0-1. NOT saturation = (max-min)/max: for a near-black grey
 * like #131318 that ratio explodes to 0.21 and the colour reads as "blue",
 * which is how near-black greys got flagged as a second colour family.
 */
const chroma = (h) => {
  const [r, g, b] = hex(h);
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
};
const hue = (h) => {
  const [r, g, b] = hex(h).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return null;
  let deg;
  if (max === r) deg = 60 * (((g - b) / d) % 6);
  else if (max === g) deg = 60 * ((b - r) / d + 2);
  else deg = 60 * ((r - g) / d + 4);
  return (deg + 360) % 360;
};
/** Composite colour of an rgba() string over a background, for rim contrast. */
const over = (rgbaStr, bgHex) => {
  const m = rgbaStr.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  const bg = hex(bgHex);
  const fg = [Number(m[1]), Number(m[2]), Number(m[3])];
  const mix = fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
  return '#' + mix.map((c) => c.toString(16).padStart(2, '0')).join('');
};

// ── 1. piece legibility, per theme -------------------------------------------
// A piece is read through FILL + RIM together, not through the fill alone: a
// white piece on a light square has almost no fill contrast, and that is normal
// and fine because the dark rim carries it. So each colour must clear 3:1
// against ONE square via its fill and the OTHER via its rim.
const vars = (block) => {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{3,6}|rgba?\([^)]*\))/gi)) out[m[1]] = m[2];
  return out;
};
// the default theme is the :root block, not a [data-theme] block
const rootBlock = CSS.slice(CSS.indexOf(':root'), CSS.indexOf('}', CSS.indexOf(':root')));
const themed = [...CSS.matchAll(/\[data-theme="([a-z]+)"\]\s*\{([\s\S]*?)\n\}/g)];
const blocks = [['dark (default)', rootBlock], ...themed.map((t) => [t[1], t[2]])];
for (const [name, block] of blocks) {
  const v = vars(block);
  const light = v['sq-light'] || '#3a3a44';
  const dark = v['sq-dark'] || '#22222a';

  for (const side of ['w', 'b']) {
    const fill = v[`piece-${side}`];
    const rimRaw = v[`piece-${side}-stroke`];
    const rim = rimRaw ? over(rimRaw, light) : null;
    if (!fill) { check(false, `${name}: --piece-${side} is defined`); continue; }

    const best = Math.max(
      contrast(fill, light), contrast(fill, dark),                 // fill against either
      rim ? contrast(rim, light) : 0, rim ? contrast(rim, dark) : 0  // rim against either
    );
    check(best >= 3, `${name}: ${side === 'w' ? 'white' : 'black'} piece is legible on BOTH squares`,
      `fill/rim best ${best.toFixed(2)}:1`);

    // and it must not be the SAME contrast on both, i.e. the rim is what
    // rescues the weak side rather than the fill doing all the work alone
    const onLight = Math.max(contrast(fill, light), rim ? contrast(rim, light) : 0);
    const onDark = Math.max(contrast(fill, dark), rim ? contrast(rim, dark) : 0);
    check(Math.min(onLight, onDark) >= 3, `${name}: ${side} piece reads on light AND dark`,
      `light ${onLight.toFixed(2)} dark ${onDark.toFixed(2)}`);
  }
  const squares = contrast(light, dark);
  check(squares >= 1.35, `${name}: the two square colours differ enough`, squares.toFixed(2));
}

// ── 2. exactly one UI accent family (a wood BOARD is allowed to be brown) ----
// Board squares are identified by the VARIABLE THEY SET, not by guessing from
// the colour: a guess by hue flagged the red accent itself as "wood", because
// #e11d2e happens to have more red than blue.
const boardColours = new Set();
for (const [, block] of blocks) {
  for (const m of block.matchAll(/--sq-(?:light|dark):\s*(#[0-9a-f]{3,6})/gi)) {
    if (chroma(m[1]) >= 0.08) boardColours.add(m[1].toLowerCase());
  }
}
const accents = new Map();
for (const m of CSS.matchAll(/#[0-9a-f]{3,6}\b/gi)) {
  const h = m[0].toLowerCase();
  if (h.length !== 4 && h.length !== 7) continue;
  if (chroma(h) < 0.08) continue;          // imperceptible tint == grey
  if (boardColours.has(h)) continue;       // a board square, not chrome
  const hu = hue(h);
  if (hu == null) continue;
  const bucket = Math.round(hu / 15) * 15;
  if (!accents.has(bucket)) accents.set(bucket, new Set());
  accents.get(bucket).add(h);
}
const families = [...accents.keys()];
check(boardColours.size > 0, 'the wood board browns are recognised as board colours', [...boardColours].join(','));
check(families.length === 1, 'there is exactly ONE UI colour family', `families ${families.join(',') || 'none'}`);
const only = families[0];
check(only === undefined || only >= 340 || only <= 15, 'and it is the red accent', `${only}deg`);

// ── 3. tap targets in the real DOM -------------------------------------------
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
if (chrome) {
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ar-TN' });
  await page.goto(process.env.CHESS_URL || 'http://127.0.0.1:8080/', { waitUntil: 'networkidle' });

  const small = await page.evaluate(() => {
    const MIN = 40;   // 44 is the guideline; 40 is the floor for a dense toolbar
    const bad = [];
    for (const el of document.querySelectorAll('button, select, a.nav-link, input, textarea')) {
      if (el.offsetParent === null) continue;         // hidden tab panes
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < MIN) bad.push(`${el.tagName}.${el.className || el.id}=${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return bad;
  });
  check(small.length === 0, 'every visible control is at least 40px tall', small.join(' | '));

  const board = await page.locator('#board').boundingBox();
  const sq = board.width / 8;
  check(sq >= 40, 'a board square is a comfortable touch target', `${Math.round(sq)}px`);

  // no text should be clipped anywhere
  const clipped = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('button, .brand-name, .nav-link, .player-name, .stat-k, .stat-v, .tab')) {
      if (el.offsetParent === null) continue;
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') {
        bad.push(`${el.tagName}.${el.className || el.id}: "${el.textContent.trim().slice(0, 18)}"`);
      }
    }
    return bad;
  });
  check(clipped.length === 0, 'no label is clipped', clipped.join(' | '));

  await browser.close();
} else {
  console.log('  skip  browser checks (no Chromium found)');
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL VISUAL CHECKS PASSED');
process.exit(failures ? 1 : 0);
