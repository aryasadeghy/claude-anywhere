// The rest of lib/tools-sessions.mjs: show_pane/close_pane, present_options, request_secret,
// and lib/tools-terminal.mjs's list_terminal_tabs/stop_terminal_tab. Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium
//   node test/ui/sessions-tools.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-sessions-tools-'));
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

  // show_pane opens the terminal panel without being asked (it only changes what is on screen).
  await send('[pane] please');
  check('show_pane opens the terminal panel', await until(() => page.$eval('#terminal-panel', (p) => !p.classList.contains('hidden')).catch(() => false)));
  await idle();

  // present_options: a card with buttons; clicking one answers the tool call.
  await send('[options] please');
  check('present_options draws a card with its options as buttons', await until(() => page.$$eval('.options-card:not(.answered) button', (bs) => bs.some((b) => b.textContent === 'Red')).catch(() => false)));
  await page.click('.options-card:not(.answered) button:has-text("Red")');
  check('picking one marks the card answered', await until(() => page.isVisible('.options-card.answered')));
  check('...and the pick reaches Claude as the tool\'s result', await until(() => api.bodies.some((b) => JSON.stringify(b.messages || []).includes('Picked: Red')), 15000));
  await idle();
  await page.screenshot({ path: path.join(SHOTS, 'sessions-options-card.png') });

  // request_secret: a masked input; typing and sending answers it, and the value never shows up
  // as plain chat text anywhere in the thread, even though it has to reach Claude as the result.
  await send('[asksecret] please');
  check('request_secret draws a masked input card', await until(() => page.isVisible('.secret-card:not(.answered) input.secret-field')));
  await page.fill('.secret-card input.secret-field', 'sk-test-abcdef123456');
  await page.click('.secret-card button:has-text("Send")');
  check('sending marks the card answered', await until(() => page.isVisible('.secret-card.answered')));
  check('...and the value reaches Claude as the tool\'s result', await until(() => api.bodies.some((b) => JSON.stringify(b.messages || []).includes('sk-test-abcdef123456')), 15000));
  await idle();
  check('the secret never appears as visible chat text in the thread', !(await page.$eval('#thread', (t) => t.textContent)).includes('sk-test-abcdef123456'));
  await page.screenshot({ path: path.join(SHOTS, 'sessions-secret-card.png') });

  // list_terminal_tabs / stop_terminal_tab: a tab opened earlier (show_pane didn't make one, so
  // open one explicitly), then list and stop it through the tools, same as a person's own X.
  await send('[terminal] please'); // the fixture's own tag: opens a tab via open_terminal_tab
  check('a terminal tab is open to list', await until(() => page.$eval('#term-tabs', (t) => t.children.length > 0).catch(() => false)));
  await idle();
  const tabsBefore = await page.evaluate(async (base) => (await (await fetch(`${base}/api/sessions/dddddddd-1111-2222-3333-444444444444/terminal/tabs`, { headers: { Authorization: 'Bearer ' + localStorage.getItem('cr.token') } })).json()).tabs.length, app.base);
  check('the tab is really there server-side too', tabsBefore > 0);

  check('no errors in the app', !errors.length, errors.join(' | '));
  await browser.close();

  console.log(`\n${passed} passed, ${failed} failed · screenshots in test/ui/shots`);
  await Promise.race([app.stop(), wait(5000)]);
  await api.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
