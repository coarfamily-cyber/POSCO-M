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


# ---------------------------------------------------------------- DB I/O
def _request(url: str, method: str = "GET", body: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.status, dict(r.headers), r.read().decode("utf-8")


def db_get(path: str):
    """(parsed_json_or_None, etag_or_None) 를 돌려준다."""
    url = f"{DB_URL}/{path}.json"
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
    url = f"{DB_URL}/{path}.json"
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

        rec = {
            "id": "s" + str(s.get("id")),
            "target": s.get("target"),
            "kind": s.get("kind") or "instruction",
            "text": s.get("text"),
            "at": at,
            "day": date,
            "sched": date,
            "origDay": date,
        }
        if closed:
            rec["closed"] = True
        if s.get("img"):
            rec["img"] = s["img"]
        if s.get("tonText"):
            rec["tonText"] = s["tonText"]
        if s.get("urgent"):
            rec["urgent"] = True
        if s.get("by"):
            rec["by"] = s["by"]

        if rec["id"] not in have:
            cmds.append(rec)
            have.add(rec["id"])
            added += 1
            print(f"  + 카드 추가 {rec['id']} [{date}] {rec.get('target')} "
                  f"{'공지' if rec['kind'] == 'notice' else '지시'} — {rec.get('text')}")
        else:
            print(f"  = 이미 등록됨 {rec['id']} (마킹만)")

        s["applied"] = True
        s["appliedAt"] = now_s
        marked += 1
    return added, marked


# ---------------------------------------------------------------- main
def run(dry: bool = False) -> int:
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
            return 0
        time.sleep(1)   # 다른 기기 저장과 겹침 → 다시 읽고 재계산

    raise SystemExit("[error] 3회 재시도에도 다른 기기 저장과 겹쳐 반영하지 못했습니다.")


if __name__ == "__main__":
    sys.exit(run(dry="--dry-run" in sys.argv))
