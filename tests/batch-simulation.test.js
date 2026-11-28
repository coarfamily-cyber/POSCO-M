// 실행: NODE_PATH=<jsdom 설치 경로> node --test tests/batch-simulation.test.js
//        (개별 실행: NODE_PATH=<jsdom 설치 경로> node tests/batch-simulation.test.js JISU/index.html)
// 2026-11-25 수뽕 님 지시 "일괄등록 여러 시나리오로 집중 시뮬레이션, 버그·안 되는 케이스 전부 수정" 회귀 테스트.
// 실제 JISU/index.html 을 jsdom 으로 띄워 #czBatchText 입력 → input 이벤트 → 미리보기/저장까지만 확인한다.
// 가짜 Firebase + 가짜 IndexedDB + fetch 차단: 운영 DB·Web Push·ntfy 로 나가지 않는다(실제 알림 금지).
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeFakeFirebase } = require('./integration/fakefb');
const fidb = require('fake-indexeddb');

const FILE = process.argv[2] && !process.argv[2].endsWith('.test.js') ? process.argv[2] : path.join(__dirname, '..', 'JISU', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 날짜 도우미 (테스트를 어느 날 돌려도 같은 결과가 나오도록 오늘 기준 상대 날짜를 쓴다) ── */
const kstToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function shift(ymd, n) {
  const p = String(ymd).split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const md = ymd => Number(ymd.slice(5, 7)) + '/' + Number(ymd.slice(8, 10));
const koDate = ymd => Number(ymd.slice(5, 7)) + '월 ' + Number(ymd.slice(8, 10)) + '일';
const TODAY = kstToday();
const D1 = shift(TODAY, 1), D2 = shift(TODAY, 2), D3 = shift(TODAY, 3);

async function load(opts = {}) {
  const t0 = Date.now();
  const errors = [], calls = [];
  const vc = new VirtualConsole();
  const envOnly = m => /Not implemented: (HTMLCanvasElement\.prototype\.getContext|window\.scrollTo)/.test(m);
  vc.on('jsdomError', e => { const m = String(e.message || e); if (!envOnly(m)) errors.push('jsdom: ' + m.slice(0, 200)); });
  vc.on('error', (...a) => { const m = a.map(String).join(' '); if (!envOnly(m)) errors.push('error: ' + m.slice(0, 200)); });
  const fake = makeFakeFirebase();
  const dom = new JSDOM(html, {
    url: 'https://jisu.test/POSCO-M/JISU/index.html',
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.firebase = fake.firebase;
      w.indexedDB = fidb.indexedDB;
      ['IDBKeyRange', 'IDBObjectStore', 'IDBIndex', 'IDBCursor', 'IDBCursorWithValue', 'IDBDatabase', 'IDBTransaction', 'IDBRequest', 'IDBOpenDBRequest', 'IDBFactory', 'IDBVersionChangeEvent'].forEach(n => { if (fidb[n]) w[n] = fidb[n]; });
      w.alert = () => {}; w.confirm = opts.confirm === undefined ? true : opts.confirm;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
      w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
      w.scrollTo = () => {};
      w.URL.createObjectURL = () => 'blob:fake-url';
      w.URL.revokeObjectURL = () => {};
      w.Tesseract = { recognize: () => Promise.resolve({ data: { text: '' } }) };
      w.fetch = (u) => { calls.push(String(u)); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') }); };
      w.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} addEventListener() {} };
    }
  });
  await sleep(opts.wait || 1300);
  dom.window.jisuSetBatchView(true);
  if (process.env.BATCHSIM_DEBUG) console.log('loaded in', Date.now() - t0, 'ms');
  return { w: dom.window, dom, errors, calls, fake };
}

/* 텍스트/기본대상을 넣고 미리보기 구조를 읽는다 (앱과 같은 input 이벤트 경로) */
function preview(w, text, target) {
  const doc = w.document;
  if (target) doc.getElementById('czBatchTarget').value = target;
  const t = doc.getElementById('czBatchText');
  t.value = text;
  t.dispatchEvent(new w.Event('input', { bubbles: true }));
  const badge = doc.getElementById('czBatchCountBadge').textContent;
  /* jsdom 영역에서 만든 배열은 프로토타입이 달라 deepEqual 이 어긋난다 — 이 영역의 값으로 복사한다 */
  const data = JSON.parse(JSON.stringify(w.jisuBatchPreviewData() || []));
  const warn = doc.querySelector('#czBatchPreview .cz-batch-warn');
  const empty = doc.querySelector('#czBatchPreview .cz-empty');
  const rows = data.flatMap(g => (g.items || []).map(it => ({ date: g.date, target: it.target, kind: it.kind, text: it.text, urgent: !!it.urgent })));
  return { badge, rows, warn: warn ? warn.textContent : '', empty: empty ? empty.textContent.trim() : '', raw: data };
}
const zones = p => p.rows.map(r => (p.w && 0, r.target));
function briefRows(w, p) {
  // 화면에 보이는 구역 이름표(NAMES)로 바꿔 비교한다
  return p.rows.map(r => ({ date: r.date, zone: label(w, r.target), kind: r.kind, text: r.text }));
}
let NAME_CACHE = null;
function label(w, target) {
  if (!NAME_CACHE) {
    NAME_CACHE = {};
    [...w.document.querySelectorAll('#cmdTarget option')].forEach(o => { if (o.value) NAME_CACHE[o.value] = o.textContent; });
    Object.assign(NAME_CACHE, w.JISU_SUB_LABELS || {});
    NAME_CACHE['*'] = '전체';
  }
  return NAME_CACHE[target] || target;
}
function expectRows(w, p, list) {
  const got = briefRows(w, p).map(r => [r.date, r.zone, r.kind, r.text].join(' | '));
  const want = list.map(r => [r.date || TODAY, label(w, r.zone), r.kind || 'instruction', r.text].join(' | '));
  assert.deepEqual(got, want);
}

function saveBatch(w, text, target) {
  preview(w, text, target);
  w.document.getElementById('czBatchSaveBtn').click();
  const read = k => { try { return JSON.parse(w.localStorage.getItem(k) || '[]'); } catch (_) { return []; } };
  return { sch: read('jisu-schedule-v1'), cmds: read('jisu-commands-v1'), memos: read('jisu-memos-v1') };
}

/* ─────────────────────────── A. 날짜 헤더 · 기간 · 해 넘김 ─────────────────────────── */
test('A. 날짜 헤더·기간·해 넘김·전각/없는 날짜', async () => {
  const p = await load();
  const w = p.w;
  try {
    let r = preview(w, `${koDate(D1)}\n입고 사각박스 640EA`);
    expectRows(w, r, [{ date: D1, zone: 'inbound', text: '사각박스 640 EA' }]);

    r = preview(w, `${md(D1)}\n입고 사각박스 640EA`);
    expectRows(w, r, [{ date: D1, zone: 'inbound', text: '사각박스 640 EA' }]);

    r = preview(w, `${D1.replace(/-/g, '.')}\n입고 사각박스 640EA`);
    expectRows(w, r, [{ date: D1, zone: 'inbound', text: '사각박스 640 EA' }]);

    // 요일만 적힌 줄은 작업이 아니다 — 예전에는 오늘 카드 '(목)' 이 생겼다
    r = preview(w, '11/26 대신 (목)\n입고 사각박스 640EA'.replace('11/26 대신 ', ''));
    assert.deepEqual(r.rows.map(x => x.text), ['사각박스 640 EA']);
    assert.deepEqual(r.rows.map(x => x.date), [TODAY]);

    // 날짜 + 요일 / 요일 + 날짜
    r = preview(w, `${md(D1)}(목) 입고 사각박스 640EA`);
    expectRows(w, r, [{ date: D1, zone: 'inbound', text: '사각박스 640 EA' }]);
    r = preview(w, `(목) ${md(D1)} 입고 사각박스 640EA`);
    expectRows(w, r, [{ date: D1, zone: 'inbound', text: '사각박스 640 EA' }]);

    // 번호 목록의 날짜가 '1월 11일'로 잘못 읽히지 않는다
    r = preview(w, `1. ${md(D1)} 입고 사각박스 640EA`);
    expectRows(w, r, [{ date: D1, zone: 'inbound', text: '사각박스 640 EA' }]);

    // 범위: 시작~끝, 월 넘김, 해 넘김
    /* 오늘 날짜가 월말이면 D3 가 다음 달로 넘어가 '11/29~1' 이 월 범위가 되어 버린다 —
       같은 달 안의 범위는 그 달 5일에서 석 달 연속 날짜로 고정한다(달력에 따라 흔들리지 않게). */
    const R1 = TODAY.slice(0, 7) + '-05', R2 = shift(R1, 1), R3 = shift(R1, 2);
    r = preview(w, `${md(R1)}~${Number(md(R3).split('/')[1])}\n입고 사각박스 640EA`);
    assert.deepEqual(r.rows.map(x => x.date), [R1, R2, R3]);

    r = preview(w, '11/28~12/2\n입고 사각박스 640EA');
    const expectNov = ['11-28', '11-29', '11-30', '12-01', '12-02'].map(x => x);
    assert.equal(r.rows.length, 5);
    assert.deepEqual(r.rows.map(x => x.date.slice(5)), expectNov);

    const y = Number(TODAY.slice(0, 4));
    r = preview(w, '12/29~1/3\n입고 사각박스 640EA');
    assert.equal(r.rows.length, 6);
    assert.equal(r.rows[0].date, `${y}-12-29`);
    assert.equal(r.rows[5].date, `${y + 1}-01-03`);

    r = preview(w, `${y}/12/30~${y + 1}/1/2\n입고 사각박스 640EA`);
    assert.deepEqual(r.rows.map(x => x.date), [`${y}-12-30`, `${y}-12-31`, `${y + 1}-01-01`, `${y + 1}-01-02`]);

    // 부터~까지 — 끝 '까지'가 작업 카드로 남지 않는다
    r = preview(w, `${koDate(D1)}부터 ${koDate(D3)}까지\n입고 사각박스 640EA`);
    assert.deepEqual(r.rows.map(x => x.date), [D1, D2, D3]);
    assert.deepEqual(r.rows.map(x => x.text), ['사각박스 640 EA', '사각박스 640 EA', '사각박스 640 EA']);

    r = preview(w, `${md(D1)} - ${md(D3)}\n입고 사각박스 640EA`);
    assert.deepEqual(r.rows.map(x => x.date), [D1, D2, D3]);

    // 쉼표로 여러 날짜
    r = preview(w, `${md(D1)}, ${md(D2)} 입고 사각박스 640EA`);
    expectRows(w, r, [{ date: D1, zone: 'inbound', text: '사각박스 640 EA' }, { date: D2, zone: 'inbound', text: '사각박스 640 EA' }]);

    // 없는 날짜 — 글자를 오늘 작업으로 등록하지 않고 경고
    r = preview(w, '11/32\n입고 사각박스 640EA');
    assert.deepEqual(r.rows.map(x => [x.date, x.text]), [[TODAY, '사각박스 640 EA']]);
    assert.match(r.warn, /없는 날짜/);
    r = preview(w, '2027/2/29\n입고 사각박스 640EA');
    assert.deepEqual(r.rows.map(x => [x.date, x.text]), [[TODAY, '사각박스 640 EA']]);
    assert.match(r.warn, /없는 날짜/);

    // 기간 뒤에 없는 날짜가 와도 그 기간 날짜들로 복사되지 않는다 (오늘 한 번만)
    r = preview(w, `${md(D1)}~${md(D3)}\n입고 사각박스 640EA\n11/32\n입고 확인용 10EA`);
    assert.deepEqual(r.rows.map(x => x.date), [TODAY, D1, D2, D3]);
    assert.deepEqual(r.rows.filter(x => x.text === '확인용 10 EA').map(x => x.date), [TODAY]);
    assert.match(r.warn, /없는 날짜/);

    // 분수·설비 표기는 날짜가 아니다
    r = preview(w, '1/2호기 청소 09:00');
    assert.deepEqual(r.rows.map(x => x.text), ['1/2호기 청소 09:00']);

    // 전각 문자·끝 슬래시
    r = preview(w, `${md(D1).replace('/', '／').replace(/\d/g, d => '０１２３４５６７８９'[+d])}\n입고 사각박스 ６４０ＥＡ`);
    expectRows(w, r, [{ date: D1, zone: 'inbound', text: '사각박스 640 EA' }]);
    r = preview(w, `${md(D1)}/\n입고 사각박스 640EA`);
    expectRows(w, r, [{ date: D1, zone: 'inbound', text: '사각박스 640 EA' }]);

    assert.deepEqual(p.errors, []);
  } finally { p.dom.window.close(); }
});

/* ─────────────────────────── B. 구역 표기 · 다중 구역 · 이동 ─────────────────────────── */
test('B. 구역 표기·다중 구역·이동 작업·머리 기호', async () => {
  const p = await load();
  const w = p.w;
  const D = koDate(D1);
  const one = (line, zone, text) => {
    const r = preview(w, `${D}\n${line}`);
    expectRows(w, r, [{ date: D1, zone, text }]);
  };
  try {
    one('입고 사각박스 640EA', 'inbound', '사각박스 640 EA');
    one('출고 12가3456 660 KG / 20 P', 'outbound', '12가3456 660 KG / 20 P');
    one('포장 12EA', 'packaging', '12 EA');
    one('포장1 12EA', 'packaging', '1라인 12 EA');
    one('포장2 12EA', 'packaging', '2라인 12 EA');
    one('피치 50t', 'pitch', '50 TON');
    one('환경 1,2호기 청소', 'environment', '1,2호기 청소');
    one('환경1호기 청소 09:00', 'environment', '1호기 청소 09:00');
    one('환경 메인통로 2호기 청소', 'environment', '메인통로 2호기 청소');
    one('생산A 100EA', 'production-a', '100 EA');
    one('생산c 30EA', 'production-c', '30 EA');
    one('생산H 900EA', 'production-h', '900 EA');
    one('창고 정리 2시간', 'W', '정리 2시간');
    one('2동 20 TON', '2', '20 TON');
    // '전체' 는 공지로 등록된다 (단일 등록의 HOME 공지와 같은 규칙)
    const all = preview(w, `${D}\n전체 안전점검 있습니다`);
    assert.deepEqual(all.rows.map(x => [x.target, x.kind, x.text]), [['*', 'notice', '안전점검 있습니다']]);

    // 이동 작업 — 출발 동을 대상으로, 글자는 그대로
    one('1동→2동 30 TON', '1', '1동→2동 30 TON');
    one('3동 -> 1동 15 TON', '3', '3동 -> 1동 15 TON');
    one('출고 2동→3동 20 TON', 'outbound', '2동→3동 20 TON');

    // 공장간 이송은 출고/입고의 하위 대상
    one('2공장→1공장 20 TON', 'outbound:2공장→1공장', '2공장→1공장 20 TON');
    one('1공장→2공장 30 TON', 'inbound:1공장→2공장', '1공장→2공장 30 TON');
    one('출고 2공장→1공장 20 TON', 'outbound:2공장→1공장', '2공장→1공장 20 TON');

    // 여러 동을 한 줄에 — 물량을 두 배로 만들지 않고 첫 동에 한 건
    one('2~3동 20 TON', '2', '2~3동 20 TON');
    one('1, 2동 20 TON', '1', '1, 2동 20 TON');
    one('1동, 2동 20 TON', '1', '1동, 2동 20 TON');

    // 대괄호 구역
    one('[출고] RAS-2 20 TON', 'outbound', 'RAS-2 20 TON');
    one('(입고) 사각박스 640EA', 'inbound', '사각박스 640 EA');

    // 불릿·번호·탭·이모지·전각 공백
    let r = preview(w, `${D}\n1. 입고 사각박스 640EA\n② 출고 12가3456 20 TON\n- 포장 12EA\n* 피치 50t\n• 환경 1호기 청소\n### 공지 안전점검\n▶ 생산C 30EA`);
    assert.deepEqual(r.rows.map(x => [x.target, x.kind, x.text]), [
      ['inbound', 'instruction', '사각박스 640 EA'],
      ['outbound', 'instruction', '12가3456 20 TON'],
      ['packaging', 'instruction', '12 EA'],
      ['pitch', 'instruction', '50 TON'],
      ['environment', 'instruction', '1호기 청소'],
      ['*', 'notice', '안전점검'],
      ['production-c', 'instruction', '30 EA']
    ]);
    r = preview(w, `${D}\n입고\t사각박스\t640EA`);
    expectRows(w, r, [{ date: D1, zone: 'inbound', text: '사각박스 640 EA' }]);
    r = preview(w, `${D}\n입고　사각박스　640EA`);
    expectRows(w, r, [{ date: D1, zone: 'inbound', text: '사각박스 640 EA' }]);
    r = preview(w, `${D}\n📦 입고 사각박스 640EA`);
    expectRows(w, r, [{ date: D1, zone: 'inbound', text: '사각박스 640 EA' }]);

    assert.deepEqual(p.errors, []);
  } finally { p.dom.window.close(); }
});

/* ─────────────────────────── C. 수량 · 톤수 · 오전/오후 ─────────────────────────── */
test('C. 수량·톤수·배차·오전/오후', async () => {
  const p = await load();
  const w = p.w;
  const D = koDate(D1);
  const text = line => preview(w, `${D}\n${line}`).rows[0].text;
  try {
    assert.equal(text('입고 1,200 kg'), '1,200 KG');
    assert.equal(text('입고 1,200,000원'), '1,200,000원');
    assert.equal(text('출고 660 KG / 20 P'), '660 KG / 20 P');
    assert.equal(text('출고 54 TON'), '54 TON');
    assert.equal(text('출고 0.5 TON'), '0.5 TON');
    assert.equal(text('피치 1.5배'), '1.5배');
    assert.equal(text('입고 라스톤백 400 EA'), '라스톤백 400 EA');
    assert.equal(text('입고 16 KG 파렛트 2대'), '16 KG 파렛트 2대');
    assert.equal(text('입고 1,200 TON'), '1,200 TON');
    assert.equal(text('입고 사각박스'), '사각박스');

    // 줄이 나뉜 오전/오후는 두 작업으로 나눈다 (한 줄에 쉼표로 붙은 경우는 원문 그대로 둔다 — 시간 표기 오탐 방지 규칙)
    let r = preview(w, `${D}\n출고 20 TON 오전, 30 TON 오후`);
    assert.deepEqual(r.rows.map(x => x.text), ['20 TON 오전, 30 TON 오후']);
    r = preview(w, `${D}\n출고 20 TON 오전\n출고 30 TON 오후`);
    assert.deepEqual(r.rows.map(x => x.text), ['20 TON 오전', '30 TON 오후']);

    // 배차 두 건: 카드마다 자기 물량만 (묶음 합계가 모든 카드에 붙지 않는다)
    const s = saveBatch(w, `${md(D1)}\n출고 12가3456 660 KG / 20 P\n출고 34나5678 660 KG / 15 P`);
    const tons = s.sch.filter(x => x.target === 'outbound').map(x => x.tonText);
    assert.deepEqual(tons, ['1대 · 13.2 TON', '1대 · 9.9 TON']);

    // 사각박스·공지에는 톤수가 붙지 않는다 (예전에는 날짜 묶음 합계 13.2 TON 이 전부에 붙었다)
    const s2 = saveBatch(w, `오늘\n입고 사각박스 100EA\n[공지] 내일 안전점검\n출고 12가3456 660 KG / 20 P`);
    const base = s2.cmds.filter(x => x.id !== 'demo_dispatch_1');
    assert.equal(base.find(x => x.target === 'inbound').tonText, undefined);
    assert.equal(base.find(x => x.kind === 'notice').tonText, undefined);
    assert.equal(base.find(x => x.target === 'outbound').tonText, '1대 · 13.2 TON');
    assert.deepEqual(p.errors, []);
  } finally { p.dom.window.close(); }
});

/* ─────────────────────────── D. 분류 · 중복 · 안전한 글자 ─────────────────────────── */
test('D. 공지/특이사항/긴급 분류·중복·XSS 글자', async () => {
  const p = await load();
  const w = p.w;
  const D = koDate(D1);
  const rows = line => preview(w, `${D}\n${line}`).rows;
  try {
    let r = rows('[공지] 내일 안전점검 있습니다');
    assert.deepEqual([r[0].target, r[0].kind, r[0].text], ['*', 'notice', '내일 안전점검 있습니다']);
    r = rows('공지: 내일 안전점검 있습니다');
    assert.deepEqual([r[0].target, r[0].kind, r[0].text], ['*', 'notice', '내일 안전점검 있습니다']);
    r = rows('* 특이사항 도색 냄새 심함');
    assert.deepEqual([r[0].kind, r[0].text], ['memo', '도색 냄새 심함']);
    r = rows('특이사항: 도색 냄새 심함');
    assert.deepEqual([r[0].kind, r[0].text], ['memo', '도색 냄새 심함']);
    r = rows('특이사항 2동 소음 심함');
    assert.deepEqual([r[0].target, r[0].kind, r[0].text], ['2', 'memo', '소음 심함']);
    r = rows('[긴급] 1호기 정지');
    assert.deepEqual([r[0].target, r[0].urgent, r[0].text], ['inbound', true, '1호기 정지']);
    r = rows('! 출고 12가3456 20 TON');
    assert.deepEqual([r[0].target, r[0].urgent, r[0].text], ['outbound', true, '12가3456 20 TON']);
    r = rows('출고 공지 내일 휴무');
    assert.deepEqual([r[0].target, r[0].kind, r[0].text], ['outbound', 'notice', '내일 휴무']);
    // 내용 없는 '특이사항' 줄은 등록하지 않는다
    assert.equal(preview(w, `${D}\n특이사항`).rows.length, 0);

    // 같은 줄이 두 번 → 미리보기 1건 (저장도 1건)
    r = preview(w, `${D}\n입고 사각박스 640EA\n입고 사각박스 640EA`);
    assert.equal(r.rows.length, 1);
    assert.match(r.warn, /같은 내용/);

    // XSS 글자는 화면에 글자로만 (태그로 실행되지 않는다)
    r = preview(w, `${D}\n입고 <img src=x onerror="window.__xss=1"> 사각박스 640EA`);
    const pv = w.document.getElementById('czBatchPreview');
    assert.equal(pv.querySelector('img'), null);
    assert.deepEqual(p.errors, []);
  } finally { p.dom.window.close(); }
});

/* ─────────────────────────── E. 저장 · 08시 반영 · 사진 · 상태 초기화 ─────────────────────────── */
test('E. 저장·즉시 반영·중복 방지·사진 1장·모달 초기화', async () => {
  const p = await load();
  const w = p.w;
  const doc = w.document;
  try {
    // 미래 날짜 범위 → jisu-schedule-v1 에 날짜별로, 아직 적용 전
    let s = saveBatch(w, `${md(D1)}~${md(D3)}\n입고 사각박스 640EA`);
    assert.deepEqual(s.sch.map(x => x.date), [D1, D2, D3]);
    assert.deepEqual(s.sch.map(x => !!x.applied), [false, false, false]);
    assert.equal(s.cmds.length, 1, '오늘 카드가 아니므로 금일작업엔 들어가지 않는다');

    // 같은 예약을 다시 저장해도 두 번 쌓이지 않는다
    s = saveBatch(w, `${md(D1)}~${md(D3)}\n입고 사각박스 640EA`);
    assert.equal(s.sch.length, 3);
    assert.match(doc.getElementById('czMsg').textContent, /이미 예약된 3건/);

    // 오늘 날짜 → 즉시 금일작업 반영 (작업지시 저장은 녹색 깜빡임을 울리지 않는다 — 2026-11-26 2차 지시)
    s = saveBatch(w, `오늘\n입고 사각박스 100EA`);
    const todayCmd = s.cmds.find(x => x.id !== 'demo_dispatch_1');
    assert.ok(todayCmd, '오늘 카드가 금일작업에 들어간다');
    assert.equal(todayCmd.day, TODAY);
    const flashed = [...doc.querySelectorAll('#mapStage [data-toggle-zone].st-flash-green')].map(e => e.getAttribute('data-toggle-zone'));
    assert.deepEqual(flashed, [], '작업지시 저장에는 깜빡이지 않아야 한다(특이사항·사진만): ' + flashed.join(','));

    // 오늘 같은 작업을 다시 등록하는 것은 허용 (이미 적용된 카드는 중복으로 보지 않는다)
    const before = s.cmds.length;
    s = saveBatch(w, `오늘\n입고 사각박스 100EA`);
    assert.equal(s.cmds.length, before + 1);

    // 오늘 특이사항 → jisu-memos-v1 (특이사항은 새 항목이 생긴 것이므로 그 구역이 깜빡인다)
    s = saveBatch(w, `오늘\n특이사항 도색 냄새`);
    assert.ok(s.memos.some(m => m.text === '도색 냄새' && m.day === TODAY));

    // 사진은 범위 전체에서 1장만 저장
    w.jisuResizeImageFile = () => Promise.resolve('data:image/jpeg;base64,AAA');
    const ev = new w.Event('paste', { bubbles: true, cancelable: true });
    ev.clipboardData = { items: [{ type: 'image/png', getAsFile: () => new w.File(['x'], 'a.png', { type: 'image/png' }) }] };
    doc.getElementById('czBatchText').dispatchEvent(ev);
    await sleep(150);
    s = saveBatch(w, `${md(shift(TODAY, 5))}~${md(shift(TODAY, 7))}\n출고 12가3456 660 KG / 20 P`);
    const ranged = s.sch.filter(x => x.date >= shift(TODAY, 5) && x.date <= shift(TODAY, 7));
    assert.equal(ranged.length, 3);
    assert.equal(ranged.filter(x => !!x.img).length, 1, '사진은 날짜 수만큼 복사되지 않는다');

    // 저장 뒤 모달을 닫았다 열면 입력·미리보기 건수가 초기화
    w.jisuSetBatchView(false); w.jisuSetBatchView(true);
    assert.equal(doc.getElementById('czBatchText').value, '');
    assert.equal(doc.getElementById('czBatchCountBadge').textContent, '0건');

    // 지난 날짜는 확인을 거부하면 저장하지 않는다
    const p2 = await load({ confirm: false });
    try {
      const s2 = saveBatch(p2.w, `${md(shift(TODAY, -3))}\n입고 사각박스 640EA`);
      assert.equal(s2.sch.length, 0);
    } finally { p2.dom.window.close(); }
    assert.deepEqual(p.errors, []);
  } finally { p.dom.window.close(); }
});

/* ─────────────────────────── F. 미리보기에서 체크 해제 · 구역 변경 ─────────────────────────── */
test('F. 미리보기 체크 해제·구역 변경 후 저장', async () => {
  const p = await load();
  const w = p.w;
  const doc = w.document;
  try {
    const text = `${md(D1)}\n입고 사각박스 640EA\n출고 12가3456 20 TON\n포장 12EA`;
    let r = preview(w, text);
    assert.equal(r.rows.length, 3);
    const boxes = [...doc.querySelectorAll('#czBatchPreview .cz-batch-ck')];
    assert.equal(boxes.length, 3, '항목마다 체크 박스가 있다');
    // 두 번째(출고) 항목 체크 해제
    boxes[1].checked = false;
    boxes[1].dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.match(doc.getElementById('czBatchCountBadge').textContent, /^2건/);
    assert.match(doc.getElementById('czBatchSaveBtn').textContent, /2건/);
    // 세 번째(포장) 항목 구역을 피치로 변경
    const sel = doc.querySelectorAll('#czBatchPreview .cz-batch-zone')[2];
    sel.value = 'pitch';
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    let s = saveBatch(w, text);
    const mine = s.sch.filter(x => x.date === D1);
    assert.deepEqual(mine.map(x => x.target), ['inbound', 'pitch'], '체크 푼 출고는 빠지고, 포장은 피치로 바뀐다');
    assert.deepEqual(mine.map(x => x.text), ['사각박스 640 EA', '12 EA']);

    // 저장 뒤에는 편집 상태가 초기화된다
    r = preview(w, text);
    assert.equal(r.rows.length, 3);
    assert.ok([...doc.querySelectorAll('#czBatchPreview .cz-batch-ck')].every(b => b.checked));
    assert.deepEqual(p.errors, []);
  } finally { p.dom.window.close(); }
});
