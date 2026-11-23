// 실행: node --test tests/push-auth.test.js  (web-push 와 네트워크를 가짜로 바꿔 api/push.js 인증 동작 확인)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

let sentCount = 0;
const sentEndpoints = [];
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'web-push') return { setVapidDetails() {}, async sendNotification(sub) { sentCount++; if (sub && sub.endpoint) sentEndpoints.push(sub.endpoint); } };
  return origLoad.call(this, req, ...rest);
};

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
process.env.FIREBASE_PROJECT_ID = 'posco-m-jisu';
process.env.VAPID_PUBLIC_KEY = 'pub';
process.env.VAPID_PRIVATE_KEY = 'priv';

const calls = [];
let rtdbRejectsToken = false, tokenEndpointFails = false;
let SUBS = { pitch: { s1: { sub: { endpoint: 'https://push.example/1' } } } };
let FLAT = {};
globalThis.fetch = async (url, init) => {
  url = String(url); calls.push(url);
  const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' } });
  if (url.includes('securetoken@system')) return json({ k1: pair.publicKey });
  if (url === 'https://oauth2.googleapis.com/token') return tokenEndpointFails ? json({ error: 'x' }, 400) : json({ access_token: 'sa-token', expires_in: 3600 });
  const [path, q] = url.split('?');
  if (q && q.includes('access_token') && rtdbRejectsToken) return json({ error: 'Permission denied' }, 401);
  if (path.endsWith('/jisu/pushSubs.json')) return json(SUBS);
  if (path.endsWith('/jisu/push_subs.json')) return json(FLAT);
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
async function call(headers, body) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {}, end() { return this; } };
  await handler({ method: 'POST', headers: headers || {}, body: body || { target: 'pitch', payload: { title: 't', body: 'b' } } }, res);
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

test('PUSH_REQUIRE_AUTH=1 + JISU_PUSH_AUTH_TOKEN: 08시 스크립트의 정적 토큰도 통과 (A-9)', async () => {
  process.env.PUSH_REQUIRE_AUTH = '1';
  process.env.JISU_PUSH_AUTH_TOKEN = 'jisu-cron-token';
  lib.resetCache(); sentCount = 0;
  assert.equal((await call({ authorization: 'Bearer jisu-cron-token' })).statusCode, 200, '정적 토큰 통과');
  assert.equal((await call({ authorization: 'Bearer jisu-cron-tokeX' })).statusCode, 401, '길이 같은 틀린 토큰 거부');
  assert.equal((await call({ authorization: 'Bearer wrong' })).statusCode, 401, '다른 토큰 거부');
  assert.equal(sentCount, 1);
  delete process.env.JISU_PUSH_AUTH_TOKEN;
  delete process.env.PUSH_REQUIRE_AUTH;
});

test('skipMaster: 구역 발송에서 관리자 기기를 빼다 (A-8)', async () => {
  delete process.env.PUSH_REQUIRE_AUTH; lib.resetCache();
  SUBS = { pitch: { s1: { sub: { endpoint: 'https://push.example/pitch' } } },
           master: { s2: { sub: { endpoint: 'https://push.example/master' } } } };
  FLAT = { f1: { sub: { endpoint: 'https://push.example/flat-all' }, zone: '*' },
           f2: { sub: { endpoint: 'https://push.example/flat-pitch' }, zone: 'pitch' } };
  sentCount = 0; sentEndpoints.length = 0;
  let r = await call({}, { target: 'pitch', payload: { title: 't', body: 'b' } });
  assert.equal(r.statusCode, 200);
  assert.equal(sentCount, 4, '기본: 구역 + 관리자 + 평면(*) + 평면(구역)');
  assert.ok(sentEndpoints.includes('https://push.example/master'));

  sentCount = 0; sentEndpoints.length = 0;
  r = await call({}, { target: 'pitch', skipMaster: true, payload: { title: 't', body: 'b' } });
  assert.equal(r.statusCode, 200);
  assert.equal(sentCount, 2, 'skipMaster: 구역 기기만');
  assert.ok(!sentEndpoints.includes('https://push.example/master'), '관리자 버킷 제외');
  assert.ok(!sentEndpoints.includes('https://push.example/flat-all'), 'zone=* 구독 제외');
  assert.ok(sentEndpoints.includes('https://push.example/pitch'));

  sentCount = 0; sentEndpoints.length = 0;
  await call({}, { target: 'master', skipMaster: true, payload: { title: 't', body: 'b' } });
  assert.ok(sentEndpoints.includes('https://push.example/master'), 'master 대상은 유지');
  assert.ok(sentEndpoints.includes('https://push.example/flat-all'));
  assert.ok(!sentEndpoints.includes('https://push.example/flat-pitch'), '구역 기기에는 안 보냄');

  sentCount = 0; sentEndpoints.length = 0;
  await call({}, { target: 'all', skipMaster: true, payload: { title: 't', body: 'b' } });
  assert.equal(sentCount, 4, '전체 공지(all) = 모든 버킷 + 평면 구독 (기기별 1번)');
  assert.ok(sentEndpoints.includes('https://push.example/pitch'));
  assert.ok(sentEndpoints.includes('https://push.example/master'));
  SUBS = { pitch: { s1: { sub: { endpoint: 'https://push.example/1' } } } }; FLAT = {};
});

test('서비스 계정 설정 시 구독 목록을 토큰으로 읽음', async () => {
  SUBS = { pitch: { s1: { sub: { endpoint: 'https://push.example/1' } } } }; FLAT = {};
  delete process.env.PUSH_REQUIRE_AUTH; lib.resetCache(); calls.length = 0; sentCount = 0;
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'svc@x.iam', private_key: pair.privateKey });
  const r = await call();
  assert.equal(r.statusCode, 200); assert.equal(sentCount, 1);
  assert.ok(calls.some(u => u.includes('/jisu/pushSubs.json?access_token=sa-token')));
  assert.ok(!calls.some(u => u.endsWith('/jisu/pushSubs.json')), '토큰으로 성공하면 인증 없이 다시 읽지 않음');
});

test('DB가 토큰을 거부하거나 토큰 발급이 실패하면 기존처럼 인증 없이 읽음', async () => {
  SUBS = { pitch: { s1: { sub: { endpoint: 'https://push.example/1' } } } }; FLAT = {};
  lib.resetCache(); calls.length = 0; sentCount = 0; rtdbRejectsToken = true;
  assert.equal((await call()).statusCode, 200); assert.equal(sentCount, 1);
  assert.ok(calls.some(u => u.endsWith('/jisu/pushSubs.json')));
  rtdbRejectsToken = false; tokenEndpointFails = true; lib.resetCache(); calls.length = 0; sentCount = 0;
  assert.equal((await call()).statusCode, 200); assert.equal(sentCount, 1);
  assert.ok(!calls.some(u => u.includes('access_token')));
  tokenEndpointFails = false; delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON; lib.resetCache();
});
