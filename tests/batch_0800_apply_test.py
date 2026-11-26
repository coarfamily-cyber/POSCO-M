# 실행: python3 tests/batch_0800_apply_test.py   (네트워크 없음 — 가짜 DB 로 실제 run() 흐름만 확인)
# 2026-11-25 일괄등록 집중 시뮬레이션 회귀: 대시보드에서 일괄등록한 미래 날짜 예약이
# 08시 예약 반영 스크립트로 그 날짜에 정확히 카드가 되는지(톤수·공지·특이사항·오전/오후·파렛트 환산) 확인한다.
import importlib.util
import json
import os
import sys
import unittest
from datetime import timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOTDIR = os.path.dirname(HERE)
sys.path.insert(0, HERE)

SPEC = importlib.util.spec_from_file_location("sched", os.path.join(ROOTDIR, ".github", "scripts", "jisu_apply_schedule.py"))
sched = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sched)
from schedule_mirror_test import FakeDB  # 같은 가짜 DB(운영 접속 없음)


def day(offset):
    d = sched.kst_now() + timedelta(days=offset)
    return sched.kst_today(d), f"{d.month:02d}. {d.day:02d}. 08:00"


def batch_schedule():
    """대시보드 일괄등록(11/26~11/28 입고 + 배차 + 공지 + 특이사항)이 저장했을 모양."""
    d1, _ = day(1)
    d2, _ = day(2)
    d3, _ = day(3)
    return [
        {"id": "b1", "date": d1, "target": "inbound", "kind": "instruction", "text": "사각박스 640 EA", "created": "11. 25. 20:00"},
        {"id": "b2", "date": d1, "target": "outbound", "kind": "instruction", "text": "12가3456 660 KG / 20 P", "tonText": "1대 · 13.2 TON"},
        {"id": "b3", "date": d1, "target": "inbound", "kind": "memo", "text": "도색 냄새 심함"},
        {"id": "b4", "date": d2, "target": "inbound", "kind": "instruction", "text": "사각박스 640 EA"},
        {"id": "b5", "date": d2, "target": "*", "kind": "notice", "text": "안전점검 있습니다"},
        {"id": "b6", "date": d3, "target": "packaging", "kind": "instruction", "text": "12 EA 오전", "urgent": True},
        {"id": "b7", "date": d3, "target": "packaging", "kind": "instruction", "text": "24 EA 오후"},
    ], d1, d2, d3


class T(unittest.TestCase):
    def setUp(self):
        os.environ.pop("FIREBASE_SERVICE_ACCOUNT_JSON", None)
        sched._AUTH_CACHE.clear()
        self._orig_push = sched.PUSH_API_URL
        sched.PUSH_API_URL = "https://posco-m.vercel.app/api/push"
        self._orig_window = sched.in_0800_window
        sched.in_0800_window = lambda now: True

    def tearDown(self):
        sched.PUSH_API_URL = self._orig_push
        sched.in_0800_window = self._orig_window

    def run_with(self, db, dry=False):
        orig, orig_open = sched._request, sched.urllib.request.urlopen

        def no_network(*a, **k):
            raise AssertionError("테스트에서 실제 네트워크 요청이 나갔습니다")
        sched._request = db.request
        sched.urllib.request.urlopen = no_network
        try:
            self.assertEqual(sched.run(dry=dry), 0)
        finally:
            sched._request, sched.urllib.request.urlopen = orig, orig_open

    def db_with(self, sch, cmds=None, memos=None):
        tree = {"jisu": {"state": {
            "jisu-schedule-v1": {"v": json.dumps(sch, ensure_ascii=False), "t": 1, "by": "x"},
            "jisu-commands-v1": {"v": json.dumps(cmds or [], ensure_ascii=False), "t": 1, "by": "x"},
            "jisu-memos-v1": {"v": json.dumps(memos or [], ensure_ascii=False), "t": 1, "by": "x"},
        }}}
        return FakeDB(tree)

    # ── 1) 08시 그 날짜에만 카드가 되고, 다음 날짜 예약은 그대로 ──────────────
    def test_first_day_only(self):
        sch, d1, d2, d3 = batch_schedule()
        db = self.db_with(sch)
        now = sched.kst_now()
        orig_now = sched.kst_now
        sched.kst_now = lambda: now + timedelta(days=1)
        try:
            self.run_with(db)
        finally:
            sched.kst_now = orig_now
        cmds = json.loads(db.tree["jisu"]["state"]["jisu-commands-v1"]["v"])
        got = [c for c in cmds if str(c.get("id", "")).startswith("sb")]
        self.assertEqual([c["id"] for c in got], ["sb1", "sb2"])
        self.assertTrue(all(c["day"] == d1 for c in got))
        self.assertEqual(got[1].get("tonText"), "1대 · 13.2 TON")
        self.assertFalse(got[0].get("closed"), "오늘 예약은 마감이 아니다")
        memos = json.loads(db.tree["jisu"]["state"]["jisu-memos-v1"]["v"])
        self.assertEqual([(m["id"], m["text"], m["tag"]) for m in memos], [("mb3", "도색 냄새 심함", "issue")])
        sch_after = json.loads(db.tree["jisu"]["state"]["jisu-schedule-v1"]["v"])
        applied = {s["id"]: bool(s.get("applied")) for s in sch_after}
        self.assertEqual(applied, {"b1": True, "b2": True, "b3": True, "b4": False, "b5": False, "b6": False, "b7": False})

    # ── 2) 다음 날 08시 — 공지는 공지로, 나머지 날짜는 아직 ─────────────────
    def test_second_day_notice(self):
        now = sched.kst_now()
        d2 = sched.kst_today(now + timedelta(days=2))
        sch, d1, _d2, d3 = batch_schedule()
        # 첫날 예약은 이미 반영된 상태로 시작
        for s in sch[:3]:
            s["applied"] = True
        db = self.db_with(sch)
        orig_now = sched.kst_now
        sched.kst_now = lambda: now + timedelta(days=2)
        try:
            self.run_with(db)
        finally:
            sched.kst_now = orig_now
        cmds = json.loads(db.tree["jisu"]["state"]["jisu-commands-v1"]["v"])
        got = [c for c in cmds if c.get("id") in ("sb4", "sb5")]
        self.assertEqual(len(got), 2)
        notice = [c for c in got if c["id"] == "sb5"][0]
        self.assertEqual((notice["kind"], notice["target"]), ("notice", "*"))
        self.assertTrue(all(c["day"] == d2 for c in got))
        sch_after = json.loads(db.tree["jisu"]["state"]["jisu-schedule-v1"]["v"])
        self.assertEqual([s["id"] for s in sch_after if not s.get("applied")], ["b6", "b7"])

    # ── 3) 셋째 날 — 오전/오후 두 카드, 긴급 표시 유지, 사진·톤수 없음 ─────────
    def test_third_day_ampm(self):
        now = sched.kst_now()
        sch, d1, d2, d3 = batch_schedule()
        for s in sch[:5]:
            s["applied"] = True
        # 한 카드 안에 오전·오후가 함께 적힌 경우(예전 저장분·직접 등록) → 08시에 두 카드로 나뉜다
        sch[5] = {"id": "b6", "date": d3, "target": "packaging", "kind": "instruction",
                  "text": "오전 12 EA 오후 24 EA", "urgent": True}
        sch = sch[:6]
        db = self.db_with(sch)
        orig_now = sched.kst_now
        sched.kst_now = lambda: now + timedelta(days=3)
        try:
            self.run_with(db)
        finally:
            sched.kst_now = orig_now
        cmds = json.loads(db.tree["jisu"]["state"]["jisu-commands-v1"]["v"])
        got = [c for c in cmds if str(c.get("id", "")).startswith("sb6")]
        self.assertEqual([c["id"] for c in got], ["sb6", "sb6-1"], "오전/오후는 두 카드로")
        self.assertEqual([c["text"] for c in got], ["오전 12 EA", "오후 24 EA"])
        self.assertTrue(got[0].get("urgent"))

    # ── 3-1) 공백 없는 오전/오후 — "오전 HH 54 TON, 오후HH 36 TON" 도 두 카드 (2026-11-27) ──
    def test_third_day_ampm_no_space(self):
        now = sched.kst_now()
        sch, _d1, _d2, d3 = batch_schedule()
        for s in sch[:5]:
            s["applied"] = True
        sch[5] = {"id": "b6", "date": d3, "target": "inbound", "kind": "instruction",
                  "text": "오전 HH 54 TON, 오후HH 36 TON"}
        sch = sch[:6]
        db = self.db_with(sch)
        orig_now = sched.kst_now
        sched.kst_now = lambda: now + timedelta(days=3)
        try:
            self.run_with(db)
        finally:
            sched.kst_now = orig_now
        cmds = json.loads(db.tree["jisu"]["state"]["jisu-commands-v1"]["v"])
        got = [c for c in cmds if str(c.get("id", "")).startswith("sb6")]
        self.assertEqual([c["id"] for c in got], ["sb6", "sb6-1"], "한 카드로 남으면 안 된다")
        self.assertEqual([c["text"] for c in got], ["오전 HH 54 TON", "오후 HH 36 TON"])

    # ── 4) 파렛트 환산·오전/오후 나누기가 이미 된 글자를 또 바꾸지 않는다 ────
    def test_pallet_and_ampm_idempotent(self):
        sch = [{"id": "p1", "date": day(0)[0], "target": "inbound", "kind": "instruction", "text": "16 KG 파렛트 576 EA"}]
        cmds, memos = [], []
        added, marked, _ = sched.apply_schedules(sch, cmds, day(0)[0], "11. 25. 08:00", memos)
        self.assertEqual((added, marked), (1, 1))
        self.assertEqual(cmds[0]["text"], "16 KG 파렛트 2대")
        again, _mk, _ = sched.apply_schedules(sch, cmds, day(0)[0], "11. 25. 08:00", memos)
        self.assertEqual(again, 0, "두 번 돌려도 카드가 늘지 않는다")
        self.assertEqual(len(cmds), 1)
        self.assertEqual(len(memos), 0)

    # ── 5) 미래 예약은 08시에 손대지 않는다 (날짜 비교 경계) ────────────────
    def test_future_untouched(self):
        sch, d1, d2, d3 = batch_schedule()
        cmds, memos = [], []
        added, marked, _ = sched.apply_schedules(sch, cmds, d1, "11. 25. 08:00", memos)
        self.assertEqual((added, marked), (2, 3))
        self.assertTrue(all(not s.get("applied") for s in sch[3:]))
        added2, _m2, _ = sched.apply_schedules(sch, cmds, d1, "11. 25. 08:00", memos)
        self.assertEqual(added2, 0, "같은 실행을 반복해도 카드가 늘지 않는다")


if __name__ == "__main__":
    unittest.main(verbosity=1)
