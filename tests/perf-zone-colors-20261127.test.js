// 실행: NODE_PATH=<jsdom 설치 경로> node tests/perf-zone-colors-20261127.test.js JISU/index.html
// 2026-11-27 지시: "주월간 실적에 버튼별 색깔 맞춰줘"
//   주·월간 실적 보고서(11시트)와 PPT 11장의 구역 색을 달력 색상 범례(.cal-lg / #cal-zone-palette)와 같게.
//   출고 #FF8A00 · 입고 #0686EF · 포장 #CBD5E1 · 생산 #EC4899 · 환경 #059669 · 피치 #9A5219
//   검사: ① CSS 팔레트 ↔ 보고서 팔레트 ② 시트별로 칠해진 실제 색(computed) ③ .pptx 슬라이드 XML 색 ④ 빈 기록 무오류
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
const ymd = k => new Date(k + 'T12:00:00+09:00');
const addD = (k, n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ymd(k).getTime() + n * 864e5));
const startOfThisWeek = (() => {
  const t = ymd(todayKst); const dw = (t.getUTCDay() + 6) % 7;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t.getTime() - dw * 864e5));
})();
const days = [-3, -2, -1].map(n => addD(startOfThisWeek, n));
const curDays = [0, 1].map(n => addD(startOfThisWeek, n)).filter(k => k <= todayKst);

const results = [];
function ok(name, fn) { try { fn(); results.push('PASS ' + name); console.log('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ' :: ' + (e && e.message ? e.message : e)); console.log(results[results.length - 1]); } }
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

/* ── 시드: 이번 주 + 지난주, 구역별 기록 (색이 다 보이도록 출고·입고·포장·생산·피치) ── */
const md = k => k.slice(5, 7) + '. ' + k.slice(8, 10) + '.';
const cmds = []; let idn = 0;
const rec = (day, target, text, o = {}) => cmds.push(Object.assign({ id: 'z' + (++idn), target, kind: 'instruction', text, at: md(day) + ' 09:00', day, closed: true, by: '1조 김민서' }, o));
[...days, ...curDays].forEach(d => {
  rec(d, 'outbound:RAS-2', 'RAS-2 30 TON 7대 상차', { done: 30, completed: true, completedAt: md(d) + ' 17:00' });
  rec(d, 'outbound:L1', 'L1 20 TON 4대 상차', { done: 20, completed: true, completedAt: md(d) + ' 16:30', by: '2조 박정호' });
  rec(d, 'inbound:HH', 'HH 12 TON 입고 계근', { done: 12, completed: true, completedAt: md(d) + ' 15:00', by: '2조 박정호' });
  rec(d, 'packaging', '포장 2동 6 TON 포장', { done: 6, completed: true, completedAt: md(d) + ' 17:30', by: '4조 최현우' });
  rec(d, 'production-a', 'A라인 8 TON 생산', { done: 8, completed: true, completedAt: md(d) + ' 16:00', by: '3조 이수진' });
  rec(d, 'production-c', 'C라인 8 TON 생산', { done: 4, completed: false, by: '3조 이수진' });
  rec(d, 'pitch', '분쇄 9 TON', { done: 9, completed: true, completedAt: md(d) + ' 14:00', by: '1조 김민서' });
});
const inbound = {}, pitch = {};
[...days, ...curDays].forEach(d => {
  inbound[d] = { day: d, shiftKey: d + '-am', workState: 'done', by: '2조 박정호', archivedRows: [], rows: [{ rid: 'r1', lot: 'L1', bag: 1, kg: '2000', worker: 'B' }] };
  pitch[d] = { workState: 'done', grind1: '45', grind2: '0', add1s: [], add2s: [], moves: [], by: '1조 김민서' };
});
const seedRich = {
  'jisu-commands-v1': JSON.stringify(cmds),
  'jisu-inbound-records-v1': JSON.stringify(inbound),
  'jisu-pitch-records-v1': JSON.stringify(pitch),
  'jisu-memos-v1': JSON.stringify([{ id: 'm1', target: 'outbound', tag: 'issue', text: '배차 지연 1건', at: md(curDays[0] || startOfThisWeek) + ' 10:00', by: '1조 김민서', day: curDays[0] || startOfThisWeek }]),
  'jisu-user': '김지수'
};
const seedEmpty = { 'jisu-commands-v1': '[]', 'jisu-memos-v1': '[]', 'jisu-user': '김지수' };

/* CSS 팔레트(#cal-zone-palette)에서 실제 값 읽기 — 화면과 보고서가 같은 값을 쓰는지 대조 */
function cssPalette(src) {
  const out = {};
  const map = { outbound: 'c-outbound', inbound: 'c-inbound', packaging: 'c-pack', production: 'c-prod', environment: 'c-env', pitch: 'c-pitch', memo: 'c-memo', notice: 'c-notice', urgent: 'c-urgent' };
  Object.entries(map).forEach(([k, cls]) => {
    const m = src.match(new RegExp('\\.' + cls + '\\{--zc:(#[0-9A-Fa-f]{6})'));
    if (m) out[k] = m[1].toUpperCase();
  });
  return out;
}
const hex = v => {
  if (typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v.trim())) return v.trim().toUpperCase();
  const m = String(v).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return String(v);
  return '#' + [1, 2, 3].map(i => (+m[i]).toString(16).padStart(2, '0')).join('').toUpperCase();
};
const sheets = w => [...w.document.querySelectorAll('#pfSlide .jpr-sheet')];
const back = (w, el) => hex(w.getComputedStyle(el).backgroundColor);
function openPerf(w, mode) {
  w.document.getElementById('perfBtn').click();
  if (mode === 'month') { const b = w.document.querySelector('[data-pf-mode="month"]'); if (b) b.click(); }
}

(async () => {
  const CSSP = cssPalette(html);
  const WANT = { outbound: '#FF8A00', inbound: '#0686EF', packaging: '#CBD5E1', production: '#EC4899', environment: '#059669', pitch: '#9A5219', memo: '#7C3AED', notice: '#FBF6D3', urgent: '#FB433A' };

  ok('달력 색상 범례 CSS 값이 지시한 10색과 같다', () => {
    Object.entries(WANT).forEach(([k, v]) => assert.equal(CSSP[k], v, k + '=' + CSSP[k]));
  });

  /* ─── 1) 실제 기록: 시트별 색 ─────────────────────────────── */
  {
    const { w, errors } = await loadPage({ seed: seedRich });
    openPerf(w, 'week');
    await sleep(700);
    const dbg = w.jisuPerfDebug();
    const pal = dbg.palette || {};
    ok('보고서 팔레트 = 달력 범례 색 (window.__jisuPerfZonePalette)', () => {
      Object.keys(WANT).forEach(k => assert.equal(hex(pal[k] || ''), WANT[k], k + '=' + pal[k]));
    });
    ok('주간 11시트가 열린다', () => assert.equal(sheets(w).length, 11));

    const s03 = sheets(w).find(s => s.textContent.includes('구역별 목표 달성률 및'));
    const s04 = sheets(w).find(s => s.textContent.includes('구역별 출·입고 누적 물량 추이'));
    const s09 = sheets(w).find(s => s.textContent.includes('생산 A~H 8개 라인'));
    const s10 = sheets(w).find(s => s.textContent.includes('핵심 구역 버튼별'));

    ok('03 구역별 달성률 막대 색 = 구역 버튼 색', () => {
      assert.ok(s03, '03 시트 없음');
      const rows = [...s03.querySelectorAll('.jpr-prow')];
      assert.ok(rows.length >= 5, 'rows=' + rows.length);
      const seen = rows.map(r => back(w, r.querySelector('.jpr-pbar')));
      const allowed = new Set([WANT.outbound, WANT.inbound, WANT.production, WANT.packaging, WANT.pitch, WANT.environment]);
      rows.forEach((r, i) => {
        const empty = /기록 없음/.test(r.textContent);
        assert.ok(allowed.has(seen[i]) || (empty && seen[i] === '#C8BFAF'), '허용 밖 색 ' + seen[i] + ' :: ' + seen.join(','));
      });
      assert.ok(seen.includes(WANT.outbound) && seen.includes(WANT.inbound) && seen.includes(WANT.production), seen.join(','));
    });
    ok('03 출·입고 물량 비중 조각 색 = 구역 색', () => {
      const segs = [...s03.querySelectorAll('.jpr-stackbar .jpr-seg')].map(e => back(w, e));
      const allowed = new Set([WANT.outbound, '#FFA733', '#FFC477', WANT.inbound, WANT.production, WANT.packaging, WANT.pitch]);
      segs.forEach(c => assert.ok(allowed.has(c), '허용 밖 색 ' + c + ' :: ' + segs.join(',')));
      assert.ok(segs.includes(WANT.outbound), segs.join(','));
    });
    ok('04 주차 누적 스택: 출고·입고·생산·포장 색이 모두 보인다', () => {
      const segs = [...s04.querySelectorAll('.jpr-stackbody .jpr-seg')].map(e => back(w, e));
      const set = new Set(segs);
      [WANT.outbound, WANT.inbound, WANT.production, WANT.packaging].forEach(c => assert.ok(set.has(c), c + ' 없음 :: ' + segs.join(',')));
    });
    ok('04 범례에 구역별 색 이름이 나온다', () => {
      const t = [...s04.querySelectorAll('.jpr-legend span')].map(e => e.textContent.replace(/\s+/g, '')).join('|');
      ['출고', '입고', '생산', '포장'].forEach(k => assert.ok(t.includes(k), k + ' 없음 :: ' + t));
    });
    ok('09 생산 A~H 막대는 생산 구역 분홍 계열만 쓴다', () => {
      const cols = [...s09.querySelectorAll('.jpr-prod .jpr-col i')].map(e => back(w, e));
      assert.equal(cols.length, 8);
      cols.forEach(c => assert.ok([WANT.production, '#F9A8D4', '#C8BFAF'].includes(c), '색 ' + c + ' :: ' + cols.join(',')));
    });
    ok('10 핵심 구역 표의 구역 색 사각형 = 구역 버튼 색', () => {
      const dots = [...s10.querySelectorAll('.jpr-zone-h .jpr-zdot')].map(e => back(w, e));
      assert.ok(dots.length >= 5, 'dots=' + dots.length);
      const allowed = new Set([WANT.outbound, WANT.inbound, WANT.production, WANT.packaging, WANT.pitch, WANT.environment]);
      dots.forEach(c => assert.ok(allowed.has(c), '허용 밖 색 ' + c + ' :: ' + dots.join(',')));
    });
    ok('주간 모드 JS 오류 없음', () => assert.deepEqual(errors, []));

    /* PPT(.pptx) — 슬라이드 XML 에 구역 색 HEX */
    const dlgEl = () => w.document.getElementById('dlConfirmModal');
    /* 08·18시 일일보고서 자동 안내가 떠 있으면 먼저 닫는다(이 검사와 무관) */
    if (dlgEl() && dlgEl().classList.contains('is-open')) dlgEl().querySelector('#dlConfirmCancel').click();
    await sleep(300);
    w.document.getElementById('pfPptBtn').click();
    await sleep(800);
    const pptTitle = (w.document.getElementById('dlConfirmTitle') || {}).textContent || '';
    ok('PPT 버튼 → PPT 다운로드 확인 요청', () => {
      assert.ok(dlgEl() && dlgEl().classList.contains('is-open'), '확인창 없음');
      assert.ok(/PPT/.test(pptTitle), '제목=' + pptTitle);
    });
    if (dlgEl() && dlgEl().classList.contains('is-open') && /PPT/.test(pptTitle)) dlgEl().querySelector('#dlConfirmOk').click();
    await sleep(1800);
    const ppt = w.__jisuPerfPpt || {};
    ok('PPT 11장 생성', () => assert.equal(ppt.slides, 11, JSON.stringify(ppt)));
    ok('PPT 슬라이드 XML 에 구역 색 HEX 반영', () => {
      const set = new Set((ppt.hexes || []).map(h => String(h).toUpperCase().replace('#', '')));
      ['FF8A00', '0686EF', 'CBD5E1', 'EC4899', '9A5219'].forEach(h => assert.ok(set.has(h), h + ' 없음 :: ' + [...set].join(',')));
    });

    /* 월간 모드 */
    w.document.querySelector('[data-pf-mode="month"]').click();
    await sleep(600);
    ok('월간 모드 11시트 · 04 스택 색 유지', () => {
      assert.equal(sheets(w).length, 11);
      const s4 = sheets(w).find(s => s.textContent.includes('월간 1~'));
      assert.ok(s4, '월간 04 시트 없음');
      const segs = [...s4.querySelectorAll('.jpr-stackbody .jpr-seg')].map(e => back(w, e));
      assert.ok(segs.length >= 3, segs.join(','));
      assert.ok(segs.includes(WANT.outbound) && segs.includes(WANT.inbound), segs.join(','));
    });
    ok('월간 모드 JS 오류 없음', () => assert.deepEqual(errors, []));
    w.close();
  }

  /* ─── 2) 빈 기록: 색 로직이 0 값에서도 깨지지 않는다 ────────── */
  {
    const { w, errors } = await loadPage({ seed: seedEmpty, wait: 1500 });
    openPerf(w, 'week');
    await sleep(600);
    ok('빈 기록: 11시트 · JS 오류 0', () => {
      assert.equal(sheets(w).length, 11);
      assert.deepEqual(errors, []);
    });
    ok('빈 기록: 물량 0 이어도 시트 구성이 유지된다', () => {
      const d = w.jisuPerfDebug();
      assert.equal(d.flow, 0);
      for (const k of ['oProd', 'oPack', 'oPitch']) if (k in d) assert.equal(d[k], 0, k + '=' + d[k]);
    });
    w.close();
  }

  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('\nTOTAL ' + results.length + ' checks, PASS ' + (results.length - fails.length) + ', FAIL ' + fails.length + (lateErrors.length ? ' (late errors: ' + lateErrors.join(' | ') + ')' : ''));
  if (fails.length) process.exitCode = 1;
})();
