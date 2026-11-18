// 실행: node --test tests/push-auth.test.js  (web-push 와 네트워크를 가짜로 바꿔 api/push.js 인증 동작 확인)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

let sentCount = 0;
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'web-push') return { setVapidDetails() {}, async sendNotification() { sentCount++; } };
  return origLoad.call(this, req, ...rest);
};

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
process.env.FIREBASE_PROJECT_ID = 'posco-m-jisu';
process.env.VAPID_PUBLIC_KEY = 'pub';
process.env.VAPID_PRIVATE_KEY = 'priv';

globalThis.fetch = async (url) => {
  const json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' } });
  if (String(url).includes('securetoken@system')) return json({ k1: pair.publicKey });
  if (String(url).endsWith('/jisu/pushSubs.json')) return json({ pitch: { s1: { sub: { endpoint: 'https://push.example/1' } } } });
  if (String(url).endsWith('/jisu/push_subs.json')) return json({});
  return new Response('x', { status: 404 });
};

const handler = require('../api/push');
const lib = require('../lib/jisu-auth');

function token(claims) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = b64({ alg: 'RS256', kid: 'k1' });
  const p = b64(Object.assign({ aud: 'posco-m-jisu', iss: 'https://securetoken.google.com/posco-m-jisu', sub: 'u', iat: now, exp: now + 3600 }, claims));
  return h + '.' + p + '.' + crypto.createSign('RSA-SHA256').update(h + '.' + p).sign(pair.privateKey).toString('base64url');
}
async function call(headers) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {}, end() { return this; } };
  await handler({ method: 'POST', headers: headers || {}, body: { target: 'pitch', payload: { title: 't', body: 'b' } } }, res);
  return res;
}

test('기본(PUSH_REQUIRE_AUTH 없음): 지금처럼 토큰 없이 발송', async () => {
  delete process.env.PUSH_REQUIRE_AUTH; sentCount = 0; lib.resetCache();
  const r = await call();
  assert.equal(r.statusCode, 200);
  assert.equal(sentCount, 1);
});

test('PUSH_REQUIRE_AUTH=1: 토큰 없으면 401, 승인 전 사용자 403, 승인된 사용자·관리자는 발송', async () => {
  process.env.PUSH_REQUIRE_AUTH = '1'; lib.resetCache();
  sentCount = 0;
  assert.equal((await call()).statusCode, 401);
  assert.equal((await call({ authorization: 'Bearer ' + token({ role: 'staff', approved: false }) })).statusCode, 403);
  assert.equal((await call({ authorization: 'Bearer garbage' })).statusCode, 401);
  assert.equal(sentCount, 0);
  assert.equal((await call({ authorization: 'Bearer ' + token({ role: 'staff', zone: 'pitch', approved: true }) })).statusCode, 200);
  assert.equal((await call({ authorization: 'Bearer ' + token({ role: 'admin', approved: true }) })).statusCode, 200);
  assert.equal(sentCount, 2);
  delete process.env.PUSH_REQUIRE_AUTH;
});
