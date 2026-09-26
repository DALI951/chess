/**
 * Open the site in a REAL, VISIBLE browser window and leave it open for Dali.
 *
 * The headless suites prove the app works; they cannot show it to anybody. This
 * launches the same Chromium the tests use, but headful, sized for a phone
 * review, and then leaves the window alone so Dali can click around himself.
 *
 *   node tools/open.mjs            # phone-sized window, Arabic
 *   node tools/open.mjs --en       # English / LTR
 *   node tools/open.mjs --desktop  # 1280x900
 *   node tools/open.mjs --url http://127.0.0.1:8081/
 *
 * @author DALI951
 */
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name) => process.argv.includes('--' + name);
const value = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const root = join(process.env.LOCALAPPDATA || process.env.HOME || '', 'ms-playwright');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = join(root, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const exe = findChrome();
if (!exe) {
  console.error('No Chromium found. Run:  npx playwright install chromium');
  process.exit(1);
}

const url = value('url', 'http://127.0.0.1:8080/');
const desktop = arg('desktop');
const viewport = desktop ? { width: 1280, height: 900 } : { width: 414, height: 896 };

const browser = await chromium.launch({
  executablePath: exe,
  headless: false,
  args: ['--start-maximized'],
});
const context = await browser.newContext({
  viewport,
  locale: arg('en') ? 'en-US' : 'ar-TN',
  deviceScaleFactor: 2,
});
const page = await context.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });

// Leave the window open. Exiting the script must NOT close the browser, or
// Dali gets a flash of a window and then nothing.
process.on('exit', () => { /* browser stays alive on purpose */ });
await new Promise(() => {});

if (errors.length) {
  console.error('console errors on load:', errors);
}
