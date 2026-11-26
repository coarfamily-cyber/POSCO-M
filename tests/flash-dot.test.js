// 실행: NODE_PATH=<jsdom 설치 경로> node --test tests/flash-dot.test.js
//        (개별 실행: NODE_PATH=<jsdom 설치 경로> node tests/flash-dot.test.js JISU/index.html)
// 2026-11-26 수뽕 님 지시 (2차): "작업중 녹색이 아니고 특이사항에 누군가 작성하였거나
//   새로운 사진을 등록하면 녹색불로" → "특이사항·사진 등록 시에만 10초간 버튼 전체 녹색 깜빡임"
//   · 특이사항(jisu-memos-v1) 새 항목 · 새 사진 등록 → 그 구역 버튼 전체 10초 녹색 깜빡임
//   · 작업지시·공지(jisu-commands-v1)·입고·피치·환경 저장 → 울리지 않는다
//   · 작업중(st-work)은 상시 녹색불 없이 투명 유리 + 회색 점(11-23 지시 그대로)
// 회귀 테스트 — jsdom + 가짜 Firebase + 가짜 IndexedDB. 네트워크·운영 DB·푸시 서버로 나가지 않는다.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeFakeFirebase } = require('./integration/fakefb');

const FILE = process.argv[2] && !process.argv[2].endsWith('.test.js') ? process.argv[2] : path.join(__dirname, '..', 'JISU', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');
const KEY = 'jisu-commands-v1';
const MKEY = 'jisu-memos-v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const md = today.slice(5, 7) + '. ' + today.slice(8, 10) + '.';

const lateErrors = [];
process.on('unhandledRejection', e => lateErrors.push(String((e && e.message) || e).slice(0, 160)));

const sid = offsetMs => (Date.now() - (offsetMs || 0)).toString(36);   /* 앱과 같은 id 형식 */

function baseItems() {
  return [
    { id: 'a1', target: 'outbound', kind: 'instruction', text: '출고 10 TON', at: md + ' 09:00', day: today, working: true },
    { id: 'p1', target: 'pitch', kind: 'instruction', text: '피치 5 TON', at: md + ' 09:30', day: today },
    { id: 'n1', target: '*', kind: 'notice', text: '전체 공지', at: md + ' 09:20', day: today }
  ];
}

async function loadPage(seed, serverItems) {
  const errors = [];
  const vc = new VirtualConsole();
  const envOnly = m => /Not implemented: HTMLCanvasElement\.prototype\.getContext/.test(m);
  vc.on('jsdomError', e => { const m = String(e.message || e); if (!envOnly(m)) errors.push('jsdom: ' + m.slice(0, 200)); });
  vc.on('error', (...a) => errors.push('error: ' + a.map(String).join(' ').slice(0, 200)));
  const fidb = require('fake-indexeddb');
  const fake = makeFakeFirebase();
  if (serverItems) fake.setServer('jisu/state/' + KEY, { v: JSON.stringify(serverItems), t: Date.now(), by: 'server' });
  const dom = new JSDOM(html, {
    url: 'https://jisu.test/POSCO-M/JISU/index.html',
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.firebase = fake.firebase;
      w.indexedDB = fidb.indexedDB;
      ['IDBKeyRange', 'IDBObjectStore', 'IDBIndex', 'IDBCursor', 'IDBCursorWithValue', 'IDBDatabase', 'IDBTransaction', 'IDBRequest', 'IDBOpenDBRequest', 'IDBFactory', 'IDBVersionChangeEvent'].forEach(n => { if (fidb[n]) w[n] = fidb[n]; });
      w.alert = () => {}; w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
      w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
      w.scrollTo = () => {};
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
      Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
    }
  });
  await sleep(1600);
  return { w: dom.window, dom, fake, errors };
}

const flashZones = w => [...w.document.querySelectorAll('#mapStage [data-toggle-zone].st-flash-green')]
  .map(e => e.getAttribute('data-toggle-zone'));

/* 사진 등록 — 앱이 쓰는 통합 사진 저장소(jisu-zone-photos-v1 · photos)에 P.put 으로 한 장 넣는다 */
const putPhoto = (w, zone, id) => w.eval(`new Promise((res,rej)=>{
  const r=indexedDB.open('jisu-zone-photos-v1',1);
  r.onupgradeneeded=()=>{ if(!r.result.objectStoreNames.contains('photos')) r.result.createObjectStore('photos',{keyPath:'id'}); };
  r.onsuccess=()=>{ try{
    const db=r.result, t=db.transaction('photos','readwrite');
    t.objectStore('photos').put({id:'${id}', zone:'${zone}', data:'data:image/jpeg;base64,QUFB', ts:Date.now()});
    t.oncomplete=()=>{ db.close(); res(1); }; t.onerror=()=>rej(t.error);
  }catch(e){ rej(String(e)); } };
  r.onerror=()=>rej(r.error);
})`);

const delPhoto = (w, id) => w.eval(`new Promise((res,rej)=>{
  const r=indexedDB.open('jisu-zone-photos-v1',1);
  r.onsuccess=()=>{ try{
    const db=r.result, t=db.transaction('photos','readwrite');
    t.objectStore('photos').delete('${id}');
    t.oncomplete=()=>{ db.close(); res(1); }; t.onerror=()=>rej(t.error);
  }catch(e){ rej(String(e)); } };
  r.onerror=()=>rej(r.error);
})`);

test('특이사항·새 사진만 버튼 전체 10초 녹색 깜빡임 · 작업중은 투명 유리+회색 점', async () => {
  const seedItems = baseItems();
  const p1 = await loadPage({ [KEY]: JSON.stringify(seedItems), [MKEY]: '[]' });
  const w = p1.w;
  try {

  // ── 1) 첫 로드: 기존 자료에는 울리지 않는다 ──────────────────────────────
  assert.equal(p1.errors.length, 0, p1.errors.join(' | '));
  assert.deepEqual(flashZones(w), [], '첫 로드에 깜빡임이 있으면 안 된다');

  /* 범례: 작업중(녹색)은 빠지고, 특이사항·사진(10초) 하나로 합쳐진다 */
  const lg = (w.document.querySelector('.state-legend') || {}).textContent || '';
  assert.ok(!lg.includes('작업중'), '범례에 작업중이 남아 있다(작업중은 상시 녹색불이 아니다): ' + lg);
  assert.ok(lg.includes('일부 완료'), '범례에 일부 완료가 없다: ' + lg);
  assert.ok(lg.includes('긴급'), '범례에 긴급이 없다: ' + lg);
  assert.ok(lg.includes('특이사항·사진(10초)'), '범례에 특이사항·사진(10초)이 없다: ' + lg);
  assert.ok(!lg.includes('신규 등록(10초)'), '옛 범례 문구(신규 등록(10초))가 남아 있다: ' + lg);

  const wb = w.document.querySelector('#mapStage [data-toggle-zone="outbound"]');
  assert.ok(wb.classList.contains('st-work'), wb.className);
  assert.ok(!wb.classList.contains('st-flash-green'), '작업중 구역에 깜빡임 클래스가 붙어 있다: ' + wb.className);

  // ── 2) 작업지시(금일작업) 로컬 저장 → 깜빡이지 않는다 ──────────────────────
  w.eval(`(()=>{
    const sel=document.getElementById('cmdTarget'); sel.value='packaging'; sel.dispatchEvent(new Event('change',{bubbles:true}));
    const t=document.getElementById('cmdText'); t.value='포장 12 TON'; t.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('cmdSubmit').click();
  })()`);
  await sleep(300);
  assert.deepEqual(flashZones(w), [], '작업지시 저장에는 울리면 안 된다(특이사항·사진만)');
  const saved = JSON.parse(w.localStorage.getItem(KEY) || '[]');
  assert.ok(saved.some(x => x.target === 'packaging'), '작업지시가 저장되지 않았다: ' + saved.length);

  // ── 3) 다른 기기(Firebase)에서 들어온 작업지시 → 깜빡이지 않는다 ───────────
  const push = obj => p1.fake.firebase.database().ref('jisu/state/' + KEY).set({ v: JSON.stringify(obj), t: Date.now(), by: 'other' });
  const fresh = { id: sid(1000), target: 'pitch', kind: 'instruction', text: '피치 방금 등록', at: md + ' 20:55', day: today };
  await push(seedItems.concat([fresh]));
  await sleep(900);
  assert.deepEqual(flashZones(w), [], '방금 다른 기기에서 등록된 작업지시에도 울리면 안 된다');

  // ── 4) 특이사항 새 작성 → 그 구역 버튼 전체 10초 깜빡임 ────────────────────
  w.eval(`(()=>{
    const a=JSON.parse(localStorage.getItem('${MKEY}')||'[]');
    a.push({id:Date.now().toString(36),target:'inbound',tag:'issue',text:'입고 특이사항',at:'20:56'});
    localStorage.setItem('${MKEY}',JSON.stringify(a));
  })()`);
  await sleep(300);
  assert.deepEqual(flashZones(w), ['inbound'], '특이사항을 작성하면 그 구역이 깜빡여야 한다');

  await sleep(6000);
  assert.deepEqual(flashZones(w), ['inbound'], '6초 뒤에도 깜빡여야 한다');
  await sleep(4500);
  assert.deepEqual(flashZones(w), [], '10초가 지나면 꺼져야 한다');

  // ── 5) 확인(ack)·수정 → 새 항목이 아니므로 울리지 않는다 ──────────────────
  w.eval(`(()=>{
    const a=JSON.parse(localStorage.getItem('${MKEY}')||'[]');
    a[0].ack=true; a[0].ackAt='20:57';
    localStorage.setItem('${MKEY}',JSON.stringify(a));
  })()`);
  await sleep(300);
  assert.deepEqual(flashZones(w), [], '특이사항 확인(ack) 변경에는 울리면 안 된다');

  // ── 6) 다른 기기에서 들어온 새 특이사항 → 깜빡임 ─────────────────────────
  const remoteMemo = { id: sid(500), target: 'production-a', tag: 'issue', text: '다른 기기 특이사항', at: md + ' 20:58' };
  w.eval(`(()=>{
    const a=JSON.parse(localStorage.getItem('${MKEY}')||'[]');
    a.push(${JSON.stringify(remoteMemo)});
    localStorage.setItem('${MKEY}',JSON.stringify(a));
  })()`);
  await sleep(300);
  assert.deepEqual(flashZones(w), ['production-a'], '새 특이사항(원격 포함)이 들어오면 깜빡여야 한다');

  // ── 7) 새 사진 등록 → 그 구역 버튼 전체 10초 깜빡임 ────────────────────────
  await sleep(300);
  w.document.querySelectorAll('#mapStage [data-toggle-zone].st-flash-green').forEach(e => e.classList.remove('st-flash-green'));
  await putPhoto(w, 'packaging', 'qa-photo-' + Date.now().toString(36));
  await sleep(500);
  assert.deepEqual(flashZones(w), ['packaging'], '새 사진을 등록하면 그 구역이 깜빡여야 한다');
  await sleep(6000);
  assert.deepEqual(flashZones(w), ['packaging'], '사진 등록 6초 뒤에도 깜빡여야 한다');
  await sleep(4500);
  assert.deepEqual(flashZones(w), [], '사진 등록 10초 뒤에는 꺼져야 한다');

  // ── 8) 사진 삭제 → 울리지 않는다 ─────────────────────────────────────────
  const pid = w.eval(`(async()=>{ const r=indexedDB.open('jisu-zone-photos-v1',1); return await new Promise(res=>{ r.onsuccess=()=>{ const db=r.result, q=db.transaction('photos','readonly').objectStore('photos').getAll(); q.onsuccess=()=>{ const it=(q.result||[]).slice(-1)[0]; db.close(); res(it?it.id:''); }; }; }); })()`);
  await delPhoto(w, pid);
  await sleep(400);
  assert.deepEqual(flashZones(w), [], '사진 삭제에는 울리면 안 된다');

  // ── 9) 전체('*') 특이사항 → 모든 구역 버튼 ────────────────────────────────
  w.eval(`window.jisuFlashZone('*')`);
  const all = flashZones(w);
  assert.ok(all.length >= 14, '전체 공지가 모든 구역을 깜빡여야 한다: ' + all.join(','));

  assert.equal(p1.errors.length, 0, p1.errors.join(' | '));
  if (lateErrors.length) console.log('닫힌 페이지의 늦은 거부(무시): ' + lateErrors.length + '건');
  } finally {
    try { w.close(); } catch (_) {}     /* 페이지 타이머를 정리해 테스트 프로세스가 끝나게 한다 */
  }
});

test('첫 로드(서버 동기화)로 들어온 자료·특이사항에는 깜빡이지 않는다', async () => {
  // 다른 기기가 1초 전에 저장해 둔 작업지시·특이사항이 서버에 있는 상태로 이 기기를 새로 켠다 → 과거 자료 재로딩이라 울리면 안 된다
  const fresh = { id: sid(1000), target: 'outbound', kind: 'instruction', text: '방금 저장된 작업', at: md + ' 21:00', day: today };
  const recentMemo = { id: sid(1000), target: 'outbound', tag: 'issue', text: '방금 쓴 특이사항', at: md + ' 21:00' };
  const p = await loadPage({ [MKEY]: JSON.stringify([recentMemo]) }, baseItems().concat([fresh]));
  try {
    await sleep(600);
    assert.deepEqual(flashZones(p.w), [], '첫 로드·재동기화에는 울리면 안 된다');
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally {
    try { p.w.close(); } catch (_) {}
  }
});
