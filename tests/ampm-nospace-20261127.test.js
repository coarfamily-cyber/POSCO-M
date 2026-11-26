// 실행: NODE_PATH=<jsdom 설치 경로> node --test tests/ampm-nospace-20261127.test.js
//        (개별 실행: NODE_PATH=<jsdom 설치 경로> node tests/ampm-nospace-20261127.test.js JISU/index.html)
// 2026-11-27 수뽕 님 화면: 입고 카드 "오전 HH 54 TON, 오후HH 36 TON" 이 두 작업으로 나뉘지 않음.
//   · '오후' 바로 뒤에 공백 없이 영문·숫자가 붙으면(오후HH·오후JH·오후L1·오후RAS-2) 라벨로 인정 — 공백을 보정해 "오후 HH ..." 로 분리
//   · 한글 조사·어미가 붙은 '오전에'·'오후까지'·'오전중'·'오후반' 은 라벨이 아니다 (기존대로)
//   · 시간만 적힌 토막('오전 10시~ 오후 2시~')·공지(kind==='notice')는 나누지 않는다
//   · 이미 저장된 항목도 페이지가 열릴 때(jisuNormalizeAmPm) 자동으로 두 카드가 된다
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
const SKEY = 'jisu-schedule-v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const md = today.slice(5, 7) + '. ' + today.slice(8, 10) + '.';

const plain = x => JSON.parse(JSON.stringify(x));   /* jsdom 다른 realm 배열 → 이 realm 값으로 */
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

/* index.html 안의 오전/오후 분리 함수만 떼어내 node 에서 그대로 돌린다 */
function loadSplitter() {
  const b = html.indexOf('window.jisuAmPmSplitText');
  const e = html.indexOf('window.jisuExpandAmPmItems');
  if (b < 0 || e < 0) throw new Error('am/pm block not found');
  const fn = new Function('window', html.slice(b, e) + '\nreturn window.jisuAmPmSplitText;');
  return fn({});
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
      w.__jisuClosed = false; w.__jisuTimers = new Set();
      const _st = w.setTimeout.bind(w), _si = w.setInterval.bind(w);
      w.setTimeout = (fn, ms, ...a) => { const id = _st(() => { w.__jisuTimers.delete(id); if (!w.__jisuClosed) fn(...a); }, ms); w.__jisuTimers.add(id); return id; };
      w.setInterval = (fn, ms, ...a) => { const id = _si(() => { if (!w.__jisuClosed) fn(...a); }, ms); w.__jisuTimers.add(id); return id; };
      Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
    }
  });
  opened.push(dom.window);
  await sleep(1600);
  return { w: dom.window, dom, fake, errors };
}

/* ───────────────────────── 1. 분리 규칙 (단위) ───────────────────────── */
test('공백 없는 오전·오후 라벨도 두 작업으로 나눈다', () => {
  const split = loadSplitter();
  const cases = [
    ['오전 HH 54 TON, 오후HH 36 TON', ['오전 HH 54 TON', '오후 HH 36 TON']],
    ['오전HH 54 TON, 오후HH 36 TON', ['오전 HH 54 TON', '오후 HH 36 TON']],
    ['오전 JH 18 TON, 오후JH 18 TON', ['오전 JH 18 TON', '오후 JH 18 TON']],
    ['오전L1 4 TON, 오후L1 2 TON', ['오전 L1 4 TON', '오후 L1 2 TON']],
    ['오전 RAS-2 8 TON, 오후RAS-2 6 TON', ['오전 RAS-2 8 TON', '오후 RAS-2 6 TON']],
    ['오전 4PLT, 오후2PLT', ['오전 4PLT', '오후 2PLT']]
  ];
  for (const [src, want] of cases) assert.deepEqual(split(src, null), want, src);
});

test('한글이 바로 붙은 조사·어미는 라벨이 아니다 · 시간만·공지는 나누지 않는다', () => {
  const split = loadSplitter();
  const keep = ['출고 오전에 하지마', '오전에 피치 오후에 출고', '오전까지 대기, 오후부터 작업',
                '오전중 점검, 오후반 근무', '오전 10시~ 오후 2시~', '오전10시~ 오후2시~', '출고 20 TON 오전, 30 TON 오후'];
  for (const src of keep) assert.deepEqual(split(src, null), [src], src);
  assert.deepEqual(split('오전 공지 오후 공지', 'notice'), ['오전 공지 오후 공지'], '공지는 나누지 않는다');
});

test('이미 나뉜 글자를 다시 나누지 않는다(반복 실행 안전)', () => {
  const split = loadSplitter();
  const once = split('오전 HH 54 TON, 오후HH 36 TON', null);
  assert.deepEqual(split(once[0], null), ['오전 HH 54 TON']);
  assert.deepEqual(split(once[1], null), ['오후 HH 36 TON']);
});

test('jisuExpandAmPmItems — 일괄등록 미리보기에서도 두 줄로 펼쳐진다', async () => {
  const p = await loadPage({});
  try {
    const out = plain(p.w.eval(`window.jisuExpandAmPmItems([{id:'b1',target:'inbound',kind:'instruction',text:'오전 HH 54 TON, 오후HH 36 TON',tonText:'90 TON'},{id:'b2',target:'*',kind:'notice',text:'오전 공지 오후 공지'}])`));
    assert.deepEqual(out.map(x => x.text), ['오전 HH 54 TON', '오후 HH 36 TON', '오전 공지 오후 공지']);
    assert.equal(out[0].tonText, '90 TON', '첫 항목이 톤수·사진을 가진다');
    assert.equal(out[1].tonText, undefined, '둘째 항목에는 톤수가 붙지 않는다');
  } finally { softClose(p.w); }
});

/* ───────────────── 2. 이미 저장된 항목 — 페이지가 열릴 때 자동 분리 ───────────────── */
test('이미 저장된 "오전 HH 54 TON, 오후HH 36 TON" 카드가 열 때 두 카드로 바뀐다', async () => {
  const bug = { id: 'a1', target: 'inbound', kind: 'instruction', text: '오전 HH 54 TON, 오후HH 36 TON', at: md + ' 08:00', day: today };
  const closed = { id: 'c1', target: 'inbound', kind: 'instruction', text: '오전 HH 54 TON, 오후HH 36 TON', at: md + ' 08:00', day: today, closed: true };
  const notice = { id: 'n1', target: '*', kind: 'notice', text: '오전 공지 오후 공지', at: md + ' 08:00', day: today };
  const p = await loadPage({ [KEY]: JSON.stringify([bug, closed, notice]) });
  try {
    const arr = JSON.parse(p.w.localStorage.getItem(KEY) || '[]');
    const byId = Object.fromEntries(arr.map(x => [x.id, x]));
    assert.ok(byId['a1'] && byId['a1-1'], '두 카드로 저장되지 않았다: ' + JSON.stringify(arr.map(x => x.id)));
    assert.equal(byId['a1'].text, '오전 HH 54 TON');
    assert.equal(byId['a1-1'].text, '오후 HH 36 TON');
    assert.equal(byId['a1-1'].day, today, '같은 날 카드');
    assert.equal(byId['c1'].text, '오전 HH 54 TON, 오후HH 36 TON', '마감(closed)된 지난 기록은 건드리지 않는다');
    assert.equal(byId['n1'].text, '오전 공지 오후 공지', '공지는 나누지 않는다');

    const texts = [...p.w.document.querySelectorAll('.cmd-item .cmd-text')].map(e => e.textContent.trim()).filter(t => /HH/.test(t));
    assert.ok(texts.includes('오전 HH 54 TON'), '화면에 오전 카드가 없다: ' + JSON.stringify(texts));
    assert.ok(texts.includes('오후 HH 36 TON'), '화면에 오후 카드가 없다: ' + JSON.stringify(texts));
    const inboundCards = [...p.w.document.querySelectorAll('#hotspot-inbound .cmd-item')].length;
    assert.ok(inboundCards >= 2, '입고 구역 카드가 두 장이 아니다: ' + inboundCards);
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

test('열 때 나눈 결과가 Firebase 에도 두 건으로 올라간다 (다른 기기·새로고침도 같은 모양)', async () => {
  const bug = { id: 'a1', target: 'inbound', kind: 'instruction', text: '오전 HH 54 TON, 오후HH 36 TON', at: md + ' 08:00', day: today };
  const p = await loadPage({ [KEY]: JSON.stringify([bug]) }, [bug]);
  try {
    /* 서버에도 합쳐진 카드가 있는 상태 → 페이지가 나눈 결과가 DB(jisu/state)와 구역 사본(jisu/zones)에 올라가야 한다 */
    let arr = null;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const srv = p.fake.getServer('jisu/state/' + KEY);
      try { arr = JSON.parse(srv && srv.v); } catch (_) { arr = null; }
      if (arr && arr.length > 1) break;
    }
    assert.deepEqual((arr || []).map(x => x && x.text), ['오전 HH 54 TON', '오후 HH 36 TON'],
      '서버 카드가 아직 합쳐져 있다: ' + JSON.stringify(arr));
    const zone = p.fake.getServer('jisu/zones/inbound/commands') || {};
    const ztexts = Object.values(zone).map(x => x && x.text);
    assert.ok(ztexts.includes('오전 HH 54 TON') && ztexts.includes('오후 HH 36 TON'),
      '구역 사본에 두 카드가 없다: ' + JSON.stringify(zone));
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

/* ───────────────────── 3. 새로 등록할 때 — 입력 그대로 두 카드 ───────────────────── */
test('금일작업 등록창에 "오전 HH 54 TON, 오후HH 36 TON" → 두 건 저장·두 카드 표시', async () => {
  const p = await loadPage({});
  try {
    p.w.eval(`(()=>{
      const sel=document.getElementById('cmdTarget'); sel.value='inbound'; sel.dispatchEvent(new Event('change',{bubbles:true}));
      const t=document.getElementById('cmdText'); t.value='오전 HH 54 TON, 오후HH 36 TON'; t.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('cmdSubmit').click();
    })()`);
    await sleep(400);
    const arr = JSON.parse(p.w.localStorage.getItem(KEY) || '[]').filter(x => x.target === 'inbound');
    assert.deepEqual(arr.map(x => x.text), ['오전 HH 54 TON', '오후 HH 36 TON'], JSON.stringify(arr));
    assert.ok(/^.+-\d+$/.test(arr[1].id) && arr[1].id.startsWith(arr[0].id), '둘째 카드 id 는 첫 카드 id + -1: ' + arr[1].id);
    assert.equal(arr[0].target, arr[1].target, '같은 구역');
    const texts = [...p.w.document.querySelectorAll('#hotspot-inbound .cmd-item .cmd-text')].map(e => e.textContent.trim());
    assert.deepEqual(texts.slice().sort(), ['오전 HH 54 TON', '오후 HH 36 TON'].sort(), JSON.stringify(texts));
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

/* ──────────────── 4. 예약(스케줄) 쪽도 같은 규칙 — 달력 저장 시 ──────────────── */
test('예약 저장도 "오후HH" 를 두 건으로 나눈다', async () => {
  const p = await loadPage({});
  try {
    const out = plain(p.w.eval(`window.jisuAmPmSplitText('오전 JH 18 TON, 오후JH 18 TON','schedule')`));
    assert.deepEqual(out, ['오전 JH 18 TON', '오후 JH 18 TON']);
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
    if (lateErrors.length) console.log('닫힌 페이지의 늦은 거부(무시): ' + lateErrors.length + '건');
  } finally { softClose(p.w); }
});
