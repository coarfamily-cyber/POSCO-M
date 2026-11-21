// 통합 테스트: 실제 index.html 전체를 jsdom + 가짜 Firebase + 가짜 IndexedDB 로 실행 (네트워크 없음)
// 준비: npm i --no-save jsdom@24 fake-indexeddb@6   실행: node tests/integration/run.js JISU/index.html
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeFakeFirebase } = require('./fakefb');

const FILE = process.argv[2];
const BASELINE_ONLY = process.argv[3] === 'main';
const html = fs.readFileSync(FILE, 'utf8');
const KEY = 'jisu-commands-v1';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const md = today.slice(5, 7) + '. ' + today.slice(8, 10) + '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 닫힌 페이지에 남은 타이머·약속의 거부는 Node 프로세스를 죽인다. 테스트 판정은 결과 줄로 하고,
// 그런 거부는 모아서 출력만 한다 (페이지가 열려 있는 동안의 오류는 errors[] 로 따로 검사한다).
const lateErrors = [];
process.on('unhandledRejection', e => lateErrors.push(String((e && e.message) || e).slice(0, 160)));

function baseItems() {
  return [
    { id: 'a1', target: 'outbound', kind: 'instruction', text: 'A 작업 10 TON', at: md + ' 09:00', day: today, done: null },
    { id: 'o2', target: 'outbound:2', kind: 'instruction', text: '출고2 작업', at: md + ' 09:05', day: today },
    { id: 'b1', target: '1', kind: 'instruction', text: '1동 작업', at: md + ' 09:10', day: today, moves: [] },
    { id: 'n1', target: '*', kind: 'notice', text: '전체 공지', at: md + ' 09:20', day: today },
    { id: 'p1', target: 'pitch', kind: 'instruction', text: '피치 작업', at: md + ' 09:30', day: today, urgent: true }
  ];
}

async function loadPage({ fake, localSeed }) {
  const errors = [];
  const vc = new VirtualConsole();
  // 캔버스는 jsdom 에 없는 브라우저 기능이다(사진 축소 등). 테스트 환경 한계라 오류로 세지 않는다.
  const envOnly = m => /Not implemented: HTMLCanvasElement\.prototype\.getContext/.test(m);
  vc.on('jsdomError', e => { const m = String(e.message || e); if (!envOnly(m)) errors.push('jsdom: ' + m.slice(0, 160)); });
  vc.on('error', (...a) => errors.push('error: ' + a.map(String).join(' ').slice(0, 160)));
  vc.on('warn', (...a) => errors.push('warn: ' + a.map(String).join(' ').slice(0, 160)));
  const fidb = require('fake-indexeddb');
  const dom = new JSDOM(html, {
    url: 'https://jisu.test/POSCO-M/JISU/index.html',
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.firebase = fake.firebase;
      w.indexedDB = fidb.indexedDB; ['IDBKeyRange','IDBObjectStore','IDBIndex','IDBCursor','IDBCursorWithValue','IDBDatabase','IDBTransaction','IDBRequest','IDBOpenDBRequest','IDBFactory','IDBVersionChangeEvent'].forEach(n => { if (fidb[n]) w[n] = fidb[n]; });
      w.alert = () => {}; w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
      w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
      w.scrollTo = () => {};
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });   // 날씨·알림 등 외부 요청 차단
      Object.entries(localSeed || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
    }
  });
  await sleep(1500);
  return { w: dom.window, dom, errors };
}

function backupRows(w) {
  return new Promise((res) => {
    const r = w.indexedDB.open('jisu-local-backup', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('items')) r.result.createObjectStore('items', { autoIncrement: true }); };
    r.onsuccess = () => { const d = r.result; const q = d.transaction('items', 'readonly').objectStore('items').getAll(); q.onsuccess = () => { d.close(); res(q.result || []); }; };
    r.onerror = () => res([]);
  });
}
async function clearBackups(w) {
  await new Promise(res => { const r = w.indexedDB.deleteDatabase('jisu-local-backup'); r.onsuccess = r.onerror = r.onblocked = () => res(); });
}

(async () => {
  const results = [];
  const ok = (name, fn) => { try { fn(); results.push('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ' :: ' + e.message); } };

  // ---------- 기본 로드 ----------
  const fake = makeFakeFirebase();
  fake.setServer('jisu/state/' + KEY, { v: JSON.stringify(baseItems()), t: 1000, by: 'server' });
  const p1 = await loadPage({ fake });
  const w = p1.w;
  if (BASELINE_ONLY) {
    console.log('ERRORS ' + p1.errors.length); p1.errors.forEach(e => console.log('  - ' + e));
    p1.dom.window.close(); return;
  }
  ok('로드 후 로컬에 서버 작업 목록 반영', () => {
    const loc = JSON.parse(w.localStorage.getItem(KEY) || '[]');
    assert.ok(loc.some(x => x.id === 'a1') && loc.some(x => x.id === 'b1'));
  });

  // ---------- 시드 복사 + 점검 ----------
  const seeded = w.jisuSeedZoneCopy();
  await sleep(300);
  ok('시드 복사 실행', () => assert.equal(seeded, true));
  ok('1동 항목은 _admin 칸에 복사', () => assert.ok(fake.getServer('jisu/zones/_admin/commands/b1')));
  ok('출고 하위 대상(outbound:2)은 출고 칸에 복사', () => assert.ok(fake.getServer('jisu/zones/outbound/commands/o2')));
  ok('공지는 notices에 복사', () => assert.ok(fake.getServer('jisu/notices/n1')));
  let v1 = await w.jisuVerifyZoneCopy();
  ok('점검: Firebase 정규화(키 정렬·null 제거)를 거쳐도 same=true', () => assert.equal(v1.same, true, JSON.stringify(v1)));
  ok('점검: 복사 버전이 원본 버전과 같음', () => assert.equal(v1.copyRev, v1.stateRev));

  // ---------- 화면에서 수정 → 저장 → 자동 복사 ----------
  const loc = JSON.parse(w.localStorage.getItem(KEY));
  loc.push({ id: 'x9', target: 'packaging', kind: 'instruction', text: '포장 신규', at: md + ' 10:00', day: today });
  w.localStorage.setItem(KEY, JSON.stringify(loc));
  ok('수정 직후 미전송 표시 생김', () => assert.equal(w.localStorage.getItem('jisu-unsynced:' + KEY), '1'));
  await sleep(800);
  ok('저장 후 서버 원본에 신규 항목 반영', () => assert.ok(JSON.parse(fake.getServer('jisu/state/' + KEY).v).some(x => x.id === 'x9')));
  ok('저장 후 구역 복사본에도 신규 항목', () => assert.ok(fake.getServer('jisu/zones/packaging/commands/x9')));
  ok('저장 후 미전송 표시 해제', () => assert.equal(w.localStorage.getItem('jisu-unsynced:' + KEY), null));
  const v2 = await w.jisuVerifyZoneCopy();
  ok('저장 후 점검 same=true', () => assert.equal(v2.same, true, JSON.stringify(v2)));

  // ---------- 순서 보호: 더 새 버전이 이미 복사돼 있으면 덮지 않음 ----------
  fake.setServer('jisu/zonesRev', 9e15);
  const loc2 = JSON.parse(w.localStorage.getItem(KEY));
  loc2.push({ id: 'y7', target: 'pitch', kind: 'instruction', text: '피치 추가', at: md + ' 10:30', day: today });
  w.localStorage.setItem(KEY, JSON.stringify(loc2));
  await sleep(800);
  ok('순서 보호: 원본은 저장됨', () => assert.ok(JSON.parse(fake.getServer('jisu/state/' + KEY).v).some(x => x.id === 'y7')));
  ok('순서 보호: 더 새 복사본은 덮지 않음', () => assert.equal(fake.getServer('jisu/zones/pitch/commands/y7'), null));
  fake.setServer('jisu/zonesRev', null);

  // ---------- 오프라인 수정 후 페이지 닫음 → 다음 로드에서 보관 ----------
  await clearBackups(w);
  fake.state.hangTransactions = true;
  const loc3 = JSON.parse(w.localStorage.getItem(KEY));
  loc3.push({ id: 'z5', target: 'inbound', kind: 'instruction', text: '오프라인 입력', at: md + ' 11:00', day: today });
  w.localStorage.setItem(KEY, JSON.stringify(loc3));
  await sleep(500);
  ok('오프라인: 미전송 표시 남음', () => assert.equal(w.localStorage.getItem('jisu-unsynced:' + KEY), '1'));
  const leftLocal = w.localStorage.getItem(KEY);
  p1.dom.window.close();
  fake.state.hangTransactions = false;

  const p2 = await loadPage({ fake, localSeed: { [KEY]: leftLocal, ['jisu-unsynced:' + KEY]: '1' } });
  await sleep(500);
  const rows = await backupRows(p2.w);
  ok('다음 로드: 서버에 없던 항목(z5)을 보관', () => assert.ok(rows.some(r => r.k === KEY && JSON.parse(r.json).some(x => x.id === 'z5')), JSON.stringify(rows).slice(0, 200)));
  ok('다음 로드: 미전송 표시 해제', () => assert.equal(p2.w.localStorage.getItem('jisu-unsynced:' + KEY), null));
  const listed = typeof p2.w.jisuListLocalBackups === 'function' ? await p2.w.jisuListLocalBackups() : [];
  ok('보관본 조회 함수 동작', () => assert.ok(listed.length >= 1));
  p2.dom.window.close();

  // ---------- 표시 없이 로컬만 다른 경우: 보관하지 않음 ----------
  const p3pre = await loadPage({ fake: (() => { const f = makeFakeFirebase(); f.setServer('jisu/state/' + KEY, { v: JSON.stringify(baseItems()), t: 2000 }); return f; })(), localSeed: {} });
  await clearBackups(p3pre.w); p3pre.dom.window.close();
  const fake4 = makeFakeFirebase();
  fake4.setServer('jisu/state/' + KEY, { v: JSON.stringify(baseItems()), t: 3000 });
  const stale = JSON.stringify(baseItems().concat([{ id: 'old1', target: 'pitch', kind: 'instruction', text: '예전 캐시', day: today }]));
  const p4 = await loadPage({ fake: fake4, localSeed: { [KEY]: stale } });
  await sleep(400);
  const rows4 = await backupRows(p4.w);
  ok('표시 없음: 단순히 오래된 캐시는 보관하지 않음', () => assert.equal(rows4.length, 0));
  p4.dom.window.close();

  console.log(results.join('\n'));
  console.log('ERRORS(first load) ' + p1.errors.length); p1.errors.forEach(e => console.log('  - ' + e));
  if (lateErrors.length) console.log('닫힌 페이지의 늦은 거부(무시) ' + lateErrors.length + '건: ' + [...new Set(lateErrors)].join(' | '));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
