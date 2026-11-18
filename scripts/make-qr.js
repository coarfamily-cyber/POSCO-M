// 구역별 가입 QR 주소를 출력합니다. 출력된 주소를 QR 코드로 만들어 인쇄하세요.
// 사용: ENROLL_SECRET=... node scripts/make-qr.js [베이스주소]
const { ZONES, makeQr } = require('../lib/jisu-auth');
const secret = process.env.ENROLL_SECRET;
if (!secret) { console.error('ENROLL_SECRET 환경변수가 필요합니다.'); process.exit(1); }
const base = process.argv[2] || 'https://coarfamily-cyber.github.io/POSCO-M/JISU/signup.html';
ZONES.forEach(z => console.log(z + '\t' + base + '?qr=' + makeQr(z, secret)));
