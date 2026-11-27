// Claude's computer use: this PC's screen, mouse and keyboard (lib/screen.mjs), named as Desktop
// names them, and the Android emulator (lib/android.mjs) as Desktop's Claude_Code_Android_Emulator
// has it - one control tool with an action.
//
// Asking is per app and per session, with Desktop's three tiers: View only (it shows in
// screenshots), Click only (clicks and scrolling), Full control (typing and keys too). The first
// action that touches an app's window asks the person through the normal permission card, naming
// the app and the tier; the answer holds for the session. Screenshots show only the apps Claude
// was given - the rest is painted over before the picture leaves the helper - so nothing the
// person has not allowed ever reaches the transcript. None of these go through canUseTool: the
// tool itself knows which app a point lands on, the SDK's permission check does not.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import * as screen from './screen.mjs';
import * as android from './android.mjs';
import { pendingPermissions, bus } from './runs.mjs';

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const TIERS = ['read', 'click', 'full'];
export const TIER_LABEL = { read: 'View only', click: 'Click only', full: 'Full control' };
const TIER_ARG = { view: 'read', click: 'click', full: 'full' };
const rank = (t) => TIERS.indexOf(t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per session, not per run: a process that rests and wakes again is the same conversation, and
// what the person allowed in it still stands.
const sessions = new Map(); // sessionId -> { grants: Map(app -> tier), denied: Set(app), view, stopped, aborted }
const stateOf = (id) => { let s = sessions.get(id || ''); if (!s) sessions.set(id || '', (s = { grants: new Map(), denied: new Set(), view: null, stopped: false, aborted: 0 })); return s; };
export const accessFor = (id) => { const s = stateOf(id); return { grants: Object.fromEntries(s.grants), denied: [...s.denied] }; };
const runsWaiting = new Map(); // reqId -> run, for the prompts this pack opened

// The banner's Stop on the PC: Claude's control ends now - what it was given is taken back, its
// turn is stopped, and it is told why if it tries again before the person writes.
const live = new Map(); // sessionId -> run
screen.events.on('stop', ({ sessions: who }) => {
  for (const id of who) {
    const s = stateOf(id); s.grants.clear(); s.stopped = true;
    const run = live.get(id);
    if (run && !run.done) { denyOpen(run, 'The person stopped Claude from the banner on the PC.'); run.stop?.().catch?.(() => {}); }
  }
});
function denyOpen(run, why) {
  for (const [reqId, r] of runsWaiting) if (r === run) { const p = pendingPermissions.get(reqId); runsWaiting.delete(reqId); if (p) { pendingPermissions.delete(reqId); p.resolve({ behavior: 'deny', message: why }); run.push({ t: 'permission_resolved', reqId, behavior: 'deny' }); } }
}
// A Stop in the chat ends Claude's control too, and a finished turn takes the banner down.
function watch(run) {
  if (run._screenWatched) return;
  run._screenWatched = true;
  const push = run.push.bind(run), stop = run.stop.bind(run);
  run.push = (ev) => { if (ev?.t === 'result') { screen.claudeDone(run.sessionId); const s = stateOf(run.sessionId); s.stopped = false; } return push(ev); };
  run.stop = (...a) => { stateOf(run.sessionId).aborted = Date.now(); screen.claudeDone(run.sessionId); denyOpen(run, 'Turn was stopped.'); return stop(...a); };
}

// The normal permission card, opened by the tool itself: it says which app and which tier.
function ask(run, tool, apps, tier, reason, signal) {
  return new Promise((resolve) => {
    const reqId = randomUUID();
    const input = { apps, access: TIER_LABEL[tier], ...(reason ? { reason } : {}) };
    const summary = `${apps.join(', ')} · ${TIER_LABEL[tier]}`;
    pendingPermissions.set(reqId, { run, resolve: (r) => { runsWaiting.delete(reqId); resolve(r?.behavior === 'allow'); } });
    runsWaiting.set(reqId, run);
    run.push({ t: 'permission', reqId, tool: 'mcp__claude-anywhere__' + tool, input, summary, canAlways: false, computerAccess: { apps, tier, label: TIER_LABEL[tier], reason: reason || '' } });
    bus.emit('permission', { sessionId: run.sessionId, tool: 'Computer use', summary });
    signal?.addEventListener('abort', () => { const p = pendingPermissions.get(reqId); if (p) { pendingPermissions.delete(reqId); runsWaiting.delete(reqId); resolve(false); run.push({ t: 'permission_resolved', reqId, behavior: 'deny' }); } }, { once: true });
  });
}

export default function computerTools(run) {
  const sid = () => run.sessionId || '';
  const st = () => stateOf(sid());
  const pc = screen.supported() && screen.getSettings().computerUse;
  const droid = !!android.sdk();
  if (!pc && !droid) return null;
  watch(run);
  if (run.sessionId) live.set(run.sessionId, run);

  // The app must have been given at least this tier; asks once if it has not been decided.
  async function need(apps, tier, toolName, extra, reason) {
    const s = st();
    const missing = [...new Set(apps)].filter((a) => !(rank(s.grants.get(a)) >= rank(tier)));
    const refused = missing.filter((a) => s.denied.has(a));
    if (refused.length) throw new Error(`The person did not allow ${refused.join(', ')} in this session. Leave ${refused.length > 1 ? 'them' : 'it'} alone, or ask them in the chat.`);
    if (!missing.length) return;
    const ok = await ask(run, toolName, missing, tier, reason, extra?.signal);
    for (const a of missing) ok ? s.grants.set(a, TIERS[Math.max(rank(tier), rank(s.grants.get(a)))]) : s.denied.add(a);
    if (!ok) throw new Error(`The person did not allow ${missing.join(', ')} (${TIER_LABEL[tier]}). Don't try again unless they ask.`);
  }
  // Where Claude's coordinates are measured: the last screenshot's display, at its scale.
  async function view(displayId) {
    const s = st(), list = await screen.displays();
    const d = list.find((x) => x.id === (displayId ?? s.view?.id)) || list[0];
    if (!d) throw new Error('No display found.');
    if (!s.view || s.view.id !== d.id || s.view.w !== d.w || s.view.h !== d.h) s.view = { ...d, scale: screen.fitScale(d.w, d.h) };
    return s.view;
  }
  const shownApps = () => [...st().grants.keys()];
  async function at(coordinate, tier, toolName, extra) {
    if (!Array.isArray(coordinate) || coordinate.length !== 2) throw new Error('coordinate is [x, y] in the screenshot\'s pixels.');
    const p = screen.toScreen(coordinate[0], coordinate[1], await view());
    const w = await screen.windowAt(p.x, p.y);
    if (w?.banner) throw new Error('That point is claude-anywhere\'s own banner on the PC; it is there for the person, not for Claude.');
    await need([w?.app || 'Desktop and taskbar'], tier, toolName, extra);
    return p;
  }
  async function front(tier, toolName, extra) {
    const w = await screen.foreground();
    if (!w) throw new Error('No window is in front to send keys to. Click into one first.');
    await need([w.app], tier, toolName, extra);
    return w;
  }
  const guard = (fn) => async (args, extra) => {
    if (!screen.supported()) return text(screen.NOT_HERE, true);
    if (!screen.getSettings().computerUse) return text('Computer use is off on this PC. The person can turn on "Let Claude use this PC" in Settings › Remote access.', true);
    const s = st();
    if (run.sessionId) live.set(run.sessionId, run);
    if (s.stopped) return text('The person stopped Claude\'s control of this PC with the Stop on its banner. Don\'t use the computer again in this turn; tell them where you got to.', true);
    const t0 = Date.now();
    try {
      const r = await fn(args, extra);
      if (s.aborted > t0) return text('Stopped.', true);
      screen.claudeActed(sid());
      return r;
    } catch (e) { return text(String(e?.message || e), true); }
  };
  const coordinate = z.array(z.number()).length(2).describe('[x, y] in the pixels of the last screenshot');
  async function click(args, extra, button, count, name) {
    const p = await at(args.coordinate, 'click', name, extra);
    const mods = args.text ? screen.parseKeys(args.text)[0] : [];
    if (mods.length) await screen.keys(mods, 'down');
    try { await screen.mouse({ action: 'click', button, count, x: p.x, y: p.y, claude: true }); }
    finally { if (mods.length) await screen.keys(mods, 'up'); }
    await sleep(120);
    return text(`${name === 'left_click' ? 'Clicked' : name.replace(/_/g, ' ')} at (${args.coordinate.join(', ')}).`);
  }
  async function shot(display, region) {
    const v = await view(display);
    const box = region ? (() => {
      const [x0, y0, x1, y1] = region.map(Number);
      const a = screen.toScreen(Math.min(x0, x1), Math.min(y0, y1), v), b = screen.toScreen(Math.max(x0, x1) - 1, Math.max(y0, y1) - 1, v);
      return { x: a.x, y: a.y, w: Math.max(8, b.x - a.x + 1), h: Math.max(8, b.y - a.y + 1) };
    })() : null;
    const max = region ? { maxW: screen.CLAUDE_MAX.w, maxH: screen.CLAUDE_MAX.h } : { maxW: Math.round(v.w * v.scale), maxH: Math.round(v.h * v.scale) };
    const g = await screen.grab(v, { ...max, quality: 75, show: shownApps(), region: box, cursor: false });
    const list = await screen.displays();
    const given = [...st().grants].map(([a, t]) => `${a} (${TIER_LABEL[t]})`);
    const lines = [
      region ? `A closer look at (${region.join(', ')}), ${g.w}×${g.h}. Coordinates for clicks are still those of the full screenshot.`
        : `Display ${v.id} of ${list.length}, ${g.w}×${g.h} (the screen is ${v.w}×${v.h}). Coordinates for clicks are this picture's pixels.`,
      given.length ? 'Shown: ' + given.join(', ') + ', and the desktop and taskbar.' : 'No app has been allowed yet: only the desktop and taskbar show.',
    ];
    if (g.hidden?.length) lines.push(`Painted over because the person has not allowed them yet: ${g.hidden.join(', ')}. Ask with request_access when you need one, or click into it and the person is asked.`);
    return { content: [{ type: 'image', data: g.jpeg.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: lines.join('\n') }] };
  }

  const tools = [];
  const allow = [];
  if (pc) {
    tools.push(
      tool('request_access', 'Ask the person to let you use one or more apps on this PC for the rest of the session, at one level: "view" (they show in screenshots), "click" (clicking and scrolling too) or "full" (typing and keys too). Ask for the least you need. The first action on an app you have not been given asks by itself; this asks ahead, for several at once, with your reason.',
        { apps: z.array(z.string()).min(1).describe('App names as list_apps or a screenshot names them, e.g. ["Notepad", "Google Chrome"]'), access: z.enum(['view', 'click', 'full']).optional().describe('Default "click"'), reason: z.string().max(300).optional().describe('One sentence the person reads: why you need them') },
        guard(async ({ apps, access, reason }, extra) => { const tier = TIER_ARG[access || 'click']; await need(apps, tier, 'request_access', extra, reason); return text(`Allowed for this session: ${apps.join(', ')} (${TIER_LABEL[tier]}).`); })),
      tool('screenshot', 'Take a screenshot of this PC\'s screen (one display). Apps the person has not allowed you are painted over. Coordinates you pass to the other tools are this picture\'s pixels.',
        { display: z.number().int().optional().describe('Which display, 1 = the main one; default the one you used last') },
        guard(async ({ display }) => shot(display))),
      tool('zoom', 'Look closer at a part of the last screenshot, at more detail. For reading only: click with the full screenshot\'s coordinates.',
        { region: z.array(z.number()).length(4).describe('[x0, y0, x1, y1] in the last screenshot\'s pixels') },
        guard(async ({ region }) => shot(undefined, region))),
      tool('left_click', 'Click at a point of the screenshot. `text` holds modifier keys to keep down during the click, e.g. "shift" or "ctrl".', { coordinate, text: z.string().optional() }, guard((a, x) => click(a, x, 'left', 1, 'left_click'))),
      tool('right_click', 'Right-click at a point of the screenshot.', { coordinate, text: z.string().optional() }, guard((a, x) => click(a, x, 'right', 1, 'right_click'))),
      tool('middle_click', 'Middle-click at a point of the screenshot.', { coordinate, text: z.string().optional() }, guard((a, x) => click(a, x, 'middle', 1, 'middle_click'))),
      tool('double_click', 'Double-click at a point of the screenshot.', { coordinate, text: z.string().optional() }, guard((a, x) => click(a, x, 'left', 2, 'double_click'))),
      tool('triple_click', 'Triple-click at a point of the screenshot (selects a line or paragraph).', { coordinate, text: z.string().optional() }, guard((a, x) => click(a, x, 'left', 3, 'triple_click'))),
      tool('mouse_move', 'Move the pointer to a point of the screenshot, without clicking (to hover).', { coordinate },
        guard(async ({ coordinate: c }, x) => { const p = await at(c, 'click', 'mouse_move', x); await screen.mouse({ action: 'move', x: p.x, y: p.y, claude: true }); return text(`Moved to (${c.join(', ')}).`); })),
      tool('left_click_drag', 'Press at one point, drag to another and let go.', { start_coordinate: coordinate, coordinate },
        guard(async ({ start_coordinate: a, coordinate: b }, x) => { const p = await at(a, 'click', 'left_click_drag', x), q = await at(b, 'click', 'left_click_drag', x); await screen.drag({ path: [[p.x, p.y], [q.x, q.y]], claude: true }); return text(`Dragged from (${a.join(', ')}) to (${b.join(', ')}).`); })),
      tool('scroll', 'Scroll at a point of the screenshot.', { coordinate, scroll_direction: z.enum(['up', 'down', 'left', 'right']), scroll_amount: z.number().int().min(1).max(30).optional().describe('Wheel notches, default 3') },
        guard(async ({ coordinate: c, scroll_direction: dir, scroll_amount: n = 3 }, x) => {
          const p = await at(c, 'click', 'scroll', x);
          const d = n * 120;
          await screen.scroll({ x: p.x, y: p.y, dy: dir === 'up' ? d : dir === 'down' ? -d : 0, dx: dir === 'right' ? d : dir === 'left' ? -d : 0, claude: true });
          await sleep(150);
          return text(`Scrolled ${dir} ${n} at (${c.join(', ')}).`);
        })),
      tool('type', 'Type text into the window in front, as if on its keyboard. Newlines press Enter.', { text: z.string().min(1).max(20000) },
        guard(async ({ text: t }, x) => {
          const w = await front('full', 'type', x);
          const t0 = Date.now();
          // In pieces, so a Stop lands between them rather than after the whole text.
          for (let i = 0; i < t.length; i += 200) { if (st().aborted > t0 || st().stopped) return text('Stopped while typing.', true); await screen.typeText(t.slice(i, i + 200)); }
          return text(`Typed ${t.length} character${t.length === 1 ? '' : 's'} into ${w.app}.`);
        })),
      tool('key', 'Press a key or a combination in the window in front, xdotool style: "Return", "Tab", "Escape", "ctrl+s", "alt+Tab", "ctrl+shift+t", "Page_Down", "F5"; several separated by spaces are pressed one after another.', { text: z.string().min(1).describe('The key or keys') },
        guard(async ({ text: spec }, x) => {
          const combos = screen.parseKeys(spec);
          if (combos.some(screen.isSecureAttention)) return text(screen.CAD, true);
          const w = await front('full', 'key', x);
          for (const c of combos) { await screen.keys(c, 'press'); await sleep(40); }
          return text(`Pressed ${spec} in ${w.app}.`);
        })),
      tool('open_application', 'Open an app on this PC by the name its Start menu shortcut has ("Notepad", "Google Chrome", "Paint"), or bring it forward if it is open.', { app: z.string().min(1) },
        guard(async ({ app }, x) => {
          const wins = await screen.windows();
          const has = wins.find((w) => w.app.toLowerCase() === app.toLowerCase()) || wins.find((w) => w.app.toLowerCase().includes(app.toLowerCase()));
          await need([has?.app || app], 'read', 'open_application', x);
          if (has) { await screen.focus(has.hwnd); return text(`Brought ${has.app} forward ("${has.title}").`); }
          const r = await screen.open(app);
          await sleep(1500);
          return text(`Opened ${app}${r.via === 'start menu' ? ' from its Start menu shortcut' : ''}. Take a screenshot to see it.`);
        })),
      tool('list_apps', 'List the apps with windows open on this PC, which one is in front, and what you may do with each. Titles show only for apps you were allowed.', {},
        guard(async () => {
          const wins = await screen.windows(), s = st();
          const byApp = new Map();
          for (const w of wins) { const e = byApp.get(w.app) || { titles: [], front: false, count: 0 }; e.count++; e.front ||= w.foreground; if (w.title && s.grants.has(w.app)) e.titles.push(w.title.slice(0, 80)); byApp.set(w.app, e); }
          const lines = [...byApp].map(([a, e]) => `- ${a}${e.front ? ' (in front)' : ''}: ${s.grants.has(a) ? TIER_LABEL[s.grants.get(a)] : s.denied.has(a) ? 'not allowed' : 'not asked yet'}; ${e.count} window${e.count === 1 ? '' : 's'}${e.titles.length ? ': ' + e.titles.map((t) => `"${t}"`).join(', ') : ''}`);
          const list = await screen.displays();
          return text((lines.length ? lines.join('\n') : 'No app windows are open.') + `\n\n${list.length} display${list.length === 1 ? '' : 's'}: ${list.map((d) => d.label).join('; ')}.`);
        })),
      tool('switch_display', 'Use another display for screenshots and coordinates (1 = the main one).', { display: z.number().int().min(1) },
        guard(async ({ display }) => { const v = await view(display); return text(`Now on display ${v.id} (${v.w}×${v.h}). Take a screenshot.`); })),
      tool('cursor_position', 'Where the pointer is, in the last screenshot\'s pixels.', {},
        guard(async () => { const c = await screen.call('cursor'); const v = await view(); const p = screen.fromScreen(c.x, c.y, v); return text(`(${p.x}, ${p.y})`); })),
      tool('wait', 'Wait a moment for something on screen to finish (up to 30 seconds), then take a screenshot to see it.', { duration: z.number().min(0).max(30).describe('Seconds') },
        guard(async ({ duration }) => { const t0 = Date.now(); while (Date.now() - t0 < duration * 1000) { if (st().aborted > t0) return text('Stopped.', true); await sleep(200); } return text(`Waited ${duration} s.`); })),
    );
    // Each tool decides about itself, per app (see `need`): the SDK is not asked.
    allow.push(...tools.map((t) => t.name));
  }
  if (droid) {
    const show = (d) => run.push({ t: 'screen_show', source: 'android', serial: d.serial });
    const dev = (serial) => android.pick(serial);
    const pt = async (d, c) => { const s = st().droid?.[d.serial]?.scale || 1; return [Math.round(c[0] / s), Math.round(c[1] / s)]; };
    tools.push(tool('android_control', 'Drive an Android emulator on this computer (never a real phone): "list" shows virtual devices and running emulators; "attach" boots one by avd name (or picks a running one); "screenshot" returns its screen; "tap", "swipe", "text", "press_key" ("home", "back", "recents", "enter", "backspace", or an Android KEYCODE) act on it; "install" installs an .apk by path; "launch" starts an app by package name. Coordinates are the last screenshot\'s pixels. The person sees the emulator in a pane as you work.',
      {
        action: z.enum(['list', 'attach', 'screenshot', 'tap', 'swipe', 'text', 'press_key', 'install', 'launch']),
        avd: z.string().optional().describe('attach: the virtual device to boot'),
        serial: z.string().optional().describe('Which running emulator (emulator-5554); default the first'),
        coordinate: z.array(z.number()).length(2).optional().describe('tap, and the start of a swipe'),
        end_coordinate: z.array(z.number()).length(2).optional().describe('swipe: where it ends'),
        duration_ms: z.number().int().min(1).max(10000).optional().describe('swipe: how long; a long press is a swipe that does not move'),
        text: z.string().optional().describe('text: what to type (ASCII)'),
        key: z.string().optional().describe('press_key: which key'),
        apk: z.string().optional().describe('install: the .apk path on this computer'),
        package: z.string().optional().describe('launch: the app package, e.g. com.example.app'),
      },
      async (a) => {
        try {
          if (a.action === 'list') {
            const s = await android.status();
            return text(`Virtual devices: ${s.avds.join(', ') || 'none (make one in Android Studio\'s Device Manager)'}.\nRunning emulators: ${s.devices.map((d) => `${d.serial}${d.avd ? ' (' + d.avd + ')' : ''} ${d.state}`).join(', ') || 'none'}.`);
          }
          if (a.action === 'attach') {
            const d = a.avd ? await android.boot(a.avd) : await dev(a.serial);
            show(d);
            return text(`Attached to ${d.serial}${d.avd ? ' (' + d.avd + ')' : ''}. Take a screenshot to see it.`);
          }
          const d = await dev(a.serial);
          show(d);
          switch (a.action) {
            case 'screenshot': {
              const r = await android.screenshot(d.serial, { maxW: 540, maxH: 1200 });
              (st().droid ||= {})[d.serial] = { scale: r.scale };
              return { content: [{ type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `${d.serial}${d.avd ? ' (' + d.avd + ')' : ''}, ${r.w}×${r.h} (the device is ${r.sw}×${r.sh}). Coordinates are this picture's pixels.` }] };
            }
            case 'tap': { if (!a.coordinate) throw new Error('tap needs coordinate.'); const [x, y] = await pt(d, a.coordinate); await android.tap(d.serial, x, y); return text(`Tapped (${a.coordinate.join(', ')}).`); }
            case 'swipe': { if (!a.coordinate) throw new Error('swipe needs coordinate.'); const [x1, y1] = await pt(d, a.coordinate), [x2, y2] = await pt(d, a.end_coordinate || a.coordinate); await android.swipe(d.serial, x1, y1, x2, y2, a.duration_ms || 300); return text('Swiped.'); }
            case 'text': if (!a.text) throw new Error('text needs text.'); await android.typeText(d.serial, a.text); return text(`Typed ${a.text.length} characters.`);
            case 'press_key': if (!a.key) throw new Error('press_key needs key.'); await android.key(d.serial, a.key); return text(`Pressed ${a.key}.`);
            case 'install': if (!a.apk) throw new Error('install needs apk.'); return text(String(await android.install(d.serial, a.apk)).trim() || 'Installed.');
            case 'launch': if (!a.package) throw new Error('launch needs package.'); await android.launch(d.serial, a.package); return text(`Launched ${a.package}.`);
          }
          return text('Unknown action.', true);
        } catch (e) { return text(String(e?.message || e), true); }
      }));
    // An emulator is a sandbox the person made for testing; Desktop does not ask for it either.
    allow.push('android_control');
  }
  return { tools, allow };
}
