// 실행: node --test tests/zone-mirror.test.js  (index.html 의 ZONE-MIRROR 블록만 꺼내 가짜 db로 검증)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'JISU', 'index.html'), 'utf8');
const begin = html.indexOf('/* ZONE-MIRROR-BEGIN');
const end = html.indexOf('/* ZONE-MIRROR-END */');
assert.ok(begin > 0 && end > begin, 'mirror block markers not found');
const block = html.slice(begin, end + '/* ZONE-MIRROR-END */'.length);

function load(flag, updates, storedJson) {
  const db = { ref(p) { return { update(obj) { updates.push({ path: p, obj }); return Promise.resolve(); } }; } };
  const win = { JISU_ZONE_MIRROR: flag };
  const ROOT = 'jisu';
  const payloadOf = () => (storedJson === undefined ? null : storedJson);
  const fn = new Function('db', 'window', 'ROOT', 'payloadOf', block + '\nreturn { buildZoneMirror, mirrorZones, win: window };');
  return fn(db, win, ROOT, payloadOf);
}

const sample = JSON.stringify([
  { id: 'a1', target: 'outbound', kind: 'instruction', text: 'A' },
  { id: 'a2', target: 'outbound:2', kind: 'instruction', text: 'B' },
  { id: 'p1', target: 'pitch', kind: 'instruction', text: 'C' },
  { id: 'n1', target: '*', kind: 'notice', text: '공지' },
  { id: 'bad.id', target: 'pitch', kind: 'instruction', text: 'X' }
]);

test('구역별로 나누고 공지는 따로 분리한다 (잘못된 키는 제외)', () => {
  const up = []; const m = load(true, up);
  const r = m.buildZoneMirror(sample);
  assert.deepEqual(Object.keys(r.zones).sort(), ['outbound', 'pitch']);
  assert.deepEqual(Object.keys(r.zones.outbound).sort(), ['a1', 'a2']);
  assert.deepEqual(Object.keys(r.notices), ['n1']);
});

test('플래그가 꺼져 있으면 아무 것도 쓰지 않는다', () => {
  const up = []; const m = load(undefined, up);
  m.mirrorZones('jisu-commands-v1', sample);
  assert.equal(up.length, 0);
});

test('다른 키는 복사하지 않는다', () => {
  const up = []; const m = load(true, up);
  m.mirrorZones('jisu-memos-v1', sample);
  assert.equal(up.length, 0);
});

test('켜면 한 번의 다중 경로 쓰기로 구역과 공지를 갱신하고, 비어 있는 구역은 삭제(null)한다', () => {
  const up = []; const m = load(true, up);
  m.mirrorZones('jisu-commands-v1', sample);
  assert.equal(up.length, 1);
  assert.equal(up[0].path, 'jisu');
  assert.deepEqual(Object.keys(up[0].obj['zones/outbound/commands']).sort(), ['a1', 'a2']);
  assert.equal(up[0].obj['zones/production-a/commands'], null);
  assert.deepEqual(Object.keys(up[0].obj.notices), ['n1']);
});

test('구역 이름에 금지 문자가 있거나 JSON이 깨졌으면 쓰지 않는다', () => {
  const up = []; const m = load(true, up);
  assert.equal(m.buildZoneMirror('not json'), null);
  m.mirrorZones('jisu-commands-v1', 'not json');
  assert.equal(up.length, 0);
});

test('수동 복사 함수: 켜져 있으면 현재 작업 목록을 한 번 복사한다', () => {
  const up = []; const m = load(true, up, sample);
  assert.equal(m.win.jisuSeedZoneCopy(), true);
  assert.equal(up.length, 1);
  assert.deepEqual(Object.keys(up[0].obj['zones/outbound/commands']).sort(), ['a1', 'a2']);
});

test('수동 복사 함수: 저장된 값이 없으면 아무 것도 쓰지 않는다', () => {
  const up = []; const m = load(true, up, undefined);
  assert.equal(m.win.jisuSeedZoneCopy(), false);
  assert.equal(up.length, 0);
});
