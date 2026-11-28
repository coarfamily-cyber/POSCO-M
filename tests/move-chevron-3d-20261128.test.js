// 실행: NODE_PATH=<jsdom 설치 경로> node --test tests/move-chevron-3d-20261128.test.js
//        (개별 실행: NODE_PATH=<jsdom 설치 경로> node tests/move-chevron-3d-20261128.test.js JISU/index.html)
// 2026-11-28 수뽕 님 지시: "이코드 검토후에 적용해줘 이동동선 기존거 대신 3d화살표 방향이야"
//   · 기존 점선(.move-path/.move-glow)·펄스 러너(.move-runner.pulse)를 지우고,
//     경로를 따라 일정 간격(18px)으로 진행 방향(atan2)을 맞춘 3D 입체 쉐브론(>) 화살표를 세운다.
//   · 쉐브론마다 ①아래쪽 어두운 두께(rgba(0,0,0,.55), y+1.5) ②메인 컬러(stroke-width 2.8)
//     ③위쪽 하이라이트(rgba(255,255,255,.45), stroke-width 1) 세 겹.
//   · mvChevWave 파도: 대기 3.8s / 작업중 2.8s, 0%(0.03)→16%(1)→38%(0.52)→64%(0.12)→100%(0.03),
//     음수 animation-delay 로 첫 프레임부터 끊김 없이 출발지→도착지로 흐른다.
//   · 유지: route() 도로 경로·다중 경로 오프셋·MVC/MVW 색·중앙 라벨·?zone= 숨김
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const md = today.slice(5, 7) + '. ' + today.slice(8, 10) + '.';
const W = 1600, H = 900;   /* 실측 기준 지도 크기(px) — 지도 대비 % 좌표를 그대로 픽셀로 환산 */

const lateErrors = [];
process.on('unhandledRejection', e => lateErrors.push(String((e && e.message) || e).slice(0, 160)));

/* 실제 이동작업 2건: 2동→1동(작업중) · 3동→창고(대기) */
function baseItems() {
  return [
    { id: 'mv1', target: 'production-a', kind: 'instruction', text: '2동 → 1동 이동', from: 'C', to: 'A', working: true, at: md + ' 20:10', day: today },
    { id: 'mv2', target: 'production-d', kind: 'instruction', text: '3동 → 창고 이동', from: 'D', to: 'W', at: md + ' 20:20', day: today }
  ];
}

async function loadPage(seed) {
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
      /* jsdom 은 레이아웃이 없어 모든 사각형이 0 — 지도 무대를 실측 크기로 고정한다 */
      w.Element.prototype.getBoundingClientRect = function () {
        const isStage = this.id === 'mapStage';
        const wd = isStage ? W : 120, ht = isStage ? H : 32;
        return { left: 0, top: 0, width: wd, height: ht, right: wd, bottom: ht, x: 0, y: 0, toJSON() { return this; } };
      };
      Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
    }
  });
  await sleep(1600);
  return { w: dom.window, dom, fake, errors };
}

const chevGroups = w => [...w.document.querySelectorAll('#moveLayer g.mv-chev')];
const tf = el => {
  const m = /translate\(([-\d.]+),\s*([-\d.]+)\)\s*rotate\(([-\d.]+)\)/.exec(el.getAttribute('transform') || '');
  return m ? { x: +m[1], y: +m[2], a: +m[3] } : null;
};
const mainTf = g => tf(g.querySelector('.mv-chev-main'));

test('이동동선 3D 쉐브론 화살표 파도 — 점선·펄스 대체, 방향·3D 3겹·파도 주기', async () => {
  const items = baseItems();
  const p = await loadPage({ [KEY]: JSON.stringify(items) });
  const w = p.w;
  try {
    assert.equal(p.errors.length, 0, p.errors.join(' | '));
    const doc = w.document;

    // ── 1) 기존 점선·펄스 마크업이 남아 있지 않다 ────────────────────────────
    const layer = doc.getElementById('moveLayer');
    assert.ok(layer, 'moveLayer(SVG) 가 없다');
    assert.equal(doc.querySelectorAll('#moveLayer .move-path').length, 0, '옛 점선 .move-path 가 남아 있다');
    assert.equal(doc.querySelectorAll('#moveLayer .move-glow').length, 0, '옛 글로우 .move-glow 가 남아 있다');
    assert.equal(doc.querySelectorAll('#moveLayer .move-path-outer, #moveLayer .move-path-inner').length, 0, '옛 외곽선이 남아 있다');
    assert.equal(doc.querySelectorAll('#moveLayer .move-start').length, 0, '옛 출발점 원이 남아 있다');
    assert.equal(doc.querySelectorAll('#moveLayer .move-runner, #moveLayer .pulse-aura, #moveLayer .pulse-core, #moveLayer .pulse-spark').length, 0, '옛 펄스 러너가 남아 있다');
    assert.equal(doc.querySelectorAll('#moveLayer marker').length, 0, '옛 화살촉 marker 가 남아 있다');
    assert.equal(layer.getAttribute('viewBox'), '0 0 ' + W + ' ' + H, 'viewBox 가 지도 크기와 다르다: ' + layer.getAttribute('viewBox'));

    // ── 2) 이동 2건이 각각 쉐브론 무리를 가진다 ──────────────────────────────
    const groups = chevGroups(w);
    assert.ok(groups.length >= 20, '쉐브론이 너무 적다: ' + groups.length);
    const working = groups.filter(g => g.classList.contains('is-working'));
    const waiting = groups.filter(g => !g.classList.contains('is-working'));
    assert.ok(working.length >= 10, '작업중 동선 쉐브론이 부족하다: ' + working.length);
    assert.ok(waiting.length >= 10, '대기 동선 쉐브론이 부족하다: ' + waiting.length);

    // ── 3) 쉐브론 한 개 = 3겹(그림자 두께·메인 컬러·위쪽 하이라이트) ──────────
    const css = html.replace(/\s+/g, ' ');
    for (const g of groups) {
      const paths = [...g.querySelectorAll('path')];
      assert.equal(paths.length, 3, '쉐브론은 3겹이어야 한다: ' + paths.length);
      const d = paths.map(p2 => p2.getAttribute('d'));
      assert.deepEqual([...new Set(d)], ['M-3.9,-4.4 L2.5,0 L-3.9,4.4'], '쉐브론 모양이 진행 방향(>)이 아니다: ' + d.join(' / '));
      assert.equal(g.querySelectorAll('.mv-chev-shadow').length, 1, '그림자(두께) 겹이 없다');
      assert.equal(g.querySelectorAll('.mv-chev-main').length, 1, '메인 컬러 겹이 없다');
      assert.equal(g.querySelectorAll('.mv-chev-gloss').length, 1, '하이라이트 겹이 없다');
      const sh = tf(g.querySelector('.mv-chev-shadow')), mn = mainTf(g), gl = tf(g.querySelector('.mv-chev-gloss'));
      assert.ok(sh && mn && gl, '쉐브론 transform 이 없다');
      assert.ok(Math.abs(sh.x - mn.x) < 0.2 && Math.abs((sh.y - mn.y) - 1.5) < 0.2, '아래쪽 두께 오프셋(y+1.5)이 아니다');
      assert.ok(Math.abs(gl.x - mn.x) < 0.2 && Math.abs((gl.y - mn.y) + 0.7) < 0.2, '위쪽 하이라이트 오프셋(y-0.7)이 아니다');
      assert.equal(sh.a, mn.a); assert.equal(gl.a, mn.a);
      assert.ok(/--c:#[0-9a-f]{6}/i.test(g.getAttribute('style') || ''), '쉐브론 컬러(--c)가 없다: ' + g.getAttribute('style'));
    }
    assert.ok(/\.mv-chev-shadow\{stroke:rgba\(0,0,0,\.55\);stroke-width:3\.6;\}/.test(css), '두께 레이어 CSS 가 규격과 다르다');
    assert.ok(/\.mv-chev-main\{stroke:var\(--c,#ff9900\);stroke-width:2\.8;\}/.test(css), '메인 쉐브론 stroke-width 2.8 이 아니다');
    assert.ok(/\.mv-chev-gloss\{stroke:rgba\(255,255,255,\.45\);stroke-width:1;\}/.test(css), '하이라이트 하이라인 CSS 가 규격과 다르다');
    assert.ok(/stroke-linecap:round/.test(css) && /stroke-linejoin:round/.test(css), 'stroke linecap/linejoin round 가 없다');

    // ── 4) 작업중/대기 색: MVC 대기 · MVW 작업중 (기존 팔레트 유지) ────────────
    const colOf = g => (/--c:(#[0-9a-f]{6})/i.exec(g.getAttribute('style') || '') || [])[1];
    assert.ok(working.every(g => colOf(g).toLowerCase() === '#ffaa00'), '작업중 1번은 MVW #ffaa00 이어야 한다: ' + [...new Set(working.map(colOf))].join(','));
    assert.ok(waiting.every(g => colOf(g).toLowerCase() === '#4ade80'), '대기 2번은 MVC #4ade80(2번 라임 그린) 이어야 한다: ' + [...new Set(waiting.map(colOf))].join(','));
    assert.ok(working.every(g => /--mv:#ff9900/i.test(g.getAttribute('style') || '')), '작업중 라벨색(--mv)이 1번 앰버가 아니다');

    // ── 5) 간격 18px · 진행 방향 정렬 · 출발→도착 순서 ────────────────────────
    for (const [name, list] of [['작업중', working], ['대기', waiting]]) {
      const pts = list.map(mainTf);
      let straight = 0, aligned = 0, pairs = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
        const dist = Math.hypot(dx, dy);
        assert.ok(dist <= 18.3, name + ' 쉐브론 간격이 18px 를 넘는다: ' + dist.toFixed(2));
        if (dist > 4) {
          pairs++;
          const want = Math.atan2(dy, dx) * 180 / Math.PI;
          const diff = a => { const d = Math.abs(((a - want + 540) % 360) - 180); return d; };
          if (dist > 16) straight++;
          if (diff(pts[i].a) <= 8 || diff(pts[i + 1].a) <= 8) aligned++;
        }
      }
      assert.ok(straight >= list.length * 0.5, name + ' 쉐브론이 곧은 구간에서 18px 로 균등하지 않다(직선 ' + straight + '/' + list.length + ')');
      assert.ok(aligned >= pairs * 0.9, name + ' 쉐브론 방향(rotate)이 진행 방향과 어긋난다(' + aligned + '/' + pairs + ')');
    }
    /* 첫 쉐브론은 출발 입구, 마지막 쉐브론은 도착 입구 근처 */
    const dock = (x, y) => ({ x: x / 100 * W, y: y / 100 * H });
    const near = (p2, q, lim) => Math.hypot(p2.x - q.x, p2.y - q.y) <= lim;
    const pairsFor = (from, to, list) => {
      const pts = list.map(mainTf);
      assert.ok(near(pts[0], dock(...from), 22), '첫 쉐브론이 출발지에 붙어 있지 않다');
      assert.ok(near(pts[pts.length - 1], dock(...to), 22), '마지막 쉐브론이 도착지에 붙어 있지 않다');
    };
    pairsFor([58.26, 38.97], [20.11, 82.35], working);   /* 2동(C) → 1동(A) */
    pairsFor([58.37, 55.43], [79.01, 9.64], waiting);    /* 3동(D) → 창고(W) */

    // ── 6) mvChevWave 파도: 주기·키프레임·음수 지연 ───────────────────────────
    assert.ok(/\.mv-chev\{fill:none;stroke-linecap:round;stroke-linejoin:round;opacity:\.03;animation:mvChevWave 3\.8s ease-in-out infinite;\}/.test(css), '대기 3.8s 파도 CSS 가 규격과 다르다');
    assert.ok(/\.mv-chev\.is-working\{animation-duration:2\.8s;\}/.test(css), '작업중 2.8s CSS 가 규격과 다르다');
    assert.ok(/@keyframes mvChevWave\{0%\{opacity:\.03;\}16%\{opacity:1;\}38%\{opacity:\.52;\}64%\{opacity:\.12;\}100%\{opacity:\.03;\}\}/.test(css), 'mvChevWave 키프레임이 0/16/38/64/100% 규격과 다르다');
    const delays = groups.map(g => parseFloat((/animation-delay:([-\d.]+)s/.exec(g.getAttribute('style') || '') || [])[1]));
    assert.ok(delays.every(d => !Number.isNaN(d) && d < 0), '파도 지연은 모두 음수여야 첫 프레임부터 흐른다: ' + delays.slice(0, 6).join(','));
    assert.ok(delays.every(d => d >= -3.81), '지연이 한 주기를 넘으면 첫 프레임이 빈다: ' + Math.min(...delays));
    /* 위상(밝아지는 시점)이 경로를 따라 커져야 파도가 출발→도착으로 흐른다(작업중 2.8s 기준) */
    const wd = working.map(g => 1 + parseFloat((/animation-delay:([-\d.]+)s/.exec(g.getAttribute('style') || '') || [])[1]) / 2.8);
    let forward = 0;
    for (let i = 0; i < wd.length - 1; i++) if (wd[i + 1] - wd[i] > -0.001) forward++;
    assert.ok(forward >= (wd.length - 1) * 0.88, '파도 위상이 경로를 따라 커지지 않는다(' + forward + '/' + (wd.length - 1) + ')');

    // ── 7) 중앙 라벨은 그대로: 경로 위 '2동 → 1동 · 작업중' ────────────────────
    const labels = [...doc.querySelectorAll('#moveLabels .move-label')];
    assert.equal(labels.length, 2, '이동 라벨이 2건이 아니다: ' + labels.length);
    const txt = labels.map(l => l.textContent);
    assert.ok(txt.some(t => t.includes('2동') && t.includes('1동') && t.includes('작업중')), '2동→1동 작업중 라벨이 없다: ' + txt.join(' | '));
    assert.ok(txt.some(t => t.includes('3동') && t.includes('창고')), '3동→창고 라벨이 없다: ' + txt.join(' | '));
    assert.ok(labels.some(l => l.classList.contains('is-working')), '작업중 라벨 클래스가 없다');
    const labStyle = labels.map(l => l.getAttribute('style') || '');
    assert.ok(labStyle.every(s => /left:[-\d.]+px;top:[-\d.]+px/.test(s)), '라벨 위치가 없다');

    // ── 8) ?zone= 작업자 화면에서는 그대로 숨긴다 ────────────────────────────
    assert.ok(/html\.worker-zone-only \.move-layer/.test(css), '작업자 화면 move-layer 숨김 규칙이 사라졌다');

    // ── 9) 세로선직 교차 확인: 쉐브론 좌표가 지도 밖으로 나가지 않는다 ─────────
    for (const g of groups) { const t = mainTf(g); assert.ok(t.x >= -5 && t.x <= W + 5 && t.y >= -5 && t.y <= H + 5, '쉐브론이 지도 밖: ' + JSON.stringify(t)); }

    // ── 10) 빌드 메타 ────────────────────────────────────────────────────────
    const build = (doc.querySelector('meta[name="jisu-build"]') || {}).content || '';
    assert.ok(/^\d{12}$/.test(build), 'jisu-build 메타가 없다: ' + build);
  assert.deepEqual(lateErrors, [], lateErrors.join(' | '));
  } finally {
    try { w.close(); } catch (_) {}     /* 페이지 타이머를 정리해 테스트 프로세스가 끝나게 한다 */
  }
});
