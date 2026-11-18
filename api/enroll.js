// 작업자 가입: 구역 QR 토큰 + 사번/이름/비밀번호 → 계정 생성(승인 대기 상태)
const { verifyQr, createUser, setAccount, httpErr } = require('../lib/jisu-auth');

const SABUN_RE = /^[0-9A-Za-z]{2,20}$/;

async function enroll(body) {
  const secret = process.env.ENROLL_SECRET || '';
  if (!secret) throw httpErr(500, 'ENROLL_SECRET not set');
  const zone = verifyQr(body.qr, secret);
  if (!zone) throw httpErr(403, '유효하지 않은 구역 QR');

  const sabun = String(body.sabun || '').trim();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  if (!SABUN_RE.test(sabun)) throw httpErr(400, '사번은 영문/숫자 2~20자');
  if (!name || name.length > 20) throw httpErr(400, '이름은 1~20자');
  if (password.length < 6 || password.length > 128) throw httpErr(400, '비밀번호는 6자 이상');

  const email = sabun.toLowerCase() + '@jisu.local';
  const { localId } = await createUser({ email, password, displayName: name });
  // 가입 직후에는 승인 전: approved=false, 구역은 QR이 정한 값
  await setAccount(localId, { role: 'staff', zone, approved: false }, {});
  return { ok: true, status: 'pending' };
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
  body = body || {};
  try {
    const out = await enroll(body);
    return res.status(201).json(out);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: status === 500 ? '서버 오류' : e.message });
  }
};
module.exports.enroll = enroll;
