// 실행: NODE_PATH=<jsdom 설치 경로> node --test tests/flash-dot.test.js
//        (개별 실행: NODE_PATH=<jsdom 설치 경로> node tests/flash-dot.test.js JISU/index.html)
// 2026-11-23 수뽕 님 지시: "내용이 저장되면 그 구역 버튼 점이 녹색으로 10초 깜빡이고, 작업중 녹색불은 없앤다"
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

test('저장하면 그 구역 점이 녹색으로 10초 깜빡이고, 작업중 녹색불은 없다', async () => {
  const seedItems = baseItems();
  const p1 = await loadPage({ [KEY]: JSON.stringify(seedItems), [MKEY]: '[]' });
  const w = p1.w;
  try {

  // ── 1) 첫 로드: 기존 자료에는 울리지 않는다 ──────────────────────────────
  assert.equal(p1.errors.length, 0, p1.errors.join(' | '));
  assert.deepEqual(flashZones(w), [], '첫 로드에 깜빡임이 있으면 안 된다');

  const lg = (w.document.querySelector('.state-legend') || {}).textContent || '';
  /* 2026-11-26 수뽕 님 지시로 규칙이 바뀌었다: 작업중도 이제 '버튼 전체 녹색불'이라 범례에 다시 들어간다.
     (11-23에 없앤 것은 점(dot)의 상시 녹색불이고, 그 점은 지금도 회색 불꺼짐 + 저장 10초만 녹색이다.) */
  assert.ok(lg.includes('작업중'), '범례에 작업중이 없다(작업중 = 버튼 전체 녹색불): ' + lg);
  assert.ok(lg.includes('일부 완료'), '범례에 일부 완료가 없다: ' + lg);
  assert.ok(lg.includes('긴급'), '범례에 긴급이 없다: ' + lg);
  assert.ok(lg.includes('신규 등록(10초)'), '범례에 신규 등록(10초)이 없다: ' + lg);

  const wb = w.document.querySelector('#mapStage [data-toggle-zone="outbound"]');
  assert.ok(wb.classList.contains('st-work'), wb.className);
  assert.ok(!wb.classList.contains('st-flash-green'), '작업중 구역에 깜빡임 클래스가 붙어 있다: ' + wb.className);

  // ── 2) 로컬 저장 → 그 구역만 10초 깜빡임 ─────────────────────────────────
  w.eval(`(()=>{
    const sel=document.getElementById('cmdTarget'); sel.value='packaging'; sel.dispatchEvent(new Event('change',{bubbles:true}));
    const t=document.getElementById('cmdText'); t.value='포장 12 TON'; t.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('cmdSubmit').click();
  })()`);
  await sleep(250);
  assert.deepEqual(flashZones(w), ['packaging'], '저장한 구역만 깜빡여야 한다');

  await sleep(6000);
  assert.deepEqual(flashZones(w), ['packaging'], '6초 뒤에도 깜빡여야 한다');
  await sleep(4500);
  assert.deepEqual(flashZones(w), [], '10초가 지나면 꺼져야 한다');

  // ── 3) 다른 기기(Firebase) 저장 수신 ────────────────────────────────────
  const push = obj => p1.fake.firebase.database().ref('jisu/state/' + KEY).set({ v: JSON.stringify(obj), t: Date.now(), by: 'other' });

  const fresh = { id: sid(1000), target: 'pitch', kind: 'instruction', text: '피치 방금 등록', at: md + ' 20:55', day: today };
  await push(seedItems.concat([fresh]));
  await sleep(900);
  assert.deepEqual(flashZones(w), ['pitch'], '방금 등록된 항목을 받으면 깜빡여야 한다');

  const stale = { id: sid(60000), target: 'outbound', kind: 'instruction', text: '옛 작업', at: md + ' 18:00', day: today };
  await push(seedItems.concat([fresh, stale]));
  await sleep(900);
  assert.ok(!flashZones(w).includes('outbound'), '10초 지난 옛 항목 수신에는 울리면 안 된다');

  // ── 4) 특이사항 저장 → 그 구역 깜빡임 ───────────────────────────────────
  w.eval(`(()=>{
    const a=JSON.parse(localStorage.getItem('${MKEY}')||'[]');
    a.push({id:Date.now().toString(36),target:'inbound',tag:'issue',text:'입고 특이사항',at:'20:56'});
    localStorage.setItem('${MKEY}',JSON.stringify(a));
  })()`);
  await sleep(300);
  assert.ok(flashZones(w).includes('inbound'), '특이사항 저장한 구역이 깜빡여야 한다');

  // ── 5) 전체('*') 공지 → 모든 구역 버튼 ─────────────────────────────────
  w.eval(`window.jisuFlashZone('*')`);
  const all = flashZones(w);
  assert.ok(all.length >= 14, '전체 공지가 모든 구역을 깜빡여야 한다: ' + all.join(','));

  assert.equal(p1.errors.length, 0, p1.errors.join(' | '));
  if (lateErrors.length) console.log('닫힌 페이지의 늦은 거부(무시): ' + lateErrors.length + '건');
  } finally {
    try { w.close(); } catch (_) {}     /* 페이지 타이머를 정리해 테스트 프로세스가 끝나게 한다 */
  }
});

test('첫 로드(서버 동기화)로 들어온 자료에는 깜빡이지 않는다', async () => {
  // 다른 기기가 1초 전에 저장해 둔 항목이 서버에 있는 상태로 이 기기를 새로 켠다 → 과거 자료 재로딩이라 울리면 안 된다
  const fresh = { id: sid(1000), target: 'outbound', kind: 'instruction', text: '방금 저장된 작업', at: md + ' 21:00', day: today };
  const p = await loadPage({}, baseItems().concat([fresh]));
  try {
    await sleep(600);
    assert.deepEqual(flashZones(p.w), [], '첫 로드·재동기화에는 울리면 안 된다');
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally {
    try { p.w.close(); } catch (_) {}
  }
});
