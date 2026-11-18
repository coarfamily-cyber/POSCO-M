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
const wait = () => new Promise(r => setTimeout(r, 10));

function load({ flag = true, zonesRev = null, remote = null, rev = 0 } = {}) {
  const updates = [];
  const db = { ref(p) { return {
    update(obj) { updates.push({ path: p, obj }); return Promise.resolve(); },
    once() { return Promise.resolve({ val: () => (p === 'jisu/zonesRev' ? zonesRev : null) }); }
  }; } };
  const win = { JISU_ZONE_MIRROR: flag };
  const lastRemote = { 'jisu-commands-v1': remote };
  const baseRev = { 'jisu-commands-v1': rev };
  const fn = new Function('db', 'window', 'ROOT', 'lastRemote', 'baseRev', 'console',
    block + '\nreturn { buildZoneMirror, mirrorZones, win: window };');
  return Object.assign(fn(db, win, 'jisu', lastRemote, baseRev, { warn() {} }), { updates });
}

const sample = JSON.stringify([
  { id: 'a1', target: 'outbound', kind: 'instruction', text: 'A' },
  { id: 'a2', target: 'outbound:2', kind: 'instruction', text: 'B' },
  { id: 'p1', target: 'pitch', kind: 'instruction', text: 'C' },
  { id: 'd1', target: '1', kind: 'instruction', text: '1동' },
  { id: 'n1', target: '*', kind: 'notice', text: '공지' },
  { id: 'bad.id', target: 'pitch', kind: 'instruction', text: 'X' }
]);

test('작업자 구역별로 나누고, 1~4동 등은 _admin 칸, 공지는 notices (잘못된 id 제외)', () => {
  const m = load();
  const r = m.buildZoneMirror(sample);
  assert.deepEqual(Object.keys(r.zones).sort(), ['_admin', 'outbound', 'pitch']);
  assert.deepEqual(Object.keys(r.zones.outbound).sort(), ['a1', 'a2']);
  assert.deepEqual(Object.keys(r.zones._admin), ['d1']);
  assert.deepEqual(Object.keys(r.notices), ['n1']);
});

test('플래그가 꺼져 있으면 아무 것도 쓰지 않는다', async () => {
  const m = load({ flag: false });
  m.mirrorZones('jisu-commands-v1', sample, 5); await wait();
  assert.equal(m.updates.length, 0);
});

test('다른 키는 복사하지 않는다', async () => {
  const m = load();
  m.mirrorZones('jisu-memos-v1', sample, 5); await wait();
  assert.equal(m.updates.length, 0);
});

test('한 번의 다중 경로 쓰기로 구역·_admin·공지·버전을 갱신하고, 빈 구역은 삭제(null)', async () => {
  const m = load();
  m.mirrorZones('jisu-commands-v1', sample, 42); await wait();
  assert.equal(m.updates.length, 1);
  const o = m.updates[0].obj;
  assert.equal(m.updates[0].path, 'jisu');
  assert.deepEqual(Object.keys(o['zones/outbound/commands']).sort(), ['a1', 'a2']);
  assert.deepEqual(Object.keys(o['zones/_admin/commands']), ['d1']);
  assert.equal(o['zones/production-a/commands'], null);
  assert.deepEqual(Object.keys(o.notices), ['n1']);
  assert.equal(o.zonesRev, 42);
});

test('이미 더 새 버전이 복사돼 있으면 덮지 않는다', async () => {
  const m = load({ zonesRev: 100 });
  m.mirrorZones('jisu-commands-v1', sample, 42); await wait();
  assert.equal(m.updates.length, 0);
});

test('깨진 JSON이면 쓰지 않는다', async () => {
  const m = load();
  assert.equal(m.buildZoneMirror('not json'), null);
  m.mirrorZones('jisu-commands-v1', 'not json', 1); await wait();
  assert.equal(m.updates.length, 0);
});

test('수동 복사 함수: 서버 값과 서버 버전으로 한 번 복사', async () => {
  const m = load({ remote: sample, rev: 77 });
  assert.equal(m.win.jisuSeedZoneCopy(), true); await wait();
  assert.equal(m.updates.length, 1);
  assert.equal(m.updates[0].obj.zonesRev, 77);
});

test('수동 복사 함수: 서버 값이 아직 없으면 아무 것도 쓰지 않는다', async () => {
  const m = load({ remote: '' });
  assert.equal(m.win.jisuSeedZoneCopy(), false); await wait();
  assert.equal(m.updates.length, 0);
});
