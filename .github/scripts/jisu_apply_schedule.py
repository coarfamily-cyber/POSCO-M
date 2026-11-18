#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
JISU(지수 통합 관제 상황실) 달력 예약 스케줄 자동 반영 — 매일 08:00 KST (GitHub Actions)

JISU/index.html 안의 달력 자동 적용 로직(apply(), window.JISU_SCHEDULE_APPLY_TIME=08:00)과
완전히 같은 규칙으로, Firebase Realtime DB 의 jisu-schedule-v1(jisu/state/jisu-schedule-v1)을
읽어 아직 적용되지 않은 예약을 jisu-commands-v1(금일작업·공지)에 등록하고 applied 로 마킹한다.

- s.date <  today : 지난 예약 → at "MM. DD. 00:00", closed=true (이월/과거 기록)
- s.date == today : 오늘 예약 → at "MM. DD. HH:MM"(현재 KST), closed 없음
- 이미 같은 id('s'+s.id)의 작업이 있으면 카드는 추가하지 않고 applied 마킹만 한다.
- 바뀐 것이 없으면 DB에 아무것도 쓰지 않고 정상 종료한다.

Firebase REST 쓰기는 X-Firebase-ETag / if-match 조건부 요청으로 보호한다.
(그 사이 대시보드에서 저장이 일어났다면 412로 되돌아오고, 다시 읽어 재계산한다.)

사용:
    python3 jisu_apply_schedule.py            # 실제 반영
    python3 jisu_apply_schedule.py --dry-run  # 읽기만 하고 무엇을 할지 출력
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

DB_URL = "https://posco-m-jisu-default-rtdb.asia-southeast1.firebasedatabase.app"
ROOT = "jisu"
STATE = f"{ROOT}/state"
SKEY = "jisu-schedule-v1"
CKEY = "jisu-commands-v1"
BY = os.environ.get("JISU_APPLY_BY", "gh-actions-0800")   # 실행 주체 표기(기록용)

KST = timezone(timedelta(hours=9))  # 한국 표준시는 DST 없음 (tzdata 불필요)
TIMEOUT = 30
MAX_TRIES = 5


# ---------------------------------------------------------------- 시간 표기
def kst_now() -> datetime:
    return datetime.now(KST)


def kst_today(now: datetime | None = None) -> str:
    n = now or kst_now()
    return f"{n.year:04d}-{n.month:02d}-{n.day:02d}"


def now_str(now: datetime | None = None) -> str:
    """대시보드와 같은 표기: '11. 17. 08:00'"""
    n = now or kst_now()
    return f"{n.month:02d}. {n.day:02d}. {n.hour:02d}:{n.minute:02d}"


def at_of_midnight(day: str) -> str:
    """'2026-11-16' -> '11. 16. 00:00'"""
    p = str(day).split("-")
    if len(p) >= 3:
        return f"{int(p[1]):02d}. {int(p[2]):02d}. 00:00"
    return ""


# ---------------------------------------------------------------- 선택적 인증 (5단계 준비)
# GitHub Secret FIREBASE_SERVICE_ACCOUNT_JSON 이 있으면 서비스 계정으로 인증해 쓴다.
# 없거나 인증에 실패하면 지금과 같이 인증 없이 동작한다 (보안 규칙을 닫기 전까지는 그대로 동작).
_AUTH_CACHE: dict = {}


def _auth_suffix() -> str:
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if not raw:
        return ""
    if _AUTH_CACHE.get("token") and _AUTH_CACHE.get("exp", 0) > time.time() + 60:
        return "?access_token=" + _AUTH_CACHE["token"]
    try:
        from google.oauth2 import service_account  # type: ignore
        import google.auth.transport.requests  # type: ignore
        creds = service_account.Credentials.from_service_account_info(
            json.loads(raw),
            scopes=["https://www.googleapis.com/auth/firebase.database",
                    "https://www.googleapis.com/auth/userinfo.email"])
        creds.refresh(google.auth.transport.requests.Request())
        _AUTH_CACHE["token"] = creds.token
        _AUTH_CACHE["exp"] = time.time() + 3000
        print("[jisu] 서비스 계정 인증 사용")
        return "?access_token=" + creds.token
    except Exception as e:  # 라이브러리 없음·키 오류 등 → 인증 없이 진행
        print(f"[warn] 서비스 계정 인증 실패, 인증 없이 진행: {type(e).__name__}")
        return ""


# ---------------------------------------------------------------- DB I/O
def _request(url: str, method: str = "GET", body: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.status, dict(r.headers), r.read().decode("utf-8")


def db_get(path: str):
    """(parsed_json_or_None, etag_or_None) 를 돌려준다."""
    url = f"{DB_URL}/{path}.json" + _auth_suffix()
    last = None
    for attempt in range(1, MAX_TRIES + 1):
        try:
            status, headers, text = _request(url, "GET", headers={"X-Firebase-ETag": "true"})
            etag = headers.get("ETag") or headers.get("etag")
            return (json.loads(text) if text and text.strip() else None), etag
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            print(f"[warn] GET {path} 실패({attempt}/{MAX_TRIES}): {e}")
            time.sleep(2 * attempt)
    raise SystemExit(f"[error] DB 읽기 실패: {path} ({last})")


def db_put(path: str, value: dict, etag: str | None, dry: bool = False):
    """조건부 PUT. 412(ETag 불일치)면 False 를 돌려준다."""
    if dry:
        print(f"[dry-run] PUT {path} (etag={etag})")
        return True
    body = json.dumps(value, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if etag:
        headers["if-match"] = etag
    url = f"{DB_URL}/{path}.json" + _auth_suffix()
    last = None
    for attempt in range(1, MAX_TRIES + 1):
        try:
            status, _, text = _request(url, "PUT", body, headers)
            print(f"[ok] PUT {path} -> HTTP {status} {text[:120]}")
            return True
        except urllib.error.HTTPError as e:
            payload = ""
            try:
                payload = e.read().decode("utf-8")
            except Exception:
                pass
            if e.code == 412:
                print(f"[retry] {path}: ETag 불일치(412) — 다시 읽어 재계산합니다. {payload[:160]}")
                return False
            last = f"HTTP {e.code} {payload[:200]}"
            print(f"[warn] PUT {path} 실패({attempt}/{MAX_TRIES}): {last}")
            time.sleep(2 * attempt)
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            print(f"[warn] PUT {path} 실패({attempt}/{MAX_TRIES}): {e}")
            time.sleep(2 * attempt)
    raise SystemExit(f"[error] DB 쓰기 실패: {path} ({last})")


def parse_v(node):
    """{"v": "<json string>"} -> python object"""
    if not isinstance(node, dict):
        return []
    raw = node.get("v")
    if not isinstance(raw, str):
        return []
    try:
        val = json.loads(raw)
    except json.JSONDecodeError:
        print("[warn] v 파싱 실패 — 빈 목록으로 처리")
        return []
    return val if isinstance(val, list) else []


def dump_v(value) -> str:
    """대시보드(JSON.stringify)와 같은 표기: 공백 없음, 한글 그대로."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


# ------------------------------------------------- 오전/오후 분리 (index.html 과 같은 규칙)
AMPM_RE = re.compile(r"(오전|오후)")
_BOUNDARY_RE = re.compile(r"[\s,·;:/|、()\[\]{}<>~\-]")
_TIME_ONLY_RE = re.compile(r"\d{0,2}(?:시|:\d{1,2})(?:[~\-–]\d{0,2}(?:시|:\d{1,2})?)?(?:부터|까지|이후|이전|경|분)?")


def _time_only(body: str) -> bool:
    t = re.sub(r"\s+", "", body or "")
    if not t:
        return True
    return bool(_TIME_ONLY_RE.fullmatch(t))


def _split_once(s: str):
    """한 항목 안에 오전 … 과 오후 … 가 함께 있으면 두 토막으로 나눈다."""
    marks = []
    for m in AMPM_RE.finditer(s):
        i = m.start()
        before = s[i - 1] if i > 0 else ""
        after = s[i + 2:]
        if before and not _BOUNDARY_RE.match(before):
            continue
        if not after[:1].isspace():      # '오전에' 처럼 붙은 말은 라벨이 아니다
            continue
        marks.append((i, m.group(1)))
    if not marks:
        return None
    am_pos = [i for i, l in marks if l == "오전"]
    pm_pos = [i for i, l in marks if l == "오후"]
    if not am_pos or not pm_pos:
        return None
    cut = next((i for i in pm_pos if i > am_pos[0]), None)
    if cut is None:
        return None
    head = re.sub(r"[\s,·;:/|、\-]+$", "", s[:cut]).strip()
    tail = re.sub(r"^[\s,·;:/|、\-]+", "", s[cut:]).strip()
    if not head or not tail:
        return None
    am_i = head.find("오전")
    if am_i < 0:
        return None
    prefix = re.sub(r"[\s,·;:/|、\-]+$", "", head[:am_i]).strip()
    if prefix and (len(prefix) > 14 or re.search(r"\d", prefix)):
        return None
    head_body, tail_body = head[am_i + 2:].strip(), tail[2:].strip()
    if len(head_body) < 2 or len(tail_body) < 2:
        return None
    if _time_only(head_body) or _time_only(tail_body):
        return None
    return [head, tail]


def split_am_pm(text, kind=None):
    raw = "" if text is None else str(text)
    if kind == "notice" or not raw:
        return [raw]
    parts = [raw]
    for _ in range(4):
        nxt, changed = [], False
        for p in parts:
            r = _split_once(p)
            if r:
                nxt.extend(r)
                changed = True
            else:
                nxt.append(p)
        parts = nxt
        if not changed:
            break
    return parts


# ---------------------------------------------------------------- 표기 규칙
PALLET_PER = 288          # 파렛트 1대 = 288 EA
_PALLET_WORD = re.compile(r"(?:파렛트|팔레트)")
_PALLET_INLINE = re.compile(
    r"(파렛트|팔레트)([\s\]\)】:：]{0,4})(\d+(?:[.,]\d+)?)\s*(?:ea|pcs|개)(?![A-Za-z0-9가-힣])",
    re.IGNORECASE)
_PALLET_HEAD = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:ea|pcs|개)(?![A-Za-z0-9가-힣])", re.IGNORECASE)


def _qty_num(s: str) -> float:
    s = str(s)
    if re.fullmatch(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?", s):
        return float(s.replace(",", ""))
    return float(s.replace(",", "."))


def _dae_text(n: float) -> str:
    v = round(n / PALLET_PER, 2)      # 2 · 1.5 · 1.33 (끝 0 없이)
    return "" if v <= 0 else ("%g" % v)


def normalize_pallet(text, target=None) -> str:
    """파렛트·팔레트 품목의 EA/개 수량을 288 EA = 1대로 환산한다.

    - 문구 안에 파렛트/팔레트가 있으면 그 바로 뒤 수량을 환산한다. (16 KG 파렛트 576 EA → 16 KG 파렛트 2대)
    - 대상(target)이 파렛트 품목이라 수량만 적힌 경우에는 첫 수량 하나만 환산한다. (576 EA → 2대)
    - 파렛트가 아닌 품목(알루미늄 파우치백 600 EA, 사각박스 640 SET, 공장간이송 30 EA)은 그대로 둔다.
    """
    raw = "" if text is None else str(text)
    if not raw:
        return raw

    def _inline(m):
        d = _dae_text(_qty_num(m.group(3)))
        return m.group(0) if not d else f"{m.group(1)}{m.group(2)}{d}대"

    if _PALLET_WORD.search(raw):
        return _PALLET_INLINE.sub(_inline, raw)
    if target and _PALLET_WORD.search(str(target)):
        return _PALLET_HEAD.sub(_inline_head, raw, count=1)
    return raw


def _inline_head(m):
    d = _dae_text(_qty_num(m.group(1)))
    return m.group(0) if not d else f"{d}대"


# ---------------------------------------------------------------- 반영 규칙
def apply_schedules(sch: list, cmds: list, today: str, now_s: str):
    """달력 예약을 금일작업으로 옮긴다. (추가된 카드 수, 마킹 수)"""
    added, marked = 0, 0
    have = {c.get("id") for c in cmds if isinstance(c, dict)}
    for s in sch:
        if not isinstance(s, dict):
            continue
        if s.get("applied"):
            continue
        date = str(s.get("date") or "")
        if not date or date > today:      # 미래 예약은 그대로 둔다
            continue

        if date < today:
            at, closed = at_of_midnight(date), True
        else:
            at, closed = now_s, False

        texts = split_am_pm(s.get("text"), s.get("kind"))
        for idx, txt in enumerate(texts):
            txt = normalize_pallet(txt, s.get("target"))
            rid = "s" + str(s.get("id")) + (("-" + str(idx)) if idx else "")
            if rid in have:
                print(f"  = 이미 등록됨 {rid} (마킹만)")
                continue
            rec = {
                "id": rid,
                "target": s.get("target"),
                "kind": s.get("kind") or "instruction",
                "text": txt,
                "at": at,
                "day": date,
                "sched": date,
                "origDay": date,
            }
            if closed:
                rec["closed"] = True
            if idx == 0:
                if s.get("img"):
                    rec["img"] = s["img"]
                if s.get("tonText"):
                    rec["tonText"] = s["tonText"]
            if s.get("urgent"):
                rec["urgent"] = True
            if s.get("by"):
                rec["by"] = s["by"]

            cmds.append(rec)
            have.add(rid)
            added += 1
            print(f"  + 카드 추가 {rid} [{date}] {rec.get('target')} "
                  f"{'공지' if rec['kind'] == 'notice' else '지시'} — {rec.get('text')}")

        s["applied"] = True
        s["appliedAt"] = now_s
        marked += 1
    return added, marked


# ---------------------------------------------------------------- 구역 복사본 (index.html ZONE-MIRROR 와 같은 규칙)
ZONE_MIRROR_KEYS = ["outbound", "inbound", "pitch", "packaging", "packaging-d", "environment",
                    "production-a", "production-b", "production-c", "production-d",
                    "production-e", "production-f", "production-g", "production-h"]
ZONE_ADMIN_BUCKET = "_admin"
BAD_FB_KEY = re.compile(r"[.#$\[\]/]")


def build_zone_mirror(cmds: list) -> dict:
    zones: dict = {}
    notices: dict = {}
    for x in cmds:
        if not isinstance(x, dict):
            continue
        xid = x.get("id")
        if not isinstance(xid, str) or not xid or BAD_FB_KEY.search(xid):
            continue
        if x.get("target") == "*" or x.get("kind") == "notice":
            notices[xid] = x
            continue
        z = str(x.get("target") or "").split(":")[0]
        if z not in ZONE_MIRROR_KEYS:
            z = ZONE_ADMIN_BUCKET
        zones.setdefault(z, {})[xid] = x
    return {"zones": zones, "notices": notices}


def mirror_updates(cmds: list, rev: int) -> dict:
    m = build_zone_mirror(cmds)
    upd: dict = {}
    for z in ZONE_MIRROR_KEYS + [ZONE_ADMIN_BUCKET]:
        o = m["zones"].get(z)
        upd[f"zones/{z}/commands"] = o if o else None
    upd["notices"] = m["notices"] if m["notices"] else None
    upd["zonesRev"] = rev
    return upd


def mirror_zones(cmds: list, rev: int) -> None:
    """작업 목록 저장 성공 후 구역 복사본 갱신. 실패해도 예약 반영 결과에는 영향 없음."""
    if os.environ.get("JISU_ZONE_MIRROR", "1") != "1":
        return
    try:
        _, _, text = _request(f"{DB_URL}/{ROOT}/zonesRev.json" + _auth_suffix(), "GET")
        cur = json.loads(text) if text and text.strip() else None
        if isinstance(cur, (int, float)) and cur > rev:
            print("[jisu] 구역 복사: 더 새 버전이 이미 있어 건너뜀")
            return
        body = json.dumps(mirror_updates(cmds, rev), ensure_ascii=False).encode("utf-8")
        status, _, _ = _request(f"{DB_URL}/{ROOT}.json" + _auth_suffix(), "PATCH", body,
                                {"Content-Type": "application/json; charset=utf-8"})
        print(f"[ok] 구역 복사 갱신 -> HTTP {status}")
    except Exception as e:
        print(f"[warn] 구역 복사 실패(예약 반영은 완료됨): {type(e).__name__}")


# ---------------------------------------------------------------- 알림
def notify_new(recs: list) -> None:
    """새 카드 ntfy 알림 (기존 동작 그대로)"""
    for rec in recs:
        try:
            base = str(rec.get("target") or "*").split(":")[0] or "*"
            kind = "공지사항" if rec.get("kind") == "notice" else ("긴급 작업" if rec.get("urgent") else "새 작업지시")
            title = f"{'전체' if base == '*' else base} · {kind}"
            msg = str(rec.get("text") or "새 지시가 등록되었습니다.")
            prio = 5 if rec.get("urgent") else (4 if rec.get("kind") == "notice" else 3)
            topics = ["posco-jisu-9m4k2p-all", "posco-jisu-9m4k2p-master"] if base == "*" else [f"posco-jisu-9m4k2p-{base}", "posco-jisu-9m4k2p-master"]
            for tp in topics:
                payload = json.dumps({
                    "topic": tp,
                    "title": title,
                    "message": msg,
                    "priority": prio,
                    "tags": ["rotating_light"] if rec.get("urgent") else ["bell"],
                    "click": "https://coarfamily-cyber.github.io/POSCO-M/JISU/" + (f"?zone={base}" if base != "*" else "")
                }, ensure_ascii=False).encode("utf-8")
                _request("https://ntfy.sh/", "POST", payload, {"Content-Type": "application/json"})
        except Exception as e:
            print(f"[warn] ntfy 발송 실패: {e}")


# ---------------------------------------------------------------- v2(구역 묶음) — index.html SYNC-V2 와 같은 규칙
V2_ZONES = ZONE_MIRROR_KEYS
V2_PARTS = V2_ZONES + ["_admin", "_notice"]


def v2_bucket_of(x) -> str:
    if isinstance(x, dict) and (x.get("target") == "*" or x.get("kind") == "notice"):
        return "_notice"
    z = str((x.get("target") if isinstance(x, dict) else "") or "").split(":")[0]
    return z if z in V2_ZONES else "_admin"


def read_sync_mode() -> str:
    """DB config/syncMode 가 'v2' 이면 v2, 없거나 다른 값이면 기존 방식(state). 읽기 실패는 db_get 처럼 재시도 후 중단"""
    val, _ = db_get(f"{ROOT}/config/syncMode")
    return "v2" if val == "v2" else "state"


def run_v2(dry: bool = False) -> int:
    """v2: 예약은 v2/_admin, 작업지시는 v2/{묶음}. 새 카드는 해당 묶음에만 조건부로 쓴다."""
    now = kst_now()
    today, now_s = kst_today(now), now_str(now)
    print(f"[jisu] (v2) KST now = {now.isoformat(timespec='seconds')}  today={today}")
    for attempt in range(1, 4):
        sch_path = f"{ROOT}/v2/_admin/{SKEY}"
        sch_node, sch_etag = db_get(sch_path)
        sch = parse_v(sch_node)
        parts = {}
        for pt in V2_PARTS:
            node, etag = db_get(f"{ROOT}/v2/{pt}/{CKEY}")
            parts[pt] = (parse_v(node), etag, node is not None)
        cmds = [x for pt in V2_PARTS for x in parts[pt][0]]
        before_len = len(cmds)
        sch_before = json.dumps(sch, ensure_ascii=False, sort_keys=True)
        print(f"[jisu] (v2) 시도 {attempt}: 예약 {len(sch)}건 · 금일작업 {before_len}건")

        added, marked = apply_schedules(sch, cmds, today, now_s)
        new_recs = cmds[before_len:]
        sch_changed = json.dumps(sch, ensure_ascii=False, sort_keys=True) != sch_before
        if not new_recs and not sch_changed:
            print("[jisu] 반영할 예약이 없습니다 — DB에 쓰지 않고 종료")
            return 0

        t = int(time.time() * 1000)
        by_part: dict = {}
        for rec in new_recs:
            by_part.setdefault(v2_bucket_of(rec), []).append(rec)
        ok = True
        for pt, recs in by_part.items():   # 카드 → 먼저(묶음별 조건부), 예약 마킹 → 나중
            cur, etag, _exists = parts[pt]
            ok = db_put(f"{ROOT}/v2/{pt}/{CKEY}", {"by": BY, "t": t, "v": dump_v(cur + recs)}, etag, dry)
            if not ok:
                break
        if ok and sch_changed:
            ok = db_put(sch_path, {"by": BY, "t": t, "v": dump_v(sch)}, sch_etag, dry)
        if ok:
            print(f"[jisu] (v2) 완료 — 카드 {added}건 추가 · 예약 {marked}건 applied 마킹")
            if not dry and added > 0:
                notify_new(cmds[-added:])
            return 0
        time.sleep(1)
    raise SystemExit("[error] 3회 재시도에도 다른 기기 저장과 겹쳐 반영하지 못했습니다.")


# ---------------------------------------------------------------- main
def run(dry: bool = False) -> int:
    if read_sync_mode() == "v2":
        return run_v2(dry)
    now = kst_now()
    today, now_s = kst_today(now), now_str(now)
    print(f"[jisu] KST now = {now.isoformat(timespec='seconds')}  today={today}  nowStr='{now_s}'")

    for attempt in range(1, 4):
        sch_node, sch_etag = db_get(f"{STATE}/{SKEY}")
        cmd_node, cmd_etag = db_get(f"{STATE}/{CKEY}")
        sch, cmds = parse_v(sch_node), parse_v(cmd_node)
        print(f"[jisu] 시도 {attempt}: 예약 {len(sch)}건 · 금일작업 {len(cmds)}건"
              f" (etag sch={sch_etag} cmd={cmd_etag})")

        sch_before = json.dumps(sch, ensure_ascii=False, sort_keys=True)
        cmds_before = json.dumps(cmds, ensure_ascii=False, sort_keys=True)

        added, marked = apply_schedules(sch, cmds, today, now_s)
        sch_changed = json.dumps(sch, ensure_ascii=False, sort_keys=True) != sch_before
        cmds_changed = json.dumps(cmds, ensure_ascii=False, sort_keys=True) != cmds_before

        if not sch_changed and not cmds_changed:
            print("[jisu] 반영할 예약이 없습니다 — DB에 쓰지 않고 종료")
            return 0

        t = int(time.time() * 1000)
        ok = True
        if cmds_changed:   # 카드 → 먼저, 스케줄 마킹 → 나중 (중간 실패해도 다음 실행이 복구)
            ok = db_put(f"{STATE}/{CKEY}",
                        {"by": BY, "t": t, "v": dump_v(cmds)}, cmd_etag, dry)
        if ok and sch_changed:
            ok = db_put(f"{STATE}/{SKEY}",
                        {"by": BY, "t": t, "v": dump_v(sch)}, sch_etag, dry)
        if ok:
            print(f"[jisu] 완료 — 카드 {added}건 추가 · 예약 {marked}건 applied 마킹")
            if cmds_changed and not dry:
                mirror_zones(cmds, t)
            if not dry and added > 0:
                notify_new(cmds[-added:])
            return 0
        time.sleep(1)   # 다른 기기 저장과 겹침 → 다시 읽고 재계산

    raise SystemExit("[error] 3회 재시도에도 다른 기기 저장과 겹쳐 반영하지 못했습니다.")


if __name__ == "__main__":
    sys.exit(run(dry="--dry-run" in sys.argv))
