// 실행: node --test tests/keep-local.test.js  (index.html 의 KEEP-LOCAL 블록만 꺼내 검증)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'JISU', 'index.html'), 'utf8');
const b = html.indexOf('/* KEEP-LOCAL-BEGIN'), e = html.indexOf('/* KEEP-LOCAL-END */');
assert.ok(b > 0 && e > b, 'keep-local markers not found');
const block = html.slice(b, e + '/* KEEP-LOCAL-END */'.length);

function setup(localValue, lastRemote) {
  const store = {};
  const ls = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const payloadOf = () => localValue;
  const lastRemoteObj = { 'jisu-commands-v1': lastRemote };
  const fn = new Function('payloadOf', 'lastRemote', 'localStorage', 'console',
    block + '\nreturn keepLocalBackup;');
  return { keep: fn(payloadOf, lastRemoteObj, ls, { warn() {} }), store };
}

test('로컬에 아직 안 올라간 수정이 있으면 보관한다', () => {
  const s = setup('[{"id":"new"}]', '[{"id":"old"}]');
  s.keep('jisu-commands-v1');
  const arr = JSON.parse(s.store['jisu-local-backup-v1']);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].k, 'jisu-commands-v1');
  assert.equal(arr[0].json, '[{"id":"new"}]');
});

test('바뀐 내용이 없으면 보관하지 않는다', () => {
  const s = setup('[{"id":"same"}]', '[{"id":"same"}]');
  s.keep('jisu-commands-v1');
  assert.equal(s.store['jisu-local-backup-v1'], undefined);
});

test('보관본은 최근 20개만 남긴다', () => {
  const s = setup('x', 'y');
  for (let i = 0; i < 25; i++) s.keep('jisu-commands-v1');
  assert.equal(JSON.parse(s.store['jisu-local-backup-v1']).length, 20);
});

test('저장소가 깨져 있어도 예외를 던지지 않는다', () => {
  const s = setup('x', 'y');
  s.store['jisu-local-backup-v1'] = 'not json';
  assert.doesNotThrow(() => s.keep('jisu-commands-v1'));
  assert.equal(JSON.parse(s.store['jisu-local-backup-v1']).length, 1);
});
