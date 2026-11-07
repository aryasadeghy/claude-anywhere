// Claude Desktop's message box, in a real browser against the real Claude Code (fake API):
//   - "/" opens a popover of the app's own commands and Claude Code's;
//   - "@" opens a fuzzy file picker for the session's folder;
//   - a message starting with "!" runs as a shell command and its output becomes context;
//   - Ctrl/Cmd+U opens the file picker, up to 20 images a message;
//   - clicking a staged image opens an annotate editor (pen, rectangle, arrow, text, undo);
//   - a microphone button dictates (hidden where the browser has no Web Speech API);
//   - number keys 1-9 pick an option on an open question card;
//   - selecting text in the thread offers "Attach as context", as removable chips above the box.
// Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/composer.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
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
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(100); } return false; };

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-composer-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  // A couple of real files, so "@" has something to find - including a dotfile, which Desktop
  // includes too ("Dotfiles show up in the file tree and @-mention search").
  fs.writeFileSync(path.join(cwd, 'notes.md'), '# Notes\n');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"demo"}');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'index.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules\n');
  const api = await fx.startFakeApi();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'dddddddd-5555-2222-3333-444444444444');

  async function open(type, opts) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', permissions: [], ...opts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + sid);
    await page.waitForSelector('#thread .msg');
    await wait(500);
    return { browser, page, errors };
  }
  const threadText = (page) => page.$eval('#thread', (t) => t.innerText);
  async function send(page, text) { await page.fill('#input', text); await page.press('#input', 'Enter'); }
  const idle = (page) => until(async () => (await page.$eval('#send', (b) => b.title)) === 'Send', 30000);

  const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });

  // 1. Selecting text in an assistant message offers "Attach as context"; clicking it makes a
  // removable chip above the box, and sending quotes it ahead of what was typed.
  await page.evaluate(() => {
    const p = document.querySelector('#thread .msg.assistant .prose p, #thread .msg.assistant .prose');
    const r = document.createRange(); r.selectNodeContents(p);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  });
  check('selecting thread text shows the floating button', await until(() => page.isVisible('#ctx-float-btn:not(.hidden)'), 4000));
  await page.screenshot({ path: path.join(SHOTS, 'composer-attach-as-context.png') });
  await page.click('#ctx-float-btn');
  check('...and a removable chip appears above the box', await until(() => page.isVisible('.ctx-chip'), 3000));
  await send(page, 'see above');
  const before = api.bodies.length;
  check('Claude reads the quoted context ahead of the message', await until(() => api.bodies.slice(before - 1).some((b) => JSON.stringify(b.messages || []).includes('> Done.')), 15000));
  check('the chip is gone once sent', !(await page.isVisible('.ctx-chip')));
  await idle(page);

  // 2. "/" opens a popover of the app's own commands and Claude Code's; arrows and Enter pick one.
  await page.fill('#input', '/');
  check('"/" opens the popover', await until(() => page.isVisible('#composer-pop .cpop-item'), 5000));
  const names = () => page.$$eval('#composer-pop .cpop-item .cpop-name', (ns) => ns.map((n) => n.textContent));
  check('the app\'s own commands are offered', (await names()).includes('/rename'), (await names()).join(', '));
  check('and Claude Code\'s own are too', (await names()).includes('/compact'), (await names()).join(', '));
  await page.screenshot({ path: path.join(SHOTS, 'composer-slash-menu.png') });
  await page.type('#input', 'comp');
  check('filters as you type', await until(async () => { const n = await names(); return n.length === 1 && n[0] === '/compact'; }, 3000), (await names()).join(', '));
  await page.press('#input', 'Enter');
  check('Enter inserts "/name " and closes the popover', await until(async () => (await page.inputValue('#input')) === '/compact ' && !(await page.isVisible('#composer-pop:not(.hidden) .cpop-item')), 3000), await page.inputValue('#input'));
  await page.fill('#input', '');

  // 3. An app command (/rename) runs here instead of reaching Claude Code.
  await send(page, '/rename Renamed from the box');
  check('/rename changes the title without a turn', await until(async () => (await page.$eval('#chat-title', (n) => n.textContent)) === 'Renamed from the box', 8000), await page.$eval('#chat-title', (n) => n.textContent));
  check('...and Claude never saw it as a message', !(await threadText(page)).includes('/rename'));

  // 4. "@" opens a fuzzy file picker for the session's folder.
  await page.fill('#input', 'see @ind');
  check('"@" opens the file picker', await until(() => page.isVisible('#composer-pop .cpop-item'), 5000));
  check('it finds the file by a fuzzy match', await until(async () => (await page.$$eval('#composer-pop .cpop-name', (ns) => ns.map((n) => n.textContent))).some((n) => n.includes('index.js')), 3000));
  await page.screenshot({ path: path.join(SHOTS, 'composer-mention-menu.png') });
  await page.keyboard.press('Enter');
  check('picking inserts "@path "', await until(async () => /^see @.*index\.js $/.test(await page.inputValue('#input')), 3000), await page.inputValue('#input'));
  await page.fill('#input', '');

  // 5. "!" runs a shell command here and attaches its output as context for the next message.
  await send(page, '!echo from-the-shell');
  check('a "You ran" block appears', await until(() => page.isVisible('.step.shell'), 8000));
  check('...with the command shown', await until(async () => (await page.$eval('.step.shell summary .arg', (n) => n.textContent)).includes('echo from-the-shell')), 3000);
  check('...and its output streams in', await until(async () => (await page.$eval('.step-shell-out', (n) => n.textContent)).includes('from-the-shell'), 8000));
  await page.screenshot({ path: path.join(SHOTS, 'composer-shell-command.png') });
  check('the output is attached as context for the next message', await until(() => page.isVisible('.ctx-chip'), 5000));
  await idle(page);

  console.log(`\n${passed} passed, ${failed} failed · screenshots in test/ui/shots`);
  await browser.close();
  await Promise.race([app.stop(), wait(5000)]);
  await api.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
