#!/usr/bin/env node
/**
 * The online game, in a REAL browser, against the REAL server.
 *
 * Every other online check in this project is Python posting JSON. That proves
 * the API works and it proves nothing about whether the page works, which is
 * the difference that bit us: a year of "immutable" caching on every .js meant
 * the code on the server was correct and the code in the browser was months old,
 * and every API-level test in the repo stayed green the entire time.
 *
 * So this drives the actual page with two real browser contexts, and it fails on
 * ANY console error or failed request, because a silent exception during module
 * init leaves the buttons dead and looks like "the site is broken".
 *
 *   node tools/live-browser.mjs [baseUrl]
 */
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || 'https://modali.powerpme.com/chess';

/** Same browser discovery the other suites use: no system browser on this box. */
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

let checks = 0;
const fails = [];
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log(`  ok   ${label}`);
  else { fails.push(label); console.log(`  FAIL ${label}  ${detail}`); }
};

/** A console error or a failed request is a failure, always. */
function watch(page, tag, bag) {
  page.on('console', (m) => {
    if (m.type() === 'error') bag.push(`[${tag}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => bag.push(`[${tag}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    bag.push(`[${tag}] request failed: ${r.url()} ${r.failure()?.errorText ?? ''}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) bag.push(`[${tag}] HTTP ${r.status()}: ${r.url()}`);
  });
}

const stamp = Date.now().toString().slice(-7);

/**
 * The DOM cell for a square, accounting for the board being drawn from the
 * VIEWER's side. A black player sees it mirrored, so the rank order in the DOM
 * is reversed: e7 sits in the cell that e2 occupies in white's view. Getting
 * this wrong is silent - the click just lands on an empty square, nothing is
 * selected, no request is sent, and the test looks like an app bug.
 */
const square = (page, name, black = false) => {
  const file = 'abcdefgh'.indexOf(name[0]);
  const rank = Number(name[1]) - 1;
  return page.locator('#board .sq').nth(black ? rank * 8 + file : (7 - rank) * 8 + file);
};
const sitsBlack = (page) => page.evaluate(() => window.__online?.myColor?.() === 1);

async function signUp(page, tag) {
  const user = `probe_br${tag}_${stamp}`;
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // The account panel is .online and hidden: it only exists in online mode, which
  // is the #mode select. This is the first thing that trips a new browser test -
  // the element is in the DOM, present and fillable-looking, and invisible.
  await page.selectOption('#mode', 'online');
  await page.waitForSelector('#authPanel:not([hidden])', { timeout: 20000 });
  await page.fill('#authName', user);
  await page.fill('#authPass', 'browserpass123');
  const display = page.locator('#authDisplayField input');
  if (await display.count()) await display.fill(`BR ${tag}`);
  await page.click('#authRegisterBtn');
  await page.waitForSelector('#onlineSetup:not([hidden])', { timeout: 25000 });
  await page.waitForTimeout(800);
  return user;
}

async function main() {
  console.log(`live browser online-game check -> ${BASE}\n`);
  const browser = await chromium.launch({ executablePath: CHROME, headless: !process.argv.includes('--headful') });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const bag = [];
  watch(A, 'A', bag);
  watch(B, 'B', bag);

  try {
    console.log('-- two players, two real browsers');
    const ua = await signUp(A, 'a');
    const ub = await signUp(B, 'b');
    ok(!bag.length, 'both pages loaded with no console errors, no failed requests',
       bag.slice(0, 4).join(' | '));
    if (bag.length) { console.log('\n  problems:'); bag.forEach((b) => console.log('    ' + b)); }

    // A creates a room and we read the code straight out of the UI
    console.log('\n-- A creates a room');
    await A.click('#onlineQuick').catch(() => {});
    await A.waitForTimeout(2500);
    let url = A.url();
    let code = (url.match(/#g=([A-Z0-9]+)/) || [])[1];
    if (!code) {
      // quick play may have found nobody; fall back to an explicit room
      await A.click('#onlineCreate');
      await A.waitForTimeout(2500);
      url = A.url();
      code = (url.match(/#g=([A-Z0-9]+)/) || [])[1];
    }
    ok(!!code, 'A is in a room and the URL carries the code', url);
    ok(!bag.length, 'no errors while creating the room', bag.slice(0, 3).join(' | '));

    console.log('\n-- B opens the invite link');
    if (code) {
      // A query param forces a REAL document load. With the hash alone the
      // browser does a same-document navigation, app.js does not re-run, and the
      // boot invite block never fires - so a link pasted into an already-open tab
      // used to do nothing at all. That case is covered separately below; this is
      // the honest "my friend sent me a link" path.
      await B.goto(`${BASE}/?inv=1#g=${code}`, { waitUntil: 'domcontentloaded' });
      await B.waitForTimeout(4000);

      const seatVisible = await B.locator('#onlineTakeSeat').isVisible().catch(() => false);
      ok(seatVisible, 'the invite actually offers a way in: "Take this seat" is shown',
         'the button stays hidden, so the link opens a game you cannot play');
      ok((await B.locator('#onlineStatus').textContent().catch(() => '')).trim().length > 0,
         'B sees the room it was invited to');

      if (seatVisible) {
        await B.locator('#onlineTakeSeat').click();
        await B.waitForTimeout(3000);
      }
    }

    console.log('\n-- the game starts once both seats are full');
    if (code) {
      // Poll until the server agrees, rather than guessing with a fixed sleep.
      let becameActive = false;
      for (let i = 0; i < 20; i++) {
        const t = (await A.locator('#onlineStatus').textContent().catch(() => '')).trim();
        if (t && !/waiting|بانتظار/i.test(t)) { becameActive = true; break; }
        await A.waitForTimeout(600);
      }
      ok(becameActive, 'A is told the game is under way',
         (await A.locator('#onlineStatus').textContent().catch(() => '?')).trim());
    }

    console.log('\n-- they can actually move');
    if (code) {
      const moveOne = async (page, from, to) => {
        const black = await sitsBlack(page);
        await square(page, from, black).click({ timeout: 8000 });
        await page.waitForTimeout(500);
        // A click that selects nothing sends no request at all, so assert the
        // selection rather than assuming it: that is the difference between "the
        // app rejected my move" and "the test clicked an empty square".
        const selected = await page.locator('#board .sq.sel').count();
        ok(selected === 1, `selecting the piece on ${from} highlights it`,
           `saw ${selected} selected squares`);
        await square(page, to, black).click({ timeout: 8000 });
        await page.waitForTimeout(2500);
      };
      let before = bag.length;
      await moveOne(A, 'e2', 'e4');
      ok(bag.length === before, 'A moved without an error', bag.slice(before).join(' | '));
      before = bag.length;
      await moveOne(B, 'e7', 'e5');
      ok(bag.length === before, 'B replied without an error', bag.slice(before).join(' | '));

      // The real proof that these are two people in ONE game and that server
      // state actually propagates: the move list is rebuilt from the server's own
      // history, so two moves on BOTH pages means both moves travelled and came
      // back. A panel's visibility proves nothing - a spectator sees the same one.
      await A.waitForTimeout(2500);
      const movesA = await A.locator('#moveList .m').count();
      const movesB = await B.locator('#moveList .m').count();
      ok(movesA >= 2, 'A sees both moves in the history', `saw ${movesA}`);
      ok(movesB >= 2, 'B sees both moves in the history', `saw ${movesB}`);
      // and B knows who it is playing, which is what the opponent panel is for
      const oppB = ((await B.locator('#onlineOpponent').textContent().catch(() => '')) || '').trim();
      ok(oppB.length > 0, 'B sees the opponent it was matched with', oppB.slice(0, 40));
    }

    console.log('\n-- a link pasted into an already-open tab still works');
    if (code) {
      // Same-document navigation: only the hash changes, so app.js does not re-run.
      // This only passes if there is a hashchange listener - which is how you
      // actually use an invite link after the site is already open.
      const beforeHash = bag.length;
      await B.goto(`${BASE}/#g=${code}`, { waitUntil: 'domcontentloaded' });
      await B.waitForTimeout(2500);
      const panelUp = await B.locator('#onlinePanel').isVisible().catch(() => false);
      const codeShown = (await B.locator('#onlineCode').textContent().catch(() => '')).trim();
      ok(panelUp && codeShown === code, 'the open tab follows the pasted link',
         `panel ${panelUp}, showing "${codeShown}", wanted "${code}"`);
      ok(bag.length === beforeHash, 'and does it without an error',
         bag.slice(beforeHash).join(' | '));
    }

    console.log('\n-- the page Dali actually loads has no stale JavaScript');
    const stampSeen = await A.evaluate(() =>
      [...document.querySelectorAll('script[type=module]')].map((s) => s.src));
    ok(stampSeen.length === 1 && /\?v=[a-f0-9]{8,}/.test(stampSeen[0]),
       'the module URL is version stamped, so a fix can actually reach the browser',
       stampSeen.join(' '));
  } finally {
    console.log('\n-- anything collected along the way');
    if (bag.length) {
      bag.forEach((b) => console.log('  ! ' + b));
    } else {
      console.log('  nothing: no console errors, no page errors, no failed requests');
    }
    await browser.close();
  }

  console.log('\n' + '='.repeat(60));
  if (fails.length || bag.length) {
    console.log(`${fails.length} check(s) failed, ${bag.length} browser problem(s)`);
    process.exit(1);
  }
  console.log(`ALL GREEN - ${checks} checks in a real browser`);
}

main().catch((e) => { console.error(e); process.exit(1); });
