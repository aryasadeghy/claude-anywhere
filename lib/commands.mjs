// The "/" menu's Claude Code half: supportedCommands(), for a folder that has no live run yet
// (a resting session, or the folder picked for a new one). Asking costs a CLI process, the same
// way lib/models.mjs asks for the model list - an input that never yields, the control-protocol
// call, then the process closed again - so the answer is cached per folder for a few minutes
// rather than asked on every keystroke.
//
// A *live* run answers this question for itself (`run.query.supportedCommands()`, server.mjs's
// /api/commands route) and keeps this cache fresh behind it: Claude Code's own
// `system/commands_changed` push (skills discovered mid-session, say) lands in lib/runs.mjs's
// message switch and calls `update()` here, so the next session opened in the same folder does
// not ask again for something the CLI just told this process.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { authEnv } from './auth.mjs';
import * as claudeCode from './claude-code.mjs';

const TTL = 3 * 60 * 1000; // "a few minutes" - long enough that typing "/" twice in a row is free

const cache = new Map();    // cwd -> { at, commands }
const inFlight = new Map(); // cwd -> Promise, so two popovers opened at once share one CLI process

async function ask(cwd, env) {
  const never = (async function* () { await new Promise(() => {}); })();
  const q = query({ prompt: never, options: { cwd, env: env || authEnv(), ...claudeCode.spawnOptions() } });
  try {
    const commands = await q.supportedCommands();
    return Array.isArray(commands) ? commands : [];
  } finally {
    // Same reasoning as models.mjs: ending the generator is what closes the subprocess.
    try { await q.return(undefined); } catch {}
  }
}

/** The commands for this folder - cached, refreshed behind the scenes once stale. */
export async function forFolder(cwd, { env, force = false } = {}) {
  if (!cwd) return [];
  const row = cache.get(cwd);
  if (!force && row && Date.now() - row.at < TTL) return row.commands;
  if (inFlight.has(cwd)) return inFlight.get(cwd);
  const p = ask(cwd, env)
    .then((commands) => { cache.set(cwd, { at: Date.now(), commands }); return commands; })
    .catch((e) => { if (row) return row.commands; throw e; }) // a stale list beats none, once there was one
    .finally(() => inFlight.delete(cwd));
  inFlight.set(cwd, p);
  return p;
}

/** A live run just heard a fresher list from the CLI itself - replace, per commands_changed's own contract. */
export function update(cwd, commands) {
  if (cwd && Array.isArray(commands)) cache.set(cwd, { at: Date.now(), commands });
}

export function forget(cwd) {
  if (cwd) cache.delete(cwd); else cache.clear();
}
