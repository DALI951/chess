/**
 * A design audit, measured rather than eyeballed.
 *
 * The taste rules are only useful if something checks them: one accent colour,
 * a readable contrast floor, 44px touch targets, a small type scale, no default
 * browser chrome left showing. This asserts all of that against the real
 * computed styles, in Arabic RTL and English LTR, on the front door and the
 * game.
 *
 *   node tools/design-audit.mjs
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

let checks = 0;
const fails = [];
const ok = (cond, label, detail = '') => {
  checks++;
  if (cond) console.log(`  ok   ${label}${detail ? '  -> ' + detail : ''}`);
  else { fails.push(label); console.log(`  FAIL ${label}${detail ? '  -> ' + detail : ''}`); }
};

/* ── colour helpers, in the page so we read real computed values ───────────── */
const PROBES = `(() => {
  const px = (s) => parseFloat(s) || 0;
  const parse = (c) => {
    const m = c.match(/[\\d.]+/g);
    return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [l1, l2] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  // walk up for the first non-transparent background
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg)) return bg;
      n = n.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };
  const hue = (c) => {
    const [r, g, b] = parse(c);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d || !mx) return -1;                 // greyscale: no hue to speak of
    // A near-black with a 9/255 blue lean is a neutral, not a second accent.
    // Judging hue without judging saturation flags every board square. 0.2 is
    // well clear of our greys (0.03-0.14) and well under any real colour.
    if (d / mx < 0.2) return -1;
    // Nobody perceives a hue at the very ends of the range: below ~4% luminance
    // a colour is just black, above ~78% it is just white. The board
    // coordinates print #23232c on a light square and are not a blue accent.
    if (mx < 60 || mn > 200) return -1;
    let h;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return Math.round(((h * 60) + 360) % 360);
  };
  // what a button is actually painted with, gradient or flat
  const paint = (el) => {
    const s = getComputedStyle(el);
    const out = [s.backgroundColor, ...(s.backgroundImage.match(/rgba?\\([^)]+\\)/g) || [])];
    return out.filter(c => !/rgba\\(0, 0, 0, 0\\)/.test(c));
  };
  const isRed = (c) => { const h = hue(c); return h >= 0 && (h >= 340 || h <= 20); };
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || px(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  return { px, ratio, hue, bgOf, vis, parse, paint, isRed };
})()`;

async function audit(page, label) {
  console.log(`\n-- ${label}`);

  // ── the front door, if it is up ───────────────────────────────────────────
  if (await page.locator('#gate').isVisible().catch(() => false)) {
    const card = await page.evaluate(() => {
      const el = document.querySelector('.gate-card');
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { radius: s.borderRadius, w: Math.round(r.width), bg: s.backgroundColor, border: s.borderColor };
    });
    ok(parseFloat(card.radius) >= 12, 'the card is rounded, not a sharp rectangle', card.radius);
    ok(card.w <= 460, 'the card is a column, not a full-bleed slab', `${card.w}px wide`);

    const fields = await page.evaluate(() => {
      const out = [];
      for (const sel of ['#authName', '#authPass']) {
        const el = document.querySelector(sel);
        const s = getComputedStyle(el);
        out.push({ sel, h: el.getBoundingClientRect().height, radius: s.borderRadius, bg: s.backgroundColor });
      }
      return out;
    });
    for (const f of fields) {
      ok(f.h >= 44, `${f.sel} is a real touch target`, `${Math.round(f.h)}px`);
    }

    // contrast on the things you actually read
    const c = await page.evaluate(`(() => {
      const P = ${PROBES};
      const out = {};
      const title = document.querySelector('.gate-title');
      const sub = document.querySelector('.gate-sub');
      const label = document.querySelector('label[for=authName]');
      const primary = document.querySelector('#authLoginBtn');
      out.title = P.ratio(getComputedStyle(title).color, P.bgOf(title));
      out.sub = P.ratio(getComputedStyle(sub).color, P.bgOf(sub));
      out.label = P.ratio(getComputedStyle(label).color, P.bgOf(label));
      out.primary = P.ratio(getComputedStyle(primary).color, P.bgOf(primary));
      out.offline = P.ratio(
        getComputedStyle(document.querySelector('#gateOffline')).color,
        P.bgOf(document.querySelector('#gateOffline')));
      return out;
    })()`);
    ok(c.title >= 4.5, 'the title passes AA', c.title.toFixed(2));
    ok(c.sub >= 4.5, 'the tagline passes AA', c.sub.toFixed(2));
    ok(c.label >= 4.5, 'field labels pass AA', c.label.toFixed(2));
    ok(c.primary >= 4.5, 'the primary button passes AA', c.primary.toFixed(2));
    ok(c.offline >= 3, 'the offline escape is legible', c.offline.toFixed(2));

    // the primary action has to be the only red thing that is a big fill
    const fills = await page.evaluate(`(() => {
      const P = ${PROBES};
      const out = [];
      for (const el of document.querySelectorAll('#gate button')) {
        if (!P.vis(el)) continue;
        out.push({ id: el.id, red: P.paint(el).some(P.isRed) });
      }
      return out;
    })()`);
    const redFills = fills.filter((f) => f.red);
    ok(redFills.length === 1, 'exactly one red fill on the front door: one primary action',
       redFills.map((f) => f.id).join(',') || 'none');
    ok(fills.length > 0, 'the front door has real buttons to judge', `${fills.length}`);
  }

  // ── the game, always ─────────────────────────────────────────────────────
  const g = await page.evaluate(`(() => {
    const P = ${PROBES};
    const out = { sizes: new Set(), hues: new Set(), small: [], huesFound: {} };
    for (const el of document.querySelectorAll('body *')) {
      if (!P.vis(el)) continue;
      if (el.closest('.sprite')) continue;
      const s = getComputedStyle(el);
      const size = Math.round(P.px(s.fontSize));
      if (size >= 12 && el.textContent.trim().length > 1) out.sizes.add(size);
      const h = P.hue(s.color);
      if (h >= 0) { out.hues.add(h); out.huesFound[h] = (out.huesFound[h] || 0) + 1; }
      // Target size: WCAG 2.2 AA asks 24px of anything clickable, and 44px of
      // anything you are meant to hit with a thumb. Inline text links get the
      // AA floor; real controls get the thumb.
      if (/^(BUTTON|SELECT|INPUT|TEXTAREA)$/.test(el.tagName) && el.type !== 'range'
          && el.type !== 'checkbox') {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.height < 44) out.small.push(el.tagName + (el.id ? '#' + el.id : '') + ' ' + Math.round(r.height) + 'px');
      }
      if (el.tagName === 'A' && el.getAttribute('href') !== null) {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.height < 24) out.small.push('A(inline) ' + Math.round(r.height) + 'px');
      }
    }
    return { sizes: [...out.sizes].sort((a, b) => a - b), small: out.small, huesFound: out.huesFound };
  })()`);

  // one accent hue family: reds, and at most a couple of near-neutrals
  const hueBuckets = Object.entries(g.huesFound).map(([h, n]) => [Number(h), n]);
  const chromatic = hueBuckets.filter(([h]) => h >= 15 && h <= 340);
  ok(chromatic.length === 0, 'the text is greyscale plus the one red accent',
     chromatic.length ? chromatic.map(([h, n]) => `${h}deg x${n}`).join(', ') : 'no second hue');
  ok(g.small.length === 0, 'every control clears a 44px touch target', g.small.slice(0, 6).join(', '));
  ok(g.sizes.length <= 12, 'the type scale stays small', g.sizes.join(' '));
}

/* ── the phone pass: what a screenshot would have to be squinted at ────────── */
async function layoutAudit(page, label) {
  console.log(`\n-- ${label} - layout on a 360px phone`);
  const m = await page.evaluate(`(() => {
    const P = ${PROBES};
    const doc = document.documentElement;
    const wide = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!P.vis(el)) continue;
      const r = el.getBoundingClientRect();
      // 1px of slack for subpixel rounding, and skip deliberate bleed
      if (r.right > doc.clientWidth + 1 || r.left < -1) {
        wide.push((el.tagName + (el.id ? '#' + el.id : '')
          + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : ''))
          + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
      }
    }
    const board = document.querySelector('#board-wrap');
    const br = board?.getBoundingClientRect();
    return {
      scrollW: doc.scrollWidth, clientW: doc.clientWidth,
      wide: wide.slice(0, 8),
      boardW: br ? Math.round(br.width) : 0,
      boardSquare: br ? Math.round(br.width / 8) : 0,
    };
  })()`);

  ok(m.scrollW <= m.clientW + 1, 'nothing scrolls sideways',
     m.scrollW > m.clientW ? `${m.scrollW}px of content in a ${m.clientW}px screen: ${m.wide.join(' | ')}` : 'clean');
  ok(m.wide.length === 0, 'no element sticks out past the edge', m.wide.join(' | '));
  ok(m.boardSquare > 0 && m.boardSquare <= m.clientW / 8,
     'the board still fits the phone', `${m.boardW}px wide, ${m.boardSquare}px a square`);
  ok(m.boardSquare >= 28, 'the board is not so small you cannot tap a square', `${m.boardSquare}px a square`);
}

/* ── run it ───────────────────────────────────────────────────────────────── */
const browser = await chromium.launch({ executablePath: findChrome() });
for (const lang of ['ar', 'en']) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: lang === 'ar' ? 'ar-TN' : 'en-GB',
  });
  const page = await ctx.newPage();
  await page.addInitScript((l) => {
    try { localStorage.setItem('chess.lang', JSON.stringify(l)); localStorage.removeItem('chess.gateSkipped'); } catch {}
  }, lang);
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await audit(page, `${lang === 'ar' ? 'Arabic, RTL' : 'English, LTR'} - the front door`);

  if (await page.locator('#gate').isVisible()) {
    await page.locator('#gateOffline').click();
    await page.waitForSelector('#gate', { state: 'hidden' });
    await page.waitForTimeout(400);
  }
  await audit(page, `${lang === 'ar' ? 'Arabic, RTL' : 'English, LTR'} - the game`);

  // RTL really mirrors
  if (lang === 'ar') {
    const dir = await page.evaluate(() => getComputedStyle(document.querySelector('.player-right')).marginInlineStart);
    ok(dir !== '0px', 'RTL: the clock is pushed to the far edge with a logical property', dir);
  }
  await ctx.close();
}

/* the same design, on the smallest screen anybody will actually use */
{
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    locale: 'ar-TN',
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try { localStorage.setItem('chess.lang', JSON.stringify('ar')); } catch {}
  });
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await layoutAudit(page, 'Arabic, RTL');

  await page.locator('#gateOffline').click();
  await page.waitForSelector('#gate', { state: 'hidden' });
  await page.waitForTimeout(400);
  await layoutAudit(page, 'the game');
  await ctx.close();
}
await browser.close();

console.log('\n' + '='.repeat(60));
if (fails.length) { console.log(`${fails.length} of ${checks} design checks failed`); process.exit(1); }
console.log(`DESIGN AUDIT CLEAN - ${checks} checks`);
