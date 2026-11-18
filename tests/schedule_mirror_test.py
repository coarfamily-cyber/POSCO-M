# 실행: python3 tests/schedule_mirror_test.py   (네트워크 없음: _request 를 가짜 DB로 바꿔 실제 run() 흐름 확인)
import importlib.util
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOTDIR = os.path.dirname(HERE)
SPEC = importlib.util.spec_from_file_location("sched", os.path.join(ROOTDIR, ".github", "scripts", "jisu_apply_schedule.py"))
sched = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sched)


class FakeDB:
    def __init__(self, tree):
        self.tree = tree
        self.calls = []
        self.etag = 1

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
        if "ntfy.sh" in url:
            return 200, {}, "{}"
        path = self._path(url)
        if method == "GET":
            return 200, {"ETag": str(self.etag)}, json.dumps(self.get(path))
        if method == "PUT":
            self.set(path, json.loads(body.decode("utf-8")))
            self.etag += 1
            return 200, {}, "{}"
        if method == "PATCH":
            for k, v in json.loads(body.decode("utf-8")).items():
                self.set((path + "/" + k) if path else k, v)
            return 200, {}, "{}"
        raise AssertionError("unexpected " + method)


def make_db(zones_rev=None):
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
    return FakeDB(tree)


class T(unittest.TestCase):
    def setUp(self):
        os.environ.pop("FIREBASE_SERVICE_ACCOUNT_JSON", None)
        os.environ.pop("JISU_ZONE_MIRROR", None)
        sched._AUTH_CACHE.clear()

    def run_with(self, db):
        orig = sched._request
        sched._request = db.request
        try:
            self.assertEqual(sched.run(dry=False), 0)
        finally:
            sched._request = orig

    def test_flow_and_mirror(self):
        db = make_db()
        self.run_with(db)
        methods = [m for m, u in db.calls if "ntfy" not in u]
        self.assertEqual(methods[:2], ["GET", "GET"])
        self.assertIn("PUT", methods)
        self.assertEqual(methods[-1], "PATCH", "구역 복사는 저장 성공 뒤 마지막에")
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


if __name__ == "__main__":
    unittest.main(verbosity=1)
