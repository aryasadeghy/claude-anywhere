// This PC's screen and the Android emulator, without touching either: the geometry between a
// screenshot and the screen, key names, the emulator's pictures and input, the prompt Claude gets,
// and the switches - which another device may only turn on with the app password.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as screen from '../lib/screen.mjs';
import * as android from '../lib/android.mjs';
import { appPrompt } from '../lib/app-prompt.mjs';
import * as fx from './fixtures/index.mjs';

test('a screenshot is at most WXGA, and its points are the screen\'s', () => {
  assert.equal(screen.fitScale(3840, 2160), 1 / 3);
  assert.equal(screen.fitScale(1280, 720), 1);
  assert.equal(screen.fitScale(1920, 1200), 800 / 1200);
  const main = { x: 0, y: 0, w: 3840, h: 2160, scale: 1 / 3 };
  assert.deepEqual(screen.toScreen(640, 360, main), { x: 1920, y: 1080 });
  assert.deepEqual(screen.fromScreen(1920, 1080, main), { x: 640, y: 360 });
  assert.throws(() => screen.toScreen(1280, 10, main), /outside the screenshot, which is 1280×720/);
  assert.throws(() => screen.toScreen(-1, 10, main), /outside/);
  assert.throws(() => screen.toScreen('a', 10, main), /not a number/);
});

test('a second display left of the main one has negative coordinates, and keeps them', () => {
  const left = { x: -1920, y: 120, w: 1920, h: 1080, scale: screen.fitScale(1920, 1080) };
  const p = screen.toScreen(0, 0, left);
  assert.deepEqual(p, { x: -1920, y: 120 });
  const q = screen.toScreen(1279, 719, left);
  assert.ok(q.x <= -1 && q.x >= -3 && q.y >= 120 + 1076, JSON.stringify(q));
  assert.deepEqual(screen.fromScreen(-960, 660, left), { x: 640, y: 360 });
});

test('displays are numbered from the main one, then left to right', () => {
  const list = screen.orderDisplays([
    { name: 'B', primary: false, x: 3840, y: 0, w: 1920, h: 1080 },
    { name: 'A', primary: true, x: 0, y: 0, w: 3840, h: 2160 },
    { name: 'C', primary: false, x: -1920, y: 0, w: 1920, h: 1080 },
  ]);
  assert.deepEqual(list.map((d) => [d.id, d.name]), [[1, 'A'], [2, 'C'], [3, 'B']]);
  assert.equal(list[0].label, 'Display 1 (main) · 3840×2160');
});

test('key names, as Claude writes them, become virtual keys', () => {
  assert.deepEqual(screen.parseKeys('Return'), [[0x0d]]);
  assert.deepEqual(screen.parseKeys('ctrl+s'), [[0x11, 0x53]]);
  assert.deepEqual(screen.parseKeys('ctrl+shift+T'), [[0x11, 0x10, 0x54]]);
  assert.deepEqual(screen.parseKeys('alt+Tab'), [[0x12, 0x09]]);
  assert.deepEqual(screen.parseKeys('ctrl+a BackSpace'), [[0x11, 0x41], [0x08]]);
  assert.deepEqual(screen.parseKeys('Page_Down'), [[0x22]]);
  assert.deepEqual(screen.parseKeys('Control_L'), [[0xa2]]);
  assert.deepEqual(screen.parseKeys('super'), [[0x5b]]);
  assert.deepEqual(screen.parseKeys('cmd+c'), [[0x11, 0x43]], 'cmd is Ctrl on Windows');
  assert.deepEqual(screen.parseKeys('F5 F12'), [[0x74], [0x7b]]);
  assert.deepEqual(screen.parseKeys('ctrl++'), [[0x11, 0xbb]]);
  assert.deepEqual(screen.parseKeys('KP_5'), [[0x65]]);
  assert.throws(() => screen.parseKeys('ctrl+nope'), /Unknown key "nope"/);
  assert.throws(() => screen.parseKeys('  '), /No key/);
  assert.ok(screen.isSecureAttention(screen.parseKeys('ctrl+alt+Delete')[0]));
  assert.ok(!screen.isSecureAttention(screen.parseKeys('ctrl+Delete')[0]));
});

test('a browser\'s key event is the key where it sits on the keyboard', () => {
  assert.equal(screen.vkFromBrowser({ key: 'a', code: 'KeyA', keyCode: 65 }), 0x41);
  assert.equal(screen.vkFromBrowser({ key: 'q', code: 'KeyA', keyCode: 81 }), 0x41, 'AZERTY: the place, not the letter');
  assert.equal(screen.vkFromBrowser({ key: 'Enter', code: 'NumpadEnter' }), 0x0d);
  assert.equal(screen.vkFromBrowser({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }), 0x25);
  assert.equal(screen.vkFromBrowser({ key: 'Control', code: 'ControlLeft', keyCode: 17 }), 0xa2);
  assert.equal(screen.vkFromBrowser({ key: 'F11', code: 'F11' }), 0x7a);
  assert.equal(screen.vkFromBrowser({ key: ';', code: 'Semicolon', keyCode: 59 }), 0xba, 'Firefox says 59; the place says 0xBA');
  assert.equal(screen.vkFromBrowser({ key: 'Escape' }), 0x1b, 'no code (a soft keyboard): by name');
  assert.equal(screen.vkFromBrowser({ key: 'Unidentified', keyCode: 229 }), 229);
  assert.equal(screen.vkFromBrowser({}), 0);
});

test('an emulator\'s raw screen becomes a smaller PNG', () => {
  const w = 8, h = 6, px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([i % w < 4 ? 255 : 0, 0, i < w * 3 ? 255 : 0, 255], i * 4);
  for (const head of [12, 16]) {
    const hdr = Buffer.alloc(head); hdr.writeUInt32LE(w, 0); hdr.writeUInt32LE(h, 4); hdr.writeUInt32LE(1, 8);
    const img = android.parseRaw(Buffer.concat([hdr, px]));
    assert.equal(img.w, w); assert.equal(img.h, h); assert.equal(img.data.length, w * h * 4);
  }
  assert.throws(() => android.parseRaw(Buffer.alloc(20)), /cannot read|no picture/);
  const small = android.scaleRGBA({ w, h, data: px }, 4, 4);
  assert.deepEqual([small.w, small.h], [4, 3]);
  assert.deepEqual([...small.rgb.subarray(0, 3)], [255, 0, 255], 'top left: red and blue, averaged over its square');
  assert.deepEqual([...small.rgb.subarray(3 * 3, 3 * 3 + 3)], [0, 0, 255]);
  const png = android.encodePNG(small);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 4); assert.equal(png.readUInt32BE(20), 3);
  if (zlib.crc32) assert.equal(png.readUInt32BE(29), zlib.crc32(png.subarray(12, 29)), 'IHDR checksum');
  // The pixels come back out: undo the Up filter row by row.
  const idatLen = png.readUInt32BE(33), raw = zlib.inflateSync(png.subarray(41, 41 + idatLen));
  const rows = []; for (let y = 0; y < 3; y++) { const f = raw.subarray(y * 13 + 1, y * 13 + 13); rows.push(y ? Buffer.from(f.map((b, i) => (b + rows[y - 1][i]) & 0xff)) : Buffer.from(f)); }
  assert.ok(Buffer.concat(rows).equals(small.rgb));
});

test('emulator input: what adb shell is given', () => {
  assert.equal(android.textArg('hello world'), 'hello%sworld');
  assert.equal(android.textArg("it's $5 (ok)"), "it\\'s%s\\$5%s\\(ok\\)");
  assert.throws(() => android.textArg('héllo'), /ASCII/);
  assert.equal(android.keycodeOf('home'), 3);
  assert.equal(android.keycodeOf('KEYCODE_BACK'), 4);
  assert.equal(android.keycodeOf('recents'), 187);
  assert.equal(android.keycodeOf('a'), 29);
  assert.equal(android.keycodeOf('7'), 14);
  assert.equal(android.keycodeOf('66'), 66);
  assert.throws(() => android.keycodeOf('hyper'), /Unknown key/);
  const devs = android.parseDevices('List of devices attached\nemulator-5554          device product:sdk_gphone64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\nR58M123ABC             device usb:1-1 product:beyond model:SM_G973F\nemulator-5556 offline\n\n');
  assert.deepEqual(devs.map((d) => [d.serial, d.state, d.emulator]), [['emulator-5554', 'device', true], ['R58M123ABC', 'device', false], ['emulator-5556', 'offline', true]]);
  assert.equal(devs[0].model, 'sdk_gphone64_x86_64');
  assert.deepEqual(android.sdkRoots({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\H'), [path.join('C:\\L', 'Android', 'Sdk')]);
  assert.deepEqual(android.sdkRoots({ ANDROID_HOME: '/sdk' }, 'darwin', '/Users/a'), ['/sdk', path.join('/Users/a', 'Library', 'Android', 'sdk')]);
});

test('Claude hears about computer use only when the tools are there', () => {
  const off = appPrompt({ tools: ['SendUserFile'] });
  assert.ok(!/computer use/.test(off) && !/android_control/.test(off));
  const on = appPrompt({ tools: ['screenshot', 'left_click', 'type', 'key', 'scroll', 'request_access', 'android_control'] });
  assert.match(on, /computer use/);
  assert.match(on, /mcp__claude-anywhere__request_access/);
  assert.match(on, /View only, Click only, Full control/);
  assert.match(on, /mcp__claude-anywhere__android_control/);
});

test('the switches start off, and another device turns them on only with the app password', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-screen-'));
  const envFile = path.join(tmp, '.env');
  fs.writeFileSync(envFile, 'REMOTE_PASSWORD=correct-horse-battery\n');
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: { CLAUDE_ANYWHERE_ENV_FILE: envFile } });
  try {
    const { token } = await (await fetch(app.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery' }) })).json();
    assert.ok(token, 'signed in');
    // Behind a proxy (a tunnel, tailscale serve): another device, as far as the server can tell.
    const away = { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-forwarded-for': '100.64.0.7' };
    const set = (body, headers = away) => fetch(app.base + '/api/screen/settings', { method: 'POST', headers, body: JSON.stringify(body) });
    const st = await (await fetch(app.base + '/api/screen/status', { headers: away })).json();
    assert.equal(st.remoteDesktop, false); assert.equal(st.computerUse, false);
    assert.equal(st.needsPassword, true);
    assert.equal(st.supported, process.platform === 'win32');
    if (process.platform !== 'win32') {
      const r = await set({ remoteDesktop: true, password: 'correct-horse-battery' });
      assert.equal(r.status, 400, 'not on this platform');
      return;
    }
    let r = await set({ remoteDesktop: true });
    assert.equal(r.status, 403); assert.equal((await r.json()).needsPassword, true);
    r = await set({ remoteDesktop: true, password: 'wrong-password-here' });
    assert.equal(r.status, 403, 'a wrong password is refused, and not with a 401 that would sign the page out');
    r = await set({ computerUse: true, password: 'correct-horse-battery' });
    assert.equal(r.status, 200);
    const on = await r.json();
    assert.equal(on.computerUse, true); assert.equal(on.remoteDesktop, false);
    r = await set({ computerUse: false });
    assert.equal(r.status, 200, 'turning off never asks');
    assert.equal((await r.json()).computerUse, false);
    // This computer itself is the person at it: no password.
    const here = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
    assert.equal((await (await fetch(app.base + '/api/screen/status', { headers: here })).json()).needsPassword, false);
    r = await set({ remoteDesktop: true }, here);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'screen', 'screen.json'), 'utf8')).remoteDesktop, true, 'kept on disk');
  } finally {
    await app.stop();
    // A child of the stopped app can still be writing into the config dir for a moment (ENOTEMPTY on
    // Linux CI): retry, and never let the clean-up fail a test that passed.
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
});
