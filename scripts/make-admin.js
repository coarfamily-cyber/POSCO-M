// 관리자 계정을 한 번 만듭니다. 비밀번호는 환경변수로만 받습니다 (명령줄 기록에 남지 않게).
// 사용: FIREBASE_SERVICE_ACCOUNT_JSON="$(cat 키.json)" ADMIN_ID=admin ADMIN_NAME=관리자 ADMIN_PW=... node scripts/make-admin.js
const { createUser, lookupByEmail, setAccount } = require('../lib/jisu-auth');
(async () => {
  const id = (process.env.ADMIN_ID || '').trim().toLowerCase();
  const name = (process.env.ADMIN_NAME || '관리자').trim();
  const pw = process.env.ADMIN_PW || '';
  if (!/^[0-9a-z]{2,20}$/.test(id) || pw.length < 6) {
    console.error('ADMIN_ID(영문/숫자 2~20자)와 ADMIN_PW(6자 이상)를 설정하세요.'); process.exit(1);
  }
  const email = id + '@jisu.local';
  const exists = await lookupByEmail(email);
  if (exists) { console.error('이미 있는 계정입니다. 권한만 갱신합니다.'); await setAccount(exists.localId, { role: 'admin', approved: true }, {}); return console.log('OK admin(updated)'); }
  const { localId } = await createUser({ email, password: pw, displayName: name });
  await setAccount(localId, { role: 'admin', approved: true }, {});
  console.log('OK admin(created)');
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
