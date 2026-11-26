// 실행: NODE_PATH=<jsdom 설치 경로> node --test tests/env-shift-cutoff.test.js
//        (개별 실행: NODE_PATH=<jsdom 설치 경로> node tests/env-shift-cutoff.test.js JISU/index.html)
// 2026-11-26 수뽕 님 지시: 지도 '환경' 파란불(env-all) 기준을 "저녁18시 오전08시로"
//   → 가장 최근 08:00/18:00(KST) 마감 이후 완료된 칸이 있을 때만 파란불.
//   (08~17시 = 오늘 08:00 · 18~23시 = 오늘 18:00 · 00~07시 = 어제 18:00)
// 회귀 테스트 — jsdom + 가짜 Firebase + 가짜 IndexedDB. 네트워크·운영 DB·푸시 서버로 나가지 않는다.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeFakeFirebase } = require('./integration/fakefb');

const FILE = process.argv[2] && !process.argv[2].endsWith('.test.js') ? process.argv[2] : path.join(__dirname, '..', 'JISU', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');
const KEY = 'jisu-env-v1';
const H = 3600 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* KST 벽시계 → ms (UTC 저장값) */
const kst = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi, 0, 0) - 9 * H;

/* 어젯밤 20:43 완료된 7,8호기 분체 (11/25) */
const DONE_25_2043 = kst(2026, 11, 25, 20, 43);

function envState(items) {
  const subs = {};
  (items || []).forEach(it => { subs[it.eq || '분체'] = { s: 'done', day: it.day, td: it.td, ts: it.ts || '', doneAt: it.doneAt }; });
  return { round: 1, u: { '7,8': { subs } }, a: { s: '', subs: {} } };
}
function withWork(extra) {
  const st = envState(extra);
  st.u['1,2'] = { subs: { '충진기': { s: 'work', ts: '오후 1:00', day: '2026-11-26' } } };
  return st;
}

const lateErrors = [];
process.on('unhandledRejection', e => lateErrors.push(String((e && e.message) || e).slice(0, 160)));

async function loadPage(seedEnv) {
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
      w.requestAnimationFrame = () => 0; w.cancelAnimationFrame = () => {};
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
      if (seedEnv) w.localStorage.setItem(KEY, JSON.stringify(seedEnv));
    }
  });
  await sleep(1600);
  return { w: dom.window, dom, fake, errors };
}

/* 페이지 안에서 '지금'을 고정하고 지도 필 상태를 읽는다 */
function at(w, nowMs, env) {
  w.Date.now = () => nowMs;
  if (env) w.localStorage.setItem(KEY, JSON.stringify(env));
  w.jisuEnvDraw();
  const st = w.jisuEnvPillState();
  const btn = w.document.querySelector('[data-toggle-zone="environment"]');
  st.domAll = !!(btn && btn.classList.contains('env-all'));
  st.domRun = !!(btn && btn.classList.contains('env-run'));
  return st;
}

/* 기대 컷오프: 08~17시 → 오늘 08:00 · 18~23시 → 오늘 18:00 · 00~07시 → 어제 18:00 */
const CASES = [
  { name: '11/26 00:00', now: kst(2026, 11, 26, 0, 0), cut: kst(2026, 11, 25, 18, 0) },
  { name: '11/26 07:59', now: kst(2026, 11, 26, 7, 59), cut: kst(2026, 11, 25, 18, 0) },
  { name: '11/26 08:00', now: kst(2026, 11, 26, 8, 0), cut: kst(2026, 11, 26, 8, 0) },
  { name: '11/26 12:20', now: kst(2026, 11, 26, 12, 20), cut: kst(2026, 11, 26, 8, 0) },
  { name: '11/26 17:59', now: kst(2026, 11, 26, 17, 59), cut: kst(2026, 11, 26, 8, 0) },
  { name: '11/26 18:00', now: kst(2026, 11, 26, 18, 0), cut: kst(2026, 11, 26, 18, 0) },
  { name: '11/26 20:43', now: kst(2026, 11, 26, 20, 43), cut: kst(2026, 11, 26, 18, 0) },
  { name: '11/27 03:10', now: kst(2026, 11, 27, 3, 10), cut: kst(2026, 11, 26, 18, 0) }
];

test('컷오프 계산 — 가장 최근 08:00/18:00(KST) 마감', async () => {
  const { w, dom, errors } = await loadPage(envState([]));
  try {
    const seen = new Set();
    for (const c of CASES) {
      const st = at(w, c.now, envState([]));
      assert.equal(st.cutoffMs, c.cut, c.name + ' 컷오프');
      seen.add(st.cutoffMs);
      assert.equal(st.blue, false, c.name + ' — 완료 건 없으면 파란불 꺼짐');
      assert.equal(st.domAll, false, c.name + ' — env-all 클래스 없음');
    }
    assert.ok(seen.size >= 3, '시간대별로 컷오프가 실제로 움직인다');
    assert.equal(errors.filter(e => !/^error: /.test(e)).length, 0, errors.join(' | '));
  } finally { dom.window.close(); }
});

test('어젯밤 20:43(7,8호기 분체)은 08:00 마감 뒤 꺼지고, 00~07:59 에는 켜진다', async () => {
  const env = envState([{ day: '2026-11-25', td: '오후 8:43', doneAt: DONE_25_2043 }]);
  const { w, dom } = await loadPage(env);
  try {
    /* 어제 어젯밤 완료 → 자정~07:59 컷오프는 어제 18:00 이므로 파란불 */
    for (const c of CASES.filter(x => x.cut === kst(2026, 11, 25, 18, 0))) {
      const st = at(w, c.now, env);
      assert.equal(st.blue, true, c.name + ' — 어제 18시 이후 완료라 파란불');
      assert.equal(st.domAll, true, c.name + ' — env-all 클래스');
      assert.equal(st.domRun, false, c.name + ' — 작업중 없음');
    }
    /* 08:00 이 되면 어젯밤 완료 건은 꺼진다 (수뽕 님이 지적한 11/26 낮 12시 상황) */
    for (const c of CASES.filter(x => x.cut >= kst(2026, 11, 26, 8, 0))) {
      const st = at(w, c.now, env);
      assert.equal(st.blue, false, c.name + ' — 08시 마감 이후 어젯밤 완료 건은 꺼짐');
      assert.equal(st.domAll, false, c.name + ' — env-all 클래스 없음');
    }
  } finally { dom.window.close(); }
});

test('오늘 08:00 이후 완료 건은 켜지고, 18:00 마감에 다시 꺼진다', async () => {
  const env = envState([{ day: '2026-11-26', td: '오전 8:05', doneAt: kst(2026, 11, 26, 8, 5) }]);
  const { w, dom } = await loadPage(env);
  try {
    for (const name of ['11/26 08:00', '11/26 12:20', '11/26 17:59']) {
      const c = CASES.find(x => x.name === name);
      const st = at(w, c.now, env);
      assert.equal(st.blue, true, name + ' — 오늘 08시 이후 완료라 파란불');
      assert.equal(st.domAll, true, name + ' — env-all 클래스');
    }
    for (const name of ['11/26 18:00', '11/26 20:43']) {
      const c = CASES.find(x => x.name === name);
      const st = at(w, c.now, env);
      assert.equal(st.blue, false, name + ' — 18시 마감 뒤 오전 완료 건은 꺼짐');
    }
  } finally { dom.window.close(); }
});

test('경계값 — 08:00 정각·18:00 정각 완료 건은 그 마감 회차에 포함', async () => {
  const env08 = envState([{ day: '2026-11-26', td: '오전 8:00', doneAt: kst(2026, 11, 26, 8, 0) }]);
  const a = await loadPage(env08);
  try {
    assert.equal(at(a.w, kst(2026, 11, 26, 8, 0), env08).blue, true, '08:00 정각 완료 = 08시 회차');
    assert.equal(at(a.w, kst(2026, 11, 26, 18, 0), env08).blue, false, '18시가 되면 08시 회차 종료');
  } finally { a.dom.window.close(); }

  const env18 = envState([{ day: '2026-11-26', td: '오후 6:00', doneAt: kst(2026, 11, 26, 18, 0) }]);
  const b = await loadPage(env18);
  try {
    assert.equal(at(b.w, kst(2026, 11, 26, 18, 0), env18).blue, true, '18:00 정각 완료 = 18시 회차');
    assert.equal(at(b.w, kst(2026, 11, 26, 18, 0) - 1, env18).cutoffMs, kst(2026, 11, 26, 8, 0), '18:00 직전(17:59:59)엔 아직 08시 회차 컷오프');
  } finally { b.dom.window.close(); }
});

test('doneAt 없는 예전 기록은 day+td 로 마감 판정', async () => {
  const legacy = envState([{ day: '2026-11-25', td: '오후 8:43' }]);
  const { w, dom } = await loadPage(legacy);
  try {
    assert.equal(at(w, kst(2026, 11, 26, 7, 59), legacy).blue, true, '07:59 — 어제 18시 이후');
    assert.equal(at(w, kst(2026, 11, 26, 12, 20), legacy).blue, false, '12:20 — 오늘 08시 이전');
  } finally { dom.window.close(); }
});

test('작업중(초록)이 하나라도 있으면 기존처럼 env-run 우선', async () => {
  const env = withWork([{ day: '2026-11-26', td: '오전 9:10', doneAt: kst(2026, 11, 26, 9, 10) }]);
  const { w, dom } = await loadPage(env);
  try {
    const st = at(w, kst(2026, 11, 26, 12, 20), env);
    assert.equal(st.green, true, '청소중 호기 → 초록');
    assert.equal(st.domRun, true, 'env-run 클래스');
    assert.equal(st.blue, false, '초록이 우선이라 파란불 없음');
    assert.equal(st.domAll, false, 'env-all 클래스 없음');
  } finally { dom.window.close(); }
});

test('소스에 옛 18시 전용 컷오프가 남아 있지 않다', () => {
  assert.equal(/last18CutoffMs/.test(html), false, 'last18CutoffMs 잔존');
  assert.equal(/lastShiftCutoffMs/.test(html), true, 'lastShiftCutoffMs 정의');
  assert.ok(!lateErrors.length, '지연 오류: ' + lateErrors.join(' | '));
});
