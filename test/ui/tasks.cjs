// Desktop parity, "tasks" package: the plan box moved to the end of the thread (status icons,
// the "N earlier steps" fold, a comment button per item, the title bar step chip), the recap
// card SuggestNextSteps can now show (summary/question, a primary button with the Ctrl/Cmd+Enter
// hint, Dismiss), the composer's busy placeholder, the /context card, and the Tasks pane's
// Desktop wording. Against the fake Anthropic API (test/fixtures), offline and the same every time.
// Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/tasks.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-tasks-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const api = await fx.startFakeApi();
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
    await wait(800);
    return { browser, page, errors };
  }
  async function send(page, text) { await page.fill('#input', text); await page.press('#input', 'Enter'); }
  const idle = (page) => until(async () => (await page.$eval('#send', (b) => b.title)) === 'Send', 30000);

  const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });

  // 1. The plan box: TodoWrite's list renders at the end of the thread, not above the composer,
  // with a filled check for the completed step and a spinner for the one under way.
  await send(page, '[todo] get started');
  check('the plan box appears', await until(() => page.isVisible('.plan-box'), 15000));
  check('...at the end of the thread, not pinned above the composer', await page.evaluate(() => { const box = document.querySelector('.plan-box'); return box && document.getElementById('thread').contains(box); }));
  check('a completed item is checked and struck through', await page.evaluate(() => { const li = [...document.querySelectorAll('.plan-box .todo-item.status-completed')][0]; return !!li && getComputedStyle(li.querySelector('.todo-label')).textDecorationLine.includes('line-through'); }));
  check('the in-progress item shows its activeForm', (await page.$eval('.plan-box .todo-item.status-in_progress .todo-label', (n) => n.textContent)).includes('Writing the tests'));
  check('the title bar chip names the step', await until(async () => /Step 2 of 3/.test(await page.$eval('#plan-step-chip', (n) => n.textContent)), 5000), await page.$eval('#plan-step-chip', (n) => n.textContent).catch(() => '(absent)'));
  // Hovering an item reveals its comment button; clicking attaches context quoting the item.
  await page.hover('.plan-box .todo-item.status-in_progress');
  check('hovering an item reveals its comment button', await page.isVisible('.plan-box .todo-item.status-in_progress .todo-comment-btn'));
  await page.click('.plan-box .todo-item.status-in_progress .todo-comment-btn');
  check('the comment button attaches the item as context', await until(async () => (await page.$eval('#context-chips', (n) => n.textContent)).includes('Todo item')), await page.$eval('#context-chips', (n) => n.textContent).catch(() => ''));
  await page.click('#context-chips .ctx-chip-x').catch(() => {});
  await page.screenshot({ path: path.join(SHOTS, 'tasks-plan-box.png') });
  await idle(page);

  // 2. The recap card: summary + question + a primary button with the queue hint; Dismiss removes it.
  await send(page, '[recap] wrap it up');
  check('the recap card shows the summary', await until(async () => (await page.$eval('.recap-card .recap-summary', (n) => n.textContent)).includes('wrote the tests')), 15000);
  check('...and the question', (await page.$eval('.recap-card .recap-question', (n) => n.textContent)).includes('ship it'));
  check('the first button is primary and carries the Enter hint', await page.$eval('.recap-card .suggest-step.btn-primary .recap-hint', (n) => !!n.textContent.trim()));
  check('the plan box is gone once the recap card is shown', !(await page.isVisible('.plan-box')));
  await page.screenshot({ path: path.join(SHOTS, 'tasks-recap-card.png') });
  await page.click('.recap-card .recap-dismiss');
  check('Dismiss recap hides the card', await until(async () => await page.$eval('.recap-card', (n) => n.classList.contains('hidden'))));
  await idle(page);

  // 3. The composer's busy hint: Enter sends now, Ctrl/Cmd+Enter queues for after the turn.
  await send(page, '[slow] take a while please');
  check('busy placeholder names both keys', await until(async () => /to send.*to queue for later/.test(await page.$eval('#input', (n) => n.placeholder))), 5000, await page.$eval('#input', (n) => n.placeholder).catch(() => ''));
  await page.fill('#input', 'do this after');
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  check('Ctrl+Enter queues the message, marked for after this turn', await until(async () => (await page.$eval('.msg.user.queued .queued-label', (n) => n.textContent)).includes('after this turn')), 10000);
  await page.screenshot({ path: path.join(SHOTS, 'tasks-composer-defer.png') });
  await idle(page);
  await idle(page); // the deferred message now runs as its own turn

  // 4. /context: a card with the usage line and a segmented bar, expandable into the breakdown.
  await send(page, 'Q1 one more');
  await idle(page);
  await page.fill('#input', '/context'); await page.keyboard.press('Enter');
  check('/context shows the usage line', await until(async () => /Context window/.test(await page.$eval('.context-card .context-card-title', (n) => n.textContent))), 10000);
  check('...with a segmented bar', await page.evaluate(() => document.querySelectorAll('.context-card .context-seg').length > 0));
  await page.click('.context-card .context-expand').catch(() => {});
  check('...and an expandable per-category breakdown', await page.evaluate(() => document.querySelectorAll('.context-card .context-breakdown .context-row').length > 0));
  await page.screenshot({ path: path.join(SHOTS, 'tasks-context-card.png') });

  // 5. Read aloud sits next to Copy in the action row, and toggles.
  check('a Read aloud button sits in the action row', await page.evaluate(() => [...document.querySelectorAll('.msg-actions button')].some((b) => b.title === 'Read aloud')));

  // 6. The Tasks pane: Desktop's own wording (Running / Completed, a Bash badge).
  await send(page, '[background] render it');
  check('the tasks bar appears', await until(() => page.isVisible('#tasks-bar'), 15000));
  await page.click('#tasks-bar');
  check('the pane has a Running section', await until(() => page.isVisible('.tp-section:has-text("Running")'), 5000));
  check('...with a Bash badge', await page.evaluate(() => [...document.querySelectorAll('.tp-meta span')].some((n) => n.textContent === 'Bash')));
  await page.screenshot({ path: path.join(SHOTS, 'tasks-pane.png') });
  check('no errors in the app', !errors.length, errors.join(' | '));
  await browser.close();

  // 7. On a phone, in Safari's engine: the plan box fits, and the step chip stays out of the way.
  {
    const { browser, page, errors } = await open(webkit, devices['iPhone 15 Pro Max']);
    await send(page, '[todo] get started on the phone');
    await until(() => page.isVisible('.plan-box'), 15000);
    const wide = await page.evaluate(() => [...document.querySelectorAll('.plan-box, .plan-box *')].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).map((n) => n.className));
    check('iphone: the plan box fits the screen', !wide.length, wide.join(', '));
    await page.screenshot({ path: path.join(SHOTS, 'tasks-plan-box-iphone.png') });
    check('iphone: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed · screenshots in test/ui/shots`);
  await Promise.race([app.stop(), wait(5000)]);
  await api.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
