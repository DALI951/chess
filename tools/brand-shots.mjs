/**
 * Screenshot the three brand options so Dali can look at them on his phone.
 *
 *   node tools/brand-shots.mjs
 *
 * Writes brand/shots/brand-full.png, phone-<name>.png, desktop-<name>.png.
 *
 * @author DALI951
 */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = pathToFileURL(join(HERE, '..', 'brand', 'index.html')).href;
const OUT = join(HERE, '..', 'brand', 'shots');

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const root = join(process.env.LOCALAPPDATA || process.env.HOME || '', 'ms-playwright');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const p = join(root, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const exe = findChrome();
if (!exe) { console.error('No Chromium found:  npx playwright install chromium'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, headless: true });
const errors = [];

// one shot per card, at phone width: that is where he will actually judge it
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'en-US' });
const p1 = await phone.newPage();
p1.on('pageerror', (e) => errors.push(String(e)));
await p1.goto(PAGE, { waitUntil: 'networkidle' });

const names = await p1.locator('.card .name b').allTextContents();
console.log('brands found:', names.join(', '));

for (let i = 0; i < names.length; i++) {
  const card = p1.locator('.card').nth(i);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: join(OUT, `phone-${names[i].toLowerCase()}.png`) });
  console.log('  ok   phone-' + names[i].toLowerCase() + '.png');
}
await p1.screenshot({ path: join(OUT, 'brand-full.png'), fullPage: true });
console.log('  ok   brand-full.png');
await phone.close();

const desk = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5, locale: 'en-US' });
const p2 = await desk.newPage();
await p2.goto(PAGE, { waitUntil: 'networkidle' });
await p2.screenshot({ path: join(OUT, 'brand-desktop.png'), fullPage: true });
console.log('  ok   brand-desktop.png');
await desk.close();

await browser.close();
if (errors.length) { console.error('page errors:', errors); process.exit(1); }
console.log('\nBRAND SHOTS DONE -> brand/shots/');
