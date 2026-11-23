# 테스트 실행 방법

모든 테스트는 네트워크(운영 Firebase·푸시 서버)에 쓰지도, 알림을 보내지도 않습니다. 필요한 도구는 저장소 밖(또는 `--no-save`)에 설치합니다.

| 무엇 | 명령 |
| --- | --- |
| 서버·블록 단위 테스트 | `node --test tests/*.test.js` |
| 예약 스크립트 | `python3 tests/schedule_mirror_test.py` |
| 화면 통합(지금 방식) | `node tests/integration/run.js JISU/index.html` |
| 화면 통합(v2 여러 기기) | `node tests/integration/v2.js JISU/index.html` |
| 2026-11-23 코드감사 수정 회귀(A-1~A-17·#28145) | `node tests/bugfix-20261123.test.js JISU/index.html` |
| 실제 SDK + 에뮬레이터 종단 간 | `npx firebase emulators:exec --only database,auth --project demo-jisu \"node tests/integration/e2e-emulator.js JISU/index.html\"` |
| 보안 규칙 | `npx firebase emulators:exec --only database --project demo-jisu \"node --test tests/rules/rules.test.js\"` |

준비: `npm i --no-save jsdom@24 fake-indexeddb@6 firebase@10.14.1 firebase-tools@13 @firebase/rules-unit-testing@3` (에뮬레이터는 Java 11 이상 필요)

## 예약 스크립트 테스트가 지키는 범위

- 실행 주체: `.github/scripts/jisu_apply_schedule.py` 한 벌(예약 실행본은 같은 파일의 복사본, SHA256 동일).
- 검사 항목: 오전/오후 분리(index.html 과 교차검증)·파렛트 환산·구역 복사·v2 묶음·08시 완료 마감·입고 입력칸 초기화·Web Push 내용·바뀐 것 없을 때 무쓰기·412 재계산·dry-run 무쓰기·08시 시간대(06:00~09:59 KST) 밖 동작.
- **실제 알림 금지**: `_request` 를 가짜 DB로 바꾸고 `urllib.request.urlopen` 을 막아 둡니다. 실제 푸시 서버(`posco-m.vercel.app/api/push`)로 나가면 수뽕 님 폰에 알림이 가므로, 테스트에서 실발송을 시도하지 마세요(2026-11-22 사고).
