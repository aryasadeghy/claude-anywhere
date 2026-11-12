// The session-management half of this package: the parent/child tree that nested sessions form
// (lib/tools-sessions.mjs's start_session / hand_off_to_session / dismiss_task), the sidebar's
// user-made sections, and the plumbing the main-chat tools (list_sessions, send_message, ...) and
// the client's sidebar both read. Kept in its own file, not conv-settings.mjs, so this package's
// writes never race another package's writes to the same JSON.
import fs from 'node:fs';
import path from 'node:path';
import { listSessions, getSessionInfo, renameSession, tagSession } from '@anthropic-ai/claude-agent-sdk';
import { runs, pendingPermissions, isLive, isBusy, startRun } from './runs.mjs';

const FILE = () => path.join(process.env.CLAUDE_ANYWHERE_DATA_DIR || process.env.CLAUDE_REMOTE_DATA_DIR || new URL('../data', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'sessions-net.json');
const defaults = () => ({
  links: {},     // childId -> { parentId, parentTitle, startedAt, prompt, dismissed }
  received: {},  // parentId -> count of child messages not yet seen (the "Received N messages" fold)
  sections: {},  // sectionId -> { id, name, order, sessionIds: [] }
  sidebar: { groupBy: 'none', sortBy: 'recent', showEmptyGroups: false }, // "Group and sort" menu state
});

export function read() {
  try { return { ...defaults(), ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) }; } catch { return defaults(); }
}
export function write(s) {
  try { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(s)); } catch {}
}

/** Record that `childId` is a nested session Claude started from `parentRun`. */
export function linkChild(childId, { parentId, parentTitle, prompt, title, worktree }) {
  const s = read();
  s.links[childId] = { parentId, parentTitle: parentTitle || '', prompt: prompt || '', title: title || '', worktree: worktree || null, startedAt: Date.now(), dismissed: false };
  write(s);
}

export function childrenOf(parentId) {
  const s = read();
  return Object.entries(s.links).filter(([, v]) => v.parentId === parentId).map(([id, v]) => ({ id, ...v }));
}

export function linkFor(childId) {
  return read().links[childId] || null;
}

export function dismiss(childId) {
  const s = read();
  if (s.links[childId]) { s.links[childId].dismissed = true; write(s); return true; }
  return false;
}

/** Bump (or read) the "Received N messages" counter the parent's sidebar/header shows. */
export function noteReceived(parentId, delta) {
  const s = read();
  s.received[parentId] = Math.max(0, (s.received[parentId] || 0) + delta);
  write(s);
  return s.received[parentId];
}
export function clearReceived(parentId) {
  const s = read();
  if (s.received[parentId]) { delete s.received[parentId]; write(s); }
}

// ---------- sidebar sections (user-made groups, plus the Group-and-sort menu's own settings) ----------
export function listSections() { return Object.values(read().sections).sort((a, b) => a.order - b.order); }
export function createSection(name) {
  const s = read();
  const id = 'sec_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const order = Object.keys(s.sections).length;
  s.sections[id] = { id, name: name || 'New section', order, sessionIds: [] };
  write(s);
  return s.sections[id];
}
export function renameSection(id, name) {
  const s = read();
  if (!s.sections[id]) return false;
  s.sections[id].name = name;
  write(s);
  return true;
}
export function deleteSection(id) {
  const s = read();
  if (!s.sections[id]) return false;
  delete s.sections[id];
  write(s);
  return true;
}
export function moveToSection(sessionId, sectionId) {
  const s = read();
  for (const sec of Object.values(s.sections)) sec.sessionIds = sec.sessionIds.filter((id) => id !== sessionId);
  if (sectionId && s.sections[sectionId]) s.sections[sectionId].sessionIds.push(sessionId);
  write(s);
  return true;
}
export function getSidebarPrefs() { return read().sidebar; }
export function setSidebarPrefs(patch) {
  const s = read();
  s.sidebar = { ...s.sidebar, ...patch };
  write(s);
  return s.sidebar;
}

// ---------- main-chat session tools: list / inspect / act ----------
const statusOf = (id) => {
  if ([...pendingPermissions.values()].some((p) => p.run.sessionId === id)) return 'needs-you';
  if (isBusy(id)) return 'busy';
  return 'idle'; // includes a resting (live but not working) process - same bucket Desktop uses
};

/** Shape used by Claude's list_sessions / get_session tools: plain facts, no app-UI fields. */
export async function listForClaude({ limit = 50, folder } = {}) {
  const all = await listSessions({ limit: 200 });
  return all
    .filter((s) => !folder || (s.cwd && path.normalize(s.cwd) === path.normalize(folder)))
    .slice(0, limit)
    .map((s) => ({
      id: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || 'Untitled',
      status: statusOf(s.sessionId),
      folder: s.cwd || '',
      updated: s.lastModified ? new Date(s.lastModified).toISOString() : null,
      archived: s.tag === 'archived',
    }));
}

export async function getForClaude(id) {
  const info = await getSessionInfo(id);
  if (!info) return null;
  return {
    id,
    title: info.customTitle || info.summary || info.firstPrompt || 'Untitled',
    status: statusOf(id),
    folder: info.cwd || '',
    updated: info.lastModified ? new Date(info.lastModified).toISOString() : null,
    archived: info.tag === 'archived',
    children: childrenOf(id).filter((c) => !c.dismissed).map((c) => c.id),
  };
}

export async function setTitle(id, title) { await renameSession(id, title); }
export async function setArchived(id, archived) { await tagSession(id, archived ? 'archived' : null); }

/** Send a message into a session the way the web app's own composer does: fold into a live/resting
 * process, or start one. Returns { queued } or { runId }, matching POST /api/sessions/:id/send. */
export async function sendMessage(id, text) {
  if (isLive(id)) {
    const qid = runs.get(id).enqueue(text);
    if (qid) return { queued: true, id: qid };
  }
  const info = await getSessionInfo(id);
  if (!info) throw new Error('Session not found');
  const { run } = startRun({ sessionId: id, cwd: info.cwd, prompt: text });
  return { runId: run.id };
}

export function stopSession(id) {
  const r = runs.get(id);
  if (!r || r.done) return false;
  r.abort.abort();
  return true;
}

// Model / effort / permission mode for another session: the same file server.mjs's own
// POST /api/sessions/:id/prefs writes (prefs.json's sessionPrefs), so a choice made here and one
// made from that session's own menu never disagree about which took effect last. Only one process
// touches it (this one), and every write is synchronous, so there is nothing to race.
const PREFS_FILE = () => path.join(process.env.CLAUDE_ANYWHERE_DATA_DIR || process.env.CLAUDE_REMOTE_DATA_DIR || new URL('../data', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'prefs.json');
function readPrefsFile() { try { return { pinned: [], ...JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8')) }; } catch { return { pinned: [] }; } }
function writePrefsFile(p) { try { fs.mkdirSync(path.dirname(PREFS_FILE()), { recursive: true }); fs.writeFileSync(PREFS_FILE(), JSON.stringify(p, null, 2)); } catch {} }

/** Set model / effort / permission mode on another session: applied live if it is running right
 * now, and saved either way so its next turn (or its next open from the sidebar) picks it up. */
export async function setControls(id, patch) {
  const live = runs.get(id);
  if (live && !live.done) await live.setControls(patch);
  const p = readPrefsFile(); p.sessionPrefs = p.sessionPrefs || {};
  const cur = p.sessionPrefs[id] || {};
  for (const k of ['model', 'permissionMode', 'effort']) if (patch[k] !== undefined) cur[k] = patch[k];
  p.sessionPrefs[id] = cur; writePrefsFile(p);
  return cur;
}
