import test from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, unb64u, b64u, generateVapid, vapidJwt, verifyVapidJwt } from '../lib/webpush.mjs';
import { parseNetstat, parseLsof, parseTree, descendants } from '../lib/ports.mjs';

// RFC 8291 appendix A: every input and the finished message.
test('web push encryption reproduces the RFC 8291 example byte for byte', () => {
  const out = encrypt('When I grow up, I want to be a watermelon', unb64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'), unb64u('BTBZMqHH6r4Tts7J_aSIgg'), {
    salt: unb64u('DGv6ra1nlYgDCS1FRnbzlw'),
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  });
  // Header (salt, record size, key) and ciphertext are base64url'd apart in the RFC: 86 bytes is not a multiple of 3.
  const header = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
  const cipher = '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ';
  assert.equal(out.toString('hex'), Buffer.concat([unb64u(header), unb64u(cipher)]).toString('hex'));
});

test('a fresh message decrypts with the subscription keys', async () => {
  const { createECDH, hkdfSync, createDecipheriv } = await import('node:crypto');
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  const body = encrypt('hello', ua.getPublicKey(), auth);
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  assert.equal(body.readUInt32BE(16), 4096);
  const ikm = Buffer.from(hkdfSync('sha256', ua.computeSecret(asPub), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
  const d = createDecipheriv('aes-128-gcm', Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain.toString(), 'hello\x02');
});

test('a VAPID key is a 65-byte point and its JWT is ES256 over the right claims', () => {
  const v = generateVapid();
  assert.equal(unb64u(v.publicKey).length, 65);
  assert.equal(unb64u(v.publicKey)[0], 4);
  const jwt = vapidJwt({ audience: 'https://push.example', subject: 'mailto:me@example.com', ...v, exp: 2000000000 });
  const [h, b, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(unb64u(h)), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(unb64u(b)), { aud: 'https://push.example', exp: 2000000000, sub: 'mailto:me@example.com' });
  assert.equal(unb64u(s).length, 64);
  assert.ok(verifyVapidJwt(jwt, v.publicKey));
  assert.ok(!verifyVapidJwt(jwt.slice(0, -2) + 'AA', v.publicKey));
  assert.ok(!verifyVapidJwt(jwt, generateVapid().publicKey));
});

test('netstat rows become port -> pid, listening only', () => {
  const m = parseNetstat(`
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1180
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242
  TCP    [::]:5173              [::]:0                 LISTENING       9999
  TCP    [::1]:3000             [::]:0                 LISTENING       777
  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     4242
`);
  assert.equal(m.get(135), 1180);
  assert.equal(m.get(5173), 4242);
  assert.equal(m.get(3000), 777);
  assert.equal(m.size, 3);
});

test('lsof field output becomes port -> pid', () => {
  const m = parseLsof('p4242\nn*:5173\nn[::]:5173\np88\nn127.0.0.1:8080\n');
  assert.equal(m.get(5173), 4242);
  assert.equal(m.get(8080), 88);
});

test('what a server started goes with it, leaves first', () => {
  const kids = parseTree('10 1\n11 10\n12 10\n13 11\n99 1\n');
  assert.deepEqual(descendants(kids, 10), [13, 11, 12, 10]);
  assert.deepEqual(descendants(kids, 99), [99]);
});
