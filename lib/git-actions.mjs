// Git actions for a session's folder: Desktop's Changes panel and PR menu buttons, driven by
// the same `git` and `gh` already on this machine - no token of our own, same as lib/pr.mjs.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const git = (cwd, args, opts = {}) => execFileP('git', ['-C', cwd, ...args], { timeout: 20000, windowsHide: true, ...opts });
const gh = (cwd, args, opts = {}) => execFileP('gh', args, { cwd, timeout: 30000, windowsHide: true, ...opts });

/** The last line a failed git/gh call printed - the part that says what went wrong. */
export const cliError = (e) => String(e.stderr || e.message || e).trim().split('\n').filter(Boolean).slice(-1)[0] || 'the command refused';

async function hasUpstream(cwd) {
  try { await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']); return true; } catch { return false; }
}
async function currentBranch(cwd) { return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(); }

/** Push the current branch, setting its upstream on `origin` the first time. */
export async function push(cwd) {
  const branch = await currentBranch(cwd);
  if (await hasUpstream(cwd)) { await git(cwd, ['push'], { timeout: 60000 }); return branch; }
  await git(cwd, ['push', '-u', 'origin', branch], { timeout: 60000 });
  return branch;
}

/** Stage everything and commit. Returns false if there was nothing to commit. */
async function commit(cwd, message) {
  await git(cwd, ['add', '-A']);
  try { await git(cwd, ['commit', '-m', message]); return true; }
  catch (e) { if (/nothing to commit/i.test(String(e.stdout || e.message))) return false; throw e; }
}

/** "Commit and push": stage all, commit with the message from the dialog, push the branch. */
export async function commitAndPush(cwd, message) {
  const committed = await commit(cwd, message || 'update');
  const branch = await push(cwd);
  return { committed, branch };
}

/** "Commit as WIP": a quick local checkpoint, no message to type and nothing pushed - Desktop's
 * "Committed work stays on its branch." */
export async function commitWip(cwd) {
  return { committed: await commit(cwd, 'WIP') };
}

/** "Create draft PR": push first (`gh pr create` refuses a branch GitHub has never seen), then
 * `gh pr create --draft --fill` exactly as Desktop runs it. */
export async function createDraftPr(cwd) {
  await push(cwd);
  const r = await gh(cwd, ['pr', 'create', '--draft', '--fill']);
  return { url: r.stdout.trim().split('\n').pop() };
}

/** "Mark ready for review": `gh pr ready` turns a draft into a real PR. */
export async function markReady(cwd) { await gh(cwd, ['pr', 'ready']); }

/** Which merge method this repository actually allows - GitHub lets an owner turn any of the
 * three off, and `gh pr merge` with a disallowed one just fails. Squash first: it is GitHub's
 * own default when more than one is on. */
export async function allowedMergeMethod(cwd) {
  try {
    const r = await gh(cwd, ['repo', 'view', '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed']);
    const j = JSON.parse(r.stdout);
    if (j.squashMergeAllowed) return 'squash';
    if (j.mergeCommitAllowed) return 'merge';
    if (j.rebaseMergeAllowed) return 'rebase';
  } catch {}
  return 'squash';
}

/** "Confirm merge": `gh pr merge` with the repo's allowed method. The confirm itself is the
 * caller's job (a dialog before this is ever called). */
export async function mergePr(cwd) {
  const method = await allowedMergeMethod(cwd);
  await gh(cwd, ['pr', 'merge', '--' + method]);
  return method;
}
