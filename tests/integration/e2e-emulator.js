// 종단 간 테스트: 실제 index.html + 실제 Firebase SDK(10.14.1 compat) + Firebase 에뮬레이터(DB·로그인)
// 준비(저장소 밖): npm i --no-save jsdom@24 fake-indexeddb@6 firebase@10.14.1 firebase-tools@13
// 실행: npx firebase emulators:exec --only database,auth --project demo-jisu "node tests/integration/e2e-emulator.js JISU/index.html"
// 1단계: 열린 규칙(지금 운영과 같음)에서 전환·동기화·동시 이월·되돌리기
// 2단계: database.rules.json 적용 후 로그인 계정별(관리자·작업자·승인 전) 동작
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const fidb = require('fake-indexeddb');

const ROOTDIR = path.join(__dirname, '..', '..');
const FB = path.dirname(require.resolve('firebase/package.json'));
const SDK = ['firebase-app-compat.js', 'firebase-database-compat.js', 'firebase-auth-compat.js'].map(f => fs.readFileSync(path.join(FB, f), 'utf8'));
const NS = 'demo-jisu';
const DBH = 'http://127.0.0.1:9000', AUTHH = 'http://127.0.0.1:9099';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, limit = 15000) { const end = Date.now() + limit; while (Date.now() < end) { try { if (await fn()) return true; } catch (_) {} await sleep(100); } return false; }
const kst = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const today = kst(new Date()), yesterday = kst(new Date(Date.now() - 86400000));
const md = d => d.slice(5, 7) + '. ' + d.slice(8, 10) + '.';
const CK = 'jisu-commands-v1';
const results = []; const pages = [];
const ok = (name, fn) => { try { fn(); results.push('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ' :: ' + String(e.message).slice(0, 300)); } };

// ---- 관리자 권한(owner) REST: 규칙 무시하고 읽기·쓰기 ----
const owner = { Authorization: 'Bearer owner' };
async function dbGet(p) { const r = await fetch(`${DBH}/${p}.json?ns=${NS}`, { headers: owner }); return r.json(); }
async function dbPut(p, v) { const r = await fetch(`${DBH}/${p}.json?ns=${NS}`, { method: 'PUT', headers: owner, body: JSON.stringify(v) }); if (!r.ok) throw new Error('put ' + p + ' ' + r.status); }
async function setRules(rules) { const r = await fetch(`${DBH}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: owner, body: rules }); if (!r.ok) throw new Error('rules ' + r.status + ' ' + await r.text()); }
const v2 = async (part, key) => { const d = await dbGet(`jisu/v2/${part}/${key}`); return d ? JSON.parse(d.v) : null; };

// ---- 로그인 에뮬레이터 계정 ----
async function makeUser(email, claims) {
  const r = await fetch(`${AUTHH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass1234', returnSecureToken: true }) });
  const j = await r.json(); if (!j.localId) throw new Error('signUp ' + JSON.stringify(j));
  const r2 = await fetch(`${AUTHH}/identitytoolkit.googleapis.com/v1/projects/${NS}/accounts:update`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, owner), body: JSON.stringify({ localId: j.localId, customAttributes: JSON.stringify(claims) }) });
  if (!r2.ok) throw new Error('claims ' + await r2.text());
}

async function device({ gate = false, local = {}, signIn = null } = {}) {
  const errors = [], warns = [], navs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const m = String(e.message || e); if (/navigation/i.test(m)) navs.push(m); else errors.push('jsdom: ' + m.slice(0, 200)); });
  vc.on('error', (...a) => errors.push('error: ' + a.map(String).join(' ').slice(0, 200)));
  vc.on('warn', (...a) => warns.push(a.map(String).join(' ').slice(0, 200)));
  // CDN 스크립트를 같은 버전의 SDK 본문으로 바꾸고, 에뮬레이터에 먼저 연결해 둔다 (페이지는 이미 만든 앱을 그대로 씀)
  let html = fs.readFileSync(process.argv[2] || path.join(ROOTDIR, 'JISU', 'index.html'), 'utf8');
  const tag = n => `<script src="https://www.gstatic.com/firebasejs/10.14.1/${n}"></script>`;
  for (const n of ['firebase-app-compat.js', 'firebase-database-compat.js', 'firebase-auth-compat.js']) assert.ok(html.includes(tag(n)), n);
  html = html.replace(tag('firebase-app-compat.js'), '<script>' + SDK[0] + '</script>')
    .replace(tag('firebase-database-compat.js'), '<script>' + SDK[1] + '</script>')
    .replace(tag('firebase-auth-compat.js'), '<script>' + SDK[2] + `</script><script>
      firebase.initializeApp({ apiKey: 'fake-key', authDomain: 'demo-jisu.firebaseapp.com', projectId: '${NS}', databaseURL: '${DBH}?ns=${NS}' });
      firebase.database().useEmulator('127.0.0.1', 9000);
      firebase.auth().useEmulator('${AUTHH}', { disableWarnings: true });
    </script>`)
    .replace('<script src="./auth.js"></script>', '');
  const dom = new JSDOM(html, {
    url: 'http://localhost/POSCO-M/JISU/index.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      if (gate) w.JISU_AUTH_GATE = true;
      w.indexedDB = new fidb.IDBFactory();
      ['IDBKeyRange', 'IDBObjectStore', 'IDBIndex', 'IDBCursor', 'IDBCursorWithValue', 'IDBDatabase', 'IDBTransaction', 'IDBRequest', 'IDBOpenDBRequest', 'IDBFactory', 'IDBVersionChangeEvent'].forEach(n => { if (fidb[n]) w[n] = fidb[n]; });
      w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {};
      // 에뮬레이터 요청만 실제로 보내고, 알림 등 외부 요청은 막음
      w.fetch = (u, o) => (String(u).startsWith('http://127.0.0.1') ? fetch(u, o) : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') }));
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      Object.entries(local).forEach(([k, v]) => w.localStorage.setItem(k, v));
    }
  });
  pages.push(dom);
  const w = dom.window;
  if (signIn) { await sleep(300); await w.firebase.auth().signInWithEmailAndPassword(signIn, 'pass1234'); }
  await waitFor(() => { const s = w.jisuDb && w.jisuDb.sync; if (!s) return false; const n = s.units().length; return navs.length > 0 || (n > 0 && s.debug().ready >= n); }, 20000);
  return { w, errors, warns, navs, arr: k => JSON.parse(w.localStorage.getItem(k) || '[]'), ls: k => w.localStorage.getItem(k),
    dump: () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; },
    idle: () => { const g = w.jisuDb.sync.debug(); return !g.pushing.length && !g.dirty.length && !g.again.length; } };
}
const ids = a => (a || []).filter(x => x && x.id !== 'demo_dispatch_1').map(x => x.id);
const st = v => ({ v: JSON.stringify(v), t: 1000, by: 'seed' });

(async () => {
  // ===== 1단계: 열린 규칙 =====
  await setRules(JSON.stringify({ rules: { '.read': true, '.write': true } }));
  await dbPut('jisu', {
    state: {
      'jisu-commands-v1': st([
        { id: 'a1', target: 'outbound', kind: 'instruction', text: '출고 10 TON', at: md(today) + ' 09:00', day: today },
        { id: 'p1', target: 'pitch', kind: 'instruction', text: '피치 작업', at: md(today) + ' 09:10', day: today },
        { id: 'b1', target: '1', kind: 'instruction', text: '1동 작업', at: md(today) + ' 09:15', day: today },
        { id: 'n1', target: '*', kind: 'notice', text: '전체 공지', at: md(today) + ' 09:20', day: today }]),
      'jisu-memos-v1': st([{ id: 'mm1', target: 'pitch', tag: '특이', text: '피치 메모', at: md(today) + ' 08:00' }]),
      'jisu-schedule-v1': st([{ id: 's9', date: '2999-01-01', target: 'pitch', kind: 'instruction', text: '먼 예약', created: '' }])
    }
  });
  const A0 = await device();
  ok('[실SDK] 시작: 지금 방식', () => assert.equal(A0.w.jisuDb.sync.mode(), 'state'));
  const mig = await A0.w.jisuMigrateToV2();
  await waitFor(() => A0.navs.length > 0);
  ok('[실SDK] 전환 결과', () => assert.equal(mig.ok, true, JSON.stringify(mig)));
  const outb = await v2('outbound', CK), adm = await v2('_admin', CK);
  ok('[실SDK] 작업지시 구역별 나눔', () => { assert.deepEqual(ids(outb), ['a1']); assert.deepEqual(ids(adm), ['b1']); });

  const A = await device({ local: A0.dump() });
  const B = await device({ local: Object.assign({}, { 'jisu-sync-mode': 'v2' }) });
  ok('[실SDK] A·B v2 시작, 같은 목록', () => { assert.equal(A.w.jisuDb.sync.mode(), 'v2'); assert.deepEqual(ids(B.arr(CK)).sort(), ['a1', 'b1', 'n1', 'p1']); });

  const la = A.arr(CK); la.find(x => x.id === 'a1').done = 5; A.w.localStorage.setItem(CK, JSON.stringify(la));
  await waitFor(() => (B.arr(CK).find(x => x.id === 'a1') || {}).done === 5);
  ok('[실SDK] A 수정 → B 반영', () => assert.equal(B.arr(CK).find(x => x.id === 'a1').done, 5));

  const la2 = A.arr(CK); la2.push({ id: 'pa', target: 'pitch', kind: 'instruction', text: 'A 추가', at: md(today) + ' 10:00', day: today });
  const lb2 = B.arr(CK); lb2.push({ id: 'ob', target: 'outbound', kind: 'instruction', text: 'B 추가', at: md(today) + ' 10:00', day: today });
  A.w.localStorage.setItem(CK, JSON.stringify(la2)); B.w.localStorage.setItem(CK, JSON.stringify(lb2));
  await waitFor(() => [A, B].every(D => { const s = ids(D.arr(CK)); return s.includes('pa') && s.includes('ob'); }) && A.idle() && B.idle());
  const sp = ids(await v2('pitch', CK)), so = ids(await v2('outbound', CK));
  ok('[실SDK] 다른 구역 동시 추가: 서버', () => { assert.ok(sp.includes('pa')); assert.ok(so.includes('ob')); assert.ok(so.includes('a1')); });

  const cur = await v2('outbound', CK);
  await dbPut(`jisu/v2/outbound/${CK}`, { v: JSON.stringify(cur.concat([{ id: 'y1', target: 'outbound', kind: 'instruction', text: '이월 10 TON', at: md(yesterday) + ' 15:00', day: yesterday }])), t: Date.now(), by: 'test' });
  await waitFor(() => [A, B].every(D => ids(D.arr(CK)).includes('y1')));
  for (const D of [A, B]) D.w.document.dispatchEvent(new D.w.Event('visibilitychange'));
  await waitFor(async () => { const o = await v2('outbound', CK); return o.some(x => x.carryFrom === 'y1') && A.idle() && B.idle(); });
  await sleep(1500);
  const o2 = await v2('outbound', CK);
  ok('[실SDK] 두 기기 동시 이월: 이월 카드 1건', () => assert.equal(o2.filter(x => x.carryFrom === 'y1').length, 1, ids(o2).join(',')));
  ok('[실SDK] 두 기기 화면도 1건', () => { for (const D of [A, B]) assert.equal(D.arr(CK).filter(x => x.carryFrom === 'y1').length, 1); });
  const chk = await A.w.jisuCheckV2();
  ok('[실SDK] 점검 ok', () => assert.equal(chk.ok, true, JSON.stringify(chk)));

  const rb = await A.w.jisuRollbackToState();
  await waitFor(() => B.navs.length > 0);
  const stc = JSON.parse((await dbGet(`jisu/state/${CK}`)).v);
  ok('[실SDK] 되돌리기: 모든 항목·수정 유지', () => { assert.equal(rb.ok, true); const s = ids(stc); for (const id of ['a1', 'p1', 'b1', 'n1', 'pa', 'ob', 'y1']) assert.ok(s.includes(id), id); assert.equal(stc.find(x => x.id === 'a1').done, 5); assert.equal(stc.filter(x => x.carryFrom === 'y1').length, 1); });
  const errs1 = [A0, A, B].flatMap(D => D.errors);
  ok('[실SDK] 1단계 콘솔 오류 없음', () => assert.equal(errs1.length, 0, errs1.join(' | ')));

  // 2단계 준비: 다시 v2로 전환
  const A2 = await device({ local: { 'jisu-sync-mode': 'state' } });
  const mig2 = await A2.w.jisuMigrateToV2();
  ok('[실SDK] 다시 전환', () => assert.equal(mig2.ok, true));

  // ===== 2단계: 새 보안 규칙 + 로그인 =====
  await setRules(fs.readFileSync(path.join(ROOTDIR, 'database.rules.json'), 'utf8'));
  await makeUser('admin@jisu.local', { role: 'admin', approved: true });
  await makeUser('1001@jisu.local', { role: 'staff', zone: 'pitch', approved: true });
  await makeUser('1002@jisu.local', { role: 'staff', zone: 'pitch', approved: false });

  const G = await device({ gate: true, local: { 'jisu-sync-mode': 'v2' }, signIn: 'admin@jisu.local' });
  ok('[규칙] 관리자: 전체 묶음 동기화', () => { assert.equal(G.w.jisuDb.sync.units().length, 38); assert.equal(G.w.jisuDb.sync.debug().ready, 38); assert.ok(ids(G.arr(CK)).includes('b1')); });
  const S = await device({ gate: true, local: { 'jisu-sync-mode': 'v2' }, signIn: '1001@jisu.local' });
  ok('[규칙] 작업자: 피치+공지 묶음만, 모두 준비됨', () => { const us = S.w.jisuDb.sync.units(); assert.ok(us.length > 0 && us.every(u => /@(pitch|_notice)$/.test(u)), us.join(',')); assert.equal(S.w.jisuDb.sync.debug().ready, us.length); });
  ok('[규칙] 작업자: 화면 목록은 피치+공지', () => assert.deepEqual(ids(S.arr(CK)).sort(), ['n1', 'p1', 'pa']));
  const ls = S.arr(CK); ls.find(x => x.id === 'p1').done = 7; ls.find(x => x.id === 'n1').closed = true;
  S.w.localStorage.setItem(CK, JSON.stringify(ls));
  await waitFor(async () => ((await v2('pitch', CK)).find(x => x.id === 'p1') || {}).done === 7 && S.idle());
  const sp2 = await v2('pitch', CK), sn2 = await v2('_notice', CK);
  ok('[규칙] 작업자 수정: 서버 반영, 공지는 그대로', () => { assert.equal(sp2.find(x => x.id === 'p1').done, 7); assert.ok(!sn2.find(x => x.id === 'n1').closed); });
  await waitFor(() => (G.arr(CK).find(x => x.id === 'p1') || {}).done === 7);
  ok('[규칙] 관리자 화면에 작업자 수정 반영', () => assert.equal(G.arr(CK).find(x => x.id === 'p1').done, 7));
  let deniedOther = false, deniedState = false;
  try { await S.w.firebase.database().ref(`jisu/v2/outbound/${CK}`).once('value'); } catch (e) { deniedOther = /permission/i.test(String(e && (e.code || e.message))); }
  try { await S.w.firebase.database().ref(`jisu/state/${CK}`).once('value'); } catch (e) { deniedState = /permission/i.test(String(e && (e.code || e.message))); }
  ok('[규칙] 작업자: 다른 구역·원본 직접 읽기 거부', () => { assert.ok(deniedOther, 'outbound'); assert.ok(deniedState, 'state'); });
  const P = await device({ gate: true, local: { 'jisu-sync-mode': 'v2' }, signIn: '1002@jisu.local' });
  await sleep(1500);
  let deniedPending = false;
  try { await P.w.firebase.database().ref(`jisu/v2/pitch/${CK}`).once('value'); } catch (e) { deniedPending = /permission/i.test(String(e && (e.code || e.message))); }
  ok('[규칙] 승인 전: 동기화 안 함, 직접 읽기 거부', () => { assert.equal(P.w.jisuDb.sync.units().length, 0); assert.ok(deniedPending); });
  const errs2 = [G, S, P].flatMap(D => D.errors).filter(e => !/permission_denied/i.test(e));
  const permWarn = [G, S].flatMap(D => D.warns).filter(w => /permission|구독 실패|저장 실패/i.test(w));
  ok('[규칙] 관리자·작업자 기기: 권한 오류·구독 실패 없음', () => assert.equal(permWarn.length, 0, permWarn.join(' | ')));
  ok('[규칙] 콘솔 오류 없음', () => assert.equal(errs2.length, 0, errs2.join(' | ')));

  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  for (const d of pages) { try { d.window.close(); } catch (_) {} }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
