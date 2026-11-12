// Claude's tools for managing sessions from inside a chat: starting a nested session in the same
// folder (Desktop's ccd_session), and the main-chat subset of ccd_session_mgmt for listing,
// inspecting and acting on other sessions. One pack, per TOOL_PACKS in lib/runs.mjs.
//
// Reading tools (list/get/search/read) run without asking - they only look. Acting tools
// (send/stop/retitle/archive) ask through the normal permission prompt: the SDK's `allow` list is
// per tool name, not per argument, so there is no way to let "act on a child I started" through
// without also asking for the rest - the argument-aware half of Desktop's rule is left to the
// permission dialog's own text, which names the target session.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { startRun } from './runs.mjs';
import { searchSession } from './history.mjs';
import * as worktrees from './worktrees.mjs';
import * as net from './sessions-net.mjs';
import * as pr from './pr.mjs';
import * as autofix from './autofix.mjs';

const execFileP = promisify(execFile);

// present_options / request_secret: Desktop's elicit - the tool call itself waits on a person's
// click or typing, the way AskUserQuestion does, but these are this app's own tools rather than
// a built-in the SDK's permission plumbing already knows, so they get a small waiting-room of
// their own instead of going through canUseTool. One Map for the process, not per run, because
// the answer comes back over a plain HTTP POST (server.mjs) that only has the request id.
const pendingElicits = new Map(); // reqId -> resolve
export function answerElicit(reqId, value) {
  const p = pendingElicits.get(reqId);
  if (!p) return false;
  pendingElicits.delete(reqId);
  p(value);
  return true;
}

export default function sessionTools(run) {
  const tools = [
    // ---------- nested sessions (ccd_session) ----------
    tool(
      'start_session',
      'Start a new Claude Code session on a separate task, in this same folder (or a new git worktree of it). Use it for work that is its own thread - the kind the person would rather watch as its own session - not for a quick sub-step of what you are already doing. The new session appears nested under this one in the sidebar, and its final answer each turn is delivered back here.',
      {
        title: z.string().min(1).max(120).describe('Short session title, shown in the sidebar and as the task card here'),
        prompt: z.string().min(1).describe('The task, written as you would say it to a fresh session that has none of this chat\'s context'),
        worktree: z.boolean().optional().describe('Give the new session its own git worktree (a branch of its own) instead of sharing this folder'),
      },
      async ({ title, prompt, worktree }) => {
        let cwd = run.cwd;
        let worktreeInfo = null;
        if (worktree) {
          try { worktreeInfo = await worktrees.addForSession(run.cwd, title); cwd = worktreeInfo.path; }
          catch (e) { return { content: [{ type: 'text', text: `Could not create a worktree: ${worktrees.cliError ? worktrees.cliError(e) : String(e.message || e)}` }], isError: true }; }
        }
        const newId = randomUUID();
        const parentInfo = await getSessionInfo(run.sessionId).catch(() => null);
        const parentTitle = parentInfo?.customTitle || parentInfo?.summary || 'this session';
        // The plain task prompt, nothing prepended: the "Started by Claude from …" line and the
        // Task card are drawn by the client from net.linkChild's record (public/app.js's
        // paintParentHeader), not from the transcript - so the child's first turn is Claude's
        // actual answer, exactly as Desktop's own child session opens (cd-shots/web/eat-17b).
        const { ready } = startRun({ newId, cwd, prompt, promptId: randomUUID() });
        let childId = newId;
        try { childId = await ready; } catch {} // falls back to newId - the CLI reports the same id it was given on failure to start differently
        net.linkChild(childId, { parentId: run.sessionId, parentTitle, prompt, title, worktree: worktreeInfo ? { path: worktreeInfo.path, branch: worktreeInfo.branch } : null });
        run.push({ t: 'session_started', childId, title, status: 'running' }); // renders as the "List 5 coast towns ›" card
        return { content: [{ type: 'text', text: `Started session "${title}" (${childId}).` }] };
      },
    ),
    tool(
      'hand_off_to_session',
      'Send a message into another session - typically a child this session started - instead of answering it here. Use it to route follow-up work to the session already doing it, or to pass something along per the "unrelated task" setting.',
      { sessionId: z.string().min(1), text: z.string().min(1) },
      async ({ sessionId, text }) => {
        try { const r = await net.sendMessage(sessionId, text); return { content: [{ type: 'text', text: r.queued ? 'Handed off; the session will take it up next.' : 'Handed off; a new turn started.' }] }; }
        catch (e) { return { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
      },
    ),
    tool(
      'dismiss_task',
      'Dismiss a nested session\'s task card: it stops showing as a child of this session in the sidebar. The session itself is untouched.',
      { sessionId: z.string().min(1) },
      async ({ sessionId }) => ({ content: [{ type: 'text', text: net.dismiss(sessionId) ? 'Dismissed.' : 'No such nested session.' }] }),
    ),
    tool(
      'list_start_targets',
      'List the sessions that hand_off_to_session can address right now: this session\'s own nested children, plus whether this session itself has a parent.',
      {},
      async () => {
        const children = net.childrenOf(run.sessionId).filter((c) => !c.dismissed);
        const parent = net.linkFor(run.sessionId);
        return { content: [{ type: 'text', text: JSON.stringify({ children: children.map((c) => ({ id: c.id, title: c.title })), parent: parent ? { id: parent.parentId, title: parent.parentTitle } : null }) }] };
      },
    ),

    // ---------- main-chat session management (ccd_session_mgmt subset) ----------
    tool(
      'list_sessions',
      'List other Claude Code sessions: title, status (busy/idle/needs-you), folder and when each last changed.',
      { folder: z.string().optional().describe('Limit to sessions in this folder') },
      async ({ folder }) => ({ content: [{ type: 'text', text: JSON.stringify(await net.listForClaude({ folder })) }] }),
    ),
    tool(
      'get_session',
      'Get one session\'s title, status, folder and nested children.',
      { sessionId: z.string().min(1) },
      async ({ sessionId }) => {
        const s = await net.getForClaude(sessionId);
        return s ? { content: [{ type: 'text', text: JSON.stringify(s) }] } : { content: [{ type: 'text', text: 'No such session.' }], isError: true };
      },
    ),
    tool(
      'search_session_transcripts',
      'Search a session\'s transcript for a word or phrase and get back matching lines.',
      { sessionId: z.string().min(1), query: z.string().min(1) },
      async ({ sessionId, query }) => {
        try { const r = await searchSession(sessionId, query); return { content: [{ type: 'text', text: JSON.stringify(r.hits.slice(0, 20)) }] }; }
        catch (e) { return { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
      },
    ),
    tool(
      'send_message',
      'Send a message into another session, as if typed there.',
      { sessionId: z.string().min(1), text: z.string().min(1) },
      async ({ sessionId, text }) => {
        try { const r = await net.sendMessage(sessionId, text); return { content: [{ type: 'text', text: r.queued ? 'Sent; queued for the session\'s next turn.' : 'Sent; a new turn started.' }] }; }
        catch (e) { return { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
      },
    ),
    tool(
      'stop_session',
      'Stop whatever another session is doing right now.',
      { sessionId: z.string().min(1) },
      async ({ sessionId }) => ({ content: [{ type: 'text', text: net.stopSession(sessionId) ? 'Stopped.' : 'That session was not running.' }] }),
    ),
    tool(
      'set_session_title',
      'Rename another session.',
      { sessionId: z.string().min(1), title: z.string().min(1).max(160) },
      async ({ sessionId, title }) => { await net.setTitle(sessionId, title); return { content: [{ type: 'text', text: `Renamed to "${title}".` }] }; },
    ),
    tool(
      'archive_session',
      'Archive another session, moving it out of the main sidebar list.',
      { sessionId: z.string().min(1) },
      async ({ sessionId }) => { await net.setArchived(sessionId, true); return { content: [{ type: 'text', text: 'Archived.' }] }; },
    ),
    tool(
      'unarchive_session',
      'Bring an archived session back into the main sidebar list.',
      { sessionId: z.string().min(1) },
      async ({ sessionId }) => { await net.setArchived(sessionId, false); return { content: [{ type: 'text', text: 'Unarchived.' }] }; },
    ),
    tool(
      'set_session_model',
      'Change which model another session uses, from its next turn on.',
      { sessionId: z.string().min(1), model: z.string().min(1) },
      async ({ sessionId, model }) => { await net.setControls(sessionId, { model }); return { content: [{ type: 'text', text: `Model set to ${model}.` }] }; },
    ),
    tool(
      'set_session_effort',
      'Change another session\'s effort level, from its next turn on.',
      { sessionId: z.string().min(1), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']) },
      async ({ sessionId, effort }) => { await net.setControls(sessionId, { effort }); return { content: [{ type: 'text', text: `Effort set to ${effort}.` }] }; },
    ),
    tool(
      'set_session_permission_mode',
      'Change another session\'s permission mode (default / acceptEdits / plan / bypassPermissions), from its next tool call on.',
      { sessionId: z.string().min(1), permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']) },
      async ({ sessionId, permissionMode }) => { await net.setControls(sessionId, { permissionMode }); return { content: [{ type: 'text', text: `Permission mode set to ${permissionMode}.` }] }; },
    ),

    // ---------- panes (ccd_view / ccd_window): the person's own side panels ----------
    tool(
      'show_pane',
      'Open one of the person\'s side panels: terminal, changes, browser, files, or tasks. Use it to bring something you are about to talk about onto their screen.',
      { pane: z.enum(['terminal', 'changes', 'browser', 'files', 'tasks']) },
      async ({ pane }) => { run.push({ t: 'show_pane', pane }); return { content: [{ type: 'text', text: `Opened the ${pane} panel.` }] }; },
    ),
    tool(
      'close_pane',
      'Close one of the person\'s side panels.',
      { pane: z.enum(['terminal', 'changes', 'browser', 'files', 'tasks']) },
      async ({ pane }) => { run.push({ t: 'close_pane', pane }); return { content: [{ type: 'text', text: `Closed the ${pane} panel.` }] }; },
    ),
    tool(
      'open_in_editor',
      'Open a file in the person\'s own editor (VS Code if it is on this computer\'s PATH). Use it instead of just naming a path when they will likely want to look at or edit it next.',
      { path: z.string().min(1), line: z.number().optional() },
      async ({ path: p, line }) => {
        const target = line ? `${p}:${line}` : p;
        try {
          await execFileP(process.platform === 'win32' ? 'code.cmd' : 'code', ['-g', target], { timeout: 4000, windowsHide: true });
          return { content: [{ type: 'text', text: `Opened ${p} in the editor.` }] };
        } catch {
          // No VS Code on this machine's PATH - this computer runs the session but may not be
          // the one the person is looking from (a phone, another desk), so the shell that can
          // still do something with a vscode:// link is theirs: hand it to the page to open.
          const url = 'vscode://file/' + p.replace(/\\/g, '/') + (line ? ':' + line : '');
          run.push({ t: 'open_external', url });
          return { content: [{ type: 'text', text: `VS Code isn't on this computer's PATH; sent ${url} to the person's own device to open.` }] };
        }
      },
    ),
    tool(
      'reveal_path',
      'Select a file or folder in the system file manager (Explorer on Windows, Finder on macOS) on the computer running this session.',
      { path: z.string().min(1) },
      async ({ path: p }) => {
        try {
          if (process.platform === 'win32') await execFileP('explorer', ['/select,' + p], { timeout: 4000, windowsHide: true });
          else if (process.platform === 'darwin') await execFileP('open', ['-R', p], { timeout: 4000 });
          else await execFileP('xdg-open', [p.replace(/[/\\][^/\\]*$/, '') || p], { timeout: 4000 }); // no Linux file manager "select", so the containing folder opens
          return { content: [{ type: 'text', text: `Revealed ${p}.` }] };
        } catch (e) { return { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
      },
    ),

    // ---------- elicit (Desktop's own): a click or a typed value becomes the tool's answer ----------
    tool(
      'present_options',
      'Ask the person to pick one of a short list of options, shown as buttons in the chat. Use it for a quick choice that does not need a full question-and-answer back-and-forth.',
      {
        question: z.string().min(1),
        options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).min(1).max(6),
      },
      async ({ question, options }) => {
        const reqId = randomUUID();
        run.push({ t: 'options_request', reqId, question, options });
        const picked = await new Promise((resolve) => pendingElicits.set(reqId, resolve));
        return { content: [{ type: 'text', text: picked == null ? 'No option was picked.' : `Picked: ${options[picked]?.label ?? picked}` }] };
      },
    ),
    tool(
      'request_secret',
      'Ask the person to type a secret (an API key, a password) into a masked input card, rather than in the chat itself where it would sit in plain text. Use it whenever you need a credential you do not already have.',
      { prompt: z.string().min(1).describe('What the secret is for, e.g. "Stripe secret key"') },
      async ({ prompt }) => {
        const reqId = randomUUID();
        run.push({ t: 'secret_request', reqId, prompt });
        const value = await new Promise((resolve) => pendingElicits.set(reqId, resolve));
        // The value has to be in the tool result - that is the only way it reaches you - so it
        // is in this session's own transcript file on disk like any other tool result (the CLI's
        // own storage, not this app's). What this app controls is its own layer on top: the card
        // above has no .step-body, so the chat's generic "show the tool result" renderer
        // (public/app.js's attachResult) never paints it, and nothing here writes it to a log.
        return { content: [{ type: 'text', text: value == null ? 'No value was entered.' : value }] };
      },
    ),

    // ---------- pull request (ccd_pr), via the gh CLI already behind lib/pr.mjs ----------
    tool(
      'get_status',
      'Get the pull request for this session\'s branch: checks, review status, mergeability, and recent comments.',
      {},
      async () => {
        const s = await pr.read(run.cwd).catch((e) => ({ has: false, error: String(e.message || e) }));
        return { content: [{ type: 'text', text: JSON.stringify(s) }] };
      },
    ),
    tool(
      'set_auto_merge',
      'Turn auto-merge on or off for this session\'s pull request: once on, GitHub merges it itself as soon as checks pass and reviews are in.',
      { on: z.boolean(), method: z.enum(['squash', 'merge', 'rebase']).optional() },
      async ({ on, method }) => {
        try { await pr.setAutoMerge(run.cwd, on, method || 'squash'); return { content: [{ type: 'text', text: `Auto-merge turned ${on ? 'on' : 'off'}.` }] }; }
        catch (e) { return { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
      },
    ),
    tool(
      'set_monitor',
      'Turn on or off watching this session\'s pull request for trouble (failing checks, a merge conflict, a new review comment) - when on, this session is woken to look at it as soon as it is free.',
      { on: z.boolean() },
      async ({ on }) => { if (run.sessionId) autofix.setAutoFix(run.sessionId, on); return { content: [{ type: 'text', text: `Monitoring turned ${on ? 'on' : 'off'}.` }] }; },
    ),
  ];
  // "Reading tools run without asking; acting tools ask ... unless the target is a child this
  // session started" - the SDK decides per tool name only, so the argument-aware half (whose
  // child is it) is decided here, once per call, the way lib/tools-browser.mjs's autoAllow does
  // (same hook in lib/runs.mjs - added for both packages so the two merge without touching it twice).
  const READS = new Set([
    'start_session', 'list_start_targets', 'list_sessions', 'get_session', 'search_session_transcripts',
    // Panes only change what the person is looking at; editor/reveal only open things on their
    // own computer, same as a click; present_options and request_secret already gate themselves
    // on a person answering, so a second Allow/Deny on top would just be asking twice.
    'show_pane', 'close_pane', 'open_in_editor', 'reveal_path', 'present_options', 'request_secret',
    'get_status',
  ]);
  const ownChild = (sessionId) => net.linkFor(sessionId)?.parentId === run.sessionId;
  return {
    tools,
    allow: [...READS],
    autoAllow: (name, input) => READS.has(name) || (!!input?.sessionId && ownChild(input.sessionId)),
  };
}
