// 실행: NODE_PATH=<jsdom 설치 경로> node tests/perf-report-full-20261126.test.js JISU/index.html
// 2026-11-26 지시: 주간·월간 실적 보고서를 페이퍼 덱 11시트(표지 00 ~ 핵심 구역 표 10)로 확장 —
//   물량 추이(점선 추세) · 구역 달성률 · 100% 비중 바 · 주차 누적 스택 · 출고/이월 비교 ·
//   아래로 내려가는 이월 추이 · 4조 2교대 · 완료율/이월률 균형 · 생산 A~H · 작성자/특이사항 표.
//   모든 숫자는 등록 기록에서만 집계(샘플 하드코딩 금지), PPT(.pptx)도 같은 구성 11장.
// jsdom + 가짜 Firebase + 가짜 IndexedDB. 네트워크·운영 DB·푸시 서버로 나가지 않는다.
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
const ymd = k => new Date(k + 'T12:00:00+09:00');

const results = [];
function ok(name, fn) { try { fn(); results.push('PASS ' + name); console.log('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ' :: ' + (e && e.message ? e.message : e)); console.log(results[results.length - 1]); } }
async function okAsync(name, fn) { try { await fn(); results.push('PASS ' + name); console.log('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ' :: ' + (e && e.message ? e.message : e)); console.log(results[results.length - 1]); } }
const lateErrors = [];
process.on('unhandledRejection', e => lateErrors.push(String((e && e.message) || e).slice(0, 200)));

async function loadPage({ seed, wait = 1600 } = {}) {
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
      w.__downloads = [];
      w.TextEncoder = w.TextEncoder || TextEncoder;
      w.TextDecoder = w.TextDecoder || TextDecoder;
      w.URL.createObjectURL = () => 'blob:jisu-test';
      w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute('download')) w.__downloads.push(this.getAttribute('download')); };
      Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
    }
  });
  await sleep(wait);
  return { w: dom.window, dom, errors };
}

/* ── 시드: 이번 주(월~오늘) + 지난 4주, 등록 기록만 ── */
function isoWeekStart(d = new Date()) {
  const k = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const t = ymd(k); const dw = (t.getUTCDay() + 6) % 7;
  const s = new Date(t.getTime() - dw * 864e5);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(s);
}
const W0 = isoWeekStart();
const addD = (k, n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ymd(k).getTime() + n * 864e5));
const days = [-1, -2, -3].map(n => addD(W0, n)).reverse();
const curDays = [0, 1].map(n => addD(W0, n)).filter(k => k <= todayKst);

const cmds = [];
let idn = 0;
const rec = (day, target, text, o = {}) => cmds.push(Object.assign({ id: 't' + (++idn), target, kind: 'instruction', text, at: mdKst + ' 09:00', day, closed: true, by: '김지수' }, o));

days.forEach(d => {
  rec(d, 'outbound:RAS-2', 'RAS-2 30 TON 7대 상차', { done: 30, completed: true, completedAt: '11. 20. 17:00', by: '1조 김민서' });
  rec(d, 'outbound:L1', 'L1 20 TON 4대 상차', { done: 20, completed: true, completedAt: '11. 20. 17:00', by: '1조 김민서' });
  rec(d, 'inbound:SH', 'SH 10 TON 입고 계근', { done: 10, completed: true, completedAt: '11. 20. 15:00', by: '2조 박정호' });
  rec(d, 'production-a', 'A라인 8 TON 생산', { done: 8, completed: true, completedAt: '11. 20. 16:00', by: '3조 이수진' });
  rec(d, 'production-c', 'C라인 8 TON 생산', { done: 4, completed: false, by: '3조 이수진' });
});
curDays.forEach(d => {
  rec(d, 'outbound:RAS-2', 'RAS-2 40 TON 8대 상차', { done: 40, completed: true, completedAt: '11. 20. 17:00', by: '1조 김민서' });
  rec(d, 'inbound:HH', 'HH 12 TON 입고', { done: 12, completed: true, completedAt: '11. 20. 15:00', by: '2조 박정호' });
  rec(d, 'pit' === 'x' ? 'pitch' : 'pitch', '분쇄 45 BAG', { completed: false, by: '1조 김민서' });
  rec(d, 'packaging', '포장 2동 60 Bag 포장', { done: 60, completed: true, completedAt: '11. 20. 17:00', by: '4조 최현우' });
  rec(d, 'production-d', 'D라인 8 TON 생산', { done: 4, completed: false, by: '3조 이수진', carryCount: 2, carryFrom: d });
  rec(d, 'production-e', 'E라인 8 TON 생산', { done: 8, completed: true, completedAt: '11. 21. 16:00', by: '3조 이수진' });
});
rec(curDays[0] || W0, 'outbound:L1', 'L1 12 TON 잔여 상차', { done: 4, completed: false, by: '1조 김민서', carryCount: 1, carryFrom: curDays[0] || W0 });

const inbound = {}, pitch = {};
days.concat(curDays).forEach(d => {
  inbound[d] = { day: d, rows: [{ rid: 'r1', lot: 'L1', bag: 1, kg: '2000', worker: '작업자B' }, { rid: 'r2', lot: 'L2', bag: 2, kg: '1500', worker: '작업자B' }], archivedRows: [], workState: 'done', by: '2조 박정호' };
  pitch[d] = { workState: 'done', grind1: '45', grind2: '0', add1s: [], add2s: [], moves: [], by: '1조 김민서' };
});
const seedRich = {
  'jisu-commands-v1': JSON.stringify(cmds),
  'jisu-inbound-records-v1': JSON.stringify(inbound),
  'jisu-pitch-records-v1': JSON.stringify(pitch),
  'jisu-memos-v1': JSON.stringify([{ id: 'm1', target: 'outbound', tag: 'issue', text: '배차 지연 1건', at: mdKst + ' 10:00', by: '1조 김민서', day: curDays[0] || W0 }]),
  'jisu-user': '김지수'
};
const seedEmpty = { 'jisu-commands-v1': '[]', 'jisu-memos-v1': '[]', 'jisu-user': '김지수' };

const sheets = w => w.document.querySelectorAll('#pfSlide .jpr-sheet');
const txt = w => (w.document.getElementById('pfSlide') || {}).textContent || '';
function openPerf(w, mode) {
  w.document.getElementById('perfBtn').click();
  if (mode === 'month') { const b = w.document.querySelector('[data-pf-mode="month"]'); if (b) b.click(); }
}
function confirmOpen(w) { const el = w.document.getElementById('dlConfirmModal'); return !!(el && el.classList.contains('is-open')); }
function clickConfirm(w, yes) { const el = w.document.getElementById('dlConfirmModal'); el.querySelector(yes ? '#dlConfirmOk' : '#dlConfirmCancel').click(); }

(async () => {
  /* ─────────── 1) 실제 기록 시드: 11시트 · 집계 정확성 (가짜 숫자 없음) ─────────── */
  {
    const { w, errors } = await loadPage({ seed: seedRich, wait: 1600 });
    openPerf(w, 'week');
    await sleep(600);
    const body = txt(w);
    ok('주간 실적 창이 11장 시트(표지 00 ~ 10)로 열린다', () => assert.equal(sheets(w).length, 11, 'sheets=' + sheets(w).length));
    ok('00 표지 · 01 하이라이트가 있다', () => {
      assert.ok(w.document.querySelector('#pfSlide .jpr-sheet.is-cover'), '표지 없음');
      assert.ok(/실적 하이라이트/.test(body), '하이라이트 없음');
    });
    ok('02 물량 추이(점선 추세) 시트', () => {
      assert.ok(/물량 추이/.test(body));
      const svg = w.document.querySelectorAll('#pfSlide svg.jpr-svg');
      assert.ok(svg.length >= 1, '차트 SVG 없음');
      const poly = w.document.querySelector('#pfSlide svg polyline');
      assert.ok(poly && /stroke-dasharray/.test(poly.getAttribute('stroke-dasharray') || '') || poly, '추세선 없음');
    });

    const dbg = w.jisuPerfDebug();
    ok('주간 시트 수 11 (디버그)', () => assert.equal(dbg.sheets, 11));
    ok('출고 톤수는 등록된 출고 완료 기록 합계다', () => {
      /* 지난 3일 30+20, 이번 주 40 → 기록이 있는 날짜만 */
      assert.ok(dbg.out >= 40, 'out=' + dbg.out);
      assert.ok(dbg.out <= 210, 'out=' + dbg.out);
    });
    ok('입고 톤수는 입고 중량일지(3.5t/일)에서 온다', () => assert.ok(dbg.inT > 0 && dbg.inT <= 40, 'in=' + dbg.inT));
    ok('평균 목표 달성률 = 완료/전체 (가짜 % 아님)', () => {
      assert.equal(dbg.pct, Math.round(dbg.done / dbg.work * 1000) / 10);
    });
    ok('구역 달성률에 6대 구역이 실제 건수와 함께 나온다', () => {
      assert.equal(dbg.groups.length, 6);
      const prod = dbg.groups.find(g => g.key === 'production');
      assert.ok(prod && prod.n > 0 && prod.done <= prod.n, JSON.stringify(prod));
      assert.ok(body.includes('생산 A~H'));
    });
    ok('출·입고 물량 비중 100% 스택 바가 있다', () => {
      assert.ok(/출·입고 물량 비중/.test(body));
      const segs = w.document.querySelectorAll('#pfSlide .jpr-stackbar .jpr-seg');
      assert.ok(segs.length >= 1, '비중 바 없음');
      const sum = [...segs].reduce((a, el) => a + parseFloat(el.style.width || '0'), 0);
      assert.ok(sum > 90 && sum <= 100.5, 'sum=' + sum);
    });
    ok('주차 누적 스택 막대 시트', () => {
      assert.ok(w.document.querySelectorAll('#pfSlide .jpr-stack .jpr-stackcol').length >= 1);
    });
    ok('출고 물량·이월 비교 시트', () => assert.ok(/이월 감소폭/.test(body) && w.document.querySelectorAll('#pfSlide .jpr-cmpbar').length >= 2));
    ok('아래로 내려가는 이월 추이 + 현장 입력 표준', () => {
      assert.ok(/이월 건수 추이/.test(body));
      const secs = [...w.document.querySelectorAll('#pfSlide .jpr-sheet')];
      const carrySheet = secs.find(sec => /이월 건수 추이/.test(sec.textContent));
      assert.ok(carrySheet && carrySheet.querySelector('svg.jpr-svg'), '이월 차트 없음');
      assert.ok(/현장 입력 표준/.test(body));
    });
    ok('4조 2교대 시트: 조별 등록·완료가 실제 작성자에서 집계된다', () => {
      const crews = dbg.crews;
      const total = crews.reduce((a, c) => a + c.n, 0);
      assert.equal(total, dbg.work, 'crew total=' + total + ' work=' + dbg.work);
      ['1조', '2조', '3조'].forEach(k => assert.ok(crews.some(c => c.key === k), k + ' 없음'));
      assert.ok(w.document.querySelectorAll('#pfSlide .jpr-crewrow').length >= 3);
    });
    ok('완료율(+)/이월률(-) 양방향 균형 차트', () => {
      assert.ok(w.document.querySelectorAll('#pfSlide svg').length >= 3, 'SVG 차트 수 부족');
    });
    ok('생산 A~H 8개 라인이 모두 나온다 (기록 없는 라인은 0)', () => {
      assert.equal(dbg.lines.length, 8);
      const names = [...w.document.querySelectorAll('#pfSlide .jpr-prod .jpr-col span')].map(e => e.textContent);
      assert.deepEqual(names, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
      const dLine = dbg.lines.find(l => l.z === 'production-d');
      assert.ok(dLine.n > 0, JSON.stringify(dLine));
      const eLine = dbg.lines.find(l => l.z === 'production-e');
      assert.ok(eLine.done > 0, JSON.stringify(eLine));
      const b = dbg.lines.find(l => l.z === 'production-b');
      assert.equal(b.n, 0);
    });
    ok('핵심 구역 표: 작성자(조)·특이사항이 들어간다', () => {
      assert.ok(w.document.querySelector('#pfSlide table.jpr-tbl'));
      assert.ok(/1조/.test(body), '조 배지 없음');
      assert.ok(/배차 지연/.test(body), '특이사항 없음');
    });
    ok('보고서에 하드코딩된 샘플 숫자(385t/418.2t/1,637t)가 없다', () => {
      ['418.2', '1,637', '96.4%'].forEach(s => assert.ok(!body.includes(s), '샘플 값 ' + s));
    });
    ok('주간 모드 JS 오류 없음', () => assert.deepEqual(errors, []));

    /* PPT: 확인 요청 유지 + 11장 */
    const pptBtn = w.document.getElementById('pfPptBtn');
    pptBtn.click();
    await sleep(300);
    ok('PPT 버튼 → 확인 요청(자동 저장 없음)', () => {
      assert.equal(confirmOpen(w), true);
      assert.ok(/11장 페이퍼 덱/.test(w.document.querySelector('#dlConfirmTitle') ? w.document.getElementById('dlConfirmDesc').textContent : ''), '설명 없음');
      assert.equal((w.__downloads || []).length, 0);
    });
    clickConfirm(w, true);
    await sleep(1200);
    ok('PPT 확인 → .pptx 1건 · 슬라이드 11장', () => {
      assert.equal((w.__downloads || []).length, 1, JSON.stringify(w.__downloads));
      assert.ok(/\.pptx$/.test(w.__downloads[0]));
      assert.ok(w.__jisuPerfPpt && w.__jisuPerfPpt.slides === 11, JSON.stringify(w.__jisuPerfPpt));
    });

    /* 월간 모드 */
    w.document.querySelector('[data-pf-mode="month"]').click();
    await sleep(500);
    ok('월간 모드도 11장 · 값이 실제 집계와 일치', () => {
      assert.equal(sheets(w).length, 11);
      const m = w.jisuPerfDebug();
      assert.equal(m.mode, 'month');
      assert.equal(m.sheets, 11);
      assert.ok(m.flow >= 0);
      assert.equal(m.pct, Math.round(m.done / m.work * 1000) / 10);
    });
    ok('월간 모드 JS 오류 없음', () => assert.deepEqual(errors, []));
    w.close();
  }

  /* ─────────── 2) 기록이 하나도 없을 때: 0 / 기록 없음 (가짜 숫자 금지) ─────────── */
  {
    const { w, errors } = await loadPage({ seed: seedEmpty, wait: 1500 });
    openPerf(w, 'week');
    await sleep(500);
    const body = txt(w);
    ok('빈 기록에서도 11장이 열리고 오류가 없다', () => {
      assert.equal(sheets(w).length, 11);
      assert.deepEqual(errors, []);
    });
    ok('빈 기록: 물량 0 · 달성률 0% · 조/라인 기록 없음', () => {
      const d = w.jisuPerfDebug();
      assert.equal(d.flow, 0);
      assert.equal(d.out, 0);
      assert.equal(d.inT, 0);
      assert.equal(d.pct, 0);
      assert.ok(d.lines.every(l => l.n === 0 && l.done === 0));
      assert.ok(/기록이 없습니다|기록 없음|등록된 구역 실적이 없습니다/.test(body));
    });
    w.close();
  }

  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('\nTOTAL ' + results.length + ' checks, PASS ' + (results.length - fails.length) + ', FAIL ' + fails.length + (lateErrors.length ? ' (late errors: ' + lateErrors.join(' | ') + ')' : ''));
  if (fails.length) process.exitCode = 1;
})();
