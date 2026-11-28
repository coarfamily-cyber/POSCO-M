// 실행: NODE_PATH=<jsdom 설치 경로> node --test tests/chief-assistant-20261128.test.js
//        (개별 실행: NODE_PATH=<jsdom 설치 경로> node tests/chief-assistant-20261128.test.js JISU/index.html)
// 2026-11-28 수뽕 님 승인: 사이드바 '지수 비서실장' — 지도 위 브러시드 메탈 말풍선(v2, 스파크 없음) +
//   무료 Gemini Flash-Lite 연동 + 코드 기반 정확 집계 + [적용 확인] 전 무쓰기.
//   · 말풍선 여닫기(아이콘 재클릭·✕·Esc·바깥 클릭) / 폭별(1920·1366·900·412) 배치 계산
//   · buildChiefContextSnapshot() 집계 정확도(합성 입력 + 2026-11-22 실제 현장 녹화본 섀도잉)
//   · [적용 확인] 전에는 localStorage 에 아무것도 쓰지 않고, 누른 뒤에만 반영
//   · 07:40·17:40 자동 브리핑(jisu-chief-briefing-v1) — 관리자 화면 말풍선 자동 오픈,
//     같은 회차 재오픈 방지(seen), 작업자(?zone=)·키오스크(?kiosk=1) 미오픈, 만료 무시
//   · 강조는 '검정 글씨 + 노란 형광펜'(2026-11-28 수뽕 님 지시) — 초록/청록 글자색 금지
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
async function loadPage(seed, opt) {
  opt = opt || {};
  const errors = [];
  const vc = new VirtualConsole();
  const envOnly = m => /Not implemented: HTMLCanvasElement\.prototype\.getContext/.test(m);
  vc.on('jsdomError', e => { const m = String(e.message || e); if (!envOnly(m)) errors.push('jsdom: ' + m.slice(0, 200)); });
  vc.on('error', (...a) => errors.push('error: ' + a.map(String).join(' ').slice(0, 200)));
  const fidb = require('fake-indexeddb');
  const fake = makeFakeFirebase();
  const gemini = [];
  const dom = new JSDOM(html, {
    url: opt.url || 'https://jisu.test/POSCO-M/JISU/index.html',
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
      /* 실행 시각 의존 제거: 이 테스트는 '08시 자동 적용 전' 화면을 가정한다.
         그대로 두면 08:00(KST) 이후 실행에서 오늘 예약이 금일작업으로 옮겨져 집계가 달라진다. */
      w.JISU_SCHEDULE_APPLY_TIME = { hour: 23, minute: 59 };
      w.__jisuClosed = false; w.__jisuTimers = new Set();
      const _st = w.setTimeout.bind(w), _si = w.setInterval.bind(w);
      w.setTimeout = (fn, ms, ...a) => { const id = _st(() => { w.__jisuTimers.delete(id); if (!w.__jisuClosed) fn(...a); }, ms); w.__jisuTimers.add(id); return id; };
      w.setInterval = (fn, ms, ...a) => { const id = _si(() => { if (!w.__jisuClosed) fn(...a); }, ms); w.__jisuTimers.add(id); return id; };
      Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
    }
  });
  opened.push(dom.window);
  await sleep(opt.wait || 1700);
  return { w: dom.window, errors, gemini, fake };
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

/* ───────────────── 1-b. 메탈 베젤 제거 · 헤더 중복 제거 (2026-11-28 2차) ───────────────── */
test('두꺼운 20px 메탈 베젤이 없고, 유리·외곽선·그림자가 꼬리까지 같은 path 하나로 그려진다', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, doc = w.document, bubble = doc.getElementById('chiefBubble');
    /* 베젤을 만들던 금속 path 들은 흔적도 없어야 한다 */
    for (const id of ['cbBezelPath', 'cbBrushPath', 'cbGrainPath', 'cbSheenPath', 'cbShadePath',
      'cbRimGlow', 'cbSpecPath', 'cbTopSpec', 'cbEdgeDark', 'cbHiPath', 'cbInnerShadePath', 'cbInnerLipPath']) {
      assert.equal(doc.getElementById(id), null, '메탈 베젤 path 가 남아 있다: ' + id);
    }
    assert.equal(bubble.querySelectorAll('path[fill^="url(#cbMetal"]').length, 0, '금속 그라디언트가 남아 있다');
    /* 남은 것은 1px 유리 림 + 부드러운 그림자 둘뿐 */
    const rim = doc.getElementById('cbRimPath');
    assert.ok(rim, '유리 림 path 가 없다');
    assert.equal(rim.getAttribute('stroke-width'), '1', '림 두께는 1px');
    assert.equal(rim.getAttribute('stroke-opacity'), '.16', '림은 은은한 흰색 16%');
    assert.equal(bubble.querySelectorAll('path[stroke="#000000"]').length, 0, '안쪽 어두운 이음매(이중 테두리)가 남아 있다');

    /* 실제 높이를 넣고 그리게 하면 유리 clip-path 가 꼬리 포함 외곽 path 와 같아야 한다 */
    const box = doc.createElement('div');
    const gl = bubble.querySelector('.cb-glass'), sh = bubble.querySelector('.cb-glass-sheen');
    Object.defineProperty(bubble, 'offsetWidth', { value: 436, configurable: true });
    Object.defineProperty(bubble, 'offsetHeight', { value: 404, configurable: true });
    w.jisuChiefTest.buildPaths();
    const outerD = w.eval('window.jisuChiefTest.outerLeftTop(436, 404, 26)');
    const off = plain(w.eval('window.jisuChiefTest.glassOffset'));
    const clipD = w.eval(`window.jisuChiefTest.outerLeftTop(436, 404, 26, ${off.x}, ${off.y})`);
    assert.ok(/path\("M62,30/.test(gl.style.clipPath), '유리 clip 이 꼬리 path(상자 기준 이동)로 시작하지 않는다: ' + gl.style.clipPath.slice(0, 44));
    assert.equal(gl.style.clipPath, 'path("' + clipD + '")', '유리 clip-path 가 꼬리 path 와 다르다(꼬리가 잘린다)');
    assert.equal(sh.style.clipPath, gl.style.clipPath, '광택 레이어가 유리와 다른 모양으로 잘린다');
    assert.equal(doc.getElementById('cbRimPath').getAttribute('d'), outerD, '외곽선이 꼬리 path 로 그려지지 않는다');
    /* 유리 상자는 꼬리만큼 말풍선 밖까지 넓어야 꼬리 안쪽도 같은 유리로 칠해진다 */
    const cssAll = Array.from(doc.querySelectorAll('style')).map(s => s.textContent).join('\n');
    const glassRule = (cssAll.match(/#chiefBubble \.cb-glass\{[^}]*\}/) || [''])[0];
    const sheenRule = (cssAll.match(/#chiefBubble \.cb-glass-sheen\{[^}]*\}/) || [''])[0];
    assert.ok(new RegExp('left:-' + off.x + 'px').test(glassRule) && new RegExp('top:-' + off.y + 'px').test(glassRule),
      '유리 상자가 꼬리 영역을 덮지 않는다(꼬리가 비어 보인다): ' + glassRule);
    assert.ok(/pointer-events:\s*none/.test(glassRule), '넓어진 유리 상자가 사이드바 클릭을 가로챈다: ' + glassRule);
    assert.ok(new RegExp('left:-' + off.x + 'px').test(sheenRule) && new RegExp('top:-' + off.y + 'px').test(sheenRule),
      '광택 상자가 꼬리 영역을 덮지 않는다: ' + sheenRule);
    box.remove();

    /* 베젤이 차지하던 20px 여백 없이 내용이 말풍선 끝까지 찬다 */
    const css = Array.from(doc.querySelectorAll('style')).map(s => s.textContent).join('\n');
    assert.ok(/#chiefBubble \.cb-inner\{[^}]*padding:16px 18px 14px/.test(css), '내부 패딩이 베젤 기준(24px 26px)으로 남아 있다');
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

test('말풍선 헤더는 상태 알약 + ✕ 만 — 사이드바와 겹치는 캐릭터·이름을 되풀이하지 않는다', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, doc = w.document, bubble = doc.getElementById('chiefBubble');
    const head = bubble.querySelector('.cb-head');
    assert.ok(head, '헤더가 없다');
    assert.equal(head.querySelector('.cb-ava'), null, '헤더 아바타가 남아 있다');
    assert.equal(head.querySelector('img'), null, '헤더에 캐릭터 이미지가 남아 있다');
    assert.equal(head.querySelector('.cb-title'), null, '헤더 제목이 남아 있다');
    assert.ok(!/지수\s*비서실장/.test(head.textContent), '헤더가 이름을 되풀이한다: ' + head.textContent.trim());
    assert.ok(/대시보드 연동/.test(head.querySelector('.cb-badge').textContent), '상태 알약이 없다');
    assert.equal(head.querySelector('.cb-badge i').getAttribute('aria-hidden'), 'true');
    assert.ok(head.querySelector('#cbClose'), '닫기 버튼이 헤더에 없다');
    assert.equal(head.children.length, 2, '헤더에는 알약과 닫기 두 요소만 있어야 한다');
    assert.equal(bubble.getAttribute('aria-label'), '지수 비서실장', '말풍선 접근성 이름이 사라졌다');
    /* 헤더가 짧아진 만큼 대화 영역이 남은 높이를 모두 쓴다 */
    bubble.classList.add('is-open');
    const msgCss = Array.from(doc.querySelectorAll('style')).map(s => s.textContent).join('\n');
    assert.ok(/#chiefBubble \.cb-msgs\{[^}]*flex:1 1 auto/.test(msgCss), '대화 영역이 남은 높이를 채우지 않는다');
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

/* ───────────────── 2. 폭별 배치 계산 (1920·1366·900·412) ───────────────── */
test('폭별 배치: 데스크탑은 사이드바 오른쪽 위, 모바일은 캐릭터 바로 아래 · 꼬리가 아이콘을 가리킨다', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, g = (o) => plain(w.eval(`window.jisuChiefTest.geometry(${JSON.stringify(o)})`));
    /* 사이드바: clamp(288px, 20.5vw, 396px) + 16px 여백 */
    const sideW = vw => Math.min(396, Math.max(288, vw * 0.205));
    const cases = [
      { vw: 1920, vh: 1080, bubbleW: 436, bubbleH: 404, mode: 'leftTop', sideRight: 410, btnCenterX: 360 },
      { vw: 1366, vh: 768, bubbleW: 436, bubbleH: 404, mode: 'leftTop', sideRight: 304, btnCenterX: 254 },
      /* 모바일은 사이드바가 화면 폭 전체(좌우 14px 여백)이고 아이콘은 제목줄 오른쪽 끝 */
      { vw: 900, vh: 700, bubbleW: 388, bubbleH: 430, mode: 'top', sideRight: 886, btnCenterX: 839 },
      { vw: 412, vh: 915, bubbleW: 388, bubbleH: 430, mode: 'top', sideRight: 398, btnCenterX: 354 }
    ];
    for (const c of cases) {
      const sideRight = c.mode === 'leftTop' ? Math.round(16 + sideW(c.vw)) : c.sideRight;
      assert.equal(sideRight, c.sideRight, c.vw + 'px 사이드바 오른쪽 끝(현장 실측 기준)');
      const btnTop = 100, btnBottom = btnTop + 36;
      const r = g({ vw: c.vw, vh: c.vh, sideRight, btnTop, btnBottom, btnCenterX: c.btnCenterX, bubbleW: c.bubbleW, bubbleH: c.bubbleH });
      assert.equal(r.mode, c.mode, c.vw + 'px 모드');
      assert.equal(r.overflowRight, 0, c.vw + 'px 가로 넘침');
      assert.equal(r.overflowLeft, 0, c.vw + 'px 왼쪽 넘침');
      assert.ok(r.top >= 0 && r.top + c.bubbleH <= c.vh, c.vw + 'px 세로 넘침: ' + r.top);
      if (c.mode === 'leftTop') {
        assert.ok(r.left > sideRight, c.vw + 'px: 말풍선이 사이드바를 덮는다');
        /* 꼬리는 말풍선 '왼쪽 위 모서리'에서 시작해 아이콘 오른쪽 모서리(얼굴 높이)를 가리킨다 */
        assert.ok(r.tail.x < r.left && r.tail.x >= sideRight - 24, c.vw + 'px: 꼬리 끝이 아이콘 쪽이 아니다');
        assert.ok(r.tail.y >= r.top && r.tail.y <= r.top + 30, c.vw + 'px: 꼬리 끝이 모서리가 아니다');
        assert.equal(r.maxHeight, c.bubbleH, c.vw + 'px: 데스크탑은 높이를 줄이지 않는다');
      } else {
        /* 모바일: 꼬리(26) + 여백(2) 아래에서만 시작 — 절대 캐릭터를 덮지 않는다 */
        assert.ok(r.top >= btnBottom + 28, c.vw + 'px: 말풍선이 캐릭터를 덮는다');
        assert.ok(r.tail.y >= btnBottom, c.vw + 'px: 꼬리 끝이 캐릭터를 덮는다');
        /* 꼬리 끝은 고정값(W-39)이 아니라 '실제 캐릭터 아이콘 중심'을 가리킨다 */
        assert.ok(Math.abs(r.tail.x - c.btnCenterX) <= 1, c.vw + 'px: 꼬리 끝이 아이콘 중심과 어긋난다 (tail ' + r.tail.x + ' / 아이콘 ' + c.btnCenterX + ')');
        assert.ok(r.tail.x > r.left && r.tail.x < r.left + c.bubbleW, c.vw + 'px: 꼬리가 말풍선 밖으로 나갔다');
        assert.ok(r.tail.y < r.top);
        assert.ok(r.maxHeight >= 280, c.vw + 'px: 최소 높이');
      }
    }
    /* 실기기(주소창 포함 가용 높이 560px)에서도 위로 밀지 않고 높이만 줄인다 */
    const small = g({ vw: 412, vh: 560, sideRight: 400, btnTop: 90, btnBottom: 158, btnCenterX: 354, bubbleW: 388, bubbleH: 430 });
    assert.equal(small.mode, 'top');
    assert.ok(small.top >= 158 + 28, '작은 화면에서 캐릭터를 덮었다: ' + small.top);
    assert.equal(small.maxHeight, 560 - small.top - 12, '남은 높이만큼만 줄인다');
    assert.ok(small.top + Math.min(430, small.maxHeight) <= 560 - 12, '작은 화면 세로 넘침');
  } finally { softClose(p.w); }
});

test('데스크탑 꼬리 path는 왼쪽 위 모서리에서 시작해 뾰족한 끝 → 위쪽 라인으로 이어진다', async () => {
  const p = await loadPage({});
  try {
    const d = p.w.eval('window.jisuChiefTest.outerLeftTop(436, 404, 26)');
    const tail = plain(p.w.eval('window.jisuChiefTest.leftTail'));
    assert.ok(d.startsWith('M22,0'), '위쪽 라인이 꼬리 끝단(topX)에서 시작하지 않는다: ' + d.slice(0, 20));
    assert.ok(d.indexOf('L0,44') > 0, '왼쪽 변에서 꼬리가 시작하지 않는다: ' + d);
    assert.ok(d.indexOf(tail.tipX + ',' + tail.tipY) > 0, '뾰족한 끝 좌표가 없다');
    assert.ok(d.trim().endsWith('22,0 Z'), '꼬리 위쪽 면이 상단 라인으로 닫히지 않는다');
    assert.ok(d.indexOf('0,94') < 0, '옛 왼쪽 변 가운데 꼬리가 남아 있다');
    assert.equal(tail.tipX, -34);
    assert.ok(tail.tipY >= -2 && tail.tipY <= 24, '끝점 높이가 캐릭터 얼굴 언저리여야 한다');
    /* 모바일 위쪽 꼬리는 그대로: 상단 오른쪽에서 아이콘 쪽으로 */
    const dm = p.w.eval('window.jisuChiefTest.outerTop(388, 430, 26)');
    assert.ok(dm.indexOf('349,-26') > 0, '모바일 꼬리 끝 좌표가 바뀌었다: ' + dm.slice(0, 120));
    assert.ok(dm.trim().endsWith(',0 Z'), '모바일 path가 닫히지 않는다');
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

/* ───────────────── 2-b. 넓은 모바일(가로모드·태블릿) 꼬리 정렬 (2026-11-28 3차) ───────────────── */
test('넓은 모바일 600~890px: 말풍선이 캐릭터 쪽으로 붙고 꼬리 끝이 아이콘 중심을 1px 오차로 가리킨다', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, g = (o) => plain(w.eval(`window.jisuChiefTest.geometry(${JSON.stringify(o)})`));
    /* 현장 실측(격리 Chromium): 모바일은 사이드바가 화면 폭 전체(좌우 14px), 아이콘 66px 는 오른쪽 끝 -15px */
    const widths = [360, 412, 600, 768, 820, 890];
    for (const vw of widths) {
      const W = Math.min(396, vw - 24);
      const sideRight = vw - 14;
      const btnRight = sideRight - 15;
      const btnCenterX = btnRight - 33;
      const btnTop = 86, btnBottom = btnTop + 74;
      const r = g({ vw, vh: 915, sideRight, btnTop, btnBottom, btnRight, btnCenterX, bubbleW: W, bubbleH: 430 });
      assert.equal(r.mode, 'top', vw + 'px 모드');
      assert.equal(r.overflowRight, 0, vw + 'px 오른쪽 넘침');
      assert.equal(r.overflowLeft, 0, vw + 'px 왼쪽 넘침');
      assert.ok(r.left >= 12, vw + 'px: 왼쪽 여백이 12px 미만');
      assert.ok(r.left + W <= vw - 12, vw + 'px: 오른쪽 여백이 12px 미만');
      /* 핵심: 꼬리 끝이 실제 캐릭터 아이콘 중심 아래 (1px 오차) */
      assert.ok(Math.abs(r.tail.x - btnCenterX) <= 1,
        vw + 'px: 꼬리 끝 ' + r.tail.x + ' 이 아이콘 중심 ' + btnCenterX + ' 과 어긋난다');
      assert.ok(r.tail.x >= btnCenterX - 33 && r.tail.x <= btnCenterX + 33, vw + 'px: 꼬리가 아이콘 폭을 벗어났다');
      assert.equal(r.tail.y, r.top - 26, vw + 'px 꼬리 높이');
      assert.ok(r.top >= btnBottom + 28, vw + 'px: 말풍선이 캐릭터를 덮는다');
      /* 600px 이상에서는 예전처럼 화면 가운데가 아니라 오른쪽(캐릭터 쪽)으로 붙는다 */
      if (vw >= 600) assert.ok(r.left > Math.round((vw - W) / 2), vw + 'px: 예전처럼 화면 가운데에 있다(꼬리가 400px 떨어짐)');
    }
    /* 태블릿 가로모드 820×500: 위로 밀지 않고 높이만 줄이며, 꼬리는 그대로 아이콘 아래 */
    const land = g({ vw: 820, vh: 500, sideRight: 806, btnTop: 86, btnBottom: 160, btnRight: 791, btnCenterX: 758, bubbleW: 396, bubbleH: 430 });
    assert.equal(land.top, 188);
    assert.equal(land.maxHeight, 500 - 188 - 12, '남은 높이만큼만 줄인다');
    assert.ok(land.top + Math.min(430, land.maxHeight) <= 500 - 12, '820×500 세로 넘침');
    assert.equal(land.tail.x, 758, '820×500 꼬리 끝이 캐릭터 중심이 아니다');
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

test('모바일 꼬리 path 는 place() 가 잡은 자리 그대로 그린다 — 넓은 가로모드에서도', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, doc = w.document, bubble = doc.getElementById('chiefBubble'), btn = doc.getElementById('jisuChiefBtn');
    const side = doc.getElementById('cmdSide');
    /* 현장 실측값(820×500 가로모드)으로 레이아웃을 흥내낸다 */
    const rect = (o) => () => ({ x: o.x, y: o.y, left: o.x, top: o.y, right: o.x + o.w, bottom: o.y + o.h, width: o.w, height: o.h });
    Object.defineProperty(w, 'innerWidth', { value: 820, configurable: true });
    btn.getBoundingClientRect = rect({ x: 725, y: 86, w: 66, h: 74 });
    if (side) side.getBoundingClientRect = rect({ x: 14, y: 73, w: 792, h: 1200 });
    Object.defineProperty(bubble, 'offsetWidth', { value: 396, configurable: true });
    Object.defineProperty(bubble, 'offsetHeight', { value: 430, configurable: true });

    const g = plain(w.jisuChiefTest.place());
    assert.equal(bubble.style.left, g.left + 'px');
    assert.ok(Math.abs(g.tail.x - 758) <= 1, '배치 꼬리가 캐릭터 중심이 아니다: ' + g.tail.x);
    w.jisuChiefTest.buildPaths();

    const d = doc.getElementById('cbRimPath').getAttribute('d');
    const mx = parseFloat((d.match(/(-?[\d.]+),-26/) || [0, 'NaN'])[1]);
    assert.equal(mx, g.tail.x - g.left, '꼬리 path 가 배치와 다른 자리에 그려졌다');
    assert.ok(/^M26,0L/.test(d), '모바일 path 머리가 바뀌었다: ' + d.slice(0, 20));
    /* 같은 자리에서 위쪽 라인 복귀(x2)와 오른쪽 모서리 둥글기가 깨지지 않았다 */
    assert.ok(d.indexOf((mx + 5) + ',0') > 0, '꼬리 오른쪽 복귀점이 없다: ' + d.slice(0, 160));
    assert.ok(/A26,26 0 0 1 396,26/.test(d), '오른쪽 둥근 모서리가 꼬리에 먹혔다: ' + d);
    /* 종이 유리 레이어도 꼬리만큼(40·30px) 옮긴 같은 모양으로 잘린다 */
    const off = plain(w.jisuChiefTest.glassOffset);
    assert.equal(doc.querySelector('#chiefBubble .cb-glass').style.clipPath,
      'path("' + w.eval(`window.jisuChiefTest.outerTop(396, 430, 26, ${off.x}, ${off.y}, ${g.tail.x - g.left})`) + '")');
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

/* ───────────────── 2-c. 따뜻한 종이 질감 (2026-11-28 승인 "이걸로 배포해주고") ───────────────── */
test('말풍선은 종이 질감: 따뜻한 크림 바탕·섬유 노이즈·1px 웜 림, 검정 그림자 path 는 꺼진다', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, doc = w.document;
    const paper = doc.getElementById('jisuChiefPaperCss');
    assert.ok(paper, '종이 질감 스타일(#jisuChiefPaperCss)이 없다');
    /* 앞선 유리 규칙 뒤에 있어야 같은 선택자를 덮어쓴다 */
    const all = Array.from(doc.querySelectorAll('style'));
    assert.ok(all.indexOf(doc.getElementById('jisu-chief-style')) < all.indexOf(paper), '종이 스타일이 유리 규칙보다 앞에 있다');
    const css = paper.textContent;
    assert.ok(/#chiefBubble\{[^}]*filter:drop-shadow/.test(css), '종이 실루엣 그림자(drop-shadow)가 없다');
    assert.ok(/#chiefBubble \.cb-glass\{[^}]*linear-gradient\(158deg, #F6F2EA 0%, #F1EADD 46%, #EBE4D6 100%\)/.test(css), '따뜻한 크림 그러데이션이 없다');
    assert.ok(/feTurbulence type='fractalNoise'/.test(css), '종이 섬유 노이즈가 없다');
    assert.ok(/#chiefBubble \.cb-glass\{[^}]*backdrop-filter:none/.test(css), '밝은 종이 위에 유리 블러가 남았다');
    assert.ok(/#chiefBubble #cbShadowWide, #chiefBubble #cbShadowTight\{display:none;?\}/.test(css), '검정 그림자 path 를 끄지 않았다(종이가 검게 죽는다)');
    assert.ok(/#chiefBubble #cbRimPath\{stroke:rgba\(120,108,92,\.38\)/.test(css), '1px 웜 림이 없다');
    assert.ok(/--cb-lime:#D7FE01/.test(css) && /#chiefBubble \.cb-send\{[^}]*linear-gradient\(180deg,#E2FF52 0%, var\(--cb-lime\) 100%\)/.test(css), '전송 버튼이 라임(#D7FE01)이 아니다');
    assert.ok(/#chiefBubble\.cb-msg|#chiefBubble \.cb-msg\.ai \.cb-bub\{[^}]*color:#1E242B/.test(css), '본문 먹색이 아니다');
    /* 모바일에서도 어두운 유리 덮어쓰기 없이 같은 종이 (같은 미디어쿼리에서 배경을 다시 지정) */
    const mobile = css.slice(css.indexOf('@media (max-width:900px)'));
    assert.ok(/linear-gradient\(158deg, #F6F2EA 0%, #F1EADD 46%, #EBE4D6 100%\)/.test(mobile), '모바일에서 종이 바탕이 다시 지정되지 않는다');
    assert.ok(/feTurbulence/.test(mobile), '모바일에서 섬유 노이즈가 빠졌다');

    /* 실제 렌더(computed) — 밝은 종이 위 먹색 글씨, 라임 전송 버튼, 숨긴 그림자 path */
    const cs = (el) => w.getComputedStyle(el);
    const glass = doc.querySelector('#chiefBubble .cb-glass');
    assert.equal(cs(glass).backgroundColor, 'rgb(244, 235, 223)', '유리 레이어 바탕색이 크림(#F4EBDF — 11-28 3차 크림 레이어가 종이를 덮는다)이 아니다(예전 검정 유리가 이겼다)');
    assert.equal(cs(doc.getElementById('chiefBubble')).color, 'var(--cb-ink)', '말풍선 글씨가 먹색 토큰(--cb-ink)을 쓰지 않는다');
    assert.equal(cs(doc.getElementById('cbShadowWide')).display, 'none', '검정 넓은 그림자가 살아 있다');
    assert.equal(cs(doc.getElementById('cbShadowTight')).display, 'none', '검정 좁은 그림자가 살아 있다');
    assert.equal(cs(doc.getElementById('chiefBubble')).filter.indexOf('drop-shadow'), 0, '말풍선 그림자 필터가 없다: ' + cs(doc.getElementById('chiefBubble')).filter);
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

/* ───────────────── 2-d. 크림 그라데이션 (2026-11-28 승인 시안 그대로 정식 반영) ───────────────── */
test('말풍선은 승인된 크림 그라데이션: 크림→라떼 4색·순백 카드·먹색 #231B15·라임 #D7FE01 전송, 모바일도 같은 크림', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, doc = w.document;
    const cream = doc.getElementById('jisuChiefCreamCss');
    assert.ok(cream, '크림 그라데이션 스타일(#jisuChiefCreamCss)이 없다');
    const all = Array.from(doc.querySelectorAll('style'));
    assert.ok(all.indexOf(doc.getElementById('jisuChiefPaperCss')) < all.indexOf(cream), '크림 스타일이 종이 규칙보다 앞에 있어 덮어쓰지 못한다');
    const css = cream.textContent;
    /* 승인된 그라데이션: 상단 크림 #FDFBF7 → #FAF5ED → #F3E6D6 → 코너 라떼 #E5D1BB (꼬리까지 한 장) */
    assert.ok(/#chiefBubble \.cb-glass\{[^}]*linear-gradient\(158deg, #FDFBF7 0%, #FAF5ED 40%, #F3E6D6 72%, #E5D1BB 100%\)/.test(css),
      '승인된 크림→라떼 그라데이션이 없다');
    for (const tone of ['#FDFBF7', '#FAF5ED', '#F3E6D6', '#E5D1BB']) assert.ok(css.indexOf(tone) >= 0, '승인된 크림 색이 빠졌다: ' + tone);
    assert.ok(/radial-gradient\(54% 32% at 50% 108%/.test(css), '하단 코너를 감싸는 베이지 radial 이 없다');
    assert.ok(/feTurbulence type='fractalNoise'/.test(css), '아주 옅은 종이 노이즈가 없다');
    assert.ok(/#chiefBubble \.cb-glass\{[^}]*backdrop-filter:none/.test(css), '밝은 크림 위에 유리 블러가 남았다');
    /* 내부 요소는 순백 카드, 글씨는 먹색, 전송은 라임 */
    assert.ok(/--cb-ink:#231B15/.test(css), '본문 먹색이 #231B15 가 아니다');
    assert.ok(/#chiefBubble \.cb-chip\{[^}]*background:rgba\(255,255,255,\.92\)/.test(css), '빠른 질문 칩이 순백 카드가 아니다');
    assert.ok(/#chiefBubble \.cb-msg\.ai \.cb-bub\{[^}]*background:rgba\(255,255,255,\.96\)/.test(css), 'AI 말풍선이 순백 카드가 아니다');
    assert.ok(/#chiefBubble \.cb-in-in\{[^}]*background:#FFFFFF/.test(css), '대화 입력창이 순백이 아니다');
    assert.ok(/--cb-lime:#D7FE01/.test(css) && /#chiefBubble \.cb-send\{[^}]*linear-gradient\(180deg,#E2FF52 0%, var\(--cb-lime\) 100%\)/.test(css), '전송 버튼이 라임(#D7FE01)이 아니다');
    assert.ok(/#chiefBubble #cbRimPath\{stroke:rgba\(150,120,92,\.32\)/.test(css), '1px 웜 림이 없다');
    /* 모바일도 같은 크림(어두운 유리 덮어쓰기 금지) */
    const mobile = css.slice(css.indexOf('@media (max-width:900px)'));
    assert.ok(/linear-gradient\(158deg, #FDFBF7 0%, #FAF5ED 40%, #F3E6D6 72%, #E5D1BB 100%\)/.test(mobile), '모바일에서 크림 바탕이 다시 지정되지 않는다');
    assert.ok(/feTurbulence/.test(mobile), '모바일에서 종이 노이즈가 빠졌다');
    /* 실제 렌더(computed) */
    const glass = doc.querySelector('#chiefBubble .cb-glass');
    assert.equal(w.getComputedStyle(glass).backgroundColor, 'rgb(244, 235, 223)', '유리 바탕색이 크림(#F4EBDF)이 아니다');
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

/* ─────────────── 2-e. 상단 검색창 오른쪽 끝 = 비서실장 말풍선 오른쪽 끝 (2026-11-28 3차 지시) ─────────────── */
test('데스크탑 어떤 폭에서도 상단 검색창 오른쪽 끝 = 말풍선 오른쪽 끝 (1920·1600·1366·1280, 시계 침범 없음)', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, T = w.jisuChiefTest;
    /* 격리 Chromium 실측값(2026-11-28): 사이드바 오른쪽·검색창 왼쪽·시계 왼쪽·말풍선 폭 */
    const cases = [
      { vw: 1920, vh: 1080, sideRight: 409.59, boxLeft: 400.86, clockLeft: 1518.52, bubbleW: 541.25 },
      { vw: 1600, vh: 900, sideRight: 344, boxLeft: 400.86, clockLeft: 1198.52, bubbleW: 480.453 },
      { vw: 1366, vh: 768, sideRight: 304, boxLeft: 394.8, clockLeft: 964.52, bubbleW: 436 },
      { vw: 1280, vh: 800, sideRight: 304, boxLeft: 387.05, clockLeft: 878.52, bubbleW: 436 }
    ];
    for (const c of cases) {
      /* 화면 폭 → 말풍선 폭 식이 CSS clamp 와 같아야 한다(여기가 틀리면 끝선도 틀어진다) */
      assert.ok(Math.abs(T.bubbleWidthFor(c.vw) - c.bubbleW) < 0.6,
        c.vw + 'px 폭 식이 CSS 와 다르다: ' + T.bubbleWidthFor(c.vw) + ' vs ' + c.bubbleW);
      /* 말풍선 자리는 geometry() 가 정한다 — 그 오른쪽 끝에 검색창을 맞춘다 */
      const g = T.geometry({ vw: c.vw, vh: c.vh, sideRight: c.sideRight, btnTop: 80, btnBottom: 116, bubbleW: c.bubbleW, bubbleH: 404 });
      const bubbleRight = g.left + c.bubbleW;
      const fit = T.searchWidthFor({ vw: c.vw, boxLeft: c.boxLeft, bubbleRight, clockLeft: c.clockLeft });
      assert.ok(fit, c.vw + 'px 폭 계산이 비었다');
      assert.ok(Math.abs((c.boxLeft + fit.width) - bubbleRight) < 0.02,
        c.vw + 'px 검색창 오른쪽 ' + (c.boxLeft + fit.width).toFixed(2) + ' ≠ 말풍선 ' + bubbleRight.toFixed(2));
      assert.ok(fit.aligned, c.vw + 'px 시계 때문에 끝선이 잘렸다');
      assert.ok(c.clockLeft - (c.boxLeft + fit.width) >= 8, c.vw + 'px 시계·로그인 칩을 침범한다');
    }
    /* 기준점(승인 브리프): 1920 에서 말풍선 541px·right 971px, 검색창 left 401 → 폭 570px */
    const g19 = T.geometry({ vw: 1920, vh: 1080, sideRight: 409.59, btnTop: 80, btnBottom: 116, bubbleW: 541.25, bubbleH: 404 });
    assert.equal(Math.round(g19.left), 430);
    assert.equal(Math.round(g19.left + 541.25), 971);
    const fit19 = T.searchWidthFor({ vw: 1920, boxLeft: 400.86, bubbleRight: g19.left + 541.25, clockLeft: 1518.52 });
    assert.ok(Math.abs(fit19.width - 570.39) < 0.05, '1920 검색창 폭이 570px 대가 아니다: ' + fit19.width);

    /* 실제 DOM 배선 — 가짜 rect 를 물리고 syncSearchWidth() 를 부르면 그 폭이 !important 로 들어간다 */
    const box = w.document.getElementById('hdrSearchBox');
    const side = w.document.getElementById('cmdSide');
    const clock = w.document.getElementById('liveClock');
    const rect = (o) => () => ({ x: o.x, y: 0, left: o.x, top: 0, right: o.x + o.w, bottom: 40, width: o.w, height: 40 });
    Object.defineProperty(w, 'innerWidth', { value: 1920, configurable: true });
    side.getBoundingClientRect = rect({ x: 16, w: 393.59 });
    clock.getBoundingClientRect = rect({ x: 1518.52, w: 120 });
    box.getBoundingClientRect = rect({ x: 400.86, w: 430 });
    const r = T.syncSearchWidth({ bubbleWidth: 541.25 });
    assert.ok(r, '검색창 폭 동기화가 아무것도 하지 않았다');
    assert.ok(Math.abs(r.width - 570.39) < 0.05, '동기화 폭이 ' + r.width + ' (570.39 기대)');
    assert.equal(box.style.getPropertyValue('width'), r.width + 'px');
    assert.equal(box.style.getPropertyPriority('width'), 'important', '기존 430px !important 규칙을 이기지 못한다');
    assert.equal(box.getAttribute('data-cb-edge'), '971', '검색창에 맞춘 끝선 좌표가 남지 않는다');

    /* 모바일(<=900px)에서는 검색창 폭을 건드리지 않고, 데스크탑 1366 으로 돌아오면 다시 좁힌다 */
    assert.equal(T.syncSearchWidth({ vw: 412, boxLeft: 20, bubbleWidth: 388, sideRight: 398, clockLeft: 260 }), null);
    assert.ok(!box.style.getPropertyValue('width'), '모바일에서 데스크탑 검색창 폭이 남아 있다');
    Object.defineProperty(w, 'innerWidth', { value: 1366, configurable: true });
    side.getBoundingClientRect = rect({ x: 16, w: 288 });
    clock.getBoundingClientRect = rect({ x: 964.52, w: 120 });
    box.getBoundingClientRect = rect({ x: 394.8, w: 365.2 });
    const r2 = T.syncSearchWidth({ bubbleWidth: 436 });
    assert.ok(r2 && Math.abs((394.8 + r2.width) - (324 + 436)) < 0.02,
      '1366 에서 검색창 오른쪽이 말풍선(760)과 어긋난다: ' + (r2 && (394.8 + r2.width)));
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

test('창 폭을 새로고침 없이 바꾸면 검색창 폭도 그 폭의 말풍선 끝선으로 다시 맞춘다', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, doc = w.document;
    const box = doc.getElementById('hdrSearchBox');
    const side = doc.getElementById('cmdSide');
    const clock = doc.getElementById('liveClock');
    const rect = (o) => () => ({ x: o.x, y: 0, left: o.x, top: 0, right: o.x + o.w, bottom: 40, width: o.w, height: 40 });
    const apply = (vw, sideW, boxLeft, clockLeft) => {
      Object.defineProperty(w, 'innerWidth', { value: vw, configurable: true });
      side.getBoundingClientRect = rect({ x: 16, w: sideW });
      clock.getBoundingClientRect = rect({ x: clockLeft, w: 120 });
      box.getBoundingClientRect = rect({ x: boxLeft, w: 430 });
      w.dispatchEvent(new w.Event('resize'));
    };
    apply(1920, 393.59, 400.86, 1518.52);
    await sleep(520);
    const w1920 = parseFloat(box.style.getPropertyValue('width'));
    assert.ok(Math.abs(w1920 - 570.4) < 0.2, '1920 검색창 폭이 다시 맞춰지지 않았다: ' + box.style.getPropertyValue('width'));
    apply(1600, 328, 400.86, 1198.52);
    await sleep(520);
    const w1600 = parseFloat(box.style.getPropertyValue('width'));
    assert.ok(Math.abs(w1600 - 443.6) < 0.2, '1600 검색창 폭이 다시 맞춰지지 않았다: ' + box.style.getPropertyValue('width'));
    apply(1366, 288, 394.8, 964.52);
    await sleep(520);
    const w1366 = parseFloat(box.style.getPropertyValue('width'));
    assert.ok(Math.abs(w1366 - 365.2) < 0.2, '1366 검색창 폭이 다시 맞춰지지 않았다: ' + box.style.getPropertyValue('width'));
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
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

/* ───────────────── 6. 07:40·17:40 자동 브리핑 (2026-11-28 수뽕 님 지시) ───────────────── */
const BRIEF = 'jisu-chief-briefing-v1';
const BRIEF_SEEN = 'jisu-chief-briefing-seen';
const BRIEF_AM = '2026-11-29-0740';
const BRIEF_PM = '2026-11-29-1740';
const briefJson = (o) => JSON.stringify(Object.assign({
  id: BRIEF_AM, slot: 'am', title: '🌅 07:40 아침 브리핑 · 주간',
  text: '세종2공장 주간 날씨(08:00~18:00) · 기온 **1~10℃** · 강수확률 **70%**\n금일작업 **6건** — 남음 **5** · 긴급 **1**',
  createdAt: Date.now(), expiresAt: Date.now() + 6 * 3600 * 1000
}, o || {}));
const briefMsg = (doc, id) => doc.querySelector('[data-cb-briefing="' + id + '"]');

test('브리핑이 들어오면 관리자 말풍선이 스스로 열리고, 강조는 검정 글씨 + 노란 형광펜이다', async () => {
  const p = await loadPage({ [BRIEF]: briefJson() });
  try {
    const w = p.w, doc = w.document, bubble = doc.getElementById('chiefBubble');
    assert.ok(bubble.classList.contains('is-open'), '브리핑이 있는데 말풍선이 열리지 않았다');
    assert.equal(bubble.getAttribute('aria-hidden'), 'false');
    assert.equal(doc.getElementById('jisuChiefBtn').getAttribute('aria-expanded'), 'true');
    const el = briefMsg(doc, BRIEF_AM);
    assert.ok(el, '브리핑 메시지가 대화창에 없다');
    assert.ok(/아침 브리핑/.test(el.textContent), el.textContent);
    assert.ok(/1~10℃/.test(el.textContent) && /70%/.test(el.textContent), '브리핑 본문이 빠졌다: ' + el.textContent);
    assert.equal(doc.querySelectorAll('[data-cb-briefing]').length, 1, '같은 브리핑이 두 번 들어갔다');
    /* 강조: 초록/청록이 아니라 진한 검정 + 노란 형광펜 */
    const strong = el.querySelector('.cb-bub b');
    assert.ok(strong, '강조(b)가 없다');
    const cs = w.getComputedStyle(strong);
    assert.equal(cs.color, 'rgb(17, 24, 39)', '강조 글씨가 진한 검정이 아니다: ' + cs.color);
    assert.ok(/linear-gradient/.test(cs.backgroundImage), '형광펜 배경이 없다: ' + cs.backgroundImage);
    assert.ok(/250,\s*204,\s*21|253,\s*224,\s*71/.test(cs.backgroundImage), '노란색 형광펜이 아니다: ' + cs.backgroundImage);
    /* 확인 전에는 seen 을 쓰지 않는다 */
    assert.equal(w.localStorage.getItem(BRIEF_SEEN), null);
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

test('브리핑을 ✕로 닫으면 같은 회차는 새로고침해도 다시 열지 않는다 (중복 방지)', async () => {
  const p = await loadPage({ [BRIEF]: briefJson() });
  try {
    const w = p.w, doc = w.document, bubble = doc.getElementById('chiefBubble');
    assert.ok(bubble.classList.contains('is-open'));
    doc.getElementById('cbClose').click();
    assert.ok(!bubble.classList.contains('is-open'), '✕로 닫히지 않았다');
    assert.equal(w.localStorage.getItem(BRIEF_SEEN), BRIEF_AM, '✕로 닫았는데 확인 기록이 없다');
    assert.equal(w.jisuChief.checkBriefing(), false, '확인한 브리핑이 다시 열렸다');
    assert.ok(!bubble.classList.contains('is-open'));
  } finally { softClose(p.w); }
  const q = await loadPage({ [BRIEF]: briefJson(), [BRIEF_SEEN]: BRIEF_AM }, { wait: 1500 });
  try {
    const doc = q.w.document;
    assert.ok(!doc.getElementById('chiefBubble').classList.contains('is-open'), '확인한 브리핑이 새로고침 뒤 다시 열렸다');
    assert.equal(doc.querySelectorAll('[data-cb-briefing]').length, 0);
  } finally { softClose(q.w); }
});

test('만료된 브리핑(expiresAt 지남)은 열지 않고, 새 회차(id)는 다시 연다', async () => {
  const p = await loadPage({ [BRIEF]: briefJson({ expiresAt: Date.now() - 60000 }) }, { wait: 1500 });
  try {
    const w = p.w, doc = w.document, bubble = doc.getElementById('chiefBubble');
    assert.equal(w.jisuChief.currentBriefing(), null, '만료된 브리핑이 유효로 남아 있다');
    assert.ok(!bubble.classList.contains('is-open'), '만료된 브리핑으로 말풍선이 열렸다');
    /* 같은 id 라도 새 회차가 오면 seen 과 무관하게 열린다 */
    w.localStorage.setItem(BRIEF_SEEN, BRIEF_AM);
    w.localStorage.setItem(BRIEF, briefJson({
      id: BRIEF_PM, slot: 'pm', title: '🌆 17:40 저녁 브리핑 · 야간',
      text: '야간 날씨(18:00~익일 08:00) · 기온 **3~8℃**\n달력 예약(내일) **1건**'
    }));
    assert.equal(w.jisuChief.checkBriefing(), true, '새 회차 브리핑이 열리지 않았다');
    const el = briefMsg(doc, BRIEF_PM);
    assert.ok(el && /야간/.test(el.textContent), '저녁 브리핑이 표시되지 않았다');
  } finally { softClose(p.w); }
});

test('작업자 ?zone= 화면과 ?kiosk=1 키오스크에서는 브리핑 말풍선을 열지 않는다', async () => {
  const cases = [
    { url: 'https://jisu.test/POSCO-M/JISU/index.html?zone=outbound', why: '?zone= 작업자 화면' },
    { url: 'https://jisu.test/POSCO-M/JISU/index.html?kiosk=1', why: '?kiosk=1 키오스크' }
  ];
  for (const c of cases) {
    const p = await loadPage({ [BRIEF]: briefJson() }, { url: c.url, wait: 1500 });
    try {
      const w = p.w, doc = w.document;
      assert.equal(w.jisuChief.isAdminScreen(), false, c.why + ' 인데 관리자 화면으로 판정했다');
      assert.ok(!doc.getElementById('chiefBubble').classList.contains('is-open'), c.why + ' 에서 말풍선이 열렸다');
      assert.equal(doc.querySelectorAll('[data-cb-briefing]').length, 0, c.why + ' 에서 브리핑이 표시됐다');
      assert.equal(w.localStorage.getItem(BRIEF_SEEN), null, c.why + ' 에서 확인 기록을 썼다');
    } finally { softClose(p.w); }
  }
});

/* 이 시간대(18시 이후)에는 페이지가 입고·보고서 확인창을 스스로 띄운다 — 브리핑보다 그 창이 우선이므로
   테스트에서는 확인창을 닫아 가며 브리핑이 열리는지 본다. */
const closeDl = (doc) => {
  const d = doc.getElementById('dlConfirmModal');
  if (d && d.classList.contains('is-open')) { const c = doc.getElementById('dlConfirmCancel'); if (c) c.click(); }
};

test('페이지를 연 뒤 Firebase 실시간으로 도착한 브리핑도 열린다 (중복 없음)', async () => {
  const p = await loadPage({}, { wait: 1300 });
  try {
    const w = p.w, doc = w.document, bubble = doc.getElementById('chiefBubble');
    assert.ok(!bubble.classList.contains('is-open'), '브리핑이 없는데 말풍선이 열려 있다');
    /* DB 구독(readyKey)이 붙을 때까지 잠깐 기다린다 — 큰 페이지라 1.3초에 아직일 수 있다 */
    for (let i = 0; i < 50 && !p.fake.state.listeners.some(l => l.path === 'jisu/state/' + BRIEF); i++) await sleep(100);
    assert.ok(p.fake.state.listeners.some(l => l.path === 'jisu/state/' + BRIEF), '브리핑 키 구독이 시작되지 않았다');
    /* 18시 이후 로드에서는 보고서 다운로드 확인창이 자동으로 떠 있다 → 먼저 닫는다(아래 겹짐 테스트가 따로 있다) */
    closeDl(doc);
    /* fakefb.setServer 는 값만 저장하고 리스너를 부르지 않는다 → 실제 수신처럼 콜백을 직접 부른다 */
    const node = {
      v: briefJson({ id: BRIEF_PM, slot: 'pm', title: '🌆 17:40 저녁 브리핑 · 야간', text: '야간 날씨 · 기온 **3~8℃**' }),
      t: Date.now(), by: 'pickle-chief-pm'
    };
    p.fake.setServer('jisu/state/' + BRIEF, node);
    p.fake.state.listeners
      .filter(l => l.path === 'jisu/state/' + BRIEF)
      .forEach(l => l.cb({ key: BRIEF, val: () => JSON.parse(JSON.stringify(node)), exists: () => true }));
    for (let i = 0; i < 75 && !bubble.classList.contains('is-open'); i++) { closeDl(doc); await sleep(100); }
    assert.ok(bubble.classList.contains('is-open'), '실시간으로 온 브리핑에 말풍선이 열리지 않았다');
    const el = briefMsg(doc, BRIEF_PM);
    assert.ok(el && /야간/.test(el.textContent), '저녁 브리핑이 표시되지 않았다');
    assert.equal(doc.querySelectorAll('[data-cb-briefing]').length, 1);
    w.jisuChief.checkBriefing();
    w.jisuChief.checkBriefing();
    assert.equal(doc.querySelectorAll('[data-cb-briefing]').length, 1, '같은 브리핑이 중복 추가됐다');
    /* 사람이 말을 걸면(=읽었다) 확인으로 기록 */
    await w.jisuChief.ask('오늘 남은 작업 요약');
    await sleep(80);
    assert.equal(w.localStorage.getItem(BRIEF_SEEN), BRIEF_PM, '브리핑을 읽고 질문했는데 확인 기록이 없다');
  } finally { softClose(p.w); }
});

test('말풍선 강조 스타일: 크림 규칙 뒤에서 초록/청록 글자색을 검정+형광펜으로 덮는다', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, doc = w.document;
    const hl = doc.getElementById('jisuChiefHighlightCss');
    assert.ok(hl, '강조 스타일(#jisuChiefHighlightCss)이 없다');
    const all = Array.from(doc.querySelectorAll('style'));
    assert.ok(all.indexOf(doc.getElementById('jisuChiefCreamCss')) < all.indexOf(hl), '크림 규칙보다 앞에 있어 덮어쓰지 못한다');
    const css = hl.textContent;
    assert.ok(/color:#111827 !important/.test(css), '검정 글씨 규칙이 없다');
    assert.ok(/background-image:linear-gradient\(180deg, transparent 26%, rgba\(250,204,21,\.72\) 26%/.test(css), '노란 형광펜 그라데이션이 없다');
    assert.ok(/box-decoration-break:clone/.test(css), '줄바꿈된 강조가 줄마다 이어지지 않는다');
    /* 실제 렌더 — 인사말의 <b> 가 검정 + 형광펜 */
    doc.getElementById('jisuChiefBtn').click();
    const b = doc.querySelector('#cbMsgs .cb-msg.ai .cb-bub b');
    assert.ok(b, '인사말에 강조가 없다');
    const cs = w.getComputedStyle(b);
    assert.equal(cs.color, 'rgb(17, 24, 39)', '인사말 강조가 검정이 아니다: ' + cs.color);
    assert.ok(/linear-gradient/.test(cs.backgroundImage), '인사말 강조에 형광펜이 없다: ' + cs.backgroundImage);
    const whoBg = w.getComputedStyle(doc.querySelector('#cbMsgs .cb-msg.ai .cb-who b')).backgroundImage;
    assert.ok(!whoBg || whoBg === 'none', '이름표까지 형광펜이 칠해졌다: ' + whoBg);
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});

test('생성 스크립트가 <b>·<br> 로 표시한 핵심도 같은 형광펜으로 그려진다 (다른 HTML 은 글자로)', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, doc = w.document;
    doc.getElementById('jisuChiefBtn').click();
    w.jisuChief.showBriefing({ id: 'test-b1', slot: 'am', title: '테스트 브리핑', text: '<b>긴급 2건</b> 먼저<br><script>alert(1)</script> 확인' });
    const el = briefMsg(doc, 'test-b1');
    assert.ok(el, '브리핑이 추가되지 않았다');
    const bolds = el.querySelectorAll('b');
    assert.ok(bolds.length >= 2, '<b> 마크업이 글자로 새어 나왔다: ' + el.innerHTML);
    assert.ok(/긴급 2건/.test(bolds[bolds.length - 1].textContent), el.innerHTML);
    assert.ok(el.querySelector('br'), '<br> 줄바꿈이 살아나지 않았다');
    assert.ok(!el.querySelector('script'), '허용하지 않은 태그가 실행됐다');
    assert.ok(/&lt;script&gt;/.test(el.innerHTML), '허용하지 않은 태그가 글자로 남지 않았다: ' + el.innerHTML);
  } finally { softClose(p.w); }
});

test('보고서 확인창이 떠 있으면 17:40 브리핑은 그 창이 닫힌 뒤에 연다 (18시 겹침 방지)', async () => {
  const p = await loadPage({}, { wait: 1500 });
  try {
    const w = p.w, doc = w.document, bubble = doc.getElementById('chiefBubble');
    /* 18시 이후 로드에서는 확인창이 이미 떠 있을 수 있다 → 확실히 띄운다 */
    const pr = w.jisuConfirmDownload({ title: '일일보고서를 다운로드할까요?', filename: 'x.xlsx', desc: '테스트' });
    if (pr && pr.catch) pr.catch(() => { });
    assert.ok(w.jisuIsDlConfirmOpen(), '확인창이 열리지 않았다');
    w.localStorage.setItem(BRIEF, briefJson({ id: '2026-11-29-1740', slot: 'pm', title: '🌆 17:40 저녁 브리핑 · 야간', text: '야간 날씨 · 기온 **3~8℃**' }));
    assert.equal(w.jisuChief.checkBriefing(), false, '확인창이 떠 있는데 브리핑을 열었다');
    assert.ok(!bubble.classList.contains('is-open'), '확인창을 덮고 말풍선이 열렸다');
    assert.equal(doc.querySelectorAll('[data-cb-briefing]').length, 0);
    /* 확인창을 닫으면 5초 간격 재확인으로 열린다 */
    doc.getElementById('dlConfirmCancel').click();
    assert.equal(w.jisuIsDlConfirmOpen(), false);
    let opened = false;
    for (let i = 0; i < 70 && !opened; i++) { closeDl(doc); await sleep(100); opened = bubble.classList.contains('is-open'); }
    assert.ok(!opened || !w.jisuIsDlConfirmOpen(), '브리핑이 열린 순간에 확인창이 겹쳐 있다');
    assert.ok(opened, '확인창이 닫힌 뒤에도 브리핑이 열리지 않았다');
    assert.ok(briefMsg(doc, '2026-11-29-1740'), '저녁 브리핑 메시지가 없다');
  } finally { softClose(p.w); }
});

test('브리핑 photos/photoIds 가 있으면 말풍선에 썸네일이 붙고, 누르면 기존 사진 확대창으로 연다', async () => {
  const p = await loadPage({});
  try {
    const w = p.w, doc = w.document;
    const asked = [];
    w.jisuPhotoBridge = {
      available: true,
      get: (zone, id) => Promise.resolve({ zone, id, data: 'data:image/png;base64,AAAA' }),
      remote: () => Promise.resolve(null)
    };
    w.jisuOpenPhotoById = (zone, id) => { asked.push(zone + ':' + id); return true; };
    doc.getElementById('jisuChiefBtn').click();
    w.jisuChief.showBriefing({
      id: 'photo-1', slot: 'am', title: '사진 브리핑', text: '입고 **중복 의심** 확인',
      photos: [{ id: 'inb-2', zone: 'inbound', label: '입고' }],
      photoIds: ['inbound:inb-2', 'inbound:inb-1']
    });
    await sleep(80);
    const el = briefMsg(doc, 'photo-1');
    assert.ok(el, '브리핑 메시지가 없다');
    const btns = el.querySelectorAll('.cb-photo');
    assert.equal(btns.length, 2, '썸네일이 photos·photoIds 만큼 붙지 않았다');
    assert.equal(btns[0].getAttribute('data-photo-zone'), 'inbound');
    assert.equal(btns[0].getAttribute('data-photo-id'), 'inb-2');
    const img = btns[0].querySelector('img');
    assert.ok(/^data:image/.test(img.getAttribute('src') || ''), '썸네일 이미지가 채워지지 않았다: ' + img.getAttribute('src'));
    btns[0].click();
    assert.deepEqual(asked, ['inbound:inb-2'], '썸네일을 누르면 기존 사진 확대창(jisuOpenPhotoById)으로 열려야 한다');
    /* 사진이 만료·삭제됐으면 빈 칸을 남기지 않는다 */
    w.jisuPhotoBridge = { available: true, get: () => Promise.resolve(null), remote: () => Promise.resolve(null) };
    w.jisuChief.showBriefing({ id: 'photo-2', slot: 'am', title: '사진 없음', text: '본문', photos: [{ id: 'gone', zone: 'pitch' }] });
    await sleep(80);
    assert.equal(briefMsg(doc, 'photo-2').querySelectorAll('.cb-photo').length, 0, '없는 사진의 빈 썸네일이 남았다');
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
  } finally { softClose(p.w); }
});
