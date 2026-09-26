/**
 * HEADLESS SMOKE TEST - open the real page in a real Chromium, fail loudly on
 * any console error, then PLAY A GAME through the UI: click squares, let the
 * worker engine answer, promote, flip, undo, and check the resulting state.
 *
 * This is the check that catches the mistakes a perft suite cannot see. It
 * already earned its keep: it found a hidden veil that swallowed every click on
 * the board, and a worker whose import path did not resolve.
 *
 *   node tools/smoke.mjs              headless
 *   node tools/smoke.mjs --headful    watch it
 *   node tools/smoke.mjs --shots      also drop PNGs in tools/shots/
 *
 * @author DALI951
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.CHESS_URL || 'http://127.0.0.1:8080/';
const HEADFUL = process.argv.includes('--headful');
const SHOTS = process.argv.includes('--shots');

/** This box has no system browser, so fall back to Playwright's own Chromium. */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) {
    if (existsSync(p)) return p;
  }
  const root = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (existsSync(root)) {
    for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
        const p = join(root, dir, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

const CHROME = findChrome();
if (!CHROME) {
  console.error('No browser found. Set CHROME_PATH, or run: npx playwright install chromium');
  process.exit(2);
}

let failures = 0;
const check = (ok, what, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${extra ? '  -> ' + extra : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: CHROME, headless: !HEADFUL });
// Arabic first: RTL being the DEFAULT is the point, not a retrofit
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'ar-TN' });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL_, { waitUntil: 'networkidle' });

// -- shell --------------------------------------------------------------------
check(await page.locator('#board .sq').count() === 64, 'the board rendered 64 squares');
check(await page.locator('#board .piece').count() === 32, 'all 32 pieces are on the board');
check((await page.locator('html').getAttribute('dir')) === 'rtl', 'an Arabic browser gets Arabic + RTL');
check((await page.locator('html').getAttribute('lang')) === 'ar', 'lang=ar');
// a8 is a LIGHT square and a1 is the dark one, on every real board
check((await page.locator('#board .sq').first().getAttribute('class')).includes('sq-light'), 'a8 is a light square');
check((await page.locator('#board .sq').nth(7).getAttribute('class')).includes('sq-dark'), 'a1 is a dark square');
check(await page.locator('#board .coord.file').first().textContent() === 'a', 'the file letters start at a');
check(await page.locator('#board .coord.rank').first().textContent() === '1', 'the rank numbers end at 1');

/** The DOM cell showing a square, when White is at the bottom. */
const sq = (name) => {
  const file = 'abcdefgh'.indexOf(name[0]);
  const rank = Number(name[1]) - 1;
  return page.locator('#board .sq').nth((7 - rank) * 8 + file);
};
const tab = (name) => page.locator(`.tab[data-tab="${name}"]`).click();
const loadFen = async (fen) => {
  await tab('setup');
  await page.locator('#fenInput').fill(fen);
  await page.locator('#loadFen').click();
  await tab('game');
};
const moveCount = () => page.locator('#moveList .m').count();

// -- click to move ------------------------------------------------------------
await sq('e2').click();
check(await page.locator('#board .sq.sel').count() === 1, 'clicking e2 selects it');
check(await page.locator('#board .dot, #board .ring').count() === 2, 'e2 shows 2 legal targets');
await sq('e4').click();
check((await sq('e4').getAttribute('class')).includes('last'), 'the piece moved to e4');
check((await sq('e4').locator('.piece').count()) === 1, 'e4 now holds a piece');
check((await sq('e2').locator('.piece').count()) === 0, 'e2 is empty');
check((await page.locator('#moveList .m').first().textContent()) === 'e4', 'the move list shows e4');
check((await page.locator('#statMoves').textContent()) === '1', 'the move counter says 1');

// -- the engine must answer ----------------------------------------------------
await page.waitForFunction(() => document.querySelectorAll('#moveList .m').length >= 2, null, { timeout: 20000 });
const sans = await page.locator('#moveList .m').allTextContents();
check(/^[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?$/.test(sans[1]), 'the engine replied with legal SAN', sans[1]);
check((await page.locator('#statEval').textContent()) !== '--', 'an evaluation appeared', await page.locator('#statEval').textContent());
check(await page.locator('#board .piece').count() === 32, 'still 32 pieces after the reply');
// the bar of the side to move carries a status; the idle one stays empty
const subs = await page.locator('#topSub, #botSub').allTextContents();
check(subs.some((s) => s.trim().length > 0), 'a player bar says whose turn it is', JSON.stringify(subs));

// -- a longer game: in AI mode only WHITE is ours ------------------------------
await sq('g1').click();
await sq('f3').click();
await page.waitForFunction(() => document.querySelectorAll('#moveList .m').length >= 4, null, { timeout: 20000 });
await sq('f1').click();
await sq('c4').click();
await page.waitForFunction(() => document.querySelectorAll('#moveList .m').length >= 6, null, { timeout: 20000 });
check((await moveCount()) >= 6, 'the game has a full move list');
const canMoveBlack = await sq('b8').evaluate((el) => {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  return document.querySelectorAll('#board .sq.sel').length;
});
check(canMoveBlack === 0, 'a black piece cannot be picked up in AI mode');

// -- flip and undo ------------------------------------------------------------
// the engine answered c6, so c6 is the only black piece we can rely on
const c6Before = await sq('c6').locator('.piece').count();
await page.locator('#flipBtn').click();
check(await page.locator('#board .piece').count() === 32, 'the board survives a flip');
check((await sq('e4').locator('.piece').count()) === 0, 'after flipping, e4 no longer shows a piece');
check((await sq('c6').locator('.piece').count()) === c6Before, 'c6 keeps its piece on the same cell when flipped');
check(await page.locator('#board .coord.file').first().textContent() === 'h', 'a flip reverses the file letters');
check(await page.locator('#board .coord.rank').first().textContent() === '8', 'and the rank numbers');
await page.locator('#flipBtn').click();
check((await sq('e4').locator('.piece').count()) === 1, 'flipping back restores the piece');
check(await page.locator('#board .coord.file').first().textContent() === 'a', 'the coordinates come back');

const before = await moveCount();
await page.locator('#undoBtn').click();
check((await moveCount()) < before, 'undo removes moves');
check((await page.locator('#statMoves').textContent()) === String(before - 2), 'undo in AI mode takes back a whole move pair');

// -- mate: fools mate, then the veil ------------------------------------------
await page.locator('#mode').selectOption('duo');
for (const mv of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) {
  await sq(mv[0]).click();
  await sq(mv[1]).click();
}
check(await page.locator('#boardVeil').isVisible(), 'the result veil appears on checkmate');
check((await page.locator('#veilTitle').textContent()).length > 0, 'the veil names the result', await page.locator('#veilTitle').textContent());
// a MATED king is still in check, so the red marker must still be there
check((await page.locator('#board .sq.check').count()) === 1, 'the mated king is still marked in check');

// a hidden veil must not eat clicks
await page.locator('#boardVeil .btn-ghost').click();
check(!(await page.locator('#boardVeil').isVisible()), 'the veil can be dismissed to review the board');
check(!(await sq('d8').isHidden()), 'the board is clickable again after dismissing it');

await page.locator('#newGame').click();
check((await moveCount()) === 0, 'a new game clears the move list');
check(await page.locator('#board .piece').count() === 32, 'a new game puts 32 pieces back');

// -- custom FEN ----------------------------------------------------------------
// NOTE the FEN has 8 ranks: the black king is on e8, NOT e3. An earlier version
// of this test used a 6-rank FEN, which put the black king on e3, which BLOCKED
// the pawn on e2 - and the engine was right to offer it no moves at all.
await loadFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
check(await page.locator('#board .piece').count() === 3, 'a custom FEN loads its 3 pieces', String(await page.locator('#board .piece').count()));
check((await sq('e2').locator('.dot, .ring').count()) === 0, 'nothing is selected yet');
await sq('e2').click();
check((await page.locator('#board .sq.sel').count()) === 1, 'the FEN pawn can be picked up');
check((await page.locator('#board .dot, #ring').count()) >= 2, 'e2 offers e3 and e4');
await sq('e4').click();
check((await sq('e4').locator('.piece').count()) === 1, 'and it is playable');

await loadFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
check(await page.locator('#board .piece').count() === 3, 'the promotion position loads');
await sq('a7').click();
await sq('a8').click();
check((await page.locator('.promo').count()) === 1, 'the promotion picker opens');
check((await page.locator('.promo button').count()) === 4, 'it offers queen, rook, bishop, knight');
await page.locator('.promo button').first().click();
check((await sq('a8').locator('.piece').count()) === 1, 'the promotion lands on a8');
check((await page.locator('#moveList .m').first().textContent()) === 'a8=Q+', 'it is written as a8=Q+');

// -- themes and language -------------------------------------------------------
for (const theme of ['wood', 'contrast', 'dark']) {
  await page.locator(`[data-theme="${theme}"]`).click();
  check((await page.locator('html').getAttribute('data-theme')) === theme, `the ${theme} theme applies`);
}
await page.locator('#langToggle').click();
check((await page.locator('html').getAttribute('dir')) === 'ltr', 'switching to English flips the page to LTR');
check((await page.locator('#brandName').textContent()) === 'KERSAT', 'the wordmark switches to English');
check(await page.locator('#board .piece').count() === 3, 'switching language does not disturb the board');
await page.locator('#langToggle').click();
check((await page.locator('html').getAttribute('dir')) === 'rtl', 'and back to Arabic');

// -- mobile --------------------------------------------------------------------
await page.setViewportSize({ width: 390, height: 844 });
check(await page.locator('#board').isVisible(), 'the board fits a 390px phone');
const box = await page.locator('#board').boundingBox();
check(box.width <= 390, 'the board does not overflow the phone width', `${Math.round(box.width)}px`);
check(await page.locator('.panel').isVisible(), 'the panel is reachable on the phone');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(overflow <= 0, 'no horizontal overflow on a phone', `${overflow}px`);

// -- clock ---------------------------------------------------------------------
await page.setViewportSize({ width: 1280, height: 900 });
await page.locator('#newGame').click();
await page.locator('#timeControl').selectOption('180+2');
const t0 = await page.locator('#botClock').textContent();
await sq('e2').click();
await sq('e4').click();
await page.waitForTimeout(1600);
const t1 = await page.locator('#botClock').textContent();
check(t1 !== '03:00', 'the clock runs and the 2s increment is added', `${t0} -> ${t1}`);

if (SHOTS) {
  const dir = join(HERE, 'shots');
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('#newGame').click();
  await page.locator('#timeControl').selectOption('600');
  for (const mv of [['e2', 'e4'], ['g1', 'f3']]) { await sq(mv[0]).click(); await sq(mv[1]).click(); }
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(dir, 'desktop-ar.png') });
  await page.locator('#langToggle').click();
  await page.screenshot({ path: join(dir, 'desktop-en.png') });
  await page.locator('[data-theme="wood"]').click();
  await page.screenshot({ path: join(dir, 'desktop-en-wood.png') });
  await page.locator('#tab-moves, .tab[data-tab="moves"]').click();
  await page.screenshot({ path: join(dir, 'desktop-en-moves.png') });
  await page.locator('[data-theme="dark"]').click();
  await page.locator('.tab[data-tab="game"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(dir, 'phone-en.png'), fullPage: true });
  await page.locator('#langToggle').click();
  await page.screenshot({ path: join(dir, 'phone-ar.png'), fullPage: true });
  console.log('  shots -> tools/shots/');
}

check(errors.length === 0, 'no console errors', errors.slice(0, 4).join(' | '));

await browser.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
