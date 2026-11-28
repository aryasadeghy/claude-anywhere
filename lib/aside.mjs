// Desktop's "aside": a message sent while Claude is at work is answered at once, by a small fast
// model that has read the conversation so far, in one or two sentences, while the real work
// carries on. The message itself still goes into the turn untouched (lib/runs.mjs yields it at
// once - holding it back for the aside would hold it past the step it was meant to change), and
// Claude is told afterwards what the aside said, so it does not repeat it or contradict it.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { envFor } from './auth.mjs';
import * as claudeCode from './claude-code.mjs';
import { historyPage } from './history.mjs';

export const ASIDE_MODEL = 'claude-haiku-4-5-20251001';
export const TIMEOUT_MS = 8000;
// The fake API in test/fixtures recognises a request by this sentence.
export const SYSTEM = [
  'You are Claude, in the middle of a task for the person you are talking to. They just sent a message while you are still working.',
  'Answer it at once with an aside: a short reply in your voice, one or two plain sentences, written from the conversation so far.',
  'If they ask how it is going, say what you are doing and how far along it is. If it is a new instruction or a change, say you will take it into account at your next step. If it is a question you can answer from the conversation, answer it.',
  'You cannot use tools or do anything yourself right now: never say you have done something you have not. No headings, no lists, no preamble.',
].join(' ');

const textOf = (c) => (typeof c === 'string' ? c : (c || []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n'));
const strip = (t) => t.replace(/<(system-reminder|task-notification)[\s\S]*?<\/\1>/g, '').trim();

/** The recent conversation as plain lines: the transcript's tail (what the person and Claude said, and which tools ran), or the run's own events for a session with no transcript yet. */
export async function recent(run, { chars = 6000 } = {}) {
  const lines = [];
  try {
    const page = run.sessionId ? await historyPage(run.sessionId, { lines: 40 }) : null;
    for (const m of page?.messages || []) {
      if (m.role === 'user') { const t = strip(textOf(m.content)); if (t) lines.push('Person: ' + t.slice(0, 800)); }
      else if (m.role === 'assistant') {
        for (const b of m.content || []) {
          if (b.type === 'text' && b.text?.trim()) lines.push('You: ' + b.text.trim().slice(0, 800));
          else if (b.type === 'tool_use') lines.push(`(you used ${b.name}${b.input?.description ? ': ' + b.input.description : b.input?.command ? ': ' + String(b.input.command).slice(0, 120) : b.input?.file_path ? ': ' + b.input.file_path : ''})`);
        }
      }
    }
  } catch {}
  if (!lines.length) {
    for (const e of run.events) {
      if (e.t === 'prompt' || e.t === 'queued') { const t = strip(e.text || ''); if (t && lines[lines.length - 1] !== 'Person: ' + t) lines.push('Person: ' + t.slice(0, 800)); }
      else if (e.t === 'assistant') for (const b of e.content || []) { if (b.type === 'text' && b.text?.trim()) lines.push('You: ' + b.text.trim().slice(0, 800)); else if (b.type === 'tool_use') lines.push('(you used ' + b.name + ')'); }
    }
  }
  let out = '';
  for (let i = lines.length - 1; i >= 0 && out.length < chars; i--) out = lines[i] + '\n' + out;
  return out.trim();
}

/** The aside's text, or '' when it fails or is not back in time - then nothing is shown. */
export async function write(run, message, { timeout = TIMEOUT_MS } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  try {
    const env = envFor();
    const context = await recent(run);
    const prompt = (context ? 'The conversation so far:\n\n' + context + '\n\n' : '') + 'The message they just sent while you were working:\n\n' + message + '\n\nWrite your aside now.';
    for await (const msg of query({ prompt, options: { env, abortController: abort, model: env.ANTHROPIC_MODEL || ASIDE_MODEL, maxTurns: 1, tools: [], persistSession: false, settingSources: [], systemPrompt: SYSTEM, cwd: run.cwd, ...claudeCode.spawnOptions() } })) {
      if (msg.type === 'result') return msg.is_error ? '' : String(msg.result || '').trim().slice(0, 600);
    }
    return '';
  } catch { return ''; }
  finally { clearTimeout(timer); abort.abort(); }
}

/**
 * Write the aside for a message just sent mid-turn, show it under the message, and tell Claude
 * what it said (only if the turn is still going: a turn that has ended is not started again for
 * a note).
 */
export async function answer(run, { id, text }) {
  const said = await write(run, text);
  if (!said || run.done || run.taken.has(id)) return '';
  run.push({ t: 'aside', id, text: said, at: Date.now() });
  run.note(id, `<system-reminder>While you were working, the person was shown this instant reply to their message "${text.slice(0, 200).replace(/\s+/g, ' ')}", written for you by a small model that could not do any work: "${said}". Do not repeat it; your work carries on and answers them properly. No reply to this note is needed.</system-reminder>`);
  return said;
}
