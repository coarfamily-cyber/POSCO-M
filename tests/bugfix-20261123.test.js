// 실행: NODE_PATH=<jsdom 설치 경로> node tests/bugfix-20261123.test.js JISU/index.html
// 2026-11-23 코드감사 버그 수정(A-1~A-17 · 다중 콤마 정규식) 재현/회귀 테스트.
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

const lateErrors = [];
process.on('unhandledRejection', e => lateErrors.push(String((e && e.message) || e).slice(0, 160)));

async function loadPage({ fake, seed, before, wait = 1500 }) {
  const errors = [], warns = [];
  const vc = new VirtualConsole();
  const envOnly = m => /Not implemented: HTMLCanvasElement\.prototype\.getContext/.test(m);
  vc.on('jsdomError', e => { const m = String(e.message || e); if (!envOnly(m)) errors.push('jsdom: ' + m.slice(0, 160)); });
  vc.on('error', (...a) => errors.push('error: ' + a.map(String).join(' ').slice(0, 200)));
  vc.on('warn', (...a) => warns.push(a.map(String).join(' ').slice(0, 300)));
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
      w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
      w.scrollTo = () => {};
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
      Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
      if (before) before(w);
    }
  });
  await sleep(wait);
  return { w: dom.window, dom, errors, warns };
}

const results = [];
function ok(name, fn) {
  try { fn(); results.push('PASS ' + name); }
  catch (e) { results.push('FAIL ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}
async function okAsync(name, fn) {
  try { await fn(); results.push('PASS ' + name); }
  catch (e) { results.push('FAIL ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

(async () => {
  // ─────────────────────────── A-6 · 다중 콤마 정규식 (목표 수량 읽기)
  {
    const fake = makeFakeFirebase();
    const p = await loadPage({ fake, wait: 900 });
    const w = p.w;
    ok('A-6 goalQty 모듈이 로드됨', () => assert.equal(typeof w.jisuGoalQty, 'function'));
    const g = t => w.jisuGoalQty(t);
    ok('A-6 1동→2동 30 TON → 30 TON', () => assert.deepEqual([g('1동→2동 30 TON').n, g('1동→2동 30 TON').u], [30, 'TON']));
    ok('A-6 1동→2동 30 TON 오전 → 30 TON (1동을 읽지 않음)', () => assert.deepEqual([g('1동→2동 30 TON 오전').n, g('1동→2동 30 TON 오전').u], [30, 'TON']));
    ok('A-6 2동→3동 20 TON (마지막) → 20 TON', () => assert.equal(g('2동→3동 20 TON (마지막)').n, 20));
    ok('A-6 포장 12 EA 오후 → 12 EA', () => assert.deepEqual([g('포장 12 EA 오후').n, g('포장 12 EA 오후').u], [12, 'EA']));
    ok('A-6 단위 없는 2동→3동 20 → 20 (동 번호 제외)', () => assert.equal(g('2동→3동 20').n, 20));
    ok('A-6 [RAS-2] 접두사 안의 숫자는 목표가 아님', () => assert.equal(g('[RAS-2] 3동 45 TON').n, 45));
    ok('A-6 1,200 TON 다중 콤마', () => assert.equal(g('출고 1,200 TON').n, 1200));
    ok('A-6 1,200,000 KG 다중 콤마', () => assert.deepEqual([g('입고 1,200,000 KG').n, g('입고 1,200,000 KG').u], [1200000, 'KG']));
    ok('A-6 12,5톤(유럽식 소수) → 12.5 TON', () => assert.deepEqual([g('12,5톤').n, g('12,5톤').u], [12.5, 'TON']));
    ok('A-6 50t → 50 TON', () => assert.equal(g('피치 50t').u, 'TON'));
    ok('A-6 TON 이 있으면 TON 을 목표로 — 11 TON (660 KG / 16 P) → 11 TON', () => assert.deepEqual([g('11 TON (660 KG / 16 P)').n, g('11 TON (660 KG / 16 P)').u], [11, 'TON']));
    ok('#28145-3 배차 줄 팩 수량은 총 톤수로 — 660 KG / 16 P → 10.56 TON', () => {
      const q = g('12가3456 · 660 KG / 16 P');
      assert.deepEqual([q.n, q.u, !!q.kp], [10.56, 'TON', true]);
    });
    ok('#28145-3 다중 콤마 팩 수량 — 1,200 KG / 10 P → 12 TON', () => assert.deepEqual([g('1,200 KG / 10 P').n, g('1,200 KG / 10 P').u], [12, 'TON']));
    ok('#28145-3 이월·수량 수정은 팩 수량 자리를 통짜 TON 으로 바꿈', () => {
      assert.equal(w.jisuGoalWithQty('12가3456 · 660 KG / 16 P', 5), '12가3456 · 5 TON');
      assert.equal(w.jisuGoalWithQty('1동→2동 30 TON 오전', 12), '1동→2동 12 TON 오전');
    });
    ok('#28145-3 팩 수량이 아닌 KG 는 그대로 (16 KG 파렛트 576 EA → 576 EA)', () => assert.deepEqual([g('16 KG 파렛트 576 EA').n, g('16 KG 파렛트 576 EA').u], [576, 'EA']));
    ok('콤마 규칙: 단위 통일이 다중 콤마를 보존', () => {
      assert.equal(w.jisuNormUnit('1,200,000kg'), '1,200,000 KG');
      assert.equal(w.jisuNormUnit('2,400 EA'), '2,400 EA');
      assert.equal(w.jisuNormUnit('1,200t'), '1,200 TON');
      assert.equal(w.jisuNormUnit('알루미늄 파우치백 1,200개'), '알루미늄 파우치백 1,200 EA');
    });
    ok('콤마 규칙: 파렛트 환산도 다중 콤마 수량을 읽음', () => {
      assert.equal(w.jisuNormUnit('파렛트 1,728개'), '파렛트 6대');
    });
    ok('A-6 페이지 로드 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  // ─────────────────────────── A-17 해 넘기는 기간 (4~9월에 12/30~1/2)
  {
    const b = html.indexOf('function inferBatchYear(mo)');
    const e = html.indexOf('function isDateHeader(line)');
    assert.ok(b > 0 && e > b, '기간 파서 구간을 찾음');
    const code = html.slice(b, e);
    const factory = new Function('kstToday', 'isValidYmd', 'fmtYmd', 'shiftYmd', code + '\nreturn { isDateRangeHeader: isDateRangeHeader };');
    const isValidYmd = (y, m, d) => { if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false; const dt = new Date(y, m - 1, d); return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d; };
    const fmtYmd = (y, m, d) => y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const shiftYmd = (base, delta) => { const q = String(base).split('-').map(Number); const dt = new Date(q[0], q[1] - 1, q[2] + (delta || 0)); return fmtYmd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()); };
    const april = factory(() => '2026-04-10', isValidYmd, fmtYmd, shiftYmd);
    const nov = factory(() => '2026-11-23', isValidYmd, fmtYmd, shiftYmd);
    ok('A-17 4월에 12/30~1/2 → 4일 (2026-12-30~2027-01-02)', () => {
      const r = april.isDateRangeHeader('12/30~1/2');
      assert.ok(r, '기간 헤더로 인식');
      assert.deepEqual(r.dates, ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
    });
    ok('A-17 11월에 12/30~1/2 → 4일', () => {
      const r = nov.isDateRangeHeader('12/30~1/2');
      assert.deepEqual(r.dates, ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
    });
    ok('A-17 4월에 9/28~10/2 는 같은 해 (잘못 +1년 하지 않음)', () => {
      const r = april.isDateRangeHeader('9/28~10/2');
      assert.deepEqual(r.dates, ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    });
    ok('#28145-1 끝 날짜에 월이 생략된 1월 2일~5일 (11월 기준) → 2027-01-02~05 4일', () => {
      const r = nov.isDateRangeHeader('1월 2일~5일');
      assert.ok(r, '기간 헤더로 인식');
      assert.deepEqual(r.dates, ['2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05']);
    });
    ok('#28145-1 끝 날짜에 월이 생략된 1/1~5 (11월 기준) → 2027-01-01~05 5일', () => {
      const r = nov.isDateRangeHeader('1/1~5');
      assert.ok(r, '기간 헤더로 인식');
      assert.deepEqual(r.dates, ['2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05']);
    });
    ok('#28145-1 1월에 1월 2일~5일 → 2026-01-02~05 4일', () => {
      const jan = factory(() => '2026-01-10', isValidYmd, fmtYmd, shiftYmd);
      const r = jan.isDateRangeHeader('1월 2일~5일');
      assert.deepEqual(r.dates, ['2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
    });
    ok('#28145-1 끝 날짜의 월이 있으면 그 월을 그대로 (11/25~12/2)', () => {
      const r = nov.isDateRangeHeader('11/25~12/2');
      assert.deepEqual(r.dates, ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
    });
  }

  // ─────────────────────────── A-7 · A-15 · A-5(부분) 일괄등록 UI
  {
    const fake = makeFakeFirebase();
    const md = mdKst;
    fake.setServer('jisu/state/jisu-commands-v1', { t: 1000, by: 'server', v: JSON.stringify([
      { id: 'oldA', target: 'A', kind: 'instruction', text: '1동 예전 기록 5 TON', at: md + ' 09:00', day: todayKst },
      { id: 'oldC', target: 'C', kind: 'instruction', text: '2동 예전 기록 10 TON', at: md + ' 09:10', day: todayKst },
      { id: 'oldD', target: 'D', kind: 'instruction', text: '3동 예전 기록 7 TON', at: md + ' 09:20', day: todayKst }
    ]) });
    const p = await loadPage({ fake, wait: 1600 });
    const w = p.w;
    const doc = w.document;
    ok('A-7 #czBatchTarget 1·2·3동 값이 cmdTarget 과 같은 1·2·3', () => {
      const sel = doc.getElementById('czBatchTarget');
      const vals = [...sel.options].map(o => o.value);
      ['1', '2', '3'].forEach(v => assert.ok(vals.includes(v), 'value ' + v));
      ['A', 'C', 'D'].forEach(v => assert.ok(!vals.includes(v), '예전 값 제거 ' + v));
      const labels = {}; [...sel.options].forEach(o => { labels[o.value] = o.textContent; });
      assert.deepEqual([labels['1'], labels['2'], labels['3']], ['1동', '2동', '3동']);
    });
    ok('A-7 예전 기록(A·C·D)은 화면에서 그대로 1동·2동·3동으로 보인다', () => {
      const body = doc.body.textContent;
      ['1동', '2동', '3동'].forEach(v => assert.ok(body.includes(v), v + ' 표시'));
      assert.ok(!/\b[C]동\b/.test(body), 'C동 같은 내부 키가 그대로 보이면 안 됨');
    });
    // 일괄등록 미리보기는 parseLine 을 그대로 쓴다 → 구역명이 붙은 공지가 그 구역으로 가는지 확인
    const preview = (text, target) => new Promise(res => {
      const ta = doc.getElementById('czBatchText');
      const sel = doc.getElementById('czBatchTarget');
      if (target) sel.value = target;
      ta.value = text;
      ta.dispatchEvent(new w.Event('input', { bubbles: true }));
      setTimeout(() => res(doc.getElementById('czBatchPreview').textContent), 120);
    });
    const pv1 = await preview('공지 출고 바닥 공사 있습니다', 'outbound');
    ok('A-15 "공지 출고 바닥 공사" → 출고 버튼 공지 (전체 공지 아님)', () => {
      assert.ok(/출고/.test(pv1), pv1);
      assert.ok(/바닥 공사/.test(pv1), pv1);
      assert.ok(!/전체/.test(pv1), '전체 공지로 잡히면 안 됨: ' + pv1);
    });
    const pv2 = await preview('공지 바닥 공사 있습니다', 'outbound');
    ok('A-15 구역명 없는 "공지 …" → 전체 공지', () => {
      assert.ok(/전체/.test(pv2), pv2);
      assert.ok(/바닥 공사/.test(pv2), pv2);
    });
    const pv3 = await preview('공지 입고 16kg 파렛트 도착 예정', 'inbound');
    ok('A-15 "공지 입고 …" → 입고 버튼 공지', () => {
      assert.ok(/입고/.test(pv3) && !/전체/.test(pv3), pv3);
    });
    ok('A-7/A-15 페이지 로드 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  // ─────────────────────────── A-1 교대 초기화가 빈 입고 저장 차단에 걸리지 않음
  {
    const fake = makeFakeFirebase();
    const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 86400000));
    const inbound = {
      [todayKst]: { day: todayKst, shiftKey: yesterday + '-am', workState: 'idle',
        rows: [{ rid: 'r1', lot: 'L1', bag: '1', kg: '1000', loc: '12가3456', worker: '김' }],
        archivedRows: [{ rid: 'r0', lot: 'L0', bag: '1', kg: '900', loc: '', worker: '' }] }
    };
    fake.setServer('jisu/state/jisu-inbound-records-v1', { v: JSON.stringify(inbound), t: 1000, by: 'server' });
    const p = await loadPage({ fake, wait: 1800 });
    const w = p.w;
    await okAsync('A-1 교대가 바뀌면 입력칸이 비워지고 보관(archivedRows)으로 옮겨진다', async () => {
      const rec = w.jisuInboundArchive.getToday();
      assert.notEqual(rec.shiftKey, yesterday + '-am', '교대키 갱신');
      // 서버에 정상 초기화가 올라갈 때까지 기다린다 (동기화 150ms 지연)
      let server = null;
      for (let i = 0; i < 25; i++) {
        server = fake.getServer('jisu/state/jisu-inbound-records-v1');
        if (server && server.v) {
          const day = JSON.parse(server.v)[todayKst];
          if (day && Array.isArray(day.rows) && day.rows.length === 0) break;
        }
        await sleep(150);
      }
      const day = JSON.parse(server.v)[todayKst];
      assert.deepEqual(day.rows, [], '서버 rows 비움 (가드에 되돌려지지 않음)');
      assert.deepEqual(day.archivedRows.map(r => r.rid), ['r0', 'r1'], '보관분 뒤로 이어 붙임');
      const local = JSON.parse(w.localStorage.getItem('jisu-inbound-records-v1'))[todayKst];
      assert.deepEqual(local.rows, [], '이 기기 입력칸도 비움');
    });
    await sleep(1500);
    ok('A-1 빈 입고 덮어쓰기 차단 경고가 뜨지 않는다 (무한 반복 없음)', () => assert.ok(!p.warns.some(x => /빈 입고 중량 기록 덮어쓰기 차단/.test(x)), p.warns.join(' | ')));
    // 진짜 사고(행을 보관 없이 빈 값으로 덮어쓰기)는 계속 차단되어야 한다
    await okAsync('A-1 진짜 빈 덮어쓰기 사고는 계속 차단 (가드 유지)', async () => {
      const cur = JSON.parse(w.localStorage.getItem('jisu-inbound-records-v1'));
      const shift = (cur[todayKst] || {}).shiftKey;
      // ① 정상적으로 행 1개를 올려 서버·이 기기의 비교 기준(lastSent)에 행이 있게 만든다
      w.localStorage.setItem('jisu-inbound-records-v1', JSON.stringify({
        [todayKst]: { day: todayKst, shiftKey: shift, rows: [{ rid: 'keep1', lot: 'K', bag: '1', kg: '500' }], archivedRows: [], workState: 'idle' } }));
      await sleep(900);
      // ② 행을 보관(archivedRows) 없이 빈 값으로 덮어쓰기 = 사고 상황
      w.localStorage.setItem('jisu-inbound-records-v1', JSON.stringify({
        [todayKst]: { day: todayKst, shiftKey: shift, rows: [], archivedRows: [], workState: 'idle' } }));
      await sleep(1200);
      assert.ok(p.warns.some(x => /빈 입고 중량 기록 덮어쓰기 차단/.test(x)), '가드 경고가 나와야 함');
    });
    ok('A-1 페이지 로드 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  // ─────────────────────────── A-2 엑셀 자동 저장 표식 통일
  {
    const fake = makeFakeFirebase();
    const p = await loadPage({ fake, wait: 1200 });
    const w = p.w;
    ok('A-2 표식 계산 함수가 노출됨', () => assert.equal(typeof w.jisuInboundExcelMark, 'function'));
    const rec = { day: todayKst, shiftKey: todayKst + '-pm', workState: 'done', completedAt: mdKst + ' 18:05',
      rows: [], archivedRows: [{ rid: 'a' }, { rid: 'b' }] };
    const mark = w.jisuInboundExcelMark(rec);
    ok('A-2 완료 표식 키 = 교대키, 값 = <교대키>:done:<완료시각>:<건수>', () => {
      assert.equal(mark.key, 'jisu-inb-auto-xlsx-' + todayKst + '-pm');
      assert.equal(mark.tag, (todayKst + '-pm') + ':done:' + rec.completedAt + ':2');
    });
    // 완료 버튼 경로가 남기는 표식과 동기화 수신 경로가 비교하는 표식이 같아야 두 번 받지 않는다
    const all = {}; all[todayKst] = rec;
    w.localStorage.setItem('jisu-inbound-records-v1', JSON.stringify(all));
    ok('A-2 동기화 수신 표식 == 완료 버튼 표식 (같아야 재다운로드 없음)', () => {
      const again = w.jisuInboundExcelMark(JSON.parse(w.localStorage.getItem('jisu-inbound-records-v1'))[todayKst]);
      assert.deepEqual(again, mark);
    });
    ok('A-2 예전 형식(날짜 키 + 완료시각 값)과 섞이지 않는다', () => {
      w.localStorage.setItem('jisu-inb-auto-xlsx-' + todayKst, rec.completedAt);   // 예전 코드가 남기던 표식
      const again = w.jisuInboundExcelMark(rec);
      assert.equal(w.localStorage.getItem(again.key), null, '교대키 표식은 따로');
      w.localStorage.removeItem('jisu-inb-auto-xlsx-' + todayKst);
    });
    ok('A-2 페이지 로드 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  // ─────────────────────────── A-4 환경·피치 3-way 병합
  {
    const fake = makeFakeFirebase();
    const p = await loadPage({ fake, wait: 1000 });
    const w = p.w;
    ok('A-4 병합 함수가 노출됨', () => {
      assert.equal(typeof w.jisuMerge.env, 'function');
      assert.equal(typeof w.jisuMerge.envLog, 'function');
      assert.equal(typeof w.jisuMerge.pitch, 'function');
    });
    ok('A-4 환경: 두 기기가 서로 다른 설비를 체크하면 둘 다 남는다', () => {
      const base = { round: 3, u: {
        '1,2': { s: '', subs: { '분체': { s: '' }, '충진기': { s: '' }, '포장기': { s: '' }, '소성로': { s: '' } } },
        '3,4': { s: '', subs: { '분체': { s: '' }, '충진기': { s: '' }, '포장기': { s: '' }, '소성로': { s: '' } } } } };
      const mine = JSON.parse(JSON.stringify(base));
      mine.u['1,2'].subs['분체'] = { s: 'done', ts: '18:01', td: '18:20', day: todayKst, doneAt: 1763900000000 };
      const theirs = JSON.parse(JSON.stringify(base));
      theirs.u['3,4'].subs['포장기'] = { s: 'done', ts: '18:02', td: '18:25', day: todayKst, doneAt: 1763900100000 };
      const out = JSON.parse(w.jisuMerge.env(JSON.stringify(base), JSON.stringify(mine), JSON.stringify(theirs)));
      assert.equal(out.u['1,2'].subs['분체'].s, 'done', '내 체크 유지');
      assert.equal(out.u['3,4'].subs['포장기'].s, 'done', '다른 기기 체크 유지');
      assert.equal(out.u['1,2'].doneCnt, 1, '파생값 재계산');
      assert.equal(out.u['3,4'].doneCnt, 1);
    });
    ok('A-4 환경: 회차(round)는 더 큰 값, 청소 확인(ack)은 더 나중 날짜', () => {
      const base = { round: 3, u: {}, a: { s: '', subs: {} }, ack: {} };
      const mine = { round: 4, u: {}, a: { s: '', subs: {} }, ack: { '1,2': '2026-11-20' } };
      const theirs = { round: 3, u: {}, a: { s: '', subs: {} }, ack: { '1,2': '2026-11-22', '3,4': '2026-11-22' } };
      const out = JSON.parse(w.jisuMerge.env(JSON.stringify(base), JSON.stringify(mine), JSON.stringify(theirs)));
      assert.equal(out.round, 4);
      assert.equal(out.ack['1,2'], '2026-11-22');
      assert.equal(out.ack['3,4'], '2026-11-22');
    });
    ok('A-4 환경: 같은 설비를 서로 다르게 바꾸면 더 진행된 단계(완료)가 남는다', () => {
      const base = { round: 1, u: { '1,2': { subs: { '분체': { s: '' } } } }, a: { s: '', subs: {} } };
      const mine = { round: 1, u: { '1,2': { subs: { '분체': { s: 'done', td: '18:30' } } } }, a: { s: '', subs: {} } };
      const theirs = { round: 1, u: { '1,2': { subs: { '분체': { s: 'work', ts: '18:10' } } } }, a: { s: '', subs: {} } };
      const out = JSON.parse(w.jisuMerge.env(JSON.stringify(base), JSON.stringify(mine), JSON.stringify(theirs)));
      assert.equal(out.u['1,2'].subs['분체'].s, 'done');
    });
    ok('A-4 청소 기록: 두 기기가 다른 설비를 완료하면 두 기록이 모두 남는다', () => {
      const base = [{ day: todayKst, unit: '1,2', equip: '분체', round: 1, ts: '18:00', td: '18:10' }];
      const mine = base.concat([{ day: todayKst, unit: '1,2', equip: '충진기', round: 1, ts: '18:05', td: '18:15' }]);
      const theirs = base.concat([{ day: todayKst, unit: '3,4', equip: '포장기', round: 1, ts: '18:06', td: '18:16' }]);
      const out = JSON.parse(w.jisuMerge.envLog(JSON.stringify(base), JSON.stringify(mine), JSON.stringify(theirs)));
      const keys = out.map(x => x.unit + '/' + x.equip + '/' + x.round);
      assert.deepEqual(keys.sort(), ['1,2/분체/1', '1,2/충진기/1', '3,4/포장기/1']);
    });
    ok('A-4 청소 기록: 완료를 되돌려 지운 기록은 되살아나지 않는다', () => {
      const base = [{ day: todayKst, unit: '1,2', equip: '분체', round: 1 }];
      const mine = [];                                     // 내가 되돌려 지움
      const theirs = base.slice();                         // 서버에는 아직 남아 있음
      const out = JSON.parse(w.jisuMerge.envLog(JSON.stringify(base), JSON.stringify(mine), JSON.stringify(theirs)));
      assert.deepEqual(out, []);
    });
    ok('A-4 피치: 두 기기가 다른 날짜를 저장하면 둘 다 남는다', () => {
      const base = { '2026-11-20': { grind1: '10', workState: 'done', savedAt: 1 } };
      const mine = { '2026-11-20': { grind1: '10', workState: 'done', savedAt: 1 }, '2026-11-22': { grind1: '5', workState: 'work', savedAt: 50 } };
      const theirs = { '2026-11-20': { grind1: '10', workState: 'done', savedAt: 1 }, '2026-11-21': { grind1: '7', workState: 'done', savedAt: 60 } };
      const out = JSON.parse(w.jisuMerge.pitch(JSON.stringify(base), JSON.stringify(mine), JSON.stringify(theirs)));
      assert.deepEqual(Object.keys(out).sort(), ['2026-11-20', '2026-11-21', '2026-11-22']);
    });
    ok('A-4 피치: 같은 날을 둘 다 바꾸면 완료·최근 저장 쪽', () => {
      const base = { d1: { grind1: '1', workState: 'work', savedAt: 10 } };
      const mine = { d1: { grind1: '2', workState: 'work', savedAt: 20 } };
      const theirs = { d1: { grind1: '3', workState: 'done', savedAt: 15 } };
      const out = JSON.parse(w.jisuMerge.pitch(JSON.stringify(base), JSON.stringify(mine), JSON.stringify(theirs)));
      assert.equal(out.d1.workState, 'done');
    });
    ok('A-4 병합 결과는 항상 유효한 JSON', () => {
      ['env', 'envLog', 'pitch'].forEach(k => {
        const out = w.jisuMerge[k]('', 'null', '');
        assert.equal(typeof out, 'string');
        assert.doesNotThrow(() => JSON.parse(out), k);
      });
    });
    ok('A-4 페이지 로드 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  // ─────────────────────────── A-12 사진 삭제는 그 구역 경로만
  {
    const fake = makeFakeFirebase();
    fake.setServer('jisu/photos/outbound/same1', { id: 'same1', zone: 'outbound', data: 'x', ts: Date.now() });
    fake.setServer('jisu/photos/pitch/same1', { id: 'same1', zone: 'pitch', data: 'y', ts: Date.now() });
    const p = await loadPage({ fake, wait: 2200 });
    const w = p.w;
    await okAsync('A-12 통합 사진 저장소에서 지우면 그 구역 경로만 지운다', async () => {
      const store = await new Promise((res, rej) => {
        const r = w.indexedDB.open('jisu-zone-photos-v1', 1);
        r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('photos')) r.result.createObjectStore('photos', { keyPath: 'id' }); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      await new Promise((res, rej) => {
        const t = store.transaction('photos', 'readwrite');
        t.objectStore('photos').put({ id: 'same1', zone: 'outbound', day: todayKst, data: 'data:image/jpeg;base64,AAA' });
        t.oncomplete = () => res(); t.onerror = () => rej(t.error);
      });
      await sleep(400);                                   // 색인(포토존) 반영
      await new Promise((res, rej) => {
        const t = store.transaction('photos', 'readwrite');
        t.objectStore('photos').delete('same1');
        t.oncomplete = () => res(); t.onerror = () => rej(t.error);
      });
      await sleep(500);
      store.close();
    });
    ok('A-12 지운 구역(outbound)만 서버에서 사라지고 pitch 사진은 남는다', () => {
      assert.equal(fake.getServer('jisu/photos/outbound/same1'), null, 'outbound 삭제');
      assert.ok(fake.getServer('jisu/photos/pitch/same1'), 'pitch 유지');
    });
    ok('A-12 전 구역 null 쓰기가 없다 (update 경로 확인)', () => {
      const upd = fake.state.log.filter(x => x.op === 'update' && x.path === 'jisu/photos');
      upd.forEach(x => x.keys.forEach(k => assert.ok(!/^(pitch|inbound|packaging)\//.test(k), '다른 구역 경로를 건드리면 안 됨: ' + k)));
    });
    ok('A-12 페이지 로드 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  // ─────────────────────────── A-13 상단 시계 KST · A-14 Storage 가로채기
  {
    const fake = makeFakeFirebase();
    const p = await loadPage({ fake, wait: 1500 });
    const w = p.w;
    ok('A-13 상단 시계가 KST 기준', () => {
      const el = w.document.getElementById('liveClock');
      assert.ok(el && el.textContent, '시계 있음');
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
      }).formatToParts(new Date()).map(x => [x.type, x.value]));
      const hh = String(Number(parts.hour) % 24).padStart(2, '0');
      const want = `${parts.year}-${parts.month}-${parts.day} ${hh}:${parts.minute}`;
      assert.ok(el.textContent.startsWith(want), '기대 ' + want + ' / 실제 ' + el.textContent);
    });
    ok('A-14 sessionStorage.setItem 은 localStorage 로 새지 않는다', () => {
      w.sessionStorage.setItem('jisu-commands-v1', JSON.stringify([{ id: 'sessionOnly' }]));
      assert.equal(w.localStorage.getItem('jisu-commands-v1') === null ? null : JSON.parse(w.localStorage.getItem('jisu-commands-v1')).filter(x => x && x.id === 'sessionOnly').length, 0, 'localStorage 오염 없음');
      assert.ok(JSON.parse(w.sessionStorage.getItem('jisu-commands-v1'))[0].id === 'sessionOnly');
    });
    ok('A-14 localStorage.setItem 은 그대로 동작', () => {
      w.localStorage.setItem('jisu-probe', 'ok');
      assert.equal(w.localStorage.getItem('jisu-probe'), 'ok');
    });
    ok('A-13/A-14 페이지 로드 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  // ─────────────────────────── A-11 복귀 시 날씨 갱신
  {
    const fake = makeFakeFirebase();
    let fetchCount = 0, urls = [];
    const p = await loadPage({
      fake, wait: 1200,
      before(w) {
        w.fetch = (u) => { fetchCount++; urls.push(String(u)); return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') }); };
      }
    });
    const w = p.w;
    const before = fetchCount;
    ok('A-11 날씨를 처음 한 번 받는다', () => assert.ok(fetchCount >= 1, 'fetch ' + fetchCount));
    // 탭 숨김 → 복귀
    Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => true });
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    await sleep(50);
    const mid = fetchCount;
    Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => false });
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    await sleep(300);
    ok('A-11 탭으로 돌아오면 맑음/흐림이어도 날씨를 다시 받는다', () => assert.ok(fetchCount > mid, '복귀 전 ' + mid + ' → 복귀 후 ' + fetchCount));
    ok('A-11 날씨 요청은 met.no/wttr 뿐', () => {
      const weather = urls.filter(u => /api\.met\.no|wttr\.in/.test(u)).length;
      assert.ok(weather >= 2, '날씨 요청 ' + weather + '건: ' + urls.join(','));
    });
    ok('A-11 페이지 로드 JS 오류 0', () => assert.deepEqual(p.errors.filter(e => !/Not implemented/.test(e)), []));
    p.dom.window.close();
  }

  // ─────────────────────────── A-16 로그인 게이트 ON · SDK 지연 로드
  {
    const fake = makeFakeFirebase();
    let authAsked = false;
    const p = await loadPage({
      fake, wait: 1800,
      before(w) {
        w.JISU_AUTH_GATE = true;
        w.Notification = { permission: 'granted', requestPermission: () => Promise.resolve('granted') };
        w.navigator.serviceWorker = { getRegistration: () => Promise.resolve(null), register: () => Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(null), subscribe: () => Promise.resolve(null) } }), ready: Promise.resolve({}) };
        w.PushManager = function () {};
        // Firebase SDK 를 페이지 스크립트보다 늦게 붙인다 (실제 로드 순서 재현)
        const fb = fake.forDevice(null);
        const origAuth = fb.auth;
        fb.auth = () => { authAsked = true; return origAuth.call(fb); };
        w.firebase = undefined;
        setTimeout(() => { w.firebase = fb; }, 120);
      }
    });
    const w = p.w;
    ok('A-16 게이트 ON + SDK 지연: 로그인 전에 알림 재연결 오탐을 띄우지 않는다', () => {
      assert.equal(w.document.getElementById('jisuNotifAsk'), null, '재연결 배지 없음');
    });
    ok('A-16 게이트 ON: SDK 가 늦게 와도 로그인 상태 감시를 붙인다', () => {
      assert.equal(authAsked, true, 'firebase.auth() 사용 = onAuthStateChanged 등록 경로');
    });
    ok('A-16 페이지 로드 JS 오류 0', () => assert.deepEqual(p.errors.filter(e => !/Not implemented/.test(e)), []));
    p.dom.window.close();
  }

  // ─────────────────────────── 2026-11-23 오후 수정 (입고 쉼표·특이사항 이동·카드 삭제·일괄등록 파서)
  {
    const fake = makeFakeFirebase();
    const kst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    /* 실행 시각 의존 제거: 입고 패널은 지금 교대(08~18 = -am, 18~08 = 전날 -pm)의 기록만 그린다.
       '-pm' 로 고정하면 오전에 돌릴 때 교대 초기화로 보관되며 합계가 0 이 된다. */
    const shiftNow = (() => {
      const h = +Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value])).hour;
      if (h >= 18) return kst + '-pm';
      if (h >= 8) return kst + '-am';
      return new Date(Date.parse(kst + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10) + '-pm';
    })();
    const inbound = { [kst]: { day: kst, shiftKey: shiftNow, workState: 'idle', rows: [
      { rid: 'r1', lot: 'LOT-A', bag: '10', kg: '1,200', loc: '12가3456', worker: '지수' },
      { rid: 'r2', lot: 'LOT-B', bag: '8', kg: '480', loc: '34나5678', worker: '지수' },
    ] } };
    const memos = [
      { id: 'm1', target: '*', tag: 'issue', text: '전 구역 소음', at: '11. 23. 10:00', day: kst },
      { id: 'm2', target: 'outbound', tag: 'issue', text: '도색 냄새', at: '11. 23. 10:05', day: kst },
    ];
    const cmds = [{ id: 'e1', target: 'outbound', kind: 'instruction', text: '출고 30 TON', at: '11. 23. 09:00', day: kst }];
    const p = await loadPage({ fake, wait: 1500, seed: {
      'jisu-inbound-records-v1': JSON.stringify(inbound),
      'jisu-memos-v1': JSON.stringify(memos),
      'jisu-commands-v1': JSON.stringify(cmds),
    } });
    const w = p.w, doc = w.document;
    const $ = id => doc.getElementById(id);

    ok('#28145 후속: 입고 "1,200" 중량이 1 이 아니라 1200 으로 집계된다', () => {
      assert.equal($('inboundSumKg').textContent.replace(/,/g, ''), '1680.0', '합계 = 1200 + 480');
      const cell = doc.querySelector('#inboundTbody .inb-kg-val');
      assert.ok(cell && cell.textContent.trim().replace(/\s/g, '') === '1200', '셀 표시: ' + (cell && cell.textContent));
    });

    ok('#28145 후속: nowStr 계열은 hourCycle h23 을 명시한다 (자정 "24:00" 방지)', () => {
      const src = fs.readFileSync(FILE, 'utf8');
      const bad = src.split('\n').filter(l => /const (nowStr|nowStamp|stamp|now|at)=\s*\(\)?\s*=>/.test(l) && /hour12:false/.test(l) && !/hourCycle/.test(l));
      assert.deepEqual(bad.map(s => s.trim().slice(0, 60)), []);
    });

    ok('#28145 후속: HOME 전체(*) 특이사항을 누르면 HOME 으로 (죽은 클릭 아님)', () => {
      const sel = $('cmdTarget');
      sel.value = 'outbound'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
      // HOME 목록은 HOME 일 때만 보이므로, 전체 항목은 HOME 에서 눌러야 한다
      sel.value = ''; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
      const row = doc.querySelector('[data-memo-goto="*"]');
      assert.ok(row, '전체 특이사항 행이 HOME 목록에 있다');
      row.click();
      assert.equal($('cmdTarget').value, '', 'HOME 유지');
    });

    ok('#28145 후속: 수정 중이던 카드를 삭제하면 수정 상태도 지운다', () => {
      $('cmdTarget').value = 'outbound'; $('cmdTarget').dispatchEvent(new w.Event('change', { bubbles: true }));
      const edit = doc.querySelector('[data-cmd-edit="e1"]');
      assert.ok(edit, '수정 버튼');
      edit.click();
      assert.ok(doc.querySelector('[data-cmd-edit-in="e1"]'), '수정 입력칸 열림');
      doc.querySelector('[data-cmd-del="e1"]').click();
      assert.equal(doc.querySelector('[data-cmd-edit-in]'), null, '수정 입력칸 없음');
      const left = JSON.parse(w.localStorage.getItem('jisu-commands-v1') || '[]').filter(x => x.id === 'e1');
      assert.equal(left.length, 0, '카드 삭제');
    });

    // 일괄등록 파서: 소수점("1.5배")이 목록 번호로 잘리지 않고, 기호만 있는 줄은 카드가 되지 않는다
    await okAsync('#28145 후속: 일괄등록 "1.5배" 유지 + "###" 무시 + 이동 문장 보존', async () => {
      assert.ok(w.jisuSetBatchView, 'setBatchView 노출');
      const ta = $('czBatchText');
      ta.value = '11/28\n1.5배 증산 10 EA\n###\n2동→3동 20 TON (마지막)';
      ta.dispatchEvent(new w.Event('input', { bubbles: true }));
      await sleep(200);
      const prev = $('czBatchPreview').textContent;
      assert.ok(prev.includes('1.5배 증산 10 EA'), '1.5배 유지: ' + prev.slice(0, 160));
      assert.ok(!prev.includes('###'), '### 무시');
      assert.ok(prev.includes('2동→3동 20 TON'), '이동 문장 보존: ' + prev.slice(0, 200));
      $('czBatchSaveBtn').click();
      await sleep(400);
      const sch = JSON.parse(w.localStorage.getItem('jisu-schedule-v1') || '[]');
      assert.equal(sch.length, 2, '2건 저장: ' + JSON.stringify(sch.map(s => s.text)));
      assert.ok(sch.some(s => s.text.includes('1.5배')), '1.5배 저장');
      assert.ok(sch.some(s => s.text.includes('2동→3동')), '이동 문장 저장');
    });

    ok('후속 수정 페이지 로드 JS 오류 0', () => assert.deepEqual(p.errors.filter(e => !/Not implemented/.test(e)), []));
    p.dom.window.close();
  }

  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL'));
  console.log('\n' + (failed.length ? 'FAILED ' + failed.length + ' / ' : '') + 'TOTAL ' + results.length + ' checks, PASS ' + (results.length - failed.length));
  if (lateErrors.length) console.log('닫힌 페이지의 늦은 거부(무시): ' + lateErrors.length + '건');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
