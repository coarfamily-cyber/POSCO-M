// 실행: node --test tests/zone-verify.test.js  (ZONE-MIRROR + ZONE-VERIFY 블록을 꺼내, 가짜 db로 점검 결과 확인. 쓰기 없음)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'JISU', 'index.html'), 'utf8');
function blockOf(name) {
  const b = html.indexOf('/* ' + name + '-BEGIN'), e = html.indexOf('/* ' + name + '-END */');
  assert.ok(b > 0 && e > b, name + ' markers not found');
  return html.slice(b, e + ('/* ' + name + '-END */').length);
}
const block = blockOf('ZONE-MIRROR') + '\n' + blockOf('ZONE-VERIFY');

// Firebase가 돌려주는 형태 흉내: 키 정렬, null·빈 값 제거
function fbRead(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'object') return v;
  const out = {}; let n = 0;
  Object.keys(v).sort().forEach(k => { const c = fbRead(v[k]); if (c !== undefined) { out[k] = c; n++; } });
  return n ? out : undefined;
}

function env(stateArr, zones, notices) {
  const writes = [];
  const snap = v => ({ val: () => (v === undefined ? null : v) });
  const db = { ref(p) { return {
    once() {
      if (p === 'jisu/state/jisu-commands-v1') return Promise.resolve(snap({ v: JSON.stringify(stateArr), t: 5 }));
      if (p === 'jisu/zones') return Promise.resolve(snap(fbRead(zones)));
      if (p === 'jisu/notices') return Promise.resolve(snap(fbRead(notices)));
      if (p === 'jisu/zonesRev') return Promise.resolve(snap(5));
      return Promise.resolve(snap(null));
    },
    update() { writes.push(p); return Promise.resolve(); }, set() { writes.push(p); return Promise.resolve(); }
  }; } };
  const revOf = d => (d && typeof d.t === 'number' ? d.t : 0);
  const fn = new Function('db', 'ROOT', 'window', 'console', 'revOf', 'lastRemote', 'baseRev', block + '\nreturn window;');
  const win = fn(db, 'jisu', {}, { info() {}, warn() {} }, revOf, {}, {});
  return { win, writes };
}

test('필드 순서가 바뀌고 null이 빠져도 같은 내용이면 same=true', async () => {
  const st = [{ id: 'a1', target: 'outbound', text: 'A', done: null, moves: [] }, { id: 'p1', target: 'pitch', text: 'P' }];
  const zones = { outbound: { commands: { a1: { text: 'A', target: 'outbound', id: 'a1' } } }, pitch: { commands: { p1: { target: 'pitch', id: 'p1', text: 'P' } } } };
  const { win, writes } = env(st, zones, null);
  const r = await win.jisuVerifyZoneCopy();
  assert.equal(r.same, true, JSON.stringify(r));
  assert.equal(r.copyRev, 5); assert.equal(r.stateRev, 5);
  assert.equal(writes.length, 0, '점검은 쓰기를 하지 않는다');
});

test('빠진 항목, 내용이 다른 항목, 남는 항목을 구분한다', async () => {
  const st = [{ id: 'a1', text: 'A' }, { id: 'b2', text: 'B' }, { id: 'c3', text: 'C' }];
  const zones = { outbound: { commands: { a1: { id: 'a1', text: 'A-changed' }, z9: { id: 'z9', text: 'extra' } } } };
  const { win } = env(st, zones, null);
  const r = await win.jisuVerifyZoneCopy();
  assert.equal(r.same, false);
  assert.deepEqual(r.missing.sort(), ['b2', 'c3']);
  assert.deepEqual(r.changed, ['a1']);
  assert.deepEqual(r.extra, ['z9']);
});

test('공지는 notices, 1~4동은 _admin 칸에서 찾는다', async () => {
  const st = [{ id: 'n1', target: '*', kind: 'notice', text: '공지' }, { id: 'd1', target: '1', text: '1동' }];
  const { win } = env(st, { _admin: { commands: { d1: { id: 'd1', target: '1', text: '1동' } } } }, { n1: { id: 'n1', target: '*', kind: 'notice', text: '공지' } });
  const r = await win.jisuVerifyZoneCopy();
  assert.equal(r.same, true, JSON.stringify(r));
});

test('복사할 수 없는 형식의 id는 빠짐이 아니라 skipped로 보고', async () => {
  const st = [{ id: 'bad.id', target: 'pitch', text: 'x' }];
  const { win } = env(st, {}, null);
  const r = await win.jisuVerifyZoneCopy();
  assert.equal(r.same, true);
  assert.deepEqual(r.skipped, ['bad.id']);
});
