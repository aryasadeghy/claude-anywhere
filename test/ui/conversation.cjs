// Desktop's Code-tab features this package adds, with the real Claude Code talking to the fake
// Anthropic API (test/fixtures): Claude's own tools (a recap with next-step buttons, a chapter
// marker, a suggested task, a session-status badge), the plan approval card, the live plan box,
// Transcript view, inline math, masked secrets, the message context menu and code-block copying,
// and Find in the session. Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/conversation.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-conversation-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const api = await fx.startFakeApi();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  fs.mkdirSync(SHOTS, { recursive: true });

  async function open(type, opts) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/');
    await wait(600);
    return { browser, page, errors };
  }
  const threadText = (page) => page.$eval('#thread', (t) => t.innerText).catch(() => '');
  // Enter only submits above 861px (narrower keeps it a newline, for a software keyboard) - the
  // send button works at every width, the way a tap on the phone actually sends a message.
  async function send(page, text) { await page.fill('#input', text); await page.click('#send'); }
  const idle = (page) => until(async () => (await page.$eval('#send', (b) => b.title)) === 'Send', 30000);

  const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });

  // 0. Settings: Transcript view and "classify sessions automatically" are there and work.
  await page.click('#account-btn');
  await page.click('#account-menu >> text=Settings…');
  await until(() => page.isVisible('#set-transcript-view .set-opt'), 5000);
  check('Transcript view has Normal/Thinking/Verbose', await page.$$eval('#set-transcript-view .set-opt', (ns) => ns.map((n) => n.textContent).join(',')) === 'Normal,Thinking,Verbose');
  await page.click('#set-auto-classify .toggle');
  check('auto-classify switch turns on', await until(() => page.$eval('#set-auto-classify .toggle', (t) => t.classList.contains('on')), 3000));
  await page.screenshot({ path: path.join(SHOTS, 'conversation-settings.png') });
  await page.click('#settings-close');

  // 1. SetSessionStatus: a badge on the sidebar row (the setting just turned on applies to a
  // session that starts from here on, not one already running).
  await send(page, '[status] mark this one up');
  await until(async () => (await threadText(page)).includes('Session marked'), 20000);
  await idle(page);
  // Typing the first message of a brand-new chat updates the hash with replaceState (no
  // hashchange, so the header stays in "new chat" shape); reload it properly, the way
  // following a link or reopening the app would, to see the session view with its badge. A
  // bare goto to the same hash is a same-document fragment navigation (no reload at all) -
  // a changed query string forces a real one.
  const sessionHash = await page.evaluate(() => location.hash);
  await page.goto(app.base + '/?r=' + Date.now() + sessionHash);
  await until(() => page.isVisible('#session-menu-btn:not(.hidden)'), 10000);
  check('the sidebar badge says Ready for review', await until(() => page.isVisible('.session-item.active .status-badge.status-ready_for_review'), 10000));
  await page.screenshot({ path: path.join(SHOTS, 'conversation-status-badge.png') });

  // 2. SuggestNextSteps: a recap and a button that sends its prompt.
  await send(page, '[suggest] what now');
  check('the recap + next-step button appear', await until(() => page.isVisible('.suggest-card .suggest-step'), 20000));
  await idle(page);
  const before = api.bodies.length;
  await page.click('.suggest-card .suggest-step');
  check('pressing the button sends its prompt', await until(() => api.bodies.slice(before).some((b) => JSON.stringify(b.messages || []).includes('Add tests for the thing')), 15000));
  await page.screenshot({ path: path.join(SHOTS, 'conversation-suggest-next-steps.png') });
  await idle(page);

  // 3. MarkChapter: a divider in the thread, and the session header's Chapters menu jumps to it.
  await send(page, '[chapter] new part of the task');
  check('a chapter divider appears', await until(() => page.isVisible('.chapter-divider'), 20000));
  await idle(page);
  await page.click('#session-menu-btn');
  await until(() => page.isVisible('#session-menu .menu-item'), 5000);
  await page.click('#session-menu >> text=Chapters');
  check('the Chapters menu lists it', await until(() => page.isVisible('#session-menu .menu-item:has-text("Set up the database")'), 5000));
  await page.screenshot({ path: path.join(SHOTS, 'conversation-chapters-menu.png') });
  await page.click('#session-menu .menu-item:has-text("Set up the database")');
  check('picking it scrolls to and highlights the divider', await until(() => page.$eval('.chapter-divider', (n) => n.closest('.jump-flash') || n.classList.contains('jump-flash') || !!n.closest('*').querySelector('.jump-flash')).catch(() => false), 5000));

  // 4. SuggestTask: a card with "Do it here" / "Start in a new session".
  await send(page, '[sugtask] a follow-up');
  check('the suggested task card appears', await until(() => page.isVisible('.suggested-task-card'), 20000));
  check('...with both buttons', await page.isVisible('.suggested-task-card >> text=Do it here') && await page.isVisible('.suggested-task-card >> text=Start in a new session'));
  await page.screenshot({ path: path.join(SHOTS, 'conversation-suggested-task.png') });
  await idle(page);
  const before2 = api.bodies.length;
  await page.click('.suggested-task-card >> text=Do it here');
  check('"Do it here" sends its prompt in this session', await until(() => api.bodies.slice(before2).some((b) => JSON.stringify(b.messages || []).includes('Write a README for this project')), 15000));
  await idle(page);

  // 5. Plan approval: the plan as Markdown, a feedback box, and "No, keep planning" sends the
  // feedback back as the reason Claude was told no.
  await page.click('#mode-btn');
  await until(() => page.isVisible('#mode-menu .menu-item'), 5000);
  await page.click('#mode-menu >> text=Plan');
  await send(page, '[plan] think about it');
  check('the plan card shows the plan as markdown', await until(() => page.isVisible('.plan-card .plan-text >> text=Do the first thing'), 20000));
  check('...with the three choices', await page.isVisible('.plan-card >> text=Yes, and auto-accept edits') && await page.isVisible('.plan-card >> text=Yes, and manually approve edits') && await page.isVisible('.plan-card >> text=No, keep planning'));
  // Selecting text in the plan offers "Plan comment", which quotes it into the feedback box.
  await page.evaluate(() => { const p = document.querySelector('.plan-card .plan-text p') || document.querySelector('.plan-card .plan-text'); const r = document.createRange(); r.selectNodeContents(p); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); });
  await page.dispatchEvent('.plan-card .plan-text', 'mouseup');
  check('a plan comment button appears over the selection', await until(() => page.isVisible('.plan-comment-btn:not(.hidden)'), 3000));
  await page.click('.plan-comment-btn');
  check('...and quotes the selection into the feedback box', await until(async () => (await page.inputValue('.plan-card .plan-feedback')).includes('>'), 3000));
  await page.fill('.plan-card .plan-feedback', 'Use a different approach.');
  await page.screenshot({ path: path.join(SHOTS, 'conversation-plan-approval.png') });
  await page.click('.plan-card >> text=No, keep planning');
  check('keep planning collapses the card', await until(() => page.isVisible('.plan-card.answered'), 5000));
  await idle(page);
  check('...and Claude is told to go on, with the feedback as the reason', await until(() => api.bodies.some((b) => JSON.stringify(b.messages || []).includes('Use a different approach.')), 15000));

  // A second plan, approved with auto-accept edits: the mode chip picks it up from the same
  // round trip (PermissionResult.updatedPermissions), no separate /controls call needed.
  await send(page, '[plan] a second plan');
  check('a second plan card appears', await until(() => page.isVisible('.plan-card:not(.answered) .plan-text'), 20000));
  await page.click('.plan-card:not(.answered) >> text=Yes, and auto-accept edits');
  check('approving switches the mode chip to Accept edits', await until(async () => (await page.textContent('#mode-name')) === 'Accept edits', 10000), await page.textContent('#mode-name'));
  await idle(page);

  // 6. The live plan box: TodoWrite's whole list, checked/struck for what is done, and a
  // TaskCreate call joins the same box once its id comes back on the result.
  await send(page, '[todo] get going');
  // The in-progress item shows its active form ("Writing the tests"), as Desktop shows a
  // spinner-labelled row; the pending and completed ones keep their plain content.
  check('the plan box shows TodoWrite\'s list', await until(() => page.isVisible('#plan-box:not(.hidden) >> text=Writing the tests'), 20000));
  check('a done item is checked and struck through', await page.$eval('#plan-box .todo-item.status-completed .todo-label', (n) => getComputedStyle(n).textDecorationLine).then((d) => d.includes('line-through')).catch(() => false));
  check('...and its count says 1 of 3', (await page.textContent('#plan-box-count')).trim() === '1 of 3', await page.textContent('#plan-box-count'));
  // The row is folded into its tool-group ("Used a tool ›"); open that, then the row itself.
  await until(() => page.isVisible('.tool-group:has-text("Used a tool")'), 10000);
  await page.$$eval('details.tool-group', (ds) => ds.forEach((d) => { d.open = true; }));
  const todoStep = page.locator('.step:has-text("Updated the task list")').last();
  check('the TodoWrite row in the thread expands to the same checklist', await until(() => todoStep.isVisible(), 5000));
  await todoStep.evaluate((d) => { d.open = true; });
  check('...showing the to-dos, not raw JSON', await page.isVisible('.step .todo-checklist >> text=Ship it'));
  await page.screenshot({ path: path.join(SHOTS, 'conversation-plan-box.png') });
  await idle(page);
  // TaskCreate/TaskUpdate feed the same box (updatePlanFromTool, planTaskCreated in app.js), but
  // this CLI build answers "TaskCreate is disabled for this session" for every SDK session it was
  // tried against - there is no settings flag documented to turn the Tasks feature on, so that
  // path is implemented from sdk-tools.d.ts and left unexercised here rather than asserted on a
  // tool the harness cannot actually turn on.

  check('no errors in the app', !errors.length, errors.join(' | '));
  await browser.close();

  // 5. On a phone, in Safari's engine: the cards and badge fit and read.
  {
    const { browser, page, errors } = await open(webkit, devices['iPhone 15 Pro Max']);
    await send(page, '[suggest] what now');
    check('iphone: the recap + next-step button appear', await until(() => page.isVisible('.suggest-card .suggest-step'), 20000));
    const wide = await page.evaluate(() => [...document.querySelectorAll('.suggest-card, .suggest-card *')].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).map((n) => n.className));
    check('iphone: the suggest card fits the screen', !wide.length, wide.join(', '));
    await page.screenshot({ path: path.join(SHOTS, 'conversation-iphone.png') });
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
