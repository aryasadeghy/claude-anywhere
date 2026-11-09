// Git actions (Desktop's Changes panel and PR menu), against a scratch git repo with a bare
// "origin" in os.tmpdir() - never the real git/gh on this machine's own repos. The gh-dependent
// half (an existing PR, related/stacked PRs, Mark ready, Confirm merge) runs against a fake `gh`
// put first on PATH: a plain script on macOS/Linux, and - since Windows' CreateProcess only
// auto-appends ".exe" to a bare command name, never ".cmd"/".bat" (confirmed by hand: lib/pr.mjs
// and lib/git-actions.mjs call `execFileP('gh', ...)` with no shell, same as the real CLI) - a
// couple of lines of C compiled on the fly here, that just re-execs the same script under node.
// Where no C compiler is on PATH, those checks are skipped rather than failing the whole suite.
// Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/git.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { execFileSync } = require('child_process');
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
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });

// A fake `gh`, controlled by rewriting a JSON state file it reads on every call. Returns the
// { dir, state(obj) } the caller needs: `dir` goes first on the spawned app's PATH, `state(obj)`
// rewrites what the next call answers. Null if this platform cannot make one run as bare `gh`.
function setUpFakeGh(tmp) {
  const dir = path.join(tmp, 'fakegh');
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(tmp, 'fakegh-state.json');
  fs.writeFileSync(statePath, '{}');
  const script = path.join(dir, 'fakegh.cjs');
  fs.writeFileSync(script, `
const fs = require('fs');
const p = process.env.FAKE_GH_STATE;
const load = () => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const save = (s) => fs.writeFileSync(p, JSON.stringify(s));
const a = process.argv.slice(2), s = load();
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const fail = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const record = (name) => { s.calls = s.calls || []; s.calls.push({ name, args: a }); save(s); };
if (a[0] === 'pr' && a[1] === 'view' && a[2] === '--json') { if (!s.pr) return fail('no pull requests found for branch'); return out(s.pr); }
if (a[0] === 'pr' && a[1] === 'view' && a[2] && a[2] !== '--json') { const row = (s.stack || {})[a[2]]; if (!row) return fail('no pull requests found'); return out(row); }
if (a[0] === 'pr' && a[1] === 'list') return out(s.related || []);
if (a[0] === 'repo' && a[1] === 'view') return out(s.repoView || { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false });
if (a[0] === 'api') return out(s.inlineComments || []);
if (a[0] === 'pr' && a[1] === 'create') { record('pr-create'); process.stdout.write('https://github.com/x/y/pull/999\\n'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'ready') { record('pr-ready'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'merge') { record('pr-merge:' + a.slice(2).join(',')); process.exit(0); }
fail('fake gh: unhandled ' + a.join(' '));
`);
  const env = { FAKE_GH_STATE: statePath };
  const state = (obj) => fs.writeFileSync(statePath, JSON.stringify(obj));
  if (process.platform !== 'win32') {
    const bin = path.join(dir, 'gh');
    fs.writeFileSync(bin, '#!/usr/bin/env node\n' + fs.readFileSync(script, 'utf8'));
    fs.chmodSync(bin, 0o755);
    return { dir, env, state, calls: () => JSON.parse(fs.readFileSync(statePath, 'utf8')).calls || [] };
  }
  // Windows: CreateProcess only tries ".exe" for a bare command name, so a plain .cmd/.bat shim
  // never gets found by execFile without a shell. A tiny re-exec compiled with whatever C
  // compiler is on PATH stands in for the real gh.exe.
  const cc = ['gcc', 'cc', 'clang'].find((c) => { try { execFileSync('where', [c], { windowsHide: true }); return true; } catch { return false; } });
  if (!cc) return null;
  const src = path.join(dir, 'gh.c');
  fs.writeFileSync(src, '#include <process.h>\n#include <stdlib.h>\nint main(int argc, char** argv) {\n  char* script = getenv("FAKEGH_SCRIPT");\n  if (!script) return 127;\n  char** newargv = (char**)malloc(sizeof(char*) * (size_t)(argc + 2));\n  newargv[0] = "node"; newargv[1] = script;\n  for (int i = 1; i < argc; i++) newargv[i + 1] = argv[i];\n  newargv[argc + 1] = NULL;\n  intptr_t rc = _spawnvp(_P_WAIT, "node", (const char* const*)newargv);\n  return (int)rc;\n}\n');
  execFileSync(cc, ['-O2', '-o', path.join(dir, 'gh.exe'), src], { windowsHide: true });
  env.FAKEGH_SCRIPT = script.replace(/\\/g, '/');
  return { dir, env, state, calls: () => JSON.parse(fs.readFileSync(statePath, 'utf8')).calls || [] };
}

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-git-'));
  const repo = path.join(tmp, 'project');
  const origin = path.join(tmp, 'origin.git');
  fs.mkdirSync(repo, { recursive: true });
  git(tmp, ['init', '--bare', origin]);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'initial']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-u', 'origin', 'main']);
  git(repo, ['checkout', '-b', 'feature-x']); // no upstream yet: commit-and-push has to set one

  const gh = setUpFakeGh(tmp);
  if (!gh) console.log('note  no C compiler on PATH: gh-dependent checks are skipped on this run');

  const configDir = path.join(tmp, 'claude');
  const api = await fx.startFakeApi({ delay: 0 });
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir, env: { ...fx.fakeApiEnv(api), ...(gh ? { PATH: gh.dir + path.delimiter + process.env.PATH, ...gh.env } : {}) } });
  try { await run(fx, app, repo, origin, gh, configDir); }
  finally { await app.stop(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function run(fx, app, repo, origin, gh, configDir) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const sid = fx.makeSession(configDir, repo, 'aaaaaaaa-1111-2222-3333-444444444444');
  const bustCache = () => fetch(app.base + '/api/sessions/' + sid + '/pr?fresh=1', { headers: { authorization: 'Bearer ' + app.token } });

  const browsers = [];
  async function open(type, opts) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    browsers.push(browser);
    const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } window.open = () => null; }, app.token);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.goto(app.base + '/#/s/' + sid);
    await page.waitForSelector('#thread .msg');
    return { browser, page, errors };
  }
  try { await walkthrough(open, sid, repo, origin, gh, bustCache, app); }
  finally { for (const b of browsers) await b.close().catch(() => {}); }
}

async function walkthrough(open, sid, repo, origin, gh, bustCache, app) {
  const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });

  // 1. Changes panel: an uncommitted file offers Commit as WIP / Commit and push / Create draft PR.
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'first note\n');
  await page.click('#session-menu-btn');
  await until(() => page.isVisible('#session-menu .menu-item'), 5000);
  await page.click('#session-menu >> text=Changes');
  check('the Changes panel opens', await until(() => page.isVisible('#changes-panel:not(.hidden)'), 5000));
  check('the new file is listed', await until(() => page.$eval('#ch-list', (n) => n.textContent.includes('notes.txt')), 5000));
  check('Commit as WIP, Commit and push, and Create draft PR are offered', await until(async () => (await page.isVisible('#ch-commit-wip')) && (await page.isVisible('#ch-commit-push')) && (await page.isVisible('#ch-create-pr')), 5000));
  await page.screenshot({ path: path.join(SHOTS, 'git-changes.png') });

  // 2. Commit as WIP: one click, no dialog, nothing pushed.
  await page.click('#ch-commit-wip');
  check('Commit as WIP leaves a WIP commit', await until(() => git(repo, ['log', '-1', '--pretty=%s']).trim() === 'WIP'));
  check('...and does not push it', !fs.existsSync(path.join(origin, 'refs', 'heads', 'feature-x')));

  // 3. Commit and push: the dialog prefills a summary, stages, commits, and sets the upstream.
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'first note\nsecond note\n');
  await page.click('#ch-refresh');
  await until(() => page.$eval('#ch-list', (n) => n.textContent.includes('notes.txt')));
  await page.click('#ch-commit-push');
  check('the commit dialog opens with a prefilled summary', await until(() => page.isVisible('#commit-modal:not(.hidden)'), 3000));
  const prefill = await page.$eval('.commit-msg', (t) => t.value);
  check('...naming the changed file', /notes\.txt/.test(prefill), prefill);
  await page.click('#commit-modal .btn-primary');
  check('the branch is pushed and gets an upstream', await until(() => { git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', 'feature-x@{u}']); return true; }, 5000));
  check('...and origin has the commit', await until(() => git(origin, ['log', 'feature-x', '-1', '--pretty=%s']).trim() === prefill.trim()));

  if (gh) {
    // 4. No PR yet: Create draft PR calls `gh pr create --draft --fill`.
    gh.state({});
    await page.click('#ch-create-pr');
    check('Create draft PR calls gh pr create --draft --fill', await until(() => gh.calls().some((c) => c.name === 'pr-create' && c.args.includes('--draft') && c.args.includes('--fill')), 5000));

    // 5. An open draft PR, with a failing check and a PR stacked on top of it: the PR menu shows
    // Mark ready for review, the failing check, and the Related list - not Confirm merge yet.
    gh.state({
      pr: {
        number: 42, title: 'Add a feature', url: 'https://github.com/x/y/pull/42', state: 'OPEN', isDraft: true,
        mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', autoMergeRequest: null,
        statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE', detailsUrl: 'https://x/run/1' }],
        comments: [], reviews: [], headRefName: 'feature-x', baseRefName: 'main', updatedAt: new Date().toISOString(),
      },
      related: [{ number: 43, title: 'Depends on this one', url: 'https://github.com/x/y/pull/43', isDraft: false }],
      stack: {},
      inlineComments: [],
    });
    await bustCache(); // the server's own 45s PR cache would otherwise still answer the old scenario
    await page.reload(); // goto() to the page's own current URL is a same-document no-op; reload() forces it
    await page.waitForSelector('#thread .msg');
    check('the PR chip shows the failing check', await until(async () => (await page.isVisible('#sb-pr-state:not(.hidden)')) && /failing/.test(await page.$eval('#sb-pr-label', (n) => n.textContent)), 8000));
    await page.click('#sb-pr-state');
    await until(() => page.isVisible('#pr-menu .menu-item'), 5000);
    check('Mark ready for review is offered on a draft', await page.isVisible('#pr-menu >> text=Mark ready for review'));
    check('Confirm merge is not offered on a draft', !(await page.isVisible('#pr-menu >> text=Confirm merge')));
    check('the Related PR is listed', await page.isVisible('#pr-menu >> text=#43 Depends on this one'));
    check('Auto-fix and Auto-archive toggles are offered', (await page.isVisible('#pr-menu >> text=Auto-fix')) && (await page.isVisible('#pr-menu >> text=Auto-archive after PR merge or close')));
    await page.screenshot({ path: path.join(SHOTS, 'git-pr-menu.png') });

    // The menu re-renders in place after an action, so it stays open for the next click - no
    // need to close and reopen it between these.
    await page.click('#pr-menu >> text=Mark ready for review');
    check('Mark ready for review calls gh pr ready', await until(() => gh.calls().some((c) => c.name === 'pr-ready'), 5000));
    check('...and says so', await until(() => page.isVisible('text=Marked ready for review.'), 3000));

    // 6. Auto-fix and Auto-archive: checkmark toggles that re-render in place.
    await page.click('#pr-menu >> text=Auto-fix');
    check('Auto-fix gets its checkmark', await until(() => page.$eval('#pr-menu', (m) => [...m.querySelectorAll('.menu-item.sel')].some((n) => n.textContent.includes('Auto-fix')))));
    await page.click('#pr-menu >> text=Auto-archive after PR merge or close');
    check('Auto-archive gets its checkmark', await until(() => page.$eval('#pr-menu', (m) => [...m.querySelectorAll('.menu-item.sel')].some((n) => n.textContent.includes('Auto-archive')))));

    // 7. Not a draft, mergeable: Confirm merge runs `gh pr merge` with the repo's allowed method.
    gh.state({
      pr: {
        number: 42, title: 'Add a feature', url: 'https://github.com/x/y/pull/42', state: 'OPEN', isDraft: false,
        mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', autoMergeRequest: null,
        statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }], comments: [], reviews: [],
        headRefName: 'feature-x', baseRefName: 'main', updatedAt: new Date().toISOString(),
      },
      related: [], stack: {}, inlineComments: [], repoView: { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false },
    });
    await bustCache();
    await page.reload(); // same reason: goto() to an unchanged URL would not re-run the page
    await page.waitForSelector('#thread .msg');
    await until(() => page.isVisible('#sb-pr-state:not(.hidden)'), 8000);
    await page.click('#sb-pr-state');
    await until(() => page.isVisible('#pr-menu .menu-item'), 5000);
    check('Confirm merge is offered once mergeable', await page.isVisible('#pr-menu >> text=Confirm merge'));
    await page.click('#pr-menu >> text=Confirm merge');
    check('Confirm merge calls gh pr merge with the allowed method', await until(() => gh.calls().some((c) => c.name === 'pr-merge:--squash'), 5000));
  }

  // 8. Session menu: Open in editor, reusing the Files package's /api/fs/open-editor.
  await page.click('#session-menu-btn');
  await until(() => page.isVisible('#session-menu .menu-item'), 5000);
  check('Open in editor is in the session menu', await page.isVisible('#session-menu >> text=Open in editor'));
  await page.keyboard.press('Escape');

  // Phone / WebKit: the Changes panel and PR menu still have to work at 390px.
  await browser.close();
  const { browser: wbrowser, page: wpage, errors: werrors } = await open(webkit, devices['iPhone 15 Pro Max']);
  await wpage.click('#session-menu-btn');
  await until(() => wpage.isVisible('#session-menu .menu-item'), 5000);
  await wpage.click('#session-menu >> text=Changes');
  check('[phone/WebKit] the Changes panel opens', await until(() => wpage.isVisible('#changes-panel:not(.hidden)'), 5000));
  check('[phone/WebKit] git actions are offered', await until(() => wpage.isVisible('#ch-actions:not(.hidden)'), 5000));
  await wpage.screenshot({ path: path.join(SHOTS, 'git-changes-phone.png') });
  check('[phone/WebKit] no page errors', werrors.length === 0, werrors.join('; '));
  await wbrowser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
