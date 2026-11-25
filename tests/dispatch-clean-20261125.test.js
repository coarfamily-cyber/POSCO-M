// 실행: NODE_PATH=<jsdom 설치 경로> node --test tests/dispatch-clean-20261125.test.js
// 2026-11-25 수뽕 님 지시(#29184) 회귀 테스트 —
//  배차 지시서 일괄등록에서 차종(윙바디 차량)·구간(세종2공장 → 창원)·하차지(동방물류센터)를
//  빼고 '차량번호 · 수량 · 배차시간 · 톤수' 한 줄만 남기는지 확인한다.
//  실제 JISU/index.html 을 jsdom 으로 띄운다. 가짜 Firebase + fetch 차단: 운영 DB·Web Push·ntfy 로 나가지 않는다.
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

const kstToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function shift(ymd, n) {
  const p = String(ymd).split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const TODAY = kstToday();
const D1 = shift(TODAY, 1);

const TAIL = '윙바디 차량 · 세종2공장 → 창원 · 동방물류센터';

async function load() {
  const errors = [];
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
      w.alert = () => {}; w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
      w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
      w.scrollTo = () => {};
      w.URL.createObjectURL = () => 'blob:fake-url';
      w.URL.revokeObjectURL = () => {};
      w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
      w.XMLHttpRequest = class { open() {} send() {} setRequestHeader() {} addEventListener() {} };
    }
  });
  await sleep(1400);
  dom.window.jisuSetBatchView(true);
  return { w: dom.window, dom, errors };
}

function preview(w, text, target) {
  const doc = w.document;
  if (target) doc.getElementById('czBatchTarget').value = target;
  const t = doc.getElementById('czBatchText');
  t.value = text;
  t.dispatchEvent(new w.Event('input', { bubbles: true }));
  const data = JSON.parse(JSON.stringify(w.jisuBatchPreviewData() || []));
  return data.flatMap(g => (g.items || []).map(it => ({ date: g.date, target: it.target, kind: it.kind, text: it.text })));
}

function saveBatch(w, text) {
  preview(w, text);
  w.document.getElementById('czBatchSaveBtn').click();
  try { return JSON.parse(w.localStorage.getItem('jisu-schedule-v1') || '[]'); } catch (_) { return []; }
}

/* A. AI(Gemini) 응답 — 줄 끝에 차종·구간·하차지가 붙어 와도 값만 남는다 */
test('A. AI 응답 꼬리표 제거 — 차량번호·수량·시간·톤수만', async () => {
  const p = await load(); const w = p.w;
  try {
    const rows = [
      ['경기80바5120', '16', '11'],
      ['부산960아2809', '12', '8'],
      ['전북85사2302', '16', '11']
    ];
    const got = preview(w, rows.map(r => `${D1} | ${r[0]} · 660 KG / ${r[1]} P · 오전 9시 · ${r[2]} TON · ${TAIL}`).join('\n'));
    assert.deepEqual(got.map(x => x.text), rows.map(r => `${r[0]} · 660 KG / ${r[1]} P · 오전 9시 · ${r[2]} TON`));
    assert.ok(got.every(x => x.target === 'outbound' && x.kind === 'instruction'));
    assert.ok(!got.some(x => /윙바디|창원|동방물류센터|세종2공장/.test(x.text)), '차종·구간·하차지가 남으면 안 된다');

    /* 표 제목이 따로 한 줄로 와도 작업 카드가 되지 않는다 */
    const got2 = preview(w, `${TAIL}\n${D1} | 경기80바5120 · 660 KG / 16 P · 오전 9시 · 11 TON\n${TAIL}\n${D1} | 부산960아2809 · 660 KG / 12 P · 오전 9시 · 8 TON`);
    assert.deepEqual(got2.map(x => x.text), [
      '경기80바5120 · 660 KG / 16 P · 오전 9시 · 11 TON',
      '부산960아2809 · 660 KG / 12 P · 오전 9시 · 8 TON'
    ]);

    /* cleanGeminiText 단계에서도 같은 정리가 된다 (입력창에 들어가는 글자) */
    const cleaned = w.__jisuCleanGeminiText('```\n' + `${D1} | 경기80바5120 · 660 KG / 16 P · 오전 9시 · 11 TON · ${TAIL}\n${TAIL}\n` + '```');
    assert.equal(cleaned, `${D1} | 경기80바5120 · 660 KG / 16 P · 오전 9시 · 11 TON`);
    assert.deepEqual(p.errors, []);
  } finally { p.dom.window.close(); }
});

/* B. 지시서 표를 그대로 붙여넣은 경우 — 탭 열(차종·출발·도착·하차지)이 있어도 값만 */
test('B. 붙여넣은 배차표 — 탭 열의 차종·구간·하차지 제외, 시간·톤수 유지', async () => {
  const p = await load(); const w = p.w;
  try {
    const table = [
      '배차일\t차량번호\t차종\t출발\t도착\t하차지\t수량\t배차시간\t톤수',
      `${D1}\t경기80바5120\t윙바디 차량\t세종2공장\t창원\t동방물류센터\t660KG/16P\t오전 9시\t11 TON`,
      `${D1}\t부산960아2809\t카고 차량\t세종2공장\t창원\t동방물류센터\t660KG/12P\t오전 9시\t8 TON`
    ].join('\n');
    const got = preview(w, table);
    assert.deepEqual(got.map(x => x.text), [
      '경기80바5120 · 660 KG / 16 P · 오전 9시 · 11 TON',
      '부산960아2809 · 660 KG / 12 P · 오전 9시 · 8 TON'
    ]);
    assert.ok(got.every(x => x.target === 'outbound'));
    assert.ok(!got.some(x => /윙바디|카고|창원|동방물류센터/.test(x.text)));
    assert.deepEqual(p.errors, []);
  } finally { p.dom.window.close(); }
});

/* C. 일반 이동작업·공지는 절대 훼손되지 않는다 (차량번호 없는 줄) */
test('C. 일반 이동작업·공지 보존', async () => {
  const p = await load(); const w = p.w;
  try {
    const got = preview(w, [
      '2공장→1공장 20 TON',
      '1동→2동 30 TON 오전',
      '2공장 → 1공장 이동',
      '[공지] 동방물류센터 납품 일정 확인',
      '[공지] 윙바디 차량 2공장 → 1공장 이동',
      `${D1} | 12가3456 · 660 KG / 20 P`
    ].join('\n'));
    const texts = got.map(x => x.text);
    assert.ok(texts.includes('2공장→1공장 20 TON'));
    assert.ok(texts.includes('1동→2동 30 TON 오전'));
    assert.ok(texts.includes('2공장 → 1공장 이동'));
    assert.ok(texts.includes('동방물류센터 납품 일정 확인'));
    assert.ok(texts.includes('윙바디 차량 2공장 → 1공장 이동'));
    assert.ok(texts.includes('12가3456 · 660 KG / 20 P'));
    /* 공지는 공지로 남는다 */
    assert.ok(got.filter(x => /동방물류센터|윙바디/.test(x.text)).every(x => x.kind === 'notice'));
    assert.deepEqual(p.errors, []);
  } finally { p.dom.window.close(); }
});

/* D. 저장까지 — 예약(스케줄)에 들어간 글자도 한 줄로 깔끔하다 */
test('D. 저장된 예약 글자도 차량번호·수량·시간·톤수만', async () => {
  const p = await load(); const w = p.w;
  try {
    const sch = saveBatch(w, [
      `${D1} | 경기80바5120 · 660 KG / 16 P · 오전 9시 · 11 TON · ${TAIL}`,
      `${D1} | 부산960아2809 · 660 KG / 12 P · 오전 9시 · 8 TON · ${TAIL}`
    ].join('\n'));
    const out = sch.filter(x => x.target === 'outbound').map(x => x.text);
    assert.deepEqual(out, [
      '경기80바5120 · 660 KG / 16 P · 오전 9시 · 11 TON',
      '부산960아2809 · 660 KG / 12 P · 오전 9시 · 8 TON'
    ]);
    assert.equal(sch.filter(x => /윙바디|동방물류센터/.test(x.text)).length, 0);
    assert.deepEqual(p.errors, []);
  } finally { p.dom.window.close(); }
});
