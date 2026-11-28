# 테스트 실행 방법

모든 테스트는 네트워크(운영 Firebase·푸시 서버)에 쓰지도, 알림을 보내지도 않습니다. 필요한 도구는 저장소 밖(또는 `--no-save`)에 설치합니다.

| 무엇 | 명령 |
| --- | --- |
| 서버·블록 단위 테스트 | `node --test tests/*.test.js` |
| 예약 스크립트 | `python3 tests/schedule_mirror_test.py` |
| 화면 통합(지금 방식) | `node tests/integration/run.js JISU/index.html` |
| 화면 통합(v2 여러 기기) | `node tests/integration/v2.js JISU/index.html` |
| 18시 마감 rollover 회귀(#28279 — 부족 완료·판단 대기 유지) | `node tests/integration/rollover-pending-short.js JISU/index.html` |
| 2026-11-23 코드감사 수정 회귀(A-1~A-17·#28145) | `node tests/bugfix-20261123.test.js JISU/index.html` |
| 사이드바 '지수 비서실장' — 지도 위 메탈 말풍선(v2, 스파크 없음)·무료 Flash-Lite·코드 집계·[적용 확인] 전 무쓰기·실제 현장 녹화본 섀도잉 (`tests/fixtures/chief-scene-20261122.json`) · 데스크탑 꼬리 = 왼쪽 위 모서리, 모바일 = 캐릭터 아래 28px 고정·넘치면 높이만 축소 (2026-11-28) | `node --test tests/chief-assistant-20261128.test.js` |
| 오전·오후 공백 없는 표기("오전 HH 54 TON, 오후HH 36 TON") 분리 — 화면·예약·08시 스크립트 공통, 이미 저장된 카드·Firebase 사본까지 두 건 (2026-11-27) | `node --test tests/ampm-nospace-20261127.test.js` |
| 특이사항·새 사진 등록 → 그 구역 버튼 전체 10초 녹색 깜빡임 · 작업중은 투명 유리+회색 점 · 작업지시 저장에는 안 울림 · 범례 회귀 (2026-11-26 2차) | `node tests/flash-dot.test.js JISU/index.html` |
| 일일보고서 엑셀(구역 버튼별 16시트: 작업 내역·구역 특이사항·현장 사진, 입고 중량일지·피치 현황·환경 호기 표) + 일간·주간·월간 다운로드 전 확인 요청(자동 저장 금지) (2026-11-26) | `node tests/daily-report-20261126.test.js JISU/index.html` |
| 주간·월간 실적 보고서 구역별 색을 달력 색상 범례(출고 #FF8A00 · 입고 #0686EF · 포장 #CBD5E1 · 생산 #EC4899 · 환경 #059669 · 피치 #9A5219)와 통일 — 03 달성률·비중, 04 누적 스택, 09 생산 A~H, 10 구역 표, PPT 11장 도형까지 (2026-11-27) | `node tests/perf-zone-colors-20261127.test.js JISU/index.html` |
| 주간·월간 실적 보고서 페이퍼 덱 11시트(표지·하이라이트·물량 추이 점선·구역 달성률·100% 비중·주차 누적 스택·출고/이월 비교·이월 추이·4조 2교대·완료율 균형·생산 A~H·구역 표) + PPT 11장 (2026-11-26) | `node tests/perf-report-full-20261126.test.js JISU/index.html` |
| 구역 버튼 상태 — 일부 완료(st-part)=점만 파란불 · 작업중=투명 유리+회색 점 · 모두 완료=버튼 전체 파란불 · 긴급(st-urgent)=버튼 전체 빨간불 · 특이사항·사진 등록 때만 버튼 전체 10초 깜빡 (2026-11-26) | `node tests/zone-partial-done.test.js JISU/index.html` |
| 지도 '환경' 파란불 기준 = 가장 최근 08:00/18:00(KST) 마감 (07:59·08:00·12:20·17:59·18:00·20:43 경계) (2026-11-26) | `node tests/env-shift-cutoff.test.js JISU/index.html` |
| 날씨 눈·비 교차확인(met.no 맑음 + wttr.in 눈/비 · 오탐 필터 유지) | `node tests/weather-crosscheck.test.js JISU/index.html` |
| ?zone= 없는 구역 → 관리자 화면 · 저장값 자동 복구(로컬·DB 수신) · 생산 작업자 화면 격자 해제 (2026-11-25) | `node tests/zone-and-recovery.test.js JISU/index.html` |
| 일괄등록 집중 시뮬레이션(날짜·구역·톤수·분류·저장·미리보기 체크/구역 변경) 회귀 (2026-11-25) | `node tests/batch-simulation.test.js JISU/index.html` |
| 일괄등록 미래 예약 → 08시 스크립트 반영(톤수·공지·특이사항·오전/오후·파렛트) (2026-11-25) | `python3 tests/batch_0800_apply_test.py` |
| 배차 지시서 일괄등록 — 차종·구간·하차지 제거 후 '차량번호 · 수량 · 시간 · 톤수' 한 줄 (2026-11-25 #29184) | `node tests/dispatch-clean-20261125.test.js JISU/index.html` |
| 실제 SDK + 에뮬레이터 종단 간 | `npx firebase emulators:exec --only database,auth --project demo-jisu \"node tests/integration/e2e-emulator.js JISU/index.html\"` |
| 보안 규칙 | `npx firebase emulators:exec --only database --project demo-jisu \"node --test tests/rules/rules.test.js\"` |

준비: `npm i --no-save jsdom@24 fake-indexeddb@6 firebase@10.14.1 firebase-tools@13 @firebase/rules-unit-testing@3` (에뮬레이터는 Java 11 이상 필요)

## 예약 스크립트 테스트가 지키는 범위

- 실행 주체: `.github/scripts/jisu_apply_schedule.py` 한 벌(예약 실행본은 같은 파일의 복사본, SHA256 동일).
- 검사 항목: 오전/오후 분리(index.html 과 교차검증)·파렛트 환산·구역 복사·v2 묶음·08시 완료 마감·입고 입력칸 초기화·Web Push 내용·바뀐 것 없을 때 무쓰기·412 재계산·dry-run 무쓰기·08시 시간대(06:00~09:59 KST) 밖 동작.
- **실제 알림 금지**: `_request` 를 가짜 DB로 바꾸고 `urllib.request.urlopen` 을 막아 둡니다. 실제 푸시 서버(`posco-m.vercel.app/api/push`)로 나가면 수뽕 님 폰에 알림이 가므로, 테스트에서 실발송을 시도하지 마세요(2026-11-22 사고).
