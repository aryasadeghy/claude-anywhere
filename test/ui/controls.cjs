// What Claude Code 2.1.319 changed about a turn, as a person meets it, with the real Claude Code
// talking to the fake Anthropic API (test/fixtures):
//   - Fast mode is a switch in the model menu, for a model that has it, and travels with the turn;
//   - Stop gives back a message typed mid-turn: it was already inside Claude Code and ran right
//     after the Stop as a turn of its own, now it goes back into the box instead;
//   - a question from Claude that is skipped, or answered by writing in the chat, is not a refusal:
//     Claude hears which it was and goes on;
//   - /clear moves the page to the new session Claude Code goes on in.
// Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/controls.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-controls-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const api = await fx.startFakeApi();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'dddddddd-1111-2222-3333-444444444444');

  // The model list is whatever Claude Code offers the account, and against the fake API that can be
  // the bare fallback. Opus 5.5 is the model with fast mode, so the page is offered it, as Claude
  // Code offers it to a real account - and only it says supportsFastMode.
  const OPUS = { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For the hardest work', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFastMode: true };
  const withFast = async (ctx) => ctx.route('**/api/models**', async (route) => {
    const r = await route.fetch(); const j = await r.json();
    j.models = (j.models || []).filter((m) => !/opus/i.test(m.value + ' ' + (m.resolvedModel || ''))).map((m) => ({ ...m, supportsFastMode: false }));
    j.models.push(OPUS);
    await route.fulfill({ response: r, json: j });
  });
  async function open(type, opts) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    await withFast(ctx);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + sid);
    await page.waitForSelector('#thread .msg');
    await wait(800);
    return { browser, page, errors };
  }
  const threadText = (page) => page.$eval('#thread', (t) => t.innerText);
  async function send(page, text) { await page.fill('#input', text); await page.press('#input', 'Enter'); }
  const idle = (page) => until(async () => (await page.$eval('#send', (b) => b.title)) === 'Send', 30000);

  const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });

  // 1. Fast mode: a switch under the models for a model that has it, the chip says so, and the
  // turn asks for it.
  await page.click('#model-btn');
  await until(() => page.isVisible('#model-menu .menu-item'), 5000);
  check('a model without fast mode has no switch', !(await page.isVisible('#model-menu .menu-switch')));
  await page.click('#model-menu .menu-item:has-text("Opus 5.5")');
  await page.click('#model-btn');
  check('the model menu has a Fast mode switch for a model that has it', await until(() => page.isVisible('#model-menu .menu-switch .toggle'), 5000));
  await page.click('#model-menu .menu-switch .toggle');
  check('...and the switch shows it is on', await until(() => page.$eval('#model-menu .menu-switch .toggle', (t) => t.classList.contains('on') && t.getAttribute('aria-checked') === 'true'), 2000));
  await wait(300); // the knob's travel, so the shot shows where it ends
  check('switched on, the chip says Fast', await until(async () => / · Fast$/.test(await page.$eval('#model-label', (n) => n.textContent)), 3000), await page.$eval('#model-label', (n) => n.textContent));
  await page.screenshot({ path: path.join(SHOTS, 'controls-fast-menu.png') });
  await page.keyboard.press('Escape'); await page.click('#thread', { position: { x: 5, y: 5 } }).catch(() => {});
  const prefs = await (await fetch(app.base + '/api/sessions/' + sid, { headers: { authorization: 'Bearer ' + app.token } })).json();
  check('...and the session remembers it', prefs.settings?.fast === true, JSON.stringify(prefs.settings));
  const before = api.bodies.length;
  // An answer more, not "Answer to: Q1": the fake API's Q-number match misses when a model change
  // rides in the same message, and says "Answer to: it." instead.
  const answers = async () => (await threadText(page)).split('Answer to:').length - 1;
  const had = await answers();
  await send(page, 'Q1 quick one');
  check('the turn runs with fast mode asked for', await until(async () => (await answers()) > had && (await threadText(page)).includes('Done.'), 30000));
  const asked = api.bodies.slice(before).filter((b) => b.stream);
  const fastSent = asked.some((b) => b.speed === 'fast'); // what Claude Code sends in fast mode
  const note = await page.$$eval('#thread .note.warning', (ns) => ns.map((n) => n.textContent).join(' | '));
  check('Claude Code asks the API for the fast answer (speed: fast)', fastSent, 'note: ' + note + ' · speeds: ' + asked.map((b) => b.speed).join(','));
  await idle(page);

  // 2. Stop gives back what was typed mid-turn.
  await send(page, 'Q2 [slow] tell me a long story about the sea and the ships upon it');
  await until(async () => (await threadText(page)).includes('Answer to: Q2'), 15000);
  await send(page, 'Q3 never mind, something else');
  check('a message typed mid-turn waits, dashed', await until(() => page.isVisible('#thread .msg.user.queued'), 5000));
  await page.click('#send'); // empty box while answering: this is Stop
  check('Stop takes it back: the dashed bubble goes', await until(async () => !(await page.isVisible('#thread .msg.user.queued')), 8000));
  check('...and its words are back in the box', await until(async () => (await page.inputValue('#input')) === 'Q3 never mind, something else', 5000), await page.inputValue('#input'));
  await page.screenshot({ path: path.join(SHOTS, 'controls-stop-gives-back.png') });
  await wait(3000);
  check('...and it never ran as a turn of its own', !(await threadText(page)).includes('Answer to: Q3'));
  check('the Stop shows no error: it was the point', !(await page.$$eval('#thread .note.error', (ns) => ns.length)), await page.$$eval('#thread .note.error', (ns) => ns.map((n) => n.textContent).join(' | ')));
  await page.fill('#input', '');
  await idle(page);

  // 3. A question, skipped: the card says so and Claude goes on, told it was skipped.
  await send(page, 'Q4 [ask] pick a colour');
  check('Claude asks: the question card', await until(() => page.isVisible('.question-card .q-opt'), 20000));
  await page.click('.question-card .permission-actions button:has-text("Skip")');
  check('Skip closes the card as skipped', await until(async () => (await page.$eval('.question-card:last-of-type', (c) => c.innerText)).includes('Skipped'), 8000));
  // A Skip that was a refusal read "The user declined this from their phone."; unanswered, Claude
  // Code tells Claude the questions were not answered, and the turn goes on.
  const heard = () => threadText(page).then((t) => t.split('\n').filter((l) => /^Noted:/.test(l.trim())));
  check('...and Claude goes on, told it was not answered rather than refused', await until(async () => (await heard()).some((l) => /did not answer/i.test(l) && !/declined|rejected/i.test(l)), 20000), (await heard()).join(' | '));
  await page.screenshot({ path: path.join(SHOTS, 'controls-question-skipped.png') });
  await idle(page);

  // 4. A question answered by writing in the chat instead.
  await send(page, 'Q5 [ask] and again');
  await until(async () => (await page.$$('.question-card:not(.answered)')).length > 0, 20000);
  await send(page, 'Make it green');
  check('writing in the chat closes the question as answered there', await until(async () => (await page.$$eval('.question-card.answered', (cs) => cs.map((c) => c.innerText).join(' | '))).includes('Answered in the chat'), 10000));
  // The message went to Claude: a request after the question carries it.
  const reached = () => api.bodies.some((b) => JSON.stringify(b.messages || []).includes('Make it green'));
  check('...and Claude reads the message', await until(async () => reached(), 20000));
  await page.screenshot({ path: path.join(SHOTS, 'controls-question-in-chat.png') });
  await idle(page);

  // 5. /clear: Claude Code goes on in a new session, and the page with it.
  await send(page, '/clear');
  check('/clear opens the new session Claude Code went on in', await until(async () => { const h = await page.evaluate(() => location.hash); return /^#\/s\/[0-9a-f-]{36}$/.test(h) && !h.includes(sid); }, 20000), await page.evaluate(() => location.hash));
  check('no errors in the app', !errors.length, errors.join(' | '));
  await browser.close();

  // 6. On a phone, in Safari's engine: the switch fits and reads.
  {
    const { browser, page, errors } = await open(webkit, devices['iPhone 15 Pro Max']);
    await page.click('#model-btn');
    await until(() => page.isVisible('#model-menu .menu-switch .toggle'), 5000);
    const wide = await page.evaluate(() => [...document.querySelectorAll('#model-menu .menu-switch, #model-menu .menu-switch *')].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).map((n) => n.className));
    check('iphone: the Fast mode row fits the screen', !wide.length, wide.join(', '));
    await page.screenshot({ path: path.join(SHOTS, 'controls-fast-iphone.png') });
    check('iphone: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed · screenshots in test/ui/shots`);
  await Promise.race([app.stop(), wait(5000)]);
  await api.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
