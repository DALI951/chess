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
// real SVG art, not a Unicode character in a <text> node
check(await page.locator('#board .piece path').count() === 32, 'all 32 pieces are drawn as SVG paths');
check(await page.locator('#board .piece text').count() === 0, 'no piece is a font glyph any more');
check((await page.locator('.brand-mark .mark-a').count()) === 1, 'the brand mark is drawn');
check((await page.locator('#brandName').textContent()).length > 0, 'the wordmark is there');

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
const moveList = () => page.locator('#moveList .m').allTextContents();

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
// A flip is a 180-degree rotation of the GRID, so the exact invariant is: after
// flipping, cell i must show whatever cell 63-i showed before. The old check
// asserted "e4 is now empty", which is a guess about the position, and it broke
// the moment the engine picked a different move. Position-dependent assertions
// about an engine's choices are not tests.
const grid = () => page.$$eval('#board .sq', (els) =>
  els.map((e) => e.querySelector('.piece')?.dataset.piece || ''));

const beforeFlip = await grid();
const beforeCount = beforeFlip.filter(Boolean).length;
await page.locator('#flipBtn').click();
const afterFlip = await grid();
check(afterFlip.filter(Boolean).length === beforeCount, 'a flip neither adds nor removes a piece',
  `${beforeCount} -> ${afterFlip.filter(Boolean).length}`);
check(afterFlip.every((v, i) => v === beforeFlip[63 - i]),
  'after a flip every cell shows the piece that was on the opposite cell',
  afterFlip.map((v, i) => (v === beforeFlip[63 - i] ? null : `${i}:${v}!=${beforeFlip[63 - i]}`))
    .filter(Boolean).slice(0, 3).join(' '));
check(await page.locator('#board .coord.file').first().textContent() === 'h', 'a flip reverses the file letters');
check(await page.locator('#board .coord.rank').first().textContent() === '8', 'and the rank numbers');
await page.locator('#flipBtn').click();
const backFlipped = await grid();
check(backFlipped.every((v, i) => v === beforeFlip[i]), 'flipping back restores every cell');
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
check((await page.locator('#brandName').textContent()) === 'SHATRANGI', 'the wordmark switches to English');
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

// -- no clock: "no clock" is not a clock of zero ------------------------------
// Choosing untimed used to set both clocks to 0, so the very first tick drove a
// side to 0 and ended the game instantly, reporting it as checkmate.
await page.locator('#newGame').click();
await page.locator('#timeControl').selectOption('0');
check((await page.locator('#topClock').textContent()) === '∞', 'untimed shows an infinity sign, not 00:00');
check((await page.locator('#botClock').textContent()) === '∞', 'on both clocks');
await sq('e2').click();
await sq('e4').click();
await sq('e7').click();
await sq('e5').click();
await page.waitForTimeout(900);
check((await moveCount()) === 2, 'an untimed game plays on', String(await moveCount()));
check(!(await page.locator('#boardVeil').isVisible()), 'an untimed game does not end on its own');
check((await page.locator('#topClock').textContent()) === '∞', 'and the clock stays unlimited');

// -- custom time control ------------------------------------------------------
await page.locator('#timeControl').selectOption('custom');
check(await page.locator('#customTime').isVisible(), 'choosing Custom reveals minutes and increment');
await page.locator('#tcMinutes').fill('1');
await page.locator('#tcIncrement').fill('5');
await page.locator('#tcApply').click();
const custom0 = await page.locator('#topClock').textContent();
check(/^01:0\d$/.test(custom0), 'a custom 1+5 starts at about a minute', custom0);
check((await page.locator('#timeControl').inputValue()) === 'custom', 'the select stays on Custom');
// an unusable custom control has to be refused, not silently played on the old clock
await page.locator('#tcMinutes').fill('0');
await page.locator('#tcApply').click();
check((await page.locator('#tcHint').textContent()).trim().length > 0, 'a custom control with no minutes is refused');
check((await page.locator('#topClock').textContent()) === custom0, 'and the running clock is left exactly as it was');
await page.locator('#tcMinutes').fill('1');

// -- running out of time ------------------------------------------------------
// The reason has to name the flag. It used to report checkmate, which is a
// different ending, and the Arabic string for checkmate was mistranslated too,
// so the bug was invisible in English and doubly wrong in Arabic.
await page.locator('#newGame').click();
await sq('e2').click();
await sq('e4').click();                       // black to move, so BLACK's clock runs
await page.evaluate(() => { window.__chess.clock.b = 0.25; });
const expectedFlag = await page.evaluate(async () =>
  (await import('/assets/js/i18n.js')).t(window.__chess.lang, 'resultTimeBlack'));
const mateReason = await page.evaluate(async () =>
  (await import('/assets/js/i18n.js')).t(window.__chess.lang, 'resultCheckmate'));
await page.waitForSelector('#boardVeil:not([hidden])', { timeout: 8000 });
check((await page.locator('#veilSub').textContent()) === expectedFlag,
  'running out of time says the clock ran out', await page.locator('#veilSub').textContent());
check((await page.locator('#veilSub').textContent()) !== mateReason, 'and does not claim checkmate instead');

// -- clocks follow the flip ----------------------------------------------------
// A clock belongs to a COLOUR, and it is only correct if it sits under its own
// player's name. paintClocks() used to hardcode white to the top clock, so after
// a flip each player's time sat under the other player's name. The assertion is
// deliberately "the name on that bar matches the time on that bar" and not
// "the top clock says 05:00": a fixed expected number passes just as happily
// against the old bug as against the fix, which is exactly what happened once.
const setClocks = (w, b) => page.evaluate(([w, b]) => {
  const s = window.__chess;
  s.clock.running = false;                    // stop the tick so the values are exact
  s.clock.w = w; s.clock.b = b;
  document.getElementById('flipBtn').click(); // any repaint path
  document.getElementById('flipBtn').click(); // and back to where we started
}, [w, b]);

const sideWords = await page.evaluate(async () => {
  const m = await import('/assets/js/i18n.js');
  return { white: m.t(window.__chess.lang, 'white'), black: m.t(window.__chess.lang, 'black') };
});
/** Is the TOP bar showing `expectWhite`'s name AND their time? */
const topShows = async (expectWhite) => {
  const st = await page.evaluate(() => ({
    whiteOnTop: window.__chess.flipped,
    name: document.getElementById('topName').textContent.trim(),
    clock: document.getElementById('topClock').textContent.trim(),
  }));
  const want = expectWhite ? sideWords.white : sideWords.black;
  const wantTime = expectWhite ? '05:00' : '01:40';
  return st.whiteOnTop === expectWhite && st.name === want && st.clock === wantTime;
};

await page.locator('#newGame').click();
await page.locator('#timeControl').selectOption('600');
await setClocks(300, 100);
check(await topShows(false), 'unflipped, the top bar is black and carries black time', await page.evaluate(() => document.getElementById('topClock').textContent));
await page.locator('#flipBtn').click();
check(await topShows(true), 'flipped, the top bar is white and carries white time', await page.evaluate(() => document.getElementById('topClock').textContent));
await page.locator('#flipBtn').click();
check(await topShows(false), 'flipping back puts black on top again');

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

// -- the engine is strong enough to be worth playing --------------------------
// "The engine replied with something legal" is the easy half. The half that
// matters is whether a beginner-level engine still sees a mate in one, because
// a strength setting that randomises between the top few moves produces exactly
// the engine that hangs a mate. Black is the engine here (the player is white)
// and the FEN is a mate in one for Black, so the engine has to find Ra1#.
await page.locator('#mode').selectOption('ai');
await page.locator('#level').evaluate((el) => {
  el.value = '400';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
check((await page.locator('#levelOut').textContent()) === '400', 'the level slider goes down to 400');
check(await page.locator('#levelField').isVisible(), 'and the level control is still there');
await loadFen('r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1');
await page.waitForSelector('#boardVeil:not([hidden])', { timeout: 25000 });
check(/Ra1#/.test((await moveList()).join(' ')), 'even at level 400 the engine mates in one', (await moveList()).join(' '));
const mate = await page.evaluate(async () =>
  (await import('/assets/js/i18n.js')).t(window.__chess.lang, 'resultCheckmate'));
check((await page.locator('#veilSub').textContent()) === mate, 'and the game ends as checkmate',
  await page.locator('#veilSub').textContent());
check((await moveCount()) === 1, 'the engine made that move, not the player', String(await moveCount()));

// and a real engine reports its work, instead of a made-up node count
const info = await page.locator('#statEval').textContent();
check(/\d+p/.test(info), 'the eval readout shows a real search depth', info);
check(/[0-9]/.test(info.replace(/^[-+][\d.]+/, '')), 'and a real node count', info);

check(errors.length === 0, 'no console errors', errors.slice(0, 4).join(' | '));

await browser.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
