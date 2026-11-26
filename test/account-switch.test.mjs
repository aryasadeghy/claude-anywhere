// A chat's Claude Code process rests between turns and keeps the login it was started with. After
// a switch of account that chat went on answering "OAuth token revoked" while every new chat
// worked, and switching back did not help. Now a switch ends the resting process, so the next
// message in the same chat runs on the account chosen now.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, startApp, startFakeApi, fakeApiEnv } from './fixtures/index.mjs';

let tmp, api, app;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(100); } return false; };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-account-'));
  api = await startFakeApi({ delay: 0 });
  app = await startApp({ port: await freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fakeApiEnv(api) });
});
after(async () => {
  await app?.stop(); await api?.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
});

const call = (p, body, method = 'POST') => fetch(app.base + p, { method, headers: { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
const turns = () => api.requests.filter((r) => r.path.endsWith('/v1/messages') && r.stream);
const idle = async (id) => until(async () => !(await call('/api/runs', undefined, 'GET')).some((r) => r.sessionId === id));

test('the next message in a resting chat runs on the account switched to', async () => {
  const cwd = path.join(tmp, 'project'); fs.mkdirSync(cwd, { recursive: true });
  const { sessionId } = await call('/api/sessions', { text: 'first', cwd });
  assert.ok(sessionId, 'a session started');
  assert.ok(await until(async () => turns().length > 0) && await idle(sessionId), 'the first turn ended');
  assert.equal(turns().at(-1).auth, 'apikey', 'the first turn used the key the app started with');

  const added = await call('/api/accounts/token', { token: 'sk-ant-oat01-' + 'x'.repeat(40) });
  assert.equal(added.active, 'token', JSON.stringify(added));

  const n = turns().length;
  await call(`/api/sessions/${sessionId}/send`, { text: 'second' });
  assert.ok(await until(async () => turns().length > n), 'the second turn reached the API');
  assert.equal(turns().at(-1).auth, 'bearer', 'the second turn used the token, not the resting process\'s old login');
});
