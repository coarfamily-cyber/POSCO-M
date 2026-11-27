// 실행: NODE_PATH=<jsdom 설치 경로> node --test tests/chief-assistant-20261128.test.js
//        (개별 실행: NODE_PATH=<jsdom 설치 경로> node tests/chief-assistant-20261128.test.js JISU/index.html)
// 2026-11-28 수뽕 님 승인: 사이드바 '지수 비서실장' — 지도 위 브러시드 메탈 말풍선(v2, 스파크 없음) +
//   무료 Gemini Flash-Lite 연동 + 코드 기반 정확 집계 + [적용 확인] 전 무쓰기.
//   · 말풍선 여닫기(아이콘 재클릭·✕·Esc·바깥 클릭) / 폭별(1920·1366·900·412) 배치 계산
//   · buildChiefContextSnapshot() 집계 정확도(합성 입력 + 2026-11-22 실제 현장 녹화본 섀도잉)
//   · [적용 확인] 전에는 localStorage 에 아무것도 쓰지 않고, 누른 뒤에만 반영
// 회귀 테스트 — jsdom + 가짜 Firebase + 가짜 IndexedDB. 네트워크·운영 DB·푸시 서버로 나가지 않는다.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeFakeFirebase } = require('./integration/fakefb');

const FILE = process.argv[2] && !process.argv[2].endsWith('.test.js') ? process.argv[2] : path.join(__dirname, '..', 'JISU', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'chief-scene-20261122.json'), 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const tomorrow = (() => { const d = new Date(Date.parse(today + 'T00:00:00Z') + 86400000); return d.toISOString().slice(0, 10); })();
const plain = x => JSON.parse(JSON.stringify(x));
const COMMANDS = 'jisu-commands-v1';
const MEMOS = 'jisu-memos-v1';

const opened = [];
function softClose(w) {
  try { w.__jisuClosed = true; } catch (_) { }
  try { (w.__jisuTimers || new Set()).forEach(id => { try { w.clearTimeout(id); w.clearInterval(id); } catch (_) { } }); } catch (_) { }
  try { (w.__jisuTimers || new Set()).clear(); } catch (_) { }
}
if (typeof test.after === 'function') test.after(async () => {
  opened.forEach(softClose); await sleep(200);
  opened.forEach(w => { try { w.close(); } catch (_) { } }); await sleep(300);
});

/* 페이지 하나 띄우기 — 밖으로 나가는 요청은 전부 가짜 응답 */
async function loadPage(seed) {
  const errors = [];
  const vc = new VirtualConsole();
  const envOnly = m => /Not implemented: HTMLCanvasElement\.prototype\.getContext/.test(m);
  vc.on('jsdomError', e => { const m = String(e.message || e); if (!envOnly(m)) errors.push('jsdom: ' + m.slice(0, 200)); });
  vc.on('error', (...a) => errors.push('error: ' + a.map(String).join(' ').slice(0, 200)));
  const fidb = require('fake-indexeddb');
  const fake = makeFakeFirebase();
  const gemini = [];
  const dom = new JSDOM(html, {
    url: 'https://jisu.test/POSCO-M/JISU/index.html',
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.firebase = fake.firebase;
      w.indexedDB = fidb.indexedDB;
      ['IDBKeyRange', 'IDBObjectStore', 'IDBIndex', 'IDBCursor', 'IDBCursorWithValue', 'IDBDatabase', 'IDBTransaction', 'IDBRequest', 'IDBOpenDBRequest', 'IDBFactory', 'IDBVersionChangeEvent'].forEach(n => { if (fidb[n]) w[n] = fidb[n]; });
      w.alert = () => { }; w.confirm = () => true;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { } }));
      w.ResizeObserver = w.ResizeObserver || class { observe() { } unobserve() { } disconnect() { } };
      w.IntersectionObserver = w.IntersectionObserver || class { observe() { } unobserve() { } disconnect() { } };
      w.scrollTo = () => { };
      w.__geminiReply = null;               /* 테스트가 넣으면 그 JSON 을 돌려준다 */
      w.fetch = (url, opts) => {
        const u = String(url);
        if (u.indexOf('generativelanguage') >= 0) {
          gemini.push({ url: u, body: opts && opts.body ? String(opts.body) : '' });
          if (w.__geminiReply) return Promise.resolve({ ok: true, json: () => Promise.resolve(w.__geminiReply) });
          return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: { message: 'API key not valid' } }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
      };
      w.__jisuClosed = false; w.__jisuTimers = new Set();
      const _st = w.setTimeout.bind(w), _si = w.setInterval.bind(w);
      w.setTimeout = (fn, ms, ...a) => { const id = _st(() => { w.__jisuTimers.delete(id); if (!w.__jisuClosed) fn(...a); }, ms); w.__jisuTimers.add(id); return id; };
      w.setInterval = (fn, ms, ...a) => { const id = _si(() => { if (!w.__jisuClosed) fn(...a); }, ms); w.__jisuTimers.add(id); return id; };
      Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
    }
  });
  opened.push(dom.window);
  await sleep(1700);
  return { w: dom.window, errors, gemini };
}

const snap = (w, day) => plain(w.eval(`window.buildChiefContextSnapshot(${day ? JSON.stringify(day) : ''})`));

/* ───────────────── 1. 화면: 버튼 위치·말풍선 여닫기 ───────────────── */
test('사이드바 제목줄 오른쪽 끝에 비서실장 아이콘이 있고, 말풍선은 처음엔 닫혀 있다', async () => {
  const p = await loadPage({});
  try {
    const btn = p.w.document.getElementById('jisuChiefBtn');
    const bubble = p.w.document.getElementById('chiefBubble');
    assert.ok(btn && bubble, '버튼·말풍선이 없다');
    assert.ok(btn.closest('.side-title-row'), '버튼이 금일작업·공지 등록 제목줄 안에 없다');
    assert.equal(btn.querySelector('img').getAttribute('src').slice(0, 15), 'data:image/png;', '아이콘은 data URI(오프라인에서도 바로 표시)');
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.equal(bubble.getAttribute('aria-hidden'), 'true');
    assert.ok(!bubble.classList.contains('is-open'));
    assert.equal(bubble.querySelectorAll('canvas').length, 0, '전기 스파크 캔버스가 남아 있다');
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

test('아이콘 재클릭·✕·Esc·바깥 클릭 네 가지로 닫힌다', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, doc = w.document;
    const btn = doc.getElementById('jisuChiefBtn');
    const bubble = doc.getElementById('chiefBubble');
    const isOpen = () => bubble.classList.contains('is-open');

    btn.click();
    assert.ok(isOpen(), '아이콘을 눌러도 열리지 않는다');
    assert.equal(btn.getAttribute('aria-expanded'), 'true');
    btn.click();
    assert.ok(!isOpen(), '아이콘 재클릭으로 닫히지 않는다');

    btn.click(); assert.ok(isOpen());
    doc.getElementById('cbClose').click();
    assert.ok(!isOpen(), '✕ 로 닫히지 않는다');

    btn.click(); assert.ok(isOpen());
    doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!isOpen(), 'Esc 로 닫히지 않는다');

    btn.click(); assert.ok(isOpen());
    const outside = doc.getElementById('mapStage') || doc.body;
    outside.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    assert.ok(!isOpen(), '바깥 클릭으로 닫히지 않는다');

    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

test('처음 열면 지금 집계로 인사한다 (예시 숫자를 지어내지 않는다)', async () => {
  const seed = {
    [COMMANDS]: JSON.stringify([{ id: 'g1', target: 'inbound', kind: 'instruction', text: '오전 HH 54 TON', day: today }]),
  };
  const p = await loadPage(seed);
  try {
    p.w.document.getElementById('jisuChiefBtn').click();
    const txt = p.w.document.getElementById('cbMsgs').textContent;
    assert.ok(/금일작업/.test(txt), '인사에 금일작업 집계가 없다: ' + txt);
    assert.ok(/1건/.test(txt), '등록한 1건이 인사에 안 나온다: ' + txt);
  } finally { softClose(p.w); }
});

/* ───────────────── 2. 폭별 배치 계산 (1920·1366·900·412) ───────────────── */
test('폭별 배치: 데스크탑은 사이드바 오른쪽 위, 모바일은 상단 중앙 · 꼬리가 아이콘을 가리킨다', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, g = (o) => plain(w.eval(`window.jisuChiefTest.geometry(${JSON.stringify(o)})`));
    /* 사이드바: clamp(288px, 20.5vw, 396px) + 16px 여백 */
    const sideW = vw => Math.min(396, Math.max(288, vw * 0.205));
    const cases = [
      { vw: 1920, vh: 1080, bubbleW: 436, bubbleH: 404, mode: 'leftTop' },
      { vw: 1366, vh: 768, bubbleW: 436, bubbleH: 404, mode: 'leftTop' },
      { vw: 900, vh: 700, bubbleW: 388, bubbleH: 430, mode: 'top' },
      { vw: 412, vh: 915, bubbleW: 388, bubbleH: 430, mode: 'top' }
    ];
    for (const c of cases) {
      const sideRight = Math.round(16 + sideW(c.vw));
      const btnTop = 100, btnBottom = btnTop + 36;
      const r = g({ vw: c.vw, vh: c.vh, sideRight, btnTop, btnBottom, bubbleW: c.bubbleW, bubbleH: c.bubbleH });
      assert.equal(r.mode, c.mode, c.vw + 'px 모드');
      assert.equal(r.overflowRight, 0, c.vw + 'px 가로 넘침');
      assert.equal(r.overflowLeft, 0, c.vw + 'px 왼쪽 넘침');
      assert.ok(r.top >= 0 && r.top + c.bubbleH <= c.vh, c.vw + 'px 세로 넘침: ' + r.top);
      if (c.mode === 'leftTop') {
        assert.ok(r.left > sideRight, c.vw + 'px: 말풍선이 사이드바를 덮는다');
        assert.ok(Math.abs(r.tail.y - (r.top + 26)) < 0.01);
        assert.ok(r.tail.x < r.left && r.tail.x > sideRight - 24, c.vw + 'px: 꼬리 끝이 아이콘 쪽이 아니다');
      } else {
        assert.ok(r.top > btnBottom, c.vw + 'px: 꼬리가 아이콘을 덮는다');
        assert.ok(Math.abs(r.tail.x - (r.left + c.bubbleW - 39)) < 0.01);
        assert.ok(r.tail.y < r.top);
      }
    }
  } finally { softClose(p.w); }
});

/* ───────────────── 3. 집계 정확도: 2026-11-22 실제 현장 녹화본 섀도잉 ───────────────── */
test('녹화본 그대로 집계된다 — 2026-11-20 / 2026-11-22 (수정 전후 결과가 같아야 한다)', async () => {
  const p = await loadPage(FX.localStorage);
  try {
    for (const day of ['2026-11-20', '2026-11-22']) {
      const s = snap(p.w, day), e = FX.expected[day];
      assert.deepEqual(s.work.total, e.work.total, day + ' 전체');
      assert.deepEqual(s.work.done, e.work.done, day + ' 완료');
      assert.deepEqual(s.work.working, e.work.working, day + ' 작업중');
      assert.deepEqual(s.work.carried, e.work.carried, day + ' 이월');
      assert.deepEqual(s.work.remaining, e.work.remaining, day + ' 잔여');
      assert.deepEqual(s.work.pending, e.work.pending, day + ' 대기');
      const zones = {};
      s.work.zones.forEach(z => { if (e.zones[z.zone]) zones[z.zone] = { total: z.total, done: z.done, carried: z.carried }; });
      assert.deepEqual(zones, e.zones, day + ' 구역별');
      assert.deepEqual([s.inbound.tons, s.inbound.rows, s.inbound.bags], [e.inbound.tons, e.inbound.rows, e.inbound.bags], day + ' 입고 합계');
      const lots = {};
      s.inbound.lots.forEach(g => { lots[g.code] = { tons: g.tons, rows: g.rows, bags: g.bags }; });
      assert.deepEqual(lots, e.inbound.lots, day + ' 입고 코드별(HH 등)');
      assert.deepEqual([s.memos.total, s.memos.unacked], [e.memos.total, e.memos.unacked], day + ' 특이사항');
      assert.equal(s.notices.length, e.notices, day + ' 공지');
      assert.deepEqual([s.env.done, s.env.total], [e.env.done, e.env.total], day + ' 환경');
      assert.equal(s.plans.today.length, e.plans.today, day + ' 오늘 예약');
    }
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

test('합성 입력: 완료·작업중·이월·공지·특이사항·예약이 정확히 갈린다', async () => {
  const seed = {
    [COMMANDS]: JSON.stringify([
      { id: 'a1', target: 'inbound:HH', kind: 'instruction', text: '오전 HH 90 TON', day: today },
      { id: 'a2', target: 'inbound:HH', kind: 'instruction', text: '오후 HH 36 TON', day: today, completed: true, done: 36 },
      { id: 'a3', target: 'production-a', kind: 'instruction', text: 'A- 75 TON', day: today, working: true },
      { id: 'a4', target: 'outbound', kind: 'instruction', text: 'RAS-2 20 TON', day: today, carried: true },
      { id: 'a5', target: 'production-b', kind: 'instruction', text: 'B- 40 TON', day: today, carryCount: 2, carryFrom: 'old1' },
      { id: 'a6', target: '*', kind: 'notice', text: '안전 점검', day: today },
      { id: 'a7', target: 'pitch', kind: 'instruction', text: '피치 4 PLT', day: '2026-11-01', completed: true, closed: true },
      { id: 'demo_dispatch_1', target: 'outbound', kind: 'instruction', text: '첨부 이미지', day: today }
    ]),
    [MEMOS]: JSON.stringify([
      { id: 'm1', target: 'environment', text: '3일째 청소 안 됨', day: today },
      { id: 'm2', target: '*', text: '야간 순찰 완료', day: today, ack: true }
    ]),
    'jisu-schedule-v1': JSON.stringify([
      { id: 's1', date: today, target: 'inbound', text: 'HH 입고 예정' },
      { id: 's2', date: tomorrow, target: 'outbound', text: 'L1 출고' },
      { id: 's3', date: today, target: 'outbound', text: '이미 반영', applied: true }
    ])
  };
  const p = await loadPage(seed);
  try {
    const s = snap(p.w);
    assert.equal(s.work.total, 5, '공지·데모·다른 날짜는 빼고 5건: ' + s.work.total);
    assert.equal(s.work.done, 1);
    assert.equal(s.work.working, 1);
    assert.equal(s.work.carried, 2, 'carried 깃발 + carryCount 둘 다 이월로 센다');
    assert.equal(s.work.remaining, 4);
    assert.equal(s.work.pending, 3);
    const byZone = Object.fromEntries(s.work.zones.map(z => [z.zone, z]));
    assert.deepEqual([byZone['inbound'].label, byZone['inbound'].total], ['입고', 2]);
    assert.deepEqual(byZone['inbound'].items.map(i => i.label), ['입고 · HH', '입고 · HH']);
    assert.equal(byZone['production-a'].items[0].status, '작업중');
    assert.equal(byZone['production-b'].items[0].status, '이월');
    assert.deepEqual([s.memos.total, s.memos.unacked], [2, 1]);
    assert.equal(s.notices.length, 1);
    assert.equal(s.plans.today.length, 1, '이미 반영된 예약은 빼고 1건');
    assert.equal(s.plans.tomorrow.length, 1);
    assert.ok(/세종2공장 날씨/.test(p.w.eval('window.jisuChief.snapshotBrief(window.buildChiefContextSnapshot())')), '프롬프트 요약에 날씨 줄이 없다');
  } finally { softClose(p.w); }
});

/* ───────────────── 4. [적용 확인] 전에는 아무것도 쓰지 않는다 ───────────────── */
test('실행 계획은 [적용 확인] 전까지 저장하지 않고, 누른 뒤에만 작업을 완료 처리한다', async () => {
  const seed = {
    [COMMANDS]: JSON.stringify([{ id: 'w1', target: 'inbound', kind: 'instruction', text: '오전 HH 54 TON', day: today }])
  };
  const p = await loadPage(seed);
  try {
    const w = p.w;
    w.localStorage.setItem('jisu-chief-gemini-key', 'AIzaTESTKEY');
    const before = w.localStorage.getItem(COMMANDS);
    w.__geminiReply = {
      candidates: [{ content: { parts: [{
        text: JSON.stringify({ reply: '오전 HH 54 TON 은 아직 남아 있습니다. 완료 처리할까요?', actions: [{ type: 'complete', id: 'w1' }] })
      }] } }]
    };
    await w.jisuChief.ask('오전 HH 완료 처리해줘');
    await sleep(120);

    assert.equal(w.localStorage.getItem(COMMANDS), before, '[적용 확인] 전에 저장이 바뀌었다');
    const plan = w.document.querySelector('[data-cb-plan]');
    assert.ok(plan, '실행 계획 말풍선이 없다');
    assert.ok(/적용 확인/.test(plan.textContent) && /나중에/.test(plan.textContent), '확인/나중에 버튼이 없다');
    assert.equal(w.jisuChief.getPending().length, 1);

    /* [나중에] → 그대로 */
    plan.querySelector('[data-cb-later]').click();
    await sleep(50);
    assert.equal(w.localStorage.getItem(COMMANDS), before, '[나중에] 를 눌렀는데 저장이 바뀌었다');
    assert.equal(w.jisuChief.getPending(), null);

    /* 다시 물어 [적용 확인] */
    await w.jisuChief.ask('오전 HH 완료 처리해줘');
    await sleep(120);
    w.document.querySelector('[data-cb-apply]').click();
    await sleep(200);
    const after = JSON.parse(w.localStorage.getItem(COMMANDS));
    const it = after.find(x => x.id === 'w1');
    assert.equal(it.completed, true, '완료 처리가 반영되지 않았다');
    assert.equal(it.working, false, '완료 처리 후에도 작업중으로 남는다');
    assert.ok(it.completedAt, '완료 시각이 없다');
    assert.equal(JSON.parse(w.localStorage.getItem(COMMANDS)).filter(x => x.id === 'w1').length, 1, '같은 항목이 복제됐다');
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

test('공지 등록 계획은 [적용 확인] 때 사이드바 등록 폼으로 실제 공지를 만든다', async () => {
  const p = await loadPage({});
  try {
    const w = p.w;
    w.localStorage.setItem('jisu-chief-gemini-key', 'AIzaTESTKEY');
    w.jisuSendNtfy = () => { };            /* 실제 알림은 보내지 않는다 */
    const before = JSON.parse(w.localStorage.getItem(COMMANDS) || '[]').length;
    w.__geminiReply = {
      candidates: [{ content: { parts: [{
        text: JSON.stringify({ reply: '공지로 올릴까요?', actions: [{ type: 'add_notice', target: '*', text: '3동 출입문 점검', urgent: true }] })
      }] } }]
    };
    await w.jisuChief.ask('3동 출입문 점검을 공지로 올려줘');
    await sleep(120);
    assert.equal(JSON.parse(w.localStorage.getItem(COMMANDS) || '[]').length, before, '[적용 확인] 전에 공지가 등록됐다');
    w.document.querySelector('[data-cb-apply]').click();
    await sleep(250);
    const all = JSON.parse(w.localStorage.getItem(COMMANDS));
    const made = all.filter(x => x.kind === 'notice' && /3동 출입문 점검/.test(x.text));
    assert.equal(made.length, 1, '공지가 등록되지 않았다: ' + JSON.stringify(all.filter(x => x.kind === 'notice')));
    assert.equal(made[0].target, '*');
    assert.equal(made[0].urgent, true);
    assert.equal(made[0].day, today);
  } finally { softClose(p.w); }
});

/* ───────────────── 5. 안전장치 ───────────────── */
test('없는 id·없는 구역·빈 내용은 실행 계획에서 걸러진다', async () => {
  const p = await loadPage({
    [COMMANDS]: JSON.stringify([{ id: 'x1', target: 'inbound', kind: 'instruction', text: 'HH 10 TON', day: today }])
  });
  try {
    const s = snap(p.w);
    const acts = plain(p.w.eval(`window.jisuChiefTest.normalizeActions(${JSON.stringify([
      { type: 'complete', id: 'nope' },
      { type: 'complete', id: 'x1' },
      { type: 'complete', id: 'x1' },
      { type: 'add_notice', target: '이상한값', text: '점검 안내' },
      { type: 'add_work', target: '없는구역', text: '내용' },
      { type: 'add_work', target: 'inbound', text: '   ' },
      { type: 'hack', id: 'x1' }
    ])}, window.buildChiefContextSnapshot())`));
    assert.equal(acts.length, 2, '유효한 두 건만 남아야 한다: ' + JSON.stringify(acts));
    assert.deepEqual([acts[0].type, acts[0].id], ['complete', 'x1']);
    assert.deepEqual([acts[1].type, acts[1].target], ['add_notice', '*']);
    /* 품목까지 적힌 대상(하위 칩)은 화면이 아는 구역으로 내려 등록한다 */
    const sub = plain(p.w.eval(`window.jisuChiefTest.baseTarget('inbound:HH')`));
    assert.equal(sub, 'inbound');
    assert.equal(plain(p.w.eval(`window.jisuChiefTest.baseTarget('없는구역')`)), '');
    assert.equal(s.work.total, 1);
  } finally { softClose(p.w); }
});

test('키가 없으면 안내하고, 전용 키 → 기존 일괄등록 키 순서로 쓴다', async () => {
  const p = await loadPage({});
  try {
    const w = p.w;
    assert.equal(w.jisuChief.hasKey(), false);
    w.document.getElementById('jisuChiefBtn').click();
    await w.jisuChief.ask('오늘 남은 작업 요약');
    await sleep(80);
    const txt = w.document.getElementById('cbMsgs').textContent;
    assert.ok(/무료 Flash-Lite 키/.test(txt), '키 안내가 없다: ' + txt);
    assert.ok(w.document.getElementById('cbKeyBox').classList.contains('is-on'), '키 입력칸이 열리지 않았다');

    w.localStorage.setItem('jisu-gemini-key', 'AIzaFALLBACK');
    assert.equal(w.jisuChief.hasKey(), true, '기존 일괄등록 키를 폴백으로 쓰지 않는다');
    w.localStorage.setItem('jisu-chief-gemini-key', 'AIzaCHIEF');
    await w.jisuChief.ask('오늘 남은 작업 요약');
    await sleep(120);
    assert.ok(p.gemini.length >= 1 && /AIzaCHIEF/.test(p.gemini[p.gemini.length - 1].url), '전용 키가 우선되지 않는다');
    const sent = JSON.parse(p.gemini[p.gemini.length - 1].body);
    assert.ok(/금일작업/.test(sent.contents[0].parts[0].text), '집계가 프롬프트에 들어가지 않았다');
  } finally { softClose(p.w); }
});
