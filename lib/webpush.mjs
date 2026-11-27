// Web Push with node:crypto only: the aes128gcm message encryption of RFC 8291, the VAPID
// identity of RFC 8292, and the POST to the browser's push service. A push library would be
// two dependencies for sixty lines of HKDF and AES.

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(String(s), 'base64url');

// The browser's key is a raw uncompressed P-256 point; node wants a JWK to build a KeyObject from it.
const publicKeyOf = (raw) => crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: 'jwk' });
const privateKeyOf = (d, pub) => crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
const rawPublic = (keyObject) => { const j = keyObject.export({ format: 'jwk' }); return Buffer.concat([Buffer.from([4]), unb64u(j.x), unb64u(j.y)]); };

/** A fresh VAPID identity: { publicKey, privateKey }, both base64url (the public one is 65 raw bytes, as the browser's subscribe() wants it). */
export function generateVapid() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { publicKey: b64u(rawPublic(publicKey)), privateKey: b64u(unb64u(privateKey.export({ format: 'jwk' }).d)) };
}

/** The VAPID JWT (ES256) for one push service origin. `exp` is seconds; push services refuse more than 24 h. */
export function vapidJwt({ audience, subject, publicKey, privateKey, exp = Math.floor(Date.now() / 1000) + 12 * 3600 }) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: audience, exp, sub: subject }));
  // ieee-p1363 is the raw r||s that JWS wants; node's default is DER.
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: privateKeyOf(unb64u(privateKey), unb64u(publicKey)), dsaEncoding: 'ieee-p1363' });
  return head + '.' + body + '.' + b64u(sig);
}
export function verifyVapidJwt(jwt, publicKey) {
  const [h, b, s] = String(jwt).split('.');
  return crypto.verify('sha256', Buffer.from(h + '.' + b), { key: publicKeyOf(unb64u(publicKey)), dsaEncoding: 'ieee-p1363' }, unb64u(s));
}

/**
 * RFC 8291 section 3: the body of one push message for a subscription. `uaPublic` and `authSecret`
 * are what the browser's subscription holds (p256dh, auth). `salt` and `asKeys` exist so the
 * RFC's own test vector can be run; a real message draws both fresh.
 */
export function encrypt(payload, uaPublic, authSecret, { salt = crypto.randomBytes(16), asPrivate, asPublic } = {}) {
  let ecdh, asPub;
  if (asPrivate) { asPub = unb64u(asPublic); ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(unb64u(asPrivate)); }
  else { ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); asPub = ecdh.getPublicKey(); }
  const ua = Buffer.from(uaPublic), auth = Buffer.from(authSecret);
  const secret = ecdh.computeSecret(ua);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 closes the last (here the only) record.
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = asPub.length;
  return Buffer.concat([head, asPub, ct]);
}

/**
 * Send one notification. Resolves { ok, status, gone } - `gone` means the push service has
 * forgotten this subscription (404/410), so the caller should drop it.
 */
export function send(sub, payload, { vapid, subject, ttl = 3600, urgency = 'normal', timeout = 10000 }) {
  return new Promise((resolve) => {
    let url; try { url = new URL(sub.endpoint); } catch { return resolve({ ok: false, status: 0, gone: true }); }
    const body = encrypt(JSON.stringify(payload), unb64u(sub.keys.p256dh), unb64u(sub.keys.auth));
    const jwt = vapidJwt({ audience: url.origin, subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey });
    const mod = url.protocol === 'http:' ? http : https; // http only for the fake push service a test runs
    const req = mod.request(url, { method: 'POST', timeout, headers: { authorization: `vapid t=${jwt}, k=${vapid.publicKey}`, 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', 'content-length': body.length, ttl: String(ttl), urgency } }, (res) => {
      res.resume(); res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, gone: res.statusCode === 404 || res.statusCode === 410 }));
    });
    req.on('error', () => resolve({ ok: false, status: 0, gone: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, gone: false }); });
    req.end(body);
  });
}
