// The Android emulator, for Claude and for the person: Desktop's Claude_Code_Android_Emulator,
// done with the SDK's own adb and emulator, wherever the Android SDK is on this computer. Only
// emulators - a phone plugged in by USB shows up in adb too, and it is nobody's test device.
//
// Pictures are `adb exec-out screencap` raw pixels, scaled down and written as PNG right here:
// a phone's screen is 1080×2400, which is more than Claude reads and more than a pane draws, and
// a PNG encoder is thirty lines with node's own zlib where an image library is a dependency.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { serveSocket } from './screen.mjs';

// ---------- finding the SDK ----------
const exe = (n) => (process.platform === 'win32' ? n + '.exe' : n);
export function sdkRoots(env = process.env, platform = process.platform, home = os.homedir()) {
  const out = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
  if (platform === 'win32') out.push(env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk'));
  else if (platform === 'darwin') out.push(path.join(home, 'Library', 'Android', 'sdk'));
  else out.push(path.join(home, 'Android', 'Sdk'), path.join(home, 'Android', 'sdk'));
  return out.filter(Boolean);
}
let cached = null;
export function sdk() {
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  let value = null;
  for (const root of sdkRoots()) {
    const adb = path.join(root, 'platform-tools', exe('adb'));
    if (!fs.existsSync(adb)) continue;
    const emu = path.join(root, 'emulator', exe('emulator'));
    value = { root, adb, emulator: fs.existsSync(emu) ? emu : null };
    break;
  }
  cached = { at: Date.now(), value };
  return value;
}
export const NO_SDK = 'No Android SDK on this computer. Install Android Studio (it brings the SDK and the emulator) and make a virtual device in its Device Manager, or point ANDROID_HOME at an SDK you already have. Then open this again.';

const run = (file, args, { timeout = 30000, buffer = false } = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout, windowsHide: true, maxBuffer: 128 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8' }, (err, out, errOut) => {
    if (err) return reject(new Error(String(errOut || err.message).trim().split('\n').slice(-2).join(' ') || err.message));
    resolve(out);
  });
});
const need = () => { const s = sdk(); if (!s) throw new Error(NO_SDK); return s; };
export const adb = (args, opts) => run(need().adb, args, opts);

// ---------- devices ----------
export function parseDevices(text) {
  return String(text).split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [serial, state, ...rest] = l.split(/\s+/);
    const props = Object.fromEntries(rest.map((p) => p.split(':')).filter((x) => x.length === 2));
    return { serial, state, model: props.model || '', emulator: /^emulator-\d+$/.test(serial) };
  }).filter((d) => d.serial);
}
export async function devices() {
  const list = parseDevices(await adb(['devices', '-l'])).filter((d) => d.emulator);
  // Which virtual device each is: the name a person gave it in Android Studio.
  for (const d of list) if (d.state === 'device') d.avd = String(await adb(['-s', d.serial, 'emu', 'avd', 'name'], { timeout: 5000 }).catch(() => '')).split(/\r?\n/)[0].trim();
  return list;
}
export async function avds() {
  const s = need();
  if (!s.emulator) return [];
  return String(await run(s.emulator, ['-list-avds'], { timeout: 15000 })).split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !/^(INFO|WARNING|ERROR)\b/.test(x));
}
export async function status() {
  const s = sdk();
  if (!s) return { sdk: false, message: NO_SDK };
  const [list, names] = await Promise.all([devices().catch(() => []), avds().catch(() => [])]);
  return { sdk: true, root: s.root, emulator: !!s.emulator, devices: list, avds: names };
}
// Boots a virtual device in a window of its own on this computer and waits for Android to be up.
export async function boot(avd, { timeoutMs = 240000 } = {}) {
  const s = need();
  if (!s.emulator) throw new Error('The SDK at ' + s.root + ' has no emulator. Install it from Android Studio\'s SDK Manager (SDK Tools › Android Emulator).');
  const running = (await devices()).find((d) => d.avd === avd);
  if (running?.state === 'device') return running;
  if (!(await avds()).includes(avd)) throw new Error(`No virtual device called "${avd}". There are: ${(await avds()).join(', ') || 'none - make one in Android Studio\'s Device Manager'}.`);
  const child = spawn(s.emulator, ['-avd', avd], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const d = (await devices().catch(() => [])).find((x) => x.avd === avd && x.state === 'device');
    if (d && String(await adb(['-s', d.serial, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 5000 }).catch(() => '')).trim() === '1') return d;
  }
  throw new Error(`"${avd}" did not finish starting in ${Math.round(timeoutMs / 1000)} s; it may still be booting.`);
}
export async function pick(serial) {
  const list = (await devices()).filter((d) => d.state === 'device');
  if (serial) { const d = list.find((x) => x.serial === serial || x.avd === serial); if (!d) throw new Error(`No running emulator "${serial}". Running: ${list.map((x) => x.serial + (x.avd ? ' (' + x.avd + ')' : '')).join(', ') || 'none'}.`); return d; }
  if (!list.length) throw new Error('No emulator is running. Boot one first (action "attach" with an avd name; "list" shows them).');
  return list[0];
}

// ---------- pictures ----------
// screencap without -p: a header (width, height, format, and on Android 8+ a colour space) and
// then the pixels, RGBA. Which header it is shows in the length.
export function parseRaw(buf) {
  if (!buf || buf.length < 12) throw new Error('The emulator sent no picture.');
  const w = buf.readUInt32LE(0), h = buf.readUInt32LE(4);
  const head = buf.length - w * h * 4;
  if (w <= 0 || h <= 0 || (head !== 12 && head !== 16)) throw new Error('The emulator sent a picture this cannot read.');
  return { w, h, data: buf.subarray(head) };
}
// Box filter: each output pixel the average of the input pixels it covers (alpha dropped - a
// screen has none). Sharp enough for text at the sizes Claude and a pane use.
export function scaleRGBA(img, maxW, maxH) {
  const s = Math.min(1, maxW / img.w, maxH / img.h);
  const ow = Math.max(1, Math.round(img.w * s)), oh = Math.max(1, Math.round(img.h * s));
  const out = Buffer.alloc(ow * oh * 3);
  const fx = img.w / ow, fy = img.h / oh;
  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * img.w + xx) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
      const o = (y * ow + x) * 3; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return { w: ow, h: oh, rgb: out, scale: ow / img.w };
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
// RGB, 8 bits, each row filtered "Up" (the row above is usually the same on a screen, which deflates to nothing).
export function encodePNG({ w, h, rgb }) {
  const row = w * 3, raw = Buffer.alloc((row + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (row + 1), s = y * row;
    raw[o] = 2;
    for (let i = 0; i < row; i++) raw[o + 1 + i] = (rgb[s + i] - (y ? rgb[s - row + i] : 0)) & 0xff;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
export async function capture(serial) { return parseRaw(await adb(['-s', serial, 'exec-out', 'screencap'], { buffer: true, timeout: 15000 })); }
export async function screenshot(serial, { maxW = 540, maxH = 1200 } = {}) {
  const img = await capture(serial);
  const small = scaleRGBA(img, maxW, maxH);
  return { png: encodePNG(small), w: small.w, h: small.h, sw: img.w, sh: img.h, scale: small.scale };
}

// ---------- input ----------
// `input text` goes through the device's shell: a space is %s there, and the shell's own
// characters need a backslash. It types ASCII only.
export function textArg(s) {
  const t = String(s);
  if (/[^\x20-\x7e]/.test(t)) throw new Error('The emulator can only be typed ASCII text into this way; put other text on its clipboard instead.');
  return t.replace(/([\\'"`$&|;<>()*~!?#[\]{}^])/g, '\\$1').replace(/ /g, '%s');
}
const KEYCODES = { home: 3, back: 4, call: 5, endcall: 6, up: 19, down: 20, left: 21, right: 22, center: 23, volume_up: 24, volume_down: 25, power: 26, camera: 27, tab: 61, space: 62, enter: 66, return: 66, del: 67, backspace: 67, menu: 82, search: 84, escape: 111, esc: 111, forward_del: 112, delete: 112, move_home: 122, move_end: 123, app_switch: 187, recents: 187, overview: 187, sleep: 223, wakeup: 224, page_up: 92, page_down: 93 };
export function keycodeOf(name) {
  const n = String(name).trim().toLowerCase().replace(/^keycode_/, '').replace(/[\s-]/g, '_');
  // One digit is the digit key; a code of its own is two or more ("66"), or KEYCODE_<name>.
  if (/^[0-9]$/.test(n)) return 7 + Number(n);
  if (/^\d+$/.test(n)) return Number(n);
  if (KEYCODES[n] !== undefined) return KEYCODES[n];
  if (/^[a-z]$/.test(n)) return 29 + n.charCodeAt(0) - 97;
  throw new Error(`Unknown key "${name}". Use home, back, recents, enter, backspace, tab, up, down, left, right, power, volume_up, or an Android KEYCODE.`);
}
const shell = (serial, ...args) => adb(['-s', serial, 'shell', ...args.map(String)]);
export const tap = (serial, x, y) => shell(serial, 'input', 'tap', Math.round(x), Math.round(y));
export const swipe = (serial, x1, y1, x2, y2, ms = 300) => shell(serial, 'input', 'swipe', Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2), Math.max(1, Math.round(ms)));
export const typeText = (serial, s) => shell(serial, 'input', 'text', textArg(s));
export const key = (serial, name) => shell(serial, 'input', 'keyevent', keycodeOf(name));
export const install = (serial, apk) => adb(['-s', serial, 'install', '-r', apk], { timeout: 300000 });
export const launch = (serial, pkg) => shell(serial, 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1');

// ---------- the pane ----------
export function handleUpgrade(req, socket, head, { serial }) {
  const v = { size: null, dev: null, paused: false, down: null, w: 0, h: 0 };
  const ws = serveSocket(req, socket, head, { onMessage: (m) => onInput(v, ws, m), onClose: () => {} });
  if (!sdk()) return ws.end({ t: 'nosdk', text: NO_SDK });
  (async () => {
    try { v.dev = await pick(serial); } catch (e) { return ws.end({ t: 'error', text: e.message }); }
    ws.send({ t: 'device', serial: v.dev.serial, avd: v.dev.avd || '' });
    let last = '';
    while (ws.open) {
      if (!v.size || v.paused) { await new Promise((r) => setTimeout(r, 200)); continue; }
      const t0 = Date.now();
      try {
        const img = await capture(v.dev.serial);
        if (img.w !== v.w || img.h !== v.h) { v.w = img.w; v.h = img.h; ws.send({ t: 'size', w: img.w, h: img.h }); last = ''; }
        // A sampled fingerprint: a phone screen that sits still is not re-sent.
        let fp = 0; for (let i = 0; i < img.data.length; i += 4093) fp = (fp * 31 + img.data[i]) | 0;
        const key = fp + ':' + v.size.pw + 'x' + v.size.ph;
        if (key !== last && ws.backlog < 512 * 1024) { last = key; ws.frame(encodePNG(scaleRGBA(img, Math.max(160, v.size.pw || 540), Math.max(240, v.size.ph || 1200)))); }
      } catch (e) { ws.send({ t: 'note', text: e.message }); await new Promise((r) => setTimeout(r, 1500)); }
      await new Promise((r) => setTimeout(r, Math.max(50, 300 - (Date.now() - t0))));
    }
  })();
}
async function onInput(v, ws, m) {
  if (!v.dev) return;
  const s = v.dev.serial, note = (e) => ws.send({ t: 'note', text: e.message });
  const clamp = (x, max) => Math.max(0, Math.min(max - 1, Math.round(+x || 0)));
  switch (m.t) {
    case 'size': v.size = { pw: +m.pw || 0, ph: +m.ph || 0 }; v.paused = false; break;
    case 'pause': v.paused = true; break;
    // A finger on the glass is a press and a lift: close together and quick is a tap, held still
    // is a long press, and anything else is a swipe from one to the other.
    case 'mouse':
      if (m.type === 'down') v.down = { x: clamp(m.x, v.w), y: clamp(m.y, v.h), at: Date.now() };
      else if (m.type === 'up' && v.down) {
        const d = v.down; v.down = null;
        const x = clamp(m.x, v.w), y = clamp(m.y, v.h), ms = Date.now() - d.at;
        if (Math.hypot(x - d.x, y - d.y) < 12) await (ms > 500 ? swipe(s, d.x, d.y, d.x, d.y, ms) : tap(s, d.x, d.y)).catch(note);
        else await swipe(s, d.x, d.y, x, y, Math.max(80, Math.min(2000, ms))).catch(note);
      }
      break;
    case 'wheel': {
      const x = clamp(m.x, v.w), y = clamp(m.y, v.h), dy = Math.max(-v.h / 2, Math.min(v.h / 2, -(+m.dy || 0) * 3));
      if (Math.abs(dy) > 4) await swipe(s, x, y, x, clamp(y + dy, v.h), 150).catch(note);
      break;
    }
    case 'text': if (m.text) await typeText(s, m.text).catch(note); break;
    case 'key': {
      if (m.type !== 'down') break;
      if (m.text && !m.ctrl && !m.alt && !m.meta) { await typeText(s, m.text).catch(note); break; }
      const name = { Enter: 'enter', Backspace: 'backspace', Delete: 'forward_del', Tab: 'tab', Escape: 'back', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'move_home', End: 'move_end', PageUp: 'page_up', PageDown: 'page_down' }[m.key];
      if (name) await key(s, name).catch(note);
      break;
    }
    case 'special': if (['home', 'back', 'recents', 'power', 'volume_up', 'volume_down'].includes(m.name)) await key(s, m.name).catch(note); break;
  }
}
