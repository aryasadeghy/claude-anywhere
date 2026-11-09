// What the pull request for a session's branch is doing: checks, reviews, auto-merge.
//
// Everything comes from the `gh` CLI that is already signed in on this machine. We
// hold no token and make no network call of our own; if gh is missing or signed out,
// the bar simply says so instead of pretending there is no pull request.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const FIELDS = 'number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,statusCheckRollup,comments,reviews,headRefName,baseRefName,updatedAt';

const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];

// gh reports a check run as `conclusion` and a commit status as `state`, and a run
// that has not finished has neither.
const outcome = (c) => String(c.conclusion || c.state || '').toUpperCase();

function shape(j) {
  const rollup = Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup : [];
  const failed = rollup.filter((c) => FAILED.includes(outcome(c)));
  const passed = rollup.filter((c) => PASSED.includes(outcome(c)));
  const pending = rollup.filter((c) => !FAILED.includes(outcome(c)) && !PASSED.includes(outcome(c)));
  const said = [
    ...(j.reviews || []).filter((r) => (r.body || '').trim() || r.state === 'CHANGES_REQUESTED'),
    ...(j.comments || []),
  ]
    .map((r) => ({
      author: r.author?.login || '',
      body: String(r.body || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      state: r.state || '',
      at: r.submittedAt || r.createdAt || '',
    }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    has: true,
    number: j.number,
    title: j.title,
    url: j.url,
    state: j.state,
    draft: !!j.isDraft,
    branch: j.headRefName,
    mergeable: j.mergeable,
    mergeState: j.mergeStateStatus,
    review: j.reviewDecision || '',
    autoMerge: !!j.autoMergeRequest,
    checks: {
      total: rollup.length,
      passed: passed.length,
      failed: failed.length,
      pending: pending.length,
      failing: failed.slice(0, 6).map((c) => ({ name: c.name || c.context || 'check', url: c.detailsUrl || c.targetUrl || '' })),
    },
    comments: said.slice(0, 8),
    commentCount: said.length,
    base: j.baseRefName || '',
  };
}

// PRs whose base is this branch - what would land on top of it once it merges.
async function relatedPrs(cwd, branch) {
  if (!branch) return [];
  try {
    const out = await execFileP('gh', ['pr', 'list', '--base', branch, '--state', 'open', '--json', 'number,title,url,isDraft'], { cwd, timeout: 15000, windowsHide: true });
    return (JSON.parse(out.stdout) || []).map((r) => ({ number: r.number, title: r.title, url: r.url, draft: !!r.isDraft }));
  } catch { return []; }
}

// This PR's base, and that branch's own PR's base, and so on - the stack it sits on. Stops at
// the first base with no open PR (usually the repository's default branch).
async function stackedOn(cwd, baseBranch, depth = 5) {
  const chain = [];
  let ref = baseBranch;
  while (ref && depth-- > 0) {
    let j;
    try {
      const out = await execFileP('gh', ['pr', 'view', ref, '--json', 'number,title,url,isDraft,baseRefName'], { cwd, timeout: 15000, windowsHide: true });
      j = JSON.parse(out.stdout);
    } catch { break; }
    chain.push({ number: j.number, title: j.title, url: j.url, draft: !!j.isDraft });
    ref = j.baseRefName;
  }
  return chain;
}

// Inline review comments - a GitHub thing gh pr view's own `comments`/`reviews` fields leave
// out, since those only carry the top-level discussion. Auto-fix needs the file and line a
// reviewer actually pointed at, not just that someone commented.
async function inlineComments(cwd, number) {
  if (!number) return [];
  try {
    const out = await execFileP('gh', ['api', `repos/{owner}/{repo}/pulls/${number}/comments`], { cwd, timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const rows = JSON.parse(out.stdout);
    return (Array.isArray(rows) ? rows : [])
      .filter((c) => !c.in_reply_to_id) // a thread's opening comment, not every reply under it
      .map((c) => ({ path: c.path || '', line: c.line ?? c.original_line ?? null, body: String(c.body || '').replace(/\s+/g, ' ').trim().slice(0, 240), author: c.user?.login || '' }))
      .slice(0, 20);
  } catch { return []; }
}

/** Read the pull request for whatever branch is checked out in `cwd`, together with the PRs
 * stacked on top of it and the chain of PRs it is itself stacked on. */
export async function read(cwd) {
  let out;
  try {
    out = await execFileP('gh', ['pr', 'view', '--json', FIELDS], { cwd, timeout: 20000, windowsHide: true });
  } catch (e) {
    const msg = String(e.stderr || e.message || '');
    if (e.code === 'ENOENT' || /is not recognized|command not found/i.test(msg)) return { has: false, noCli: true };
    if (/gh auth login|authentication|not logged in/i.test(msg)) return { has: false, needsAuth: true };
    if (/no pull requests found|no default remote|not a git repository|could not determine/i.test(msg)) return { has: false };
    return { has: false, error: msg.trim().split('\n').filter(Boolean)[0] || 'gh refused' };
  }
  let j; try { j = JSON.parse(out.stdout); } catch { return { has: false }; }
  const base = shape(j);
  // Best-effort: a slow or unreachable extra call must not blank the checks/reviews that matter most.
  const [related, stack, inline] = await Promise.all([
    relatedPrs(cwd, j.headRefName).catch(() => []),
    stackedOn(cwd, j.baseRefName).catch(() => []),
    inlineComments(cwd, j.number).catch(() => []),
  ]);
  base.related = related;
  base.stack = stack;
  base.inlineComments = inline;
  return base;
}

/** Turn GitHub's own auto-merge on or off for that pull request. */
export async function setAutoMerge(cwd, on, method = 'squash') {
  const how = ['merge', 'squash', 'rebase'].includes(method) ? method : 'squash';
  const args = on ? ['pr', 'merge', '--auto', '--' + how] : ['pr', 'merge', '--disable-auto'];
  await execFileP('gh', args, { cwd, timeout: 30000, windowsHide: true });
}

// One reading per folder per minute is plenty: the bar polls while a session is open
// and several devices can be watching the same one.
const cache = new Map();
const TTL = 45000;
export async function cached(cwd) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await read(cwd);
  cache.set(cwd, { at: Date.now(), value });
  return value;
}
export const forget = (cwd) => cache.delete(cwd);
