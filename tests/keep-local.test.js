// 실행: node --test tests/keep-local.test.js  (index.html 의 KEEP-LOCAL 블록만 꺼내, 가짜 IndexedDB로 검증)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'JISU', 'index.html'), 'utf8');
const b = html.indexOf('/* KEEP-LOCAL-BEGIN'), e = html.indexOf('/* KEEP-LOCAL-END */');
assert.ok(b > 0 && e > b, 'keep-local markers not found');
const block = html.slice(b, e + '/* KEEP-LOCAL-END */'.length);

// 가짜 IndexedDB: autoIncrement 저장소, put / getAllKeys / delete / transaction 콜백만 흉내
function fakeIndexedDB() {
  const dbs = {};
  return {
    dbs,
    open(name) {
      const req = {};
      setTimeout(() => {
        const isNew = !dbs[name];
        const db = dbs[name] || (dbs[name] = { stores: {}, seq: 0 });
        const result = { objectStoreNames: { contains: n => !!db.stores[n] }, createObjectStore: n => { db.stores[n] = db.stores[n] || { rows: new Map() }; return db.stores[n]; }, close() {}, transaction(store) {
          const st = db.stores[store];
          const t = { objectStore: () => ({
            put(v) { db.seq += 1; st.rows.set(db.seq, v); return {}; },
            getAllKeys() { const r = {}; setTimeout(() => { r.result = [...st.rows.keys()].sort((a, c) => a - c); if (r.onsuccess) r.onsuccess(); }, 0); return r; },
            delete(key) { st.rows.delete(key); }
          }) };
          setTimeout(() => { if (t.oncomplete) t.oncomplete(); }, 5);
          return t;
        } };
        req.result = result;
        if (isNew && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    }
  };
}
function makeEnv(localValue, remoteValue) {
  const idb = fakeIndexedDB();
  const lastRemote = { 'jisu-commands-v1': remoteValue };
  const warn = [];
  const fn = new Function('payloadOf', 'lastRemote', 'indexedDB', 'console', 'window', 'lsSet', 'localStorage', block + '\nreturn keepLocalBackup;');
  const keep = fn(() => localValue, lastRemote, idb, { warn: m => warn.push(m) }, {}, () => {}, { getItem: () => null, removeItem() {} });
  const rows = () => { const db = idb.dbs['jisu-local-backup']; return db ? [...db.stores.items.rows.values()] : []; };
  return { keep, rows, idb, warn };
}
const wait = () => new Promise(r => setTimeout(r, 40));

test('서버에 없는 로컬 항목만 보관한다 (같은 항목은 제외)', async () => {
  const local = JSON.stringify([{ id: 'a', text: '같음' }, { id: 'b', text: '새 입력' }]);
  const remote = JSON.stringify([{ id: 'a', text: '같음' }]);
  const env = makeEnv(local, remote);
  env.keep('jisu-commands-v1');
  await wait();
  const rows = env.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].json).map(x => x.id), ['b']);
});

test('바뀐 내용이 없으면 아무것도 저장하지 않는다', async () => {
  const same = JSON.stringify([{ id: 'a', text: 'x' }]);
  const env = makeEnv(same, same);
  env.keep('jisu-commands-v1');
  await wait();
  assert.equal(env.rows().length, 0);
});

test('목록이 아닌 값은 통째로 보관한다', async () => {
  const env = makeEnv('{"x":1}', '{"x":0}');
  env.keep('jisu-commands-v1');
  await wait();
  assert.equal(env.rows()[0].json, '{"x":1}');
});

test('최근 20건만 남긴다', async () => {
  const env = makeEnv('[{"id":"n","text":"y"}]', '[]');
  for (let i = 0; i < 25; i++) env.keep('jisu-commands-v1');
  await wait();
  await wait();
  assert.equal(env.rows().length, 20);
});

test('IndexedDB가 없어도 예외 없이 넘어간다', () => {
  const fn = new Function('payloadOf', 'lastRemote', 'indexedDB', 'console', 'window', 'lsSet', 'localStorage', block + '\nreturn keepLocalBackup;');
  const keep = fn(() => '[{"id":"q"}]', { 'jisu-commands-v1': '[]' }, undefined, { warn() {} }, {}, () => {}, { getItem: () => null, removeItem() {} });
  assert.doesNotThrow(() => keep('jisu-commands-v1'));
});
