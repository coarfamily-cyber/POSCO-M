// 실행: NODE_PATH=<jsdom 설치 경로> node --test tests/zone-and-recovery.test.js
//        (개별 실행: NODE_PATH=<jsdom 설치 경로> node tests/zone-and-recovery.test.js JISU/index.html)
// 2026-11-25 전체 코드 버그 점검에서 찾은 두 가지 회귀 테스트.
//  1) ?zone=<없는 구역> 이면 관리자 대시보드를 그대로 보여준다 (예전에는 빈 화면).
//  2) localStorage 값이 "null"·객체·깨진 모양이어도 시작할 때 자동 복구해 빈 화면이 되지 않는다.
//  3) 생산 A~H 작업자 화면(?zone=production-*)은 .prod-grid 격자를 풀어 화면 폭을 그대로 쓴다 (CSS 가드).
// jsdom + 가짜 Firebase + 가짜 IndexedDB. 네트워크·운영 DB·푸시 서버로 나가지 않는다.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { test: nodeTest } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeFakeFirebase } = require('./integration/fakefb');

const FILE = process.argv[2] && !process.argv[2].endsWith('.test.js') ? process.argv[2] : path.join(__dirname, '..', 'JISU', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* 창을 닫은 뒤 늦게 도착한 타이머/동기화 거부는 무시한다 (다른 테스트와 같은 처리) */
const lateErrors = [];
process.on('unhandledRejection', e => lateErrors.push(String((e && e.message) || e).slice(0, 160)));
/* 각 테스트가 연 창은 테스트가 끝날 때 닫지 않고 마지막(after)에 한 번에 닫는다.
   테스트 도중에 닫으면 남은 타이머가 '테스트 종료 후 비동기 작업'으로 잡혀 파일이 실패한다. */
const opened = [];
function closeWin(w){
  try{
    w.__jisuClosed = true;
    (w.__jisuTimers || new Set()).forEach(id => { try { w.clearTimeout(id); w.clearInterval(id); } catch (_) {} });
    (w.__jisuTimers || new Set()).clear();
  }catch(_){}
}
/* node 18.4 처럼 test.after 가 없는 러너에서도 파일이 실패하지 않게 (있으면 그대로 사용)
   — 없는 러너에서는 마지막 테스트가 끝났을 때 창을 닫아 프로세스가 스스로 끝나게 한다. */
const finish = async () => { opened.forEach(closeWin); await sleep(200); opened.forEach(w => { try { w.close(); } catch (_) {} }); await sleep(400); };
if (typeof nodeTest.after === 'function') {
  nodeTest.after(finish);
  const test = nodeTest;
  global.__jisuTest = test;
} else {
  let running = 0, timer = null;
  global.__jisuTest = function test(name, fn) {
    return nodeTest(name, async (...args) => {
      running++;
      try { return await fn(...args); }
      finally {
        running--;
        clearTimeout(timer);
        timer = setTimeout(() => { if (running === 0) finish(); }, 400);
      }
    });
  };
}
const test = global.__jisuTest;

async function loadPage(query, seed, server) {
  const errors = [];
  const vc = new VirtualConsole();
  const envOnly = m => /Not implemented: HTMLCanvasElement\.prototype\.getContext/.test(m);
  vc.on('jsdomError', e => { const m = String(e.message || e); if (!envOnly(m)) errors.push('jsdom: ' + m.slice(0, 200)); });
  vc.on('error', (...a) => errors.push('error: ' + a.map(String).join(' ').slice(0, 200)));
  const fidb = require('fake-indexeddb');
  const fake = makeFakeFirebase();
  if (server) Object.entries(server).forEach(([k, v]) => fake.setServer('jisu/state/' + k, { v: v, t: Date.now(), by: 'server' }));
  const dom = new JSDOM(html, {
    url: 'https://jisu.test/POSCO-M/JISU/index.html' + (query || ''),
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.firebase = fake.firebase;
      w.indexedDB = fidb.indexedDB;
      ['IDBKeyRange', 'IDBObjectStore', 'IDBIndex', 'IDBCursor', 'IDBCursorWithValue', 'IDBDatabase', 'IDBTransaction', 'IDBRequest', 'IDBOpenDBRequest', 'IDBFactory', 'IDBVersionChangeEvent'].forEach(n => { if (fidb[n]) w[n] = fidb[n]; });
      w.alert = () => {}; w.confirm = () => true;
      /* 창을 닫은 뒤 남은 타이머·rAF 가 닫힌 문서(document undefined)를 건드리지 않게 감싼다.
         테스트가 끝나고 창을 닫아도 '테스트 종료 후 비동기 오류'가 생기지 않는다. */
      /* 창을 진짜로 닫으면(jsdom close) 남은 타이머·콜백이 사라진 document 를 건드려
         '테스트 종료 후 비동기 오류'가 난다. 그래서 창은 그대로 두고, 테스트가 끝나면
         타이머만 모두 멈추는 '소프트 닫기'를 쓴다. */
      w.__jisuClosed = false;
      w.__jisuTimers = new Set();
      const _st = w.setTimeout.bind(w), _si = w.setInterval.bind(w), _raf = w.requestAnimationFrame && w.requestAnimationFrame.bind(w);
      w.setTimeout = (fn, ms, ...a) => { const id = _st(() => { w.__jisuTimers.delete(id); if (!w.__jisuClosed) fn(...a); }, ms); w.__jisuTimers.add(id); return id; };
      w.setInterval = (fn, ms, ...a) => { const id = _si(() => { if (!w.__jisuClosed) fn(...a); }, ms); w.__jisuTimers.add(id); return id; };
      if (_raf) w.requestAnimationFrame = fn => { const id = _raf(t => { w.__jisuTimers.delete(id); if (!w.__jisuClosed) fn(t); }); w.__jisuTimers.add(id); return id; };
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
      w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
      w.scrollTo = () => {};
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
      Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
    }
  });
  await sleep(2600);
  opened.push(dom.window);
  return { w: dom.window, dom, errors };
}

const isWorker = w => w.document.documentElement.classList.contains('worker-zone-only') || w.document.body.classList.contains('worker-zone-only');

test('없는 구역(?zone=zzz)이면 빈 화면이 아니라 관리자 대시보드를 보여준다', async () => {
  const p = await loadPage('?zone=zzz');
  const w = p.w;
  try {
    assert.equal(isWorker(w), false, '없는 구역인데 작업자 화면 클래스가 남아 있다');
    const txt = (w.document.body.textContent || '').replace(/\s+/g, ' ');
    assert.ok(txt.includes('지수 통합 관제 상황실'), '대시보드 제목이 보이지 않는다');
    assert.ok(txt.includes('금일작업'), '사이드바 등록 영역이 보이지 않는다');
    const side = w.document.querySelector('aside#cmdSide');
    assert.ok(side, '사이드바가 없다');
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { closeWin(w); }
});

test('?zone=하위품목(outbound:RAS-2)은 구역만 떼어 출고 작업자 화면으로 연다', async () => {
  const p = await loadPage('?zone=outbound:RAS-2');
  const w = p.w;
  try {
    assert.equal(isWorker(w), true, '출고 작업자 화면이 아니다');
    const wrap = w.document.getElementById('hotspot-outbound');
    assert.ok(wrap && wrap.classList.contains('is-worker-zone'), '출고 카드가 작업자 카드로 열리지 않았다');
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { closeWin(w); }
});

test('?zone=inbound 는 그대로 입고 작업자 화면이다 (기존 동작)', async () => {
  const p = await loadPage('?zone=inbound');
  const w = p.w;
  try {
    assert.equal(isWorker(w), true);
    assert.ok(w.document.getElementById('hotspot-inbound').classList.contains('is-worker-zone'));
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { closeWin(w); }
});

test('저장값이 null·객체·깨진 모양이어도 자동 복구해 화면이 뜬다', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const p = await loadPage('', {
    'jisu-commands-v1': 'null',                                   /* 배열이어야 하는데 null */
    'jisu-memos-v1': '{}',                                        /* 배열이어야 하는데 객체 */
    'jisu-schedule-v1': JSON.stringify([null, 5, { id: 's1', date: today, target: 'outbound', text: '출고 5 TON' }]),
    'jisu-inbound-records-v1': JSON.stringify({ [today]: { rows: 'oops', archivedRows: null } }),
    'jisu-pitch-records-v1': 'null',
    'jisu-env-v1': 'not-json',
    'jisu-env-log-v1': JSON.stringify([null, { unit: '1,2', day: today }])
  });
  const w = p.w;
  try {
    const txt = (w.document.body.textContent || '').replace(/\s+/g, ' ');
    assert.ok(txt.includes('지수 통합 관제 상황실'), '자동 복구 후에도 화면이 비어 있다');
    assert.equal(p.errors.length, 0, '복구 후에도 페이지 오류: ' + p.errors.join(' | '));

    /* 배열 키는 배열로 되돌아간다 */
    assert.ok(Array.isArray(JSON.parse(w.localStorage.getItem('jisu-commands-v1'))), 'commands 가 배열이 아니다');
    assert.ok(Array.isArray(JSON.parse(w.localStorage.getItem('jisu-memos-v1'))), 'memos 가 배열이 아니다');
    assert.ok(Array.isArray(JSON.parse(w.localStorage.getItem('jisu-schedule-v1'))), 'schedule 이 배열이 아니다');
    /* 잘못된 항목(null·숫자)만 걸러지고 정상 예약은 남는다 */
    const sch = JSON.parse(w.localStorage.getItem('jisu-schedule-v1'));
    assert.equal(sch.length, 1, '정상 예약이 사라졌다: ' + JSON.stringify(sch));
    assert.equal(sch[0].id, 's1');
    /* 입고 rows 가 배열로 복구된다 */
    const inb = JSON.parse(w.localStorage.getItem('jisu-inbound-records-v1'));
    assert.ok(Array.isArray(inb[today].rows), '입고 rows 가 배열이 아니다');
    /* 원래 값은 jisu-recover-<키>-<시각> 으로 보관된다 */
    const keys = Object.keys(w.localStorage);
    assert.ok(keys.some(k => k.indexOf('jisu-recover-jisu-commands-v1-') === 0), '복구 전 값 보관본이 없다');
    assert.equal(w.localStorage.getItem(keys.find(k => k.indexOf('jisu-recover-jisu-commands-v1-') === 0)), 'null');
  } finally { closeWin(w); }
});

test('다른 기기에서 "null" 값이 올라와도 저장 전에 걸러 화면이 멈추지 않는다', async () => {
  const p = await loadPage('', null, { 'jisu-commands-v1': 'null', 'jisu-memos-v1': '{}' });
  const w = p.w;
  try {
    const txt = (w.document.body.textContent || '').replace(/\s+/g, ' ');
    assert.ok(txt.includes('지수 통합 관제 상황실'), '동기화 후 화면이 비어 있다');
    assert.equal(p.errors.length, 0, '동기화 값 때문에 페이지 오류: ' + p.errors.join(' | '));
    assert.ok(Array.isArray(JSON.parse(w.localStorage.getItem('jisu-commands-v1'))), 'DB 의 null 이 배열로 걸러지지 않았다');
    assert.ok(Array.isArray(JSON.parse(w.localStorage.getItem('jisu-memos-v1'))), 'DB 의 {} 가 배열로 걸러지지 않았다');
  } finally { closeWin(w); }
});

test('생산 A~H 작업자 화면(?zone=production-*)은 .prod-grid 격자를 풀어 화면 폭을 쓴다 (CSS 가드)', () => {
  /* jsdom 은 레이아웃을 계산하지 않으므로 규칙 존재·범위를 확인한다.
     실제 412·360 실측은 qa/posco-m-full-audit-20261125.py 가 Chromium 으로 확인한다. */
  const m = html.match(/body\.worker-zone-only:not\(#z1#z2#z3#z4#z5\) #mapStage \.prod-grid[\s\S]{0,400}?\}/);
  assert.ok(m, '작업자 화면 .prod-grid 해제 규칙이 없다');
  assert.ok(/position:static !important/.test(m[0]), '.prod-grid 를 static 으로 풀지 않는다');
  assert.ok(/width:100% !important/.test(m[0]), '.prod-grid 폭을 화면 폭으로 맞추지 않는다');
});
