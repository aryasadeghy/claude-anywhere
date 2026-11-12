// One live Claude Code process per session, driven the way the Desktop app
// drives it: streaming input (so messages typed while Claude works are queued,
// not refused), permission mode / model / effort switchable mid-turn, and every
// status signal the SDK gives (tool progress, task notifications, token usage)
// forwarded to the client. Events are buffered so a phone that drops off can
// reconnect and catch up. Continuing a session appends to that session's own
// transcript, exactly as `claude --resume` does from a terminal.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { authEnv } from './auth.mjs';
import * as models from './models.mjs';
import * as commandsMod from './commands.mjs';
import { taskFrom } from './history.mjs';
import { sessionFile } from './tail.mjs';
import * as claudeCode from './claude-code.mjs';
import toolsTerminal from './tools-terminal.mjs';
import conversationTools from './tools-conversation.mjs';
import routinesTools from './tools-routines.mjs';

// Desktop gives Claude a SendUserFile tool so it can hand finished files (a video, a
// cover image, a PDF) to the person in the chat. The SDK's Claude Code does not have
// it, so this in-process tool fills the gap; the client renders it like Desktop does.
const sendUserFile = () => ({
  allow: ['SendUserFile'],
  tools: [
    tool(
      'SendUserFile',
      'Show files you produced to the user inside the chat: images, video, audio, PDFs, documents. Use it whenever the result of the work is a file the user should see or download, instead of only mentioning the path. Files must exist on disk; give absolute paths.',
      { files: z.array(z.string()).min(1).describe('Absolute paths of the files to show'), caption: z.string().optional().describe('One or two lines describing what these files are') },
      async ({ files, caption }) => {
        const missing = files.filter((f) => { try { return !fs.statSync(f).isFile(); } catch { return true; } });
        const ok = files.filter((f) => !missing.includes(f));
        const lines = [`${ok.length} file${ok.length === 1 ? '' : 's'} shown to the user in the chat.`];
        for (const f of ok) lines.push(`  ${f}`);
        if (missing.length) lines.push(`Not found: ${missing.join(', ')}`);
        if (caption) lines.push(`Caption: ${caption}`);
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: ok.length === 0 };
      },
    ),
  ],
});

// Claude's tools that come from the app itself, one pack per feature. A pack is a function of
// the run giving { tools: [tool(...)], allow: ['Name'] } - the names in `allow` run without
// asking; the rest ask like any tool. Add a pack to TOOL_PACKS, nowhere else.
const TOOL_PACKS = [sendUserFile, toolsTerminal, conversationTools, routinesTools];
// A fresh server for every run: one createSdkMcpServer instance binds to one transport.
function makeAppServer(run) {
  const packs = TOOL_PACKS.map((pack) => pack(run)).filter(Boolean);
  return {
    server: createSdkMcpServer({ name: 'claude-anywhere', version: '1.0.0', tools: packs.flatMap((p) => p.tools || []) }),
    allow: packs.flatMap((p) => (p.allow || []).map((n) => 'mcp__claude-anywhere__' + n)),
  };
}

export const runs = new Map();               // sessionId -> Run
export const pendingPermissions = new Map(); // reqId -> { run, resolve }
export const bus = new EventEmitter();       // 'permission' | 'turn_done' — the desktop app turns these into notifications

// Which models exist, and which effort levels each one takes, is the CLI's answer —
// see lib/models.mjs. A list written here drifted from Claude the day a model changed.
// bypassPermissions and dontAsk are left out on purpose: the first runs everything
// unattended, the second silently denies. 'auto' lets Claude's own classifier
// approve routine actions and still asks (here, on the phone) for the rest.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];
// The SDK's own set. 'high' is what a model runs at when no level is asked for, and
// 'max' is session-only — it is never written to a settings file.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Last known context-window usage per session and the account's rate limits, from the
// CLI's own control requests; what the Desktop "Context window / Plan usage" popover shows.
export const contextBySession = new Map(); // sessionId -> { totalTokens, maxTokens, percentage, model, at }
export let lastLimits = null;              // { subscription_type, rate_limits, at }
// When this computer's claude.ai sign-in ends for good, as Claude Code last reported it: a phone
// cannot run `claude login`, so the app says so days ahead rather than at the first 401.
export let credentialExpiresAt = null;
// Limits survive a restart so the banner and popover are right from the first screen.
const LIMITS_FILE = (process.env.CLAUDE_ANYWHERE_DATA_DIR || process.env.CLAUDE_REMOTE_DATA_DIR || new URL('../data', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) + '/limits.json';
try { const saved = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')); if (saved && Date.now() - saved.at < 7 * 24 * 3600 * 1000) lastLimits = saved; } catch {}
async function refreshUsage(run) {
  const q = run.query; if (!q) return;
  try {
    const c = await q.getContextUsage();
    const ctx = { totalTokens: c.totalTokens, maxTokens: c.maxTokens, percentage: c.percentage, model: c.model, at: Date.now() };
    if (run.sessionId) contextBySession.set(run.sessionId, ctx);
    run.push({ t: 'context', ...ctx });
  } catch {}
  try {
    // Only the limits are read here, after every turn: without skipBehaviors each call also
    // scanned the last week of transcripts for its usage advice, which nothing here shows.
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    lastLimits = { subscription_type: u.subscription_type, rate_limits: u.rate_limits_available ? u.rate_limits : null, at: Date.now() };
    run.push({ t: 'limits', ...lastLimits });
    try { fs.mkdirSync(LIMITS_FILE.replace(/[\\/][^\\/]+$/, ''), { recursive: true }); fs.writeFileSync(LIMITS_FILE, JSON.stringify(lastLimits)); } catch {}
  } catch {}
}

// Events a client only ever needs the newest of: each one replaces what the last one said.
const REPLACED = new Set(['tasks', 'usage', 'tool_progress', 'context', 'limits', 'commands']);

// A run's process is kept a while after its answer. The next message then goes straight into it
// instead of starting Claude Code again - spawning it, resuming the session, connecting every
// connector - which is a second or more before Claude even sees the message, and more on a big
// session. Desktop keeps its sessions open the same way. A few at most, and never one that
// another window has gone on with since: its picture of the conversation is out of date.
const KEEP_WARM_MS = 10 * 60 * 1000;
const MAX_RESTING = 3;
// Another Claude Code was chosen in Settings: a resting process goes now, so the next message
// starts the new one. A turn under way finishes on the one it began with (maybeClose).
claudeCode.onChange(() => { for (const r of runs.values()) if (r.rest) r.close(); });
// Has anyone else written conversation since `size`? The resting process itself only adds titles
// and queue bookkeeping, which start with their type; a turn elsewhere adds user/assistant lines.
function wroteSince(id, size) {
  const file = sessionFile(id);
  if (!file) return false;
  try {
    const st = fs.statSync(file);
    if (st.size <= size) return false;
    const len = Math.min(st.size - size, 1 << 20), buf = Buffer.alloc(len), fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, size); } finally { fs.closeSync(fd); }
    return buf.toString('utf8').split('\n').some((l) => { if (!l.startsWith('{"parentUuid"')) return false; try { const j = JSON.parse(l); return !j.isSidechain && (j.type === 'user' || j.type === 'assistant'); } catch { return false; } });
  } catch { return false; }
}
const fileSize = (id) => { try { const f = sessionFile(id); return f ? fs.statSync(f).size : 0; } catch { return 0; } };

export class Run {
  constructor(sessionId) {
    this.id = randomUUID();
    this.sessionId = sessionId || null; // filled in at `init` for a new session
    this.events = [];
    this.listeners = new Set();
    this.abort = new AbortController();
    this.done = false;
    this.startedAt = Date.now();
    this.query = null;      // the SDK Query, for mid-turn control
    this.queue = [];        // messages typed while Claude works
    this.wake = null;
    this.closing = false;
    this.inTurn = false;
    this.controls = {};
    this.tasks = new Map();  // task_id -> what the Desktop tasks panel shows: commands, subagents, workflows
    this.sent = new Map();   // uuid -> queued item handed to the CLI but not yet taken up by a turn
    this.turnFrom = 0;       // the event the turn under way began with (the first prompt's, to begin with)
    this.turnStartedAt = this.startedAt;
    this.rest = null;        // { since, size, timer, watch } while the process waits for the next message
  }
  // A turn starts. A page opening the session now replays this turn, not every turn this
  // process has served - those are in the transcript, which the page reads anyway.
  startTurn() { this.turnFrom = this.events.length; this.turnStartedAt = Date.now(); }
  // Working on something: a turn, a message about to run, or a background task.
  busy() { return !this.done && !this.closing && (this.inTurn || this.queue.length > 0 || this.sent.size > 0 || this.liveBackground()); }
  // The CLI took a queued message into a turn: the dashed bubble becomes a real one, in place.
  consume(uuids) {
    for (const id of uuids || []) {
      const item = this.sent.get(id); if (!item) continue;
      this.sent.delete(id);
      this.push({ t: 'prompt', id, text: item.text, images: (item.images || []).map(imageBlock), at: Date.now() });
    }
  }
  // The panel gets the whole set every time (replace semantics), so a missed edge cannot wedge a row.
  pushTasks() { this.push({ t: 'tasks', tasks: [...this.tasks.values()].filter((t) => !t.ambient) }); }
  liveBackground() { return [...this.tasks.values()].some((t) => t.status === 'running' && t.backgrounded && !t.ambient); }
  // When nothing is left to do (turn over, queue empty, no background work) the process rests,
  // ready for the next message, and goes when it has rested long enough, when too many others
  // rest too, or as soon as another window writes to the session.
  maybeClose() {
    if (this.closing || this.done) return;
    if (this.busy()) { this.wakeUp(); return; }
    // Claude Code was updated (or taken back) during this turn: the next message starts the new one.
    if (this.cli !== claudeCode.version()) { this.close(); return; }
    if (this.rest) return;
    const since = Date.now(), size = fileSize(this.sessionId);
    this.rest = { since, size, timer: setTimeout(() => this.close(), KEEP_WARM_MS), watch: setInterval(() => { if (wroteSince(this.sessionId, size)) this.close('elsewhere'); }, 3000) };
    const resting = [...runs.values()].filter((r) => r.rest && !r.done).sort((a, b) => a.rest.since - b.rest.since);
    while (resting.length > MAX_RESTING) resting.shift().close();
  }
  wakeUp() { if (!this.rest) return; clearTimeout(this.rest.timer); clearInterval(this.rest.watch); this.rest = null; }
  // Let the process go - unless a message or a task came in meanwhile. `elsewhere`: another
  // window went on with the session, and pages should read it again from the transcript.
  close(why) { this.wakeUp(); if (this.closing || this.done || this.busy()) return; this.closeWhy = why; this.closing = true; this.wake?.(); }
  // What a page opening the session needs from this run: that it runs (`init` - it carries the
  // controls as they are now), the newest task list, context and limits, then the turn under
  // way and any message waiting to run. The turns before are in the transcript.
  attach() {
    let from = this.inTurn ? this.turnFrom : this.events.length;
    const pending = new Set([...this.queue.map((q) => q.id), ...this.sent.keys()]);
    if (pending.size) { const q = this.events.find((e) => e.t === 'queued' && pending.has(e.id)); if (q && q.i < from) from = q.i; }
    const head = new Map();
    for (let k = 0; k < from; k++) { const ev = this.events[k]; if (ev.t === 'init' || ev.t === 'tasks' || ev.t === 'context' || ev.t === 'limits') head.set(ev.t, ev); }
    // `init` says "running", which a page reads as answering: between turns, say it is not.
    const ready = this.inTurn ? [] : [{ t: 'ready' }];
    return [...[...head.values()].sort((a, b) => a.i - b.i), ...this.backlog(from - 1), ...ready];
  }
  async stopTask(taskId) { if (!this.query || !this.tasks.has(taskId)) return false; await this.query.stopTask(taskId); return true; }
  async backgroundTask(taskId) { const t = this.tasks.get(taskId); if (!this.query || !t?.toolUseId) return false; return this.query.backgroundTasks(t.toolUseId); }
  push(ev) {
    ev.i = this.events.length;
    this.events.push(ev);
    const line = `id: ${ev.i}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.listeners) res.write(line);
  }
  // Everything after `since`, in as few events as draw the same thread. An hour of work is
  // tens of thousands of events - a streamed answer arrives a few characters at a time, and
  // every tick of a background agent resends the task list - and a page that came back to
  // the session replayed them one by one: the whole hour again, at speed, before it showed
  // the present. So a streamed block's pieces become one, and of the events that each
  // replace the one before, only the newest is kept.
  backlog(since) {
    const events = this.events.slice(Math.max(0, since + 1));
    const newest = new Map();
    for (const ev of events) if (REPLACED.has(ev.t)) newest.set(ev.t, ev);
    const out = [];
    for (const ev of events) {
      if (REPLACED.has(ev.t)) { if (newest.get(ev.t) === ev) out.push(ev); continue; }
      const prev = out[out.length - 1];
      if (ev.t === 'delta' && prev?.t === 'delta' && prev.index === ev.index && prev.kind === ev.kind) out[out.length - 1] = { ...prev, text: prev.text + ev.text, i: ev.i };
      else out.push(ev);
    }
    return out;
  }
  finish() {
    this.wakeUp();
    this.done = true;
    this.finishedAt = Date.now();
    for (const res of this.listeners) res.end();
    this.listeners.clear();
    // keep the buffer a while so a reconnecting client still sees the tail
    setTimeout(() => { if (runs.get(this.sessionId) === this) runs.delete(this.sessionId); }, 5 * 60 * 1000);
  }
  // Queue a follow-up. It is handed to Claude as soon as the current turn ends
  // (the Desktop/Remote Control behaviour). Returns null if this process is
  // already shutting down; the caller then starts a fresh one.
  // `id` is the page's own for the message, so the bubble it already drew is the one that turns
  // solid when the turn takes the message up - not a second one.
  enqueue(text, images = [], id = randomUUID()) {
    if (this.closing || this.done) return null;
    // Another window went on with the session while this process rested: it no longer knows the
    // conversation. Let it go; the caller starts afresh from the transcript.
    if (this.rest && wroteSince(this.sessionId, this.rest.size)) { this.close('elsewhere'); return null; }
    this.wakeUp();
    const item = { id, text, images };
    this.queue.push(item);
    this.push({ t: 'queued', id: item.id, text, images: images.map(imageBlock) });
    this.wake?.();
    // Writing in the chat while Claude's question is open is the answer, as in Desktop: the card
    // closes as "replied in the chat", and Claude reads the message next.
    if (this.caps?.has('ask_user_question_unanswered_v1')) for (const [reqId, p] of pendingPermissions) if (p.run === this && isAsk(this.events.find((e) => e.t === 'permission' && e.reqId === reqId)?.tool)) answerPermission(reqId, 'deny', false, null, 'replied_in_chat');
    return item.id;
  }
  // Stop the current turn (like Esc / the stop button). Queued messages are dropped - and so are
  // the ones already handed to Claude Code, which ran as a turn of their own right after the Stop:
  // a CLI that can (interrupt_cancel_queued_v1) gives them back, and they are returned here so the
  // page that pressed Stop puts them back in its box, as Esc does in the CLI.
  async stop() {
    this.wakeUp();
    const taken = this.queue; this.queue = []; this.stopped = true;
    if (this.query && this.inTurn) {
      try {
        const r = await this.query.interrupt(...(this.caps?.has('interrupt_cancel_queued_v1') ? [{ cancelQueued: true }] : []));
        for (const id of r?.cancelled || []) { const item = this.sent.get(id); if (item) { this.sent.delete(id); taken.push(item); } }
        if (taken.length) this.push({ t: 'unqueued', ids: taken.map((x) => x.id) });
        return taken;
      } catch {}
    }
    if (taken.length) this.push({ t: 'unqueued', ids: taken.map((x) => x.id) });
    this.closing = true; this.wake?.();
    this.abort.abort();
    return taken;
  }
  async setControls({ permissionMode, model, effort, ultracode, fast }) {
    const applied = {};
    if (!this.query) return applied;
    if (permissionMode && PERMISSION_MODES.includes(permissionMode) && permissionMode !== 'bypassPermissions') { await this.query.setPermissionMode(permissionMode); applied.permissionMode = permissionMode; }
    else if (permissionMode === 'bypassPermissions') { try { await this.query.setPermissionMode('bypassPermissions'); applied.permissionMode = permissionMode; } catch { applied.note = 'Bypass takes effect on the next turn.'; } }
    const want = models.acceptable(model);
    if (want) { await this.query.setModel(want === 'default' ? undefined : want); applied.model = want; }
    // Ultracode is its own flag, not an effort level: standing workflow orchestration. It travels
    // with effort because that is one control to a person - and because an effort change sent
    // without it turns it off. Fast mode is a flag too, and the CLI's opt-in for an SDK session.
    if (effort !== undefined || ultracode !== undefined || fast !== undefined) {
      const settings = {};
      if (effort !== undefined) settings.effortLevel = EFFORTS.includes(effort) ? effort : null;
      if (ultracode !== undefined) settings.ultracode = !!ultracode;
      if (fast !== undefined) settings.fastMode = !!fast;
      await this.query.applyFlagSettings(settings);
      if (effort !== undefined) applied.effort = settings.effortLevel || '';
      if (ultracode !== undefined) applied.ultracode = !!ultracode;
      if (fast !== undefined) applied.fast = !!fast;
    }
    Object.assign(this.controls, applied);
    this.push({ t: 'controls', ...applied });
    return applied;
  }

  // ---------- queued message controls (Desktop's row menu on a dashed bubble) ----------
  // By the time a message is shown queued it is already at the CLI - `enqueue` below hands it
  // straight to the input stream, which the generator yields without waiting for a turn to be
  // free - so the CLI's own per-message controls are what remove or promote one. Anything still
  // only in `this.queue` has not been yielded yet (a window too small to matter in practice) and
  // is simplest to splice out here instead.
  orderedQueue() { return [...this.sent.values(), ...this.queue]; }
  async removeQueued(id) {
    const i = this.queue.findIndex((x) => x.id === id);
    if (i >= 0) { this.queue.splice(i, 1); this.push({ t: 'unqueued', ids: [id] }); return true; }
    if (!this.sent.has(id)) return false;
    // cancel_async_message has no typed Query method (interrupt() only ever forwards
    // cancelQueued, not a single uuid) - it is reached through the untyped Query.request the
    // typed methods themselves call. cancelled:false means the CLI already took it into a turn.
    let cancelled = true;
    if (this.query && typeof this.query.request === 'function') {
      try { const r = await this.query.request({ subtype: 'cancel_async_message', message_uuid: id }); cancelled = r?.response?.cancelled !== false; } catch {}
    }
    if (!cancelled) return false;
    this.sent.delete(id);
    this.push({ t: 'unqueued', ids: [id] });
    return true;
  }
  async sendNowQueued(id) {
    const i = this.queue.findIndex((x) => x.id === id);
    if (i >= 0) { const [item] = this.queue.splice(i, 1); this.queue.unshift(item); this.wake?.(); return true; } // not at the CLI yet - it is about to be anyway
    if (!this.sent.has(id)) return false;
    if (!this.caps?.has('interrupt_send_now_v1')) throw new Error('This Claude Code is too old for Send now.');
    if (!this.query || typeof this.query.request !== 'function') throw new Error("Send now isn't available for this session.");
    // The turn this cuts short ends in an error result, like a Stop: it is the point, not a failure.
    this.stopped = true;
    const r = await this.query.request({ subtype: 'interrupt', send_now: true, message_uuid: id });
    if (r?.response?.send_now === 'nothing_waiting') throw new Error('That message already started, or is gone.');
    return true;
  }
  // Drag-to-reorder: the CLI has only cancel-one-uuid and bring-one-uuid-forward, no
  // "swap position N and M" - so a reorder cancels every id in the new order and re-queues them
  // in it; the generator (inputStream, below) re-yields them to the CLI in exactly that order. An
  // id the CLI already took into a turn by the time this runs is left running, not an error.
  async reorderQueued(idsInOrder) {
    const have = new Map(this.orderedQueue().map((x) => [x.id, x]));
    const ids = idsInOrder.map(String).filter((id) => have.has(id));
    if (ids.length < 2) return false;
    await Promise.all(ids.map((id) => (this.sent.has(id) && this.query?.request)
      ? this.query.request({ subtype: 'cancel_async_message', message_uuid: id }).catch(() => {}) : null));
    for (const id of ids) { this.sent.delete(id); const i = this.queue.findIndex((x) => x.id === id); if (i >= 0) this.queue.splice(i, 1); }
    this.queue.unshift(...ids.map((id) => have.get(id)));
    this.wake?.();
    this.push({ t: 'reordered', ids });
    return true;
  }

  // Rewind needs a live Query to call rewindFiles on (lib/rewind.mjs and the server route use this).
  async rewindFiles(userMessageId, opts) {
    if (!this.query) throw new Error('This session has no live Claude Code to rewind files with.');
    return this.query.rewindFiles(userMessageId, opts);
  }
}

export const isLive = (id) => { const r = runs.get(id); return !!r && !r.done; };
// Live and working at something - not a process resting between turns.
export const isBusy = (id) => { const r = runs.get(id); return !!r && r.busy(); };

// Fast mode as Claude Code reports it on `init` and on each result: on, off, or cooling down after
// a rate limit - and, when it cannot serve, why ('extra_usage_disabled', 'not_first_party', …).
const fastOf = (msg) => (msg.fast_mode_state ? { state: msg.fast_mode_state, reason: msg.fast_mode_disabled_reason || '' } : undefined);

// AskUserQuestion is answered on the tool's own input; one that was not answered says how, where
// Claude Code can hear it (an older one refuses the whole answer, so it is a Skip there).
const isAsk = (tool) => tool === 'AskUserQuestion' || /(^|__)AskUserQuestion$/.test(tool || '');
const unanswered = (input, how) => ({ annotations: Object.fromEntries((input?.questions || []).map((q) => [q?.question, { unanswered: how }]).filter(([k]) => k)) });

function summariseInput(input) {
  if (!input || typeof input !== 'object') return '';
  // A question tool carries its question in a list, and that is the whole point of it.
  const asked = Array.isArray(input.questions) ? input.questions.map((q) => q && q.question).filter(Boolean).join(' · ') : '';
  const s = asked || input.command || input.file_path || input.pattern || input.path || input.description || input.url || input.query || input.prompt || '';
  return String(s).slice(0, 400);
}

// ExitPlanMode's own canUseTool input arrives normalized to `{}` - Claude Code injects `plan`
// (or `planFilePath`) from disk there, and when that file never existed (every plan mode run
// through this app so far) the injection comes back empty, dropping what the model actually
// wrote. The assistant message carrying the same tool_use is pushed to `run.events` before the
// tool runs, still holding the model's own input, so that is read back here instead.
function planInputFrom(run, input) {
  for (let i = run.events.length - 1; i >= 0; i--) {
    const e = run.events[i];
    if (e.t !== 'assistant' || !Array.isArray(e.content)) continue;
    const b = e.content.find((c) => c?.type === 'tool_use' && c.name === 'ExitPlanMode' && (c.input?.plan || c.input?.planFilePath));
    if (b) return { ...input, ...b.input };
  }
  return input;
}

// A user turn: text, plus any images (API image blocks) sent from the phone or dropped into the window.
export const imageBlock = (a) => ({ type: 'image', source: { type: 'base64', media_type: a.media_type, data: a.data } });
const userMessage = (text, images = []) => ({
  type: 'user',
  message: { role: 'user', content: images.length ? [...images.map(imageBlock), ...(text ? [{ type: 'text', text }] : [])] : text },
  parent_tool_use_id: null,
  session_id: '',
});

// Start a session process. Pass `sessionId` to continue, or only `cwd` for a new
// session. `ready` resolves with the session id as soon as the CLI reports it. `prompt` may be
// '' (no images either): a run started purely to get a live Query to run control requests on -
// rewind needs one, and the input stream below is already written to wait for a message when
// there isn't one yet, so this is just skipping the one line that would otherwise send it.
export function startRun({ sessionId, newId, cwd, prompt, images = [], model, permissionMode, effort, ultracode, fast, disabledMcp = [], promptId }) {
  const run = new Run(sessionId);
  run.cwd = cwd; // the folder it works in: removing a worktree asks whether Claude is at work there
  if (sessionId) runs.set(sessionId, run);
  const hasFirst = !!(prompt || images.length);
  const firstId = promptId || randomUUID(); // the page's own id for its bubble, when it sent one
  if (hasFirst) run.push({ t: 'prompt', id: firstId, text: prompt, images: images.map(imageBlock), at: run.startedAt }); // so a client that reloads mid-turn sees the question too
  run.controls = { permissionMode: PERMISSION_MODES.includes(permissionMode) ? permissionMode : 'default', model: models.acceptable(model) || models.providerDefault(), effort: EFFORTS.includes(effort) ? effort : '', ultracode: !!ultracode, fast: !!fast };

  let resolveInit, rejectInit;
  const ready = new Promise((res, rej) => { resolveInit = res; rejectInit = rej; });

  // Tool prompts are answered by the user in the web client; the turn waits.
  const canUseTool = (toolName, input, { signal, suggestions }) => new Promise((resolve) => {
    const reqId = randomUUID();
    if (toolName === 'ExitPlanMode' && !input?.plan) {
      input = planInputFrom(run, input);
      // A plan kept in its own file (long plans, or a teammate's): read it rather than show nothing.
      if (!input.plan && input.planFilePath) {
        try { input = { ...input, plan: fs.readFileSync(path.isAbsolute(input.planFilePath) ? input.planFilePath : path.join(run.cwd, input.planFilePath), 'utf8') }; } catch {}
      }
    }
    pendingPermissions.set(reqId, { run, resolve });
    run.push({ t: 'permission', reqId, tool: toolName, input, summary: summariseInput(input), canAlways: Array.isArray(suggestions) && suggestions.length > 0, suggestions });
    bus.emit('permission', { sessionId: run.sessionId, tool: toolName, summary: summariseInput(input) });
    signal?.addEventListener('abort', () => {
      if (pendingPermissions.delete(reqId)) resolve({ behavior: 'deny', message: 'Turn was stopped.' });
    }, { once: true });
  });

  // Streaming input: the first prompt, then whatever gets queued — handed over the
  // moment it is typed. Mid-turn, the CLI folds it in between tool rounds (the
  // model sees it right after the current tool finishes); between turns it starts
  // the next one. The bubble turns from dashed to solid when a turn takes it up.
  async function* inputStream() {
    // Under the page's own id, which the CLI keeps as the transcript line's uuid: a page that
    // later reads the line and also hears the prompt event knows the two for one message.
    if (hasFirst) yield { ...userMessage(prompt, images), uuid: firstId };
    while (true) {
      if (run.queue.length) {
        const item = run.queue.shift();
        run.sent.set(item.id, item);
        if (!run.inTurn) { run.inTurn = true; run.startTurn(); run.consume([item.id]); }
        yield { ...userMessage(item.text, item.images || []), uuid: item.id };
        continue;
      }
      if (run.closing) return;
      await new Promise((r) => { run.wake = r; });
      run.wake = null;
    }
  }
  // Frames that say which sends a turn has taken up so far.
  const consumed = (msg) => { const ids = msg.user_message_uuids || (msg.user_message_uuid ? [msg.user_message_uuid] : null); if (ids) run.consume(ids); };

  (async () => {
    try {
      const appServer = makeAppServer(run);
      const options = {
        cwd,
        // Behind a provider, the CLI's aliases still name Claude models - a subagent asked
        // for 'sonnet', the haiku it uses for titles - and the provider 404s on each. Point
        // any slot the provider was not given a model for at the one this turn runs.
        env: (() => {
          const e = authEnv(), m = run.controls.model; if (e.ANTHROPIC_BASE_URL && m && m !== 'default') for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) e[k] ||= m;
          // Since 2.1.285 Claude Code stops a background command at its `timeout` (30 minutes unless
          // Claude asks for more) in every session but Desktop's and VS Code's, which it knows by
          // name. A dev server for the Browser, a long render: this ceiling lets Claude ask for a
          // day when the work needs it. A ceiling set on this computer is left alone.
          e.BASH_MAX_TIMEOUT_MS ||= String(24 * 3600 * 1000);
          // A start that fails (a settings file it cannot read, a folder gone) says why in the result.
          e.CLAUDE_CODE_STARTUP_FAILURE_RESULTS ||= '1';
          return e;
        })(),
        abortController: run.abort,
        permissionMode: run.controls.permissionMode,
        ...(run.controls.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        // 'default' is the CLI's own row for "you choose"; passing no model is what it means.
        ...(run.controls.model && run.controls.model !== 'default' ? { model: run.controls.model } : {}),
        ...(run.controls.effort ? { effort: run.controls.effort } : {}),
        // Flags in force from the first request on: Ultracode, and Fast mode, which an SDK session
        // has to ask for this way ('sdk_opt_in_required' otherwise).
        ...(run.controls.ultracode || run.controls.fast ? { settings: { ...(run.controls.ultracode ? { ultracode: true } : {}), ...(run.controls.fast ? { fastMode: true } : {}) } } : {}),
        canUseTool,
        mcpServers: { 'claude-anywhere': appServer.server }, // a fresh instance: one transport per session
        allowedTools: appServer.allow,
        includePartialMessages: true,
        perTaskStopAffordance: true,   // Stop ends the turn only; each background task has its own Stop in the panel
        agentProgressSummaries: true,  // one-line summaries for subagent rows
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        stderr: (d) => { const s = String(d).trim(); if (s) run.push({ t: 'stderr', text: s.slice(0, 2000) }); },
        // Backs Query.rewindFiles() (lib/runs.mjs ensureLive, the rewind routes): on by default so
        // a session someone may later want to rewind always has checkpoints. Only turns run after
        // this shipped are covered - the CLI cannot back-fill checkpoints for older ones.
        enableFileCheckpointing: true,
        ...claudeCode.spawnOptions(),
      };
      if (sessionId) options.resume = sessionId;
      // A new session whose id was chosen first: a "No folder" chat lives in a folder named after it.
      else if (newId) options.sessionId = newId;

      run.cli = claudeCode.version();
      const q = query({ prompt: inputStream(), options });
      run.query = q;
      run.inTurn = hasFirst; // a run started with nothing to send (ensureLive) is resting, not working, from the first moment

      for await (const msg of q) {
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              if (!run.sessionId) { run.sessionId = msg.session_id; runs.set(msg.session_id, run); }
              // What this Claude Code can do, to use a newer behaviour only where it exists.
              run.caps = new Set(msg.capabilities || []);
              run.push({ t: 'init', sessionId: msg.session_id, model: msg.model, cwd: msg.cwd, permissionMode: msg.permissionMode, controls: run.controls, fast: fastOf(msg) });
              resolveInit(msg.session_id);
              refreshUsage(run);
              for (const name of disabledMcp) q.toggleMcpServer(name, false).catch(() => {}); // connectors switched off in the app
            } else if (msg.subtype === 'status') {
              consumed(msg); // 'requesting' after a fold lists the folded message among user_message_uuids
              run.push({ t: 'status', status: msg.status, permissionMode: msg.permissionMode });
            } else if (msg.subtype === 'compact_boundary') {
              // The marker the history draws where the context was compacted, not a note of its own.
              const cm = msg.compact_metadata || {};
              run.push({ t: 'row', m: { role: 'compact', trigger: cm.trigger || '', preTokens: cm.pre_tokens || 0, postTokens: cm.post_tokens || 0 } });
            } else if (msg.subtype === 'informational') {
              // The words are in `content` - reading `message` dropped every one, a hook's reason for
              // blocking a turn among them. 'info' is for a transcript view only, as in the CLI.
              const text = msg.content ?? msg.message;
              if (text && msg.level !== 'info') run.push({ t: 'note', text: String(text).slice(0, 500), level: msg.level });
            } else if (msg.subtype === 'session_writes_lost') {
              // Said once, as Claude Code exits: the disk was full and lines never reached the transcript,
              // which is what this app and `claude --resume` read the conversation back from.
              const what = (msg.lost || []).includes('transcript') ? 'part of this conversation' : 'its settings';
              run.push({ t: 'note', level: 'warning', text: `The disk is full (${msg.error_code}), so Claude Code could not save ${what}. Reopening the session may leave out what it could not write. Free some space before going on.` });
            } else if (msg.subtype === 'task_started') {
              const prev = run.tasks.get(msg.task_id) || {};
              run.tasks.set(msg.task_id, { ...prev, id: msg.task_id, type: msg.task_type || prev.type || 'task', description: msg.description || prev.description || '', subagentType: msg.subagent_type || prev.subagentType, workflow: msg.workflow_name, toolUseId: msg.tool_use_id || prev.toolUseId, backgrounded: !!msg.is_backgrounded, depth: msg.spawn_depth || 0, startedAt: prev.startedAt || Date.now(), status: 'running', usage: prev.usage || null, ambient: !!msg.ambient || !!msg.skip_transcript, prompt: msg.prompt ? String(msg.prompt).slice(0, 4000) : prev.prompt });
              run.pushTasks();
            } else if (msg.subtype === 'task_progress') {
              const t = run.tasks.get(msg.task_id) || { id: msg.task_id, type: 'task', startedAt: Date.now(), status: 'running', backgrounded: false, toolUseId: msg.tool_use_id };
              Object.assign(t, { description: msg.description || t.description, subagentType: msg.subagent_type || t.subagentType, usage: msg.usage || t.usage, lastTool: msg.last_tool_name || t.lastTool, summary: msg.summary || t.summary, progressAt: Date.now() });
              run.tasks.set(msg.task_id, t); run.pushTasks();
            } else if (msg.subtype === 'task_updated') {
              const t = run.tasks.get(msg.task_id); if (!t) break;
              const p = msg.patch || {};
              if (p.status) t.status = p.status === 'killed' ? 'stopped' : p.status === 'pending' || p.status === 'paused' ? 'running' : p.status;
              if (p.description) t.description = p.description;
              if (p.is_backgrounded !== undefined) t.backgrounded = !!p.is_backgrounded;
              if (p.error) t.error = String(p.error).slice(0, 500);
              if (p.end_time) t.endedAt = p.end_time;
              run.pushTasks(); run.maybeClose();
            } else if (msg.subtype === 'task_notification') {
              const t = run.tasks.get(msg.task_id) || { id: msg.task_id, type: 'task', startedAt: Date.now(), backgrounded: true, toolUseId: msg.tool_use_id, ambient: !!msg.ambient || !!msg.skip_transcript };
              Object.assign(t, { status: msg.status, summary: msg.summary || t.summary, outputFile: msg.output_file || t.outputFile, usage: msg.usage || t.usage, endedAt: Date.now(), reason: msg.reason });
              run.tasks.set(msg.task_id, t); run.pushTasks();
              // Drawn where Desktop draws it, and where the history will: among the turn's tool calls,
              // "Background command completed · <what it was>".
              if (t.backgrounded && !t.ambient) run.push({ t: 'row', m: { role: 'task', ...taskFrom(msg.status, msg.summary || (t.description ? `Background command "${t.description}" ${msg.status}` : ''), msg.tool_use_id || '') } });
              run.maybeClose();
            } else if (msg.subtype === 'background_tasks_changed') {
              const live = new Set();
              for (const b of msg.tasks || []) {
                live.add(b.task_id);
                const t = run.tasks.get(b.task_id);
                if (t) { t.backgrounded = true; t.ambient = !!b.ambient; if (t.status === 'running') t.description = t.description || b.description; }
                else run.tasks.set(b.task_id, { id: b.task_id, type: b.task_type || 'task', description: b.description || '', backgrounded: true, startedAt: Date.now(), status: 'running', usage: null, ambient: !!b.ambient });
              }
              for (const t of run.tasks.values()) if (t.backgrounded && t.status === 'running' && !live.has(t.id)) { t.status = 'completed'; t.endedAt = t.endedAt || Date.now(); }
              run.pushTasks(); run.maybeClose();
            } else if (msg.subtype === 'commands_changed') {
              // Fire-and-forget per its own doc comment: replace, not merge. lib/commands.mjs keeps
              // the per-folder cache a session opened here later would otherwise ask the CLI again for.
              commandsMod.update(run.cwd, msg.commands);
              run.push({ t: 'commands', commands: msg.commands });
            }
            break;
          // The account hit (or cleared) a plan rate limit, reported as it happens rather than
          // only in the slower post-turn usage call (refreshUsage) - fold it into the same
          // `lastLimits` the composer banner and lib/limit-queue.mjs's scheduler both read, keyed
          // by the window it names, so a held message is not left waiting on a stale answer.
          case 'rate_limit_event': {
            const info = msg.rate_limit_info || {};
            run.push({ t: 'rate_limit', status: info.status, resetsAt: info.resetsAt, rateLimitType: info.rateLimitType });
            const key = /^(five_hour|seven_day)$/.test(info.rateLimitType || '') ? info.rateLimitType : null;
            if (key && info.status === 'rejected' && info.resetsAt) lastLimits = { subscription_type: lastLimits?.subscription_type, at: Date.now(), rate_limits: { ...(lastLimits?.rate_limits || {}), [key]: { utilization: 100, resets_at: info.resetsAt } } };
            break;
          }
          // A message typed mid-turn is folded in at the next tool boundary, and a turn that began with
          // a message of yours stamps no reply frame for it after that - so its bubble stayed dashed
          // until the whole turn ended. Claude Code says when it takes each one up: state 'started'.
          case 'command_lifecycle':
            if (msg.state === 'started' && msg.command_uuid) run.consume([msg.command_uuid]);
            break;
          case 'conversation_reset': {
            // /clear (or leaving plan mode with a clean context): Claude Code goes on in a new
            // session, written to a transcript of its own. The run follows it, and so do the pages.
            const next = msg.new_conversation_id;
            if (!next || next === run.sessionId) break;
            if (runs.get(run.sessionId) === run) runs.delete(run.sessionId);
            const from = run.sessionId; run.sessionId = next; runs.set(next, run);
            run.push({ t: 'reset', from, sessionId: next, trigger: msg.trigger || '', at: Date.parse(msg.timestamp || '') || Date.now() });
            break;
          }
          case 'stream_event': {
            consumed(msg);
            const e = msg.event;
            if (e.type === 'message_start') { run.streamed = 0; run.push({ t: 'msg_start', inputTokens: e.message?.usage?.input_tokens }); }
            // `at` on both ends: a page that catches up later still says how long Claude thought.
            else if (e.type === 'content_block_start') run.push({ t: 'block_start', index: e.index, block: { type: e.content_block.type, name: e.content_block.name, id: e.content_block.id }, at: Date.now() });
            else if (e.type === 'content_block_delta') {
              const d = e.delta;
              const text = d.text ?? d.thinking ?? d.partial_json ?? '';
              // Thinking is not drawn - narration arrives whole, with its block - so its words stay
              // off the network: on a phone they were most of what a long think sent. What the
              // answer has cost so far still reaches the status line, roughly, a few times a second.
              run.streamed = (run.streamed || 0) + text.length;
              if (text && d.type !== 'thinking_delta') run.push({ t: 'delta', index: e.index, kind: d.type, text });
              if (Date.now() - (run.countedAt || 0) > 400) { run.countedAt = Date.now(); run.push({ t: 'usage', outputTokens: Math.round(run.streamed / 4) }); }
            } else if (e.type === 'content_block_stop') run.push({ t: 'block_stop', index: e.index, at: Date.now() });
            else if (e.type === 'message_delta' && e.usage) run.push({ t: 'usage', outputTokens: e.usage.output_tokens });
            break;
          }
          case 'assistant':
            consumed(msg);
            if (!msg.parent_tool_use_id) run.push({ t: 'assistant', uuid: msg.uuid, content: msg.message.content });
            break;
          case 'user':
            if (!msg.parent_tool_use_id && Array.isArray(msg.message?.content)) {
              const results = msg.message.content.filter((b) => b.type === 'tool_result');
              if (results.length) run.push({ t: 'tool_results', uuid: msg.uuid, content: results });
            }
            break;
          case 'tool_progress':
            if (!msg.parent_tool_use_id) run.push({ t: 'tool_progress', toolUseId: msg.tool_use_id, tool: msg.tool_name, elapsed: msg.elapsed_time_seconds, heartbeat: !!msg.heartbeat });
            break;
          case 'tool_use_summary':
            run.push({ t: 'tool_summary', summary: msg.summary, toolUseIds: msg.preceding_tool_use_ids });
            break;
          case 'result':
            consumed(msg);
            // An older CLI does not echo uuids: with nothing left queued, whatever was handed over ran in this turn.
            if (!msg.user_message_uuids && !msg.queued_turn_count) run.consume([...run.sent.keys()]);
            run.inTurn = msg.queued_turn_count > 0 || run.sent.size > 0;
            // `more`: another turn is queued behind this one. When it is false the answer is
            // finished even if a backgrounded task keeps the process alive - the composer goes
            // idle then, instead of holding at "Working" and queueing the next message behind
            // work that is not the answer.
            // An error result has no `result`: what went wrong is in `errors`, and a start that failed
            // says why in `startup_failure_reason`. Every failed turn used to read "Something went wrong."
            // `[ede_diagnostic] …` lines are Claude Code's notes to itself, not words for a person; a
            // turn the person stopped is an error result too, and `stopped` says not to show it as one.
            const said = msg.result ?? (Array.isArray(msg.errors) ? msg.errors.filter((e) => e && !/^\[ede_diagnostic\]/.test(e)).join('\n') : '');
            if (msg.credential_expires_at) credentialExpiresAt = msg.credential_expires_at;
            run.push({ t: 'result', subtype: msg.subtype, isError: !!msg.is_error, stopped: !!run.stopped, more: run.inTurn, text: said, startupFailure: msg.startup_failure_reason, fast: fastOf(msg), costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, numTurns: msg.num_turns, usage: msg.usage ? { input: msg.usage.input_tokens, output: msg.usage.output_tokens } : undefined });
            bus.emit('turn_done', { sessionId: run.sessionId, text: String(said || '').slice(0, 200), isError: !!msg.is_error && !run.stopped });
            run.stopped = false;
            // The process rests now, ready for the next message (or stays at work for a background
            // command). Context and limits are read a moment later, not at once: those requests
            // queue in front of a message sent straight after the answer, which waited a second
            // behind them. A turn that has begun meanwhile reads them at its own end.
            run.maybeClose(); run.wake?.();
            clearTimeout(run.usageTimer);
            run.usageTimer = setTimeout(() => { if (!run.inTurn && !run.done && !run.closing) refreshUsage(run); }, 1500);
            break;
          default:
            break;
        }
      }
    } catch (err) {
      const text = err?.name === 'AbortError' ? 'Stopped.' : String(err?.message || err);
      run.push({ t: 'error', text });
      if (err?.name !== 'AbortError') bus.emit('turn_done', { sessionId: run.sessionId, text: text.slice(0, 200), isError: true });
      rejectInit(err);
    } finally {
      run.push({ t: 'done', why: run.closeWhy });
      run.finish();
    }
  })();

  return { run, ready };
}

// A live Query to run control requests on (rewind needs one: Query.rewindFiles only works
// against the session it belongs to). Reuses whatever is already running or resting; otherwise
// starts one with nothing to send - see `hasFirst` above - and waits for its `init`. The caller
// should let it go back to resting once done (run.maybeClose()): this exists to make one control
// request, not to keep a process the person never asked for alive.
export async function ensureLive(sessionId, cwd) {
  let run = runs.get(sessionId);
  if (run && !run.done) {
    for (let i = 0; i < 100 && !run.query; i++) await new Promise((r) => setTimeout(r, 50));
    if (run.query) return { run, created: false };
  }
  const started = startRun({ sessionId, cwd, prompt: '' });
  await started.ready;
  return { run: started.run, created: true };
}

// `updatedPermissions` lets a caller set the session's mode in the same resolution as the
// approval - what the plan approval card does ("Yes, and auto-accept edits" is one round
// trip, not an approval plus a separate controls call); `message` is the deny reason shown
// to Claude, for "No, keep planning" to carry the person's feedback instead of a stock line.
export function answerPermission(reqId, behavior, always, updatedInput, how, updatedPermissions, message) {
  const p = pendingPermissions.get(reqId);
  if (!p) return false;
  pendingPermissions.delete(reqId);
  const ev = p.run.events.find((e) => e.t === 'permission' && e.reqId === reqId);
  // A question left unanswered - skipped, or replied to in the chat instead - is not a refusal:
  // Claude hears which it was and goes on, rather than being told the person said no.
  if (isAsk(ev?.tool) && (behavior !== 'allow' || how) && p.run.caps?.has('ask_user_question_unanswered_v1')) {
    how = how === 'replied_in_chat' ? how : 'skipped';
    p.resolve({ behavior: 'allow', updatedInput: { ...(ev.input || {}), ...unanswered(ev.input, how) } });
    p.run.push({ t: 'permission_resolved', reqId, behavior: 'deny', how });
    if (![...pendingPermissions.values()].some((x) => x.run === p.run)) bus.emit('permission_resolved', { sessionId: p.run.sessionId });
    return true;
  }
  if (behavior === 'allow') {
    const r = { behavior: 'allow' };
    if (updatedPermissions && updatedPermissions.length) r.updatedPermissions = updatedPermissions;
    else if (always && ev?.suggestions?.length) r.updatedPermissions = ev.suggestions;
    // AskUserQuestion is not really a permission: the tool asks, and the answer rides
    // back on the input it is allowed to run with. Anything else ignores this.
    if (updatedInput && typeof updatedInput === 'object') r.updatedInput = { ...(ev?.input || {}), ...updatedInput };
    p.resolve(r);
  } else {
    p.resolve({ behavior: 'deny', message: message || 'The user declined this from their phone.' });
  }
  p.run.push({ t: 'permission_resolved', reqId, behavior: behavior === 'allow' ? 'allow' : 'deny' });
  if (![...pendingPermissions.values()].some((x) => x.run === p.run)) bus.emit('permission_resolved', { sessionId: p.run.sessionId });
  return true;
}
