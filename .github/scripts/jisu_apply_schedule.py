#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
JISU(지수 통합 관제 상황실) 달력 예약 스케줄 자동 반영 — 매일 08:00 KST

이 파일 한 벌이 두 곳에서 같은 일을 한다(두 경로의 내용은 항상 같게 유지한다).
  · GitHub Actions : .github/workflows/jisu-schedule.yml  (cron 0 23 * * *, JISU_APPLY_BY=gh-actions-0800)
  · 피클 예약 작업 : scheduled-actions/jisu-0800-schedule-apply/  (JISU_APPLY_BY=pickle-0800)

JISU/index.html 안의 달력 자동 적용 로직(apply(), window.JISU_SCHEDULE_APPLY_TIME=08:00)과
완전히 같은 규칙으로, Firebase Realtime DB 의 jisu-schedule-v1(jisu/state/jisu-schedule-v1)을
읽어 아직 적용되지 않은 예약을 jisu-commands-v1(금일작업·공지)에 등록하고 applied 로 마킹한다.

- s.date <  today : 지난 예약 → at "MM. DD. 00:00", closed=true (이월/과거 기록)
- s.date == today : 오늘 예약 → at "MM. DD. HH:MM"(현재 KST), closed 없음
- 이미 같은 id('s'+s.id)의 작업이 있으면 카드는 추가하지 않고 applied 마킹만 한다.
- 본문에 "오전 … 오후 …" 가 함께 있으면 index.html 과 같은 규칙으로 두 작업으로 나눈다
  (두 번째부터 id 뒤에 -1, -2 … / 사진·톤수는 첫 작업에만).
- 파렛트·팔레트 품목의 EA/개 수량은 288 EA = 1대로 환산한다(index.html 과 같은 규칙).
- 08:00 마감: 08:00 이전에 완료된 작업은 closed=true 로 화면에서 내린다.
- 08:00 초기화: 입고 입력칸(jisu-inbound-records-v1)의 rows 를 모두 archivedRows 로 옮기고 비운다
  (실적·엑셀 자료는 archivedRows·workState 등에 그대로 보존).
  단 초기화와 요약 알림은 08시 일에만 의미가 있으므로 06:00~09:59 KST 실행에서만 한다
  — 깃허브 예약(cron)이 몇 시간 늦게 돌아도 낮에 입력칸을 비우지 않는다(예약 반영은 그대로).
- 반영·마감 뒤 Web Push(요약)와 ntfy(새 카드) 알림을 보낸다. 알림 실패는 반영 결과에 영향 없음.
- 바뀐 것이 없으면 DB에 아무것도 쓰지 않고 정상 종료한다.

Firebase REST 쓰기는 X-Firebase-ETag / if-match 조건부 요청으로 보호한다.
(그 사이 대시보드에서 저장이 일어났다면 412로 되돌아오고, 다시 읽어 재계산한다.)

DB 구조가 v2(구역 묶음, jisu/config/syncMode = "v2")면 자동으로 v2 규칙으로 동작한다.

사용:
    python3 jisu_apply_schedule.py            # 실제 반영
    python3 jisu_apply_schedule.py --dry-run  # 읽기만 하고 무엇을 할지 출력
환경:
    JISU_APPLY_BY             기록용 실행 주체 표기
    JISU_ZONE_MIRROR=0        구역 복사본 갱신 끄기
    JISU_PUSH_API_URL         Web Push 주소(기본 https://posco-m.vercel.app/api/push)
    JISU_PUSH_AUTH_TOKEN      Web Push 인증 토큰(선택)
    FIREBASE_SERVICE_ACCOUNT_JSON  서비스 계정 인증(선택)
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
PUSH_API_URL = os.environ.get("JISU_PUSH_API_URL", "https://posco-m.vercel.app/api/push").strip()
ROOT = "jisu"
STATE = f"{ROOT}/state"
SKEY = "jisu-schedule-v1"
CKEY = "jisu-commands-v1"
INB = "jisu-inbound-records-v1"
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


# ---------------------------------------------------------------- 08:00 마감·입고 초기화·Web Push
# 입고 초기화·요약 알림은 '08시' 일에만 의미가 있다. 같은 스크립트가 깃허브 예약(cron)으로
# 몇 시간 늦게 돌 수 있어서, 이 시간대(KST) 밖이면 입력칸을 비우지 않고 예약 반영만 한다.
CLOSE_WINDOW_HOURS = (6, 10)      # 06:00 ~ 09:59


def in_0800_window(now: datetime) -> bool:
    a, b = CLOSE_WINDOW_HOURS
    return a <= now.hour < b


def close_completed_before_0800(cmds: list, today: str, now: datetime) -> int:
    """08:00 기준 이전 완료 작업을 화면에서 숨김(closed=True) 초기화한다."""
    cutoff = now.replace(hour=8, minute=0, second=0, microsecond=0)
    if now.hour < 8:
        cutoff = cutoff - timedelta(days=1)
    closed_cnt = 0
    ty = int(today[:4])
    for x in cmds:
        if not isinstance(x, dict):
            continue
        if x.get("id") == "demo_dispatch_1" or x.get("closed"):
            continue
        if x.get("completed") is not True:
            continue
        s = str(x.get("completedAt") or "")
        m = re.search(r"(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{1,2}):(\d{2})", s)
        done_dt = None
        if m:
            try:
                done_dt = datetime(ty, int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), tzinfo=KST)
                if done_dt.timestamp() > now.timestamp() + 86400:
                    done_dt = done_dt.replace(year=ty - 1)
            except ValueError:
                done_dt = None
        else:
            d = str(x.get("day") or "")
            if d:
                try:
                    done_dt = datetime(int(d[:4]), int(d[5:7]), int(d[8:10]), tzinfo=KST)
                except (ValueError, IndexError):
                    done_dt = None
        if done_dt is not None and done_dt <= cutoff:
            x["closed"] = True
            closed_cnt += 1
            print(f"  - 완료 초기화 {x.get('id')} [{x.get('target')}] {x.get('text')}")
    return closed_cnt


def inbound_records_path(v2: bool = False) -> str:
    """입고 기록 위치: v2(구역 묶음)면 inbound 묶음, 지금 방식이면 state."""
    return f"{ROOT}/v2/inbound/{INB}" if v2 else f"{STATE}/{INB}"


def cleanup_completed_inputs_0800(dry: bool = False, v2: bool = False) -> None:
    """08:00 초기화: 입고 입력칸의 rows(모든 날짜)를 archivedRows 로 옮기고 비운다.

    · 비우는 것은 화면 입력칸(rows)뿐이고, 옮긴 값은 archivedRows 에 그대로 남는다(실적·엑셀 자료 보존).
    · 작업 상태는 idle, 근무 표시는 '오늘-am' 으로 되돌린다. (환경 호기 칸은 이 초기화 대상이 아니다)
    """
    try:
        path = inbound_records_path(v2)
        inb_node, inb_etag = db_get(path)
        if isinstance(inb_node, dict) and isinstance(inb_node.get("v"), str):
            ir = json.loads(inb_node["v"])
            if isinstance(ir, dict):
                changed = False
                for d, rec in ir.items():
                    if isinstance(rec, dict) and rec.get("rows"):
                        rec["archivedRows"] = (rec.get("archivedRows") or []) + rec["rows"]
                        rec["rows"] = []
                        rec["workState"] = "idle"
                        rec["shiftKey"] = f"{kst_today()}-am"
                        changed = True
                if changed:
                    db_put(path, {"by": BY, "t": int(time.time() * 1000), "v": dump_v(ir)}, inb_etag, dry)
    except Exception as e:
        print(f"[warn] 입고 입력칸 초기화 실패(무시): {e}")


def send_push_notifications(added_items: list, cmds: list, dry: bool = False) -> None:
    """08시에 새로 추가된 작업지시 또는 미완료 작업이 있으면 Web Push 서버로 알린다."""
    active_cmds = [
        c for c in cmds
        if isinstance(c, dict) and not c.get("closed") and not c.get("completed")
        and c.get("kind") != "notice" and c.get("id") != "demo_dispatch_1"
    ]
    if not added_items and not active_cmds:
        return

    if added_items:
        title = f"⏰ 08시 새 작업지시 {len(added_items)}건"
        body = " / ".join(f"{it.get('target')} {it.get('text')}" for it in added_items[:3])
        if len(added_items) > 3:
            body += f" 외 {len(added_items) - 3}건"
    else:
        title = f"⏰ 08시 작업지시 {len(active_cmds)}건 대기"
        body = f"미완료 작업지시 {len(active_cmds)}건이 대시보드에 대기 중입니다."

    zones_to_notify = {"master"}
    for it in (added_items or active_cmds):
        z = it.get("target")
        if z == "*":
            zones_to_notify.add("all")
        elif z:
            zones_to_notify.add(str(z))

    for zone in sorted(zones_to_notify):
        url = (
            "https://coarfamily-cyber.github.io/POSCO-M/JISU/"
            if zone in ("master", "all")
            else f"https://coarfamily-cyber.github.io/POSCO-M/JISU/?zone={zone}"
        )
        if dry or not PUSH_API_URL:
            print(f"[dry-run] POST {PUSH_API_URL} ({zone}) — {title}: {body}")
            continue
        payload = json.dumps({"zone": zone, "title": title, "body": body, "url": url}, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json; charset=utf-8"}
        tok = os.environ.get("JISU_PUSH_AUTH_TOKEN", "").strip()
        if tok:
            headers["Authorization"] = f"Bearer {tok}"
        try:
            # 다른 요청과 같이 _request 를 쓴다 (테스트에서 가짜 DB·가짜 알림으로 바꿔 끼울 수 있게)
            status, _, text = _request(PUSH_API_URL, "POST", payload, headers)
            print(f"[ok] Web Push({zone}) -> HTTP {status} {text[:100]}")
        except Exception as e:
            print(f"[warn] Web Push({zone}) 발송 실패(무시): {e}")


def morning_tail(added_items: list, cmds: list, dry: bool = False, morning: bool = True, v2: bool = False) -> None:
    """08시 시간대 실행에서만 입고 초기화와 요약 알림을 한다(늦게 도는 백업 실행 보호)."""
    if not morning:
        print("[jisu] 08시 시간대 밖 실행 — 입고 초기화·요약 알림은 건너뜀")
        return
    cleanup_completed_inputs_0800(dry, v2=v2)
    send_push_notifications(added_items, cmds, dry)


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
            # PWA Web Push 연동 (선택적 인증 토큰 지원)
            try:
                push_url = os.environ.get("JISU_PUSH_API_URL", "https://posco-m.vercel.app/api/push").strip()
                if push_url:
                    push_headers = {"Content-Type": "application/json"}
                    push_tok = os.environ.get("JISU_PUSH_AUTH_TOKEN", "").strip()
                    if push_tok:
                        push_headers["Authorization"] = f"Bearer {push_tok}"
                    push_body = json.dumps({
                        "target": base,
                        "payload": {
                            "title": title,
                            "body": msg,
                            "url": "https://coarfamily-cyber.github.io/POSCO-M/JISU/" + (f"?zone={base}" if base != "*" else ""),
                            "tag": f"jisu-sched-{rec.get('id', base)}",
                            "badge": 1,
                        },
                    }, ensure_ascii=False).encode("utf-8")
                    _request(push_url, "POST", push_body, push_headers)
            except Exception as pe:
                print(f"[warn] Web Push 발송 실패: {pe}")
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
    morning = in_0800_window(now)
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
        before_ids = {c.get("id") for c in cmds if isinstance(c, dict)}
        parts_before = {pt: dump_v(parts[pt][0]) for pt in V2_PARTS}
        sch_before = json.dumps(sch, ensure_ascii=False, sort_keys=True)
        print(f"[jisu] (v2) 시도 {attempt}: 예약 {len(sch)}건 · 금일작업 {before_len}건")

        closed_cnt = 0
        for pt in V2_PARTS:      # 08:00 이전 완료 작업은 각 묶음에서 마감
            closed_cnt += close_completed_before_0800(parts[pt][0], today, now)

        added, marked = apply_schedules(sch, cmds, today, now_s)
        new_recs = cmds[before_len:]
        added_items = [c for c in cmds if isinstance(c, dict) and c.get("id") not in before_ids]
        sch_changed = json.dumps(sch, ensure_ascii=False, sort_keys=True) != sch_before
        changed_parts = [pt for pt in V2_PARTS if dump_v(parts[pt][0]) != parts_before[pt]]
        if not new_recs and not sch_changed and not changed_parts:
            print("[jisu] (v2) 반영·초기화할 항목이 없습니다 — DB에 쓰지 않음")
            morning_tail([], cmds, dry, morning, v2=True)
            return 0

        t = int(time.time() * 1000)
        by_part: dict = {}
        for rec in new_recs:
            by_part.setdefault(v2_bucket_of(rec), []).append(rec)
        ok = True
        for pt in V2_PARTS:      # 카드 → 먼저(묶음별 조건부), 예약 마킹 → 나중
            recs = by_part.get(pt) or []
            if not recs and pt not in changed_parts:
                continue
            cur, etag, _exists = parts[pt]
            ok = db_put(f"{ROOT}/v2/{pt}/{CKEY}", {"by": BY, "t": t, "v": dump_v(cur + recs)}, etag, dry)
            if not ok:
                break
        if ok and sch_changed:
            ok = db_put(sch_path, {"by": BY, "t": t, "v": dump_v(sch)}, sch_etag, dry)
        if ok:
            print(f"[jisu] (v2) 완료 — 완료 초기화 {closed_cnt}건 · 카드 {added}건 추가 · 예약 {marked}건 applied 마킹")
            if not dry and added > 0:
                # 지난 날짜 예약을 소급 마킹한 closed 카드는 알리지 않는다 (오늘 실제로 열린 작업만)
                notify_new([r for r in cmds[-added:] if not r.get("closed")])
            morning_tail(added_items, cmds, dry, morning, v2=True)
            return 0
        time.sleep(1)
    raise SystemExit("[error] 3회 재시도에도 다른 기기 저장과 겹쳐 반영하지 못했습니다.")


# ---------------------------------------------------------------- main
def run(dry: bool = False) -> int:
    if read_sync_mode() == "v2":
        return run_v2(dry)
    now = kst_now()
    today, now_s = kst_today(now), now_str(now)
    morning = in_0800_window(now)
    print(f"[jisu] KST now = {now.isoformat(timespec='seconds')}  today={today}  nowStr='{now_s}'"
          f"  08시 초기화={'함' if morning else '건너뜀(시간대 밖)'}")

    for attempt in range(1, 4):
        sch_node, sch_etag = db_get(f"{STATE}/{SKEY}")
        cmd_node, cmd_etag = db_get(f"{STATE}/{CKEY}")
        sch, cmds = parse_v(sch_node), parse_v(cmd_node)
        print(f"[jisu] 시도 {attempt}: 예약 {len(sch)}건 · 금일작업 {len(cmds)}건"
              f" (etag sch={sch_etag} cmd={cmd_etag})")

        sch_before = json.dumps(sch, ensure_ascii=False, sort_keys=True)
        cmds_before = json.dumps(cmds, ensure_ascii=False, sort_keys=True)

        before_ids = {c.get("id") for c in cmds if isinstance(c, dict)}
        closed_cnt = close_completed_before_0800(cmds, today, now)   # 08:00 마감 → 예약 반영
        added, marked = apply_schedules(sch, cmds, today, now_s)
        added_items = [c for c in cmds if isinstance(c, dict) and c.get("id") not in before_ids]

        sch_changed = json.dumps(sch, ensure_ascii=False, sort_keys=True) != sch_before
        cmds_changed = json.dumps(cmds, ensure_ascii=False, sort_keys=True) != cmds_before

        if not sch_changed and not cmds_changed:
            print("[jisu] 반영·초기화할 항목이 없습니다 — DB에 쓰지 않음")
            morning_tail(added_items, cmds, dry, morning)
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
            print(f"[jisu] 완료 — 완료 초기화 {closed_cnt}건 · 카드 {added}건 추가 · 예약 {marked}건 applied 마킹")
            if cmds_changed and not dry:
                mirror_zones(cmds, t)
            if not dry and added > 0:
                # 지난 날짜 예약을 소급 마킹한 closed 카드는 알리지 않는다 (오늘 실제로 열린 작업만)
                notify_new([r for r in cmds[-added:] if not r.get("closed")])
            morning_tail(added_items, cmds, dry, morning)
            return 0
        time.sleep(1)   # 다른 기기 저장과 겹침 → 다시 읽고 재계산

    raise SystemExit("[error] 3회 재시도에도 다른 기기 저장과 겹쳐 반영하지 못했습니다.")


if __name__ == "__main__":
    sys.exit(run(dry="--dry-run" in sys.argv))
