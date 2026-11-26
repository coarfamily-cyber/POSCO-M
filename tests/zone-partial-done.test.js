// 실행: NODE_PATH=<jsdom 설치 경로> node --test tests/zone-partial-done.test.js
//        (개별 실행: NODE_PATH=<jsdom 설치 경로> node tests/zone-partial-done.test.js JISU/index.html)
// 2026-11-26 수뽕 님 지시: 지도 구역 버튼 상태를 이렇게 나눈다.
//   ① 작업 없음·대기        = 맑은 투명 유리 + 회색 점
//   ② 일부만 완료(st-part)  = 맑은 투명 유리 + 점만 파란불
//   ③ 작업중(st-work)       = 버튼 전체 녹색불
//   ④ 모두 완료(st-done)    = 버튼 전체 파란불 (예전에는 투명 유리 규칙이 덮어써서 점만 파랬다)
//   ⑤ 정비(st-warn)         = 기존 노란 테두리·글로우 그대로
//   ⑥ 긴급(st-urgent)       = 버튼 전체 빨간불, 어떤 상태든 덮는 최우선
//   ⑦ 새 내용 등록(st-flash-green) = 버튼 전체가 10초 깜빡 (점만 아님)
// jsdom + 가짜 Firebase + 가짜 IndexedDB. 네트워크·운영 DB·푸시 서버로 나가지 않는다.
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
const ST = ['st-none', 'st-wait', 'st-part', 'st-work', 'st-done', 'st-carry'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const md = today.slice(5, 7) + '. ' + today.slice(8, 10) + '.';
/* 완료 시각은 '지금(KST)'으로 둔다 — 08시·18시 마감선보다 뒤라야 마감(closed)되지 않고 오늘 작업으로 남는다 */
const nowHM = (() => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value])); return (p.hour === '24' ? '00' : p.hour) + ':' + p.minute; })();
const NOW = md + ' ' + nowHM;

const lateErrors = [];
process.on('unhandledRejection', e => lateErrors.push(String((e && e.message) || e).slice(0, 160)));

/* 테스트가 끝나면 창을 소프트 닫기(타이머만 정지) — 닫힌 문서를 건드려 생기는
   '테스트 종료 후 비동기 오류'를 만들지 않는다(다른 회귀 테스트와 같은 처리). */
const opened = [];
function softClose(w) {
  try { w.__jisuClosed = true; } catch (_) { }
  try { (w.__jisuTimers || new Set()).forEach(id => { try { w.clearTimeout(id); w.clearInterval(id); } catch (_) { } }); } catch (_) { }
  try { (w.__jisuTimers || new Set()).clear(); } catch (_) { }
}
const finish = async () => { opened.forEach(softClose); await sleep(200); opened.forEach(w => { try { w.close(); } catch (_) {} }); await sleep(300); };
if (typeof test.after === 'function') test.after(finish);

/* 구역별 시나리오
   outbound      : 2건 중 1건 완료          → st-part
   inbound       : 2건 모두 완료            → st-done
   packaging     : 1건, 아무도 시작 안 함    → st-wait
   packaging-d   : 1건 완료(긴급이지만 완료) → st-done, 긴급 아님
   pitch         : 긴급 1건 미완료           → st-wait + st-urgent
   production-a  : 긴급 1건 미완료 + 1건 완료 → st-part + st-urgent
   production-b  : 작업중(working) 1건       → st-work
   environment   : 작업 없음                 → st-none
*/
function items() {
  return [
    { id: 'o1', target: 'outbound', kind: 'instruction', text: '출고 10 TON', at: NOW, day: today, completed: true, completedAt: NOW },
    { id: 'o2', target: 'outbound', kind: 'instruction', text: '출고 20 TON', at: NOW, day: today },
    { id: 'i1', target: 'inbound', kind: 'instruction', text: '입고 A', at: NOW, day: today, completed: true, completedAt: NOW },
    { id: 'i2', target: 'inbound', kind: 'instruction', text: '입고 B', at: NOW, day: today, completed: true, completedAt: NOW },
    { id: 'k1', target: 'packaging', kind: 'instruction', text: '포장 30 TON', at: NOW, day: today },
    { id: 'd1', target: 'packaging-d', kind: 'instruction', text: '3동 포장 5 TON', at: NOW, day: today, urgent: true, completed: true, completedAt: NOW },
    { id: 't1', target: 'pitch', kind: 'instruction', text: '피치 1호기 긴급', at: NOW, day: today, urgent: true },
    { id: 'a1', target: 'production-a', kind: 'instruction', text: 'A라인 긴급', at: NOW, day: today, urgent: true },
    { id: 'a2', target: 'production-a', kind: 'instruction', text: 'A라인 75 TON', at: NOW, day: today, completed: true, completedAt: NOW },
    { id: 'b1', target: 'production-b', kind: 'instruction', text: 'B라인 60 TON', at: NOW, day: today, working: true, startedAt: NOW }
  ];
}

async function loadPage(seed) {
  const errors = [];
  const vc = new VirtualConsole();
  const envOnly = m => /Not implemented: HTMLCanvasElement\.prototype\.getContext/.test(m);
  vc.on('jsdomError', e => { const m = String(e.message || e); if (!envOnly(m)) errors.push('jsdom: ' + m.slice(0, 200)); });
  vc.on('error', (...a) => errors.push('error: ' + a.map(String).join(' ').slice(0, 200)));
  const fidb = require('fake-indexeddb');
  const fake = makeFakeFirebase();
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
      w.__jisuClosed = false;
      w.__jisuTimers = new Set();
      const _st = w.setTimeout.bind(w), _si = w.setInterval.bind(w);
      w.setTimeout = (fn, ms, ...a) => { const id = _st(() => { w.__jisuTimers.delete(id); if (!w.__jisuClosed) fn(...a); }, ms); w.__jisuTimers.add(id); return id; };
      w.setInterval = (fn, ms, ...a) => { const id = _si(() => { if (!w.__jisuClosed) fn(...a); }, ms); w.__jisuTimers.add(id); return id; };
      if (w.requestAnimationFrame) { const _raf = w.requestAnimationFrame.bind(w); w.requestAnimationFrame = fn => { const id = _raf(t => { w.__jisuTimers.delete(id); if (!w.__jisuClosed) fn(t); }); w.__jisuTimers.add(id); return id; }; }
      Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
    }
  });
  opened.push(dom.window);
  await sleep(1600);
  return { w: dom.window, dom, errors };
}

const zoneBtn = (w, k) => w.document.querySelector('#mapStage [data-toggle-zone="' + k + '"]');
const sideBtn = (w, k) => w.document.querySelector('[data-zone-btn="' + k + '"]');
function stateOf(el) {
  const hit = ST.filter(c => el.classList.contains(c));
  assert.equal(hit.length, 1, '상태 클래스는 하나만 붙어야 한다: ' + el.className);
  return hit[0];
}

test('일부 완료=점만 파란불(st-part) · 모두 완료=버튼 전체 파란불(st-done) 클래스', async () => {
  const p = await loadPage({ [KEY]: JSON.stringify(items()), [MKEY]: '[]' });
  const w = p.w;
  try {
    assert.equal(p.errors.length, 0, p.errors.join(' | '));

    /* ② 일부만 완료 — 지도 버튼과 사이드바 버튼 모두 st-part, 완료(st-done)가 아니다 */
    const ob = zoneBtn(w, 'outbound');
    assert.equal(stateOf(ob), 'st-part', 'outbound(2건 중 1건 완료): ' + ob.className);
    assert.ok(!ob.classList.contains('st-done'), 'outbound 가 st-done 이면 안 된다: ' + ob.className);
    assert.equal(stateOf(sideBtn(w, 'outbound')), 'st-part', '사이드바 outbound: ' + sideBtn(w, 'outbound').className);

    /* ④ 모두 완료 — 버튼 전체 파란불 상태 */
    const ib = zoneBtn(w, 'inbound');
    assert.equal(stateOf(ib), 'st-done', 'inbound(2건 모두 완료): ' + ib.className);
    assert.equal(stateOf(sideBtn(w, 'inbound')), 'st-done', '사이드바 inbound');
    assert.equal(stateOf(zoneBtn(w, 'packaging-d')), 'st-done', 'packaging-d(1건 완료, 긴급이지만 완료됨)');

    /* ① 대기·없음 — 투명 유리 + 회색 점 */
    assert.equal(stateOf(zoneBtn(w, 'packaging')), 'st-wait', 'packaging');
    assert.equal(stateOf(zoneBtn(w, 'environment')), 'st-none', 'environment');

    /* ③ 작업중 */
    assert.equal(stateOf(zoneBtn(w, 'production-b')), 'st-work', 'production-b');

    /* ⑤ 긴급 — 미완료 긴급 작업이 있는 구역만 st-urgent (지도·사이드바 모두) */
    assert.ok(zoneBtn(w, 'pitch').classList.contains('st-urgent'), 'pitch 긴급: ' + zoneBtn(w, 'pitch').className);
    assert.ok(sideBtn(w, 'pitch').classList.contains('st-urgent'), '사이드바 pitch 긴급');
    assert.ok(zoneBtn(w, 'production-a').classList.contains('st-urgent'), 'production-a 긴급');
    assert.equal(stateOf(zoneBtn(w, 'production-a')), 'st-part', 'production-a 는 일부 완료(긴급 1 · 완료 1)');
    assert.ok(!zoneBtn(w, 'packaging-d').classList.contains('st-urgent'), '완료된 긴급 건은 긴급불이 아니다');
    assert.ok(!zoneBtn(w, 'outbound').classList.contains('st-urgent'), '긴급 없는 구역에 긴급불이 붙었다');
    assert.ok(!sideBtn(w, 'outbound').classList.contains('st-urgent'), '사이드바에 긴급불이 붙었다');
    /* 기존 '!' 배지도 그대로 */
    assert.ok(zoneBtn(w, 'pitch').querySelector('.urgent-mark'), '긴급 ! 배지가 없다');
    assert.ok(!zoneBtn(w, 'outbound').querySelector('.urgent-mark'), '긴급 아닌 구역에 ! 배지');

    /* ⑥ 정비(st-warn)는 별개 축 — 이 자료에는 없다 */
    assert.ok(!zoneBtn(w, 'inbound').classList.contains('st-warn'), '정비 클래스가 붙었다');

    /* ⑦ 범례도 새 규칙과 같아야 한다 */
    const lg = (w.document.querySelector('.state-legend') || {}).textContent || '';
    ['작업 없음', '일부 완료', '작업중', '완료', '긴급', '이월', '신규 등록(10초)'].forEach(t => assert.ok(lg.includes(t), '범례에 ' + t + ' 가 없다: ' + lg));

    /* 남은 1건까지 완료하면 outbound 는 st-done 으로 넘어간다 */
    w.eval(`(()=>{const a=JSON.parse(localStorage.getItem('${KEY}')||'[]');const it=a.find(x=>x.id==='o2');it.completed=true;it.completedAt='${NOW}';localStorage.setItem('${KEY}',JSON.stringify(a));if(window.jisuStateRefresh)window.jisuStateRefresh();})()`);
    assert.equal(stateOf(zoneBtn(w, 'outbound')), 'st-done', '모두 완료 뒤: ' + zoneBtn(w, 'outbound').className);
    assert.equal(stateOf(sideBtn(w, 'outbound')), 'st-done', '모두 완료 뒤 사이드바');

    /* 하나를 다시 미완료로 되돌리면 st-part 로 돌아간다 */
    w.eval(`(()=>{const a=JSON.parse(localStorage.getItem('${KEY}')||'[]');const it=a.find(x=>x.id==='i1');delete it.completed;delete it.completedAt;localStorage.setItem('${KEY}',JSON.stringify(a));if(window.jisuStateRefresh)window.jisuStateRefresh();})()`);
    assert.equal(stateOf(zoneBtn(w, 'inbound')), 'st-part', '되돌린 뒤 inbound: ' + zoneBtn(w, 'inbound').className);

    /* 긴급 건을 완료 처리하면 빨간불이 꺼진다 */
    w.eval(`(()=>{const a=JSON.parse(localStorage.getItem('${KEY}')||'[]');const it=a.find(x=>x.id==='t1');it.completed=true;it.completedAt='${NOW}';localStorage.setItem('${KEY}',JSON.stringify(a));if(window.jisuStateRefresh)window.jisuStateRefresh();})()`);
    assert.ok(!zoneBtn(w, 'pitch').classList.contains('st-urgent'), '긴급 완료 뒤에도 빨간불: ' + zoneBtn(w, 'pitch').className);
    assert.equal(stateOf(zoneBtn(w, 'pitch')), 'st-done', 'pitch 1건 완료: ' + zoneBtn(w, 'pitch').className);

    assert.equal(p.errors.length, 0, p.errors.join(' | '));
    if (lateErrors.length) console.log('닫힌 페이지의 늦은 거부(무시): ' + lateErrors.length + '건');
  } finally {
    softClose(w);
    await sleep(120);
    try { w.close(); } catch (_) {}
  }
});

test('CSS — 투명 유리 목록에서 완료·작업중을 빼고 상태별 전체 색·긴급 최우선·전체 깜빡임 규칙이 있다', async () => {
  /* '항상 맑은 투명 유리' 목록: 대기·없음·일부완료·이월만 남고 완료·작업중은 빠져야 한다 */
  const listStart = html.indexOf('/* 캡슐 색 규칙 (2026-11-26');
  assert.ok(listStart > 0, '투명 유리 목록 주석을 찾지 못했다');
  const listEnd = html.indexOf('}', listStart);
  const list = html.slice(listStart, listEnd);
  assert.ok(list.includes('.st-part'), '투명 목록에 st-part 가 없다');
  assert.ok(list.includes('.st-none') && list.includes('.st-wait') && list.includes('.st-carry'), '투명 목록에 대기·없음·이월이 빠졌다');
  assert.ok(!/\.st-done/.test(list), '투명 목록에 st-done 이 남아 있다(전체 파란불을 덮는다)');
  assert.ok(!/\.st-work/.test(list), '투명 목록에 st-work 가 남아 있다(전체 녹색불을 덮는다)');

  const bgs = [
    ['작업중 전체 녹색불', 'button.hotspot-pill[data-toggle-zone].st-work', 'rgba(34,197,94,.62)'],
    ['전체 완료 파란불', 'button.hotspot-pill[data-toggle-zone].st-done', 'rgba(59,130,246,.62)'],
    ['긴급 전체 빨간불', 'button.hotspot-pill[data-toggle-zone].st-urgent', 'rgba(220,38,38,.72)'],
    ['환경 작업중 녹색불', '.env-run', 'rgba(34,197,94,.62)'],
    ['환경 완료 파란불', '.env-all:not(.env-run)', 'rgba(59,130,246,.62)']
  ];
  bgs.forEach(([name, sel, color]) => {
    const i = html.indexOf(sel + '{');
    const j = html.indexOf(sel + '{', i + 1);
    const at = i > 0 ? i : j;
    assert.ok(at > 0, name + ' 규칙을 찾지 못했다: ' + sel);
    const block = html.slice(at, html.indexOf('}', at));
    assert.ok(block.includes(color), name + ' 배경색이 ' + color + ' 가 아니다: ' + block.slice(0, 120));
  });

  /* 긴급은 정비(노란불)보다 뒤에 있어야 이긴다 */
  const warnAt = html.indexOf('body:not(#zz) #mapStage button.hotspot-pill[data-toggle-zone].st-warn{');
  const urgentAt = html.indexOf('body:not(#zz) #mapStage button.hotspot-pill[data-toggle-zone].st-urgent{');
  assert.ok(warnAt > 0 && urgentAt > 0, '정비·긴급 규칙을 찾지 못했다');
  assert.ok(urgentAt > warnAt, '긴급 규칙이 정비 규칙보다 뒤에 있어야 노란불을 덮는다');

  /* 일부 완료 = 점만 파란불 */
  assert.ok(/#mapStage \[data-toggle-zone\]\.st-part \.pulse-ring\{[^}]*#38bdf8/.test(html), '일부 완료 점 색(#38bdf8) 규칙이 없다');
  assert.ok(/\[data-zone-btn\]\.st-part > span\.rounded-full\{[^}]*#3b82f6/.test(html), '사이드바 일부 완료 점 규칙이 없다');
  assert.ok(/\[data-zone-btn\]\.st-urgent > span\.rounded-full\{[^}]*#dc2626/.test(html), '사이드바 긴급 점 규칙이 없다');

  /* 새 내용 등록 = 버튼 전체가 10초(1초×10회) 깜빡 */
  assert.ok(/@keyframes nvBtnFlashGreen/.test(html), '버튼 전체 깜빡임 keyframes 가 없다');
  const fl = html.indexOf('button.hotspot-pill[data-toggle-zone].st-flash-green,');
  assert.ok(fl > 0, 'st-flash-green 버튼 규칙이 없다');
  const flBlock = html.slice(fl, html.indexOf('}', html.indexOf('animation:nvBtnFlashGreen', fl)));
  assert.ok(/animation:nvBtnFlashGreen 1s ease-in-out 10 !important/.test(flBlock), '10초(1초×10회) 애니메이션이 아니다: ' + flBlock.slice(0, 200));
  assert.ok(/background:rgba\(34,197,94,/.test(flBlock), '깜빡임 배경색 규칙이 없다');

  /* 10초 뒤 클래스가 떨어지면 원래 상태로 돌아가는 타이머는 그대로 */
  assert.ok(/var FLASH_MS = 10000;/.test(html), '10초 타이머 상수가 바뀌었다');
  assert.ok(/setTimeout\(function\(\)\{ el\.classList\.remove\(CLS\);/.test(html), '깜빡임 해제 타이머가 바뀌었다');

  /* 빌드 번호는 meta 로 갱신된다 */
  assert.ok(/<meta name="jisu-build" content="\d{12}">/.test(html), '빌드 번호(12자리 KST)가 없다');
});
