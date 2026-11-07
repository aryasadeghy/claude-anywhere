// A long session in a real browser. It opens on its newest page; older pages arrive as the
// reader scrolls up, without moving what is on screen, all the way to the first message; and
// it reads the way Claude Desktop shows it - compactions as markers with everything before
// them still there, background notices in their tool groups (a failed one first, in red),
// narration as text and the rest of the thinking hidden, the files a turn wrote as cards.
// The transcript is made up (test/fixtures), the app is the real one. Shots in test/ui/shots/.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/history.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
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
const until = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(100); } return false; };

// The thread as rows of text: what a reader would read down the page.
const rowsOf = (page) => page.evaluate(() => {
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.matches('.msg.user')) out.push('USER ' + (c.querySelector('.msg-text')?.textContent || ''));
      else if (c.matches('.msg.assistant')) walk(c.querySelector('.msg-body'));
      else if (c.matches('.prose') && !c.classList.contains('hidden')) out.push('TEXT ' + c.textContent.trim());
      else if (c.matches('details.tool-group')) out.push((c.classList.contains('lone-task') ? 'NOTICE ' : 'GROUP ') + c.querySelector('summary').textContent);
      else if (c.matches('.sent-card')) out.push('SENT ' + c.querySelectorAll('img').length);
      else if (c.matches('.file-cards')) out.push('CARDS ' + [...c.querySelectorAll('.file-card')].map((f) => f.textContent).join(' | '));
      else if (c.matches('.compact-mark')) out.push('COMPACT ' + c.querySelector('summary').textContent);
      else if (c.matches('.history-top')) out.push('TOP ' + c.textContent);
    }
  };
  walk(document.getElementById('thread'));
  return out;
});
// Scroll to the top until the first message is in, a page at a time.
async function upToStart(page, max = 60) {
  for (let i = 0; i < max; i++) {
    const n = await page.evaluate(() => { document.getElementById('scroll').scrollTop = 0; return document.querySelectorAll('#thread *').length; });
    if (!(await page.$('.history-top'))) return true;
    await until(() => page.evaluate((k) => document.querySelectorAll('#thread *').length !== k || !document.querySelector('.history-top'), n), 8000);
  }
  return !(await page.$('.history-top'));
}
// Scroll to the top once and measure how far what was on screen moved when the older page landed
// above it, with its pictures arriving late. It should not move; 4 px is for rounding. (Before
// the thread kept its own anchor, an iPhone moved 167 px; anchored to an element only half in
// view, the pictures loading in it moved Linux's WebKit 434 px.)
const STILL = 4;
// Pictures arrive late, as on a phone or a slow machine: after the older page is placed.
const late = (ctx) => ctx.route(/\/api\/file\?/, async (r) => { await wait(700); r.continue().catch(() => {}); });
async function drift(page) {
  const before = await page.evaluate(() => {
    const sc = document.getElementById('scroll'); sc.scrollTop = 0;
    // The first thing that was on screen under the loading line. Nothing below it can move it,
    // so any movement is the older page's going in above it (or its pictures settling there).
    const first = [...document.getElementById('thread').children].find((c) => !c.classList.contains('history-top'));
    const ref = first.classList.contains('msg') ? first.querySelector('.msg-body').firstElementChild || first : first;
    ref.dataset.anchor = '1';
    return { top: ref.getBoundingClientRect().top, n: document.querySelectorAll('#thread *').length, at: sc.scrollTop, h: sc.scrollHeight, ref: ref.className + ' "' + ref.textContent.slice(0, 40) + '"' };
  });
  await until(() => page.evaluate((k) => document.querySelectorAll('#thread *').length > k, before.n), 8000);
  await wait(1200);
  const after = await page.evaluate(() => { const sc = document.getElementById('scroll'); return { top: document.querySelector('[data-anchor="1"]').getBoundingClientRect().top, at: sc.scrollTop, h: sc.scrollHeight }; });
  const moved = Math.abs(after.top - before.top);
  // What a failure in CI needs to be read: where the page was, what it measured, how it changed.
  return { moved, detail: `${moved} px; ref ${before.ref}; top ${before.top} -> ${after.top}; scrollTop ${before.at} -> ${after.at}; height ${before.h} -> ${after.h}` };
}

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-history-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const s = fx.makeLongSession(path.join(tmp, 'claude'), cwd, { turns: 80 });
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude') });
  fs.mkdirSync(SHOTS, { recursive: true });

  async function open(type, ctxOpts, before = null) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', ...ctxOpts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    if (before) await before(ctx);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const requests = []; page.on('request', (r) => { if (/\/history/.test(r.url())) requests.push(r.url()); });
    await page.goto(app.base + '/#/s/' + s.id);
    await page.waitForSelector('#thread .msg');
    await wait(1000);
    return { browser, page, errors, requests };
  }
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });
  const text = (page) => page.$eval('#thread', (t) => t.innerText);

  // ---------- desktop, Chromium ----------
  {
    const { browser, page, errors, requests } = await open(chromium, { viewport: { width: 1380, height: 900 } }, late);
    const rows = await rowsOf(page);
    check('it opens on the newest page, not the whole session', requests.length <= 2 && !(await text(page)).includes('Turn 1: build thing 1'), requests.length + ' requests');
    check('the newest turn is at the bottom: its notice, then the file it wrote', rows.at(-2)?.startsWith("NOTICE Background task stopped · 2 background shell command tasks didn't finish") && /^CARDS thing-80\.txt\+3 −0/.test(rows.at(-1) || ''), rows.slice(-3).join(' / '));
    check('while there is more, the top says it is loading earlier messages', rows[0] === 'TOP Loading earlier messages…', rows[0]);
    await shot(page, 'history-end');
    const d = await drift(page);
    check('an older page lands above without moving what is on screen', d.moved < STILL, d.detail);
    check('it reaches the first message, and the loading line goes', await upToStart(page) && (await text(page)).includes('Turn 1: build thing 1'));
    const all = await rowsOf(page);
    const joined = all.join('\n');
    check('every message the session showed is here, before and after both compactions', s.said.every((t) => joined.includes(t)), s.said.filter((t) => !joined.includes(t)).slice(0, 3).join(' | '));
    check('and nothing it did not: meta prompts, the CLI answering itself, a sidechain, the thinking', s.hidden.every((t) => !joined.includes(t)), s.hidden.filter((t) => joined.includes(t)).slice(0, 3).join(' | '));
    const marks = all.filter((r) => r.startsWith('COMPACT'));
    check('each compaction is a marker in Desktop\'s words', marks.length === 2 && marks.every((m) => /^COMPACT Compacted session · from 95\dk tokens$/.test(m)), marks.join(' / '));
    await page.evaluate(() => { const m = document.querySelector('.compact-mark'); m.open = true; m.scrollIntoView({ block: 'center' }); });
    await wait(300);
    check('opening a marker shows the summary Claude kept', /Summary \d+: the first 80 things/.test(await page.$eval('.compact-mark .compact-summary', (n) => n.textContent)));
    await shot(page, 'history-compacted');
    const turn = (i) => { const a = all.indexOf('USER Turn ' + i + ': build thing ' + i); return all.slice(a, all.indexOf('USER Turn ' + (i + 1) + ': build thing ' + (i + 1))); };
    check('a background command\'s notice counts in the group it arrived in', turn(13).includes('GROUP Ran 2 commands, finished a background command'), turn(13).join(' / '));
    check('a failed one leads its group', turn(15).includes('GROUP Finished a background command, ran 2 commands, read shot-15.png'), turn(15).join(' / '));
    check('and the command that started it counts as failed where it ran', turn(14).some((r) => r.startsWith('GROUP Ran 3 commands (1 failed), created a file')), turn(14).join(' / '));
    check('a command that failed: "(1 failed)"', turn(16).includes('GROUP Ran 2 commands (1 failed)'), turn(16).join(' / '));
    const colors = await page.evaluate(() => { const s = document.querySelector('.tool-group > summary .task-failed'); return s ? [getComputedStyle(s).color, getComputedStyle(s.parentElement).color] : null; });
    check('"Finished" is in its own colour when the command failed', !!colors && colors[0] !== colors[1], JSON.stringify(colors));
    check('narration reads as text between the tool groups', turn(20).includes('TEXT Thing 20 is built and tested.'), turn(20).join(' / '));
    check('a connector\'s SendUserFile counts in its group, its picture under the group line', turn(18).includes('GROUP Ran 2 commands, used a tool') && turn(18).includes('SENT 1'), turn(18).join(' / '));
    check('the message typed mid-turn is a bubble of its own', turn(10).includes('USER also keep the logs'), turn(10).join(' / '));
    check('the message a second process answered beside the main thread is there', joined.includes('USER stop the gpu for a game') && joined.includes('TEXT Stopped the GPU jobs, play away.'));
    const pics = await page.evaluate(async () => {
      const imgs = [...document.querySelectorAll('#thread .step .tool-img')].slice(0, 3);
      for (const im of imgs) { im.scrollIntoView(); im.loading = 'eager'; await new Promise((r) => (im.complete ? r() : (im.onload = im.onerror = r))); }
      return imgs.map((im) => (im.src.includes('/image/') ? im.naturalWidth : -1));
    });
    check('a picture Claude read loads from its URL', pics.length === 3 && pics.every((w) => w > 0), JSON.stringify(pics));
    const rewind = await page.evaluate(() => [...document.querySelectorAll('#thread .msg.user')].map((m) => [m.querySelector('.msg-text')?.textContent, !!m.querySelector('.rewind')]));
    const firstTurn = rewind.find(([t]) => t === 'Turn 1: build thing 1'), lastTurn = rewind.find(([t]) => t === 'Turn 80: build thing 80');
    check('rewind is offered after the last compaction, not before it', firstTurn && !firstTurn[1] && lastTurn && lastTurn[1], JSON.stringify([firstTurn, lastTurn]));
    await page.evaluate(() => { const u = [...document.querySelectorAll('#thread .msg.user')].find((m) => m.textContent.includes('Turn 15: build')); u.scrollIntoView({ block: 'start' }); });
    await wait(300);
    await shot(page, 'history-groups');
    // Another window (Desktop, a terminal) goes on with the session: the page follows the file,
    // and what it adds reads the way the history does.
    let last = s.lines.filter((l) => l.uuid && !l.isSidechain).at(-1).uuid, k = 0;
    const write = (o) => { const uuid = 'eeeeeeee-0000-4000-9000-' + String(++k).padStart(12, '0'); fs.appendFileSync(s.file, JSON.stringify({ parentUuid: last, isSidechain: false, cwd, sessionId: s.id, uuid, timestamp: new Date().toISOString(), ...o }) + '\n'); last = uuid; };
    write({ type: 'user', isMeta: true, message: { role: 'user', content: 'a meta line from elsewhere' } });
    write({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'thinking', thinking: 'Carrying on from Desktop.', signature: fx.thinkingSignature('narration') }] } });
    write({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'thinking', thinking: 'a private thought from elsewhere', signature: fx.thinkingSignature('reasoning') }] } });
    write({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<task-id>bt1</task-id>\n<status>completed</status>\n<summary>Background command "Render in the other window" completed (exit code 0)</summary>\n</task-notification>' } });
    write({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } });
    const followed = await until(async () => (await text(page)).includes('Background command completed · Render in the other window'), 10000);
    const t = await text(page);
    check('a turn written by another window shows as it happens, the way the history shows it', followed && t.includes('Carrying on from Desktop.') && !t.includes('a meta line from elsewhere') && !t.includes('a private thought from elsewhere') && !t.includes('No response requested.'), followed ? '' : 'the notice never arrived');
    check('no errors on the page', !errors.length, errors.join(' | '));
    await browser.close();
  }

  // ---------- a tall window: the first page is shorter than the screen ----------
  // An older page loads at once, and the page scrolls itself to keep the end in view. Its
  // pictures grow the thread before that scroll's own event arrives - which used to read as the
  // reader leaving the end, and a real session opened 1,300 px above it. Here the growth is
  // made certain: the moment the older page goes in, the thread gains 600 px.
  {
    const grow = (ctx) => ctx.addInitScript(() => {
      if (window.top !== window) return;
      addEventListener('DOMContentLoaded', () => {
        const t = document.getElementById('thread'); let done = false;
        new MutationObserver((ms) => {
          if (done || !ms.some((m) => m.addedNodes.length > 3 && m.nextSibling)) return;
          done = true; const d = document.createElement('div'); d.className = 'grew'; d.style.height = '600px'; t.appendChild(d);
        }).observe(t, { childList: true });
      });
    });
    const { browser, page, errors, requests } = await open(chromium, { viewport: { width: 1380, height: 4200 } }, grow);
    await wait(1500);
    const gap = await page.evaluate(() => { const sc = document.getElementById('scroll'); return Math.round(sc.scrollHeight - sc.clientHeight - sc.scrollTop); });
    check('a tall window: an older page comes at once, the thread grows, and it still opens at its end', requests.length >= 2 && !!(await page.$('.grew')) && gap < 2, `${requests.length} requests, grew: ${!!(await page.$('.grew'))}, ${gap} px from the end`);
    check('a tall window: no errors on the page', !errors.length, errors.join(' | '));
    await browser.close();
  }

  // ---------- an iPhone, WebKit ----------
  {
    const { browser, page, errors } = await open(webkit, { ...devices['iPhone 13'] }, late);
    const rows = await rowsOf(page);
    check('iPhone: opens on the newest turn', /^CARDS thing-80\.txt/.test(rows.at(-1) || ''), rows.at(-1));
    await shot(page, 'history-phone');
    const d = await drift(page);
    check('iPhone: an older page lands without moving what is on screen', d.moved < STILL, d.detail);
    check('iPhone: it reaches the first message', await upToStart(page) && (await text(page)).includes('Turn 1: build thing 1'));
    check('iPhone: no errors on the page', !errors.length, errors.join(' | '));
    await browser.close();
  }

  // What --test prints and what CI reads: a summary first, then leave.
  console.log(`\n${passed} passed, ${failed} failed`);
  await Promise.race([app.stop(), wait(5000)]);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
