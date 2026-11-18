// v2(구역 묶음) 동기화 통합 테스트: 실제 index.html 을 여러 기기로 띄워 같은 가짜 DB를 공유
// 준비: npm i --no-save jsdom@24 fake-indexeddb@6   실행: node tests/integration/v2.js JISU/index.html
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeFakeFirebase } = require('./fakefb');
const fidb = require('fake-indexeddb');

const html = fs.readFileSync(process.argv[2] || 'JISU/index.html', 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 조건이 맞을 때까지 기다림(최대 limit ms). 기기가 바빠도 결과로 판정하기 위함
async function waitFor(fn, limit = 10000) { const end = Date.now() + limit; while (Date.now() < end) { try { if (fn()) return true; } catch (_) {} await sleep(50); } return false; }
const kst = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const today = kst(new Date());
const yesterday = kst(new Date(Date.now() - 86400000));
const tomorrow = kst(new Date(Date.now() + 86400000));
const md = d => d.slice(5, 7) + '. ' + d.slice(8, 10) + '.';
const CK = 'jisu-commands-v1', MK = 'jisu-memos-v1';
const results = [];
const ok = (name, fn) => { try { fn(); results.push('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ' :: ' + e.message.slice(0, 300)); } };
const pages = [];

function seedCommands() {
  return [
    { id: 'a1', target: 'outbound', kind: 'instruction', text: '출고 작업 10 TON', at: md(today) + ' 09:00', day: today },
    { id: 'o2', target: 'outbound:2', kind: 'instruction', text: '출고2 작업', at: md(today) + ' 09:05', day: today },
    { id: 'p1', target: 'pitch', kind: 'instruction', text: '피치 작업', at: md(today) + ' 09:10', day: today },
    { id: 'b1', target: '1', kind: 'instruction', text: '1동 작업', at: md(today) + ' 09:15', day: today },
    { id: 'n1', target: '*', kind: 'notice', text: '전체 공지', at: md(today) + ' 09:20', day: today },
    { id: 'k1', target: 'packaging', kind: 'instruction', text: '포장 작업', at: md(today) + ' 09:25', day: today }
  ];
}
function seedServer(fake) {
  const st = (v, t) => ({ v: JSON.stringify(v), t, by: 'seed' });
  fake.setServer('jisu/state/jisu-commands-v1', st(seedCommands(), 1000));
  fake.setServer('jisu/state/jisu-memos-v1', st([{ id: 'mm1', target: 'pitch', tag: '특이', text: '피치 메모', at: md(today) + ' 08:00' }, { id: 'mm2', target: 'inbound', tag: '특이', text: '입고 메모', at: md(today) + ' 08:10' }], 1000));
  fake.setServer('jisu/state/jisu-pitch-records-v1', st({ [today]: { add1s: ['RPB1'], add2s: [''], moves: [''], grind1: '', grind2: '' } }, 1000));
  fake.setServer('jisu/state/jisu-inbound-records-v1', st({ [today]: { day: today, workState: 'idle', rows: [], shiftKey: 'D' } }, 1000));
  fake.setServer('jisu/state/jisu-schedule-v1', st([{ id: 's9', date: tomorrow, target: 'pitch', kind: 'instruction', text: '내일 예약', created: md(today) + ' 07:00' }], 1000));
  fake.setServer('jisu/state/jisu-env-v1', st({ u: {}, round: 1 }, 1000));
  fake.setServer('jisu/state/jisu-env-log-v1', st([{ unit: '1', round: 1, day: today, ts: '08:00', td: today, by: '' }], 1000));
  const img = 'data:image/jpeg;base64,/9j/AAAA';
  fake.setServer('jisu/photos/pitch/ph1', { id: 'ph1', zone: 'pitch', day: today, at: '', name: 'p.jpg', data: img, ts: Date.now() });
  fake.setServer('jisu/photos/outbound/ph2', { id: 'ph2', zone: 'outbound', day: today, at: '', name: 'o.jpg', data: img, ts: Date.now() });
}

async function device(fake, { claims = null, gate = false, local = {}, wait = 1600 } = {}) {
  const errors = [], navs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const m = String(e.message || e); if (/navigation/i.test(m)) navs.push(m); else errors.push('jsdom: ' + m.slice(0, 160)); });
  vc.on('error', (...a) => errors.push('error: ' + a.map(String).join(' ').slice(0, 160)));
  const warns = [];
  vc.on('warn', (...a) => warns.push(a.map(String).join(' ').slice(0, 160)));
  const dom = new JSDOM(html, {
    url: 'https://jisu.test/POSCO-M/JISU/index.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.firebase = fake.forDevice(claims);
      if (gate) w.JISU_AUTH_GATE = true;
      w.indexedDB = new fidb.IDBFactory();   // 기기마다 따로 쓰는 IndexedDB
      ['IDBKeyRange', 'IDBObjectStore', 'IDBIndex', 'IDBCursor', 'IDBCursorWithValue', 'IDBDatabase', 'IDBTransaction', 'IDBRequest', 'IDBOpenDBRequest', 'IDBFactory', 'IDBVersionChangeEvent'].forEach(n => { if (fidb[n]) w[n] = fidb[n]; });
      w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {};
      w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });   // 알림 등 외부 요청 차단
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      Object.entries(local).forEach(([k, v]) => w.localStorage.setItem(k, v));
    }
  });
  pages.push(dom);
  await sleep(wait);
  const w = dom.window;
  // 동기화 준비(모든 묶음 첫 값 수신)가 끝날 때까지 기다림. 승인 전 계정·전환 직후 기기는 묶음이 없거나 시작하지 않음
  await waitFor(() => { const s = w.jisuDb && w.jisuDb.sync; if (!s) return true; const n = s.units().length; return navs.length > 0 || n === 0 || s.debug().ready >= n; }, 15000);
  return { w, errors, warns, navs, ls: k => w.localStorage.getItem(k), arr: k => JSON.parse(w.localStorage.getItem(k) || '[]'),
    dump: () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; } };
}
const ids = a => a.filter(x => x && x.id !== 'demo_dispatch_1').map(x => x.id);
const srv = (fake, part, key) => { const d = fake.getServer(`jisu/v2/${part}/${key}`); return d ? JSON.parse(d.v) : null; };

(async () => {
  const fake = makeFakeFirebase();
  seedServer(fake);

  // 0) 전환 직전, 기기 X가 수정했지만 서버에 못 올린 상태(연결 끊김)
  const X0 = await device(fake);
  fake.state.hangTransactions = true;
  const lx = X0.arr(CK); lx.push({ id: 'xu', target: 'pitch', kind: 'instruction', text: '못 올린 입력', at: md(today) + ' 08:59', day: today });
  X0.w.localStorage.setItem(CK, JSON.stringify(lx));
  await sleep(400);
  const xLocal = X0.dump();
  fake.state.hangTransactions = false;

  // 1) 지금 방식 관리자 기기에서 전환
  const A0 = await device(fake);
  ok('전환 전: 지금 방식으로 시작', () => assert.equal(A0.w.jisuDb.sync.mode(), 'state'));
  const mig = await A0.w.jisuMigrateToV2();
  await waitFor(() => A0.navs.length >= 1);
  ok('전환 결과 ok', () => assert.equal(mig.ok, true, JSON.stringify(mig)));
  ok('config/syncMode = v2', () => assert.equal(fake.getServer('jisu/config/syncMode'), 'v2'));
  ok('state 키에 전환 표시', () => assert.equal(fake.getServer('jisu/state/jisu-commands-v1').mode, 'v2'));
  ok('작업지시: 구역별로 나뉨', () => {
    assert.deepEqual(ids(srv(fake, 'outbound', CK)), ['a1', 'o2']);
    assert.deepEqual(ids(srv(fake, 'pitch', CK)), ['p1']);
    assert.deepEqual(ids(srv(fake, '_admin', CK)), ['b1']);
    assert.deepEqual(ids(srv(fake, '_notice', CK)), ['n1']);
    assert.deepEqual(srv(fake, 'production-c', CK), []);
  });
  ok('특이사항·피치·입고·환경·예약 묶음', () => {
    assert.deepEqual(ids(srv(fake, 'pitch', MK)), ['mm1']);
    assert.deepEqual(ids(srv(fake, 'inbound', MK)), ['mm2']);
    assert.ok(srv(fake, 'pitch', 'jisu-pitch-records-v1')[today]);
    assert.ok(srv(fake, 'inbound', 'jisu-inbound-records-v1')[today]);
    assert.ok(srv(fake, 'environment', 'jisu-env-v1'));
    assert.equal(srv(fake, 'environment', 'jisu-env-log-v1').length, 1);
    assert.deepEqual(ids(srv(fake, '_admin', 'jisu-schedule-v1')), ['s9']);
  });
  ok('전환한 기기는 v2로 새로고침 시도', () => { assert.equal(A0.ls('jisu-sync-mode'), 'v2'); assert.ok(A0.navs.length >= 1); });
  const chk = await A0.w.jisuCheckV2();
  ok('점검: 잘못 들어간 항목·중복 없음', () => assert.equal(chk.ok, true, JSON.stringify(chk)));

  // 2) 새로고침 = v2 로 시작
  const A = await device(fake, { local: A0.dump() });
  ok('A: v2로 시작, 묶음 38개', () => { assert.equal(A.w.jisuDb.sync.mode(), 'v2'); assert.equal(A.w.jisuDb.sync.units().length, 38); });
  ok('A: 화면 목록에 모든 항목, 원래 순서 유지', () => assert.deepEqual(ids(A.arr(CK)), seedCommands().map(x => x.id)));
  ok('A: 새로고침 반복 없음', () => assert.equal(A.navs.length, 0));

  // 2-1) 기기 X 새로고침(v2): 못 올린 항목은 보관하고 서버 값으로 맞춤
  xLocal['jisu-sync-mode'] = 'v2';
  const X = await device(fake, { local: xLocal });
  await sleep(300);
  const bk = await X.w.jisuListLocalBackups();
  ok('전환 직전 못 올린 수정: v2 첫 로드에서 보관', () => assert.ok(bk.some(r => String(r.k).startsWith(CK) && JSON.parse(r.json).some(x => x.id === 'xu')), JSON.stringify(bk).slice(0, 200)));
  ok('전환 직전 못 올린 수정: 미전송 표시 정리', () => { const d = X.dump(); assert.deepEqual(Object.keys(d).filter(k => k.startsWith('jisu-unsynced:') && d[k] === '1'), []); });
  ok('전환 직전 못 올린 수정: 서버 값으로 맞춤(xu 없음)', () => assert.ok(!ids(X.arr(CK)).includes('xu')));

  // 3) 처음 쓰는 기기(캐시 없음): 전환 표시를 보고 v2로
  const B0 = await device(fake);
  ok('새 기기: 전환 표시 보고 v2로 새로고침', () => { assert.equal(B0.ls('jisu-sync-mode'), 'v2'); assert.ok(B0.navs.length >= 1); });
  const B = await device(fake, { local: B0.dump() });
  ok('B: v2로 시작, 같은 목록', () => { assert.equal(B.w.jisuDb.sync.mode(), 'v2'); assert.deepEqual(ids(B.arr(CK)).sort(), seedCommands().map(x => x.id).sort()); });

  // 4) A 수정 → 해당 구역 묶음만 저장 → B 반영
  const tPitchBefore = fake.getServer('jisu/v2/pitch/' + CK).t;
  const la = A.arr(CK); la.find(x => x.id === 'a1').done = 5;
  A.w.localStorage.setItem(CK, JSON.stringify(la));
  await waitFor(() => srv(fake, 'outbound', CK).find(x => x.id === 'a1').done === 5 && B.arr(CK).find(x => x.id === 'a1').done === 5);
  ok('A 수정: 출고 묶음에 저장', () => assert.equal(srv(fake, 'outbound', CK).find(x => x.id === 'a1').done, 5));
  ok('A 수정: 다른 묶음은 그대로', () => assert.equal(fake.getServer('jisu/v2/pitch/' + CK).t, tPitchBefore));
  ok('A 수정: state 원본은 건드리지 않음', () => assert.equal(fake.getServer('jisu/state/jisu-commands-v1').t, 1000));
  ok('B: A의 수정 반영', () => assert.equal(B.arr(CK).find(x => x.id === 'a1').done, 5));
  if (B.arr(CK).find(x => x.id === 'a1').done !== 5) console.log('DEBUG B', JSON.stringify(B.w.jisuDb.sync.debug()), 'A', JSON.stringify(A.w.jisuDb.sync.debug()), 'B warns', B.warns.slice(-6).join(' | '), 'X', JSON.stringify(X.w.jisuDb.sync.debug()));

  // 5) 서로 다른 구역 동시 추가 → 둘 다 남음
  const la2 = A.arr(CK); la2.push({ id: 'pa', target: 'pitch', kind: 'instruction', text: 'A 피치 추가', at: md(today) + ' 10:00', day: today });
  const lb2 = B.arr(CK); lb2.push({ id: 'kb', target: 'packaging', kind: 'instruction', text: 'B 포장 추가', at: md(today) + ' 10:00', day: today });
  A.w.localStorage.setItem(CK, JSON.stringify(la2));
  B.w.localStorage.setItem(CK, JSON.stringify(lb2));
  await waitFor(() => [A, B].every(D => { const s = ids(D.arr(CK)); return s.includes('pa') && s.includes('kb'); }));
  ok('동시 추가(다른 구역): 서버에 둘 다', () => { assert.ok(srv(fake, 'pitch', CK).some(x => x.id === 'pa')); assert.ok(srv(fake, 'packaging', CK).some(x => x.id === 'kb')); });
  ok('동시 추가(다른 구역): 두 기기 모두 둘 다', () => { for (const D of [A, B]) { const s = ids(D.arr(CK)); assert.ok(s.includes('pa') && s.includes('kb'), s.join(',')); } });

  // 6) 작업자 기기(피치): 자기 구역 + 공지만, 다른 구역 캐시는 지움, 공지는 쓰지 않음
  const staffLocal = Object.assign({}, A.dump());
  const S = await device(fake, { claims: { role: 'staff', zone: 'pitch', approved: true }, gate: true, local: staffLocal });
  ok('작업자: v2, 피치 권한', () => { assert.equal(S.w.jisuDb.sync.mode(), 'v2'); assert.equal(JSON.stringify(S.w.jisuDb.sync.role()), JSON.stringify({ all: false, zone: 'pitch' })); });
  ok('작업자: 작업지시는 피치+공지만', () => assert.deepEqual(ids(S.arr(CK)).sort(), ['n1', 'p1', 'pa']));
  ok('작업자: 특이사항은 피치만', () => assert.deepEqual(ids(S.arr(MK)), ['mm1']));
  ok('작업자: 권한 밖 서버 기록(예약·입고·환경)이 기기에 남지 않음', () => {
    assert.equal(S.ls('jisu-schedule-v1'), null, '예약');
    const inb = JSON.parse(S.ls('jisu-inbound-records-v1') || '{}'); assert.notEqual((inb[today] || {}).shiftKey, 'D', '입고(서버 값)');
    const el = JSON.parse(S.ls('jisu-env-log-v1') || '[]'); assert.equal(el.length, 0, '환경 로그(서버 값)');
  });
  ok('작업자: 권한 밖 키는 동기화 묶음에 없음', () => { const us = S.w.jisuDb.sync.units(); assert.ok(us.every(u => /@(pitch|_notice)$/.test(u)), us.join(',')); });
  const idbIds = (D, dbName, store) => new Promise(res => { const r = D.w.indexedDB.open(dbName, 1); r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(store)) r.result.createObjectStore(store, { keyPath: 'id' }); }; r.onsuccess = () => { const q = r.result.transaction(store, 'readonly').objectStore(store).getAllKeys(); q.onsuccess = () => { r.result.close(); res(q.result.map(String)); }; q.onerror = () => res([]); }; r.onerror = () => res([]); });
  await sleep(3000);   // 사진 동기화(시작 1.5초 뒤)가 끝날 시간
  const sPitch = await idbIds(S, 'jisu-pitch-photos', 'pitch'), sOut = await idbIds(S, 'jisu-photos', 'outbound');
  const aPitch = await idbIds(A, 'jisu-pitch-photos', 'pitch'), aOut = await idbIds(A, 'jisu-photos', 'outbound');
  if (!sPitch.includes('ph1')) console.log('DEBUG S photo warns:', S.warns.filter(w => /사진/.test(w)).slice(-5).join(' | '), 'errors:', S.errors.slice(-3).join(' | '));
  ok('사진: 작업자는 자기 구역 사진만 받음', () => { assert.ok(sPitch.includes('ph1'), 'pitch ' + sPitch); assert.ok(!sOut.includes('ph2'), 'outbound ' + sOut); });
  ok('사진: 관리자는 모든 구역 사진', () => { assert.ok(aPitch.includes('ph1')); assert.ok(aOut.includes('ph2')); });
  const sInfo = await S.w.jisuAuthInfo(), aInfo = await A.w.jisuAuthInfo();
  ok('로그인 정보: 게이트 켠 작업자는 토큰·구역, 게이트 꺼진 기기는 없음', () => { assert.equal(sInfo.token, 'tok-pitch'); assert.equal(sInfo.claims.zone, 'pitch'); assert.equal(aInfo, null); });
  ok('작업자: 피치 기록은 남음', () => assert.ok(JSON.parse(S.ls('jisu-pitch-records-v1'))[today]));
  const tNotice = fake.getServer('jisu/v2/_notice/' + CK).t;
  const ls1 = S.arr(CK); ls1.find(x => x.id === 'p1').done = 3; ls1.find(x => x.id === 'n1').closed = true;
  S.w.localStorage.setItem(CK, JSON.stringify(ls1));
  await waitFor(() => srv(fake, 'pitch', CK).find(x => x.id === 'p1').done === 3 && A.arr(CK).find(x => x.id === 'p1').done === 3);
  await sleep(500);
  if (srv(fake, 'pitch', CK).find(x => x.id === 'p1').done !== 3) console.log('DEBUG S', JSON.stringify(S.w.jisuDb.sync.debug()), 'units', S.w.jisuDb.sync.units().length, 'local p1', JSON.stringify(S.arr(CK).find(x => x.id === 'p1')), 'warns', S.warns.slice(-5).join(' | '), 'errs', S.errors.slice(-3).join(' | '));
  ok('작업자 수정: 피치 묶음 저장', () => assert.equal(srv(fake, 'pitch', CK).find(x => x.id === 'p1').done, 3));
  ok('작업자 수정: 공지 묶음은 쓰지 않음', () => assert.equal(fake.getServer('jisu/v2/_notice/' + CK).t, tNotice));
  ok('관리자 A: 작업자 수정 반영, 다른 구역 그대로', () => { const a = A.arr(CK); assert.equal(a.find(x => x.id === 'p1').done, 3); assert.ok(a.some(x => x.id === 'kb') && a.some(x => x.id === 'b1')); });

  // 6-1) 게이트를 켠 관리자 기기: 전체 묶음
  const G = await device(fake, { claims: { role: 'admin', approved: true }, gate: true, local: { 'jisu-sync-mode': 'v2' } });
  ok('게이트 켠 관리자: 전체 묶음 38개, 모든 항목', () => { assert.equal(G.w.jisuDb.sync.units().length, 38); assert.ok(ids(G.arr(CK)).includes('b1')); });
  const P = await device(fake, { claims: { role: 'staff', zone: 'pitch', approved: false }, gate: true, local: { 'jisu-sync-mode': 'v2' } });
  ok('승인 전 계정: 동기화하지 않음', () => { assert.equal(P.w.jisuDb.sync.units().length, 0); assert.ok(!P.ls(CK) || ids(P.arr(CK)).length === 0); });

  // 7) 두 기기 동시 이월: 어제 작업 1건 → 이월 카드는 1건만
  const y = { id: 'y1', target: 'outbound', kind: 'instruction', text: '이월 작업 10 TON', at: md(yesterday) + ' 15:00', day: yesterday };
  const cur = srv(fake, 'outbound', CK);
  await fake.firebase.database().ref('jisu/v2/outbound/' + CK).set({ v: JSON.stringify(cur.concat([y])), t: Date.now(), by: 'test' });
  await sleep(500);
  for (const D of [A, B]) { const ev = new D.w.Event('visibilitychange'); D.w.document.dispatchEvent(ev); }
  await waitFor(() => srv(fake, 'outbound', CK).some(x => x.carryFrom === 'y1') && [A, B].every(D => D.arr(CK).some(x => x.carryFrom === 'y1') && !Object.keys(JSON.parse(D.w.JSON.stringify(D.w.jisuDb.sync.debug()))).length === false));
  await waitFor(() => [A, B].every(D => { const g = D.w.jisuDb.sync.debug(); return !g.pushing.length && !g.dirty.length && !g.again.length; }));
  await sleep(800);
  const outb = srv(fake, 'outbound', CK);
  const carries = outb.filter(x => x.carryFrom === 'y1');
  ok('동시 이월: 서버에 이월 카드 정확히 1건', () => assert.equal(carries.length, 1, JSON.stringify(outb.map(x => x.id))));
  ok('동시 이월: 원래 작업은 닫힘', () => assert.equal(outb.find(x => x.id === 'y1').closed, true));
  ok('동시 이월: 두 기기 화면도 1건', () => { for (const D of [A, B]) assert.equal(D.arr(CK).filter(x => x.carryFrom === 'y1').length, 1); });

  // 8) 되돌리기 → 지금 방식
  const rb = await A.w.jisuRollbackToState();
  await waitFor(() => B.navs.length >= 1 && B.ls('jisu-sync-mode') === 'state');
  ok('되돌리기 ok, config = state', () => { assert.equal(rb.ok, true); assert.equal(fake.getServer('jisu/config/syncMode'), 'state'); });
  const stCmd = JSON.parse(fake.getServer('jisu/state/jisu-commands-v1').v);
  ok('되돌리기: state 에 모든 항목 (중복 없음)', () => { const s = ids(stCmd); for (const id of ['a1', 'o2', 'p1', 'b1', 'n1', 'k1', 'pa', 'kb', 'y1']) assert.ok(s.includes(id), id); assert.equal(s.length, new Set(s).size); assert.equal(stCmd.filter(x => x.carryFrom === 'y1').length, 1); });
  ok('되돌리기: 수정 내용 유지(a1.done=5, p1.done=3)', () => { assert.equal(stCmd.find(x => x.id === 'a1').done, 5); assert.equal(stCmd.find(x => x.id === 'p1').done, 3); });
  ok('되돌리기: 전환 표시 없음', () => assert.equal(fake.getServer('jisu/state/jisu-commands-v1').mode, undefined));
  ok('되돌리기: 다른 기능 기록 유지', () => { assert.ok(JSON.parse(fake.getServer('jisu/state/jisu-pitch-records-v1').v)[today]); assert.equal(JSON.parse(fake.getServer('jisu/state/jisu-schedule-v1').v)[0].id, 's9'); });
  ok('되돌리기: 열린 v2 기기는 새로고침 시도', () => { assert.equal(B.ls('jisu-sync-mode'), 'state'); assert.ok(B.navs.length >= 1); });
  const C = await device(fake, { local: { 'jisu-sync-mode': 'state' } });
  ok('되돌린 뒤 새 기기: 지금 방식으로 모든 항목', () => { assert.equal(C.w.jisuDb.sync.mode(), 'state'); assert.ok(ids(C.arr(CK)).includes('kb')); });

  // 9) 콘솔 오류
  const all = [X0, X, A0, A, B0, B, S, G, P, C];
  const errs = all.flatMap(D => D.errors);
  ok('콘솔 오류 없음 (경고 제외)', () => assert.equal(errs.length, 0, errs.join(' | ')));

  console.log(results.join('\n'));
  const warnSet = [...new Set(all.flatMap(D => D.warns).map(w => w.replace(/\(.*?\)/g, '()').slice(0, 80)))];
  console.log('경고 종류:', warnSet.length ? warnSet.join(' || ') : '없음');
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
