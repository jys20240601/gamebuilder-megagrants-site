"""정제 · 정합 샘플 코드

MQTT로 들어온 메시지를 정제하고(검사·고치기·표시·버리기), 정합하고(대상·시간·좌표 맞추기),
DB(SQLite)에 저장한다. 파이썬 기본 기능만 써서 추가 설치 없이 돌아간다.

실행:  python clean_align_sample.py   (Git Bash에서 한글이 깨지면 PYTHONIOENCODING=utf-8 을 앞에 붙인다)
결과:  같은 폴더에 sample.db(DB)와 raw_messages.jsonl(원본 보관)이 생기고, 처리 결과가 화면에 나온다.
"""
import json
import math
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

UTC = timezone.utc


# ─────────────────────────────────────────────
# 1. 장비 대장: 정합의 중심. 장비를 추가할 때는 여기에 한 줄만 넣는다
# ─────────────────────────────────────────────
@dataclass
class Asset:
    asset_id: str        # DB와 트윈에서 쓰는 ID
    actor: str           # 언리얼 액터 이름
    kind: str            # "temp" 또는 "position"
    unit: str            # 센서가 보내는 단위: "C", "F", "deg"(위경도)
    vmin: float | None   # 정상 범위 아래 (℃)
    vmax: float | None   # 정상 범위 위 (℃)
    max_jump: float      # 1초당 허용 변화량 (온도는 ℃, 위치는 m)


REGISTRY = {
    "pump03":  Asset("pump03",  "BP_Pump_03",  "temp",     "C",   -20, 120, 5),
    "pump05":  Asset("pump05",  "BP_Pump_05",  "temp",     "F",   -20, 120, 5),
    "crane07": Asset("crane07", "BP_Crane_07", "position", "deg", None, None, 5),
}

ORIGIN_LAT, ORIGIN_LON = 35.10500, 129.08000   # 터미널 원점(언리얼 0,0,0에 해당하는 실제 위치)
MAX_CLOCK_SKEW = timedelta(seconds=5)          # 장비 시각과 받은 시각의 허용 차이


# ─────────────────────────────────────────────
# 2. 정제·정합에 쓰는 작은 함수들
# ─────────────────────────────────────────────
def to_celsius(value: float, unit: str) -> float:
    """단위 통일: 화씨면 섭씨로 바꾼다."""
    if unit == "F":
        return round((value - 32) * 5 / 9, 1)
    return value


def fix_time(device_time: str | None, received: datetime) -> tuple[datetime, str]:
    """시간 정합: UTC로 바꾸고, 장비 시계가 많이 틀렸으면 받은 시각으로 대신한다."""
    if not device_time:
        return received, "clock_missing"
    t = datetime.fromisoformat(device_time).astimezone(UTC)
    if abs(t - received) > MAX_CLOCK_SKEW:
        return received, "clock_fixed"
    return t, "ok"


def latlon_to_local_m(lat: float, lon: float) -> tuple[float, float]:
    """좌표 정합: 위경도(WGS84)를 원점 기준 동쪽·북쪽 거리(m)로 바꾼다.

    수 km 안의 좁은 현장에서 쓰는 근사식이다. 넓은 지역이나 정밀 작업은
    pyproj(좌표계 변환 라이브러리)나 언리얼 Georeferencing 플러그인을 쓴다.
    """
    a, e2 = 6378137.0, 6.69437999014e-3                 # WGS84 타원체
    phi = math.radians(ORIGIN_LAT)
    w = 1 - e2 * math.sin(phi) ** 2
    m = a * (1 - e2) / w ** 1.5                         # 남북 방향 곡률 반지름
    n = a / math.sqrt(w)                                # 동서 방향 곡률 반지름
    north = math.radians(lat - ORIGIN_LAT) * m
    east = math.radians(lon - ORIGIN_LON) * n * math.cos(phi)
    return round(east, 2), round(north, 2)


# ─────────────────────────────────────────────
# 3. 저장기: 메시지 한 통을 받아 처리한다 (MQTT on_message에서 이 함수를 부르면 된다)
# ─────────────────────────────────────────────
class Cleaner:
    def __init__(self, db_path="sample.db", raw_path="raw_messages.jsonl"):
        self.db = sqlite3.connect(db_path)
        self.db.executescript("""
            DROP TABLE IF EXISTS sensor_data; DROP TABLE IF EXISTS errors; DROP TABLE IF EXISTS pending;
            CREATE TABLE sensor_data (time TEXT, asset_id TEXT, actor TEXT, metric TEXT, value REAL, quality TEXT);
            CREATE TABLE errors  (received TEXT, topic TEXT, raw TEXT, reason TEXT);
            CREATE TABLE pending (received TEXT, device TEXT, raw TEXT);
        """)
        self.raw_file = open(raw_path, "w", encoding="utf-8")
        self.seen = set()       # 중복 확인용: (장비, 시각, 값)
        self.last_ok = {}       # 장비별 마지막 정상값: {asset_id: (시각, 값)}
        self.log = []           # 화면 출력용 판정 기록

    def handle(self, received: datetime, topic: str, payload: str):
        rec = received.astimezone(UTC)

        # ⓪ 원본은 무조건 그대로 보관한다
        self.raw_file.write(json.dumps({"received": rec.isoformat(), "topic": topic, "payload": payload},
                                       ensure_ascii=False) + "\n")

        # ① 정제: 형식 검사
        try:
            d = json.loads(payload)
            device = d["device"]
        except (json.JSONDecodeError, KeyError, TypeError):
            return self._error(rec, topic, payload, "형식 오류(JSON이 깨졌거나 device 없음)")

        # ② 정합: 대상 맞추기 — 장비 대장에 없으면 보류
        asset = REGISTRY.get(device)
        if asset is None:
            self.db.execute("INSERT INTO pending VALUES (?,?,?)", (rec.isoformat(), device, payload))
            return self.log.append((device, "보류", "장비 대장에 없음"))

        # ② 정합: 시간 맞추기
        t, time_flag = fix_time(d.get("time"), rec)

        if asset.kind == "temp":
            self._handle_temp(asset, d, t, time_flag)
        else:
            self._handle_position(asset, d, t, time_flag)

    def _handle_temp(self, asset, d, t, time_flag):
        if "value" not in d:
            return self.log.append((asset.asset_id, "버림", "value 없음"))
        v = to_celsius(float(d["value"]), asset.unit)                  # ① 단위 통일

        key = (asset.asset_id, t.isoformat(), v)                       # ① 중복 제거
        if key in self.seen:
            return self.log.append((asset.asset_id, "중복 제거", f"{v}℃"))
        self.seen.add(key)

        quality = time_flag                                            # ① 범위·변화량 검사
        if not (asset.vmin <= v <= asset.vmax):
            quality = "out_of_range"
        elif asset.asset_id in self.last_ok:
            t0, v0 = self.last_ok[asset.asset_id]
            seconds = max((t - t0).total_seconds(), 1)
            if abs(v - v0) > asset.max_jump * seconds:
                quality = "spike"

        self._insert(t, asset, "temp_c", v, quality)
        if quality in ("ok", "clock_fixed"):
            self.last_ok[asset.asset_id] = (t, v)
        note = f"{d['value']}°F → {v}℃" if asset.unit == "F" else f"{v}℃"
        self.log.append((asset.asset_id, quality, note))

    def _handle_position(self, asset, d, t, time_flag):
        east, north = latlon_to_local_m(d["lat"], d["lon"])           # ② 좌표 맞추기
        self._insert(t, asset, "east_m", east, time_flag)
        self._insert(t, asset, "north_m", north, time_flag)
        self.log.append((asset.asset_id, time_flag,
                         f"({d['lat']}, {d['lon']}) → 동 {east}m · 북 {north}m → 언리얼 {east*100:.0f} · {north*100:.0f} cm"))

    def _insert(self, t, asset, metric, value, quality):
        self.db.execute("INSERT INTO sensor_data VALUES (?,?,?,?,?,?)",
                        (t.isoformat(timespec="milliseconds"), asset.asset_id, asset.actor, metric, value, quality))

    def _error(self, rec, topic, payload, reason):
        self.db.execute("INSERT INTO errors VALUES (?,?,?,?)", (rec.isoformat(), topic, payload, reason))
        self.log.append((topic.split("/")[-2], "버림", reason))

    def close(self):
        self.db.commit()
        self.raw_file.close()


# ─────────────────────────────────────────────
# 4. 시간 정합 예: 주기가 다른 데이터를 1초 칸으로 다시 나누기(리샘플링)
# ─────────────────────────────────────────────
def resample_last_per_second(points: list[tuple[float, float]]) -> dict[int, float]:
    """(초, 값) 목록을 받아 1초 칸마다 마지막 값만 남긴다."""
    out = {}
    for sec, value in sorted(points):
        out[int(sec)] = value
    return out


# ─────────────────────────────────────────────
# 5. 실행 예: 5초 동안 들어온 메시지 9통
# ─────────────────────────────────────────────
SAMPLE = [  # (받은 시각, 토픽, 내용물)
    ("2026-11-15T10:00:00.2+09:00", "busan/terminal/pump03/temp",
     '{"device":"pump03","value":32.1,"unit":"C","time":"2026-11-15T10:00:00+09:00"}'),
    ("2026-11-15T10:00:01.1+09:00", "busan/terminal/pump03/temp",
     '{"device":"pump03","value":85.0,"unit":"C","time":"2026-11-15T10:00:01+09:00"}'),     # 튀는 값
    ("2026-11-15T10:00:01.3+09:00", "busan/terminal/crane07/position",
     '{"device":"crane07","lat":35.10560,"lon":129.08200,"time":"2026-11-15T10:00:01+09:00"}'),
    ("2026-11-15T10:00:02.0+09:00", "busan/terminal/pump03/temp",
     '{"device":"pump03","value":32.3,"unit":"C","time":"2026-11-15T10:00:02+09:00"}'),
    ("2026-11-15T10:00:02.4+09:00", "busan/terminal/pump03/temp",
     '{"device":"pump03","value":32.3,"unit":"C","time":"2026-11-15T10:00:02+09:00"}'),     # 중복
    ("2026-11-15T10:00:03.0+09:00", "busan/terminal/pump05/temp",
     '{"device":"pump05","value":91.4,"unit":"F","time":"2026-11-15T10:00:03+09:00"}'),     # 화씨
    ("2026-11-15T10:00:03.5+09:00", "busan/terminal/pump03/temp",
     '{"device":"pump03","value":32.4,"unit":"C","time":"2026-11-15T09:58:03+09:00"}'),     # 시계 2분 늦음
    ("2026-11-15T10:00:04.1+09:00", "busan/terminal/pump03/temp",
     '{"device":"pump03","value":32.5,"un'),                                                 # 잘린 JSON
    ("2026-11-15T10:00:04.6+09:00", "busan/terminal/tmp-9/temp",
     '{"device":"tmp-9","value":27.0,"unit":"C","time":"2026-11-15T10:00:04+09:00"}'),      # 미등록 장비
]

if __name__ == "__main__":
    c = Cleaner()
    for received, topic, payload in SAMPLE:
        c.handle(datetime.fromisoformat(received), topic, payload)
    c.close()

    print("■ 판정")
    for i, (who, verdict, note) in enumerate(c.log, 1):
        print(f"  {i}. {who:<8} {verdict:<13} {note}")

    print("\n■ DB에 저장된 행 (sensor_data)")
    for row in c.db.execute("SELECT substr(time,12,12), asset_id, actor, metric, value, quality FROM sensor_data"):
        print("  ", row)

    print("\n■ 품질별 개수")
    for row in c.db.execute("SELECT quality, count(*) FROM sensor_data GROUP BY quality"):
        print("  ", row)

    print("\n■ 정상값만 장비별 평균 (분석할 때는 quality로 걸러 쓴다)")
    for row in c.db.execute("SELECT asset_id, round(avg(value),2) FROM sensor_data "
                            "WHERE metric='temp_c' AND quality IN ('ok','clock_fixed') GROUP BY asset_id"):
        print("  ", row)

    print("\n■ 오류·보류:", c.db.execute("SELECT count(*) FROM errors").fetchone()[0], "건 /",
          c.db.execute("SELECT count(*) FROM pending").fetchone()[0], "건")

    print("\n■ 리샘플링 예: 크레인 1초 5회 + 헬멧 1초 2회 → 1초 칸")
    crane = [(i * 0.2, round(10 + i * 0.3, 1)) for i in range(15)]   # 0.0~2.8초, 위치(m)
    helmet = [(i * 0.5, round(4 + i * 0.1, 1)) for i in range(6)]    # 0.0~2.5초, 위치(m)
    rc, rh = resample_last_per_second(crane), resample_last_per_second(helmet)
    for sec in sorted(set(rc) | set(rh)):
        print(f"   {sec}초  크레인 {rc.get(sec)}m  헬멧 {rh.get(sec)}m")
