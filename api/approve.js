// 관리자 전용: 승인 / 구역 변경 / 사용 중지·해제 / 계정 목록
// 호출자는 Firebase ID 토큰(Bearer)으로 인증하고, 토큰의 role 클레임이 admin이어야 함
const { verifyIdToken, lookupByEmail, setAccount, listAccounts, ZONES, httpErr } = require('../lib/jisu-auth');

const SABUN_RE = /^[0-9A-Za-z]{2,20}$/;

async function approve(req, body) {
  const auth = String(req.headers.authorization || '');
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) throw httpErr(401, '로그인이 필요합니다');
  const caller = await verifyIdToken(m[1]);
  if (caller.role !== 'admin') throw httpErr(403, '관리자만 가능합니다');

  const action = String(body.action || '');
  if (action === 'list') {
    const users = await listAccounts();
    return { ok: true, zones: ZONES, users: users.map(u => ({
      sabun: (u.email || '').replace(/@jisu\.local$/, ''), name: u.displayName,
      role: u.claims.role || '', zone: u.claims.zone || '', approved: u.claims.approved === true, disabled: u.disabled
    })) };
  }

  const sabun = String(body.sabun || '').trim().toLowerCase();
  if (!SABUN_RE.test(sabun)) throw httpErr(400, '사번 형식이 올바르지 않습니다');
  const target = await lookupByEmail(sabun + '@jisu.local');
  if (!target) throw httpErr(404, '계정이 없습니다');
  if (target.claims.role === 'admin') throw httpErr(403, '관리자 계정은 이 화면에서 바꿀 수 없습니다');
  if (target.localId === caller.user_id) throw httpErr(403, '본인 계정은 바꿀 수 없습니다');

  const claims = Object.assign({ role: 'staff', zone: '', approved: false }, target.claims);
  const extra = {};
  if (action === 'approve') {
    if (!ZONES.includes(claims.zone)) throw httpErr(400, '구역이 지정되지 않았습니다. 먼저 구역을 변경하세요');
    claims.approved = true;
  } else if (action === 'move') {
    const zone = String(body.zone || '');
    if (!ZONES.includes(zone)) throw httpErr(400, '없는 구역입니다');
    claims.zone = zone;
  } else if (action === 'disable') {
    extra.disableUser = true;
  } else if (action === 'enable') {
    extra.disableUser = false;
  } else {
    throw httpErr(400, '알 수 없는 작업입니다');
  }
  // 권한을 줄이는 작업(구역 변경, 사용 중지)만 기존 로그인을 무효화한다.
  // 승인·사용 재개는 로그아웃 없이 다음 토큰 갱신(새로고침)부터 적용된다.
  if (action === 'move' || action === 'disable') extra.validSince = String(Math.floor(Date.now() / 1000));
  await setAccount(target.localId, claims, extra);
  return { ok: true, sabun, action };
}

const ALLOWED_ORIGIN = 'https://coarfamily-cyber.github.io';
function setCors(req, res) {
  const origin = req.headers && req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  try {
    return res.status(200).json(await approve(req, body || {}));
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: status === 500 ? '서버 오류' : e.message });
  }
};
module.exports.approve = approve;
