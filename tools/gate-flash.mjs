/**
 * Does the gate flash for somebody who is already signed in?
 *
 * The gate is in the markup and shown by default, so it is on screen before
 * the session check answers. For a returning player that is a red login card
 * flashing in the face of somebody who is already logged in. This samples the
 * gate's visibility from before the first paint and reports whether it was ever
 * seen, so "it only flashes for a moment" stops being a matter of opinion.
 */
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function findChrome() {
  for (const p of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe']) if (existsSync(p)) return p;
  const root = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (existsSync(root)) for (const d of readdirSync(root).filter(x => x.startsWith('chromium-')).sort().reverse())
    for (const r of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const p = join(root, d, r); if (existsSync(p)) return p;
    }
  return null;
}

const URL_ = process.env.CHESS_URL || 'http://127.0.0.1:8080/';
const ME_DELAY = Number(process.env.ME_DELAY || 700);

// Runs before anything on the page. Watches the gate from the moment it exists,
// because a flash that is gone before the first screenshot is still a flash.
// Nothing in here may throw: at init-script time documentElement can still be
// null, and a sampler that died silently would report "never seen" forever.
const SAMPLER = `(() => {
  window.__gateSeen = 0;
  window.__gateSamples = 0;
  let obs = null;
  const look = () => {
    try {
      const g = document.getElementById('gate');
      if (!g) return;
      window.__gateSamples++;
      if (getComputedStyle(g).display !== 'none') window.__gateSeen++;
      if (!obs && document.documentElement) {
        obs = new MutationObserver(look);
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      }
    } catch (e) { /* a sampler must never break the page it is measuring */ }
  };
  const t = setInterval(look, 8);
  // Deliberately never cleared: sampling has to outlast the load event, because
  // the whole question is what the gate does AFTER the page is up but BEFORE the
  // session check answers.
  window.addEventListener('load', look);
})()`;

let fails = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ok   ${label}${detail ? '  -> ' + detail : ''}`);
  else { fails++; console.log(`  FAIL ${label}${detail ? '  -> ' + detail : ''}`); }
};

const browser = await chromium.launch({ executablePath: findChrome() });

async function run(label, { sessionDelay, signedIn, hint }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(SAMPLER);
  if (hint) await ctx.addInitScript(() => { try { localStorage.setItem('chess.wasSignedIn', '1'); } catch {} });
  const page = await ctx.newPage();

  // A slow session check is the worst case: the longer the answer takes, the
  // longer a wrongly-shown gate would sit there.
  await page.route('**/api/auth.php', async (route) => {
    const body = route.request().postData() || '';
    if (body.includes('"me"') || body.includes('action=me')) {
      await new Promise((r) => setTimeout(r, sessionDelay));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(signedIn
          ? { user: { id: 7, username: 'returning', display_name: 'Returning' } }
          : { user: null }),
      });
    }
    return route.continue();
  });

  await page.goto(URL_, { waitUntil: 'load' });
  const atLoad = await page.evaluate(() => {
    const g = document.getElementById('gate');
    return g ? getComputedStyle(g).display !== 'none' : false;
  });
  // Only a signed-in player ends with the gate gone. Waiting for a hidden gate
  // when the whole point is that it stays up just burns the timeout.
  if (signedIn) await page.waitForSelector('#gate', { state: 'hidden', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(sessionDelay + 400);
  const atEnd = await page.evaluate(() => {
    const g = document.getElementById('gate');
    return g ? getComputedStyle(g).display !== 'none' : false;
  });
  const seen = await page.evaluate(() => ({ seen: window.__gateSeen, samples: window.__gateSamples }));
  const who = await page.evaluate(() => (document.querySelector('#authPanel')?.textContent || '').trim());

  console.log(`\n-- ${label}`);
  ok(seen.samples > 20, 'the sampler actually watched the gate', `${seen.samples} samples`);
  if (signedIn) {
    ok(!!who, 'the account panel knows who is signed in', who || 'empty');
    ok(seen.seen === 0, 'a signed-in player never sees the gate',
       seen.seen ? `VISIBLE in ${seen.seen} of ${seen.samples} samples` : 'never visible');
  } else if (hint) {
    // A hint that turns out to be wrong must not strand anybody outside the app.
    // Late is the correct answer here; never is not.
    ok(!atLoad, 'a stale hint does not flash the gate it does not need', atLoad ? 'gate up at load' : 'held back');
    ok(atEnd, 'a stale hint still ends with the login card up', atEnd ? 'up' : 'MISSING');
  } else {
    ok(atLoad, 'a first-time player gets the login card on the first paint', atLoad ? 'up' : 'missing');
    ok(atEnd, 'and it is still up once the session check has answered', atEnd ? 'up' : 'MISSING');
  }
  await ctx.close();
}

console.log('\n=== somebody who has a session');
await run('returning player, normal network', { sessionDelay: 700, signedIn: true, hint: true });
await run('returning player, slow server', { sessionDelay: 1500, signedIn: true, hint: true });

console.log('\n=== somebody who has never signed in');
await run('new player, normal network', { sessionDelay: 700, signedIn: false, hint: false });
await run('new player, slow server', { sessionDelay: 1500, signedIn: false, hint: false });

console.log('\n=== the hint was wrong: cookie gone, hint still set');
await run('stale hint, session actually expired', { sessionDelay: 700, signedIn: false, hint: true });

await browser.close();
console.log('\n' + '='.repeat(60));
if (fails) { console.log(`${fails} gate-flash checks failed`); process.exit(1); }
console.log('GATE FLASH CLEAN');
