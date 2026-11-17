const webpush = require('web-push');

const RTDB = 'https://posco-m-jisu-default-rtdb.asia-southeast1.firebasedatabase.app/jisu/pushSubs';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  setCors(res);
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

  const target = String(body.target || '*').split(':')[0] || '*';
  const title = String(body.title || '지수 통합 관제 상황실').slice(0, 120);
  const message = String(body.body || '새 작업/공지가 등록되었습니다.').slice(0, 500);
  const url = String(body.url || 'https://coarfamily-cyber.github.io/POSCO-M/JISU/');
  const tag = String(body.tag || 'jisu-push');
  const badge = typeof body.badge === 'number' ? body.badge : 1;

  try {
    const r = await fetch(`${RTDB}.json`);
    const allSubs = (await r.json()) || {};
    const targets = [];
    const seenEndpoints = new Set();

    const addBucket = (zoneKey) => {
      const bucket = allSubs[zoneKey];
      if (!bucket || typeof bucket !== 'object') return;
      for (const [subId, entry] of Object.entries(bucket)) {
        const sub = entry && entry.sub ? entry.sub : entry;
        if (!sub || !sub.endpoint || seenEndpoints.has(sub.endpoint)) continue;
        seenEndpoints.add(sub.endpoint);
        targets.push({ zoneKey, subId, sub });
      }
    };

    if (target === '*') {
      Object.keys(allSubs).forEach(addBucket);
    } else {
      addBucket(target);
      addBucket('master');
    }

    const payload = JSON.stringify({ title, body: message, url, tag, badge });
    let sent = 0;
    let failed = 0;
    const stale = [];

    await Promise.all(targets.map(async ({ zoneKey, subId, sub }) => {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 86400, urgency: 'high' });
        sent++;
      } catch (err) {
        failed++;
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          stale.push(`${RTDB}/${encodeURIComponent(zoneKey)}/${encodeURIComponent(subId)}.json`);
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
