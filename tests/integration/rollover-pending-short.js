// 회귀 테스트(#28279): 18시 마감(rollover)에서 '부족 완료 + 판단 대기' 작업은 closed 로 사라지지 않고
// 다음 날 이월 창(판단 필요)에 남아 관리자가 [잔량 이월]·[이대로 종료]로 직접 판단할 수 있어야 한다.
// 일반 완료는 예전처럼 마감(closed)되어야 한다. 네트워크·운영 DB·실제 알림 없음(가짜 Firebase + jsdom).
// 실행: node tests/integration/rollover-pending-short.js JISU/index.html
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeFakeFirebase } = require('./fakefb');

const FILE = process.argv[2] || 'JISU/index.html';
const html = fs.readFileSync(FILE, 'utf8');
const KEY = 'jisu-commands-v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lateErrors = [];
process.on('unhandledRejection', e => lateErrors.push(String((e && e.message) || e).slice(0, 160)));

const KST = { timeZone: 'Asia/Seoul', hour12: false, hourCycle: 'h23' };
const parts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  ...KST, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
}).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
const dateOf = ms => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
const stampOf = ms => { const p = parts(ms); return `${Number(p.month)}. ${Number(p.day)}. ${p.hour}:${p.minute}`; };

// rollover()의 cutoff 규칙과 같게 계산한다 — 테스트를 실행 시각과 무관하게 만든다.
const nowMs = Date.now();
const p = parts(nowMs);
const hKst = Number(p.hour);
const today = dateOf(nowMs);
const yday = dateOf(nowMs - 864e5);
const base = new Date(`${today}T00:00:00+09:00`).getTime();
const cutoffMs = hKst >= 18 ? base + 18 * 3600e3 : (hKst >= 8 ? base + 8 * 3600e3 : base - 6 * 3600e3);
const beforeMs = cutoffMs - 3600e3;                 // cutoff 1시간 전 완료 → 마감 대상
const beforeDay = dateOf(beforeMs), beforeAt = stampOf(beforeMs);
const yAt = stampOf(new Date(`${yday}T15:00:00+09:00`).getTime());

const items = [
  // 일반 완료(목표 달성) — 마감 대상
  { id: 'a', target: 'outbound', kind: 'instruction', text: '출고 20 TON', at: beforeAt, day: beforeDay, done: 20, completed: true, completedAt: beforeAt },
  // 부족 완료 + 판단 대기 — 마감되면 안 됨
  { id: 'b', target: 'outbound', kind: 'instruction', text: '출고 20 TON', at: beforeAt, day: beforeDay, done: 14, completed: true, completedAt: beforeAt, short: true, review: 'pending' },
  // 미완료(오늘) — 그대로
  { id: 'c', target: 'packaging', kind: 'instruction', text: '포장 5 BOX', at: beforeAt, day: today, done: 2 },
  // 어제 부족 완료 + 판단 대기 — 지난 날짜 분기에서도 마감되면 안 됨
  { id: 'd', target: 'pitch', kind: 'instruction', text: '피치 → 3동 30 TON', day: yday, at: yAt, done: 18, completed: true, completedAt: yAt, short: true, review: 'pending' },
  // 어제 미완료 — 기존처럼 오늘로 이월 카드 1건 생성
  { id: 'e', target: 'inbound', kind: 'instruction', text: '입고 640 EA', at: yAt, day: yday },
  // 어제 공지 — 기존처럼 종료
  { id: 'f', target: '*', kind: 'notice', text: '안전점검 안내', at: yAt, day: yday },
  // 이미 판단이 끝나 마감된 부족 완료 — 다시 열지 않는다
  { id: 'g', target: 'outbound', kind: 'instruction', text: '출고 10 TON', at: yAt, day: yday, done: 6, completed: true, completedAt: yAt, short: true, review: 'accepted', closed: true }
];

async function loadPage(fake) {
  const errors = [];
  const vc = new VirtualConsole();
  const envOnly = m => /Not implemented: HTMLCanvasElement\.prototype\.getContext/.test(m);
  vc.on('jsdomError', e => { const m = String(e.message || e); if (!envOnly(m)) errors.push('jsdom: ' + m.slice(0, 160)); });
  const fidb = require('fake-indexeddb');
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
      w.scrollTo = () => {};
      w.HTMLCanvasElement.prototype.getContext = function () { return null; };
      w.fetch = () => Promise.reject(new Error('offline test'));   /* 버전 확인 fetch — 네트워크 없음 */
      w.localStorage.setItem(KEY, JSON.stringify(items));
    }
  });
  await sleep(1300);
  return { w: dom.window, dom, errors };
}

(async () => {
  const results = [];
  const ok = (name, fn) => { try { fn(); results.push('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ' :: ' + e.message); } };
  const fake = makeFakeFirebase();
  fake.setServer('jisu/state/' + KEY, { v: JSON.stringify(items), t: 1000, by: 'server' });
  const p1 = await loadPage(fake);
  const w = p1.w;
  const get = () => JSON.parse(w.localStorage.getItem(KEY) || '[]');
  const by = id => get().find(x => x.id === id) || {};

  // 화면이 켜질 때 rollover가 한 번 돌지만, 기준 상태를 확실히 하려고 직접 한 번 더 돌린다(멱등).
  w.jisuRollover();
  await sleep(400);
  let list = get();

  ok('기준: rollover 실행 후 목록이 살아 있음', () => assert.ok(list.length >= items.length));
  ok('일반 완료(a)는 기존처럼 마감(closed)', () => assert.equal(by('a').closed, true, JSON.stringify(by('a'))));
  ok('부족 완료+판단 대기(b)는 마감되지 않음', () => assert.ok(!by('b').closed, JSON.stringify(by('b'))));
  ok('부족 완료+판단 대기(b)는 판단 대기 상태 유지', () => { assert.equal(by('b').review, 'pending'); assert.equal(by('b').short, true); });
  ok('부족 완료+판단 대기(b)의 완료 수량·목표 보존', () => { assert.equal(Number(by('b').done), 14); assert.match(String(by('b').text), /20\s*TON/i); });
  ok('미완료(c)는 건드리지 않음', () => { assert.ok(!by('c').closed); assert.ok(!by('c').completed); });
  ok('어제 부족 완료+판단 대기(d)도 마감되지 않음', () => assert.ok(!by('d').closed, JSON.stringify(by('d'))));
  ok('어제 판단 대기(d)는 이월 표시(origDay·autoCarriedDay)', () => { assert.equal(by('d').origDay, yday); assert.equal(by('d').autoCarriedDay, today); });
  ok('어제 미완료(e)는 기존처럼 이월 카드 생성', () => {
    assert.equal(by('e').closed, true);
    const cid = 'c_e_' + today;
    assert.equal(by('e').carriedTo, cid);
    const rec = by(cid);
    assert.ok(rec, '이월 카드 없음');
    assert.equal(rec.day, today);
    assert.equal(rec.carryFrom, 'e');
    assert.equal(rec.review, 'ok');
  });
  ok('어제 공지(f)는 기존처럼 종료', () => assert.equal(by('f').closed, true));
  ok('이미 마감된 판단(g)은 다시 열지 않음', () => assert.equal(by('g').closed, true));
  ok('판단 대기 목록에 부족 완료 2건만 남음', () => assert.equal(w.jisuReviewCount(), 2, 'count=' + w.jisuReviewCount()));
  ok('이월 카드는 중복 생성되지 않음(멱등)', () => assert.equal(list.filter(x => x.id === 'c_e_' + today).length, 1));
  ok('부족 완료(b)로 새 카드가 생기지 않음(중복·집계 왜곡 없음)', () => assert.equal(list.filter(x => x.carryFrom === 'b').length, 0));

  // ── 이월 창(판단 필요) 노출 + 판단 버튼 동작 ──
  w.jisuOpenReview();
  await sleep(200);
  const modal = w.document.querySelector('.rv-modal');
  ok('이월 창이 열린다', () => assert.ok(modal && !modal.hidden));
  const rowOf = id => modal.querySelector('.rv-row[data-rv-id="' + id + '"]');
  const clickBtn = (id, act) => { const r = rowOf(id); if (!r) return false; const b = r.querySelector('[data-rv="' + act + '"]'); if (!b) return false; b.click(); return true; };
  ok('이월 창 판단 목록에 (b) 노출', () => assert.ok(rowOf('b'), 'b 행 없음'));
  ok('이월 창 판단 목록에 (d) 노출', () => assert.ok(rowOf('d'), 'd 행 없음'));
  ok('(b) 행에 부족 완료 표기', () => assert.match(rowOf('b').textContent, /부족 완료\s*14\s*\/\s*20/));
  ok('(b)·(d) 행에 판단 버튼(잔량 이월·이대로 종료)', () => {
    ['b', 'd'].forEach(id => {
      assert.ok(rowOf(id).querySelector('[data-rv="carry"]'), id + ' 잔량 이월 버튼 없음');
      assert.ok(rowOf(id).querySelector('[data-rv="accept"]'), id + ' 이대로 종료 버튼 없음');
    });
  });
  ok('이월 창 머리말 숫자(판단 필요 2)', () => assert.match(modal.querySelector('.rv-count').textContent, /판단 필요\s*2/));

  // 이대로 종료(b) → 판단 대기에서 빠지고 그대로 남는다(기존 처리)
  ok('(b) 이대로 종료 버튼 클릭', () => assert.ok(clickBtn('b', 'accept'), 'b 버튼 없음'));
  await sleep(300);
  ok('(b) 이대로 종료 → review=accepted', () => assert.equal(by('b').review, 'accepted'));
  ok('(b) 판단 후 목록에서 빠짐', () => assert.equal(w.jisuReviewCount(), 1, 'count=' + w.jisuReviewCount()));
  ok('(b) 판단 기록(reviewBy·reviewNote) 남음', () => { assert.ok(by('b').reviewNote); assert.ok(by('b').reviewAt); });

  // 잔량 이월(d) → 남은 12 TON 카드가 오늘로 생기고 원본은 carried(기존 처리)
  w.jisuOpenReview();
  await sleep(150);
  ok('(d) 잔량 이월 버튼 클릭', () => assert.ok(clickBtn('d', 'carry'), 'd 버튼 없음'));
  await sleep(400);
  ok('(d) 잔량 이월 → 원본 review=carried', () => assert.equal(by('d').review, 'carried'));
  ok('(d) 남은 12 TON 카드가 오늘 날짜로 생성', () => {
    const rec = get().find(x => x.carryFrom === 'd');
    assert.ok(rec, '잔량 이월 카드 없음');
    assert.equal(rec.day, today);
    assert.equal(Number(rec.prevDone), 18);
    assert.match(String(rec.text), /12\s*TON/i);
    assert.equal(rec.review, 'ok');
  });
  ok('판단 후 판단 대기 목록 비움', () => assert.equal(w.jisuReviewCount(), 0, 'count=' + w.jisuReviewCount()));

  // 마감 뒤에도 일반 완료는 판단 목록에 없다
  ok('일반 완료(a)·공지(f)는 판단 목록에 없음', () => { assert.ok(!by('a').short); assert.equal(by('a').review, undefined); });

  console.log(results.join('\n'));
  const bad = results.filter(r => r.startsWith('FAIL'));
  console.log('ERRORS ' + p1.errors.length);
  p1.errors.slice(0, 6).forEach(e => console.log('  - ' + e));
  console.log(bad.length ? `ROLLOVER-SHORT FAILED (${bad.length}/${results.length})` : `ROLLOVER-SHORT ALL PASSED (${results.length} checks)`);
  if (lateErrors.length) console.log('늦은 거부(무시): ' + lateErrors.length + '건');
  p1.dom.window.close();
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
