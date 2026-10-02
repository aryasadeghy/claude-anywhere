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
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { authEnv } from './auth.mjs';
import * as models from './models.mjs';
import { taskFrom } from './history.mjs';
import { sessionFile } from './tail.mjs';
import * as claudeCode from './claude-code.mjs';

// Desktop gives Claude a SendUserFile tool so it can hand finished files (a video, a
// cover image, a PDF) to the person in the chat. The SDK's Claude Code does not have
// it, so this in-process tool fills the gap; the client renders it like Desktop does.
const makeSendUserFileServer = () => createSdkMcpServer({
  name: 'claude-anywhere',
  version: '1.0.0',
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
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    lastLimits = { subscription_type: u.subscription_type, rate_limits: u.rate_limits_available ? u.rate_limits : null, at: Date.now() };
    run.push({ t: 'limits', ...lastLimits });
    try { fs.mkdirSync(LIMITS_FILE.replace(/[\\/][^\\/]+$/, ''), { recursive: true }); fs.writeFileSync(LIMITS_FILE, JSON.stringify(lastLimits)); } catch {}
  } catch {}
}

// Events a client only ever needs the newest of: each one replaces what the last one said.
const REPLACED = new Set(['tasks', 'usage', 'tool_progress', 'context', 'limits']);

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
    return item.id;
  }
  // Stop the current turn (like Esc / the stop button). Queued messages are dropped.
  async stop() {
    this.wakeUp();
    this.queue = []; this.stopped = true;
    if (this.query && this.inTurn) { try { await this.query.interrupt(); return; } catch {} }
    this.closing = true; this.wake?.();
    this.abort.abort();
  }
  async setControls({ permissionMode, model, effort, ultracode }) {
    const applied = {};
    if (!this.query) return applied;
    if (permissionMode && PERMISSION_MODES.includes(permissionMode) && permissionMode !== 'bypassPermissions') { await this.query.setPermissionMode(permissionMode); applied.permissionMode = permissionMode; }
    else if (permissionMode === 'bypassPermissions') { try { await this.query.setPermissionMode('bypassPermissions'); applied.permissionMode = permissionMode; } catch { applied.note = 'Bypass takes effect on the next turn.'; } }
    const want = models.acceptable(model);
    if (want) { await this.query.setModel(want === 'default' ? undefined : want); applied.model = want; }
    // Ultracode is its own flag, not an effort level: xhigh plus standing workflow
    // orchestration. It travels with effort because that is one control to a person.
    if (effort !== undefined || ultracode !== undefined) {
      const settings = {};
      if (effort !== undefined) settings.effortLevel = EFFORTS.includes(effort) ? effort : null;
      if (ultracode !== undefined) settings.ultracode = !!ultracode;
      await this.query.applyFlagSettings(settings);
      if (effort !== undefined) applied.effort = settings.effortLevel || '';
      if (ultracode !== undefined) applied.ultracode = !!ultracode;
    }
    Object.assign(this.controls, applied);
    this.push({ t: 'controls', ...applied });
    return applied;
  }
}

export const isLive = (id) => { const r = runs.get(id); return !!r && !r.done; };
// Live and working at something - not a process resting between turns.
export const isBusy = (id) => { const r = runs.get(id); return !!r && r.busy(); };

function summariseInput(input) {
  if (!input || typeof input !== 'object') return '';
  // A question tool carries its question in a list, and that is the whole point of it.
  const asked = Array.isArray(input.questions) ? input.questions.map((q) => q && q.question).filter(Boolean).join(' · ') : '';
  const s = asked || input.command || input.file_path || input.pattern || input.path || input.description || input.url || input.query || input.prompt || '';
  return String(s).slice(0, 400);
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
// session. `ready` resolves with the session id as soon as the CLI reports it.
export function startRun({ sessionId, cwd, prompt, images = [], model, permissionMode, effort, ultracode, disabledMcp = [], promptId }) {
  const run = new Run(sessionId);
  run.cwd = cwd; // the folder it works in: removing a worktree asks whether Claude is at work there
  if (sessionId) runs.set(sessionId, run);
  const firstId = promptId || randomUUID(); // the page's own id for its bubble, when it sent one
  run.push({ t: 'prompt', id: firstId, text: prompt, images: images.map(imageBlock), at: run.startedAt }); // so a client that reloads mid-turn sees the question too
  run.controls = { permissionMode: PERMISSION_MODES.includes(permissionMode) ? permissionMode : 'default', model: models.acceptable(model) || models.providerDefault(), effort: EFFORTS.includes(effort) ? effort : '', ultracode: !!ultracode };

  let resolveInit, rejectInit;
  const ready = new Promise((res, rej) => { resolveInit = res; rejectInit = rej; });

  // Tool prompts are answered by the user in the web client; the turn waits.
  const canUseTool = (toolName, input, { signal, suggestions }) => new Promise((resolve) => {
    const reqId = randomUUID();
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
    yield { ...userMessage(prompt, images), uuid: firstId };
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
      const options = {
        cwd,
        // Behind a provider, the CLI's aliases still name Claude models - a subagent asked
        // for 'sonnet', the haiku it uses for titles - and the provider 404s on each. Point
        // any slot the provider was not given a model for at the one this turn runs.
        env: (() => { const e = authEnv(), m = run.controls.model; if (e.ANTHROPIC_BASE_URL && m && m !== 'default') for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) e[k] ||= m; return e; })(),
        abortController: run.abort,
        permissionMode: run.controls.permissionMode,
        ...(run.controls.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        // 'default' is the CLI's own row for "you choose"; passing no model is what it means.
        ...(run.controls.model && run.controls.model !== 'default' ? { model: run.controls.model } : {}),
        ...(run.controls.effort ? { effort: run.controls.effort } : {}),
        canUseTool,
        mcpServers: { 'claude-anywhere': makeSendUserFileServer() }, // a fresh instance: one transport per session
        allowedTools: ['mcp__claude-anywhere__SendUserFile'],
        includePartialMessages: true,
        perTaskStopAffordance: true,   // Stop ends the turn only; each background task has its own Stop in the panel
        agentProgressSummaries: true,  // one-line summaries for subagent rows
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        stderr: (d) => { const s = String(d).trim(); if (s) run.push({ t: 'stderr', text: s.slice(0, 2000) }); },
        ...claudeCode.spawnOptions(),
      };
      if (sessionId) options.resume = sessionId;

      run.cli = claudeCode.version();
      const q = query({ prompt: inputStream(), options });
      run.query = q;
      run.inTurn = true;

      for await (const msg of q) {
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              if (!run.sessionId) { run.sessionId = msg.session_id; runs.set(msg.session_id, run); }
              run.push({ t: 'init', sessionId: msg.session_id, model: msg.model, cwd: msg.cwd, permissionMode: msg.permissionMode, controls: run.controls });
              resolveInit(msg.session_id);
              if (run.controls.ultracode) q.applyFlagSettings({ ultracode: true }).catch(() => {});
              refreshUsage(run);
              for (const name of disabledMcp) q.toggleMcpServer(name, false).catch(() => {}); // connectors switched off in the app
            } else if (msg.subtype === 'status') {
              run.push({ t: 'status', status: msg.status, permissionMode: msg.permissionMode });
            } else if (msg.subtype === 'compact_boundary') {
              // The marker the history draws where the context was compacted, not a note of its own.
              const cm = msg.compact_metadata || {};
              run.push({ t: 'row', m: { role: 'compact', trigger: cm.trigger || '', preTokens: cm.pre_tokens || 0, postTokens: cm.post_tokens || 0 } });
            } else if (msg.subtype === 'informational' && msg.message) {
              run.push({ t: 'note', text: String(msg.message).slice(0, 500) });
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
            }
            break;
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
            run.push({ t: 'result', subtype: msg.subtype, isError: !!msg.is_error, more: run.inTurn, text: msg.result ?? '', costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, numTurns: msg.num_turns, usage: msg.usage ? { input: msg.usage.input_tokens, output: msg.usage.output_tokens } : undefined });
            bus.emit('turn_done', { sessionId: run.sessionId, text: String(msg.result || '').slice(0, 200), isError: !!msg.is_error && !run.stopped });
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

export function answerPermission(reqId, behavior, always, updatedInput) {
  const p = pendingPermissions.get(reqId);
  if (!p) return false;
  pendingPermissions.delete(reqId);
  const ev = p.run.events.find((e) => e.t === 'permission' && e.reqId === reqId);
  if (behavior === 'allow') {
    const r = { behavior: 'allow' };
    if (always && ev?.suggestions?.length) r.updatedPermissions = ev.suggestions;
    // AskUserQuestion is not really a permission: the tool asks, and the answer rides
    // back on the input it is allowed to run with. Anything else ignores this.
    if (updatedInput && typeof updatedInput === 'object') r.updatedInput = { ...(ev?.input || {}), ...updatedInput };
    p.resolve(r);
  } else {
    p.resolve({ behavior: 'deny', message: 'The user declined this from their phone.' });
  }
  p.run.push({ t: 'permission_resolved', reqId, behavior: behavior === 'allow' ? 'allow' : 'deny' });
  if (![...pendingPermissions.values()].some((x) => x.run === p.run)) bus.emit('permission_resolved', { sessionId: p.run.sessionId });
  return true;
}
