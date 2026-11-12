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
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { startRun } from './runs.mjs';
import { searchSession } from './history.mjs';
import * as worktrees from './worktrees.mjs';
import * as net from './sessions-net.mjs';

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
  ];
  return {
    tools,
    allow: ['start_session', 'list_start_targets', 'list_sessions', 'get_session', 'search_session_transcripts'],
  };
}
