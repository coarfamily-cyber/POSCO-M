// 실행: NODE_PATH=<jsdom 설치 경로> node tests/daily-report-20261126.test.js JISU/index.html
// 2026-11-26 지시: ① 일일보고서 엑셀을 수뽕 님 지정 17시트 양식 그대로 ② 일간·주간·월간 보고서는
// 자동으로 받지 않고 다운로드 전 확인 요청을 거친다. jsdom + 가짜 Firebase + 가짜 IndexedDB.
// 네트워크·운영 DB·푸시 서버로 나가지 않는다.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeFakeFirebase } = require('./integration/fakefb');

const FILE = process.argv[2] || path.join(__dirname, '..', 'JISU', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const todayKst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const mdKst = todayKst.slice(5, 7) + '. ' + todayKst.slice(8, 10) + '.';

const results = [];
function ok(name, fn) {
  try { fn(); results.push('PASS ' + name); console.log('PASS ' + name); }
  catch (e) { results.push('FAIL ' + name + ' :: ' + (e && e.message ? e.message : e)); console.log(results[results.length - 1]); }
}
async function okAsync(name, fn) {
  try { await fn(); results.push('PASS ' + name); console.log('PASS ' + name); }
  catch (e) { results.push('FAIL ' + name + ' :: ' + (e && e.message ? e.message : e)); console.log(results[results.length - 1]); }
}

const lateErrors = [];
process.on('unhandledRejection', e => lateErrors.push(String((e && e.message) || e).slice(0, 200)));

async function loadPage({ seed, before, wait = 1500 } = {}) {
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
      /* 다운로드 감시: <a download> 클릭을 기록만 한다 (jsdom 내비게이션 대체) */
      w.__downloads = [];
      w.TextEncoder = w.TextEncoder || TextEncoder;
      w.TextDecoder = w.TextDecoder || TextDecoder;
      w.URL.createObjectURL = () => 'blob:jisu-test';
      w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = function () {
        if (this.hasAttribute('download')) w.__downloads.push(this.getAttribute('download'));
      };
      /* XLSX(입고 일지) — CDN 대신 가짜 */
      w.__xlsxWriteFile = [];
      Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
      if (before) before(w);
    }
  });
  await sleep(wait);
  return { w: dom.window, dom, errors };
}

const CMD = (o) => JSON.stringify(o);
const seedWork = {
  'jisu-commands-v1': JSON.stringify([
    { id: 'c1', target: 'outbound:RAS-2', kind: 'instruction', text: 'RAS-2 660 KG 16 P (10.56 TON) 상차', at: '11. 26. 08:10', day: todayKst, completed: true, completedAt: '11. 26. 16:00', done: 10.56, by: '김지수' },
    { id: 'c2', target: 'inbound:SH', kind: 'instruction', text: 'SH 원료 18 TON 입고 계근', at: '11. 26. 09:00', day: todayKst, completed: true, completedAt: '11. 26. 15:00', done: 18, by: '작업자B' },
    { id: 'c3', target: 'pitch', kind: 'instruction', text: '분쇄 45 BAG', at: '11. 26. 08:30', day: todayKst, working: true, by: '김지수' },
    { id: 'c4', target: 'production-a', kind: 'instruction', text: 'A라인 12 TON', at: '11. 26. 08:00', day: todayKst, completed: true, completedAt: '11. 26. 16:30', done: 12, by: '1조' },
    { id: 'c5', target: '*', kind: 'notice', text: '18:00 마감 전 완료 수량 최종 확인', at: '11. 26. 08:00', day: todayKst, by: '김지수' }
  ]),
  'jisu-inbound-records-v1': JSON.stringify({
    [todayKst]: { day: todayKst, rows: [{ rid: 'r1', lot: 'LOT-261126-01', bag: 1, kg: '1002.5', worker: '작업자B', loc: '경북82가1234' }, { rid: 'r2', lot: 'LOT-261126-02', bag: 2, kg: '998.2', worker: '작업자B', loc: '경북82가1234' }], archivedRows: [], workState: 'work', startedAt: '11. 26. 09:00', shiftKey: todayKst + '-' + (Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).format(new Date())) % 24 >= 18 ? 'pm' : 'am') }
  }),
  'jisu-pitch-records-v1': JSON.stringify({ [todayKst]: { workState: 'done', grind1: '45', grind2: '42', add1s: ['LOT-77'], add2s: [], moves: ['1동→2동'], startedAt: '08:30', completedAt: '17:00', by: '김지수' } }),
  'jisu-env-v1': JSON.stringify({ round: 2, u: { '1,2': { subs: { '분체': { s: 'done', ts: '09:10', td: '09:35', day: todayKst }, '충진기': { s: 'work', ts: '10:00', day: todayKst } } } }, a: { subs: { '2호기': { s: 'done', ts: '11:00', td: '11:20', day: todayKst }, '3호기': { s: '' } } } }),
  'jisu-memos-v1': JSON.stringify([{ id: 'm1', target: 'outbound', tag: 'issue', text: '파렛트 파손 2건', at: mdKst + ' 10:00', by: '김지수', day: todayKst },
    { id: 'm2', target: '*', tag: 'issue', text: '공장 전체 정전 예정', at: mdKst + ' 09:00', by: '김지수', day: todayKst }]),
  'jisu-schedule-v1': JSON.stringify([{ id: 's1', date: '2026-11-28', target: 'outbound', kind: 'instruction', text: 'RAS-2 20 TON', applied: false, by: '김지수' }]),
  'jisu-user': '김지수'
};

function countDownloads(w) { return (w.__downloads || []).length; }
function confirmOpen(w) {
  const el = w.document.getElementById('dlConfirmModal');
  return !!(el && el.classList.contains('is-open'));
}
function confirmTitle(w) {
  const el = w.document.getElementById('dlConfirmModal');
  return el ? el.querySelector('#dlConfirmTitle').textContent : '';
}
function clickConfirm(w, yes) {
  const el = w.document.getElementById('dlConfirmModal');
  el.querySelector(yes ? '#dlConfirmOk' : '#dlConfirmCancel').click();
}

(async () => {
  /* ─────────────── 1) 일일보고서 엑셀: 버튼 → 확인 → 취소 시 0건 ─────────────── */
  {
    const { w, errors } = await loadPage({ seed: seedWork, wait: 1200 });
    ok('일일보고서 모듈이 로드된다', () => assert.ok(w.jisuDailyReport && typeof w.jisuDailyReport.build === 'function'));
    ok('확인 요청 창은 처음엔 닫혀 있다', () => assert.equal(confirmOpen(w), false));

    w.document.getElementById('xlsxDoneBtn').click();
    await sleep(200);
    ok('액셀 버튼 → 바로 저장하지 않고 확인 요청이 뜬다', () => {
      assert.equal(confirmOpen(w), true);
      assert.ok(/일일 보고서/.test(confirmTitle(w)), confirmTitle(w));
      assert.equal(countDownloads(w), 0);
    });
    ok('확인 요청에 파일명이 보인다', () => {
      const f = w.document.querySelector('#dlConfirmFile').textContent;
      assert.ok(/POSCO-M_JISU_일일보고서_구역별_\d{8}\.xlsx/.test(f), f);
    });
    clickConfirm(w, false);
    await sleep(400);
    ok('취소하면 다운로드 0건 · 창이 닫힌다', () => {
      assert.equal(countDownloads(w), 0);
      assert.equal(confirmOpen(w), false);
    });

    /* 확인 → 실제 생성 */
    w.document.getElementById('xlsxDoneBtn').click();
    await sleep(150);
    clickConfirm(w, true);
    await sleep(2500);
    ok('확인하면 .xlsx 한 건이 저장된다', () => {
      assert.equal(countDownloads(w), 1, JSON.stringify(w.__downloads));
      assert.ok(/\.xlsx$/.test(w.__downloads[0]), w.__downloads[0]);
    });
    ok('생성된 보고서는 16시트(구역 버튼별 + 요약 + 공지·예정)', () => {
      const rep = w.__jisuLastReport;
      assert.ok(rep && rep.bytes && rep.bytes.length > 20000, '보고서 바이트 없음');
      const files = w.jisuDailyReport._internals.zipRead(rep.bytes);
      const wb = w.jisuDailyReport._internals.utf8Decode(files.get('xl/workbook.xml'));
      const names = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1]);
      assert.equal(names.length, 16, names.join(','));
      assert.deepEqual(names, ['일일 요약', '출고', '입고', '피치', '포장(2동)', '포장(3동)', '환경', '생산A', '생산B', '생산C', '생산D', '생산E', '생산F', '생산G', '생산H', '공지·예정']);
      assert.ok(!files.has('xl/worksheets/sheet17.xml'), '현장 사진 별도 시트가 남아 있음');
    });
    ok('일일 요약은 구역 시트를 수식으로 집계한다', () => {
      const files = w.jisuDailyReport._internals.zipRead(w.__jisuLastReport.bytes);
      const s1 = w.jisuDailyReport._internals.utf8Decode(files.get('xl/worksheets/sheet1.xml'));
      assert.ok(/COUNTA\(출고!C5:C\d+\)/.test(s1), '출고 COUNTA 없음');
      assert.ok(/COUNTIF\(입고!G5:G\d+,&quot;작업완료&quot;\)/.test(s1), '입고 COUNTIF 없음');
      assert.ok(/COUNTIF\('포장\(2동\)'!G5:G\d+,&quot;이월&quot;\)/.test(s1), '포장(2동) 이월 없음');
      assert.ok(/IF\(B19=0,0,C19\/B19\)/.test(s1), '전체 합계 달성률 없음');
    });
    ok('구역 시트에 실제 작업지시가 들어간다', () => {
      const files = w.jisuDailyReport._internals.zipRead(w.__jisuLastReport.bytes);
      const s2 = w.jisuDailyReport._internals.utf8Decode(files.get('xl/worksheets/sheet2.xml'));
      assert.ok(/RAS-2 660 KG 16 P \(10\.56 TON\) 상차/.test(s2), '출고 작업 내용 없음');
      assert.ok(/출고 · RAS-2/.test(s2), '대상 이름 없음');
      assert.ok(/IF\(C5=""|IF\(C5=&quot;&quot;/.test(s2), '번호 수식 없음');
      assert.ok(/출고 일일 보고서 \(2026-/.test(s2), '제목 없음');
    });
    ok('구역 시트 안에 그 구역 특이사항·현장 사진 표가 들어간다', () => {
      const I = w.jisuDailyReport._internals;
      const s2 = I.utf8Decode(I.zipRead(w.__jisuLastReport.bytes).get('xl/worksheets/sheet2.xml'));
      assert.ok(/\[구역 특이사항\]/.test(s2), '구역 특이사항 표 없음');
      assert.ok(/파렛트 파손 2건/.test(s2), '출고 특이사항 내용 없음');
      assert.ok(/\[구역 현장 사진\]/.test(s2), '구역 현장 사진 표 없음');
    });
    ok('입고 시트에 중량 기록일지가 채워진다', () => {
      const files = w.jisuDailyReport._internals.zipRead(w.__jisuLastReport.bytes);
      const s3 = w.jisuDailyReport._internals.utf8Decode(files.get('xl/worksheets/sheet3.xml'));
      assert.ok(/LOT-261126-01/.test(s3), 'LOT 없음');
      assert.ok(/1002\.5/.test(s3), '중량 없음');
      assert.ok(/SUM\(E\d+:E\d+\)/.test(s3), '합계 수식 없음');
      assert.ok(/\/1000/.test(s3), 'TON 환산 없음');
    });
    ok('피치·환경 시트에 당일 기록이 채워진다', () => {
      const I = w.jisuDailyReport._internals;
      const files = I.zipRead(w.__jisuLastReport.bytes);
      const s4 = I.utf8Decode(files.get('xl/worksheets/sheet4.xml'));
      assert.ok(/부원료 투입 \(LOT-77\)/.test(s4), '피치 부원료 없음');
      assert.ok(/분쇄/.test(s4), '피치 분쇄 없음');
      const s7 = I.utf8Decode(files.get('xl/worksheets/sheet7.xml'));
      assert.ok(/1,2호기/.test(s7) && /메인통로/.test(s7), '환경 호기 없음');
      assert.ok(/작업완료/.test(s7) && /작업중/.test(s7), '환경 상태 없음');
    });
    ok('공지·예정 시트에 공지·달력 예정·전체(*) 특이사항이 들어간다', () => {
      const I = w.jisuDailyReport._internals;
      const files = I.zipRead(w.__jisuLastReport.bytes);
      const s16 = I.utf8Decode(files.get('xl/worksheets/sheet16.xml'));
      assert.ok(/18:00 마감 전 완료 수량 최종 확인/.test(s16), '공지 없음');
      assert.ok(/\[예정 11-28\]/.test(s16), '예정 없음');
      assert.ok(/\[특이사항\]/.test(s16), '전체 특이사항 없음');
    });
    ok('일일보고서 생성 중 JS 오류 없음', () => assert.deepEqual(errors, []));
    w.close();
  }

  /* ─────────────── 2) 자동 다운로드 금지 (08·18시) ─────────────── */
  {
    const { w, errors } = await loadPage({ seed: seedWork, wait: 4600 });
    ok('08·18시 자동 저장 대신 확인 요청만 뜬다', () => {
      assert.equal(countDownloads(w), 0, JSON.stringify(w.__downloads));
      assert.equal(confirmOpen(w), true, '확인 요청이 없음');
      assert.ok(/일일보고서\(엑셀\)를 다운로드할까요/.test(confirmTitle(w)), confirmTitle(w));
    });
    clickConfirm(w, false);
    await sleep(1200);
    ok('자동 확인 요청을 취소하면 그대로 0건 · 이 탭에서는 다시 묻지 않는다', () => {
      assert.equal(countDownloads(w), 0);
      assert.equal(confirmOpen(w), false);
      const hh = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).format(new Date())) % 24;
      const tag = todayKst + (hh >= 18 ? '-pm' : '-am');
      assert.equal(w.localStorage.getItem('jisu-auto-excel-shift'), null);      /* 취소는 '받았다'는 표식이 아니다 */
      assert.equal(w.sessionStorage.getItem('jisu-auto-excel-asked'), tag);     /* 같은 탭에서 반복 질문 없음 */
    });
    ok('자동 경로 JS 오류 없음', () => assert.deepEqual(errors, []));
    w.close();
  }

  /* ─────────────── 3) 주간·월간 보고서(PPT) 확인 요청 ─────────────── */
  {
    const { w, errors } = await loadPage({ seed: seedWork, wait: 1200 });
    w.document.getElementById('perfBtn').click();
    await sleep(500);
    const pptBtn = w.document.getElementById('pfPptBtn');
    ok('실적 창의 PPT 버튼이 있다', () => assert.ok(pptBtn));
    pptBtn.click();
    await sleep(300);
    ok('PPT 버튼 → 확인 요청 · 저장 0건', () => {
      assert.equal(confirmOpen(w), true);
      assert.ok(/보고서\(PPT\)를 다운로드할까요/.test(confirmTitle(w)), confirmTitle(w));
      assert.equal(countDownloads(w), 0);
    });
    clickConfirm(w, false);
    await sleep(300);
    ok('PPT 취소 → 다운로드 0건', () => assert.equal(countDownloads(w), 0));
    pptBtn.click();
    await sleep(250);
    clickConfirm(w, true);
    await sleep(800);
    ok('PPT 확인 → .pptx 한 건 저장', () => {
      assert.equal(countDownloads(w), 1, JSON.stringify(w.__downloads));
      assert.ok(/\.pptx$/.test(w.__downloads[0]), w.__downloads[0]);
    });
    ok('주간·월간 JS 오류 없음', () => assert.deepEqual(errors, []));
    w.close();
  }

  /* ─────────────── 4) 입고 완료·다시 받기 확인 요청 ─────────────── */
  {
    const { w, errors } = await loadPage({
      seed: seedWork, wait: 1500,
      before(x) {
        x.XLSX = {
          utils: { book_new: () => ({}), aoa_to_sheet: () => ({}), book_append_sheet: () => {} },
          writeFile: (wb, name) => { x.__xlsxWriteFile.push(name); }
        };
      }
    });
    const btn = w.document.getElementById('inboundCompleteBtn') || w.document.querySelector('#inboundComplete, [data-inbound-complete]');
    ok('입고 완료 버튼을 찾았다', () => assert.ok(btn, 'complete 버튼 없음'));
    btn.click();
    await sleep(400);
    ok('입고완료(PC) → 엑셀 일지도 확인 요청을 거친다', () => {
      assert.equal(confirmOpen(w), true);
      assert.ok(/입고원료 중량 기록일지\(엑셀\)/.test(confirmTitle(w)), confirmTitle(w));
      assert.equal(w.__xlsxWriteFile.length, 0);
    });
    clickConfirm(w, false);
    await sleep(300);
    ok('입고 완료 취소 → 엑셀 저장 0건', () => {
      assert.equal(w.__xlsxWriteFile.length, 0);
      assert.equal(confirmOpen(w), false);
    });
    ok('입고 JS 오류 없음', () => assert.deepEqual(errors, []));
    w.close();
  }

  /* ─────────────── 5) 피치 작업완료 확인 요청 + 일반 작업완료는 조용함 ─────────────── */
  {
    const { w, errors } = await loadPage({ seed: seedWork, wait: 1500 });
    /* 일반 구역 작업완료 카드 버튼: 보고서 다운로드가 없어야 한다 */
    const before = countDownloads(w);
    const workBtn = w.document.querySelector('[data-cmd-complete], .ch-act-done, [data-ch-done]');
    ok('구역 작업완료 버튼이 화면에 있다', () => assert.ok(workBtn, '작업완료 버튼 없음'));
    if (workBtn) workBtn.click();
    await sleep(600);
    ok('구역 작업완료 버튼은 보고서를 내려받지 않는다', () => {
      assert.equal(countDownloads(w), before);
      assert.equal(confirmOpen(w), false);
    });
    ok('일반 작업완료 JS 오류 없음', () => assert.deepEqual(errors, []));
    w.close();
  }

  /* ─────────────── 6) 사진 시트: 그림 삽입 경로 ─────────────── */
  {
    const { w } = await loadPage({ seed: seedWork, wait: 1000 });
    await okAsync('구역 사진은 그 구역 시트 안에 그림으로 들어간다', async () => {
      const I = w.jisuDailyReport._internals;
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const model = {
        day: '2026-11-26', author: '김지수',
        zones: { outbound: { tasks: [], memos: [], photos: [{ at: '11. 26. 10:12', name: '출고_상차완료.jpg', dataUrl: png, w: 270, h: 145 }] } },
        inbound: { rows: [] }, pitch: { rows: [] }, env: { rows: [] }, notices: [], plans: [], memos: [], photos: []
      };
      const out = w.jisuDailyReport.build(model);
      const files = I.zipRead(out.bytes);
      assert.ok(files.has('xl/media/jisupic_outbound_1.png'), 'media 없음: ' + [...files.keys()].filter(k => k.includes('media')));
      assert.ok(files.has('xl/drawings/jisuphotosoutbound.xml'), 'drawing 없음');
      const s2 = I.utf8Decode(files.get('xl/worksheets/sheet2.xml'));
      assert.ok(/<drawing r:id="rIdJisuDr"\/>/.test(s2), 'drawing 참조 없음(출고 시트)');
      assert.ok(/출고_상차완료\.jpg/.test(s2), '파일 이름 없음');
      assert.ok(/ht="118"/.test(s2), '사진 행 높이 없음');
      const ct = I.utf8Decode(files.get('[Content_Types].xml'));
      assert.ok(/drawings\/jisuphotosoutbound\.xml/.test(ct), 'content type 없음');
    });
    w.close();
  }

  const pass = results.filter(r => r.startsWith('PASS')).length;
  const fail = results.filter(r => r.startsWith('FAIL')).length;
  console.log('\nTOTAL ' + results.length + ' checks, PASS ' + pass + ', FAIL ' + fail);
  if (fail) process.exit(1);
})();
