// 보안 규칙 테스트 (Firebase 데이터베이스 에뮬레이터)
// 준비: npm i --no-save @firebase/rules-unit-testing@3 firebase@10.14.1 firebase-tools@13
// 실행: npx firebase emulators:exec --only database --project demo-jisu "node --test tests/rules/rules.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8');
const [host, port] = (process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000').split(':');
let env;
const item = (v) => ({ v: JSON.stringify(v), t: Date.now(), by: 't' });

test.before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-jisu', database: { rules, host, port: Number(port) } });
});
test.after(async () => { if (env) await env.cleanup(); });
test.beforeEach(async () => {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref('jisu').set({
      config: { syncMode: 'v2' },
      state: { 'jisu-commands-v1': item([{ id: 'a' }]) },
      v2: {
        pitch: { 'jisu-commands-v1': item([{ id: 'p1', target: 'pitch' }]) },
        outbound: { 'jisu-commands-v1': item([{ id: 'o1', target: 'outbound' }]) },
        _notice: { 'jisu-commands-v1': item([{ id: 'n1', target: '*' }]) },
        _admin: { 'jisu-schedule-v1': item([{ id: 's1' }]) }
      },
      photos: { pitch: { ph1: { id: 'ph1', data: 'x', ts: 1 } }, outbound: { ph2: { id: 'ph2', data: 'x', ts: 1 } } },
      push_subs: { sub_o: { zone: 'outbound', sub: { endpoint: 'e' } }, sub_p: { zone: 'pitch', sub: { endpoint: 'e2' } } },
      zones: { pitch: { commands: { p1: { id: 'p1' } } } }
    });
  });
});

const admin = () => env.authenticatedContext('admin1', { role: 'admin', approved: true }).database();
const pitch = () => env.authenticatedContext('s1', { role: 'staff', zone: 'pitch', approved: true }).database();
const pending = () => env.authenticatedContext('s2', { role: 'staff', zone: 'pitch', approved: false }).database();
const noClaims = () => env.authenticatedContext('x1', {}).database();
const anon = () => env.unauthenticatedContext().database();

test('관리자: 전체 읽기·쓰기', async () => {
  const db = admin();
  await assertSucceeds(db.ref('jisu').once('value'));
  await assertSucceeds(db.ref('jisu/state/jisu-commands-v1').set(item([])));
  await assertSucceeds(db.ref('jisu/v2/outbound/jisu-commands-v1').set(item([])));
  await assertSucceeds(db.ref('jisu/config/syncMode').set('state'));
  await assertSucceeds(db.ref('jisu/v2/_notice/jisu-commands-v1').set(item([])));
  // 전환 도구와 같은 다중 경로 쓰기
  await assertSucceeds(db.ref('jisu').update({ 'v2/pitch/jisu-memos-v1': item([]), 'state/jisu-commands-v1/mode': 'v2', 'config/syncMode': 'v2' }));
});

test('작업자(피치): 자기 구역 묶음 읽기·쓰기, 트랜잭션', async () => {
  const db = pitch();
  await assertSucceeds(db.ref('jisu/v2/pitch/jisu-commands-v1').once('value'));
  await assertSucceeds(db.ref('jisu/v2/pitch/jisu-commands-v1').set(item([{ id: 'p1', done: 3 }])));
  await assertSucceeds(db.ref('jisu/v2/pitch/jisu-commands-v1').transaction(cur => ({ v: '[]', t: ((cur && cur.t) || 0) + 1, by: 's1' })));
  await assertSucceeds(db.ref('jisu/v2/pitch/jisu-pitch-records-v1').set(item({})));
});

test('작업자(피치): 형식이 틀린 값은 거부', async () => {
  const db = pitch();
  await assertFails(db.ref('jisu/v2/pitch/jisu-commands-v1').set({ foo: 1 }));
  await assertFails(db.ref('jisu/v2/pitch/jisu-commands-v1').set({ v: 1, t: 1 }));
});

test('작업자(피치): 다른 구역·관리자 묶음·원본 접근 불가', async () => {
  const db = pitch();
  await assertFails(db.ref('jisu/v2/outbound/jisu-commands-v1').once('value'));
  await assertFails(db.ref('jisu/v2/outbound/jisu-commands-v1').set(item([])));
  await assertFails(db.ref('jisu/v2/_admin/jisu-schedule-v1').once('value'));
  await assertFails(db.ref('jisu/v2').once('value'));
  await assertFails(db.ref('jisu/state/jisu-commands-v1').once('value'));
  await assertFails(db.ref('jisu/state/jisu-commands-v1').set(item([])));
  await assertFails(db.ref('jisu/zones/pitch').once('value'));
  await assertFails(db.ref('jisu').once('value'));
});

test('작업자(피치): 공지는 읽기만', async () => {
  const db = pitch();
  await assertSucceeds(db.ref('jisu/v2/_notice/jisu-commands-v1').once('value'));
  await assertFails(db.ref('jisu/v2/_notice/jisu-commands-v1').set(item([])));
});

test('작업자(피치): 자기 구역이 섞인 다중 경로 쓰기는 통째로 거부', async () => {
  const db = pitch();
  await assertSucceeds(db.ref('jisu/v2').update({ 'pitch/jisu-commands-v1': item([]), 'pitch/jisu-memos-v1': item([]) }));
  await assertFails(db.ref('jisu/v2').update({ 'pitch/jisu-commands-v1': item([]), 'outbound/jisu-commands-v1': item([]) }));
});

test('작업자(피치): 전환 설정은 읽기만', async () => {
  const db = pitch();
  await assertSucceeds(db.ref('jisu/config/syncMode').once('value'));
  await assertFails(db.ref('jisu/config/syncMode').set('state'));
});

test('작업자(피치): 사진은 자기 구역만', async () => {
  const db = pitch();
  await assertSucceeds(db.ref('jisu/photos/pitch').once('value'));
  await assertSucceeds(db.ref('jisu/photos/pitch/ph9').set({ id: 'ph9', data: 'x', ts: 2 }));
  await assertSucceeds(db.ref('jisu/photos').update({ 'pitch/ph1': null }));   // 화면의 사진 삭제와 같은 형태
  await assertFails(db.ref('jisu/photos/outbound').once('value'));
  await assertFails(db.ref('jisu/photos').once('value'));
  await assertFails(db.ref('jisu/photos/outbound/ph9').set({ id: 'ph9', data: 'x', ts: 2 }));
});

test('작업자(피치): 알림 구독은 자기 구역으로만 저장, 목록 읽기 불가', async () => {
  const db = pitch();
  await assertSucceeds(db.ref('jisu/push_subs/sub_new').set({ zone: 'pitch', sub: { endpoint: 'x' } }));
  await assertFails(db.ref('jisu/push_subs/sub_bad').set({ zone: 'outbound', sub: { endpoint: 'x' } }));
  await assertFails(db.ref('jisu/push_subs/sub_all').set({ zone: '*', sub: { endpoint: 'x' } }));
  await assertFails(db.ref('jisu/push_subs/sub_o').set(null));
  await assertFails(db.ref('jisu/push_subs').once('value'));
});

test('승인 전·권한 없는 계정: 설정 읽기 외에는 모두 불가', async () => {
  for (const db of [pending(), noClaims()]) {
    await assertSucceeds(db.ref('jisu/config/syncMode').once('value'));
    await assertFails(db.ref('jisu/v2/pitch/jisu-commands-v1').once('value'));
    await assertFails(db.ref('jisu/v2/_notice/jisu-commands-v1').once('value'));
    await assertFails(db.ref('jisu/photos/pitch').once('value'));
    await assertFails(db.ref('jisu/push_subs/sub_x').set({ zone: 'pitch', sub: { endpoint: 'x' } }));
    await assertFails(db.ref('jisu/state').once('value'));
  }
});

test('로그인하지 않은 접속: 모두 불가', async () => {
  const db = anon();
  await assertFails(db.ref('jisu/config/syncMode').once('value'));
  await assertFails(db.ref('jisu/state/jisu-commands-v1').once('value'));
  await assertFails(db.ref('jisu/state/jisu-commands-v1').set(item([])));
  await assertFails(db.ref('jisu/photos').once('value'));
  await assertFails(db.ref('jisu/push_subs/k').set({ zone: '*' }));
});
