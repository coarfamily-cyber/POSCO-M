const webpush = require('web-push');
const { verifyIdToken } = require('../lib/jisu-auth');

const RTDB_SUBS = 'https://posco-m-jisu-default-rtdb.asia-southeast1.firebasedatabase.app/jisu/pushSubs';
const RTDB_FLAT = 'https://posco-m-jisu-default-rtdb.asia-southeast1.firebasedatabase.app/jisu/push_subs';

const ALLOWED_ORIGIN = 'https://coarfamily-cyber.github.io';
const ALLOWED_URL_PREFIX = 'https://coarfamily-cyber.github.io/POSCO-M/';
const DEFAULT_URL = 'https://coarfamily-cyber.github.io/POSCO-M/JISU/';

function setCors(req, res) {
  const origin = req.headers && req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// 알림 클릭 시 열리는 주소는 이 저장소의 페이지로만 허용한다 (피싱 링크 차단)
function safeUrl(raw) {
  const s = String(raw || '');
  return s.startsWith(ALLOWED_URL_PREFIX) ? s.slice(0, 300) : DEFAULT_URL;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const pub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const priv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (!pub || !priv) {
    return res.status(500).json({ ok: false, error: 'Missing VAPID keys' });
  }
  webpush.setVapidDetails('mailto:coarfamily@gmail.com', pub, priv);

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body || {};

  // 5단계 준비: Vercel 환경변수 PUSH_REQUIRE_AUTH=1 이면 승인된 로그인 사용자만 발송 가능.
  // 설정하지 않으면 지금과 같이 동작한다 (로그인 게이트를 켜기 전에는 설정하지 말 것).
  if (String(process.env.PUSH_REQUIRE_AUTH || '') === '1') {
    const m = String((req.headers && req.headers.authorization) || '').match(/^Bearer (.+)$/);
    if (!m) return res.status(401).json({ ok: false, error: '로그인이 필요합니다' });
    let caller;
    try { caller = await verifyIdToken(m[1]); } catch (e) { return res.status(e.status || 401).json({ ok: false, error: '인증 실패' }); }
    if (!(caller.role === 'admin' || caller.approved === true)) return res.status(403).json({ ok: false, error: '승인된 사용자만 가능합니다' });
  }
  // 클라이언트는 { target, payload:{title,body,url,tag,badge} } 형식으로 보낸다.
  // 구형 평면 형식({ target, title, body, ... })도 함께 받는다.
  const p = (body.payload && typeof body.payload === 'object') ? body.payload : body;

  const target = String(body.target || body.zone || p.target || '*').split(':')[0] || '*';
  const title = String(p.title || '지수 통합 관제 상황실').slice(0, 120);
  const message = String(p.body || '새 작업/공지가 등록되었습니다.').slice(0, 500);
  const url = safeUrl(p.url);
  const tag = String(p.tag || 'jisu-push').slice(0, 80);
  const badge = typeof p.badge === 'number' ? p.badge : 1;

  try {
    // 구독 목록은 항상 DB에서 직접 읽는다. 요청 본문의 subscriptions 는 무시한다.
    const [r1, r2] = await Promise.all([
      fetch(`${RTDB_SUBS}.json`),
      fetch(`${RTDB_FLAT}.json`)
    ]);
    const allSubs = (await r1.json()) || {};
    const flatSubs = (await r2.json()) || {};
    const targets = [];
    const seenEndpoints = new Set();

    const addBucket = (zoneKey) => {
      const bucket = allSubs[zoneKey];
      if (!bucket || typeof bucket !== 'object') return;
      for (const [subId, entry] of Object.entries(bucket)) {
        const sub = entry && entry.sub ? entry.sub : entry;
        if (!sub || !sub.endpoint || seenEndpoints.has(sub.endpoint)) continue;
        seenEndpoints.add(sub.endpoint);
        targets.push({ delUrl: `${RTDB_SUBS}/${encodeURIComponent(zoneKey)}/${encodeURIComponent(subId)}.json`, sub });
      }
    };

    if (target === '*') {
      Object.keys(allSubs).forEach(addBucket);
    } else {
      addBucket(target);
      addBucket('master');
    }

    for (const [subId, entry] of Object.entries(flatSubs)) {
      if (!entry || typeof entry !== 'object') continue;
      const sub = entry.sub ? entry.sub : entry;
      const ez = String(entry.zone || '*').split(':')[0] || '*';
      if (!sub || !sub.endpoint || seenEndpoints.has(sub.endpoint)) continue;
      const match = target === '*' || target === 'master' || target === 'all' || ez === '*' || ez === 'master' || ez === target;
      if (!match) continue;
      seenEndpoints.add(sub.endpoint);
      targets.push({ delUrl: `${RTDB_FLAT}/${encodeURIComponent(subId)}.json`, sub });
    }

    const payload = JSON.stringify({ title, body: message, url, tag, badge });
    let sent = 0;
    let failed = 0;
    const stale = [];

    await Promise.all(targets.map(async ({ delUrl, sub }) => {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 86400, urgency: 'high' });
        sent++;
      } catch (err) {
        failed++;
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          stale.push(delUrl);
        }
      }
    }));

    if (stale.length) {
      await Promise.all(stale.map(u => fetch(u, { method: 'DELETE' }).catch(() => {})));
    }

    return res.status(200).json({ ok: true, sent, failed, total: targets.length, cleaned: stale.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'Push failed' });
  }
};
