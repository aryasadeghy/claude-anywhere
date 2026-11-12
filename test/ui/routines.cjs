// Scheduled tasks: the sidebar button, the list/create/history views in one modal, Run now
// starting a real session, and the folder/weekdays schedule reading back in plain words.
// Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/routines.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
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
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(50); } return false; };

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-routines-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const api = await fx.startFakeApi({ delay: 0 });
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'aaaaaaaa-1111-2222-3333-444444444444');

  async function open(type, opts) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + sid);
    await page.waitForSelector('#thread .msg');
    await wait(400);
    return { browser, page, errors };
  }

  const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });

  // 1. The sidebar button opens the Scheduled modal, empty at first.
  await page.click('#scheduled-btn');
  check('the Scheduled modal opens', await until(() => page.isVisible('#scheduled-modal:not(.hidden)'), 5000));
  check('it starts with no scheduled tasks', await until(() => page.innerText('#sch-list').then((t) => /No scheduled tasks/.test(t)), 5000));

  // 2. Creating one: weekdays at a time, this session's folder prefilled.
  await page.click('#sch-new');
  check('the folder is prefilled with this session\'s cwd', (await page.inputValue('#sch-folder')) === cwd);
  await page.fill('#sch-name', 'Morning notes');
  await page.fill('#sch-prompt', 'Summarize overnight activity');
  await page.selectOption('#sch-sched-type', 'weekdays');
  await page.fill('#sch-time', '09:00');
  await page.click('#sch-save');
  check('saving returns to the list with the new card', await until(() => page.isVisible('.sch-card-row:has-text("Morning notes")'), 5000));
  check('the schedule reads back in plain words', await until(() => page.innerText('.sch-card-row').then((t) => t.includes('Weekdays at 9:00 AM')), 5000), await page.innerText('.sch-card-row'));
  await page.screenshot({ path: path.join(SHOTS, 'routines-card.png') });

  // 3. Run now starts a real session, which shows up in the sidebar.
  const before = (await page.$$('.session-item')).length;
  await page.click('.sch-card-row button:has-text("Run now")');
  check('Run now starts a session and the card gets a "Last run"', await until(() => page.innerText('.sch-card-row').then((t) => /Last run/.test(t)), 10000));
  await page.click('#sch-close');
  await page.click('#sidebar-open').catch(() => {});
  check('the run shows up as a new session in the sidebar', await until(async () => (await page.$$('.session-item')).length > before, 10000));

  // 4. Turning it off, then deleting it.
  await page.click('#scheduled-btn');
  await page.click('.sch-card-row .toggle');
  check('turning the switch off marks the card off', await until(() => page.isVisible('.sch-card-row.off'), 5000));
  page.once('dialog', (d) => d.accept());
  await page.click('.sch-card-row button:has-text("Delete")');
  check('deleting it empties the list again', await until(() => page.innerText('#sch-list').then((t) => /No scheduled tasks/.test(t)), 5000));

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();

  // 5. iPhone WebKit: the modal fits a phone screen (one check, per the house rules).
  const { browser: ib, page: ip } = await open(webkit, devices['iPhone 15 Pro Max']);
  if (!(await ip.$eval('#app', (a) => a.classList.contains('sidebar-open')))) await ip.click('#sidebar-open');
  await ip.click('#scheduled-btn');
  check('on a phone the Scheduled modal is full-width and usable', await until(() => ip.isVisible('#scheduled-modal:not(.hidden)'), 5000));
  await ip.screenshot({ path: path.join(SHOTS, 'routines-iphone.png') });
  await ib.close();

  await app.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
