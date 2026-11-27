// Notifications for devices that are not the desktop shell: browsers and phones that subscribed
// to Web Push from Settings. The shell has its own notifier (spawn_notifier in src-tauri); this
// is everything else. One VAPID identity for the whole server, kept beside the data so a
// subscription survives a restart; one subscription per device, dropped when its push service
// says it is gone.

import fs from 'node:fs';
import path from 'node:path';
import { generateVapid, send } from './webpush.mjs';

// A page that reported focus this recently is the one being looked at. The page reports every
// few seconds while it is in front (app.js), so this is a little more than two beats.
export const FOCUS_MS = 12000;
const SUBJECT = 'https://github.com/aryasadeghy/claude-anywhere';

let file = '', state = { vapid: null, subs: [] };
const focused = new Map(); // endpoint -> when the page last said it was in front
let lookup = async () => ({ title: '' });

export function init(dataDir, { titleOf } = {}) {
  file = path.join(dataDir, 'push.json');
  if (titleOf) lookup = titleOf;
  try { state = { vapid: null, subs: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  if (!state.vapid?.publicKey) { state.vapid = generateVapid(); save(); }
}
const save = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 }); } catch {} };

export const publicKey = () => state.vapid?.publicKey || '';
export const devices = () => state.subs.map((s) => ({ endpoint: s.endpoint, name: s.name, since: s.since }));
export const has = (endpoint) => state.subs.some((s) => s.endpoint === endpoint);

export function subscribe(sub, name) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https?:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return false;
  state.subs = state.subs.filter((s) => s.endpoint !== sub.endpoint);
  state.subs.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, name: String(name || 'Browser').slice(0, 60), since: Date.now() });
  save();
  return true;
}
export function unsubscribe(endpoint) {
  const n = state.subs.length;
  state.subs = state.subs.filter((s) => s.endpoint !== endpoint);
  focused.delete(endpoint);
  if (state.subs.length !== n) save();
  return state.subs.length !== n;
}
export const reportFocus = (endpoint, isFocused) => { if (!endpoint) return; if (isFocused) focused.set(endpoint, Date.now()); else focused.delete(endpoint); };
const lookingAt = (endpoint) => Date.now() - (focused.get(endpoint) || 0) < FOCUS_MS;

/** What each event says. Desktop's own words where it has them; otherwise the plain sentence. */
export function words(kind, { tool, summary, text, isError, status } = {}) {
  if (kind === 'permission') {
    const ask = /(^|__)AskUserQuestion$/.test(tool || '');
    return { title: ask ? 'Claude has a question' : 'Claude needs your approval', body: summary || (ask ? 'Open the chat to answer.' : tool ? 'To use ' + tool : 'Open the chat to review.') };
  }
  if (kind === 'task') return { title: status === 'completed' ? 'Background task finished' : 'Background task ' + (status === 'stopped' ? 'stopped' : 'failed'), body: summary || '' };
  if (kind === 'test') return { title: 'Notifications are on', body: 'This is what a finished task will look like.' };
  return { title: isError ? 'Claude hit an error' : 'Task complete', body: text || 'Open the chat to read the answer.' };
}

/**
 * Tell every subscribed device that is not being looked at. `sessionId` is what a click opens.
 * Resolves how many pushes were accepted (the test button reports it).
 */
export async function notify(kind, { sessionId = '', only = '', ...info } = {}) {
  if (!state.subs.length) return { sent: 0, skipped: 0 };
  const { title: session } = sessionId ? await lookup(sessionId).catch(() => ({})) : {};
  const w = words(kind, info);
  const payload = { kind, sessionId, title: w.title, body: (session ? session + (w.body ? ' · ' : '') : '') + w.body.slice(0, 200), url: sessionId ? '/#/s/' + sessionId : '/', tag: sessionId ? 'session-' + sessionId : 'claude-anywhere' };
  payload.body = payload.body.slice(0, 240);
  let sent = 0, skipped = 0;
  await Promise.all(state.subs.filter((s) => !only || s.endpoint === only).map(async (s) => {
    if (kind !== 'test' && lookingAt(s.endpoint)) { skipped++; return; }
    const r = await send(s, payload, { vapid: state.vapid, subject: SUBJECT, urgency: kind === 'permission' ? 'high' : 'normal' });
    if (r.ok) sent++;
    else if (r.gone) unsubscribe(s.endpoint);
  }));
  return { sent, skipped };
}
