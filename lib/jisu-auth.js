/* 지수 대시보드 계정 서버 공용 모듈 (3단계)
   · 무료 플랜만 사용: Vercel 서버리스 + Firebase Auth REST (Admin 용 서비스 계정 키는 Vercel 환경변수에만 둠)
   · 환경변수
     - FIREBASE_PROJECT_ID          (기본 posco-m-jisu)
     - FIREBASE_SERVICE_ACCOUNT_JSON (서비스 계정 키 JSON 전체, 저장소에 올리지 않음)
     - ENROLL_SECRET                 (구역 QR 서명용 비밀값, 저장소에 올리지 않음)
   · 서버만 계정을 만들 수 있도록, Firebase 콘솔에서 "사용자 가입(공개 가입)"을 꺼 둬야 합니다. */
const crypto = require('crypto');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'posco-m-jisu';
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const ID_ISS = 'https://securetoken.google.com/' + PROJECT_ID;
const IDT = 'https://identitytoolkit.googleapis.com/v1/projects/' + PROJECT_ID;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// 구역 목록 (index.html 의 구역 키와 맞춤). 바뀌면 여기만 고칩니다.
// 대시보드 '대상 버튼'(#cmdTarget)과 같은 키. 대시보드 대상 목록이 바뀌면 여기도 맞춥니다.
// 창고(warehouse)와 1~4동 버튼은 작업 대상 버튼에 없어서 제외했습니다.
const ZONES = ['outbound', 'inbound', 'pitch', 'packaging', 'packaging-d', 'environment',
  'production-a', 'production-b', 'production-c', 'production-d', 'production-e', 'production-f', 'production-g', 'production-h'];

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function b64urlBuf(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function b64urlStr(s) { return b64urlBuf(Buffer.from(s, 'utf8')); }
function b64urlToBuf(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function jsonPart(s) { return JSON.parse(b64urlToBuf(s).toString('utf8')); }

/* ---------- 구역 QR 토큰: base64url(구역) . HMAC(비밀값, 구역) — 유효기간 없음, 비밀값을 바꾸면 전부 무효 ---------- */
function makeQr(zone, secret) {
  const z = b64urlStr(zone);
  const mac = b64urlBuf(crypto.createHmac('sha256', secret).update(zone).digest());
  return z + '.' + mac;
}
function verifyQr(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  let zone;
  try { zone = b64urlToBuf(parts[0]).toString('utf8'); } catch (_) { return null; }
  if (!ZONES.includes(zone)) return null;
  const expect = makeQr(zone, secret).split('.')[1];
  const a = Buffer.from(parts[1]), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return zone;
}

/* ---------- 구글 공개키로 ID 토큰 검증 (서비스 계정 불필요) ---------- */
let certCache = { at: 0, certs: null, maxAge: 0 };
function resetCache() { certCache = { at: 0, certs: null, maxAge: 0 }; svcCache = { token: null, exp: 0 }; }
async function getCerts(fetchImpl) {
  if (certCache.certs && Date.now() - certCache.at < certCache.maxAge) return certCache.certs;
  const r = await fetchImpl(CERTS_URL);
  if (!r.ok) throw httpErr(502, 'cert fetch failed');
  const certs = await r.json();
  const cc = (r.headers && r.headers.get && r.headers.get('cache-control')) || '';
  const m = cc.match(/max-age=(\d+)/);
  certCache = { at: Date.now(), certs, maxAge: m ? Number(m[1]) * 1000 : 3600000 };
  return certs;
}
async function verifyIdToken(idToken, opts) {
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const now = (opts && opts.now) || Date.now();
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw httpErr(401, 'bad token');
  let header, payload;
  try { header = jsonPart(parts[0]); payload = jsonPart(parts[1]); } catch (_) { throw httpErr(401, 'bad token'); }
  if (header.alg !== 'RS256' || !header.kid) throw httpErr(401, 'bad alg');
  const certs = await getCerts(fetchImpl);
  const pem = certs[header.kid];
  if (!pem) throw httpErr(401, 'unknown kid');
  const ok = crypto.createVerify('RSA-SHA256').update(parts[0] + '.' + parts[1]).verify(pem, b64urlToBuf(parts[2]));
  if (!ok) throw httpErr(401, 'bad signature');
  const t = Math.floor(now / 1000);
  if (payload.aud !== PROJECT_ID || payload.iss !== ID_ISS) throw httpErr(401, 'bad audience');
  if (!(payload.exp > t)) throw httpErr(401, 'expired');
  if (!(payload.iat <= t + 300)) throw httpErr(401, 'bad iat');
  if (!payload.sub) throw httpErr(401, 'no sub');
  return payload;
}

/* ---------- 서비스 계정으로 관리자 권한 호출 (Identity Toolkit Admin REST) ---------- */
let svcCache = { token: null, exp: 0 };
async function serviceToken(fetchImpl, now) {
  if (svcCache.token && now < svcCache.exp - 60000) return svcCache.token;
  let sa;
  try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || 'null'); } catch (_) { sa = null; }
  if (!sa || !sa.client_email || !sa.private_key) throw httpErr(500, 'service account not configured');
  const iat = Math.floor(now / 1000);
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlStr(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: TOKEN_URL, iat, exp: iat + 3600
  }));
  const sig = crypto.createSign('RSA-SHA256').update(header + '.' + claim).sign(sa.private_key);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: header + '.' + claim + '.' + b64urlBuf(sig)
  });
  const r = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw httpErr(500, 'token exchange failed');
  svcCache = { token: j.access_token, exp: now + (Number(j.expires_in) || 3600) * 1000 };
  return j.access_token;
}
async function idt(path, body, fetchImpl, now) {
  const tok = await serviceToken(fetchImpl, now);
  const r = await fetchImpl(IDT + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && j.error.message) || 'identity toolkit error';
    throw httpErr(msg.includes('EMAIL_EXISTS') ? 409 : 502, msg);
  }
  return j;
}
async function createUser({ email, password, displayName }, opts) {
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const now = (opts && opts.now) || Date.now();
  const j = await idt('/accounts', { email, password, displayName, emailVerified: true }, fetchImpl, now);
  return { localId: j.localId };
}
async function lookupByEmail(email, opts) {
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const now = (opts && opts.now) || Date.now();
  const j = await idt('/accounts:lookup', { email: [email] }, fetchImpl, now);
  const u = j.users && j.users[0];
  if (!u) return null;
  let claims = {};
  try { claims = JSON.parse(u.customAttributes || '{}') || {}; } catch (_) { claims = {}; }
  return { localId: u.localId, claims, disabled: !!u.disabled, displayName: u.displayName || '' };
}
async function setAccount(localId, claims, extra, opts) {
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const now = (opts && opts.now) || Date.now();
  const body = Object.assign({ localId, customAttributes: JSON.stringify(claims) }, extra || {});
  return idt('/accounts:update', body, fetchImpl, now);
}

async function listAccounts(opts) {
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const now = (opts && opts.now) || Date.now();
  const tok = await serviceToken(fetchImpl, now);
  const r = await fetchImpl(IDT + '/accounts:batchGet?maxResults=1000', { headers: { Authorization: 'Bearer ' + tok } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(502, (j.error && j.error.message) || 'list failed');
  return (j.users || []).map(u => {
    let claims = {};
    try { claims = JSON.parse(u.customAttributes || '{}') || {}; } catch (_) { claims = {}; }
    return { localId: u.localId, email: u.email || '', displayName: u.displayName || '', disabled: !!u.disabled, claims };
  });
}

module.exports = {
  ZONES, PROJECT_ID, httpErr, makeQr, verifyQr, verifyIdToken,
  createUser, lookupByEmail, setAccount, listAccounts, resetCache
};
