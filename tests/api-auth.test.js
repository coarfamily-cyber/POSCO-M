// 실행: node --test tests/api-auth.test.js   (외부 패키지 없이 Node 내장 test/assert 사용, 네트워크 호출 없음)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const KID = 'test-kid';
const PROJECT = 'posco-m-jisu';
process.env.FIREBASE_PROJECT_ID = PROJECT;
process.env.ENROLL_SECRET = 'test-enroll-secret-123';
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'svc@x.iam', private_key: pair.privateKey });

const lib = require('../lib/jisu-auth');
const enrollMod = require('../api/enroll');
const approveMod = require('../api/approve');

// ---- 가짜 Google / Identity Toolkit 서버 ----
let users; let calls;
function reset() {
  users = new Map(); calls = [];
  lib.resetCache();
}
function jsonRes(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'max-age=3600' }, headers) });
}
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url, init });
  if (url.includes('securetoken@system')) return jsonRes({ [KID]: pair.publicKey });
  if (url === 'https://oauth2.googleapis.com/token') return jsonRes({ access_token: 'svc-token', expires_in: 3600 });
  if (url.endsWith('/accounts:batchGet?maxResults=1000')) {
    return jsonRes({ users: [...users.values()].map(u => ({ localId: u.localId, email: u.email, displayName: u.displayName, disabled: !!u.disabled, customAttributes: JSON.stringify(u.claims) })) });
  }
  if (url.endsWith('/accounts')) {
    const b = JSON.parse(init.body);
    if ([...users.values()].some(u => u.email === b.email)) return jsonRes({ error: { message: 'EMAIL_EXISTS' } }, 400);
    const localId = 'uid' + (users.size + 1);
    users.set(localId, { localId, email: b.email, displayName: b.displayName, claims: {}, disabled: false });
    return jsonRes({ localId });
  }
  if (url.endsWith('/accounts:lookup')) {
    const b = JSON.parse(init.body);
    const u = [...users.values()].find(x => x.email === b.email[0]);
    return jsonRes({ users: u ? [{ localId: u.localId, customAttributes: JSON.stringify(u.claims), disabled: u.disabled, displayName: u.displayName }] : [] });
  }
  if (url.endsWith('/accounts:update')) {
    const b = JSON.parse(init.body);
    const u = users.get(b.localId);
    if (!u) return jsonRes({ error: { message: 'USER_NOT_FOUND' } }, 400);
    if (b.customAttributes !== undefined) u.claims = JSON.parse(b.customAttributes);
    if (b.disableUser !== undefined) u.disabled = b.disableUser;
    return jsonRes({ localId: u.localId });
  }
  return new Response('not mocked', { status: 599 });
};

// 테스트용 ID 토큰 발급 (실제 Firebase 형식과 동일한 RS256 JWT)
function idToken(claims, { aud = PROJECT, iss = 'https://securetoken.google.com/' + PROJECT, exp, key = pair.privateKey, kid = KID } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const p = b64(Object.assign({ aud, iss, sub: claims.user_id || 'u', user_id: claims.user_id || 'u', iat: now, exp: exp || now + 3600 }, claims));
  const sig = crypto.createSign('RSA-SHA256').update(h + '.' + p).sign(key).toString('base64url');
  return h + '.' + p + '.' + sig;
}
function mockRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {}, end() { return this; } };
}
async function call(handler, { method = 'POST', body = {}, headers = {} } = {}) {
  const res = mockRes();
  await handler({ method, body, headers }, res);
  return res;
}

// ---- QR ----
test('QR: 정상 토큰은 구역을 돌려주고, 위조/다른 비밀값/없는 구역은 거부', () => {
  const t = lib.makeQr('outbound', 'k1');
  assert.equal(lib.verifyQr(t, 'k1'), 'outbound');
  assert.equal(lib.verifyQr(t, 'other'), null);
  assert.equal(lib.verifyQr(t.slice(0, -2) + 'AA', 'k1'), null);
  assert.equal(lib.verifyQr(lib.makeQr('no-such-zone', 'k1'), 'k1'), null);
  assert.equal(lib.verifyQr(lib.makeQr('warehouse', 'k1'), 'k1'), null);
  assert.equal(lib.verifyQr('garbage', 'k1'), null);
});

// ---- ID 토큰 ----
test('ID 토큰: 정상 토큰 통과, 서명/대상/만료 오류 거부', async () => {
  reset();
  const ok = await lib.verifyIdToken(idToken({ role: 'staff' }));
  assert.equal(ok.role, 'staff');
  await assert.rejects(lib.verifyIdToken(idToken({}, { aud: 'other-project' })), e => e.status === 401);
  await assert.rejects(lib.verifyIdToken(idToken({}, { exp: 1000 })), e => e.status === 401);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  await assert.rejects(lib.verifyIdToken(idToken({}, { key: other.privateKey })), e => e.status === 401);
});

// ---- 가입 ----
test('가입: 잘못된 QR은 403, 계정을 만들지 않음', async () => {
  reset();
  const r = await call(enrollMod, { body: { qr: 'bad', sabun: '1001', name: '홍길동', password: '123456' } });
  assert.equal(r.statusCode, 403);
  assert.equal(users.size, 0);
});

test('가입: 정상 QR이면 승인 대기 계정이 구역과 함께 생성', async () => {
  reset();
  const qr = lib.makeQr('packaging', process.env.ENROLL_SECRET);
  const r = await call(enrollMod, { body: { qr, sabun: '1001', name: '홍길동', password: '123456' } });
  assert.equal(r.statusCode, 201);
  assert.equal(r.body.status, 'pending');
  const u = [...users.values()][0];
  assert.equal(u.email, '1001@jisu.local');
  assert.deepEqual(u.claims, { role: 'staff', zone: 'packaging', approved: false });
});

test('가입: 같은 사번 중복은 409, 형식/비밀번호 오류는 400', async () => {
  reset();
  const qr = lib.makeQr('pitch', process.env.ENROLL_SECRET);
  const base = { qr, sabun: '2002', name: '김철수', password: '123456' };
  assert.equal((await call(enrollMod, { body: base })).statusCode, 201);
  assert.equal((await call(enrollMod, { body: base })).statusCode, 409);
  assert.equal((await call(enrollMod, { body: Object.assign({}, base, { sabun: 'a-b' }) })).statusCode, 400);
  assert.equal((await call(enrollMod, { body: Object.assign({}, base, { sabun: '3003', password: '123' }) })).statusCode, 400);
  assert.equal((await call(enrollMod, { body: Object.assign({}, base, { sabun: '3004', name: '' }) })).statusCode, 400);
});

// ---- 관리자 승인 ----
function seed(sabun, claims) {
  const localId = 'uid-' + sabun;
  users.set(localId, { localId, email: sabun + '@jisu.local', displayName: sabun, claims, disabled: false });
  return localId;
}
const admin = { user_id: 'admin-uid', role: 'admin' };
const adminAuth = { authorization: 'Bearer ' + idToken(admin) };

test('승인: 토큰 없음 401, 사원 토큰 403', async () => {
  reset(); seed('1001', { role: 'staff', zone: 'packaging', approved: false });
  assert.equal((await call(approveMod, { body: { action: 'approve', sabun: '1001' } })).statusCode, 401);
  const staff = { authorization: 'Bearer ' + idToken({ user_id: 's1', role: 'staff', zone: 'packaging', approved: true }) };
  assert.equal((await call(approveMod, { body: { action: 'approve', sabun: '1001' }, headers: staff })).statusCode, 403);
});

test('승인: 관리자가 승인하면 approved=true, 구역은 유지', async () => {
  reset(); seed('1001', { role: 'staff', zone: 'packaging', approved: false });
  const r = await call(approveMod, { body: { action: 'approve', sabun: '1001' }, headers: adminAuth });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(users.get('uid-1001').claims, { role: 'staff', zone: 'packaging', approved: true });
});

test('구역 변경: 없는 구역은 400, 있는 구역은 반영', async () => {
  reset(); seed('1001', { role: 'staff', zone: 'packaging', approved: true });
  assert.equal((await call(approveMod, { body: { action: 'move', sabun: '1001', zone: 'nope' }, headers: adminAuth })).statusCode, 400);
  assert.equal((await call(approveMod, { body: { action: 'move', sabun: '1001', zone: 'pitch' }, headers: adminAuth })).statusCode, 200);
  assert.equal(users.get('uid-1001').claims.zone, 'pitch');
});

test('사용 중지/해제와 로그인 토큰 무효화(validSince)', async () => {
  reset(); seed('1001', { role: 'staff', zone: 'pitch', approved: true });
  await call(approveMod, { body: { action: 'disable', sabun: '1001' }, headers: adminAuth });
  assert.equal(users.get('uid-1001').disabled, true);
  const upd = calls.filter(c => c.url.endsWith('/accounts:update')).pop();
  assert.ok(JSON.parse(upd.init.body).validSince);
  await call(approveMod, { body: { action: 'enable', sabun: '1001' }, headers: adminAuth });
  assert.equal(users.get('uid-1001').disabled, false);
});

test('보호: 관리자 계정과 본인 계정은 변경 불가, 없는 사번은 404', async () => {
  reset(); seed('admin1', { role: 'admin' }); seed('1001', { role: 'staff', zone: 'pitch', approved: false });
  assert.equal((await call(approveMod, { body: { action: 'disable', sabun: 'admin1' }, headers: adminAuth })).statusCode, 403);
  users.get('uid-1001').localId = 'admin-uid';
  assert.equal((await call(approveMod, { body: { action: 'approve', sabun: '1001' }, headers: adminAuth })).statusCode, 403);
  assert.equal((await call(approveMod, { body: { action: 'approve', sabun: '9999' }, headers: adminAuth })).statusCode, 404);
});

test('목록: 관리자만 사번/구역/승인 상태를 받음', async () => {
  reset(); seed('1001', { role: 'staff', zone: 'pitch', approved: false });
  const r = await call(approveMod, { body: { action: 'list' }, headers: adminAuth });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.zones, lib.ZONES);
  assert.deepEqual(r.body.users[0], { sabun: '1001', name: '1001', role: 'staff', zone: 'pitch', approved: false, disabled: false });
});

test('QR 주소 생성 스크립트 출력값은 서버가 검증 가능', async () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['scripts/make-qr.js'], { env: Object.assign({}, process.env, { ENROLL_SECRET: 'test-enroll-secret-123' }) }).toString();
  const line = out.split('\n').find(l => l.startsWith('outbound\t'));
  const token = line.split('?qr=')[1];
  assert.equal(lib.verifyQr(token, 'test-enroll-secret-123'), 'outbound');
});
