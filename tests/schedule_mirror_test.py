# 실행: python3 tests/schedule_mirror_test.py   (네트워크 없음: _request 를 가짜 DB로 바꿔 실제 run() 흐름 확인)
import hashlib
import importlib.util
import io
import json
import urllib.error
import os
import subprocess
import sys
import unittest
from datetime import timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOTDIR = os.path.dirname(HERE)
SPEC = importlib.util.spec_from_file_location("sched", os.path.join(ROOTDIR, ".github", "scripts", "jisu_apply_schedule.py"))
sched = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sched)


class FakeDB:
    def __init__(self, tree, interfere=None):
        self.tree = tree
        self.calls = []
        self.posts = []              # 알림 요청(ntfy·Web Push)의 URL·본문
        self.etag = 1
        self.interfere = interfere   # (경로, 함수): 그 경로에 처음 PUT 할 때 다른 기기가 먼저 저장한 것처럼 바꿈

    def tag(self, path):
        return hashlib.sha1(json.dumps(self.get(path), sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def _path(self, url):
        p = url.split(".firebasedatabase.app/", 1)[1].split("?", 1)[0]
        return p[:-5] if p.endswith(".json") else p

    def get(self, path):
        cur = self.tree
        for k in [x for x in path.split("/") if x]:
            if not isinstance(cur, dict) or k not in cur:
                return None
            cur = cur[k]
        return cur

    def set(self, path, value):
        ks = [x for x in path.split("/") if x]
        if value is None:   # 실제 RTDB처럼: 삭제할 때 빈 상위 칸을 만들지 않음
            cur = self.tree
            for k in ks[:-1]:
                if not isinstance(cur, dict) or k not in cur:
                    return
                cur = cur[k]
            cur.pop(ks[-1], None)
            return
        cur = self.tree
        for k in ks[:-1]:
            cur = cur.setdefault(k, {})
        cur[ks[-1]] = value

    def request(self, url, method="GET", body=None, headers=None):
        self.calls.append((method, url))
        if "ntfy.sh" in url or "/api/push" in url:   # 알림(ntfy·Web Push)은 DB가 아니다
            try:
                self.posts.append((url, json.loads(body.decode("utf-8"))))
            except Exception:
                self.posts.append((url, None))
            return 200, {}, "{}"
        path = self._path(url)
        if method == "GET":
            return 200, {"ETag": self.tag(path)}, json.dumps(self.get(path))
        if method == "PUT":
            if self.interfere and self.interfere[0] == path:
                fn = self.interfere[1]
                self.interfere = None
                fn(self)
            im = (headers or {}).get("if-match")
            if im and im != self.tag(path):
                raise urllib.error.HTTPError(url, 412, "Precondition Failed", {}, io.BytesIO(b'{"error":"etag"}'))
            self.set(path, json.loads(body.decode("utf-8")))
            self.etag += 1
            return 200, {}, "{}"
        if method == "PATCH":
            for k, v in json.loads(body.decode("utf-8")).items():
                self.set((path + "/" + k) if path else k, v)
            return 200, {}, "{}"
        raise AssertionError("unexpected " + method)


def make_db(zones_rev=None, interfere=None):
    today = sched.kst_today()
    sch = [{"id": "100", "date": today, "target": "pitch", "kind": "instruction", "text": "피치 예약 작업"},
           {"id": "101", "date": today, "target": "2", "kind": "instruction", "text": "2동 예약 작업"},
           {"id": "102", "date": today, "target": "*", "kind": "notice", "text": "예약 공지"}]
    cmds = [{"id": "a1", "target": "outbound", "kind": "instruction", "text": "기존", "day": today}]
    tree = {"jisu": {"state": {
        "jisu-schedule-v1": {"v": json.dumps(sch, ensure_ascii=False), "t": 1, "by": "x"},
        "jisu-commands-v1": {"v": json.dumps(cmds, ensure_ascii=False), "t": 1, "by": "x"}}}}
    if zones_rev is not None:
        tree["jisu"]["zonesRev"] = zones_rev
    return FakeDB(tree, interfere)


def day_str(offset_days=0, hm="00:10"):
    """(YYYY-MM-DD, 'MM. DD. HH:MM') — 대시보드 표기 completedAt 만들 때 쓴다."""
    d = sched.kst_now() + timedelta(days=offset_days)
    return sched.kst_today(d), f"{d.month:02d}. {d.day:02d}. {hm}"


def make_full_db(sch=None, cmds=None, inbound=None, interfere=None):
    """08시 마감·입고 초기화·Web Push 까지 한 번에 도는 DB."""
    today = sched.kst_today()
    yesterday, y_at = day_str(-1)
    _t, t_at = day_str(0, "23:59")
    if sch is None:
        sch = [{"id": "200", "date": today, "target": "pitch", "kind": "instruction", "text": "오전 피치 100 TON, 오후 출고 2대"}]
    if cmds is None:
        cmds = [
            {"id": "a1", "target": "outbound", "kind": "instruction", "text": "기존", "day": today},
            # 어제 00:10 완료 → 08시 마감 대상
            {"id": "c_old", "target": "pitch", "kind": "instruction", "text": "어제 완료", "day": yesterday,
             "completed": True, "completedAt": y_at},
            # 오늘 23:59 완료 → 마감 대상 아님
            {"id": "c_now", "target": "outbound", "kind": "instruction", "text": "오늘 늦게 완료", "day": today,
             "completed": True, "completedAt": t_at},
            # 데모 카드는 건드리지 않는다
            {"id": "demo_dispatch_1", "target": "*", "kind": "instruction", "text": "데모", "completed": True},
        ]
    if inbound is None:
        inbound = {
            today: {"day": today, "rows": [{"rid": "r1", "item": "SH", "qty": 3}],
                    "archivedRows": [{"rid": "r0", "item": "HH", "qty": 1}], "workState": "work", "shiftKey": "D"},
            yesterday: {"day": yesterday, "rows": [{"rid": "r9", "item": "SH", "qty": 7}],
                        "archivedRows": [], "workState": "idle", "shiftKey": "D"},
        }
    tree = {"jisu": {"state": {
        "jisu-schedule-v1": {"v": json.dumps(sch, ensure_ascii=False), "t": 1, "by": "x"},
        "jisu-commands-v1": {"v": json.dumps(cmds, ensure_ascii=False), "t": 1, "by": "x"},
        "jisu-inbound-records-v1": {"v": json.dumps(inbound, ensure_ascii=False), "t": 1, "by": "x"}}}}
    return FakeDB(tree, interfere)


def state_cmds(db):
    return json.loads(db.tree["jisu"]["state"]["jisu-commands-v1"]["v"])


def state_inbound(db):
    return json.loads(db.tree["jisu"]["state"]["jisu-inbound-records-v1"]["v"])


def _no_network(*a, **k):
    raise AssertionError("테스트에서 실제 네트워크 요청이 나갔습니다 — _request 를 가짜로 바꿔야 합니다")


class T(unittest.TestCase):
    def setUp(self):
        os.environ.pop("FIREBASE_SERVICE_ACCOUNT_JSON", None)
        os.environ.pop("JISU_ZONE_MIRROR", None)
        os.environ.pop("JISU_PUSH_API_URL", None)
        os.environ.pop("JISU_PUSH_AUTH_TOKEN", None)
        sched._AUTH_CACHE.clear()
        self._orig_push_url = sched.PUSH_API_URL
        sched.PUSH_API_URL = "https://posco-m.vercel.app/api/push"
        # 실행 시각과 무관하게 08시 마감·초기화·알림을 검사한다 (시간대 동작은 따로 테스트)
        self._orig_window = sched.in_0800_window
        sched.in_0800_window = lambda now: True

    def tearDown(self):
        sched.PUSH_API_URL = self._orig_push_url
        sched.in_0800_window = self._orig_window

    def run_with(self, db, dry=False):
        orig, orig_open = sched._request, sched.urllib.request.urlopen
        sched._request = db.request
        sched.urllib.request.urlopen = _no_network   # 실수로라도 실제 인터넷(운영 DB·푸시)으로 나가지 않게
        try:
            self.assertEqual(sched.run(dry=dry), 0)
        finally:
            sched._request, sched.urllib.request.urlopen = orig, orig_open

    def test_flow_and_mirror(self):
        db = make_db()
        self.run_with(db)
        methods = [m for m, u in db.calls if "ntfy" not in u and "/api/push" not in u]
        self.assertEqual(methods[:2], ["GET", "GET"])
        self.assertIn("PUT", methods)
        puts = [i for i, m in enumerate(methods) if m == "PUT"]
        self.assertIn("PATCH", methods, "구역 복사")
        self.assertGreater(methods.index("PATCH"), puts[-1], "구역 복사는 카드·예약 저장 성공 뒤")
        j = db.tree["jisu"]
        cmd_t = j["state"]["jisu-commands-v1"]["t"]
        self.assertEqual(j["zonesRev"], cmd_t)
        self.assertIn("s100", j["zones"]["pitch"]["commands"])
        self.assertIn("a1", j["zones"]["outbound"]["commands"])
        self.assertIn("s101", j["zones"]["_admin"]["commands"], "2동 예약은 _admin 칸")
        self.assertIn("s102", j["notices"])
        self.assertNotIn("production-a", j.get("zones", {}))

    def test_no_auth_urls_unchanged(self):
        db = make_db()
        self.run_with(db)
        self.assertFalse(any("access_token" in u for _, u in db.calls))

    def test_bad_secret_falls_back_without_crash(self):
        os.environ["FIREBASE_SERVICE_ACCOUNT_JSON"] = "{not json"
        db = make_db()
        self.run_with(db)
        self.assertFalse(any("access_token" in u for _, u in db.calls))
        ids = [x["id"] for x in json.loads(db.tree["jisu"]["state"]["jisu-commands-v1"]["v"])]
        self.assertIn("s100", ids, "비밀값이 잘못돼도 예약 반영은 정상 진행")

    def test_newer_copy_not_overwritten(self):
        db = make_db(zones_rev=9_000_000_000_000_000)
        self.run_with(db)
        self.assertNotIn("zones", db.tree["jisu"])
        self.assertNotIn("PATCH", [m for m, _ in db.calls])

    def test_mirror_off_by_env(self):
        os.environ["JISU_ZONE_MIRROR"] = "0"
        db = make_db()
        self.run_with(db)
        self.assertNotIn("PATCH", [m for m, _ in db.calls])

    # ---------------- 통합본 추가 기능: 08시 마감 · 입고 초기화 · Web Push ----------------
    def test_0800_close_cleanup_and_push(self):
        db = make_full_db()
        self.run_with(db)
        cmds = {x["id"]: x for x in state_cmds(db)}
        self.assertTrue(cmds["c_old"].get("closed"), "08:00 이전 완료 → closed")
        self.assertNotIn("closed", cmds["c_now"], "08:00 이후 완료는 그대로")
        self.assertNotIn("closed", cmds["demo_dispatch_1"], "데모 카드는 건드리지 않음")

        today, yesterday = sched.kst_today(), day_str(-1)[0]
        inb = state_inbound(db)
        self.assertEqual(inb[today]["rows"], [], "입고 입력칸 비움")
        self.assertEqual([r["rid"] for r in inb[today]["archivedRows"]], ["r0", "r1"], "기존 보관분 뒤로 이어 붙임")
        self.assertEqual(inb[today]["workState"], "idle")
        self.assertEqual(inb[today]["shiftKey"], today + "-am")
        self.assertEqual(inb[yesterday]["rows"], [], "다른 날짜 입력칸도 비움")
        self.assertEqual([r["rid"] for r in inb[yesterday]["archivedRows"]], ["r9"], "비운 값은 보관")

        push = [p for u, p in db.posts if "/api/push" in u and isinstance(p, dict) and "zone" in p]
        self.assertTrue(push, "Web Push 발송")
        self.assertIn("08시 새 작업지시", push[0]["title"])
        zones = {p["zone"] for p in push}
        self.assertTrue({"master", "pitch"} <= zones, zones)
        self.assertTrue(any("ntfy.sh" in u for u, _ in db.posts), "새 카드 ntfy 알림")

    def test_am_pm_split_makes_two_cards(self):
        db = make_full_db(inbound={})
        self.run_with(db)
        cards = [x for x in state_cmds(db) if x["id"].startswith("s200")]
        self.assertEqual([c["id"] for c in cards], ["s200", "s200-1"])
        self.assertEqual(cards[0]["text"], "오전 피치 100 TON")
        self.assertEqual(cards[1]["text"], "오후 출고 2대")
        self.assertEqual(cards[0]["at"], cards[1]["at"], "같은 시각으로 등록")

    def test_am_pm_split_not_for_notice_and_time_only(self):
        self.assertEqual(sched.split_am_pm("오전 10시~ 오후 2시~"), ["오전 10시~ 오후 2시~"])
        self.assertEqual(sched.split_am_pm("오전 공지 오후 공지", "notice"), ["오전 공지 오후 공지"])
        self.assertEqual(sched.split_am_pm("출고 오전에 하지마"), ["출고 오전에 하지마"])

    def test_pallet_normalized_on_apply(self):
        today = sched.kst_today()
        sch = [{"id": "300", "date": today, "target": "inbound", "kind": "instruction",
                "text": "16 KG 파렛트 576 EA"},
               {"id": "301", "date": today, "target": "inbound:16kg 파렛트", "kind": "instruction",
                "text": "432 EA"},
               {"id": "302", "date": today, "target": "inbound", "kind": "instruction",
                "text": "알루미늄 파우치백 600 EA"}]
        db = make_full_db(sch=sch, inbound={})
        self.run_with(db)
        text = {x["id"]: x["text"] for x in state_cmds(db)}
        self.assertEqual(text["s300"], "16 KG 파렛트 2대")
        self.assertEqual(text["s301"], "1.5대")
        self.assertEqual(text["s302"], "알루미늄 파우치백 600 EA", "파렛트 품목이 아니면 그대로")

    def test_split_matches_index_html(self):
        samples = [["오전 피치 100 TON, 오후 출고 2대", None],
                   ["오전 10시~ 피치, 오후 2시~ 출고", None],
                   ["[피치] 오전 4PLT · 오후 2PLT", None],
                   ["오전 공지 오후 공지", "notice"],
                   ["출고 오전에 하지마", None],
                   ["오전 10시~ 오후 2시~", None],
                   ["오전에 피치 오후에 출고", None]]
        js_code = r"""
const fs=require('fs'); const html=fs.readFileSync(process.argv[1],'utf8');
const b=html.indexOf('window.jisuAmPmSplitText');
const e=html.indexOf('window.jisuExpandAmPmItems');
if(b<0||e<0) throw new Error('am/pm block not found');
const fn=new Function('window', html.slice(b,e)+'\nreturn window.jisuAmPmSplitText;');
const f=fn({});
process.stdout.write(JSON.stringify(JSON.parse(process.argv[2]).map(s=>f(s[0], s[1]||null))));
"""
        out = subprocess.run(["node", "-e", js_code, os.path.join(ROOTDIR, "JISU", "index.html"),
                              json.dumps(samples, ensure_ascii=False)],
                             capture_output=True, text=True, check=True).stdout
        py = [sched.split_am_pm(t, k) for t, k in samples]
        self.assertEqual(py, json.loads(out))

    def test_idle_run_writes_nothing(self):
        today = sched.kst_today()
        sch = [{"id": "400", "date": today, "target": "pitch", "kind": "instruction",
                "text": "이미 반영", "applied": True, "appliedAt": "11. 22. 08:00"}]
        cmds = [{"id": "a1", "target": "outbound", "kind": "instruction", "text": "기존", "day": today}]
        db = make_full_db(sch=sch, cmds=cmds, inbound={})
        self.run_with(db)
        self.assertNotIn("PUT", [m for m, _ in db.calls], "바뀐 것이 없으면 쓰지 않음")
        self.assertNotIn("PATCH", [m for m, _ in db.calls])
        push = [p for u, p in db.posts if "/api/push" in u and isinstance(p, dict) and "zone" in p]
        self.assertTrue(push, "대기 안내는 보냄")
        self.assertEqual(push[0]["title"], "⏰ 08시 작업지시 1건 대기", "새 카드가 없으면 대기 안내")

    def test_0800_window_hours(self):
        mk = lambda h: sched.kst_now().replace(hour=h, minute=0)
        win = self._orig_window       # setUp 의 고정(항상 true) 대신 실제 시간대 판단
        for h in (6, 8, 9):
            self.assertTrue(win(mk(h)), h)
        for h in (0, 5, 10, 12, 23):
            self.assertFalse(win(mk(h)), h)

    def test_outside_window_applies_but_keeps_inputs(self):
        sched.in_0800_window = lambda now: False    # GitHub cron 이 몇 시간 늦게 도는 경우
        db = make_full_db()
        self.run_with(db)
        self.assertIn("s200", [x["id"] for x in state_cmds(db)], "예약 반영은 그대로")
        inb = state_inbound(db)
        today = sched.kst_today()
        self.assertTrue(inb[today]["rows"], "낮에 도는 백업 실행은 입고 입력칸을 비우지 않음")
        self.assertNotEqual(inb[today]["shiftKey"], today + "-am")
        summary = [p for u, p in db.posts if "/api/push" in u and isinstance(p, dict) and "zone" in p]
        self.assertEqual(summary, [], "늦은 요약 알림은 보내지 않음")
        self.assertTrue(any("ntfy.sh" in u for u, _ in db.posts), "새 카드 알림은 그대로")

    def test_dry_run_reads_only(self):
        db = make_full_db()
        before = json.dumps(db.tree, sort_keys=True, ensure_ascii=False)
        self.run_with(db, dry=True)
        self.assertNotIn("PUT", [m for m, _ in db.calls])
        self.assertNotIn("PATCH", [m for m, _ in db.calls])
        self.assertEqual(db.posts, [], "dry-run 은 알림도 보내지 않음")
        self.assertEqual(json.dumps(db.tree, sort_keys=True, ensure_ascii=False), before)

    def test_conflict_412_retries_and_keeps_other_device_change(self):
        def other_device(fdb):
            cur = json.loads(fdb.tree["jisu"]["state"]["jisu-commands-v1"]["v"])
            cur.append({"id": "dev1", "target": "pitch", "kind": "instruction", "text": "다른 기기"})
            fdb.tree["jisu"]["state"]["jisu-commands-v1"] = {
                "v": json.dumps(cur, ensure_ascii=False), "t": 2, "by": "dev"}
        db = make_db(interfere=("jisu/state/jisu-commands-v1", other_device))
        self.run_with(db)
        ids = [x["id"] for x in state_cmds(db)]
        self.assertIn("dev1", ids, "다른 기기 저장 보존")
        self.assertIn("s100", ids)
        self.assertEqual(len(ids), len(set(ids)), "중복 없음")
        self.assertEqual(ids.count("s100"), 1)

    def test_same_result_as_index_html(self):
        sample = [
            {"id": "a1", "target": "outbound", "kind": "instruction", "text": "A"},
            {"id": "a2", "target": "outbound:2", "kind": "instruction", "text": "B"},
            {"id": "d1", "target": "1", "kind": "instruction", "text": "1동"},
            {"id": "h1", "target": "", "kind": "instruction", "text": "대상 없음"},
            {"id": "n1", "target": "*", "kind": "notice", "text": "공지"},
            {"id": "n2", "target": "pitch", "kind": "notice", "text": "구역 공지"},
            {"id": "bad.id", "target": "pitch", "text": "X"},
            {"id": 5, "target": "pitch", "text": "숫자 id"},
        ]
        py = sched.mirror_updates(sample, 7)
        js_code = r"""
const fs=require('fs'); const html=fs.readFileSync(process.argv[1],'utf8');
const b=html.indexOf('/* ZONE-MIRROR-BEGIN'), e=html.indexOf('/* ZONE-MIRROR-END */');
const block=html.slice(b, e+'/* ZONE-MIRROR-END */'.length);
let captured=null;
const db={ref(p){return {once(){return Promise.resolve({val:()=>null});}, update(o){captured=o;return Promise.resolve();}};}};
const fn=new Function('db','window','ROOT','lastRemote','baseRev','console',block+'\nreturn mirrorZones;');
const mz=fn(db,{JISU_ZONE_MIRROR:true},'jisu',{},{},{warn(){}});
mz('jisu-commands-v1', process.argv[2], 7);
setTimeout(()=>process.stdout.write(JSON.stringify(captured)),20);
"""
        out = subprocess.run(["node", "-e", js_code, os.path.join(ROOTDIR, "JISU", "index.html"), json.dumps(sample, ensure_ascii=False)],
                             capture_output=True, text=True, check=True).stdout
        js = json.loads(out)
        self.assertEqual(json.dumps(py, sort_keys=True, ensure_ascii=False), json.dumps(js, sort_keys=True, ensure_ascii=False))


def make_v2_db(interfere=None, pitch_extra=None, inbound=None):
    today = sched.kst_today()
    sch = [{"id": "100", "date": today, "target": "pitch", "kind": "instruction", "text": "피치 예약 작업"},
           {"id": "101", "date": today, "target": "2", "kind": "instruction", "text": "2동 예약 작업"},
           {"id": "102", "date": today, "target": "*", "kind": "notice", "text": "예약 공지"},
           {"id": "103", "date": "2999-01-01", "target": "pitch", "kind": "instruction", "text": "먼 미래 예약"}]
    v2 = {pt: {"jisu-commands-v1": {"v": "[]", "t": 1, "by": "m"}} for pt in sched.V2_PARTS}
    v2["outbound"]["jisu-commands-v1"]["v"] = json.dumps([{"id": "a1", "target": "outbound", "kind": "instruction", "text": "기존", "day": today}], ensure_ascii=False)
    if pitch_extra:
        v2["pitch"]["jisu-commands-v1"]["v"] = json.dumps(pitch_extra, ensure_ascii=False)
    v2["_admin"]["jisu-schedule-v1"] = {"v": json.dumps(sch, ensure_ascii=False), "t": 1, "by": "m"}
    state_cmds = {"v": "[]", "t": 1, "by": "frozen", "mode": "v2"}
    tree = {"jisu": {"config": {"syncMode": "v2"}, "v2": v2, "state": {"jisu-commands-v1": state_cmds}}}
    if inbound is not None:
        v2["inbound"]["jisu-inbound-records-v1"] = {"v": json.dumps(inbound, ensure_ascii=False), "t": 1, "by": "m"}
    return FakeDB(tree, interfere)


class V2(unittest.TestCase):
    def setUp(self):
        os.environ.pop("FIREBASE_SERVICE_ACCOUNT_JSON", None)
        os.environ.pop("JISU_ZONE_MIRROR", None)
        os.environ.pop("JISU_PUSH_API_URL", None)
        os.environ.pop("JISU_PUSH_AUTH_TOKEN", None)
        sched._AUTH_CACHE.clear()
        self._orig_push_url = sched.PUSH_API_URL
        sched.PUSH_API_URL = "https://posco-m.vercel.app/api/push"
        self._orig_window = sched.in_0800_window
        sched.in_0800_window = lambda now: True

    def tearDown(self):
        sched.PUSH_API_URL = self._orig_push_url
        sched.in_0800_window = self._orig_window

    def run_with(self, db, dry=False):
        orig, orig_open = sched._request, sched.urllib.request.urlopen
        sched._request = db.request
        sched.urllib.request.urlopen = _no_network   # 실수로라도 실제 인터넷(운영 DB·푸시)으로 나가지 않게
        try:
            self.assertEqual(sched.run(dry=dry), 0)
        finally:
            sched._request, sched.urllib.request.urlopen = orig, orig_open

    def part(self, db, pt, key="jisu-commands-v1"):
        return json.loads(db.tree["jisu"]["v2"][pt][key]["v"])

    def test_v2_cards_go_to_their_parts(self):
        db = make_v2_db()
        self.run_with(db)
        self.assertEqual([x["id"] for x in self.part(db, "pitch")], ["s100"])
        self.assertEqual([x["id"] for x in self.part(db, "_admin")], ["s101"])
        self.assertEqual([x["id"] for x in self.part(db, "_notice")], ["s102"])
        self.assertEqual([x["id"] for x in self.part(db, "outbound")], ["a1"], "다른 묶음은 그대로")
        sch = self.part(db, "_admin", "jisu-schedule-v1")
        self.assertEqual([s.get("applied", False) for s in sch], [True, True, True, False])

    def test_v2_does_not_touch_state_or_mirror(self):
        db = make_v2_db()
        self.run_with(db)
        self.assertEqual(db.tree["jisu"]["state"]["jisu-commands-v1"]["v"], "[]")
        self.assertNotIn("PATCH", [m for m, _ in db.calls])
        self.assertNotIn("zones", db.tree["jisu"])

    def test_v2_writes_only_changed_parts(self):
        db = make_v2_db()
        self.run_with(db)
        puts = sorted(u.split(".firebasedatabase.app/")[1].split(".json")[0] for m, u in db.calls if m == "PUT")
        self.assertEqual(puts, ["jisu/v2/_admin/jisu-commands-v1", "jisu/v2/_admin/jisu-schedule-v1",
                                "jisu/v2/_notice/jisu-commands-v1", "jisu/v2/pitch/jisu-commands-v1"])

    def test_v2_conflict_retries_and_keeps_other_device_change(self):
        def other_device(fdb):
            cur = json.loads(fdb.tree["jisu"]["v2"]["pitch"]["jisu-commands-v1"]["v"])
            cur.append({"id": "dev1", "target": "pitch", "kind": "instruction", "text": "다른 기기"})
            fdb.tree["jisu"]["v2"]["pitch"]["jisu-commands-v1"] = {"v": json.dumps(cur, ensure_ascii=False), "t": 2, "by": "dev"}
        db = make_v2_db(interfere=("jisu/v2/pitch/jisu-commands-v1", other_device))
        self.run_with(db)
        ids = [x["id"] for x in self.part(db, "pitch")]
        self.assertIn("dev1", ids)
        self.assertIn("s100", ids)
        self.assertEqual(len(ids), len(set(ids)), "중복 없음")
        self.assertEqual(len([i for x in sched.V2_PARTS for i in [y["id"] for y in self.part(db, x)] if i == "s101"]), 1)

    def test_v2_second_run_is_noop(self):
        db = make_v2_db()
        self.run_with(db)
        n = len(db.calls)
        self.run_with(db)
        self.assertNotIn("PUT", [m for m, _ in db.calls[n:]])

    def test_v2_closes_completed_in_its_part(self):
        yesterday, y_at = day_str(-1)
        _, t_at = day_str(0, "23:59")
        pitch_extra = [
            {"id": "c_old", "target": "pitch", "kind": "instruction", "text": "어제 완료",
             "day": yesterday, "completed": True, "completedAt": y_at},
            {"id": "c_now", "target": "pitch", "kind": "instruction", "text": "오늘 늦게 완료",
             "day": sched.kst_today(), "completed": True, "completedAt": t_at},
        ]
        db = make_v2_db(pitch_extra=pitch_extra)
        self.run_with(db)
        cards = {x["id"]: x for x in self.part(db, "pitch")}
        self.assertTrue(cards["c_old"].get("closed"), "08:00 이전 완료 → closed")
        self.assertNotIn("closed", cards["c_now"])
        self.assertIn("s100", cards, "예약 카드도 같은 묶음에")

    def test_v2_cleanup_uses_inbound_bucket(self):
        today = sched.kst_today()
        inb = {today: {"day": today, "rows": [{"rid": "r1", "item": "SH", "qty": 2}],
                       "archivedRows": [], "workState": "work", "shiftKey": "D"}}
        db = make_v2_db(inbound=inb)
        self.run_with(db)
        after = json.loads(db.tree["jisu"]["v2"]["inbound"]["jisu-inbound-records-v1"]["v"])
        self.assertEqual(after[today]["rows"], [])
        self.assertEqual([r["rid"] for r in after[today]["archivedRows"]], ["r1"])
        self.assertEqual(after[today]["shiftKey"], today + "-am")

    def test_bucket_same_as_index_html(self):
        sample = [{"target": "outbound"}, {"target": "outbound:2"}, {"target": "1"}, {"target": ""}, {},
                  {"target": "*"}, {"target": "pitch", "kind": "notice"}, {"target": "warehouse"}, {"target": "production-h"}]
        py = [sched.v2_bucket_of(x) for x in sample]
        js_code = r"""
const fs=require('fs'); const html=fs.readFileSync(process.argv[1],'utf8');
const b=html.indexOf('/* SYNC-V2-BEGIN'), e=html.indexOf('/* SYNC-V2-END */');
const block=html.slice(b, e);
const fn=new Function('lsGet','lsSet','STATE_KEYS','ROOT','db','paint', block+';return v2BucketOf;');
const f=fn(()=>null,()=>{},[],'jisu',null,()=>{});
process.stdout.write(JSON.stringify(JSON.parse(process.argv[2]).map(f)));
"""
        out = subprocess.run(["node", "-e", js_code, os.path.join(ROOTDIR, "JISU", "index.html"), json.dumps(sample)],
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(py, json.loads(out))
        self.assertEqual(sched.V2_PARTS, json.loads(subprocess.run(["node", "-e", r"""
const fs=require('fs'); const html=fs.readFileSync(process.argv[1],'utf8');
const b=html.indexOf('/* SYNC-V2-BEGIN'), e=html.indexOf('/* SYNC-V2-END */');
const fn=new Function('lsGet','lsSet','STATE_KEYS','ROOT','db','paint', html.slice(b,e)+';return V2_PARTS;');
process.stdout.write(JSON.stringify(fn(()=>null,()=>{},[],'jisu',null,()=>{})));
""", os.path.join(ROOTDIR, "JISU", "index.html")], capture_output=True, text=True, check=True).stdout))


if __name__ == "__main__":
    unittest.main(verbosity=1)
