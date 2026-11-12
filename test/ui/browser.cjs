// The Browser pane in a real browser, done the way a person would do it, with screenshots
// in test/ui/shots/. Starts its own app and dev server on throwaway data.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/browser.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
//
// Desktop in Chromium; an iPhone in WebKit; 390 px in Chromium; and the fallback, with the
// Browser's own ports made unreachable as they are behind `tailscale serve`.
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const SHOTS = path.join(__dirname, 'shots');
const channel = process.env.PW_CHANNEL || undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail = '') { ok ? passed++ : failed++; console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail && !ok ? '  — ' + detail : '')); }
const until = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(150); } return false; };

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-'));
  const project = fx.makeProject(path.join(tmp, 'project'));
  const sid = fx.makeSession(path.join(tmp, 'claude'), project.dir);
  const dev = await fx.startDevServer();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: { CLAUDE_ANYWHERE_BROWSER: 'off' } }); // the iframe pane; test/ui/browser-real.cjs has the real one
  fs.mkdirSync(SHOTS, { recursive: true });
  const page_ = path.join(project.site, 'index.html'), page2 = path.join(project.site, 'page2.html'), pdf = path.join(project.site, 'report.pdf');

  async function open(type, ctxOpts, { fallback = false, before = null } = {}) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'light', ...ctxOpts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    // The servers this computer is running are the test's, whatever else the machine has open.
    await ctx.route('**/api/preview/ports', (r) => r.fulfill({ json: { ports: [{ port: dev.port, pid: 0, process: 'node', label: 'Node', http: true, status: 200, server: '', title: 'Test app', serves: true, dev: true }] } }));
    if (fallback) await ctx.route('**/__claude-anywhere/ping', (r) => r.abort());
    if (before) await before(ctx);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + sid);
    await page.waitForSelector('#thread a.file-link');
    const pane = {
      addr: () => page.$eval('#pv-addr', (i) => i.value),
      tabs: () => page.$$eval('#pv-tabs .pv-tab', (ts) => ts.map((t) => (t.classList.contains('on') ? '*' : '') + t.querySelector('.pv-tab-name').textContent)),
      front: () => page.$eval('#pv-stage', (s) => [...s.children].find((x) => !x.classList.contains('hidden'))?.src || ''),
      async frame() { const src = await pane.front(); return page.frames().find((f) => src && f.url().startsWith(src.split('?')[0].replace(/\/$/, ''))); },
      async eval(fn) { for (let i = 0; i < 40; i++) { const f = await pane.frame(); if (f) { try { return await f.evaluate(fn); } catch {} } await wait(150); } return null; },
    };
    return { browser, ctx, page, errors, pane };
  }
  // Desktop shots leave out the sidebar: it shows the account, and the pane is the point.
  const shot = (page, name, clip) => page.screenshot({ path: path.join(SHOTS, name + '.png'), ...(clip ? { clip } : {}) });

  // ---------- desktop ----------
  {
    const { browser, page, errors, pane } = await open(chromium, { viewport: { width: 1380, height: 860 } });
    const clip = { x: 300, y: 0, width: 1080, height: 860 };
    await page.keyboard.press('Control+Shift+B');
    await page.waitForSelector('#preview-panel:not(.hidden)');
    check('Ctrl+Shift+B opens the Browser on the dev server', await until(async () => (await pane.addr()) === `localhost:${dev.port}/`), await pane.addr());
    await until(async () => (await pane.eval(() => document.getElementById('page')?.textContent)) === 'Home');
    const f = await pane.eval(() => ({ page: document.getElementById('page').textContent, href: location.href, color: getComputedStyle(document.querySelector('h1')).color, token: document.getElementById('token').textContent }));
    check('the app\'s router sees its own paths: Home, not "Not found"', f?.page === 'Home', JSON.stringify(f));
    check('it is served from a port of its own, at the root', /^http:\/\/127\.0\.0\.1:\d+\/$/.test(f?.href || '') && !(f?.href || '').includes(':' + dev.port + '/'), f?.href);
    check('its CSS, at an absolute path, loads', f?.color === 'rgb(10, 120, 10)', f?.color);
    check('its hot-reload socket connects', await until(async () => /live/.test((await pane.eval(() => document.getElementById('ws').textContent)) || '')));
    check('it cannot read the app\'s sign-in token or key', /visible here: none · cookies: \(none\)/.test(f?.token || ''), f?.token);
    check('the tab takes the page\'s title', await until(async () => (await pane.tabs()).includes('*Test app · Home')), (await pane.tabs()).join(', '));

    await (await pane.frame()).click('#to-about');
    check('a link inside the page updates the bar', await until(async () => (await pane.addr()) === `localhost:${dev.port}/about`), await pane.addr());
    await page.click('#pv-back');
    check('Back goes back inside the page', await until(async () => (await pane.eval(() => document.getElementById('page').textContent)) === 'Home'));
    check('...and leaves the app on its session', page.url().endsWith('#/s/' + sid), page.url());
    await page.click('#pv-fwd');
    check('Forward goes forward', await until(async () => (await pane.addr()) === `localhost:${dev.port}/about`));
    await (await pane.frame()).click('#sign-in');
    check('signing in inside the page sticks across its reload', await until(async () => /Signed in as arya/.test((await pane.eval(() => document.getElementById('login').textContent)) || '')));
    await (await pane.frame()).click('#to-home');
    await until(async () => (await pane.eval(() => location.pathname)) === '/');
    const before = await pane.eval(() => performance.timeOrigin);
    await (await pane.frame()).click('#to-go');
    check('a redirect to localhost stays inside the pane', await until(async () => { const r = await pane.eval(() => ({ p: location.pathname, o: performance.timeOrigin })); return r && r.p === '/about' && r.o !== before; }));
    check('...and the bar follows it', await until(async () => (await pane.addr()) === `localhost:${dev.port}/about`));
    await shot(page, 'desktop-dev-server', clip);

    const kept = await pane.eval(() => { window.__kept = 1; return performance.timeOrigin; });
    await page.click('#pv-new');
    await page.waitForSelector('.pv-start-item');
    check('a new tab starts on a page listing what is being served', (await page.textContent('.pv-start')).includes(`localhost:${dev.port}`));
    await shot(page, 'desktop-new-tab', clip);
    await page.fill('#pv-addr', page_);
    await page.press('#pv-addr', 'Enter');
    await until(async () => /Visits/.test((await pane.eval(() => document.getElementById('count')?.textContent)) || ''));
    const g = await pane.eval(() => ({ color: getComputedStyle(document.getElementById('h')).color, img: document.getElementById('img').naturalWidth, count: document.getElementById('count').textContent }));
    check('a file path in the bar opens the page, with its CSS', g?.color === 'rgb(200, 30, 30)', JSON.stringify(g));
    check('...its picture', g?.img > 0, JSON.stringify(g));
    check('...and its script, with localStorage', g?.count === 'Visits: 1', JSON.stringify(g));
    check('the bar shows the file\'s path', (await pane.addr()) === page_, await pane.addr());
    await page.click('#pv-reload');
    check('Reload reloads it', await until(async () => (await pane.eval(() => document.getElementById('count')?.textContent)) === 'Visits: 2'));
    await (await pane.frame()).click('#next');
    check('a link to another file follows in the same tab', await until(async () => (await pane.addr()) === page2), await pane.addr());
    check('...named after that page', await until(async () => (await pane.tabs()).includes('*Page two')), (await pane.tabs()).join(', '));
    await page.click('#pv-back');
    check('Back returns to the report', await until(async () => (await pane.addr()) === page_));
    await shot(page, 'desktop-html-page', clip);

    await page.click('#pv-tabs .pv-tab >> nth=0');
    check('switching tabs keeps the page as it was', (await pane.eval(() => window.__kept && performance.timeOrigin)) === kept);

    await page.click('#thread a.file-link:has-text("report.pdf")');
    check('the chat\'s PDF link opens a PDF tab', await until(async () => /report\.pdf$/.test(await pane.front())), await pane.front());
    check('...with its path in the bar', await until(async () => (await pane.addr()) === pdf), await pane.addr());
    await wait(1500);
    await shot(page, 'desktop-pdf', clip);
    const count = (await pane.tabs()).length;
    await page.click('#thread a.file-link:has-text("site/index.html")');
    check('the chat\'s page link finds the tab it already has', await until(async () => (await pane.addr()) === page_) && (await pane.tabs()).length === count, (await pane.tabs()).join(', '));
    await page.click('#pv-tabs .pv-tab.on .pv-tab-x');
    const left = (await pane.tabs()).length;
    check('× closes a tab', left === count - 1);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('chat-title')?.textContent === 'Report and PDF');
    await page.keyboard.press('Control+Shift+B');
    check('the tabs are still there after the app reloads', await until(async () => (await pane.tabs()).length === left), (await pane.tabs()).join(', '));

    // From the Files panel: a page renders in the Browser, it does not print its source.
    await page.click('#pv-close');
    await page.click('#session-menu-btn');
    await page.click('.menu-item:has-text("Files")');
    await page.waitForSelector('#files-panel:not(.hidden)');
    await page.click('.fx-row:has-text("site")');
    await page.waitForSelector('.fx-row:has-text("index.html")');
    await page.click('.fx-row:has-text("index.html")');
    check('an HTML file from the Files panel opens the Browser', await until(async () => !(await page.$eval('#preview-panel', (p) => p.classList.contains('hidden')))));
    check('...rendered, not shown as source', await until(async () => (await pane.eval(() => getComputedStyle(document.getElementById('h')).color)) === 'rgb(200, 30, 30)'), 'the page did not render');
    check('...and the Files panel is not left showing markup', await page.$eval('#fx-view', (n) => !/<!doctype|<html/i.test(n.textContent)));
    await shot(page, 'desktop-files-html', clip);
    check('desktop: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  // ---------- phones ----------
  for (const [label, type, opts] of [['iphone', webkit, devices['iPhone 15 Pro Max']], ['390', chromium, { ...devices['iPhone 15 Pro Max'], viewport: { width: 390, height: 780 } }]]) {
    const { browser, ctx, page, errors, pane } = await open(type, { ...opts, colorScheme: 'dark' });
    await page.click('#session-menu-btn');
    await page.click('.menu-item:has-text("Browser")');
    await until(async () => (await pane.eval(() => document.getElementById('page')?.textContent)) === 'Home');
    check(`${label}: the dev server opens from the session menu, its router intact`, (await pane.eval(() => document.getElementById('page')?.textContent)) === 'Home');
    check(`${label}: its hot-reload socket connects`, await until(async () => /live/.test((await pane.eval(() => document.getElementById('ws').textContent)) || '')));
    const box = await page.$eval('#preview-panel', (p) => { const r = p.getBoundingClientRect(); return { x: r.x, w: Math.round(r.width), vw: innerWidth, page: document.documentElement.scrollWidth }; });
    check(`${label}: the pane fills the screen, nothing wider than it`, box.x === 0 && box.w === box.vw && box.page === box.vw, JSON.stringify(box));
    await shot(page, `${label}-dev-server`);
    await page.click('#pv-close');
    await page.click('#thread a.file-link:has-text("site/index.html")');
    await until(async () => /Visits/.test((await pane.eval(() => document.getElementById('count')?.textContent)) || ''));
    const g = await pane.eval(() => ({ color: getComputedStyle(document.getElementById('h')).color, img: document.getElementById('img').naturalWidth }));
    check(`${label}: the chat's page link opens it, styled, with its picture`, g?.color === 'rgb(200, 30, 30)' && g?.img > 0, JSON.stringify(g));
    await shot(page, `${label}-html-page`);
    if (label === 'iphone') {
      // An iPhone shows only the first page of a PDF in a frame: it goes to Safari's viewer.
      // Playwright's WebKit has no PDF viewer of its own, so what is checked is the fetch.
      await page.click('#pv-close');
      let got = null;
      ctx.on('page', (p) => p.on('response', (r) => { if (/report\.pdf$/.test(r.url()) && r.status() === 200) got = r.headers()['content-type']; }));
      await page.click('#thread a.file-link:has-text("report.pdf")');
      check('iphone: the PDF opens in a page of its own, for Safari\'s viewer', await until(() => got === 'application/pdf'), String(got));
    }
    check(`${label}: no errors in the app`, !errors.length, errors.join(' | '));
    await browser.close();
  }

  // ---------- the fallback: one https port, no ports of our own ----------
  {
    const { browser, page, errors, pane } = await open(chromium, { viewport: { width: 1380, height: 860 } }, { fallback: true });
    await page.keyboard.press('Control+Shift+B');
    await until(async () => /\/preview\//.test(await pane.front()));
    check('fallback: the dev server comes through /preview/<port>/', (await pane.front()).includes('/preview/' + dev.port + '/'), await pane.front());
    check('fallback: its hot-reload socket still connects', await until(async () => /live/.test((await pane.eval(() => document.getElementById('ws')?.textContent)) || '')));
    await page.click('#thread a.file-link:has-text("site/index.html")');
    await until(async () => /Visits|Storage/.test((await pane.eval(() => document.getElementById('count')?.textContent)) || ''));
    const g = await pane.eval(() => ({ color: getComputedStyle(document.getElementById('h')).color, count: document.getElementById('count').textContent }));
    check('fallback: a page is shown sandboxed, styled, without storage', g?.color === 'rgb(200, 30, 30)' && /SecurityError/.test(g?.count || ''), JSON.stringify(g));
    check('fallback: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  // ---------- a server older than the page: it hands out no key, so it has no files ----------
  // The page is read fresh from disk while the server process keeps running the code it
  // started with, until someone restarts it. Its answer to the key request is the old one.
  {
    let restartAsked = false;
    const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } }, { before: async (ctx) => {
      await ctx.route('**/api/preview/grant', (r) => r.fulfill({ json: { ok: true } }));
      await ctx.route('**/api/restart', (r) => { restartAsked = true; r.fulfill({ json: { ok: true, restarting: false, queued: true, liveRuns: 1 } }); });
      await ctx.route('**/api/me', async (r) => { const j = await (await r.fetch()).json(); r.fulfill({ json: { ...j, host: 'studio-pc' } }); });
    } });
    await page.click('#thread a.file-link:has-text("site/index.html")');
    await page.waitForSelector('#pv-stage .pv-card:not(.hidden)');
    const card = await page.textContent('#pv-stage .pv-card:not(.hidden)');
    check('old server: the tab says the server is older than the page', /“studio-pc” is older than this page/.test(card), card);
    check('old server: no frame is pointed at /files//… (the "Cannot GET")', !(await page.$$eval('#pv-stage iframe', (fs) => fs.some((f) => /\/files\/\//.test(f.src)))));
    check('old server: "open in your browser" is off, it would lead nowhere', await page.$eval('#pv-open', (b) => b.disabled));
    await shot(page, 'desktop-old-server', { x: 300, y: 0, width: 1080, height: 860 });
    await page.click('#pv-stage .pv-card button:has-text("Restart server")');
    check('old server: Restart server asks the server to restart', await until(() => restartAsked));
    check('old server: and says it waits for the turn to end', await until(async () => /restarts by itself/.test(await page.textContent('#pv-stage .pv-card:not(.hidden)'))));
    check('old server: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed · screenshots in ${path.relative(process.cwd(), SHOTS) || SHOTS}`);
  process.exitCode = failed ? 1 : 0;
  // The verdict is out first; tidying up gets a few seconds and no say in it.
  await Promise.race([Promise.all([app.stop(), dev.close()]), wait(5000)]);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
main().catch((e) => { console.error(e); process.exit(1); });
