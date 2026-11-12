// Nested sessions (lib/tools-sessions.mjs's start_session, lib/sessions-net.mjs): the parent's
// chat shows a session card for the tool call, the child nests under it in the sidebar, and the
// child's own chat opens with "Started by Claude from …" and a Task card. Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/sessions.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-sessions-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const api = await fx.startFakeApi({ delay: 0 });
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'dddddddd-1111-2222-3333-444444444444');

  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 }, colorScheme: 'dark' });
  await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(app.base + '/#/s/' + sid);
  await page.waitForSelector('#thread .msg');
  await wait(500);

  async function send(text) { await page.fill('#input', text); await page.press('#input', 'Enter'); }
  const idle = () => until(async () => (await page.$eval('#send', (b) => b.title)) === 'Send', 30000);
  const threadText = () => page.$eval('#thread', (t) => t.innerText);
  const authedFetch = (p) => page.evaluate((p) => fetch(p, { headers: { Authorization: 'Bearer ' + localStorage.getItem('cr.token') } }).then((r) => r.json()), p);

  // Claude starts a nested session: the parent's chat gets a session card, the child shows up
  // nested in the sidebar, and the server records the link (lib/sessions-net.mjs).
  await send('[spawn] please');
  check('the session card for start_session appears in the parent chat', await until(() => page.isVisible('.session-card-btn')), 'no .session-card-btn');
  await idle();

  // Starting the child's own Claude Code process (against the fake API too) takes real wall
  // time, so the card's chevron only resolves a target once the server's link exists.
  check('the server links the new session to its parent, and the card learns its child id', await until(() => page.$eval('.session-card-btn', (b) => !!b.dataset.childId).catch(() => false), 30000));

  await page.reload();
  await page.waitForSelector('#thread .msg');
  await wait(500);
  check('the card still resolves its child id after a reload (childMeta re-fetched)', await until(() => page.$eval('.session-card-btn', (b) => !!b.dataset.childId).catch(() => false)));
  const childId = await page.$eval('.session-card-btn', (b) => b.dataset.childId).catch(() => null);
  check('the sidebar nests the child under its parent', await until(() => page.$eval('#session-list', (l) => !!l.querySelector('.session-item.session-child')).catch(() => false)));
  await page.screenshot({ path: path.join(SHOTS, 'sessions-card-and-sidebar.png') });

  // Open the child: it shows "Started by Claude from …" and the Task card (eat-17b).
  await page.evaluate((id) => { location.hash = '#/s/' + id; }, childId);
  await page.waitForSelector('#thread');
  check('the child opens with a "Started by Claude from" header', await until(() => page.$eval('#thread', (t) => t.textContent.includes('Started by Claude from')).catch(() => false)));
  check('...and a Task card with the prompt it was given', await until(() => page.$eval('#thread', (t) => t.textContent.includes('Task') && t.textContent.includes('Coast towns')).catch(() => false)));
  await page.screenshot({ path: path.join(SHOTS, 'sessions-child-header.png') });

  // ---------- sidebar sections and the "Group and sort" menu ----------
  // Real clicks throughout, not internal hooks: the heading's own act button only shows on
  // hover (CSS opacity), so it is clicked directly rather than via a (possibly 0-opacity) point.
  await page.evaluate((id) => { location.hash = '#/s/' + id; }, sid);
  await page.waitForSelector('#thread .msg');
  page.once('dialog', (d) => d.accept('Billing work'));
  await page.evaluate(() => document.querySelector('.project-group .proj-act[title="Group and sort"]').click());
  await until(() => page.isVisible('#filter-menu'));
  await page.evaluate(() => [...document.querySelectorAll('#filter-menu .menu-item')].find((b) => b.textContent.includes('New section')).click());
  check('a new section appears in the sidebar, even while empty', await until(() => page.$eval('#session-list', (l) => !!l.querySelector('.section-group')).catch(() => false)));

  // Move the open session into it from its own right-click menu.
  await page.evaluate((id) => { const row = document.querySelector(`.session-item[data-id="${CSS.escape(id)}"]`); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 })); }, sid);
  await until(() => page.isVisible('#ctx-menu'));
  await page.evaluate(() => [...document.querySelectorAll('#ctx-menu .menu-item')].find((b) => b.textContent.includes('Billing work')).click());
  check('moving a session into the section lists it there', await until(() => page.$eval('#session-list', (l) => { const g = l.querySelector('.section-group'); return !!g && /^1$/.test(g.querySelector('.cnt')?.textContent || ''); }).catch(() => false)));

  // Group by None: a Recents heading, no Project/Status buckets.
  await page.evaluate(() => document.querySelector('.project-group .proj-act[title="Group and sort"]').click());
  await until(() => page.isVisible('#filter-menu'));
  await page.evaluate(() => [...document.querySelectorAll('#filter-menu .menu-item')].find((b) => b.textContent.includes('None')).click());
  check('grouping by None shows a Recents heading', await until(() => page.$eval('#session-list', (l) => [...l.querySelectorAll('.project-group > summary > span')].some((n) => n.textContent === 'Recents')).catch(() => false)));

  // Group by Status with "show empty groups" on: every bucket's heading shows, even at 0.
  await page.evaluate(() => document.querySelector('.project-group .proj-act[title="Group and sort"]').click());
  await until(() => page.isVisible('#filter-menu'));
  await page.evaluate(() => [...document.querySelectorAll('#filter-menu .menu-item')].find((b) => b.textContent.includes('Status')).click());
  await page.evaluate(() => document.querySelector('.project-group .proj-act[title="Group and sort"]').click());
  await until(() => page.isVisible('#filter-menu'));
  await page.evaluate(() => [...document.querySelectorAll('#filter-menu .menu-item')].find((b) => b.textContent.includes('Show empty groups')).click());
  check('"show empty groups" lists every Status bucket, even an empty one', await until(() => page.$eval('#session-list', (l) => l.querySelectorAll('.project-group').length >= 5).catch(() => false)));
  await page.screenshot({ path: path.join(SHOTS, 'sessions-sections-and-grouping.png') });

  // The prefs just set are shared with the server (lib/sessions-net.mjs), not only localStorage.
  const serverPrefs = await authedFetch('/api/sidebar/prefs');
  check('"Group and sort" choices are saved server-side too', serverPrefs.groupBy === 'state' && serverPrefs.showEmptyGroups === true, JSON.stringify(serverPrefs));

  // ---------- /btw side chat ----------
  await page.evaluate(() => document.querySelector('.project-group .proj-act[title="Group and sort"]').click());
  await until(() => page.isVisible('#filter-menu'));
  await page.evaluate(() => [...document.querySelectorAll('#filter-menu .menu-item')].find((b) => b.textContent.includes('Project')).click());
  const threadBefore = await threadText();
  await send('/btw Q1 what is the capital');
  await wait(600);
  check('the side chat does not add anything to the main thread', (await threadText()) === threadBefore);
  check('a side-chat tab opens in its own pane', await until(() => page.isVisible('#btw-panel:not(.hidden)')));
  check('...with the question as the tab label', await page.$eval('#btw-tabs .pv-tab', (t) => t.title.includes('Q1')));
  check('the side chat answers (the tab shows Claude\'s reply)', await until(() => page.$eval('#btw-stage', (s) => s.textContent.includes('Answer to: Q1')).catch(() => false), 15000));
  await page.screenshot({ path: path.join(SHOTS, 'sessions-btw-pane.png') });

  // The forked session is real but unlisted - never in the sidebar or the main-chat session tools.
  const sideIds = await authedFetch(`/api/sessions/${sid}/side-chats`);
  check('the server tracks the side chat against this session', sideIds.tabs?.length === 1);
  const listed = await authedFetch('/api/sessions?limit=200');
  check('the side chat never appears in the sidebar\'s own session list', !listed.some((s) => s.id === sideIds.tabs[0].id));

  // Closing the tab discards it: the server stops tracking it and the panel closes.
  await page.click('#btw-tabs .pv-tab-x');
  check('closing the tab closes the panel (nothing left to show)', await until(() => page.$eval('#btw-panel', (el) => el.classList.contains('hidden')).catch(() => false)));
  const sideIdsAfter = await authedFetch(`/api/sessions/${sid}/side-chats`);
  check('...and discards the forked session server-side', sideIdsAfter.tabs?.length === 0);

  check('no errors in the app', !errors.length, errors.join(' | '));
  await browser.close();

  // iPhone WebKit: the sidebar's nested row fits the narrow width.
  {
    const b2 = await webkit.launch({ headless: true });
    const c2 = await b2.newContext(devices['iPhone 15 Pro Max']);
    await c2.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    const p2 = await c2.newPage();
    const errs2 = []; p2.on('pageerror', (e) => errs2.push(e.message));
    await p2.goto(app.base + '/#/s/' + sid);
    await p2.waitForSelector('#thread .msg');
    await p2.evaluate(() => document.querySelector('#app').classList.add('sidebar-open'));
    const wide = await until(() => p2.$eval('#session-list', (l) => [...l.querySelectorAll('.session-item.session-child')].every((n) => n.getBoundingClientRect().right <= window.innerWidth + 1)).catch(() => false));
    check('iphone: a nested row fits the screen', wide);
    await p2.screenshot({ path: path.join(SHOTS, 'sessions-iphone-sidebar.png') });
    check('iphone: no errors in the app', !errs2.length, errs2.join(' | '));
    await b2.close();
  }

  console.log(`\n${passed} passed, ${failed} failed · screenshots in test/ui/shots`);
  await Promise.race([app.stop(), wait(5000)]);
  await api.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
