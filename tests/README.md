# 테스트 실행 방법

모든 테스트는 네트워크(운영 Firebase)에 쓰지 않습니다. 필요한 도구는 저장소 밖(또는 `--no-save`)에 설치합니다.

| 무엇 | 명령 |
| --- | --- |
| 서버·블록 단위 테스트 | `node --test tests/*.test.js` |
| 예약 스크립트 | `python3 tests/schedule_mirror_test.py` |
| 화면 통합(지금 방식) | `node tests/integration/run.js JISU/index.html` |
| 화면 통합(v2 여러 기기) | `node tests/integration/v2.js JISU/index.html` |
| 실제 SDK + 에뮬레이터 종단 간 | `npx firebase emulators:exec --only database,auth --project demo-jisu "node tests/integration/e2e-emulator.js JISU/index.html"` |
| 보안 규칙 | `npx firebase emulators:exec --only database --project demo-jisu "node --test tests/rules/rules.test.js"` |

준비: `npm i --no-save jsdom@24 fake-indexeddb@6 firebase@10.14.1 firebase-tools@13 @firebase/rules-unit-testing@3` (에뮬레이터는 Java 11 이상 필요)
