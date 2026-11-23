// 실행: node tests/push-payload.test.js
// api/push.js 의 알림 본문 정규화(safeUrl · badge) 회귀 테스트.
// web-push 를 가짜로 바꾸고 fetch 도 가짜라서 실제 알림·운영 DB 로 나가지 않는다.
const assert = require('assert/strict');
const path = require('path');
const Module = require('module');

const sent = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'web-push') {
    return { setVapidDetails() {}, sendNotification: async (sub, payload) => { sent.push(JSON.parse(payload)); } };
  }
  return origLoad.apply(this, arguments);
};

process.env.VAPID_PUBLIC_KEY = 'test-public';
process.env.VAPID_PRIVATE_KEY = 'test-private';

const SUBS = {
  outbound: { s1: { sub: { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } } } },
  master: { s9: { sub: { endpoint: 'https://push.example/9', keys: { p256dh: 'a', auth: 'b' } } } },
};
global.fetch = async (url) => {
  if (String(url).includes('/pushSubs')) return { ok: true, json: async () => SUBS };
  return { ok: true, json: async () => ({}) };
};

const handler = require(path.join(__dirname, '..', 'api', 'push.js'));

function res() {
  const r = {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
  };
  return r;
}

const results = [];
function ok(name, fn) {
  try { fn(); results.push('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ' :: ' + (e && e.message || e)); }
}

(async () => {
  ok('safeUrl: 앞뒤 공백·줄바꿈·탭을 걷어낸다', () => {
    const u = 'https://coarfamily-cyber.github.io/POSCO-M/JISU/?zone=inbound';
    assert.equal(handler.safeUrl('  ' + u + '\n\t '), u);
  });
  ok('safeUrl: 저장소 밖 주소는 대시보드로 대체', () => {
    assert.equal(handler.safeUrl('https://evil.example/x'), 'https://coarfamily-cyber.github.io/POSCO-M/JISU/');
    assert.equal(handler.safeUrl(null), 'https://coarfamily-cyber.github.io/POSCO-M/JISU/');
  });

  sent.length = 0;
  const r1 = res();
  await handler({
    method: 'POST',
    headers: { origin: 'https://coarfamily-cyber.github.io' },
    body: {
      target: 'outbound',
      payload: {
        title: '출고 · 새 작업지시',
        body: '출고 33 TON',
        url: '  https://coarfamily-cyber.github.io/POSCO-M/JISU/?zone=outbound\n',
        tag: 'jisu-x',
        badge: '2',
      },
    },
  }, r1);
  ok('알림 발송 성공(가짜 web-push)', () => assert.equal(r1.statusCode, 200));
  ok('알림 클릭 주소 = 줄바꿈·공백 없는 딥링크', () => {
    assert.ok(sent.length >= 1, '발송 ' + sent.length);
    assert.equal(sent[0].url, 'https://coarfamily-cyber.github.io/POSCO-M/JISU/?zone=outbound');
  });
  ok('문자열 badge "2" → 숫자 2', () => assert.equal(sent[0].badge, 2));

  sent.length = 0;
  const r2 = res();
  await handler({ method: 'POST', headers: {}, body: { target: 'outbound', payload: { title: 't', body: 'b', badge: 'x' } } }, r2);
  ok('숫자가 아닌 badge 는 1 로 방어', () => assert.equal(sent[0].badge, 1));
  ok('badge 0 이하는 1', () => assert.equal(sent[0].badge, 1));

  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL'));
  console.log('\n' + (failed.length ? 'FAILED ' + failed.length + ' / ' : '') + 'TOTAL ' + results.length + ' checks, PASS ' + (results.length - failed.length));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
