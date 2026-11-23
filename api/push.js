const webpush = require('web-push');
const { verifyIdToken, dbAccessToken } = require('../lib/jisu-auth');

// 구독 목록 읽기: 서비스 계정 토큰이 있으면 붙이고, 없거나 거부되면 기존처럼 인증 없이 다시 시도
async function readDb(url, tok) {
  if (tok) {
    const r = await fetch(url + '?access_token=' + encodeURIComponent(tok));
    if (r.ok) return (await r.json()) || {};
  }
  const r2 = await fetch(url);
  // 권한 오류(401/403)를 { ok:true, sent:0 } 으로 숨기지 않는다 — 구독 목록을 못 읽었으면 실패로 알린다
  if (!r2.ok) {
    throw new Error(`RTDB read failed (${r2.status})`);
  }
  return (await r2.json()) || {};
}

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
  /* 앞뒤 공백·줄바꿈·탭을 먼저 걷어낸다 — "https://.../JISU/?zone=inbound\n" 처럼 제어문자가 붙으면
     startsWith 가 빗나가 딥링크가 대시보드 첫 화면으로 조용히 바뀌었다. */
  const s = String(raw == null ? '' : raw).trim().replace(/[\r\n\t]/g, '');
  return s.startsWith(ALLOWED_URL_PREFIX) ? s.slice(0, 300) : DEFAULT_URL;
}

// 정적 서버 토큰 비교 (08시 스크립트 같은 서버 간 발송용) — 길이까지 같을 때만 상수 시간 비교
function sameToken(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (!x.length || x.length !== y.length) return false;
  try { return require('crypto').timingSafeEqual(x, y); } catch (_) { return false; }
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
  // A-9: 08시 스크립트는 Firebase ID 토큰이 아니라 JISU_PUSH_AUTH_TOKEN 을 Bearer 로 보낸다.
  //      인증을 켜는 순간 그 발송이 401 로 조용히 묻히지 않도록, 정적 토큰(설정된 경우)도 같이 받는다.
  if (String(process.env.PUSH_REQUIRE_AUTH || '') === '1') {
    const m = String((req.headers && req.headers.authorization) || '').match(/^Bearer (.+)$/);
    if (!m) return res.status(401).json({ ok: false, error: '로그인이 필요합니다' });
    const staticTok = String(process.env.JISU_PUSH_AUTH_TOKEN || '').trim();
    if (!(staticTok && sameToken(m[1], staticTok))) {
      let caller;
      try { caller = await verifyIdToken(m[1]); } catch (e) { return res.status(e.status || 401).json({ ok: false, error: '인증 실패' }); }
      if (!(caller.role === 'admin' || caller.approved === true)) return res.status(403).json({ ok: false, error: '승인된 사용자만 가능합니다' });
    }
  }
  // 클라이언트는 { target, payload:{title,body,url,tag,badge} } 형식으로 보낸다.
  // 구형 평면 형식({ target, title, body, ... })도 함께 받는다.
  const p = (body.payload && typeof body.payload === 'object') ? body.payload : body;
  // A-8: skipMaster=true 면 구역 발송에서 관리자(master) 기기를 빼다 — 08시 스크립트가 구역별로 보낼 때
  //      관리자 폰이 구역 수만큼 울리지 않게 한다(관리자 기기에는 요약 1건을 따로 보낸다). 기본값은 지금과 같다.
  const skipMaster = body.skipMaster === true || body.skip_master === true;

  const target = String(body.target || body.zone || p.target || '*').split(':')[0] || '*';
  const title = String(p.title || '지수 통합 관제 상황실').slice(0, 120);
  const message = String(p.body || '새 작업/공지가 등록되었습니다.').slice(0, 500);
  const url = safeUrl(p.url);
  const tag = String(p.tag || 'jisu-push').slice(0, 80);
  const badgeNum = Number(p.badge);
  const badge = Number.isFinite(badgeNum) && badgeNum > 0 ? Math.floor(badgeNum) : 1;   /* 문자열 "2" 도 2 로 (예전엔 1) */

  try {
    // 구독 목록은 항상 DB에서 직접 읽는다. 요청 본문의 subscriptions 는 무시한다.
    const tok = await dbAccessToken();
    const [allSubs, flatSubs] = await Promise.all([
      readDb(`${RTDB_SUBS}.json`, tok),
      readDb(`${RTDB_FLAT}.json`, tok)
    ]);
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

    if (target === '*' || target === 'all') {
      Object.keys(allSubs).forEach(addBucket);
    } else if (skipMaster) {
      addBucket(target);                       /* 그 구역 기기에만 */
    } else {
      addBucket(target);
      addBucket('master');
    }

    for (const [subId, entry] of Object.entries(flatSubs)) {
      if (!entry || typeof entry !== 'object') continue;
      const sub = entry.sub ? entry.sub : entry;
      const ez = String(entry.zone || '*').split(':')[0] || '*';
      if (!sub || !sub.endpoint || seenEndpoints.has(sub.endpoint)) continue;
      /* 대상 선택
         · '*'/'all' : 모두(전체 공지)
         · 'master'  : 관리자 기기만 — 예전에는 이 경우 평면 구독 전부에 보내져 작업자 폰까지 받았다.
                       이제 구역이 '*' 또는 'master'(= 관리자 전체 화면으로 구독된 기기)인 구독만 받는다.
         · 구역명    : 그 구역 + 관리자 */
      const match = (target === '*' || target === 'all')
        ? true
        : (target === 'master'
            ? (ez === '*' || ez === 'master')
            : (ez === '*' || ez === 'master' || ez === target));
      /* skipMaster: 구역 발송에서 관리자(전체/미지정 구독) 기기를 빼다 (A-8) */
      if (skipMaster && target !== '*' && target !== 'all' && target !== 'master' && (ez === '*' || ez === 'master')) continue;
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
      const q = tok ? '?access_token=' + encodeURIComponent(tok) : '';
      await Promise.all(stale.map(u => fetch(u + q, { method: 'DELETE' }).catch(() => {})));
    }

    return res.status(200).json({ ok: true, sent, failed, total: targets.length, cleaned: stale.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'Push failed' });
  }
};

/* 점검용: 알림 클릭 주소 정규화 함수 노출 (동작에는 영향 없음) */
module.exports.safeUrl = safeUrl;
