// Claude's voice in this app, with the real Claude Code talking to the fake Anthropic API:
//   - every request Claude Code makes for a turn carries the app's own instructions
//     (lib/app-prompt.mjs, appended to Claude Code's system prompt);
//   - while Claude works, the live line shows Claude Code's one-line label for the work in hand
//     ("Listed project files") with a ticking timer, as Desktop does;
//   - a finished group of tool calls is titled with those labels ("Listed project files, waited for the build");
//   - a link to a terminal tab or a session in a message opens it.
// Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/app-voice.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-app-voice-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'budget.csv'), 'item,cost\nflights,420\n');
  const api = await fx.startFakeApi();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'abababab-1111-2222-3333-444444444444');
  const browsers = [];
  try {
    async function open(type, opts) {
      const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
      browsers.push(browser);
      const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
      await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
      const page = await ctx.newPage();
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(app.base + '/#/s/' + sid);
      await page.waitForSelector('#thread .msg');
      return { page, errors };
    }
    async function send(page, text) { await page.fill('#input', text); await page.press('#input', 'Enter'); }
    const idle = (page) => until(async () => (await page.$eval('#send', (b) => b.title)) === 'Send', 30000);
    const live = (page) => page.$eval('.status-line', (n) => ({ text: n.querySelector('.shimmer').textContent, meta: n.querySelector('.status-meta').textContent }));

    const { page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });

    // 1. The live line: Claude Code's label for the round just done, and the turn's time ticking on.
    const before = api.bodies.length;
    await send(page, '[summary] check the project builds');
    check('while Claude works, the live line shows the label of the work in hand', await until(async () => (await live(page)).text === 'Listed project files', 20000), JSON.stringify(await live(page).catch(() => null)));
    const t0 = (await live(page)).meta;
    check('...with a timer that ticks', await until(async () => { const l = await live(page); return l.text === 'Listed project files' && l.meta !== t0; }, 2500), t0);
    await page.screenshot({ path: path.join(SHOTS, 'app-voice-live-line.png') });

    // 2. The finished group is titled with what was done, round by round.
    check('the turn ends', await idle(page));
    const label = await page.$eval('#thread details.tool-group:last-of-type > summary', (n) => n.textContent).catch(() => '');
    check('a finished group is titled with Claude Code\'s labels', await until(async () => (await page.$$eval('#thread details.tool-group > summary', (ns) => ns.map((n) => n.textContent))).includes('Listed project files, waited for the build'), 5000), label);
    await page.screenshot({ path: path.join(SHOTS, 'app-voice-finished-group.png') });

    // 3. The app's instructions reach Claude Code: every request of the turn that can use tools carries them.
    const turn = api.bodies.slice(before).filter((b) => Array.isArray(b.tools) && b.tools.length);
    const sys = (b) => JSON.stringify(b.system || '');
    check('the turn\'s requests carry the app\'s instructions', turn.length >= 3 && turn.every((b) => sys(b).includes('You are running inside claude-anywhere')), `${turn.length} requests`);
    check('...naming the app\'s own tools', turn.length > 0 && sys(turn[0]).includes('mcp__claude-anywhere__SuggestNextSteps') && sys(turn[0]).includes('mcp__claude-anywhere__create_artifact'));
    const labels = api.bodies.slice(before).filter((b) => sys(b).includes('short summary label'));
    check('each round of tool calls got its own label request', labels.length >= 2, String(labels.length));

    // 4. Links Claude is asked to write: a terminal tab opens the Terminal pane, a session link goes to that session.
    await send(page, `[link:${sid}] where is it`);
    check('a terminal tab link is drawn as a link', await until(() => page.isVisible('#thread a.term-link'), 15000));
    check('...and a session link points at the session', (await page.getAttribute('#thread a:has-text("the other chat")', 'href').catch(() => '')) === '#/s/' + sid);
    await idle(page);
    await page.click('#thread a.term-link');
    check('clicking a terminal link opens the Terminal pane', await until(() => page.isVisible('#terminal-panel:not(.hidden)'), 8000));
    check('...and says so when that tab is gone', await until(async () => (await page.$eval('#thread', (t) => t.innerText)).includes('That terminal tab is closed.'), 8000));
    check('no page errors on the desktop', errors.length === 0, errors.join(' | '));

    // 5. The phone: the long label still fits the live line's row (WebKit, as on an iPhone).
    const phone = await open(webkit, { ...devices['iPhone 15 Pro Max'] });
    await phone.page.fill('#input', '[summary] once more on the phone'); await phone.page.tap('#send'); // Enter is a new line on a phone
    check('on the phone the live line shows the label too', await until(async () => (await live(phone.page)).text === 'Listed project files', 20000));
    const fits = await phone.page.$eval('.status-line', (n) => n.scrollWidth <= n.clientWidth + 1 && n.getBoundingClientRect().right <= window.innerWidth + 1);
    check('...and fits the screen', fits);
    await phone.page.screenshot({ path: path.join(SHOTS, 'app-voice-phone.png') });
    await idle(phone.page);
    check('no page errors on the phone', phone.errors.length === 0, phone.errors.join(' | '));
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
    await app.stop(); await api.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
