// 실행: NODE_PATH=<jsdom 설치 경로> node tests/weather-crosscheck.test.js JISU/index.html
// 2026-11-24 날씨 눈·비 교차확인(met.no 1순위 + 맑음·실패면 wttr.in 함께 확인) 회귀 테스트.
// jsdom + 가짜 Firebase. 날씨 API는 전부 스텁으로 바꾸고 네트워크·운영 DB·푸시 서버로 나가지 않는다.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeFakeFirebase } = require('./integration/fakefb');

const FILE = process.argv[2] || path.join(__dirname, '..', 'JISU', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MET_URL = /api\.met\.no/;
const WTTR_URL = /wttr\.in/;

function metJson(symbol, mm) {
  const t0 = new Date(Date.now() - 60 * 1000).toISOString();
  const t1 = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const slot = s => ({ time: s, data: { instant: { details: { air_temperature: -1 } }, next_1_hours: { summary: { symbol_code: symbol }, details: { precipitation_amount: mm } } } });
  return { properties: { timeseries: [slot(t0), slot(t1)] } };
}
function wttrJson(code, desc, mm) {
  return { current_condition: [{ weatherCode: String(code), weatherDesc: [{ value: desc }], precipMM: String(mm), temp_C: '-1' }] };
}

// weather: 'met:<symbol>:<mm>' | 'metfail' | null(응답 없음)
// wttr:   'wttr:<code>:<desc>:<mm>' | 'wttrfail' | null(응답 없음)
async function loadPage({ weather, wttr, wait = 1600, url = 'https://jisu.test/POSCO-M/JISU/index.html' }) {
  const errors = [], calls = [];
  const vc = new VirtualConsole();
  const envOnly = m => /Not implemented: HTMLCanvasElement\.prototype\.getContext/.test(m);
  vc.on('jsdomError', e => { const m = String(e.message || e); if (!envOnly(m)) errors.push('jsdom: ' + m.slice(0, 160)); });
  vc.on('error', (...a) => errors.push('error: ' + a.map(String).join(' ').slice(0, 200)));
  const fidb = require('fake-indexeddb');
  const fake = makeFakeFirebase();
  const dom = new JSDOM(html, {
    url,
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
      const reply = body => Promise.resolve({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve('') });
      w.fetch = (u) => {
        const s = String(u); calls.push(s);
        if (MET_URL.test(s)) {
          if (weather === 'metfail') return Promise.reject(new Error('met down'));
          if (!weather) return reply(null);
          const [, sym, mm] = weather.match(/^met:([^:]+):([\d.]+)$/) || [];
          return reply(metJson(sym, Number(mm)));
        }
        if (WTTR_URL.test(s)) {
          if (wttr === 'wttrfail') return Promise.reject(new Error('wttr down'));
          if (!wttr) return reply(null);
          const [, code, desc, mm] = wttr.match(/^wttr:(\d+):([^:]+):([\d.]+)$/) || [];
          return reply(wttrJson(code, desc, Number(mm)));
        }
        return reply({});   /* 그 밖의 요청(Firebase REST 등)은 빈 응답 — 실네트워크로 나가지 않는다 */
      };
    }
  });
  await sleep(wait);
  return { w: dom.window, dom, errors, calls };
}

const results = [];
function ok(name, fn) {
  try { fn(); results.push('PASS ' + name); }
  catch (e) { results.push('FAIL ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

(async () => {
  // 1) met.no 맑음(0.0mm) + wttr.in Moderate snow(332, 0.2mm) → 눈
  {
    const p = await loadPage({ weather: 'met:cloudy:0.0', wttr: 'wttr:332:Moderate snow:0.2' });
    const w = p.w, fx = w.jisuWeatherFx;
    ok('1 met.no clear + wttr Moderate snow(332, 0.2mm) → snow', () => assert.equal(fx.state(), 'snow'));
    ok('1 눈이면 조감도 snow 사진', () => assert.ok(/plant-map-snow\.jpg/.test(fx.photo()), 'photo=' + fx.photo()));
    ok('1 눈이면 조감도 판에 weather-snow 캡슐 클래스', () => {
      const stage = w.document.getElementById('mapStage');
      assert.ok(stage.classList.contains('weather-snow'), 'class=' + stage.className);
    });
    ok('1 눈·비 동시 확인: met.no 다음에 wttr.in 을 실제로 조회했다', () => {
      assert.ok(p.calls.some(u => MET_URL.test(u)), 'met.no 요청 있음');
      assert.ok(p.calls.some(u => WTTR_URL.test(u)), 'wttr.in 요청 있음');
    });
    ok('1 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  // 2) met.no 맑음 + wttr.in Patchy heavy snow(335, 0.3mm) → 맑음 (오탐 차단 유지, 1mm 미만 필터)
  {
    const p = await loadPage({ weather: 'met:cloudy:0.0', wttr: 'wttr:335:Patchy heavy snow:0.3' });
    const w = p.w, fx = w.jisuWeatherFx;
    ok('2 met.no clear + wttr Patchy heavy snow(335, 0.3mm) → clear (오탐 차단)', () => assert.equal(fx.state(), 'clear'));
    ok('2 맑음이면 기본 조감도 · 캡슐 클래스 없음', () => {
      assert.ok(/plant-map\.jpg/.test(fx.photo()), 'photo=' + fx.photo());
      assert.equal(w.document.getElementById('mapStage').classList.contains('weather-snow'), false);
    });
    ok('2 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  // 3) met.no lightsnow(0.5mm) → 눈 (wttr.in 을 부르지 않는다)
  {
    const p = await loadPage({ weather: 'met:lightsnow:0.5', wttr: 'wttr:113:Clear:0.0' });
    const w = p.w, fx = w.jisuWeatherFx;
    ok('3 met.no lightsnow(0.5mm) → snow', () => assert.equal(fx.state(), 'snow'));
    ok('3 met.no 가 눈이면 wttr.in 은 조회하지 않는다', () => assert.equal(p.calls.filter(u => WTTR_URL.test(u)).length, 0));
    ok('3 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  // 4) met.no 실패 + wttr.in Light rain(296, 0.5mm) → 비
  {
    const p = await loadPage({ weather: 'metfail', wttr: 'wttr:296:Light rain:0.5' });
    const w = p.w, fx = w.jisuWeatherFx;
    ok('4 met.no 실패 + wttr Light rain(296, 0.5mm) → rain', () => assert.equal(fx.state(), 'rain'));
    ok('4 비면 조감도 rain 사진', () => assert.ok(/plant-map-rain\.jpg/.test(fx.photo()), 'photo=' + fx.photo()));
    ok('4 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  // 5) 둘 다 맑음 → 맑음
  {
    const p = await loadPage({ weather: 'met:cloudy:0.0', wttr: 'wttr:113:Clear:0.0' });
    const fx = p.w.jisuWeatherFx;
    ok('5 met.no clear + wttr Clear → clear', () => assert.equal(fx.state(), 'clear'));
    ok('5 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  // 6) met.no 맑음 + wttr.in 전부 실패 → 맑음 (재시도 2회 뒤)
  {
    const p = await loadPage({ weather: 'met:cloudy:0.0', wttr: 'wttrfail', wait: 9000 });
    const fx = p.w.jisuWeatherFx;
    ok('6 met.no clear + wttr.in 실패 → clear', () => assert.equal(fx.state(), 'clear'));
    ok('6 wttr.in 은 3회까지 시도(1+재시도 2)', () => {
      const n = p.calls.filter(u => WTTR_URL.test(u)).length;
      assert.ok(n === 3, 'wttr 요청 ' + n + '회');
    });
    ok('6 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  // 7) ?weather= 강제값은 그대로 (API 를 부르지 않는다)
  {
    const p = await loadPage({ weather: 'met:cloudy:0.0', wttr: 'wttr:332:Moderate snow:0.2', url: 'https://jisu.test/POSCO-M/JISU/index.html?weather=rain' });
    const fx = p.w.jisuWeatherFx;
    ok('7 ?weather=rain 강제값 유지', () => assert.equal(fx.state(), 'rain'));
    ok('7 강제값일 때는 날씨 API 를 부르지 않는다', () => assert.equal(p.calls.filter(u => MET_URL.test(u) || WTTR_URL.test(u)).length, 0));
    ok('7 JS 오류 0', () => assert.deepEqual(p.errors, []));
    p.dom.window.close();
  }

  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL'));
  console.log('\n' + (failed.length ? 'FAILED ' + failed.length + ' / ' : '') + 'TOTAL ' + results.length + ' checks, PASS ' + (results.length - failed.length));
  process.exit(failed.length ? 1 : 0);
})();
