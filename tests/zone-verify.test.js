// 실행: node --test tests/zone-verify.test.js  (ZONE-VERIFY 블록만 꺼내, 가짜 db로 점검 결과 확인. 쓰기 없음)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'JISU', 'index.html'), 'utf8');
const b = html.indexOf('/* ZONE-VERIFY-BEGIN'), e = html.indexOf('/* ZONE-VERIFY-END */');
assert.ok(b > 0 && e > b, 'verify markers not found');
const block = html.slice(b, e + '/* ZONE-VERIFY-END */'.length);

function env(stateArr, zones, notices, writes) {
  const snap = v => ({ val: () => v });
  const db = { ref(p) { return { once() {
    if (p === 'jisu/state/jisu-commands-v1') return Promise.resolve(snap({ v: JSON.stringify(stateArr), t: 1 }));
    if (p === 'jisu/zones') return Promise.resolve(snap(zones));
    if (p === 'jisu/notices') return Promise.resolve(snap(notices));
    return Promise.resolve(snap(null));
  }, update() { writes.push(p); return Promise.resolve(); }, set() { writes.push(p); return Promise.resolve(); } }; } };
  const win = {};
  const fn = new Function('db', 'ROOT', 'window', 'console', block + '\nreturn { compareZoneCopy, win: window };');
  const m = fn(db, 'jisu', win, { info() {}, warn() {} });
  return { m, win };
}

test('복사본이 원본과 같으면 same=true', async () => {
  const writes = [];
  const st = [{ id: 'a1', target: 'outbound', text: 'A' }, { id: 'p1', target: 'pitch', text: 'P' }];
  const zones = { outbound: { commands: { a1: { id: 'a1', target: 'outbound', text: 'A' } } }, pitch: { commands: { p1: { id: 'p1', target: 'pitch', text: 'P' } } } };
  const { win } = env(st, zones, null, writes);
  const r = await win.jisuVerifyZoneCopy();
  assert.equal(r.same, true);
  assert.equal(r.originalCount, 2);
  assert.equal(r.copyCount, 2);
  assert.equal(writes.length, 0, '점검은 쓰기를 하지 않는다');
});

test('복사본에서 빠진 항목, 내용이 다른 항목, 남는 항목을 구분한다', async () => {
  const writes = [];
  const st = [{ id: 'a1', text: 'A' }, { id: 'b2', text: 'B' }, { id: 'c3', text: 'C' }];
  const zones = { outbound: { commands: { a1: { id: 'a1', text: 'A-changed' }, z9: { id: 'z9', text: 'extra' } } } };
  const { win } = env(st, zones, null, writes);
  const r = await win.jisuVerifyZoneCopy();
  assert.equal(r.same, false);
  assert.deepEqual(r.missing.sort(), ['b2', 'c3']);
  assert.deepEqual(r.changed, ['a1']);
  assert.deepEqual(r.extra, ['z9']);
});

test('공지는 복사본의 notices 경로에서 비교한다', async () => {
  const writes = [];
  const st = [{ id: 'n1', target: '*', kind: 'notice', text: '공지' }];
  const { win } = env(st, {}, { n1: { id: 'n1', target: '*', kind: 'notice', text: '공지' } }, writes);
  const r = await win.jisuVerifyZoneCopy();
  assert.equal(r.same, true);
});
